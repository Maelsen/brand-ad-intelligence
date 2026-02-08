/**
 * Shopify Store Detector
 * Detects if a domain runs on Shopify and extracts brand/vendor info.
 *
 * Detection methods:
 * 1. /products.json — Public endpoint with vendor names (FREE, highest value)
 * 2. HTML analysis — cdn.shopify.com, Shopify.shop variable
 * 3. og:site_name — Meta tag with store name
 * 4. /meta.json — Shopify metadata endpoint
 */

import { ShopifyDetectionResult } from './types.ts';

const REQUEST_TIMEOUT = 10000;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';

/**
 * Full Shopify detection for a domain.
 * Returns platform info, vendor name, store name, etc.
 */
export async function detectShopifyStore(domain: string): Promise<ShopifyDetectionResult> {
  const result: ShopifyDetectionResult = {
    is_shopify: false,
    domain,
    platform: 'unknown',
    store_name: null,
    myshopify_domain: null,
    vendor_name: null,
    vendors: [],
    og_site_name: null,
    confidence: 0,
    detection_methods: [],
  };

  // Run checks in parallel for speed
  const [htmlResult, productsResult] = await Promise.allSettled([
    fetchAndAnalyzeHtml(domain),
    fetchProductsJson(domain),
  ]);

  // Process HTML analysis
  if (htmlResult.status === 'fulfilled' && htmlResult.value) {
    const html = htmlResult.value;

    // Check for Shopify CDN
    if (/cdn\.shopify\.com/i.test(html.body)) {
      result.is_shopify = true;
      result.platform = 'shopify';
      result.confidence += 0.3;
      result.detection_methods.push('cdn_shopify');
    }

    // Extract Shopify.shop variable
    const shopMatch = html.body.match(/Shopify\.shop\s*=\s*["']([^"']+)["']/);
    if (shopMatch) {
      result.is_shopify = true;
      result.platform = 'shopify';
      result.myshopify_domain = shopMatch[1];
      result.store_name = shopMatch[1].replace('.myshopify.com', '');
      result.confidence += 0.3;
      result.detection_methods.push('shopify_shop_var');
    }

    // Extract og:site_name
    const ogMatch = html.body.match(
      /<meta[^>]*property=["']og:site_name["'][^>]*content=["']([^"']+)["']/i
    ) || html.body.match(
      /<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:site_name["']/i
    );
    if (ogMatch) {
      result.og_site_name = ogMatch[1].trim();
      if (!result.store_name) {
        result.store_name = result.og_site_name;
      }
      result.confidence += 0.1;
      result.detection_methods.push('og_site_name');
    }

    // Check WooCommerce
    if (!result.is_shopify && /woocommerce|wc-ajax/i.test(html.body)) {
      result.platform = 'woocommerce';
      result.confidence += 0.3;
      result.detection_methods.push('woocommerce_html');
    }

    // Check Magento
    if (!result.is_shopify && result.platform === 'unknown' && /Magento|mage\/cookies/i.test(html.body)) {
      result.platform = 'magento';
      result.confidence += 0.2;
      result.detection_methods.push('magento_html');
    }

    // Redirect detection
    if (html.final_domain && html.final_domain !== domain) {
      result.detection_methods.push(`redirected_to:${html.final_domain}`);
    }
  }

  // Process /products.json
  if (productsResult.status === 'fulfilled' && productsResult.value) {
    const products = productsResult.value;
    result.is_shopify = true;
    result.platform = 'shopify';
    result.vendors = products.vendors;
    result.confidence += 0.3;
    result.detection_methods.push('products_json');

    // Primary vendor = most common vendor in products
    if (products.primary_vendor) {
      result.vendor_name = products.primary_vendor;
      result.confidence += 0.1;
      result.detection_methods.push('vendor_field');
    }
  }

  // Normalize confidence
  result.confidence = Math.min(result.confidence, 1.0);

  return result;
}

/**
 * Quick check: Is this domain a Shopify store?
 * Only checks HTML for cdn.shopify.com (no /products.json call)
 */
export async function isShopifyDomain(domain: string): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);

    const response = await fetch(`https://${domain}`, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html',
      },
    });

    clearTimeout(timer);
    if (!response.ok) return false;

    const html = await response.text();
    return /cdn\.shopify\.com/i.test(html) || /Shopify\.shop/i.test(html);
  } catch {
    return false;
  }
}

/**
 * Get vendor name from Shopify /products.json
 * Returns the primary (most common) vendor or null
 */
export async function getShopifyVendor(domain: string): Promise<string | null> {
  const products = await fetchProductsJson(domain);
  return products?.primary_vendor || null;
}

/**
 * Get all unique vendors from a Shopify store
 */
export async function getShopifyVendors(domain: string): Promise<string[]> {
  const products = await fetchProductsJson(domain);
  return products?.vendors || [];
}

/**
 * Check if a domain's Shopify store sells products from a specific brand/vendor
 */
export async function shopifyStoreHasVendor(
  domain: string,
  brandName: string
): Promise<{ found: boolean; matched_vendor: string | null; confidence: number }> {
  const products = await fetchProductsJson(domain);
  if (!products) return { found: false, matched_vendor: null, confidence: 0 };

  const brandLower = brandName.toLowerCase().trim();

  for (const vendor of products.vendors) {
    const vendorLower = vendor.toLowerCase().trim();

    // Exact match
    if (vendorLower === brandLower) {
      return { found: true, matched_vendor: vendor, confidence: 0.95 };
    }

    // Contains match
    if (vendorLower.includes(brandLower) || brandLower.includes(vendorLower)) {
      return { found: true, matched_vendor: vendor, confidence: 0.80 };
    }

    // Normalized match (remove spaces, hyphens, dots)
    const normalizedVendor = vendorLower.replace(/[\s\-_.]+/g, '');
    const normalizedBrand = brandLower.replace(/[\s\-_.]+/g, '');
    if (normalizedVendor === normalizedBrand) {
      return { found: true, matched_vendor: vendor, confidence: 0.85 };
    }
  }

  return { found: false, matched_vendor: null, confidence: 0 };
}

// ============================================
// Internal helpers
// ============================================

interface HtmlAnalysis {
  body: string;
  final_url: string;
  final_domain: string | null;
}

async function fetchAndAnalyzeHtml(domain: string): Promise<HtmlAnalysis | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT);

    const response = await fetch(`https://${domain}`, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
      },
    });

    clearTimeout(timer);
    if (!response.ok) return null;

    const body = await response.text();
    const finalUrl = response.url;
    let finalDomain: string | null = null;
    try {
      finalDomain = new URL(finalUrl).hostname.replace(/^www\./, '').toLowerCase();
    } catch { /* ignore */ }

    return { body, final_url: finalUrl, final_domain: finalDomain };
  } catch {
    return null;
  }
}

interface ProductsJsonResult {
  vendors: string[];
  primary_vendor: string | null;
  product_count: number;
}

async function fetchProductsJson(domain: string): Promise<ProductsJsonResult | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT);

    const response = await fetch(`https://${domain}/products.json?limit=250`, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json',
      },
    });

    clearTimeout(timer);

    if (!response.ok) return null;

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('json')) return null;

    const data = await response.json();

    if (!data.products || !Array.isArray(data.products)) return null;

    // Extract all vendors
    const vendorCounts = new Map<string, number>();
    for (const product of data.products) {
      if (product.vendor && typeof product.vendor === 'string' && product.vendor.trim()) {
        const vendor = product.vendor.trim();
        vendorCounts.set(vendor, (vendorCounts.get(vendor) || 0) + 1);
      }
    }

    // Sort by frequency
    const sortedVendors = [...vendorCounts.entries()]
      .sort((a, b) => b[1] - a[1]);

    const vendors = sortedVendors.map(([v]) => v);
    const primary_vendor = sortedVendors.length > 0 ? sortedVendors[0][0] : null;

    return {
      vendors,
      primary_vendor,
      product_count: data.products.length,
    };
  } catch {
    return null;
  }
}
