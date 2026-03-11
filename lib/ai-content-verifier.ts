/**
 * AI Content-Based Verifier
 *
 * Scrapes actual page content (brand homepage + landing pages) and uses
 * GPT-4o-mini to verify whether a landing page promotes the brand's products.
 *
 * Much more accurate than name-based verification because the AI sees
 * real text content, not just page names.
 */

import type { ThirdPartyPageInfo } from './types.ts';

// ============================================
// Types
// ============================================

export interface BrandProfile {
  domain: string;
  title: string;
  description: string;
  body_text: string;
  products_hint: string;
  success: boolean;
}

export interface PageContent {
  url: string;
  title: string;
  description: string;
  body_text: string;
  success: boolean;
}

export interface ContentVerdict {
  verdict: 'match' | 'no_match' | 'uncertain';
  confidence: number;
  reason: string;
}

export interface PageVerificationDetail {
  page_id: string;
  page_name: string;
  connection_type: string;
  domain_scraped: string | null;
  scrape_success: boolean;
  verdict: ContentVerdict;
}

export interface VerificationReport {
  brand: string;
  brand_profile_summary: string;
  total_pages: number;
  pages_checked: number;
  pages_kept: number;
  pages_removed: number;
  pages_scrape_failed: number;
  details: PageVerificationDetail[];
}

// ============================================
// HTML Text Extraction
// ============================================

/**
 * Strip HTML tags and extract clean text from HTML content.
 * Returns title, meta description, and body text.
 */
function extractTextFromHtml(html: string): { title: string; description: string; body_text: string } {
  // Extract title
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : '';

  // Extract meta description
  const metaDescMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*?)["']/i)
    || html.match(/<meta[^>]*content=["']([^"']*?)["'][^>]*name=["']description["']/i);
  const metaDesc = metaDescMatch ? metaDescMatch[1].trim() : '';

  // Extract og:description as fallback
  const ogDescMatch = html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']*?)["']/i)
    || html.match(/<meta[^>]*content=["']([^"']*?)["'][^>]*property=["']og:description["']/i);
  const ogDesc = ogDescMatch ? ogDescMatch[1].trim() : '';

  const description = metaDesc || ogDesc;

  // Strip script/style/nav/footer tags first
  let bodyHtml = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  // Extract body content
  const bodyMatch = bodyHtml.match(/<body[\s\S]*?>([\s\S]*)<\/body>/i);
  if (bodyMatch) bodyHtml = bodyMatch[1];

  // Strip all remaining HTML tags
  let text = bodyHtml
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#\d+;/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Limit to ~500 words
  const words = text.split(/\s+/);
  if (words.length > 500) {
    text = words.slice(0, 500).join(' ') + '...';
  }

  return { title, description, body_text: text };
}

// ============================================
// Scraping Functions
// ============================================

/**
 * Scrape a URL with plain HTTP and extract text content.
 * No headless browser needed — works for ~80% of pages.
 */
async function scrapeUrl(url: string, timeoutMs: number = 10000): Promise<PageContent> {
  const result: PageContent = {
    url,
    title: '',
    description: '',
    body_text: '',
    success: false,
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
      },
      redirect: 'follow',
    });

    clearTimeout(timeout);

    if (!response.ok) {
      console.log(`[ContentVerify] Scrape ${url} → HTTP ${response.status}`);
      return result;
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) {
      console.log(`[ContentVerify] Scrape ${url} → not HTML (${contentType})`);
      return result;
    }

    const html = await response.text();
    if (html.length < 200) {
      console.log(`[ContentVerify] Scrape ${url} → too short (${html.length} chars)`);
      return result;
    }

    const extracted = extractTextFromHtml(html);
    result.title = extracted.title;
    result.description = extracted.description;
    result.body_text = extracted.body_text;
    result.success = extracted.body_text.length > 50; // Need at least some text

    return result;
  } catch (error) {
    const errMsg = String(error).substring(0, 80);
    if (!errMsg.includes('abort')) {
      console.log(`[ContentVerify] Scrape ${url} → error: ${errMsg}`);
    }
    return result;
  }
}

/**
 * Scrape the brand's homepage to build a profile of what the brand sells.
 */
export async function scrapeBrandProfile(brandDomain: string): Promise<BrandProfile> {
  const profile: BrandProfile = {
    domain: brandDomain,
    title: '',
    description: '',
    body_text: '',
    products_hint: '',
    success: false,
  };

  // Try main domain
  const urls = [
    `https://${brandDomain}`,
    `https://www.${brandDomain}`,
  ];

  for (const url of urls) {
    const content = await scrapeUrl(url);
    if (content.success) {
      profile.title = content.title;
      profile.description = content.description;
      profile.body_text = content.body_text;
      profile.success = true;
      break;
    }
  }

  // Try Shopify /products.json for product hints
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const prodResp = await fetch(`https://${brandDomain}/products.json?limit=5`, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    });
    clearTimeout(timeout);

    if (prodResp.ok) {
      const prodData = await prodResp.json();
      const products = prodData?.products || [];
      const productNames = products.slice(0, 5).map((p: any) => p.title).filter(Boolean);
      if (productNames.length > 0) {
        profile.products_hint = `Produkte: ${productNames.join(', ')}`;
      }
    }
  } catch { /* Shopify check is optional */ }

  if (profile.success) {
    console.log(`[ContentVerify] Brand profile scraped: ${brandDomain} (${profile.body_text.length} chars)`);
  } else {
    console.log(`[ContentVerify] Brand profile scrape FAILED: ${brandDomain}`);
  }

  return profile;
}

/**
 * Scrape a landing page for a third-party page result.
 * Tries the best URL from domain_urls first (actual landing page),
 * then falls back to domain homepage.
 */
export async function scrapePageContent(domain: string, bestUrl?: string): Promise<PageContent> {
  // Try best URL first (actual ad landing page — much better content)
  if (bestUrl) {
    const result = await scrapeUrl(bestUrl);
    if (result.success) return result;
  }
  // Fallback to domain homepage
  return await scrapeUrl(`https://${domain}`);
}

// ============================================
// AI Content Verification
// ============================================

/**
 * Use GPT-4o-mini to compare brand profile with landing page content.
 * Returns verdict: does this page promote/sell the brand's products?
 */
export async function verifyWithContent(
  brandProfile: BrandProfile,
  pageContent: PageContent,
  pageName: string,
  openaiKey: string,
  connectionType?: string
): Promise<ContentVerdict> {
  // Build brand context
  const brandContext = [
    brandProfile.title && `Titel: ${brandProfile.title}`,
    brandProfile.description && `Beschreibung: ${brandProfile.description}`,
    brandProfile.products_hint,
    brandProfile.body_text && `Inhalt: ${brandProfile.body_text.substring(0, 800)}`,
  ].filter(Boolean).join('\n');

  // Build page context
  const pageContext = [
    pageContent.title && `Titel: ${pageContent.title}`,
    pageContent.description && `Beschreibung: ${pageContent.description}`,
    pageContent.body_text && `Inhalt: ${pageContent.body_text.substring(0, 800)}`,
  ].filter(Boolean).join('\n');

  // Connection type context for the AI
  const connContext = connectionType === 'checkout_match'
    ? 'Verbindungstyp: checkout_match (NUR der Checkout-Markenname stimmte ueberein — PRUEFE GENAU ob wirklich die gleiche Marke)'
    : connectionType === 'deep_cta' || connectionType === 'presell_cta'
    ? 'Verbindungstyp: ' + connectionType + ' (URL-Chain wurde verifiziert: CTA-Button auf der Seite leitet zur Brand-Domain weiter — starkes Signal)'
    : connectionType === 'content_link'
    ? 'Verbindungstyp: content_link (die Brand-Domain wurde in den Facebook-Ads dieser Seite gefunden — die Seite verlinkt aktiv zur Brand)'
    : connectionType
    ? 'Verbindungstyp: ' + connectionType
    : '';

  const prompt = `Du bist ein Experte fuer Facebook-Werbung. Pruefe ob eine Landingpage die Produkte einer bestimmten Marke bewirbt.

## BRAND: ${brandProfile.domain}
${brandContext || '(keine Daten verfuegbar)'}

## LANDINGPAGE: "${pageName}"
URL: ${pageContent.url}
${connContext}
${pageContext || '(keine Daten verfuegbar)'}

## Frage
Bewirbt diese Landingpage die Produkte/Marke von ${brandProfile.domain}?

Moegliche Ergebnisse:
- MATCH: Die Seite bewirbt/verkauft/empfiehlt Produkte dieser Brand (z.B. Affiliate, Presell-Seite, Magazin das fuer die Brand wirbt)
- NO_MATCH: Die Seite bewirbt ein komplett anderes Produkt/eine andere Marke — kein Bezug zur Brand
- UNCERTAIN: Nicht genug Informationen

WICHTIG: Wenn der Inhalt der Landingpage den Brand-Namen erwaehnt oder deren Produkte direkt bewirbt/verlinkt → MATCH.
Presell-Seiten und Magazine die fuer eine Brand werben sind MATCH, auch wenn sie einen anderen Seitennamen haben.

Antworte NUR mit einem JSON Objekt (kein Markdown):
{"verdict": "MATCH", "confidence": 0.9, "reason": "Kurze Begruendung"}`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'Antworte nur mit validem JSON. Kein Markdown.' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.1,
        max_tokens: 150,
      }),
    });

    if (!response.ok) {
      console.log(`[ContentVerify] AI call failed: HTTP ${response.status}`);
      return { verdict: 'uncertain', confidence: 0, reason: 'AI API error' };
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) {
      return { verdict: 'uncertain', confidence: 0, reason: 'Empty AI response' };
    }

    const jsonStr = content.replace(/^```json?\s*/, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(jsonStr);

    const verdict = parsed.verdict?.toUpperCase() === 'MATCH' ? 'match'
      : parsed.verdict?.toUpperCase() === 'NO_MATCH' ? 'no_match'
      : 'uncertain';

    return {
      verdict,
      confidence: parsed.confidence || 0.5,
      reason: parsed.reason || 'No reason given',
    };
  } catch (error) {
    console.log(`[ContentVerify] AI error: ${String(error).substring(0, 100)}`);
    return { verdict: 'uncertain', confidence: 0, reason: `Error: ${String(error).substring(0, 80)}` };
  }
}

// ============================================
// Domain Resolution: Find the right domain for each page
// ============================================

/**
 * Domain data from the cached discovery result.
 * Used to find which domain belongs to which page.
 */
export interface CachedDomainData {
  domains_all: string[];
  domain_urls: Record<string, { url: string; count: number }[]>;
  brand_domain: string;
}

/**
 * Try to find the landing domain for a page.
 * Strategy:
 * 1. page.domains_used[0] if available
 * 2. page.discovered_via if it looks like a domain
 * 3. Fuzzy match page name against cached domain names
 *    (e.g., "Dynamik Plus" → "dynamikplus.de", "MensSana" → "shop.menssana.de")
 */
function findDomainForPage(
  page: ThirdPartyPageInfo,
  domainData: CachedDomainData | null,
): string | null {
  // 1. Direct from page data
  if (page.domains_used?.length > 0) return page.domains_used[0];
  if ((page as any).discovered_via && (page as any).discovered_via.includes('.')) {
    return (page as any).discovered_via;
  }

  if (!domainData) return null;

  // 2. Fuzzy match: normalize page name and compare to domain names
  const pageLower = page.page_name.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (pageLower.length < 3) return null;

  const nonBrandDomains = domainData.domains_all.filter(d => d !== domainData.brand_domain);

  for (const domain of nonBrandDomains) {
    // Extract all meaningful parts from domain
    // e.g., "news.dailyrituals.de" → ["news", "dailyrituals", "newsdailyrituals"]
    // e.g., "shop.menssana.de" → ["shop", "menssana", "shopmenssana"]
    // e.g., "dynamikplus.de" → ["dynamikplus"]
    const parts = domain.split('.');
    const tld = parts[parts.length - 1]; // de, com, etc.
    const meaningfulParts = parts.filter(p => p !== tld && p !== 'www').map(p => p.toLowerCase());

    for (const part of meaningfulParts) {
      if (part.length < 3) continue;
      if (pageLower.includes(part) || part.includes(pageLower)) {
        return domain;
      }
    }

    // Also try concatenation of subdomains (e.g., "news"+"dailyrituals" → "newsdailyrituals")
    if (meaningfulParts.length > 1) {
      const concat = meaningfulParts.join('');
      if (pageLower.includes(concat) || concat.includes(pageLower)) {
        return domain;
      }
    }
  }

  // 3. Check domain_urls values for page name references (less reliable)
  // Skip this — too many false matches

  return null;
}

// ============================================
// AI Name-Only Verification (fallback when no domain to scrape)
// ============================================

/**
 * Verify a page using ONLY the brand profile and page name.
 * Used when we can't find/scrape a landing domain for the page.
 */
async function verifyWithNameOnly(
  brandProfile: BrandProfile,
  pageName: string,
  connectionType: string,
  openaiKey: string
): Promise<ContentVerdict> {
  const brandContext = [
    brandProfile.title && `Titel: ${brandProfile.title}`,
    brandProfile.description && `Beschreibung: ${brandProfile.description}`,
    brandProfile.products_hint,
    brandProfile.body_text && `Inhalt: ${brandProfile.body_text.substring(0, 600)}`,
  ].filter(Boolean).join('\n');

  const prompt = `Du bist ein Experte fuer Facebook-Werbung. Pruefe ob eine Drittseite wahrscheinlich fuer eine bestimmte Marke wirbt.

## BRAND: ${brandProfile.domain}
${brandContext || '(keine Daten verfuegbar)'}

## DRITTSEITE
Name: "${pageName}"
Verbindungstyp: ${connectionType}

## Frage
Ist es wahrscheinlich, dass diese Facebook-Seite die Produkte von ${brandProfile.domain} bewirbt?

Hinweise:
- Wenn der Seitenname Begriffe enthaelt die zu den Brand-Produkten passen (z.B. "Kollagen" fuer eine Kollagen-Marke) → eher MATCH
- Wenn der Seitenname eine komplett eigenstaendige Marke/Firma ist die andere Produkte verkauft → NO_MATCH
- Verbindungstyp "deep_cta" oder "presell_cta" bedeutet: die URL-Chain wurde bereits verifiziert → tendiere zu MATCH
- Verbindungstyp "checkout_match" bedeutet: nur der Checkout-Markenname stimmte ueberein → pruefe genauer

Antworte NUR mit einem JSON Objekt (kein Markdown):
{"verdict": "MATCH", "confidence": 0.9, "reason": "Kurze Begruendung"}`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'Antworte nur mit validem JSON. Kein Markdown.' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.1,
        max_tokens: 150,
      }),
    });

    if (!response.ok) {
      return { verdict: 'uncertain', confidence: 0, reason: 'AI API error' };
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) return { verdict: 'uncertain', confidence: 0, reason: 'Empty AI response' };

    const jsonStr = content.replace(/^```json?\s*/, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(jsonStr);

    const verdict = parsed.verdict?.toUpperCase() === 'MATCH' ? 'match'
      : parsed.verdict?.toUpperCase() === 'NO_MATCH' ? 'no_match'
      : 'uncertain';

    return { verdict, confidence: parsed.confidence || 0.5, reason: parsed.reason || 'No reason' };
  } catch (error) {
    return { verdict: 'uncertain', confidence: 0, reason: `Error: ${String(error).substring(0, 80)}` };
  }
}

// ============================================
// Orchestration: Verify All Pages for a Brand
// ============================================

/**
 * Verify all third-party pages for a brand using content scraping + AI.
 *
 * Flow:
 * 1. Scrape brand homepage once
 * 2. For each page: find domain → scrape → AI compare (or name-only fallback)
 * 3. Return report with kept/removed pages
 *
 * Domain resolution: tries page.domains_used, discovered_via, fuzzy name match.
 * Scrape cache: each domain is scraped only once and reused for all pages using it.
 * Safety: If scrape fails or no domain found → name-only AI check (never skip).
 */
export async function verifyAllPages(
  brandName: string,
  brandDomain: string | null,
  pages: ThirdPartyPageInfo[],
  openaiKey: string,
  options: { dryRun?: boolean; domainData?: CachedDomainData } = {}
): Promise<VerificationReport> {
  const report: VerificationReport = {
    brand: brandName,
    brand_profile_summary: '',
    total_pages: pages.length,
    pages_checked: 0,
    pages_kept: 0,
    pages_removed: 0,
    pages_scrape_failed: 0,
    details: [],
  };

  if (!brandDomain || pages.length === 0) {
    report.pages_kept = pages.length;
    return report;
  }

  // Step 1: Scrape brand homepage
  const brandProfile = await scrapeBrandProfile(brandDomain);
  report.brand_profile_summary = brandProfile.success
    ? `${brandProfile.title} — ${brandProfile.description || brandProfile.body_text.substring(0, 150)}`
    : '(Scrape fehlgeschlagen)';

  if (!brandProfile.success) {
    console.log(`[ContentVerify] Brand scrape failed for ${brandDomain} — keeping all pages`);
    report.pages_kept = pages.length;
    return report;
  }

  // Step 2: Scrape cache — avoid scraping the same domain twice
  const scrapedDomains = new Map<string, PageContent>();

  // Step 3: For each page, find domain, scrape, and verify
  for (const page of pages) {
    const domain = findDomainForPage(page, options.domainData || null);

    let pageContent: PageContent | null = null;
    let scrapeSuccess = false;

    // For checkout_match: scrape landing domain for full content comparison
    // For other types (content_link, deep_cta, etc.): these have verified URL chains,
    // scraping the page's OWN domain is misleading (e.g., easyApotheke homepage shows
    // Dr. Theiss, but their ADS link to doppelherz.de). Use name-only for these.
    const isCheckoutMatch = page.connection_type === 'checkout_match';

    if (isCheckoutMatch && domain && domain !== brandDomain) {
      // Scrape the landing domain (with cache)
      if (scrapedDomains.has(domain)) {
        pageContent = scrapedDomains.get(domain)!;
      } else {
        const bestUrl = options.domainData?.domain_urls?.[domain]?.[0]?.url || undefined;
        pageContent = await scrapePageContent(domain, bestUrl);
        scrapedDomains.set(domain, pageContent);
        await new Promise(r => setTimeout(r, 300));
      }
      scrapeSuccess = pageContent?.success || false;
    }

    let verdict: ContentVerdict;

    if (isCheckoutMatch && pageContent?.success) {
      // Full content verification for checkout_match
      verdict = await verifyWithContent(brandProfile, pageContent, page.page_name, openaiKey, page.connection_type);
    } else {
      // Name-only verification (for verified connection types OR failed scrapes)
      if (isCheckoutMatch && domain && !scrapeSuccess) report.pages_scrape_failed++;
      verdict = await verifyWithNameOnly(brandProfile, page.page_name, page.connection_type, openaiKey);
    }

    report.pages_checked++;

    const detail: PageVerificationDetail = {
      page_id: page.page_id,
      page_name: page.page_name,
      connection_type: page.connection_type,
      domain_scraped: domain,
      scrape_success: scrapeSuccess,
      verdict,
    };
    report.details.push(detail);

    // Two-tier removal:
    // - checkout_match: threshold 0.8 (weakly verified, content scrape is key evidence)
    // - Other types: never removed (verified URL chains, name-only check can't override)
    const canRemove = isCheckoutMatch
      && verdict.verdict === 'no_match'
      && verdict.confidence >= 0.8;

    if (canRemove) {
      report.pages_removed++;
      console.log(`[ContentVerify] REMOVE: "${page.page_name}" (${domain || 'no-domain'}) — ${verdict.reason}`);
    } else {
      report.pages_kept++;
      const tag = verdict.verdict === 'match' ? 'KEEP'
        : verdict.verdict === 'no_match' ? 'FLAGGED/KEEP'
        : 'UNCERTAIN/KEEP';
      console.log(`[ContentVerify] ${tag}: "${page.page_name}" (${domain || 'no-domain'}) — ${verdict.reason} [conf=${verdict.confidence}]`);
    }

    // Rate limit: 1s pause between AI calls
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log(`[ContentVerify] ${brandName}: ${report.pages_checked} checked, ${report.pages_kept} kept, ${report.pages_removed} removed, ${report.pages_scrape_failed} scrape failed`);
  return report;
}

/**
 * Apply verification report to pages — returns kept and removed arrays.
 */
export function applyContentVerification(
  pages: ThirdPartyPageInfo[],
  report: VerificationReport
): { kept: ThirdPartyPageInfo[]; removed: ThirdPartyPageInfo[] } {
  // Only remove checkout_match pages with high-confidence no_match
  const removedIds = new Set(
    report.details
      .filter(d =>
        d.connection_type === 'checkout_match'
        && d.verdict.verdict === 'no_match'
        && d.verdict.confidence >= 0.8
      )
      .map(d => d.page_id)
  );

  const kept: ThirdPartyPageInfo[] = [];
  const removed: ThirdPartyPageInfo[] = [];

  for (const page of pages) {
    if (removedIds.has(page.page_id)) {
      page.flagged_suspicious = true;
      page.flag_reason = report.details.find(d => d.page_id === page.page_id)?.verdict.reason || 'Content mismatch';
      page.ai_verdict = 'confirmed_false_positive';
      page.ai_confidence = report.details.find(d => d.page_id === page.page_id)?.verdict.confidence || 0.9;
      removed.push(page);
    } else {
      kept.push(page);
    }
  }

  return { kept, removed };
}
