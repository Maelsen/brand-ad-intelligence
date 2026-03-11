/**
 * Brand Cache Light — Edge Function
 *
 * Lightweight pipeline: finds a brand's Facebook page + loads all ads in ONE call.
 * Uses separate META_LIGHT_TOKENS (independent from VPS Worker tokens).
 * Results cached in page_ad_cache (24h TTL) — same table as brand-search.
 *
 * POST /brand-cache-light
 * Body: { brand: string, country?: string }
 *
 * Response: { success: true, brand, page_id, page_name, total_ads, domains, demographics }
 */

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  BrandSearchResponse,
  ProcessedAd,
  PagesMapping,
  MetaAd,
  DemographicsData,
} from '../../../lib/types.ts';
import { MetaAdLibraryClient, MetaApiError } from '../../../lib/meta-api.ts';
import {
  extractDomainFromCaption,
  extractDomainsFromCaptions,
  formatReach,
} from '../../../lib/url-extractor.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// ============================================
// Scoring (copied from page-search-quick)
// ============================================

function calculateQuickScore(pageName: string, query: string, reach: number, adCount: number): number {
  let score = 0;
  const pnl = pageName.toLowerCase();
  const ql = query.toLowerCase();
  if (pnl === ql) score += 10000;
  else if (pnl.includes(ql)) score += 5000;
  else if (ql.includes(pnl)) score += 2000;
  score += Math.log10(reach + 1) * 300;
  score += Math.log10(adCount + 1) * 50;
  return score;
}

function isRelevantResult(pageName: string, query: string, reach: number): boolean {
  const pnl = pageName.toLowerCase();
  const ql = query.toLowerCase();
  const cq = query.toLowerCase().replace(/[^a-z0-9]/g, '');
  const cp = pageName.toLowerCase().replace(/[^a-z0-9]/g, '');
  const nameMatch = pnl.includes(ql) || ql.includes(pnl) || cp.includes(cq) || cq.includes(cp);
  return nameMatch || reach > 50000;
}

// ============================================
// Ad Processing (copied from brand-search)
// ============================================

function processAds(ads: MetaAd[]): ProcessedAd[] {
  return ads.map(ad => {
    const rawCaption = ad.ad_creative_link_captions?.[0] || null;
    const domain = rawCaption ? extractDomainFromCaption(rawCaption) : null;
    const fullUrl = rawCaption ? extractFullUrlFromCaption(rawCaption) : null;
    return {
      id: ad.id,
      creative_url: ad.ad_snapshot_url || null,
      primary_text: ad.ad_creative_bodies?.[0] || null,
      headline: ad.ad_creative_link_titles?.[0] || null,
      description: ad.ad_creative_link_descriptions?.[0] || null,
      start_date: ad.ad_delivery_start_time || null,
      status: (ad.ad_delivery_stop_time ? 'inactive' : 'active') as 'active' | 'inactive',
      landing_page_url: fullUrl,
      landing_page_domain: domain,
      reach: ad.eu_total_reach || null,
      reach_formatted: formatReach(ad.eu_total_reach),
      page_id: ad.page_id || null,
      page_name: ad.page_name || null,
      platforms: ad.publisher_platforms || [],
      languages: ad.languages || [],
    };
  });
}

function extractFullUrlFromCaption(caption: string): string | null {
  if (!caption) return null;
  let cleaned = caption.trim().toLowerCase().replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '');
  const domainPart = cleaned.split('/')[0];
  if (!domainPart || !domainPart.includes('.') || domainPart.includes(' ')) return null;
  return `https://${cleaned}`;
}

function aggregateDemographics(ads: MetaAd[]): DemographicsData | undefined {
  let totalMale = 0, totalFemale = 0, totalUnknown = 0, totalSample = 0;
  const ageMap: Record<string, number> = {};
  const countryMap: Record<string, number> = {};

  for (const ad of ads) {
    const breakdown = ad.age_country_gender_reach_breakdown;
    if (!breakdown || !Array.isArray(breakdown)) continue;
    for (const countryEntry of breakdown) {
      const country = countryEntry.country || 'unknown';
      const ageBreakdowns = countryEntry.age_gender_breakdowns;
      if (!ageBreakdowns || !Array.isArray(ageBreakdowns)) continue;
      for (const ae of ageBreakdowns) {
        const m = ae.male || 0, f = ae.female || 0, u = ae.unknown || 0;
        const t = m + f + u;
        totalMale += m; totalFemale += f; totalUnknown += u; totalSample += t;
        const age = ae.age_range || 'unknown';
        ageMap[age] = (ageMap[age] || 0) + t;
        countryMap[country] = (countryMap[country] || 0) + t;
      }
    }
  }
  if (totalSample === 0) return undefined;
  const gt = totalMale + totalFemale + totalUnknown;
  return {
    gender: {
      male: Math.round((totalMale / gt) * 100),
      female: Math.round((totalFemale / gt) * 100),
      unknown: Math.round((totalUnknown / gt) * 100),
    },
    age_groups: Object.entries(ageMap).sort(([a], [b]) => a.localeCompare(b))
      .map(([group, reach]) => ({ group, pct: Math.round((reach / totalSample) * 100) })),
    countries: Object.entries(countryMap).sort(([, a], [, b]) => b - a)
      .map(([country, reach]) => ({ country, reach, pct: Math.round((reach / totalSample) * 100) })),
    total_sample: totalSample,
  };
}

// ============================================
// Main Handler
// ============================================

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  const startTime = Date.now();

  try {
    const body = await req.json() as { brand?: string; country?: string };
    if (!body.brand?.trim()) {
      return jsonResponse({ success: false, error: 'brand is required' }, 400);
    }

    const brand = body.brand.trim();
    const country = body.country || 'DE';

    // ========== TOKENS: Use separate LIGHT pool (NO fallback to shared tokens) ==========
    const lightTokens: string[] = (() => {
      const multi = Deno.env.get('META_LIGHT_TOKENS');
      if (multi) return multi.split(',').map(t => t.trim()).filter(t => t.length > 0);
      return [];
    })();

    if (lightTokens.length === 0) {
      return jsonResponse({ success: false, error: 'No META_LIGHT_TOKENS configured' }, 500);
    }

    const metaClient = new MetaAdLibraryClient({ access_tokens: lightTokens });

    // ========== Supabase for caching ==========
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_ANON_KEY');
    const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

    // ========== STEP 1: Find the brand's Facebook page ==========
    console.log(`[LIGHT] Step 1: Finding page for "${brand}"...`);

    const cleanQuery = brand.toLowerCase().replace(/[^a-z0-9]/g, '');
    const searchVariants = [...new Set([
      brand,
      ...(brand.includes(' ') ? [cleanQuery] : []),
      `${cleanQuery}.de`,
      `weare${cleanQuery}`,
    ])].slice(0, 4);

    console.log(`[LIGHT] Search variants: ${searchVariants.join(', ')}`);

    // Sequential search with per-variant timeout to avoid 60s edge function kill
    const VARIANT_TIMEOUT_MS = 12000; // 12s max per variant
    const DEADLINE_MS = 50000; // stop searching after 50s total
    const searchResults: MetaAd[][] = [];
    let rateLimitHits = 0;
    for (const term of searchVariants) {
      // Deadline check: stop if we're running out of time
      if (Date.now() - startTime > DEADLINE_MS) {
        console.log(`[LIGHT] Deadline reached (${Math.round((Date.now() - startTime) / 1000)}s), stopping search`);
        break;
      }
      // 2s delay between search variants to avoid rate limit spikes
      if (searchResults.length > 0) {
        await new Promise(r => setTimeout(r, 2000));
      }
      try {
        // Race against timeout to prevent MetaAdLibraryClient retry delays from exceeding edge fn limit
        const ads = await Promise.race([
          metaClient.fetchAllAds({
            search_terms: term,
            ad_reached_countries: [country],
            ad_active_status: 'ALL',
            search_type: 'KEYWORD_UNORDERED',
            max_results: 100,
          }),
          new Promise<MetaAd[]>((_, reject) =>
            setTimeout(() => reject(new Error('VARIANT_TIMEOUT')), VARIANT_TIMEOUT_MS)
          ),
        ]);
        searchResults.push(ads);
      } catch (err) {
        if (err instanceof MetaApiError && (err.code === 613 || err.code === 4 || err.code === 429)) {
          rateLimitHits++;
        } else if (err instanceof Error && err.message === 'VARIANT_TIMEOUT') {
          rateLimitHits++;
          console.log(`[LIGHT] "${term}" timed out after ${VARIANT_TIMEOUT_MS}ms (likely rate limited)`);
        }
        console.log(`[LIGHT] "${term}" failed: ${err}`);
        searchResults.push([]);
      }
    }

    const allSearchAds = searchResults.flat();

    if (allSearchAds.length === 0) {
      if (rateLimitHits > 0) {
        // Rate limit: mark as cached so pipeline moves on (user can re-search manually)
        if (supabase) {
          try {
            await supabase
              .from('brand_list')
              .update({ light_cached_at: new Date().toISOString() })
              .ilike('input_name', brand);
            console.log(`[LIGHT] Rate limited for "${brand}" — marked as done (skip, user can retry manually)`);
          } catch { /* non-critical */ }
        }
        return jsonResponse({
          success: false,
          brand,
          error: `Rate limit erreicht (${rateLimitHits}/${searchVariants.length} Anfragen). Brand uebersprungen.`,
          rate_limited: true,
          search_time_ms: Date.now() - startTime,
        });
      }
      // No ads found: mark as cached so pipeline moves to next brand
      if (supabase) {
        try {
          await supabase
            .from('brand_list')
            .update({ light_cached_at: new Date().toISOString() })
            .ilike('input_name', brand);
          console.log(`[LIGHT] No ads found for "${brand}" — marked as done (skip)`);
        } catch { /* non-critical */ }
      }
      return jsonResponse({
        success: false,
        brand,
        error: `Keine Ads für "${brand}" gefunden`,
        search_time_ms: Date.now() - startTime,
      });
    }

    // Group by page + score
    const pageMap = new Map<string, { page_id: string; page_name: string; ad_count: number; reach: number; domain: string | null }>();
    for (const ad of allSearchAds) {
      if (!ad.page_id) continue;
      let p = pageMap.get(ad.page_id);
      if (!p) {
        p = { page_id: ad.page_id, page_name: ad.page_name || 'Unknown', ad_count: 0, reach: 0, domain: null };
        pageMap.set(ad.page_id, p);
      }
      p.ad_count++;
      p.reach += ad.eu_total_reach || 0;
      if (!p.domain && ad.ad_creative_link_captions) {
        for (const c of ad.ad_creative_link_captions) {
          const d = extractDomainFromCaption(c);
          if (d) { p.domain = d; break; }
        }
      }
    }

    // Pick best matching page
    const pages = Array.from(pageMap.values())
      .filter(p => isRelevantResult(p.page_name, brand, p.reach))
      .map(p => ({ ...p, score: calculateQuickScore(p.page_name, brand, p.reach, p.ad_count) }))
      .sort((a, b) => b.score - a.score);

    if (pages.length === 0) {
      // No matching page: mark as cached so pipeline moves on
      if (supabase) {
        try {
          await supabase
            .from('brand_list')
            .update({ light_cached_at: new Date().toISOString() })
            .ilike('input_name', brand);
          console.log(`[LIGHT] No matching page for "${brand}" — marked as done (skip)`);
        } catch { /* non-critical */ }
      }
      return jsonResponse({
        success: false,
        brand,
        error: `Keine passende Facebook-Seite für "${brand}" gefunden`,
        search_time_ms: Date.now() - startTime,
      });
    }

    const bestPage = pages[0];
    console.log(`[LIGHT] Best match: "${bestPage.page_name}" (${bestPage.page_id}), score=${bestPage.score}, domain=${bestPage.domain}`);

    // ========== STEP 1.5: Check cache for this page ==========
    if (supabase) {
      const { data: cached } = await supabase
        .from('page_ad_cache')
        .select('page_id, page_name, total_ads, data')
        .eq('page_id', bestPage.page_id)
        .eq('country', country)
        .gt('expires_at', new Date().toISOString())
        .maybeSingle();

      if (cached) {
        console.log(`[LIGHT] Cache HIT for ${bestPage.page_name} (${cached.total_ads} ads)`);
        // Update brand_list even on cache hit (brand may have been added after caching)
        try {
          await supabase
            .from('brand_list')
            .update({
              light_cached_at: new Date().toISOString(),
              page_id: cached.page_id,
              page_name: cached.page_name,
            })
            .ilike('input_name', brand);
        } catch { /* non-critical */ }
        return jsonResponse({
          success: true,
          brand,
          page_id: cached.page_id,
          page_name: cached.page_name,
          total_ads: cached.total_ads,
          domains: (cached.data as BrandSearchResponse)?.domains || [],
          demographics: (cached.data as BrandSearchResponse)?.demographics,
          from_cache: true,
          search_time_ms: Date.now() - startTime,
        });
      }
    }

    // ========== STEP 2: Fetch ALL ads from the best page ==========
    console.log(`[LIGHT] Step 2: Fetching all ads from "${bestPage.page_name}" (${bestPage.page_id})...`);

    const pageAds = await metaClient.fetchAllAdsFromPage({
      page_id: bestPage.page_id,
      ad_reached_countries: [country],
      ad_active_status: 'ALL',
      max_results: 10000,
    });

    console.log(`[LIGHT] Fetched ${pageAds.length} ads`);

    // Process ads
    const processedAds = processAds(pageAds);
    processedAds.sort((a, b) => (b.reach || 0) - (a.reach || 0));

    const allCaptions = pageAds.flatMap(a => a.ad_creative_link_captions || []);
    const domains = extractDomainsFromCaptions(allCaptions);
    const demographics = aggregateDemographics(pageAds);

    // Build response (same format as brand-search)
    const brandResponse: BrandSearchResponse = {
      success: true,
      brand: bestPage.page_name,
      total_ads: processedAds.length,
      pages: {
        official: [{ page_id: bestPage.page_id, page_name: bestPage.page_name, ad_count: pageAds.length, is_official: true }],
        third_party: [],
      },
      domains,
      ads: processedAds,
      demographics,
    };

    // ========== STEP 3: Cache to page_ad_cache ==========
    if (supabase && pageAds.length > 0) {
      const { error: upsertError } = await supabase
        .from('page_ad_cache')
        .upsert({
          page_id: bestPage.page_id,
          page_name: bestPage.page_name,
          country,
          total_ads: pageAds.length,
          total_reach: demographics?.total_sample || 0,
          data: brandResponse,
          created_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(), // 90 days
        }, { onConflict: 'page_id,country' });

      if (upsertError) {
        console.log(`[LIGHT] Cache write error: ${upsertError.message}`);
      } else {
        console.log(`[LIGHT] Cached ${pageAds.length} ads for "${bestPage.page_name}"`);
      }

      // Update brand_list: mark light pipeline as done + resolve page_name/page_id
      try {
        await supabase
          .from('brand_list')
          .update({
            light_cached_at: new Date().toISOString(),
            page_id: bestPage.page_id,
            page_name: bestPage.page_name,
          })
          .ilike('input_name', brand);
        console.log(`[LIGHT] Updated brand_list: light_cached_at for "${brand}"`);
      } catch (blErr) {
        console.log(`[LIGHT] brand_list update failed (non-critical): ${blErr}`);
      }
    }

    const totalTime = Date.now() - startTime;
    console.log(`[LIGHT] Done: "${brand}" → "${bestPage.page_name}" (${pageAds.length} ads, ${totalTime}ms)`);

    return jsonResponse({
      success: true,
      brand,
      page_id: bestPage.page_id,
      page_name: bestPage.page_name,
      total_ads: processedAds.length,
      domains,
      demographics,
      from_cache: false,
      search_time_ms: totalTime,
    });

  } catch (error) {
    console.error('[LIGHT] Error:', error);
    const msg = error instanceof MetaApiError
      ? `Meta API Error: ${error.message} (Code: ${error.code})`
      : String(error);
    return jsonResponse({ success: false, error: msg, search_time_ms: Date.now() - startTime }, 500);
  }
});
