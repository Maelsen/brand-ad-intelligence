/**
 * URL Extractor for Landing Pages
 * Robust Three-Stage System:
 * - Stage 1: Extract domain from ad_creative_link_captions (100% reliable)
 * - Stage 2: Enhanced HTML scraping + redirect tracking (85% success rate)
 * - Stage 3: Headless browser via ScrapingBee (fallback for JS-heavy pages)
 */

import { RedirectChain, FullUrlCacheEntry } from './types.ts';

// ============================================
// Stage 1: Domain Extraction (100% Reliable)
// ============================================

/**
 * Extract domain from ad_creative_link_captions
 * This is the caption shown in the ad (e.g., "WEAREHOLY.COM")
 * Always available, never fails
 */
export function extractDomainFromCaption(caption: string | undefined | null): string | null {
  if (!caption) return null;

  // Clean up the caption - it's usually just a domain
  let domain = caption.trim().toLowerCase();

  // Remove common prefixes
  domain = domain.replace(/^(https?:\/\/)?(www\.)?/i, '');

  // Remove trailing slashes and paths
  domain = domain.split('/')[0];

  // Validate it looks like a domain
  if (domain && domain.includes('.') && !domain.includes(' ')) {
    return domain;
  }

  return null;
}

/**
 * Extract domain from a full URL
 */
export function extractDomain(url: string | undefined | null): string | null {
  if (!url) return null;

  try {
    // If it's already just a domain (no protocol), add one
    const urlToTest = url.includes('://') ? url : `https://${url}`;
    const parsedUrl = new URL(urlToTest);
    return parsedUrl.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    // Fallback: try to extract domain-like pattern
    return extractDomainFromCaption(url);
  }
}

/**
 * Generic/platform domains to exclude
 */
const EXCLUDED_DOMAINS = [
  'facebook.com',
  'fb.com',
  'fb.me',
  'fbcdn.net',
  'instagram.com',
  'meta.com',
  'facebook.net',
  'l.facebook.com',
  'l.instagram.com',
  'bit.ly',
  'tinyurl.com',
  'linktr.ee',
];

/**
 * Check if a domain should be excluded
 */
function isExcludedDomain(domain: string): boolean {
  const domainLower = domain.toLowerCase();
  return EXCLUDED_DOMAINS.some(
    (excluded) => domainLower === excluded || domainLower.endsWith(`.${excluded}`)
  );
}

/**
 * Extract full URL from ad_creative_link_captions
 * Preserves the path if present (e.g., "MONAPURE.DE/COLLECTIONS/SALE" → "https://monapure.de/collections/sale")
 * Falls back to just domain if no path (e.g., "MIAVOLA.DE" → "https://miavola.de")
 */
export function extractFullUrlFromCaption(caption: string | undefined | null): string | null {
  if (!caption) return null;

  let cleaned = caption.trim().toLowerCase();

  // Remove protocol if present
  cleaned = cleaned.replace(/^https?:\/\//i, '');

  // Remove www. prefix
  cleaned = cleaned.replace(/^www\./i, '');

  // Remove trailing slash
  cleaned = cleaned.replace(/\/+$/, '');

  // Validate it has a domain part
  const domainPart = cleaned.split('/')[0];
  if (!domainPart || !domainPart.includes('.') || domainPart.includes(' ')) {
    return null;
  }

  return `https://${cleaned}`;
}

/**
 * Extract all unique domains from ad captions
 * Filters out generic/platform domains
 */
export function extractDomainsFromCaptions(captions: string[]): string[] {
  const domains = new Set<string>();

  for (const caption of captions) {
    const domain = extractDomainFromCaption(caption);
    if (domain && !isExcludedDomain(domain)) {
      domains.add(domain);
    }
  }

  return Array.from(domains);
}

// ============================================
// Stage 2: Best Effort URL Extraction
// ============================================

/**
 * Extract FULL landing page URL from Meta ad snapshot URL
 * Returns the complete URL with path and query parameters
 * e.g., "https://de.weareholy.com/discount/HOLY?utm_source=facebook&utm_medium=paid"
 */
export async function extractLandingPageUrl(
  adSnapshotUrl: string
): Promise<string | null> {
  try {
    const response = await fetch(adSnapshotUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
      },
    });

    if (!response.ok) {
      console.log(`Ad snapshot fetch failed: ${response.status}`);
      return null;
    }

    const html = await response.text();

    // Try multiple extraction strategies (ordered by reliability)
    const url =
      extractFromFacebookRedirectLinks(html) || // Facebook l.php redirect links
      extractFromLinkTag(html) ||
      extractFromDataAttributes(html) ||
      extractFromScriptTags(html) ||
      extractFromMetaRefresh(html) ||           // Meta refresh redirects
      extractFromJsRedirects(html) ||           // JS-based redirects
      extractFromHref(html) ||
      extractFromAnyExternalUrl(html);          // Aggressive fallback: JSON/Relay data

    // If we got a URL, try to follow redirects to get the FINAL full URL
    if (url) {
      const finalUrl = await followToFinalUrl(url);
      return finalUrl || url;
    }

    return null;
  } catch (error) {
    console.log('Error extracting landing page URL:', error);
    return null;
  }
}

/**
 * Extract full URL result with all metadata
 * Used by the url-enrichment endpoint for caching
 */
export async function extractFullUrlWithMetadata(
  adId: string,
  snapshotUrl: string,
  domain?: string
): Promise<FullUrlCacheEntry> {
  const entry: FullUrlCacheEntry = {
    ad_id: adId,
    snapshot_url: snapshotUrl,
    domain: domain || undefined,
    redirect_chain: [],
    confidence: 0,
    scrape_success: false,
  };

  // Try multiple URL strategies to get the ad page HTML
  const urlsToTry = [
    snapshotUrl,
    // Try without access_token (public Ad Library renders)
    snapshotUrl.replace(/[?&]access_token=[^&]+/, ''),
    // Try the public Ad Library page URL
    `https://www.facebook.com/ads/library/?id=${adId}`,
  ];

  let html = '';
  let fetchStatus = 0;

  for (const url of urlsToTry) {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
        },
      });

      fetchStatus = response.status;
      const body = await response.text();

      // Accept any response that has substantial HTML (not just an error page)
      if (body.length > 5000 && !body.includes('<title>Error</title>')) {
        html = body;
        console.log(`[URL] Got HTML for ${adId}: ${html.length} chars from ${url.substring(0, 60)}...`);
        break;
      }

      console.log(`[URL] URL attempt for ${adId}: HTTP ${response.status}, ${body.length} chars (insufficient)`);
    } catch (err) {
      console.log(`[URL] Fetch error for ${adId}: ${err}`);
    }
  }

  if (!html) {
    console.log(`[URL] All URL strategies failed for ${adId}`);
    (entry as any)._debug = {
      status: fetchStatus,
      error: 'all_fetch_strategies_failed',
      urlsTriedCount: urlsToTry.length,
    };
    return entry;
  }

  try {
    // Extract URL using all strategies
    const extractedUrl =
      extractFromFacebookRedirectLinks(html) ||
      extractFromLinkTag(html) ||
      extractFromDataAttributes(html) ||
      extractFromScriptTags(html) ||
      extractFromMetaRefresh(html) ||
      extractFromJsRedirects(html) ||
      extractFromHref(html);

    if (!extractedUrl) {
      console.log(`[URL] No URL found in HTML for ${adId}`);
      (entry as any)._debug = {
        status: fetchStatus,
        htmlLength: html.length,
        hasLphp: html.includes('l.facebook.com/l.php'),
        hasLinkUrl: html.includes('link_url'),
        hasWebsiteUrl: html.includes('website_url'),
        hasCtaLink: html.includes('cta_link'),
        hasCallToAction: html.includes('call_to_action'),
        hasExternalUrl: html.includes('external_url'),
        hasDisplayLink: html.includes('display_link'),
        hrefCount: (html.match(/href="/g) || []).length,
        scriptCount: (html.match(/<script/g) || []).length,
        htmlSnippet: html.substring(0, 500).replace(/access_token=[^&"'\s]+/g, 'TOKEN'),
      };
      return entry;
    }

    entry.extracted_url = extractedUrl;
    entry.extraction_method = 'html_parse';
    entry.confidence = 0.7;

    // Follow redirects to get final URL
    const redirectResult = await followRedirectsWithChain(extractedUrl);
    entry.final_url = redirectResult.final_url;
    entry.redirect_chain = redirectResult.chain;
    entry.full_path = extractPathAndQuery(redirectResult.final_url);

    if (entry.final_url) {
      entry.scrape_success = true;
      entry.confidence = 0.85;
    }

    return entry;
  } catch (error) {
    console.log(`[URL] Error extracting full URL for ${adId}:`, error);
    return entry;
  }
}

function extractFromLinkTag(html: string): string | null {
  const patterns = [
    /<meta\s+property="og:url"\s+content="([^"]+)"/i,
    /<link\s+rel="canonical"\s+href="([^"]+)"/i,
    /data-lynx-uri="([^"]+)"/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && match[1] && isValidLandingPageUrl(match[1])) {
      return decodeUrl(match[1]);
    }
  }

  return null;
}

function extractFromDataAttributes(html: string): string | null {
  const patterns = [
    /data-href="([^"]+facebook\.com\/ads\/archive\/render_ad\/\?[^"]+)"/i,
    /data-url="(https?:\/\/[^"]+)"/i,
    /destination_url['"]\s*:\s*['"]([^'"]+)['"]/i,
    /"link"\s*:\s*"(https?:\/\/[^"]+)"/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && match[1]) {
      if (match[1].includes('render_ad')) {
        try {
          const urlParams = new URL(match[1]).searchParams;
          const destUrl = urlParams.get('dest_url') || urlParams.get('link');
          if (destUrl && isValidLandingPageUrl(destUrl)) {
            return decodeUrl(destUrl);
          }
        } catch {
          // Continue to next pattern
        }
      } else if (isValidLandingPageUrl(match[1])) {
        return decodeUrl(match[1]);
      }
    }
  }

  return null;
}

function extractFromScriptTags(html: string): string | null {
  const scriptPattern = /<script[^>]*>([^<]*(?:link|url)[^<]*)<\/script>/gi;
  let match;

  while ((match = scriptPattern.exec(html)) !== null) {
    const scriptContent = match[1];

    const urlPatterns = [
      /"link_url"\s*:\s*"([^"]+)"/i,
      /"website_url"\s*:\s*"([^"]+)"/i,
      /"call_to_action_url"\s*:\s*"([^"]+)"/i,
      /"landing_page_url"\s*:\s*"([^"]+)"/i,
      /"cta_link"\s*:\s*"([^"]+)"/i,
    ];

    for (const pattern of urlPatterns) {
      const urlMatch = scriptContent.match(pattern);
      if (urlMatch && urlMatch[1] && isValidLandingPageUrl(urlMatch[1])) {
        return decodeUrl(urlMatch[1]);
      }
    }
  }

  return null;
}

function extractFromHref(html: string): string | null {
  const patterns = [
    /<a[^>]*href="(https?:\/\/[^"]+)"[^>]*class="[^"]*_8l12[^"]*"/i,
    /<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>(?:Shop Now|Learn More|Jetzt kaufen|Mehr erfahren|Jetzt shoppen)/i,
    /<a[^>]*class="[^"]*cta[^"]*"[^>]*href="(https?:\/\/[^"]+)"/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && match[1] && isValidLandingPageUrl(match[1])) {
      return decodeUrl(match[1]);
    }
  }

  return null;
}

function isValidLandingPageUrl(url: string): boolean {
  if (!url || typeof url !== 'string') return false;

  try {
    const parsedUrl = new URL(url);
    const domain = parsedUrl.hostname.toLowerCase();

    const excludedDomains = [
      'facebook.com',
      'fb.com',
      'fbcdn.net',
      'instagram.com',
      'meta.com',
      'meta.ai',
      'facebook.net',
      'threads.net',
      'whatsapp.com',
    ];

    return !excludedDomains.some(
      (excluded) => domain === excluded || domain.endsWith(`.${excluded}`)
    );
  } catch {
    return false;
  }
}

function decodeUrl(url: string): string {
  try {
    let decoded = decodeURIComponent(url);
    if (decoded.includes('%')) {
      decoded = decodeURIComponent(decoded);
    }
    return decoded;
  } catch {
    return url;
  }
}

// ============================================
// Redirect Chain Tracking
// ============================================

/**
 * Track redirect chain from initial URL to final destination
 * Follows HTTP redirects (301, 302, etc.)
 */
export async function trackRedirectChain(initialUrl: string): Promise<RedirectChain> {
  const chain: string[] = [initialUrl];
  let currentUrl = initialUrl;
  const maxRedirects = 10;

  for (let i = 0; i < maxRedirects; i++) {
    try {
      const response = await fetch(currentUrl, {
        method: 'HEAD', // Use HEAD to be faster
        redirect: 'manual',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
      });

      // Check for redirect status codes
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (location) {
          // Handle relative URLs
          const nextUrl = new URL(location, currentUrl).href;

          // Avoid infinite loops
          if (chain.includes(nextUrl)) {
            break;
          }

          currentUrl = nextUrl;
          chain.push(currentUrl);
          continue;
        }
      }

      // No more redirects
      break;
    } catch (error) {
      console.log(`Redirect tracking error at ${currentUrl}:`, error);
      break;
    }
  }

  return {
    initial_url: initialUrl,
    final_url: currentUrl,
    chain: chain,
  };
}

/**
 * Identify domain type in redirect chain
 */
export function classifyDomains(redirectChain: RedirectChain, brandName: string): {
  presell: string | null;
  final_shop: string | null;
} {
  const brandLower = brandName.toLowerCase();
  const domains = redirectChain.chain.map(url => extractDomain(url)).filter(Boolean) as string[];
  const uniqueDomains = [...new Set(domains)];

  let presell: string | null = null;
  let final_shop: string | null = null;

  for (const domain of uniqueDomains) {
    // If domain contains brand name, it's likely the shop
    if (domain.includes(brandLower)) {
      final_shop = domain;
    } else if (!presell && uniqueDomains.length > 1) {
      // First non-brand domain is likely presell
      presell = domain;
    }
  }

  // If no brand domain found, last domain is final shop
  if (!final_shop && uniqueDomains.length > 0) {
    final_shop = uniqueDomains[uniqueDomains.length - 1];
  }

  return { presell, final_shop };
}

// ============================================
// Batch Processing
// ============================================

/**
 * Batch extract landing pages with concurrency limit
 */
export async function batchExtractLandingPages(
  snapshotUrls: string[],
  concurrency: number = 5
): Promise<Map<string, string | null>> {
  const results = new Map<string, string | null>();
  const chunks = chunkArray(snapshotUrls, concurrency);

  for (const chunk of chunks) {
    const promises = chunk.map(async (url) => {
      const landingPage = await extractLandingPageUrl(url);
      results.set(url, landingPage);
    });

    await Promise.all(promises);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return results;
}

function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

// ============================================
// NEW: Enhanced Extraction Strategies
// ============================================

/**
 * Extract URL from Facebook l.php redirect links
 * Facebook wraps external URLs: l.facebook.com/l.php?u=ACTUAL_URL
 * This gives us the FULL URL with path and UTM params
 */
function extractFromFacebookRedirectLinks(html: string): string | null {
  const patterns = [
    // l.facebook.com redirect links
    /href="(https?:\/\/l\.facebook\.com\/l\.php\?u=[^"]+)"/gi,
    // Encoded versions
    /href="(https?:\/\/l\.facebook\.com\/l\.php\?[^"]*u%3D[^"]+)"/gi,
    // l.instagram.com redirects
    /href="(https?:\/\/l\.instagram\.com\/\?u=[^"]+)"/gi,
    // Data attributes with Facebook redirect
    /data-(?:href|url|link)="(https?:\/\/l\.facebook\.com\/l\.php\?u=[^"]+)"/gi,
  ];

  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    const matches = [...html.matchAll(pattern)];
    for (const match of matches) {
      const fbUrl = match[1];
      const actualUrl = extractUrlFromFbRedirect(fbUrl);
      if (actualUrl && isValidLandingPageUrl(actualUrl)) {
        return actualUrl;
      }
    }
  }

  return null;
}

/**
 * Extract actual URL from Facebook's l.php redirect
 */
function extractUrlFromFbRedirect(fbUrl: string): string | null {
  try {
    const url = new URL(fbUrl);
    const actualUrl = url.searchParams.get('u') || url.searchParams.get('href');
    if (actualUrl) {
      return decodeUrl(actualUrl);
    }
  } catch {
    // Try regex fallback
    const match = fbUrl.match(/[?&]u=([^&]+)/);
    if (match) {
      return decodeUrl(match[1]);
    }
  }
  return null;
}

/**
 * Extract URL from meta refresh tags
 * <meta http-equiv="refresh" content="0;url=https://example.com/page">
 */
function extractFromMetaRefresh(html: string): string | null {
  const patterns = [
    /<meta[^>]*http-equiv=["']refresh["'][^>]*content=["']\d+\s*;\s*url=([^"']+)["']/i,
    /<meta[^>]*content=["']\d+\s*;\s*url=([^"']+)["'][^>]*http-equiv=["']refresh["']/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && match[1] && isValidLandingPageUrl(match[1])) {
      return decodeUrl(match[1]);
    }
  }

  return null;
}

/**
 * Extract URL from JavaScript redirects
 * window.location = "https://..."
 * window.location.href = "https://..."
 * window.location.replace("https://...")
 */
function extractFromJsRedirects(html: string): string | null {
  const patterns = [
    // window.location.href = "..."
    /window\.location\.href\s*=\s*["'](https?:\/\/[^"']+)["']/i,
    // window.location = "..."
    /window\.location\s*=\s*["'](https?:\/\/[^"']+)["']/i,
    // window.location.replace("...")
    /window\.location\.replace\s*\(\s*["'](https?:\/\/[^"']+)["']\s*\)/i,
    // document.location.href = "..."
    /document\.location\.href\s*=\s*["'](https?:\/\/[^"']+)["']/i,
    // top.location = "..."
    /top\.location\s*=\s*["'](https?:\/\/[^"']+)["']/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && match[1] && isValidLandingPageUrl(match[1])) {
      return decodeUrl(match[1]);
    }
  }

  return null;
}

/**
 * Aggressive fallback: Find ANY external (non-Facebook) URL in the HTML
 * Searches all script tags, JSON blobs, and href attributes
 * This catches URLs in React data, __RELAY_STORE__, etc.
 */
function extractFromAnyExternalUrl(html: string): string | null {
  // Strategy 1: Look for URLs in JSON-like contexts within script tags
  // Facebook often embeds ad data as JSON in script tags
  const jsonUrlPatterns = [
    // "link_url":"https://..." or "link_url":"https:\/\/..."
    /"(?:link_url|website_url|cta_link|call_to_action_url|landing_page_url|external_url|display_link|share_url|object_url|action_url|target_url)"\s*:\s*"((?:https?:\\?\/\\?\/[^"]+))"/gi,
    // "uri":"https://..." (common in Facebook's internal data)
    /"(?:uri|url|href|link)"\s*:\s*"(https?:\\?\/\\?\/(?!(?:www\.)?(?:facebook|fb|instagram|meta|fbcdn)\b)[^"]+)"/gi,
    // Encoded URLs: "u=https%3A%2F%2F..."
    /[?&]u=(https?%3A%2F%2F[^&"'\s]+)/gi,
  ];

  for (const pattern of jsonUrlPatterns) {
    pattern.lastIndex = 0;
    const matches = [...html.matchAll(pattern)];
    for (const match of matches) {
      let url = match[1];
      // Unescape JSON forward slashes
      url = url.replace(/\\\//g, '/');
      // Decode URL encoding
      try {
        if (url.includes('%3A') || url.includes('%2F')) {
          url = decodeURIComponent(url);
        }
      } catch { /* keep as-is */ }

      if (isValidLandingPageUrl(url)) {
        console.log(`[URL] Found via aggressive pattern: ${url.substring(0, 80)}`);
        return decodeUrl(url);
      }
    }
  }

  // Strategy 2: Find any https:// URL that's not Facebook in the entire HTML
  const allUrls = html.matchAll(/(?:"|')(https?:\/\/(?!(?:www\.)?(?:facebook\.com|fb\.com|fbcdn\.net|instagram\.com|meta\.com|facebook\.net|connect\.facebook)[\/"])[a-zA-Z0-9][^"'\s<>]{10,200})(?:"|')/g);

  const candidateUrls: string[] = [];
  for (const m of allUrls) {
    let url = m[1].replace(/\\\//g, '/');
    // Skip static assets, CDN, etc.
    if (/\.(js|css|png|jpg|gif|svg|woff|ttf|ico)(\?|$)/i.test(url)) continue;
    if (/googleapis\.com|gstatic\.com|cloudflare|sentry\.io|google-analytics/i.test(url)) continue;
    if (isValidLandingPageUrl(url)) {
      candidateUrls.push(url);
    }
  }

  if (candidateUrls.length > 0) {
    // Prefer URLs that look like landing pages (have paths, not just domains)
    const withPath = candidateUrls.filter(u => {
      try { return new URL(u).pathname.length > 1; } catch { return false; }
    });
    const best = withPath[0] || candidateUrls[0];
    console.log(`[URL] Found via broad scan: ${best.substring(0, 80)} (${candidateUrls.length} candidates)`);
    return decodeUrl(best);
  }

  return null;
}

/**
 * Follow redirects and return full chain with final URL
 */
async function followRedirectsWithChain(
  initialUrl: string,
  maxRedirects: number = 10
): Promise<{ final_url: string; chain: string[] }> {
  const chain: string[] = [initialUrl];
  let currentUrl = initialUrl;

  for (let i = 0; i < maxRedirects; i++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);

      const response = await fetch(currentUrl, {
        method: 'HEAD',
        redirect: 'manual',
        signal: ctrl.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        },
      });

      clearTimeout(timer);

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (location) {
          const nextUrl = new URL(location, currentUrl).href;
          if (chain.includes(nextUrl)) break;
          chain.push(nextUrl);
          currentUrl = nextUrl;
          continue;
        }
      }

      // Try GET if HEAD didn't redirect (some servers don't redirect HEAD)
      if (i === 0 && response.status === 200) {
        const getResponse = await fetch(currentUrl, {
          redirect: 'manual',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
          },
        });

        if (getResponse.status >= 300 && getResponse.status < 400) {
          const location = getResponse.headers.get('location');
          if (location) {
            const nextUrl = new URL(location, currentUrl).href;
            if (!chain.includes(nextUrl)) {
              chain.push(nextUrl);
              currentUrl = nextUrl;
              continue;
            }
          }
        }

        // Check for meta refresh in HTML
        if (getResponse.ok) {
          const html = await getResponse.text();
          const metaRefreshUrl = extractFromMetaRefresh(html);
          if (metaRefreshUrl && !chain.includes(metaRefreshUrl)) {
            chain.push(metaRefreshUrl);
            currentUrl = metaRefreshUrl;
            continue;
          }
        }
      }

      break;
    } catch {
      break;
    }
  }

  return { final_url: currentUrl, chain };
}

/**
 * Follow URL to its final destination (simple version)
 */
async function followToFinalUrl(url: string): Promise<string | null> {
  try {
    const result = await followRedirectsWithChain(url, 5);
    return result.final_url !== url ? result.final_url : url;
  } catch {
    return url;
  }
}

/**
 * Extract path and query string from URL
 */
export function extractPathAndQuery(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const pathAndQuery = parsed.pathname + parsed.search;
    return pathAndQuery === '/' ? '/' : pathAndQuery;
  } catch {
    return null;
  }
}

// ============================================
// Helper: Format Reach
// ============================================

/**
 * Format reach number into human-readable string
 */
export function formatReach(reach: number | null | undefined): string | null {
  if (!reach) return null;

  if (reach >= 1000000) {
    return `${(reach / 1000000).toFixed(1)}M`;
  } else if (reach >= 1000) {
    return `${(reach / 1000).toFixed(0)}K`;
  }

  return reach.toLocaleString('de-DE');
}
