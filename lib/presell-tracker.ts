/**
 * Presell-Page Tracker
 * Finds CTA buttons on presell/affiliate pages and tracks the redirect chain to the shop domain
 */

import { RedirectChain } from './types.ts';

// CTA Button patterns for German presell pages
const CTA_BUTTON_PATTERNS = [
  // German CTA texts in links
  /<a[^>]*href="([^"]+)"[^>]*>(?:[^<]*(?:Angebot|Kaufen|Bestellen|Verfügbar|Prüfen|Shop|Jetzt|Hier|Klicken|Weiter|Produkt)[^<]*)<\/a>/gi,

  // English CTA texts
  /<a[^>]*href="([^"]+)"[^>]*>(?:[^<]*(?:Buy|Shop|Order|Get|Claim|Check)[^<]*)<\/a>/gi,

  // Button/link with data attributes
  /<(?:button|a|div)[^>]*data-(?:href|url|redirect|link|target)="([^"]+)"[^>]*>/gi,

  // onclick handlers with URL
  /onclick=["'](?:window\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']/gi,

  // onclick with navigateTo or redirect function
  /onclick=["'][^"']*(?:navigateTo|redirect|goTo)\s*\(\s*["']([^"']+)["']/gi,

  // Form action
  /<form[^>]*action="([^"]+)"[^>]*>/gi,

  // JavaScript variable assignments
  /(?:var|let|const)\s+(?:redirect|target|shop|checkout|buy)(?:Url|Link|Href)\s*=\s*["']([^"']+)["']/gi,

  // JSON embedded URLs
  /"(?:redirect|target|shop|checkout|buy|order)_?(?:url|link|href)"\s*:\s*"([^"]+)"/gi,
];

// Patterns indicating a shop/checkout page
const SHOP_INDICATORS = [
  /shopify/i,
  /woocommerce/i,
  /magento/i,
  /checkout/i,
  /warenkorb/i,
  /cart/i,
  /bestell/i,
  /kasse/i,
];

// Patterns indicating a presell/editorial page
const PRESELL_INDICATORS = [
  /editorial/i,
  /review/i,
  /erfahrung/i,
  /test/i,
  /bewertung/i,
  /ratgeber/i,
  /artikel/i,
  /bericht/i,
];

// Excluded domains
const EXCLUDED_DOMAINS = [
  'facebook.com',
  'fb.com',
  'instagram.com',
  'meta.com',
  'google.com',
  'youtube.com',
  'twitter.com',
  'pinterest.com',
];

export interface PresellChainResult {
  initial_url: string;
  cta_url: string | null;
  final_url: string | null;
  chain: string[];
  is_presell: boolean;
  shop_domain: string | null;
  confidence: number;
  extraction_method: string | null;
}

/**
 * Track a presell page's redirect chain to the shop domain
 */
export async function trackPresellChain(
  presellUrl: string,
  options?: { timeout?: number; maxRedirects?: number }
): Promise<PresellChainResult> {
  const timeout = options?.timeout || 10000;
  const maxRedirects = options?.maxRedirects || 10;

  const result: PresellChainResult = {
    initial_url: presellUrl,
    cta_url: null,
    final_url: null,
    chain: [presellUrl],
    is_presell: false,
    shop_domain: null,
    confidence: 0,
    extraction_method: null,
  };

  try {
    // 1. Fetch the presell page
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);

    const response = await fetch(presellUrl, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
      },
      redirect: 'follow',
    });

    clearTimeout(timer);

    if (!response.ok) {
      console.log(`[Presell] Failed to fetch ${presellUrl}: ${response.status}`);
      return result;
    }

    const html = await response.text();
    const finalFetchUrl = response.url;

    // Check if URL changed during fetch (redirect)
    if (finalFetchUrl !== presellUrl) {
      result.chain.push(finalFetchUrl);
    }

    // 2. Determine if this is a presell page
    result.is_presell = isPresellPage(html, presellUrl);
    if (result.is_presell) {
      result.confidence += 0.2;
    }

    // 3. Extract CTA URL
    const ctaResult = extractCtaUrl(html, presellUrl);
    result.cta_url = ctaResult.url;
    result.extraction_method = ctaResult.method;

    if (result.cta_url) {
      result.chain.push(result.cta_url);
      result.confidence += 0.3;

      // 4. Follow the CTA URL's redirect chain
      const finalChain = await followRedirects(result.cta_url, maxRedirects, timeout);
      if (finalChain.length > 0) {
        result.chain.push(...finalChain);
        result.final_url = finalChain[finalChain.length - 1];

        // 5. Extract shop domain
        result.shop_domain = extractDomain(result.final_url);
        if (result.shop_domain && isShopDomain(result.final_url)) {
          result.confidence += 0.4;
        }
      }
    }

    return result;
  } catch (error) {
    console.log(`[Presell] Error tracking ${presellUrl}:`, error);
    return result;
  }
}

/**
 * Check if a page is a presell/editorial page
 */
function isPresellPage(html: string, url: string): boolean {
  const indicators: boolean[] = [
    // URL contains presell patterns
    PRESELL_INDICATORS.some(p => p.test(url)),
    // Meta og:type is article
    /og:type["'][^>]*content=["']article/i.test(html),
    // Has CTA buttons
    /(?:Angebot|Kaufen|Bestellen|Shop|Jetzt|Buy|Order)/i.test(html),
    // Does NOT have checkout elements (negated)
    !SHOP_INDICATORS.some(p => p.test(html)),
    // Has article structure
    /<article/i.test(html) || /class=["'][^"']*article/i.test(html),
  ];

  // At least 2 indicators must be true
  return indicators.filter(Boolean).length >= 2;
}

/**
 * Check if a URL/page is a shop domain
 */
function isShopDomain(url: string): boolean {
  return SHOP_INDICATORS.some(p => p.test(url));
}

/**
 * Extract CTA URL from HTML
 */
function extractCtaUrl(html: string, baseUrl: string): { url: string | null; method: string | null } {
  for (const pattern of CTA_BUTTON_PATTERNS) {
    // Reset regex state
    pattern.lastIndex = 0;

    const matches = [...html.matchAll(pattern)];
    for (const match of matches) {
      let url = match[1];

      if (!url || url.length < 5) continue;

      // Skip excluded domains and anchors
      if (EXCLUDED_DOMAINS.some(d => url.includes(d))) continue;
      if (url.startsWith('#')) continue;
      if (url.startsWith('javascript:')) continue;
      if (url.startsWith('mailto:')) continue;
      if (url.startsWith('tel:')) continue;

      // Resolve relative URLs
      if (url.startsWith('/')) {
        try {
          const base = new URL(baseUrl);
          url = `${base.origin}${url}`;
        } catch {
          continue;
        }
      } else if (!url.startsWith('http')) {
        try {
          const base = new URL(baseUrl);
          url = new URL(url, base).href;
        } catch {
          continue;
        }
      }

      // Validate URL
      try {
        new URL(url);
        return { url, method: pattern.source.slice(0, 30) };
      } catch {
        continue;
      }
    }
  }

  return { url: null, method: null };
}

/**
 * Follow HTTP redirects
 */
async function followRedirects(
  initialUrl: string,
  maxRedirects: number,
  timeout: number
): Promise<string[]> {
  const chain: string[] = [];
  let currentUrl = initialUrl;

  for (let i = 0; i < maxRedirects; i++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeout);

      const response = await fetch(currentUrl, {
        method: 'HEAD',
        redirect: 'manual',
        signal: ctrl.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });

      clearTimeout(timer);

      // Check for redirect
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (location) {
          // Handle relative URLs
          const nextUrl = new URL(location, currentUrl).href;

          // Avoid infinite loops
          if (chain.includes(nextUrl) || nextUrl === currentUrl) {
            break;
          }

          chain.push(nextUrl);
          currentUrl = nextUrl;
          continue;
        }
      }

      // No more redirects
      break;
    } catch (error) {
      console.log(`[Presell] Redirect tracking error at ${currentUrl}:`, error);
      break;
    }
  }

  return chain;
}

/**
 * Extract domain from URL
 */
function extractDomain(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

/**
 * Batch track multiple presell chains with concurrency limit
 */
export async function batchTrackPresellChains(
  urls: string[],
  concurrency: number = 5,
  options?: { timeout?: number }
): Promise<PresellChainResult[]> {
  const results: PresellChainResult[] = [];

  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(url => trackPresellChain(url, options))
    );
    results.push(...batchResults);

    // Small delay between batches
    if (i + concurrency < urls.length) {
      await new Promise(r => setTimeout(r, 100));
    }
  }

  return results;
}
