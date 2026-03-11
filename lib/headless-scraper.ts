/**
 * Headless Scraper Service
 * Uses ScrapingBee API as fallback when HTML-based extraction fails.
 * Renders JavaScript, clicks CTA buttons, and captures full redirect URLs.
 *
 * Stufen:
 * 1. HTML Parsing (kostenlos, schnell) - url-extractor.ts
 * 2. ScrapingBee (kostenpflichtig, zuverlässig) - dieser Service
 */

import { PLATFORM_DOMAINS, isPlatformDomain, isValidExternalUrl } from './constants.ts';
import { BrowserRenderer } from './browser-renderer.ts';

export interface HeadlessScrapeResult {
  success: boolean;
  url: string | null;           // Extracted landing page URL
  final_url: string | null;     // After all redirects
  full_path: string | null;     // Path + query params only
  redirect_chain: string[];
  method: 'scrapingbee_extract' | 'scrapingbee_js_render' | 'scrapingbee_redirect';
  credits_used: number;
  error?: string;
}

interface ScrapingBeeResponse {
  body?: string;
  headers?: Record<string, string>;
  resolved_url?: string;
  status_code?: number;
}

const SCRAPINGBEE_BASE_URL = 'https://app.scrapingbee.com/api/v1/';

/**
 * Extract full landing page URL using ScrapingBee
 * Tries multiple strategies in order of cost efficiency
 */
export async function scrapeWithHeadless(
  snapshotUrl: string,
  apiKey?: string,
  adId?: string
): Promise<HeadlessScrapeResult> {
  const key = apiKey || Deno.env.get('SCRAPINGBEE_API_KEY');
  const logId = adId || 'unknown';

  if (!key) {
    return {
      success: false,
      url: null,
      final_url: null,
      full_path: null,
      redirect_chain: [],
      method: 'scrapingbee_extract',
      credits_used: 0,
      error: 'SCRAPINGBEE_API_KEY not configured',
    };
  }

  // Try render_ad URL first (has l.facebook.com/l.php links we need),
  // fall back to Ad Library page if render_ad returns error
  const adIdMatch = snapshotUrl.match(/[?&]id=(\d+)/);
  const adLibraryUrl = adIdMatch ? `https://www.facebook.com/ads/library/?id=${adIdMatch[1]}` : null;
  let totalCredits = 0;

  // Strategy 0: LOCAL BROWSER render + DOM extraction (FREE, no credits)
  // Uses page.evaluate() with CSS selectors (same as ScrapingBee extract_rules)
  // Much more reliable than regex on serialized HTML for Facebook's React pages.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const renderer = BrowserRenderer.getInstance();

      if (attempt === 0) {
        console.log(`[Headless] Ad ${logId}: Trying local browser render...`);
      } else {
        console.log(`[Headless] Ad ${logId}: Retry local browser (attempt ${attempt + 1})...`);
      }
      const browserResult = await renderer.renderPage(snapshotUrl, {
        wait_ms: 5000,
        timeout_ms: 25000,
      });

      // First: check DOM-extracted URLs (most reliable for Facebook)
      if (browserResult.extracted_urls) {
        const eu = browserResult.extracted_urls;
        const lphpCount = eu.lphp_links.length;
        const lynxCount = eu.lynx_uris.length;
        const extCount = eu.external_links.length;

        // Try l.php links first (same priority as ScrapingBee Strategy 1)
        for (const href of eu.lphp_links) {
          const cleanUrl = extractUrlFromFacebookRedirect(href);
          if (cleanUrl && isValidExternalUrl(cleanUrl)) {
            console.log(`[Headless] Ad ${logId}: Local DOM extract → l.php → ${cleanUrl.substring(0, 80)} (lphp=${lphpCount}, lynx=${lynxCount}, ext=${extCount})`);
            const finalResult = await followRedirectsSimple(cleanUrl);
            return {
              success: true, url: cleanUrl, final_url: finalResult.final_url,
              full_path: extractPathAndQuery(finalResult.final_url),
              redirect_chain: finalResult.chain, method: 'scrapingbee_extract', credits_used: 0,
            };
          }
        }

        // Try lynx-uri attributes
        for (const uri of eu.lynx_uris) {
          const cleanUrl = extractUrlFromFacebookRedirect(uri);
          if (cleanUrl && isValidExternalUrl(cleanUrl)) {
            console.log(`[Headless] Ad ${logId}: Local DOM extract → lynx-uri → ${cleanUrl.substring(0, 80)}`);
            const finalResult = await followRedirectsSimple(cleanUrl);
            return {
              success: true, url: cleanUrl, final_url: finalResult.final_url,
              full_path: extractPathAndQuery(finalResult.final_url),
              redirect_chain: finalResult.chain, method: 'scrapingbee_extract', credits_used: 0,
            };
          }
        }

        // Try external links
        for (const href of eu.external_links) {
          if (isValidExternalUrl(href)) {
            console.log(`[Headless] Ad ${logId}: Local DOM extract → external → ${href.substring(0, 80)}`);
            const finalResult = await followRedirectsSimple(href);
            return {
              success: true, url: href, final_url: finalResult.final_url,
              full_path: extractPathAndQuery(finalResult.final_url),
              redirect_chain: finalResult.chain, method: 'scrapingbee_extract', credits_used: 0,
            };
          }
        }

        console.log(`[Headless] Ad ${logId}: Local DOM extract found no valid URLs (lphp=${lphpCount}, lynx=${lynxCount}, ext=${extCount})`);
      }

      // Fallback: regex on HTML string
      if (browserResult.html && browserResult.html.length > 500) {
        const url = extractUrlFromRenderedHtml(browserResult.html);
        if (url) {
          console.log(`[Headless] Ad ${logId}: Local HTML regex → ${url.substring(0, 80)}`);
          const finalResult = await followRedirectsSimple(url);
          return {
            success: true, url: url, final_url: finalResult.final_url,
            full_path: extractPathAndQuery(finalResult.final_url),
            redirect_chain: finalResult.chain, method: 'scrapingbee_js_render', credits_used: 0,
          };
        }
        console.log(`[Headless] Ad ${logId}: Local browser rendered but no URL found (${browserResult.html.length} chars)`);
        break; // HTML was there, DOM extraction ran — no point retrying
      } else {
        console.log(`[Headless] Ad ${logId}: Local browser failed: ${browserResult.error || 'empty HTML'}`);
        // On Protocol error, retry once
        if (attempt === 0 && browserResult.error?.includes('Protocol error')) continue;
        break;
      }
    } catch (error) {
      const errMsg = String(error);
      console.log(`[Headless] Ad ${logId}: Local browser error: ${errMsg.substring(0, 100)}`);
      // Retry on Protocol error / crash
      if (attempt === 0 && errMsg.includes('Protocol error')) continue;
      break;
    }
  }

  // ScrapingBee as last-resort fallback (only if local browser failed)
  console.log(`[Headless] Ad ${logId}: Local failed — trying ScrapingBee fallback...`);

  // Strategy 1: CSS extract rules (5 credits, cheapest)
  const extractResult = await tryScrapingBeeExtract(snapshotUrl, key, logId);
  totalCredits += extractResult.credits_used;
  if (extractResult.success) return extractResult;

  // Strategy 2: Full JS render + regex (5 credits)
  const renderResult = await tryScrapingBeeRender(snapshotUrl, key, logId);
  totalCredits += renderResult.credits_used;
  if (renderResult.success) return renderResult;

  // Strategy 2b: Try Ad Library URL if different from snapshot
  if (adLibraryUrl && adLibraryUrl !== snapshotUrl) {
    console.log(`[Headless] Ad ${logId}: Trying Ad Library URL...`);
    const altResult = await tryScrapingBeeExtract(adLibraryUrl, key, logId);
    totalCredits += altResult.credits_used;
    if (altResult.success) return altResult;
  }

  // All methods exhausted
  console.log(`[Headless] Ad ${logId}: All methods failed (${totalCredits} credits used)`);
  return {
    success: false,
    url: null,
    final_url: null,
    full_path: null,
    redirect_chain: [],
    method: 'scrapingbee_extract',
    credits_used: totalCredits,
    error: 'All extraction methods failed',
  };
}

/**
 * Strategy 1: Use ScrapingBee extract rules to find CTA URL (cheapest)
 */
async function tryScrapingBeeExtract(
  snapshotUrl: string,
  apiKey: string,
  logId: string
): Promise<HeadlessScrapeResult> {
  try {
    const params = new URLSearchParams({
      api_key: apiKey,
      url: snapshotUrl,
      render_js: 'true',
      wait: '5000',
      // Extract CTA button href directly
      extract_rules: JSON.stringify({
        // Facebook l.php redirect links (highest priority)
        lphp_links: {
          selector: 'a[href*="l.facebook.com/l.php"], a[href*="l.instagram.com/l.php"]',
          output: '@href',
          type: 'list',
        },
        // data-lynx-uri attributes (Facebook internal)
        lynx_uri: {
          selector: '[data-lynx-uri*="l.facebook.com"]',
          output: '@data-lynx-uri',
          type: 'list',
        },
        // External links (not Facebook/Meta)
        external_links: {
          selector: 'a[href^="http"]:not([href*="facebook.com"]):not([href*="instagram.com"]):not([href*="meta."])',
          output: '@href',
          type: 'list',
        },
        meta_url: {
          selector: 'meta[property="og:url"]',
          output: '@content',
        },
      }),
    });

    const response = await fetch(`${SCRAPINGBEE_BASE_URL}?${params}`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });

    if (!response.ok) {
      console.log(`[ScrapingBee] Ad ${logId}: Strategy 1 extract failed: ${response.status}`);
      return makeFailResult('scrapingbee_extract', `HTTP ${response.status}`);
    }

    const data = await response.json();

    const lphpCount = Array.isArray(data.lphp_links) ? data.lphp_links.length : 0;
    const lynxCount = Array.isArray(data.lynx_uri) ? data.lynx_uri.length : 0;
    const extCount = Array.isArray(data.external_links) ? data.external_links.length : 0;

    // Try lphp_links first (extract actual URL from l.php?u=...)
    if (data.lphp_links && Array.isArray(data.lphp_links)) {
      for (const href of data.lphp_links) {
        const cleanUrl = extractUrlFromFacebookRedirect(href);
        if (cleanUrl && isValidExternalUrl(cleanUrl)) {
          console.log(`[ScrapingBee] Ad ${logId}: Strategy 1 → success | lphp=${lphpCount}, lynx=${lynxCount}, ext=${extCount}`);
          const finalResult = await followRedirectsSimple(cleanUrl);
          return {
            success: true,
            url: cleanUrl,
            final_url: finalResult.final_url,
            full_path: extractPathAndQuery(finalResult.final_url),
            redirect_chain: finalResult.chain,
            method: 'scrapingbee_extract',
            credits_used: 5,
          };
        }
      }
    }

    // Try lynx_uri next (same extraction)
    if (data.lynx_uri && Array.isArray(data.lynx_uri)) {
      for (const href of data.lynx_uri) {
        const cleanUrl = extractUrlFromFacebookRedirect(href);
        if (cleanUrl && isValidExternalUrl(cleanUrl)) {
          console.log(`[ScrapingBee] Ad ${logId}: Strategy 1 → success (lynx) | lphp=${lphpCount}, lynx=${lynxCount}, ext=${extCount}`);
          const finalResult = await followRedirectsSimple(cleanUrl);
          return {
            success: true,
            url: cleanUrl,
            final_url: finalResult.final_url,
            full_path: extractPathAndQuery(finalResult.final_url),
            redirect_chain: finalResult.chain,
            method: 'scrapingbee_extract',
            credits_used: 5,
          };
        }
      }
    }

    // Try external_links last (filter with isValidExternalUrl)
    if (data.external_links && Array.isArray(data.external_links)) {
      for (const href of data.external_links) {
        if (href && isValidExternalUrl(href)) {
          console.log(`[ScrapingBee] Ad ${logId}: Strategy 1 → success (external) | lphp=${lphpCount}, lynx=${lynxCount}, ext=${extCount}`);
          const finalResult = await followRedirectsSimple(href);
          return {
            success: true,
            url: href,
            final_url: finalResult.final_url,
            full_path: extractPathAndQuery(finalResult.final_url),
            redirect_chain: finalResult.chain,
            method: 'scrapingbee_extract',
            credits_used: 5,
          };
        }
      }
    }

    // Try meta_url as final fallback
    if (data.meta_url && isValidExternalUrl(data.meta_url)) {
      console.log(`[ScrapingBee] Ad ${logId}: Strategy 1 → success (meta) | lphp=${lphpCount}, lynx=${lynxCount}, ext=${extCount}`);
      return {
        success: true,
        url: data.meta_url,
        final_url: data.meta_url,
        full_path: extractPathAndQuery(data.meta_url),
        redirect_chain: [data.meta_url],
        method: 'scrapingbee_extract',
        credits_used: 5,
      };
    }

    console.log(`[ScrapingBee] Ad ${logId}: Strategy 1 → failed | lphp=${lphpCount}, lynx=${lynxCount}, ext=${extCount}`);
    return makeFailResult('scrapingbee_extract', 'No valid URLs found in extract rules');
  } catch (error) {
    console.log(`[ScrapingBee] Ad ${logId}: Strategy 1 extract error:`, error);
    return makeFailResult('scrapingbee_extract', String(error));
  }
}

/**
 * Strategy 2: Full JS render, get full HTML, parse ourselves (more expensive)
 */
async function tryScrapingBeeRender(
  snapshotUrl: string,
  apiKey: string,
  logId: string
): Promise<HeadlessScrapeResult> {
  try {
    const params = new URLSearchParams({
      api_key: apiKey,
      url: snapshotUrl,
      render_js: 'true',
      wait: '7000',
      // Get rendered HTML
      return_page_source: 'true',
    });

    const response = await fetch(`${SCRAPINGBEE_BASE_URL}?${params}`, {
      method: 'GET',
    });

    if (!response.ok) {
      console.log(`[ScrapingBee] Ad ${logId}: Strategy 2 render failed: ${response.status}`);
      return makeFailResult('scrapingbee_js_render', `HTTP ${response.status}`);
    }

    const html = await response.text();

    // Parse rendered HTML for URLs
    const url = extractUrlFromRenderedHtml(html);
    if (url) {
      console.log(`[ScrapingBee] Ad ${logId}: Strategy 2 → success`);
      const finalResult = await followRedirectsSimple(url);
      return {
        success: true,
        url: url,
        final_url: finalResult.final_url,
        full_path: extractPathAndQuery(finalResult.final_url),
        redirect_chain: finalResult.chain,
        method: 'scrapingbee_js_render',
        credits_used: 5,
      };
    }

    console.log(`[ScrapingBee] Ad ${logId}: Strategy 2 → failed (no valid URL in rendered HTML)`);
    return makeFailResult('scrapingbee_js_render', 'No valid URL found in rendered HTML');
  } catch (error) {
    console.log(`[ScrapingBee] Ad ${logId}: Strategy 2 render error:`, error);
    return makeFailResult('scrapingbee_js_render', String(error));
  }
}

/**
 * Extract actual URL from Facebook's l.facebook.com redirect
 */
function extractUrlFromFacebookRedirect(href: string): string | null {
  if (!href) return null;

  try {
    // Facebook wraps external URLs: l.facebook.com/l.php?u=ACTUAL_URL
    if (href.includes('l.facebook.com') || href.includes('l.instagram.com')) {
      const url = new URL(href);
      const actualUrl = url.searchParams.get('u') || url.searchParams.get('href');
      if (actualUrl) {
        return decodeURIComponent(actualUrl);
      }
    }

    // Already a direct URL
    if (href.startsWith('http') && !href.includes('facebook.com') && !href.includes('instagram.com')) {
      return href;
    }
  } catch {
    // Ignore parse errors
  }

  return null;
}

/**
 * Extract URL from fully rendered HTML (after JS execution)
 */
function extractUrlFromRenderedHtml(html: string): string | null {
  // Pattern priority: CTA buttons > data attributes > script tags > links
  const patterns = [
    // CTA button hrefs (highest priority)
    /<a[^>]*href="(https?:\/\/l\.facebook\.com\/l\.php\?u=[^"]+)"[^>]*(?:data-testid="cta|role="link")/gi,
    /<a[^>]*(?:data-testid="cta|role="link")[^>]*href="(https?:\/\/l\.facebook\.com\/l\.php\?u=[^"]+)"/gi,

    // Direct external links in CTA area
    /<a[^>]*href="(https?:\/\/(?!(?:www\.)?(?:facebook|instagram|fb|meta)\.)[^"]+)"[^>]*(?:data-testid="cta|role="link")/gi,
    /<a[^>]*(?:data-testid="cta|role="link")[^>]*href="(https?:\/\/(?!(?:www\.)?(?:facebook|instagram|fb|meta)\.)[^"]+)"/gi,

    // Any Facebook redirect link
    /href="(https?:\/\/l\.facebook\.com\/l\.php\?u=[^"]+)"/gi,

    // Data attributes
    /"(?:link_url|website_url|landing_page_url|destination_url)"\s*:\s*"([^"]+)"/gi,

    // Window.location assignments
    /window\.location(?:\.href)?\s*=\s*["']([^"']+)["']/gi,
  ];

  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    const match = pattern.exec(html);
    if (match && match[1]) {
      const url = extractUrlFromFacebookRedirect(match[1]) || match[1];
      if (url && isValidExternalUrl(url)) {
        return url;
      }
    }
  }

  return null;
}

/**
 * Check if URL is a valid external (non-platform) URL
 */
function isValidExternalUrlLocal(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    const domain = parsed.hostname.toLowerCase();
    const excludedDomains = [
      'facebook.com', 'fb.com', 'fbcdn.net', 'instagram.com',
      'meta.com', 'meta.ai', 'facebook.net', 'threads.net',
      'whatsapp.com', 'messenger.com', 'fb.me',
    ];
    return !excludedDomains.some(d => domain === d || domain.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

/**
 * Extract path and query params from URL
 * e.g., "https://de.weareholy.com/discount/HOLY?utm_source=fb" → "/discount/HOLY?utm_source=fb"
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

/**
 * Simple redirect follower for extracted URLs
 */
async function followRedirectsSimple(
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
      break;
    } catch {
      break;
    }
  }

  return { final_url: currentUrl, chain };
}

/**
 * Batch scrape multiple URLs with ScrapingBee
 */
export async function batchScrapeWithHeadless(
  urls: Array<{ ad_id: string; snapshot_url: string }>,
  concurrency: number = 3,
  apiKey?: string
): Promise<Map<string, HeadlessScrapeResult>> {
  const results = new Map<string, HeadlessScrapeResult>();
  let totalCredits = 0;

  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async ({ ad_id, snapshot_url }) => {
        const result = await scrapeWithHeadless(snapshot_url, apiKey, ad_id);
        return { ad_id, result };
      })
    );

    for (const { ad_id, result } of batchResults) {
      results.set(ad_id, result);
      totalCredits += result.credits_used || 0;
    }

    // Delay between batches (respect rate limits)
    if (i + concurrency < urls.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  console.log(`[ScrapingBee] Batch complete: ${results.size} ads, ~${totalCredits} credits used`);
  return results;
}

/**
 * Extract ad creative image/video URL via ScrapingBee (fallback for Chromium crashes).
 * Uses CSS extract_rules with same selectors as browser-renderer.ts extractAdPreview().
 * Costs 5 credits per call.
 */
export async function scrapeAdPreviewWithScrapingBee(
  snapshotUrl: string,
  adId: string,
  apiKey?: string
): Promise<{ image_url: string | null; video_url: string | null; type: 'image' | 'video' | 'unknown' }> {
  const key = apiKey || Deno.env.get('SCRAPINGBEE_API_KEY');
  if (!key) return { image_url: null, video_url: null, type: 'unknown' };

  try {
    const params = new URLSearchParams({
      api_key: key,
      url: snapshotUrl,
      render_js: 'true',
      wait: '5000',
      extract_rules: JSON.stringify({
        images: {
          selector: 'img[src*="scontent"][src*="fbcdn.net"]',
          output: '@src',
          type: 'list',
        },
        videos: {
          selector: 'video[src*="fbcdn.net"], video source[src*="fbcdn.net"]',
          output: '@src',
          type: 'list',
        },
        video_posters: {
          selector: 'video[poster]',
          output: '@poster',
          type: 'list',
        },
      }),
    });

    const response = await fetch(`${SCRAPINGBEE_BASE_URL}?${params}`, {
      headers: { 'Accept': 'application/json' },
    });

    if (!response.ok) {
      console.log(`[ScrapingBee] Preview ${adId}: HTTP ${response.status}`);
      return { image_url: null, video_url: null, type: 'unknown' };
    }

    const data = await response.json();
    const images: string[] = data.images || [];
    const videos: string[] = data.videos || [];
    const videoPosters: string[] = data.video_posters || [];

    // Video ads: prefer poster (HD thumbnail) over images (often just 60x60 page logo)
    const hasVideo = videos.length > 0;
    const bestImage = images.sort((a, b) => b.length - a.length)[0] || null;
    const creative = hasVideo
      ? (videoPosters[0] || bestImage)
      : (bestImage || videoPosters[0] || null);
    const video = videos[0] || null;
    const type = video ? 'video' : creative ? 'image' : 'unknown';

    if (type !== 'unknown') {
      console.log(`[ScrapingBee] Preview ${adId}: Success (${type}, ${images.length} imgs, ${videos.length} vids)`);
    } else {
      console.log(`[ScrapingBee] Preview ${adId}: No media found (${images.length} imgs, ${videos.length} vids)`);
    }
    return { image_url: creative, video_url: video, type };
  } catch (error) {
    console.log(`[ScrapingBee] Preview ${adId}: Error ${String(error).substring(0, 80)}`);
    return { image_url: null, video_url: null, type: 'unknown' };
  }
}

function makeFailResult(method: HeadlessScrapeResult['method'], error: string): HeadlessScrapeResult {
  return {
    success: false,
    url: null,
    final_url: null,
    full_path: null,
    redirect_chain: [],
    method,
    credits_used: 0,
    error,
  };
}
