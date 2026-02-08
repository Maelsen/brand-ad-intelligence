/**
 * Checkout Detector
 * Identifies the actual brand/shop behind a presell page by following
 * the purchase flow through to checkout.
 *
 * Supports:
 * - Shopify checkout detection
 * - WooCommerce detection
 * - Generic e-commerce detection
 * - Brand name extraction from checkout pages
 */

export interface CheckoutDetectionResult {
  brand_name: string | null;
  shop_domain: string | null;
  checkout_url: string | null;
  platform: 'shopify' | 'woocommerce' | 'magento' | 'custom' | 'unknown';
  confidence: number;
  detection_method: string;
}

// Shopify checkout URL patterns
const SHOPIFY_PATTERNS = [
  /checkout\.shopify\.com/i,
  /\.myshopify\.com/i,
  /\/checkouts\/[a-z0-9]+/i,
  /\/cart\/[a-z0-9]+:[\d]+/i,
];

// WooCommerce patterns
const WOOCOMMERCE_PATTERNS = [
  /\/checkout\//i,
  /wc-ajax/i,
  /woocommerce/i,
];

/**
 * Detect the brand/shop from a checkout URL or page
 */
export async function detectBrandFromCheckout(
  url: string,
  options?: { timeout?: number; followRedirects?: boolean }
): Promise<CheckoutDetectionResult> {
  const timeout = options?.timeout || 10000;

  const result: CheckoutDetectionResult = {
    brand_name: null,
    shop_domain: null,
    checkout_url: null,
    platform: 'unknown',
    confidence: 0,
    detection_method: 'none',
  };

  try {
    // 1. Check if URL itself is a checkout URL
    if (isShopifyUrl(url)) {
      result.platform = 'shopify';
      result.checkout_url = url;
      result.shop_domain = extractShopifyDomain(url);
      result.confidence = 0.7;
      result.detection_method = 'url_pattern';
    }

    // 2. Fetch the page and analyze content
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);

    const response = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
      },
    });

    clearTimeout(timer);

    if (!response.ok) return result;

    const finalUrl = response.url;
    const html = await response.text();

    // Update checkout URL if we were redirected
    if (finalUrl !== url) {
      result.checkout_url = finalUrl;
    }

    // 3. Detect platform from page content
    if (result.platform === 'unknown') {
      result.platform = detectPlatform(html, finalUrl);
    }

    // 4. Extract brand name
    const brandInfo = extractBrandFromPage(html, finalUrl);
    if (brandInfo.name) {
      result.brand_name = brandInfo.name;
      result.confidence = Math.max(result.confidence, brandInfo.confidence);
      result.detection_method = brandInfo.method;
    }

    // 5. Extract shop domain
    if (!result.shop_domain) {
      result.shop_domain = extractDomain(finalUrl);
    }

    return result;
  } catch (error) {
    console.log(`[Checkout] Error detecting brand from ${url}:`, error);
    return result;
  }
}

/**
 * Follow a presell page through CTA to checkout and identify the brand
 * This is the main entry point for the Drittseiten-Finder
 */
export async function followToCheckout(
  presellUrl: string,
  options?: { timeout?: number; maxHops?: number }
): Promise<CheckoutDetectionResult & { chain: string[] }> {
  const timeout = options?.timeout || 10000;
  const maxHops = options?.maxHops || 5;
  const chain: string[] = [presellUrl];

  let currentUrl = presellUrl;

  for (let hop = 0; hop < maxHops; hop++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeout);

      const response = await fetch(currentUrl, {
        signal: ctrl.signal,
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html',
          'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
        },
      });

      clearTimeout(timer);
      if (!response.ok) break;

      const finalUrl = response.url;
      if (finalUrl !== currentUrl && !chain.includes(finalUrl)) {
        chain.push(finalUrl);
      }

      const html = await response.text();

      // Check if we've reached a checkout/shop page
      if (isCheckoutPage(html, finalUrl)) {
        const detection = await detectBrandFromCheckout(finalUrl, { timeout });
        return { ...detection, chain };
      }

      // Try to find a CTA that leads to the shop
      const ctaUrl = findShopCtaUrl(html, finalUrl);
      if (ctaUrl && !chain.includes(ctaUrl)) {
        chain.push(ctaUrl);
        currentUrl = ctaUrl;
        continue;
      }

      // No more hops possible
      break;
    } catch {
      break;
    }
  }

  // Try to detect brand from last page in chain
  const lastUrl = chain[chain.length - 1];
  const detection = await detectBrandFromCheckout(lastUrl, { timeout });
  return { ...detection, chain };
}

/**
 * Check if URL matches Shopify patterns
 */
function isShopifyUrl(url: string): boolean {
  return SHOPIFY_PATTERNS.some(p => p.test(url));
}

/**
 * Extract Shopify store domain from URL
 */
function extractShopifyDomain(url: string): string | null {
  try {
    const parsed = new URL(url);

    // checkout.shopify.com/... → extract from query params or path
    if (parsed.hostname === 'checkout.shopify.com') {
      // Some Shopify checkouts have the store in the path
      const pathMatch = parsed.pathname.match(/\/(\d+)\//);
      if (pathMatch) return `shop-${pathMatch[1]}`;
    }

    // {store}.myshopify.com
    if (parsed.hostname.endsWith('.myshopify.com')) {
      return parsed.hostname.replace('.myshopify.com', '');
    }

    // Custom domain with /checkouts/
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/**
 * Detect e-commerce platform from HTML
 */
function detectPlatform(html: string, url: string): CheckoutDetectionResult['platform'] {
  // Shopify
  if (
    /Shopify\.shop/i.test(html) ||
    /cdn\.shopify\.com/i.test(html) ||
    /\/checkouts\//i.test(url) ||
    isShopifyUrl(url)
  ) {
    return 'shopify';
  }

  // WooCommerce
  if (
    /woocommerce/i.test(html) ||
    /wc-ajax/i.test(html) ||
    /class="woocommerce/i.test(html)
  ) {
    return 'woocommerce';
  }

  // Magento
  if (/Magento/i.test(html) || /mage\/cookies/i.test(html)) {
    return 'magento';
  }

  // Generic shop indicators
  if (/checkout|warenkorb|cart|kasse/i.test(url)) {
    return 'custom';
  }

  return 'unknown';
}

/**
 * Extract brand name from page HTML
 */
function extractBrandFromPage(
  html: string,
  url: string
): { name: string | null; confidence: number; method: string } {
  // Priority 1: Shopify store config (highest confidence)
  const shopifyMatch = html.match(/Shopify\.shop\s*=\s*["']([^"']+)["']/);
  if (shopifyMatch) {
    const storeName = shopifyMatch[1].replace('.myshopify.com', '');
    return { name: storeName, confidence: 0.95, method: 'shopify_config' };
  }

  // Priority 2: og:site_name (high confidence)
  const ogSiteMatch = html.match(/<meta[^>]*property=["']og:site_name["'][^>]*content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:site_name["']/i);
  if (ogSiteMatch) {
    return { name: ogSiteMatch[1].trim(), confidence: 0.85, method: 'og_site_name' };
  }

  // Priority 3: Title tag with checkout indicator
  const titleMatch = html.match(/<title>(?:Checkout|Kasse|Warenkorb)\s*[-–|]\s*(.+?)<\/title>/i) ||
    html.match(/<title>(.+?)\s*[-–|]\s*(?:Checkout|Kasse|Warenkorb)<\/title>/i);
  if (titleMatch) {
    return { name: titleMatch[1].trim(), confidence: 0.8, method: 'title_tag' };
  }

  // Priority 4: Schema.org Organization
  const schemaMatch = html.match(/"@type"\s*:\s*"Organization"[^}]*"name"\s*:\s*"([^"]+)"/);
  if (schemaMatch) {
    return { name: schemaMatch[1].trim(), confidence: 0.75, method: 'schema_org' };
  }

  // Priority 5: Domain name as fallback
  try {
    const parsed = new URL(url);
    const domain = parsed.hostname.replace(/^www\./, '').split('.')[0];
    if (domain && domain.length > 2) {
      return { name: domain, confidence: 0.4, method: 'domain_name' };
    }
  } catch {
    // ignore
  }

  return { name: null, confidence: 0, method: 'none' };
}

/**
 * Check if a page is a checkout/shop page
 */
function isCheckoutPage(html: string, url: string): boolean {
  const urlIndicators = /checkout|warenkorb|cart|kasse|order|bestell/i.test(url);
  const htmlIndicators = [
    /add.to.cart/i.test(html),
    /class="[^"]*checkout/i.test(html),
    /id="[^"]*checkout/i.test(html),
    /Shopify\.shop/i.test(html),
    /woocommerce-checkout/i.test(html),
  ].filter(Boolean).length >= 1;

  return urlIndicators || htmlIndicators;
}

/**
 * Find a CTA URL that leads to a shop
 */
function findShopCtaUrl(html: string, baseUrl: string): string | null {
  const ctaPatterns = [
    // German CTAs
    /<a[^>]*href="([^"]+)"[^>]*>[^<]*(?:Jetzt\s+(?:kaufen|bestellen|shoppen|sichern)|Zum\s+(?:Angebot|Shop|Produkt)|(?:Verfügbarkeit|Angebot)\s+prüfen|In\s+den\s+Warenkorb|Hier\s+(?:kaufen|bestellen)|Weiter\s+zum\s+Shop)[^<]*<\/a>/gi,

    // English CTAs
    /<a[^>]*href="([^"]+)"[^>]*>[^<]*(?:Buy\s+Now|Shop\s+Now|Add\s+to\s+Cart|Order\s+Now|Get\s+(?:It|Yours)|Check\s+Availability|Go\s+to\s+Shop)[^<]*<\/a>/gi,

    // Generic button-like elements
    /<a[^>]*class="[^"]*(?:btn|button|cta)[^"]*"[^>]*href="([^"]+)"/gi,
  ];

  const excludedDomains = [
    'facebook.com', 'fb.com', 'instagram.com', 'google.com',
    'youtube.com', 'twitter.com', 'pinterest.com',
  ];

  for (const pattern of ctaPatterns) {
    pattern.lastIndex = 0;
    const matches = [...html.matchAll(pattern)];

    for (const match of matches) {
      let url = match[1];
      if (!url || url.startsWith('#') || url.startsWith('javascript:') || url.startsWith('mailto:')) continue;

      // Resolve relative URLs
      if (!url.startsWith('http')) {
        try {
          url = new URL(url, baseUrl).href;
        } catch {
          continue;
        }
      }

      // Check it's not an excluded domain
      try {
        const domain = new URL(url).hostname.toLowerCase();
        if (excludedDomains.some(d => domain.includes(d))) continue;
        return url;
      } catch {
        continue;
      }
    }
  }

  return null;
}

/**
 * Extract domain from URL
 */
function extractDomain(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Batch detect brands from multiple URLs
 */
export async function batchDetectBrands(
  urls: string[],
  concurrency: number = 3,
  options?: { timeout?: number }
): Promise<Map<string, CheckoutDetectionResult>> {
  const results = new Map<string, CheckoutDetectionResult>();

  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (url) => {
        const result = await detectBrandFromCheckout(url, options);
        return { url, result };
      })
    );

    for (const { url, result } of batchResults) {
      results.set(url, result);
    }

    if (i + concurrency < urls.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  return results;
}
