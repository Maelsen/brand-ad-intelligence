/**
 * Deep CTA Chain Tracker
 * Follows CTA buttons through multiple pages using local headless Chromium
 * until reaching a checkout/shop page where the brand can be identified.
 *
 * This solves the core problem: presell pages like naturgesundcheck.com
 * have ZERO name connection to the brand (vitafant.com), but following
 * their CTA chain leads to the brand's checkout page.
 *
 * Flow per hop:
 * 1. Check if URL is on brand domain → MATCH
 * 2. Check if URL is checkout → extract brand → compare
 * 3. Try plain HTTP first (free) → extract CTA from raw HTML
 * 4. If no CTA → headless render → extract CTA from rendered HTML
 * 5. Score CTAs, follow the best one → next hop
 * 6. Repeat up to max_hops (default 5)
 */

import {
  BrandInfo,
  DeepCTAChainResult,
  CTAHopResult,
  CTACandidate,
  DeepCTAOptions,
} from './types.ts';
import { detectBrandFromCheckout } from './checkout-detector.ts';
import { BrowserRenderer } from './browser-renderer.ts';

// ============================================
// Configuration
// ============================================

const DEFAULT_MAX_HOPS = 5;
const DEFAULT_RENDER_WAIT_MS = 6000;
const DEFAULT_TIMEOUT_PER_HOP_MS = 20000;
const DEFAULT_TOTAL_TIMEOUT_MS = 90000;
const MAX_CTA_RETRIES_PER_HOP = 2; // Try 2nd best CTA if first doesn't lead to checkout

// ============================================
// CTA Text Patterns (German + English)
// ============================================

// Strong purchase-intent CTAs (score +15)
const STRONG_CTA_WORDS = [
  'jetzt kaufen', 'jetzt bestellen', 'jetzt sichern', 'jetzt zuschlagen',
  'zum shop', 'zum angebot', 'zum produkt', 'zum warenkorb',
  'hier kaufen', 'hier bestellen', 'hier sichern',
  'in den warenkorb', 'verfügbarkeit prüfen', 'angebot prüfen',
  'buy now', 'shop now', 'order now', 'add to cart',
  'get it now', 'claim offer', 'check availability',
];

// Medium-intent CTAs (score +10)
const MEDIUM_CTA_WORDS = [
  'jetzt zum angebot', 'jetzt entdecken', 'jetzt testen', 'jetzt starten',
  'weiter zum shop', 'weiter zum angebot', 'weiter zur bestellung',
  'produkt ansehen', 'angebot ansehen', 'details ansehen',
  'weiter', 'nächster schritt', 'fortfahren', 'continue',
  'next step', 'proceed', 'get yours', 'get started',
  'learn more', 'see details', 'view product', 'mehr erfahren',
];

// Anchor patterns that likely lead to buy sections
const ANCHOR_BUY_PATTERNS = [
  'zumangebot', 'angebot', 'kaufen', 'bestellen', 'shop',
  'checkout', 'order', 'buy', 'product', 'produkt', 'offer',
  'cart', 'warenkorb', 'kasse', 'pricing', 'preis',
];

// CSS class patterns indicating CTA buttons
const CTA_CSS_PATTERNS = [
  /\bcta\b/i, /\bbtn-primary\b/i, /\bbtn-action\b/i, /\bbtn-cta\b/i,
  /\bbuy-button\b/i, /\bshop-button\b/i, /\border-button\b/i,
  /\baction-button\b/i, /\bmain-cta\b/i, /\bprimary-action\b/i,
  /\bbutton--primary\b/i, /\bbutton-cta\b/i, /\bbtn--primary\b/i,
];

// Checkout/shop URL path patterns
const CHECKOUT_PATH_PATTERNS = [
  /\/checkout/i, /\/checkouts\//i, /\/cart/i,
  /\/warenkorb/i, /\/kasse/i, /\/order/i,
  /\/bestell/i, /\/payment/i, /\/zahlung/i,
];

// Domains to exclude from CTA candidates
const EXCLUDED_DOMAINS = new Set([
  'facebook.com', 'fb.com', 'fb.me', 'instagram.com', 'meta.com',
  'google.com', 'youtube.com', 'twitter.com', 'x.com', 'pinterest.com',
  'tiktok.com', 'linkedin.com', 'whatsapp.com', 'telegram.org',
]);

// Legal/footer link patterns to exclude
const LEGAL_PATTERNS = [
  /impressum/i, /datenschutz/i, /privacy/i, /agb/i, /terms/i,
  /kontakt/i, /contact/i, /about/i, /über uns/i, /faq/i,
  /widerruf/i, /versand/i, /shipping/i, /return/i, /refund/i,
];

// ============================================
// Main Function
// ============================================

/**
 * Follow CTA chain through multiple pages until reaching brand checkout.
 * Uses local headless Chromium for JS rendering when plain HTTP fails.
 */
export async function deepCTAChainFollow(
  startUrl: string,
  options: DeepCTAOptions
): Promise<DeepCTAChainResult> {
  const maxHops = options.max_hops ?? DEFAULT_MAX_HOPS;
  const renderWaitMs = options.render_wait_ms ?? DEFAULT_RENDER_WAIT_MS;
  const timeoutPerHop = options.timeout_per_hop_ms ?? DEFAULT_TIMEOUT_PER_HOP_MS;
  const totalTimeout = options.total_timeout_ms ?? DEFAULT_TOTAL_TIMEOUT_MS;
  const totalStart = Date.now();

  const result: DeepCTAChainResult = {
    initial_url: startUrl,
    chain: [],
    final_url: null,
    final_domain: null,
    is_brand_match: false,
    match_method: 'none',
    confidence: 0,
    total_credits_used: 0,
    total_hops: 0,
  };

  const visitedUrls = new Set<string>();
  let currentUrl = startUrl;
  const startDomain = extractDomain(startUrl) || '';
  let internalHopCount = 0;  // Track hops that stay on the same domain
  const MAX_INTERNAL_HOPS = 2;  // Max hops on same domain before giving up

  for (let hop = 0; hop < maxHops; hop++) {
    // Total timeout check
    if (Date.now() - totalStart > totalTimeout) {
      result.error = `Total timeout after ${hop} hops`;
      console.log(`[DeepCTA] Timeout after ${hop} hops (${totalTimeout}ms)`);
      break;
    }

    // Internal hop limit: if we've bounced around the same domain too many times, stop
    if (internalHopCount >= MAX_INTERNAL_HOPS) {
      console.log(`[DeepCTA] Max internal hops (${MAX_INTERNAL_HOPS}) reached on ${startDomain}, stopping`);
      break;
    }

    // Loop protection
    const normalizedUrl = normalizeUrl(currentUrl);
    if (visitedUrls.has(normalizedUrl)) {
      console.log(`[DeepCTA] Loop detected: ${currentUrl} already visited`);
      break;
    }
    visitedUrls.add(normalizedUrl);

    const hopResult: CTAHopResult = {
      hop_number: hop,
      page_url: currentUrl,
      rendered: false,
      cta_candidates: [],
      chosen_cta: null,
      is_checkout: false,
      domain: extractDomain(currentUrl) || '',
      credits_used: 0,
    };

    console.log(`[DeepCTA] Hop ${hop}: ${currentUrl}`);

    // CHECK 1: Is this URL on the brand domain?
    const currentDomain = extractDomain(currentUrl);
    if (currentDomain && isDomainBrandMatch(currentDomain, options.brand_info)) {
      console.log(`[DeepCTA] MATCH: URL is on brand domain ${currentDomain}`);
      hopResult.is_checkout = isCheckoutUrl(currentUrl);
      result.chain.push(hopResult);
      result.final_url = currentUrl;
      result.final_domain = currentDomain;
      result.is_brand_match = true;
      result.match_method = hopResult.is_checkout ? 'cta_chain_checkout' : 'cta_chain_domain';
      result.confidence = hopResult.is_checkout ? 0.95 : 0.90;
      result.total_hops = hop + 1;
      return result;
    }

    // CHECK 2: Is this a checkout URL? Extract brand from it
    if (isCheckoutUrl(currentUrl)) {
      console.log(`[DeepCTA] Checkout URL detected: ${currentUrl}`);
      hopResult.is_checkout = true;
      try {
        const checkoutResult = await detectBrandFromCheckout(currentUrl, { timeout: 10000 });
        if (checkoutResult.shop_domain) {
          const shopDomain = checkoutResult.shop_domain.toLowerCase().replace(/^www\./, '');
          if (isDomainBrandMatch(shopDomain, options.brand_info)) {
            console.log(`[DeepCTA] MATCH: Checkout brand "${checkoutResult.brand_name}" on ${shopDomain}`);
            result.chain.push(hopResult);
            result.final_url = currentUrl;
            result.final_domain = shopDomain;
            result.is_brand_match = true;
            result.match_method = 'cta_chain_checkout';
            result.confidence = Math.min(checkoutResult.confidence, 0.95);
            result.total_hops = hop + 1;
            return result;
          }
        }
      } catch (e) {
        console.log(`[DeepCTA] Checkout detection failed: ${e}`);
      }
    }

    // STEP 3: Try plain HTTP first (free)
    let html: string | null = null;
    let finalFetchUrl = currentUrl;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      const resp = await fetch(currentUrl, {
        signal: ctrl.signal,
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
        },
      });
      clearTimeout(timer);

      if (resp.ok) {
        finalFetchUrl = resp.url;
        html = await resp.text();

        // Check if redirect landed on brand domain
        const fetchDomain = extractDomain(finalFetchUrl);
        if (fetchDomain && fetchDomain !== currentDomain && isDomainBrandMatch(fetchDomain, options.brand_info)) {
          console.log(`[DeepCTA] MATCH: HTTP redirect to brand domain ${fetchDomain}`);
          result.chain.push(hopResult);
          result.final_url = finalFetchUrl;
          result.final_domain = fetchDomain;
          result.is_brand_match = true;
          result.match_method = 'cta_chain_domain';
          result.confidence = 0.90;
          result.total_hops = hop + 1;
          return result;
        }

        // Try extracting CTAs from raw HTML
        const rawCandidates = extractCTACandidates(html, finalFetchUrl, extractDomain(finalFetchUrl) || '');
        const scoredRaw = rawCandidates.map(c => ({
          ...c,
          score: scoreCTACandidate(c, extractDomain(finalFetchUrl) || '', options.brand_info, visitedUrls),
        })).sort((a, b) => b.score - a.score);

        // If we found a good external CTA via plain HTTP, use it (no need for JS rendering)
        const bestRawExternal = scoredRaw.find(c => c.is_external && c.score > 15 && !c.is_anchor);
        if (bestRawExternal) {
          console.log(`[DeepCTA] Hop ${hop}: CTA from raw HTML: "${bestRawExternal.text}" → ${bestRawExternal.url}`);
          hopResult.cta_candidates = scoredRaw.slice(0, 10);
          hopResult.chosen_cta = bestRawExternal;
          result.chain.push(hopResult);

          // Follow this CTA - check if it leads to brand via redirects
          const redirectTarget = await followRedirectsQuick(bestRawExternal.url, 8000);
          if (redirectTarget) {
            const redirectDomain = extractDomain(redirectTarget);
            if (redirectDomain && isDomainBrandMatch(redirectDomain, options.brand_info)) {
              console.log(`[DeepCTA] MATCH: Raw CTA redirect → brand domain ${redirectDomain}`);
              result.final_url = redirectTarget;
              result.final_domain = redirectDomain;
              result.is_brand_match = true;
              result.match_method = isCheckoutUrl(redirectTarget) ? 'cta_chain_checkout' : 'cta_chain_domain';
              result.confidence = 0.90;
              result.total_hops = hop + 1;
              return result;
            }
            // Track internal hops
            const rawCtaDomain = extractDomain(redirectTarget) || '';
            if (rawCtaDomain === startDomain || rawCtaDomain === currentDomain) {
              internalHopCount++;
            } else {
              internalHopCount = 0;
            }
            currentUrl = redirectTarget;
          } else {
            const rawCtaDomain = extractDomain(bestRawExternal.url) || '';
            if (rawCtaDomain === startDomain || rawCtaDomain === currentDomain) {
              internalHopCount++;
            } else {
              internalHopCount = 0;
            }
            currentUrl = bestRawExternal.url;
          }
          continue;
        }
      }
    } catch (e) {
      console.log(`[DeepCTA] Hop ${hop}: Plain HTTP failed: ${e}`);
    }

    // STEP 4: Headless browser render (local Chromium)
    console.log(`[DeepCTA] Hop ${hop}: Rendering with headless browser...`);
    let renderedHtml: string | null = null;
    try {
      const renderResult = await renderWithHeadless(currentUrl, renderWaitMs);
      renderedHtml = renderResult.html;
      hopResult.rendered = true;
      hopResult.credits_used = 0;
      console.log(`[DeepCTA] Hop ${hop}: Headless rendered (${renderedHtml?.length || 0} chars)`);
    } catch (e) {
      console.log(`[DeepCTA] Hop ${hop}: Headless render failed: ${e}`);
      // If render fails and we have raw HTML, try that
      if (!html) {
        result.chain.push(hopResult);
        break;
      }
    }

    const htmlToUse = renderedHtml || html;
    if (!htmlToUse) {
      console.log(`[DeepCTA] Hop ${hop}: No HTML available, stopping`);
      result.chain.push(hopResult);
      break;
    }

    // STEP 5: Extract and score all CTA candidates
    const pageDomain = extractDomain(currentUrl) || '';
    const candidates = extractCTACandidates(htmlToUse, currentUrl, pageDomain);
    const scored = candidates.map(c => ({
      ...c,
      score: scoreCTACandidate(c, pageDomain, options.brand_info, visitedUrls),
    })).sort((a, b) => b.score - a.score);

    hopResult.cta_candidates = scored.slice(0, 15);
    console.log(`[DeepCTA] Hop ${hop}: Found ${candidates.length} CTA candidates, top 3: ${scored.slice(0, 3).map(c => `"${c.text}"(${c.score})`).join(', ')}`);

    // STEP 6: Handle anchor links
    const bestCandidate = scored[0];
    if (bestCandidate && bestCandidate.is_anchor) {
      console.log(`[DeepCTA] Hop ${hop}: Best CTA is anchor: ${bestCandidate.url}`);
      const anchorCtas = resolveAnchorCTAs(htmlToUse, bestCandidate.url, currentUrl, pageDomain, options.brand_info, visitedUrls);
      if (anchorCtas.length > 0) {
        const bestAnchorCta = anchorCtas[0];
        console.log(`[DeepCTA] Hop ${hop}: Found CTA in anchor section: "${bestAnchorCta.text}" → ${bestAnchorCta.url}`);
        hopResult.chosen_cta = bestAnchorCta;
        result.chain.push(hopResult);

        // Follow the CTA from the anchor section
        const redirectTarget = await followRedirectsQuick(bestAnchorCta.url, 8000);
        const targetUrl = redirectTarget || bestAnchorCta.url;
        const targetDomain = extractDomain(targetUrl);
        if (targetDomain && isDomainBrandMatch(targetDomain, options.brand_info)) {
          console.log(`[DeepCTA] MATCH: Anchor section CTA → brand domain ${targetDomain}`);
          result.final_url = targetUrl;
          result.final_domain = targetDomain;
          result.is_brand_match = true;
          result.match_method = isCheckoutUrl(targetUrl) ? 'cta_chain_checkout' : 'cta_chain_domain';
          result.confidence = 0.90;
          result.total_hops = hop + 1;
          return result;
        }
        currentUrl = targetUrl;
        continue;
      }

      // No CTAs found in anchor section, try headless anchor click
      if (renderedHtml) {
        console.log(`[DeepCTA] Hop ${hop}: Trying headless anchor click`);
        try {
          const clickResult = await renderWithHeadlessClick(
            currentUrl,
            bestCandidate.url, // The anchor href like "#zumangebot"
            renderWaitMs
          );
          hopResult.credits_used += 0;

          // Re-extract CTAs from the clicked page
          const clickCandidates = extractCTACandidates(clickResult.html, currentUrl, pageDomain);
          const clickScored = clickCandidates.map(c => ({
            ...c,
            score: scoreCTACandidate(c, pageDomain, options.brand_info, visitedUrls),
          })).sort((a, b) => b.score - a.score);

          const bestAfterClick = clickScored.find(c => !c.is_anchor && c.score > 10);
          if (bestAfterClick) {
            console.log(`[DeepCTA] Hop ${hop}: After anchor click, found CTA: "${bestAfterClick.text}" → ${bestAfterClick.url}`);
            hopResult.chosen_cta = bestAfterClick;
            result.chain.push(hopResult);

            const redirectTarget = await followRedirectsQuick(bestAfterClick.url, 8000);
            const targetUrl = redirectTarget || bestAfterClick.url;
            const targetDomain = extractDomain(targetUrl);
            if (targetDomain && isDomainBrandMatch(targetDomain, options.brand_info)) {
              result.final_url = targetUrl;
              result.final_domain = targetDomain;
              result.is_brand_match = true;
              result.match_method = isCheckoutUrl(targetUrl) ? 'cta_chain_checkout' : 'cta_chain_domain';
              result.confidence = 0.90;
              result.total_hops = hop + 1;
              return result;
            }
            currentUrl = targetUrl;
            continue;
          }
        } catch (e) {
          console.log(`[DeepCTA] Hop ${hop}: js_scenario click failed: ${e}`);
        }
      }

      // Skip non-anchor candidates if anchor didn't work
      const nonAnchorCandidate = scored.find(c => !c.is_anchor && c.score > 10);
      if (nonAnchorCandidate) {
        hopResult.chosen_cta = nonAnchorCandidate;
        result.chain.push(hopResult);
        const redirectTarget = await followRedirectsQuick(nonAnchorCandidate.url, 8000);
        currentUrl = redirectTarget || nonAnchorCandidate.url;
        continue;
      }

      // Nothing worked
      result.chain.push(hopResult);
      break;
    }

    // STEP 7: Follow the best non-anchor CTA (with retry on 2nd best)
    let followed = false;
    const nonAnchorCandidates = scored.filter(c => !c.is_anchor && c.score > 5);

    for (let attempt = 0; attempt < Math.min(MAX_CTA_RETRIES_PER_HOP, nonAnchorCandidates.length); attempt++) {
      const candidate = nonAnchorCandidates[attempt];
      if (!candidate) break;

      console.log(`[DeepCTA] Hop ${hop}: Following CTA #${attempt}: "${candidate.text}" → ${candidate.url}`);
      hopResult.chosen_cta = candidate;

      // Follow redirects for the CTA URL
      const redirectTarget = await followRedirectsQuick(candidate.url, 8000);
      const targetUrl = redirectTarget || candidate.url;
      const targetDomain = extractDomain(targetUrl);

      // Check if we reached brand domain
      if (targetDomain && isDomainBrandMatch(targetDomain, options.brand_info)) {
        console.log(`[DeepCTA] MATCH: CTA → brand domain ${targetDomain}`);
        result.chain.push(hopResult);
        result.final_url = targetUrl;
        result.final_domain = targetDomain;
        result.is_brand_match = true;
        result.match_method = isCheckoutUrl(targetUrl) ? 'cta_chain_checkout' : 'cta_chain_domain';
        result.confidence = 0.90;
        result.total_hops = hop + 1;
        return result;
      }

      // Check if redirect landed on a checkout page
      if (isCheckoutUrl(targetUrl)) {
        try {
          const checkoutResult = await detectBrandFromCheckout(targetUrl, { timeout: 10000 });
          if (checkoutResult.shop_domain) {
            const shopDomain = checkoutResult.shop_domain.toLowerCase().replace(/^www\./, '');
            if (isDomainBrandMatch(shopDomain, options.brand_info)) {
              console.log(`[DeepCTA] MATCH: CTA → checkout → brand ${shopDomain}`);
              result.chain.push(hopResult);
              result.final_url = targetUrl;
              result.final_domain = shopDomain;
              result.is_brand_match = true;
              result.match_method = 'cta_chain_checkout';
              result.confidence = Math.min(checkoutResult.confidence, 0.95);
              result.total_hops = hop + 1;
              return result;
            }
          }
        } catch { /* continue */ }
      }

      // CTA didn't lead to brand yet - continue to next hop with this URL
      result.chain.push(hopResult);
      // Track internal hops: if CTA stays on the same domain, increment counter
      const ctaTargetDomain = extractDomain(targetUrl) || '';
      if (ctaTargetDomain === startDomain || ctaTargetDomain === (extractDomain(currentUrl) || '')) {
        internalHopCount++;
        console.log(`[DeepCTA] Hop ${hop}: Internal hop (${internalHopCount}/${MAX_INTERNAL_HOPS}) — staying on ${ctaTargetDomain}`);
      } else {
        internalHopCount = 0;  // Reset: we moved to a new domain
      }
      currentUrl = targetUrl;
      followed = true;
      break;
    }

    if (!followed) {
      // No viable CTA candidates at all
      console.log(`[DeepCTA] Hop ${hop}: No viable CTAs found, stopping`);
      result.chain.push(hopResult);
      break;
    }
  }

  result.total_hops = result.chain.length;
  result.final_url = currentUrl;
  result.final_domain = extractDomain(currentUrl);
  console.log(`[DeepCTA] Chain complete: ${result.total_hops} hops, match=${result.is_brand_match}, credits=${result.total_credits_used}`);
  return result;
}

// ============================================
// Headless Rendering (Local Chromium)
// ============================================

async function renderWithHeadless(
  url: string,
  waitMs: number
): Promise<{ html: string }> {
  const renderer = BrowserRenderer.getInstance();

  const result = await renderer.renderPage(url, {
    wait_ms: waitMs,
    timeout_ms: 30000,
  });

  if (result.error && !result.html) {
    throw new Error(`Render failed: ${result.error}`);
  }

  return { html: result.html };
}

/**
 * Render a page and click an anchor/element first
 */
async function renderWithHeadlessClick(
  url: string,
  anchorSelector: string,
  waitMs: number
): Promise<{ html: string }> {
  const renderer = BrowserRenderer.getInstance();

  // Build CSS selector from anchor href
  const cssSelector = anchorSelector.startsWith('#')
    ? `a[href="${anchorSelector}"], a[href*="${anchorSelector}"]`
    : `a[href="${anchorSelector}"]`;

  const result = await renderer.renderPageWithClick(url, cssSelector, {
    wait_ms: waitMs,
    timeout_ms: 30000,
    click_wait_ms: 2000,
    scroll_y: 500,
  });

  if (result.error && !result.html) {
    throw new Error(`Render click failed: ${result.error}`);
  }

  return { html: result.html };
}

// ============================================
// CTA Extraction
// ============================================

/**
 * Extract all CTA candidates from HTML (raw or rendered)
 */
function extractCTACandidates(
  html: string,
  pageUrl: string,
  pageDomain: string
): CTACandidate[] {
  const candidates: CTACandidate[] = [];
  const seenUrls = new Set<string>();

  // Strategy 1: <a> tags with href
  const linkRegex = /<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = linkRegex.exec(html)) !== null) {
    const href = match[1];
    const innerHtml = match[2];
    const text = stripHtml(innerHtml).trim();
    if (!text || text.length > 200) continue;

    const url = resolveUrl(href, pageUrl);
    if (!url || seenUrls.has(url)) continue;
    seenUrls.add(url);

    // Extract CSS classes from the <a> tag
    const classMatch = match[0].match(/class="([^"]*)"/i);
    const cssClasses = classMatch ? classMatch[1] : '';

    candidates.push({
      url,
      text,
      score: 0,
      is_external: isExternalUrl(url, pageDomain),
      is_anchor: href.startsWith('#'),
      element_type: 'a',
    });
  }

  // Strategy 2: <button> elements with onclick navigation
  const buttonRegex = /<button[^>]*onclick=["'](?:window\.)?location(?:\.href)?\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/button>/gi;
  while ((match = buttonRegex.exec(html)) !== null) {
    const url = resolveUrl(match[1], pageUrl);
    const text = stripHtml(match[2]).trim();
    if (!url || !text || seenUrls.has(url)) continue;
    seenUrls.add(url);

    candidates.push({
      url,
      text,
      score: 0,
      is_external: isExternalUrl(url, pageDomain),
      is_anchor: false,
      element_type: 'button',
    });
  }

  // Strategy 3: Elements with data-href, data-url, data-redirect
  const dataAttrRegex = /<(?:a|button|div|span)[^>]*data-(?:href|url|redirect|link|target)="([^"]+)"[^>]*>([\s\S]*?)<\/(?:a|button|div|span)>/gi;
  while ((match = dataAttrRegex.exec(html)) !== null) {
    const url = resolveUrl(match[1], pageUrl);
    const text = stripHtml(match[2]).trim();
    if (!url || !text || seenUrls.has(url)) continue;
    seenUrls.add(url);

    candidates.push({
      url,
      text,
      score: 0,
      is_external: isExternalUrl(url, pageDomain),
      is_anchor: false,
      element_type: 'data-attr',
    });
  }

  // Strategy 4: onclick with navigateTo/redirect/goTo
  const onclickRegex = /onclick=["'][^"']*(?:navigateTo|redirect|goTo)\s*\(\s*["']([^"']+)["']/gi;
  while ((match = onclickRegex.exec(html)) !== null) {
    const url = resolveUrl(match[1], pageUrl);
    if (!url || seenUrls.has(url)) continue;
    seenUrls.add(url);

    candidates.push({
      url,
      text: '(onclick)',
      score: 0,
      is_external: isExternalUrl(url, pageDomain),
      is_anchor: false,
      element_type: 'onclick',
    });
  }

  // Strategy 5: Form actions
  const formRegex = /<form[^>]*action="([^"]+)"[^>]*method="(?:post|get)"[^>]*>/gi;
  while ((match = formRegex.exec(html)) !== null) {
    const url = resolveUrl(match[1], pageUrl);
    if (!url || seenUrls.has(url)) continue;
    seenUrls.add(url);

    candidates.push({
      url,
      text: '(form)',
      score: 0,
      is_external: isExternalUrl(url, pageDomain),
      is_anchor: false,
      element_type: 'form',
    });
  }

  // Strategy 6: JavaScript variable assignments with shop/checkout URLs
  const jsVarRegex = /(?:var|let|const)\s+(?:redirect|target|shop|checkout|buy|order|offer)(?:Url|Link|Href|Path)\s*=\s*["']([^"']+)["']/gi;
  while ((match = jsVarRegex.exec(html)) !== null) {
    const url = resolveUrl(match[1], pageUrl);
    if (!url || seenUrls.has(url)) continue;
    seenUrls.add(url);

    candidates.push({
      url,
      text: '(js-var)',
      score: 0,
      is_external: isExternalUrl(url, pageDomain),
      is_anchor: false,
      element_type: 'js-var',
    });
  }

  // Strategy 7: JSON embedded URLs
  const jsonUrlRegex = /"(?:redirect|target|shop|checkout|buy|order|offer)_?(?:url|link|href)"\s*:\s*"(https?:\/\/[^"]+)"/gi;
  while ((match = jsonUrlRegex.exec(html)) !== null) {
    const url = match[1];
    if (seenUrls.has(url)) continue;
    seenUrls.add(url);

    candidates.push({
      url,
      text: '(json)',
      score: 0,
      is_external: isExternalUrl(url, pageDomain),
      is_anchor: false,
      element_type: 'json',
    });
  }

  return candidates;
}

// ============================================
// CTA Scoring
// ============================================

function scoreCTACandidate(
  candidate: CTACandidate,
  pageDomain: string,
  brandInfo: BrandInfo,
  visitedUrls: Set<string>
): number {
  let score = 0;
  const textLower = candidate.text.toLowerCase();
  const urlLower = candidate.url.toLowerCase();

  // Already visited → disqualify
  if (visitedUrls.has(normalizeUrl(candidate.url))) return -100;

  // Brand domain in URL → highest priority
  if (brandInfo.brand_domain && urlLower.includes(brandInfo.brand_domain.toLowerCase())) {
    score += 50;
  }

  // External domain → likely leads to shop
  if (candidate.is_external) {
    score += 20;
  }

  // Strong CTA text
  if (STRONG_CTA_WORDS.some(w => textLower.includes(w))) {
    score += 15;
  }

  // Medium CTA text
  if (MEDIUM_CTA_WORDS.some(w => textLower.includes(w))) {
    score += 10;
  }

  // CSS-like class patterns in the text/url context (check element_type hints)
  // We check the raw candidate for CSS patterns when extracted
  if (CTA_CSS_PATTERNS.some(p => p.test(candidate.element_type === 'a' ? candidate.text : ''))) {
    score += 8;
  }

  // URL contains checkout/cart paths
  if (CHECKOUT_PATH_PATTERNS.some(p => p.test(urlLower))) {
    score += 12;
  }

  // URL contains tracking params (affiliate links)
  if (/[?&](?:ref|aff|utm_|click|track|partner|campaign)=/i.test(urlLower)) {
    score += 5;
  }

  // Anchor to buy section
  if (candidate.is_anchor) {
    const hash = candidate.url.replace('#', '').toLowerCase();
    if (ANCHOR_BUY_PATTERNS.some(p => hash.includes(p))) {
      score += 8;
    } else {
      score += 3; // Generic anchor
    }
  }

  // NEGATIVE scores

  // Excluded social media domains
  try {
    const domain = new URL(candidate.url).hostname.toLowerCase().replace(/^www\./, '');
    if (EXCLUDED_DOMAINS.has(domain) || [...EXCLUDED_DOMAINS].some(d => domain.endsWith(`.${d}`))) {
      return -100;  // Hard disqualify
    }
  } catch { /* not a valid URL, OK for anchors */ }

  // Legal/footer links
  if (LEGAL_PATTERNS.some(p => p.test(textLower) || p.test(urlLower))) {
    return -50;  // Hard disqualify
  }

  // Navigation links — these are NEVER CTAs to a shop/checkout
  const NAV_PATTERNS = [
    /\bblog\b/i, /\bkarriere\b/i, /\bjobs?\b/i, /\bcareer/i,
    /\büber uns\b/i, /\babout\b/i, /\bteam\b/i, /\bpresse\b/i, /\bpress\b/i,
    /\bnews\b/i, /\bartikel\b/i, /\barticle/i, /\bmagazin\b/i,
    /\brezepte?\b/i, /\brecipe/i, /\bratgeber\b/i, /\bguide\b/i,
    /\bsitemap\b/i, /\blogin\b/i, /\bregist/i, /\bsign[- ]?(?:in|up)\b/i,
    /\bkonto\b/i, /\baccount\b/i, /\bprofil\b/i, /\bprofile\b/i,
    /\bnewsletter\b/i, /\bsubscri/i, /\banmeld/i,
    /\bpartner\b/i, /\baffiliate\b/i, /\bkooper/i,
    /\bhelp\b/i, /\bhilfe\b/i, /\bsupport\b/i, /\bfaq\b/i,
    /\bhome\b/i, /\bstartseite\b/i,
    /\bapp\b/i, /\bdownload\b/i,
    /\bsocial/i, /\bfollow/i, /\bteilen\b/i, /\bshare\b/i,
  ];
  if (NAV_PATTERNS.some(p => p.test(textLower) || p.test(urlLower))) {
    score -= 40;
  }

  // URL paths that indicate navigation, not purchase flow
  const NAV_URL_PATTERNS = [
    /\/blog\b/i, /\/karriere\b/i, /\/jobs?\b/i, /\/about\b/i,
    /\/team\b/i, /\/press/i, /\/news\b/i, /\/magazine?\b/i,
    /\/rezept/i, /\/recipe/i, /\/ratgeber\b/i, /\/guide/i,
    /\/login\b/i, /\/register\b/i, /\/account\b/i, /\/profil/i,
    /\/newsletter\b/i, /\/help\b/i, /\/faq\b/i, /\/support\b/i,
    /\/sitemap/i, /\/category\b/i, /\/kategorie\b/i, /\/tag\b/i,
  ];
  if (NAV_URL_PATTERNS.some(p => p.test(urlLower))) {
    score -= 30;
  }

  // Very short generic text
  if (textLower.length < 3 && !candidate.is_anchor) {
    score -= 10;
  }

  // Generic "mehr" / "more" links without purchase context
  if (/^(mehr|more|lesen|read|erfahren|details?)$/i.test(textLower.trim())) {
    score -= 15;
  }

  // Same-page links that aren't anchors (like #top, #header)
  if (candidate.is_anchor) {
    const hash = candidate.url.replace('#', '').toLowerCase();
    if (['top', 'header', 'nav', 'menu', 'footer', 'back', 'start', 'content', 'main'].includes(hash)) {
      return -50;  // Hard disqualify
    }
  }

  return score;
}

// ============================================
// Anchor Resolution
// ============================================

/**
 * When the best CTA is an anchor link (#zumangebot), find CTAs within that section.
 */
function resolveAnchorCTAs(
  html: string,
  anchorHref: string,
  pageUrl: string,
  pageDomain: string,
  brandInfo: BrandInfo,
  visitedUrls: Set<string>
): CTACandidate[] {
  const anchorId = anchorHref.replace('#', '');
  if (!anchorId) return [];

  // Find the section with this ID
  // Look for id="anchorId" and extract content until next section/div
  const sectionRegex = new RegExp(
    `id=["']${escapeRegex(anchorId)}["'][^>]*>([\\s\\S]*?)(?=<(?:section|div)[^>]*id=["']|$)`,
    'i'
  );
  const sectionMatch = sectionRegex.exec(html);
  if (!sectionMatch) {
    console.log(`[DeepCTA] Anchor section #${anchorId} not found in HTML`);
    return [];
  }

  const sectionHtml = sectionMatch[1];
  console.log(`[DeepCTA] Found anchor section #${anchorId} (${sectionHtml.length} chars)`);

  // Extract CTAs from this section only
  const candidates = extractCTACandidates(sectionHtml, pageUrl, pageDomain);
  const scored = candidates
    .filter(c => !c.is_anchor) // Don't follow anchors within an anchor section
    .map(c => ({
      ...c,
      score: scoreCTACandidate(c, pageDomain, brandInfo, visitedUrls),
    }))
    .filter(c => c.score > 5)
    .sort((a, b) => b.score - a.score);

  return scored;
}

// ============================================
// Helper Functions
// ============================================

function extractDomain(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

function isDomainBrandMatch(domain: string, brandInfo: BrandInfo): boolean {
  const domainLower = domain.toLowerCase().replace(/^www\./, '');

  // Exact domain match
  if (brandInfo.brand_domain && domainLower === brandInfo.brand_domain.toLowerCase()) {
    return true;
  }

  // Myshopify match
  if (brandInfo.shopify_store && domainLower === `${brandInfo.shopify_store}.myshopify.com`) {
    return true;
  }

  // Domain contains brand alias (only for aliases >=3 chars)
  for (const alias of brandInfo.brand_aliases) {
    const normalized = alias.replace(/[\s\-_.]+/g, '').toLowerCase();
    if (normalized.length >= 3 && domainLower.includes(normalized)) {
      return true;
    }
  }

  return false;
}

function isCheckoutUrl(url: string): boolean {
  return CHECKOUT_PATH_PATTERNS.some(p => p.test(url));
}

function isExternalUrl(url: string, currentDomain: string): boolean {
  try {
    const urlDomain = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return urlDomain !== currentDomain.toLowerCase().replace(/^www\./, '');
  } catch {
    return false;
  }
}

function resolveUrl(href: string, baseUrl: string): string | null {
  if (!href || href.length < 2) return null;
  if (href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) return null;

  // Anchor links are returned as-is
  if (href.startsWith('#')) return href;

  try {
    if (href.startsWith('http')) {
      return new URL(href).href;
    }
    return new URL(href, baseUrl).href;
  } catch {
    return null;
  }
}

function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // Remove trailing slash, lowercase hostname, remove fragments for dedup
    return `${parsed.protocol}//${parsed.hostname.toLowerCase()}${parsed.pathname.replace(/\/$/, '')}${parsed.search}`;
  } catch {
    return url.toLowerCase();
  }
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ');
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Quick redirect following via HEAD requests (free, no rendering)
 */
async function followRedirectsQuick(url: string, timeoutMs: number): Promise<string | null> {
  let currentUrl = url;
  const maxRedirects = 10;
  const visited = new Set<string>();

  for (let i = 0; i < maxRedirects; i++) {
    if (visited.has(currentUrl)) break;
    visited.add(currentUrl);

    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const response = await fetch(currentUrl, {
        method: 'HEAD',
        redirect: 'manual',
        signal: ctrl.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });
      clearTimeout(timer);

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (location) {
          currentUrl = new URL(location, currentUrl).href;
          continue;
        }
      }

      // 200 or other — check if the URL changed (some servers redirect on GET but not HEAD)
      if (response.status === 405 || response.status === 403) {
        // Try GET instead
        const getCtrl = new AbortController();
        const getTimer = setTimeout(() => getCtrl.abort(), timeoutMs);
        const getResp = await fetch(currentUrl, {
          redirect: 'follow',
          signal: getCtrl.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          },
        });
        clearTimeout(getTimer);
        if (getResp.url !== currentUrl) {
          return getResp.url;
        }
      }

      return currentUrl;
    } catch {
      return currentUrl;
    }
  }

  return currentUrl;
}
