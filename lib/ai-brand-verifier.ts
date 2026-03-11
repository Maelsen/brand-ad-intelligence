/**
 * AI Brand Verifier
 * Replaces false-positive-detector.ts with stronger AI verification.
 *
 * Two modes:
 * 1. verifyThirdPartyPages() — Batch post-discovery verification (replaces checkFalsePositives)
 * 2. quickAIVerify() — Inline guard for checkout_match during Step 6
 */

import type { ThirdPartyPageInfo, BrandInfo } from './types.ts';

// ============================================
// Types
// ============================================

export interface AIVerificationResult {
  page_id: string;
  verdict: 'confirmed_false_positive' | 'confirmed_match' | 'uncertain';
  confidence: number;  // 0.0 - 1.0
  reason: string;
}

export interface BatchVerificationResult {
  results: AIVerificationResult[];
  total_checked: number;
  auto_removed: number;   // confidence >= 0.8 + confirmed_false_positive (only checkout_match evaluated)
  flagged: number;         // confidence 0.7-0.8 + confirmed_false_positive
  confirmed: number;       // confirmed_match
}

// ============================================
// Batch Verification (Post-Discovery)
// ============================================

/**
 * AI-verify all third-party pages after discovery.
 * Returns verdicts for each page with confidence scores.
 *
 * Pages with confirmed_false_positive + confidence >= 0.8 should be AUTO-REMOVED.
 * Pages with confirmed_false_positive + confidence 0.7-0.8 should be FLAGGED.
 * NOTE: Only checkout_match pages are evaluated — all other types are auto-kept via VERIFIED_CONNECTION_TYPES.
 */
// Connection types that are verified via URL chain and should NEVER be AI-overridden
const VERIFIED_CONNECTION_TYPES = new Set([
  'deep_cta',       // ScrapingBee multi-hop CTA chain → verified redirect to brand
  'presell_cta',    // CTA button redirect → verified redirect to brand
  'redirect',       // Domain redirect → verified redirect to brand
  'shopify_vendor', // Shopify vendor match → verified product relationship
  'content_link',   // Link to brand domain found in ads/HTML — IS a verification
]);

export async function verifyThirdPartyPages(
  pages: ThirdPartyPageInfo[],
  brandInfo: BrandInfo,
  openaiKey?: string
): Promise<BatchVerificationResult | null> {
  if (!openaiKey || pages.length === 0) return null;

  try {
    // Split pages: verified connections are auto-kept, only evaluate unverified ones
    const verifiedPages: ThirdPartyPageInfo[] = [];
    const pagesToCheck: ThirdPartyPageInfo[] = [];

    for (const p of pages) {
      if (VERIFIED_CONNECTION_TYPES.has(p.connection_type)) {
        verifiedPages.push(p);
      } else {
        pagesToCheck.push(p);
      }
    }

    console.log(`[AI-Verify] ${verifiedPages.length} pages auto-kept (verified connection), ${pagesToCheck.length} pages to AI-check`);

    if (pagesToCheck.length === 0) {
      // All pages are verified — nothing to check
      return {
        results: verifiedPages.map(p => ({
          page_id: p.page_id,
          verdict: 'confirmed_match' as const,
          confidence: 1.0,
          reason: `Verified connection: ${p.connection_type}`,
        })),
        total_checked: pages.length,
        auto_removed: 0,
        flagged: 0,
        confirmed: verifiedPages.length,
      };
    }

    // Build page summaries with rich context (only unverified pages)
    const pageSummaries = pagesToCheck.map(p => ({
      page_id: p.page_id,
      page_name: p.page_name,
      connection_type: p.connection_type,
      confidence: Math.round(p.confidence * 100),
      ad_count: p.ad_count,
      domains_used: p.domains_used,
    }));

    // Build brand profile for context
    const brandProfile = {
      name: brandInfo.brand_name,
      domain: brandInfo.brand_domain || 'unbekannt',
      category: brandInfo.brand_category || 'unbekannt',
      aliases: brandInfo.brand_aliases.slice(0, 5),
      vendor_name: brandInfo.vendor_name || null,
      payers: brandInfo.brand_payers?.slice(0, 5) || [],
    };

    const prompt = `Du bist ein Experte fuer Facebook-Werbung und Markenanalyse. Deine Aufgabe: Pruefe ob die gefundenen Drittseiten WIRKLICH fuer die Marke werben oder FALSCHE POSITIVE sind.

## Brand-Profil
${JSON.stringify(brandProfile, null, 2)}

## Gefundene Drittseiten
${JSON.stringify(pageSummaries, null, 2)}

## Bewertungskriterien

### FALSCH POSITIV (confirmed_false_positive):
- **Eigenstaendige Marke:** Hat eigene Produkte, eigenen Shop, eigene Brand-Identity (z.B. "MORE Nutrition" ist NICHT ein Affiliate von "Best Body Nutrition" — beides sind eigenstaendige Supplement-Marken)
- **Kategorie-Mismatch:** Seite operiert in komplett anderer Branche als die Brand
- **Grosse Marktplaetze/Ketten:** Amazon, Douglas, dm, Rossmann, DocMorris — verkaufen VIELE Marken
- **Medien/Verlage:** Zeitschriften, TV-Sender, Nachrichtenportale (Bild, RTL, Focus)
- **Rein generischer Wort-Match:** Der checkout_match basiert nur auf einem generischen Wort wie "nutrition", "body", "beauty", "health", "fitness"

### ECHTER MATCH (confirmed_match):
- **Kleine unbekannte Presell-Seite:** Keine eigene Brand-Identity, existiert NUR um fuer diese Marke zu werben
- **Starke Verbindung:** deep_cta, presell_cta, redirect mit hoher Confidence
- **Gleicher EU-Zahler:** Payer/Beneficiary stimmt ueberein
- **Domain verweist direkt:** Die Domain der Drittseite leitet zur Brand-Domain weiter

### UNSICHER (uncertain):
- Nicht genug Informationen fuer ein klares Urteil
- Seite koennte Affiliate oder eigenstaendige Marke sein

## Wichtig
- Sei NICHT konservativ! Ein Mensch wuerde sofort sehen, dass "ESN" nicht zu "Best Body Nutrition" gehoert.
- Bewerte JEDE Seite einzeln.
- Confidence 0.0-1.0 (wie sicher bist du?)

Antworte NUR mit einem JSON Array (ohne Markdown-Codeblock):
[{"page_id": "123", "verdict": "confirmed_false_positive", "confidence": 0.95, "reason": "Eigenstaendige Supplement-Marke"}]`;

    // Process in batches of 30 pages to stay within token limits
    const BATCH_SIZE = 30;
    const allResults: AIVerificationResult[] = [];

    for (let i = 0; i < pageSummaries.length; i += BATCH_SIZE) {
      const batchSummaries = pageSummaries.slice(i, i + BATCH_SIZE);

      // Build batch-specific prompt
      const batchPrompt = prompt.replace(
        JSON.stringify(pageSummaries, null, 2),
        JSON.stringify(batchSummaries, null, 2)
      );

      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${openaiKey}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: 'Du bist ein Marketing-Analyst. Antworte nur mit validem JSON Array. Keine Markdown-Codeblocks.' },
            { role: 'user', content: batchPrompt },
          ],
          temperature: 0.1,
          max_tokens: 2000,
        }),
      });

      if (!response.ok) {
        console.log(`[AI-Verify] Batch ${Math.floor(i / BATCH_SIZE) + 1}: HTTP ${response.status}`);
        continue;
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content?.trim();
      if (!content) continue;

      try {
        const jsonStr = content.replace(/^```json?\s*/, '').replace(/\s*```$/, '').trim();
        const batchResults: AIVerificationResult[] = JSON.parse(jsonStr);
        allResults.push(...batchResults);
      } catch (parseErr) {
        console.log(`[AI-Verify] Batch ${Math.floor(i / BATCH_SIZE) + 1}: JSON parse error — ${parseErr}`);
      }

      // Rate limit pause between batches
      if (i + BATCH_SIZE < pageSummaries.length) {
        await new Promise(r => setTimeout(r, 300));
      }
    }

    // Add verified pages as confirmed matches
    const verifiedResults: AIVerificationResult[] = verifiedPages.map(p => ({
      page_id: p.page_id,
      verdict: 'confirmed_match' as const,
      confidence: 1.0,
      reason: `Verified connection: ${p.connection_type}`,
    }));
    const combinedResults = [...allResults, ...verifiedResults];

    // Count statistics (only from AI-checked pages, not auto-verified)
    let autoRemoved = 0;
    let flagged = 0;
    let confirmed = verifiedPages.length; // Start with verified count

    for (const r of allResults) {
      if (r.verdict === 'confirmed_false_positive' && r.confidence >= 0.8) autoRemoved++;
      else if (r.verdict === 'confirmed_false_positive' && r.confidence >= 0.7) flagged++;
      else if (r.verdict === 'confirmed_match') confirmed++;
    }

    console.log(`[AI-Verify] ${pagesToCheck.length} AI-checked, ${verifiedPages.length} auto-kept: ${autoRemoved} remove, ${flagged} flagged, ${confirmed} confirmed`);

    return {
      results: combinedResults,
      total_checked: pages.length,
      auto_removed: autoRemoved,
      flagged,
      confirmed,
    };
  } catch (error) {
    console.log(`[AI-Verify] Error: ${error}`);
    return null;
  }
}

/**
 * Apply AI verification results to pages.
 *
 * Returns two arrays:
 * - kept: pages that passed verification (or were uncertain)
 * - removed: pages auto-removed (confirmed_false_positive with confidence >= 0.8)
 */
export function applyVerificationResults(
  pages: ThirdPartyPageInfo[],
  verification: BatchVerificationResult | null
): { kept: ThirdPartyPageInfo[]; removed: ThirdPartyPageInfo[] } {
  if (!verification || verification.results.length === 0) {
    return { kept: pages, removed: [] };
  }

  const verdictMap = new Map(
    verification.results.map(r => [r.page_id, r])
  );

  const kept: ThirdPartyPageInfo[] = [];
  const removed: ThirdPartyPageInfo[] = [];

  for (const page of pages) {
    const verdict = verdictMap.get(page.page_id);
    if (!verdict) {
      // No verdict = keep
      kept.push(page);
      continue;
    }

    // Apply AI fields
    page.ai_verdict = verdict.verdict;
    page.ai_confidence = verdict.confidence;

    if (verdict.verdict === 'confirmed_false_positive' && verdict.confidence >= 0.8) {
      // AUTO-REMOVE (only checkout_match reaches here — verified types are auto-kept)
      page.flagged_suspicious = true;
      page.flag_reason = verdict.reason;
      removed.push(page);
      console.log(`[AI-Verify] AUTO-REMOVE: "${page.page_name}" (${page.page_id}) — ${verdict.reason} (${Math.round(verdict.confidence * 100)}%)`);
    } else if (verdict.verdict === 'confirmed_false_positive' && verdict.confidence >= 0.7) {
      // FLAG but keep
      page.flagged_suspicious = true;
      page.flag_reason = verdict.reason;
      kept.push(page);
      console.log(`[AI-Verify] FLAGGED: "${page.page_name}" (${page.page_id}) — ${verdict.reason} (${Math.round(verdict.confidence * 100)}%)`);
    } else {
      // Keep (confirmed_match or uncertain)
      kept.push(page);
    }
  }

  return { kept, removed };
}

// ============================================
// Quick AI Verify (Inline during Step 6)
// ============================================

/**
 * Quick AI check for checkout_match: "Is X the same brand as Y?"
 * Returns true if the brands match, false if they don't.
 *
 * Cost: ~$0.00001 per call (minimal tokens).
 * Only called for checkout_match (rare), not for domain/redirect matches.
 */
export async function quickAIVerify(
  checkoutBrandName: string,
  brandInfo: BrandInfo,
  openaiKey?: string
): Promise<boolean> {
  if (!openaiKey) return true; // No AI key = trust the match

  try {
    const prompt = `Ist "${checkoutBrandName}" die gleiche Marke/Firma wie "${brandInfo.brand_name}" (Domain: ${brandInfo.brand_domain || 'unbekannt'}, Kategorie: ${brandInfo.brand_category || 'unbekannt'})?

Antworte NUR mit JA oder NEIN.
- JA: wenn es die gleiche Marke ist (z.B. gleicher Shop, Sub-Brand, oder Variation des Namens)
- NEIN: wenn es eine eigenstaendige, andere Marke ist (auch wenn beide in der gleichen Branche sind)`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'Antworte nur mit JA oder NEIN.' },
          { role: 'user', content: prompt },
        ],
        temperature: 0,
        max_tokens: 5,
      }),
    });

    if (!response.ok) {
      console.log(`[QuickAI] HTTP ${response.status} — defaulting to trust`);
      return true;
    }

    const data = await response.json();
    const answer = data.choices?.[0]?.message?.content?.trim()?.toUpperCase() || '';
    const isMatch = answer.startsWith('JA');

    console.log(`[QuickAI] "${checkoutBrandName}" = "${brandInfo.brand_name}"? → ${answer} (${isMatch ? 'MATCH' : 'REJECTED'})`);
    return isMatch;

  } catch (error) {
    console.log(`[QuickAI] Error: ${error} — defaulting to trust`);
    return true;
  }
}
