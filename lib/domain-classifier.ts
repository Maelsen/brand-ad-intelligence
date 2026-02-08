/**
 * Domain Classifier
 * Intelligently classifies domains as presell, shop, affiliate, or unknown
 * based on content analysis and URL patterns
 */

export type DomainType = 'presell' | 'affiliate' | 'shop' | 'redirect' | 'unknown';

export interface DomainClassification {
  domain: string;
  type: DomainType;
  confidence: number;
  indicators: string[];
  final_url?: string;
}

// Shop indicators (checkout, cart, product pages)
const SHOP_INDICATORS = {
  url: [
    /checkout/i,
    /warenkorb/i,
    /cart/i,
    /shop\./i,
    /store\./i,
    /\/product/i,
    /\/produkt/i,
  ],
  html: [
    /shopify/i,
    /woocommerce/i,
    /magento/i,
    /add[_-]?to[_-]?cart/i,
    /buy[_-]?now/i,
    /jetzt[_-]?kaufen/i,
    /"@type"\s*:\s*"Product"/i,
    /og:type["'][^>]*content=["']product/i,
    /itemprop=["']price/i,
    /data-price/i,
  ],
};

// Presell/editorial indicators
const PRESELL_INDICATORS = {
  url: [
    /editorial/i,
    /review/i,
    /erfahrung/i,
    /test-/i,
    /-test/i,
    /bewertung/i,
    /ratgeber/i,
    /artikel/i,
    /bericht/i,
    /blog/i,
    /news/i,
    /mission-/i,
    /getestet/i,
  ],
  html: [
    /og:type["'][^>]*content=["']article/i,
    /"@type"\s*:\s*"Article"/i,
    /<article/i,
    /class=["'][^"']*article/i,
    /class=["'][^"']*blog/i,
    /class=["'][^"']*editorial/i,
  ],
};

// Affiliate indicators
const AFFILIATE_INDICATORS = {
  url: [
    /\?ref=/i,
    /\?aff=/i,
    /\?partner=/i,
    /affiliate/i,
    /partner/i,
    /tracking/i,
  ],
  html: [
    /affiliate/i,
    /partner[_-]?link/i,
    /tracking[_-]?id/i,
    /utm_source/i,
    /ref[_-]?code/i,
  ],
};

/**
 * Classify a domain based on its content
 */
export async function classifyDomain(
  domain: string,
  brandName?: string,
  options?: { timeout?: number }
): Promise<DomainClassification> {
  const timeout = options?.timeout || 10000;

  const result: DomainClassification = {
    domain,
    type: 'unknown',
    confidence: 0,
    indicators: [],
  };

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);

    const response = await fetch(`https://${domain}`, {
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
      result.indicators.push(`HTTP ${response.status}`);
      return result;
    }

    const html = await response.text();
    const finalUrl = response.url;
    result.final_url = finalUrl;

    // Check if domain redirected
    const finalDomain = extractDomain(finalUrl);
    if (finalDomain && finalDomain !== domain) {
      result.indicators.push(`Redirected to ${finalDomain}`);
    }

    // Score each category
    const scores = {
      shop: 0,
      presell: 0,
      affiliate: 0,
    };

    // Check URL patterns
    for (const pattern of SHOP_INDICATORS.url) {
      if (pattern.test(finalUrl)) {
        scores.shop += 1;
        result.indicators.push(`URL: ${pattern.source.slice(0, 20)}`);
      }
    }

    for (const pattern of PRESELL_INDICATORS.url) {
      if (pattern.test(finalUrl)) {
        scores.presell += 1;
        result.indicators.push(`URL: ${pattern.source.slice(0, 20)}`);
      }
    }

    for (const pattern of AFFILIATE_INDICATORS.url) {
      if (pattern.test(finalUrl)) {
        scores.affiliate += 1;
        result.indicators.push(`URL: ${pattern.source.slice(0, 20)}`);
      }
    }

    // Check HTML content
    for (const pattern of SHOP_INDICATORS.html) {
      if (pattern.test(html)) {
        scores.shop += 1;
      }
    }

    for (const pattern of PRESELL_INDICATORS.html) {
      if (pattern.test(html)) {
        scores.presell += 1;
      }
    }

    for (const pattern of AFFILIATE_INDICATORS.html) {
      if (pattern.test(html)) {
        scores.affiliate += 0.5; // Lower weight for HTML affiliate patterns
      }
    }

    // Check if brand name is mentioned (if provided)
    if (brandName) {
      const brandRegex = new RegExp(brandName, 'gi');
      const brandMentions = (html.match(brandRegex) || []).length;
      if (brandMentions > 5) {
        result.indicators.push(`Brand mentioned ${brandMentions}x`);
        // High brand mentions with no shop elements = likely presell
        if (scores.shop < 2) {
          scores.presell += 1;
        }
      }

      // If domain contains brand name, likely shop
      if (domain.toLowerCase().includes(brandName.toLowerCase())) {
        scores.shop += 2;
        result.indicators.push('Brand in domain');
      }
    }

    // Determine type based on scores
    const maxScore = Math.max(scores.shop, scores.presell, scores.affiliate);

    if (maxScore === 0) {
      result.type = 'unknown';
      result.confidence = 0;
    } else if (scores.shop >= scores.presell && scores.shop >= scores.affiliate && scores.shop >= 2) {
      result.type = 'shop';
      result.confidence = Math.min(scores.shop / 6, 1);
    } else if (scores.presell >= scores.shop && scores.presell >= scores.affiliate && scores.presell >= 2) {
      result.type = 'presell';
      result.confidence = Math.min(scores.presell / 5, 1);
    } else if (scores.affiliate >= 2) {
      result.type = 'affiliate';
      result.confidence = Math.min(scores.affiliate / 4, 1);
    } else if (maxScore >= 1) {
      // Low confidence classification
      if (scores.shop > scores.presell) {
        result.type = 'shop';
      } else if (scores.presell > scores.shop) {
        result.type = 'presell';
      }
      result.confidence = 0.3;
    }

    return result;
  } catch (error) {
    result.indicators.push(`Error: ${String(error).slice(0, 50)}`);
    return result;
  }
}

/**
 * Batch classify multiple domains
 */
export async function batchClassifyDomains(
  domains: string[],
  brandName?: string,
  concurrency: number = 5,
  options?: { timeout?: number }
): Promise<DomainClassification[]> {
  const results: DomainClassification[] = [];

  for (let i = 0; i < domains.length; i += concurrency) {
    const batch = domains.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(domain => classifyDomain(domain, brandName, options))
    );
    results.push(...batchResults);

    // Small delay between batches
    if (i + concurrency < domains.length) {
      await new Promise(r => setTimeout(r, 100));
    }
  }

  return results;
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
 * Quick classification based on URL patterns only (no fetch)
 */
export function quickClassifyByUrl(url: string): { type: DomainType; confidence: number } {
  let shopScore = 0;
  let presellScore = 0;

  for (const pattern of SHOP_INDICATORS.url) {
    if (pattern.test(url)) shopScore++;
  }

  for (const pattern of PRESELL_INDICATORS.url) {
    if (pattern.test(url)) presellScore++;
  }

  if (shopScore > presellScore && shopScore >= 1) {
    return { type: 'shop', confidence: Math.min(shopScore / 3, 0.7) };
  }
  if (presellScore > shopScore && presellScore >= 1) {
    return { type: 'presell', confidence: Math.min(presellScore / 3, 0.7) };
  }

  return { type: 'unknown', confidence: 0 };
}
