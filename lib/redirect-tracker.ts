/**
 * Redirect Chain Tracker
 * Follows HTTP redirects to find final destination URLs
 * Used for Teil 2: Drittseiten Finder
 */

import { RedirectChain } from './types.ts';

const MAX_REDIRECTS = 10;
const REQUEST_TIMEOUT = 10000; // 10 seconds

/**
 * Follow redirects and track the chain
 */
export async function trackRedirectChain(
  initialUrl: string
): Promise<RedirectChain> {
  const chain: string[] = [initialUrl];
  let currentUrl = initialUrl;
  let redirectCount = 0;

  while (redirectCount < MAX_REDIRECTS) {
    try {
      const response = await fetch(currentUrl, {
        method: 'HEAD',
        redirect: 'manual', // Don't auto-follow redirects
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      });

      // Check for redirect status codes
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (location) {
          // Handle relative URLs
          const nextUrl = new URL(location, currentUrl).toString();
          chain.push(nextUrl);
          currentUrl = nextUrl;
          redirectCount++;
          continue;
        }
      }

      // No more redirects
      break;
    } catch (error) {
      // If HEAD fails, try GET
      try {
        const getResponse = await fetch(currentUrl, {
          method: 'GET',
          redirect: 'manual',
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT),
        });

        if (getResponse.status >= 300 && getResponse.status < 400) {
          const location = getResponse.headers.get('location');
          if (location) {
            const nextUrl = new URL(location, currentUrl).toString();
            chain.push(nextUrl);
            currentUrl = nextUrl;
            redirectCount++;
            continue;
          }
        }

        // Check for meta refresh or JavaScript redirects in HTML
        if (
          getResponse.headers.get('content-type')?.includes('text/html')
        ) {
          const html = await getResponse.text();
          const metaRedirect = extractMetaRefreshUrl(html, currentUrl);
          if (metaRedirect && metaRedirect !== currentUrl) {
            chain.push(metaRedirect);
            currentUrl = metaRedirect;
            redirectCount++;
            continue;
          }
        }

        break;
      } catch {
        console.error(`Failed to follow redirect for ${currentUrl}`);
        break;
      }
    }
  }

  return {
    initial_url: initialUrl,
    final_url: currentUrl,
    chain,
  };
}

/**
 * Extract URL from meta refresh tag
 */
function extractMetaRefreshUrl(html: string, baseUrl: string): string | null {
  // Match meta refresh patterns
  const patterns = [
    /<meta[^>]*http-equiv=["']?refresh["']?[^>]*content=["']?\d+;\s*url=([^"'>\s]+)/i,
    /<meta[^>]*content=["']?\d+;\s*url=([^"'>\s]+)["']?[^>]*http-equiv=["']?refresh["']?/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && match[1]) {
      try {
        return new URL(match[1], baseUrl).toString();
      } catch {
        return match[1];
      }
    }
  }

  // Check for JavaScript redirect patterns
  const jsPatterns = [
    /window\.location(?:\.href)?\s*=\s*["']([^"']+)["']/i,
    /location\.replace\(["']([^"']+)["']\)/i,
  ];

  for (const pattern of jsPatterns) {
    const match = html.match(pattern);
    if (match && match[1]) {
      try {
        return new URL(match[1], baseUrl).toString();
      } catch {
        return match[1];
      }
    }
  }

  return null;
}

/**
 * Batch track redirect chains
 */
export async function batchTrackRedirects(
  urls: string[],
  concurrency: number = 3
): Promise<RedirectChain[]> {
  const results: RedirectChain[] = [];
  const uniqueUrls = [...new Set(urls)];

  // Process in batches
  for (let i = 0; i < uniqueUrls.length; i += concurrency) {
    const batch = uniqueUrls.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map((url) => trackRedirectChain(url))
    );
    results.push(...batchResults);

    // Small delay between batches
    if (i + concurrency < uniqueUrls.length) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  return results;
}

/**
 * Categorize domains based on patterns
 */
export function categorizeDomains(redirectChains: RedirectChain[]): {
  presell: Set<string>;
  redirect: Set<string>;
  final_shop: Set<string>;
} {
  const presell = new Set<string>();
  const redirect = new Set<string>();
  const final_shop = new Set<string>();

  // Patterns indicating presell/advertorial domains
  const presellPatterns = [
    /getestet/i,
    /erfahrung/i,
    /test-/i,
    /review/i,
    /mission-/i,
    /gesundheit/i,
    /health/i,
    /blog/i,
    /news/i,
    /artikel/i,
    /story/i,
  ];

  // Patterns indicating shop/final destination
  const shopPatterns = [
    /shop/i,
    /store/i,
    /buy/i,
    /kaufen/i,
    /order/i,
    /checkout/i,
    /cart/i,
    /product/i,
  ];

  for (const chain of redirectChains) {
    // Process each URL in the chain
    for (let i = 0; i < chain.chain.length; i++) {
      const url = chain.chain[i];
      const domain = extractDomainFromUrl(url);
      if (!domain) continue;

      const isLast = i === chain.chain.length - 1;
      const isMiddle = i > 0 && i < chain.chain.length - 1;

      // Categorize based on position and patterns
      if (isLast) {
        // Final URL - likely the shop
        if (shopPatterns.some((p) => p.test(domain) || p.test(url))) {
          final_shop.add(domain);
        } else {
          final_shop.add(domain);
        }
      } else if (isMiddle) {
        // Middle of chain - redirect domain
        redirect.add(domain);
      } else {
        // First URL - check if presell
        if (presellPatterns.some((p) => p.test(domain) || p.test(url))) {
          presell.add(domain);
        }
      }
    }
  }

  return { presell, redirect, final_shop };
}

/**
 * Extract domain from URL
 */
function extractDomainFromUrl(url: string): string | null {
  try {
    const parsedUrl = new URL(url);
    return parsedUrl.hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/**
 * Aggregate domains from multiple ads
 */
export function aggregateDomains(
  landingPageUrls: (string | null)[]
): Map<string, number> {
  const domainCounts = new Map<string, number>();

  for (const url of landingPageUrls) {
    if (!url) continue;
    const domain = extractDomainFromUrl(url);
    if (domain) {
      domainCounts.set(domain, (domainCounts.get(domain) || 0) + 1);
    }
  }

  return domainCounts;
}
