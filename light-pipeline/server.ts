/**
 * Light Pipeline Server — Standalone Deno HTTP Server (4GB VPS)
 *
 * Same logic as brand-cache-light edge function, but NO timeout limit.
 * Runs independently from the 8GB VPS worker.
 * Called by pg_cron every minute via light_pipeline_tick().
 *
 * Port: 8788 (different from 8GB worker on 8787)
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  BrandSearchResponse,
  ProcessedAd,
  MetaAd,
  DemographicsData,
} from './lib/types.ts';
import { MetaAdLibraryClient, MetaApiError } from './lib/meta-api.ts';
import {
  extractDomainFromCaption,
  extractDomainsFromCaptions,
  formatReach,
} from './lib/url-extractor.ts';

// ============================================
// Config from environment
// ============================================
const PORT = parseInt(Deno.env.get('PORT') || '8788');
const API_SECRET = Deno.env.get('LIGHT_API_SECRET') || '';
const META_LIGHT_TOKENS = (Deno.env.get('META_LIGHT_TOKENS') || '').split(',').map(t => t.trim()).filter(Boolean);
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

console.log(`[LIGHT-VPS] Starting on port ${PORT}`);
console.log(`[LIGHT-VPS] Tokens: ${META_LIGHT_TOKENS.length}`);
console.log(`[LIGHT-VPS] Supabase: ${SUPABASE_URL ? 'configured' : 'MISSING'}`);

// ============================================
// Scoring (same as brand-cache-light edge fn)
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
// Ad Processing
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
  const cleaned = caption.trim().toLowerCase().replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '');
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

// Track current processing state
let currentBrand: string | null = null;
let currentStartTime = 0;

// Shared instances — token cooldown state persists across brands
const sharedMetaClient = META_LIGHT_TOKENS.length > 0
  ? new MetaAdLibraryClient({ access_tokens: META_LIGHT_TOKENS, wait_for_rate_limit: true })
  : null;
const sharedSupabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : null;

async function processBrand(brand: string, country: string): Promise<void> {
  const startTime = Date.now();
  currentBrand = brand;
  currentStartTime = startTime;

  try {
    if (!sharedMetaClient) {
      console.log('[LIGHT-VPS] No META_LIGHT_TOKENS configured');
      return;
    }

    const metaClient = sharedMetaClient;
    const supabase = sharedSupabase;

    // ========== STEP 1: Find the brand's Facebook page ==========
    console.log(`[LIGHT-VPS] Step 1: Finding page for "${brand}" (async)...`);

    const cleanQuery = brand.toLowerCase().replace(/[^a-z0-9]/g, '');
    const searchVariants = [...new Set([
      brand,
      ...(brand.includes(' ') ? [cleanQuery] : []),
      `${cleanQuery}.de`,
      `weare${cleanQuery}`,
    ])].slice(0, 4);

    console.log(`[LIGHT-VPS] Search variants: ${searchVariants.join(', ')}`);

    // NO timeout limits — VPS has unlimited time
    const searchResults: MetaAd[][] = [];
    let rateLimitHits = 0;
    for (const term of searchVariants) {
      if (searchResults.length > 0) {
        await new Promise(r => setTimeout(r, 2000));
      }
      try {
        const ads = await metaClient.fetchAllAds({
          search_terms: term,
          ad_reached_countries: [country],
          ad_active_status: 'ALL',
          search_type: 'KEYWORD_UNORDERED',
          max_results: 100,
        });
        searchResults.push(ads);
      } catch (err) {
        if (err instanceof MetaApiError && (err.code === 613 || err.code === 4 || err.code === 429)) {
          rateLimitHits++;
        }
        console.log(`[LIGHT-VPS] "${term}" failed: ${err}`);
        searchResults.push([]);
      }
    }

    const allSearchAds = searchResults.flat();

    if (allSearchAds.length === 0) {
      // Mark as cached so pipeline moves on
      if (supabase) {
        try {
          await supabase.from('brand_list')
            .update({ light_cached_at: new Date().toISOString() })
            .ilike('input_name', brand);
          console.log(`[LIGHT-VPS] No results for "${brand}" (rate_limit=${rateLimitHits}) — marked as done`);
        } catch { /* non-critical */ }
      }
      return;
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

    const pages = Array.from(pageMap.values())
      .filter(p => isRelevantResult(p.page_name, brand, p.reach))
      .map(p => ({ ...p, score: calculateQuickScore(p.page_name, brand, p.reach, p.ad_count) }))
      .sort((a, b) => b.score - a.score);

    if (pages.length === 0) {
      if (supabase) {
        try {
          await supabase.from('brand_list')
            .update({ light_cached_at: new Date().toISOString() })
            .ilike('input_name', brand);
          console.log(`[LIGHT-VPS] No matching page for "${brand}" — marked as done`);
        } catch { /* non-critical */ }
      }
      return;
    }

    const bestPage = pages[0];
    console.log(`[LIGHT-VPS] Best match: "${bestPage.page_name}" (${bestPage.page_id}), score=${bestPage.score}`);

    // ========== STEP 1.5: Check cache ==========
    if (supabase) {
      const { data: cached } = await supabase
        .from('page_ad_cache')
        .select('page_id, page_name, total_ads, data')
        .eq('page_id', bestPage.page_id)
        .eq('country', country)
        .gt('expires_at', new Date().toISOString())
        .maybeSingle();

      if (cached) {
        console.log(`[LIGHT-VPS] Cache HIT for ${bestPage.page_name} (${cached.total_ads} ads)`);
        try {
          await supabase.from('brand_list')
            .update({ light_cached_at: new Date().toISOString(), page_id: cached.page_id, page_name: cached.page_name })
            .ilike('input_name', brand);
        } catch { /* non-critical */ }
        console.log(`[LIGHT-VPS] Done (cached): "${brand}" → "${cached.page_name}" (${cached.total_ads} ads)`);
        return;
      }
    }

    // ========== STEP 2: Fetch ALL ads (NO LIMIT — VPS has no timeout) ==========
    console.log(`[LIGHT-VPS] Step 2: Fetching ALL ads from "${bestPage.page_name}" (${bestPage.page_id})...`);

    const pageAds = await metaClient.fetchAllAdsFromPage({
      page_id: bestPage.page_id,
      ad_reached_countries: [country],
      ad_active_status: 'ALL',
      max_results: 10000,
    });

    console.log(`[LIGHT-VPS] Fetched ${pageAds.length} ads in ${Math.round((Date.now() - startTime) / 1000)}s`);

    const processedAds = processAds(pageAds);
    processedAds.sort((a, b) => (b.reach || 0) - (a.reach || 0));

    const allCaptions = pageAds.flatMap(a => a.ad_creative_link_captions || []);
    const domains = extractDomainsFromCaptions(allCaptions);
    const demographics = aggregateDemographics(pageAds);

    const brandResponse: BrandSearchResponse = {
      success: true,
      brand: bestPage.page_name,
      total_ads: processedAds.length,
      pages: {
        official: [{ page_id: bestPage.page_id, page_name: bestPage.page_name, ad_count: pageAds.length, is_official: true }],
        third_party: [],
      },
      domains, ads: processedAds, demographics,
    };

    // ========== STEP 3: Cache ==========
    if (supabase && pageAds.length > 0) {
      const { error: upsertError } = await supabase
        .from('page_ad_cache')
        .upsert({
          page_id: bestPage.page_id, page_name: bestPage.page_name, country,
          total_ads: pageAds.length, data: brandResponse,
          total_reach: demographics?.total_sample || 0,
          created_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
        }, { onConflict: 'page_id,country' });

      if (upsertError) console.log(`[LIGHT-VPS] Cache write error: ${upsertError.message}`);
      else console.log(`[LIGHT-VPS] Cached ${pageAds.length} ads for "${bestPage.page_name}"`);

      try {
        await supabase.from('brand_list')
          .update({ light_cached_at: new Date().toISOString(), page_id: bestPage.page_id, page_name: bestPage.page_name })
          .ilike('input_name', brand);
      } catch { /* non-critical */ }
    }

    const totalTime = Date.now() - startTime;
    console.log(`[LIGHT-VPS] Done: "${brand}" → "${bestPage.page_name}" (${pageAds.length} ads, ${totalTime}ms)`);

  } catch (error) {
    console.error(`[LIGHT-VPS] Error processing "${brand}":`, error);
    // Mark as done so pipeline moves on (don't retry endlessly for huge brands like Coca-Cola)
    if (sharedSupabase) {
      try {
        await sharedSupabase.from('brand_list')
          .update({ light_cached_at: new Date().toISOString() })
          .ilike('input_name', brand);
        console.log(`[LIGHT-VPS] Marked "${brand}" as done after error — skipping`);
      } catch { /* non-critical */ }
    }
  } finally {
    currentBrand = null;
  }
}

// ============================================
// HTTP Handler (responds immediately, processes in background)
// ============================================

async function handleRequest(req: Request): Promise<Response> {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers });

  if (req.method === 'OPTIONS') return new Response(null, { headers });

  const url = new URL(req.url);

  // Health check
  if (url.pathname === '/health') {
    return json({
      status: 'ok',
      tokens: META_LIGHT_TOKENS.length,
      uptime: Math.round(performance.now() / 1000),
      current_brand: currentBrand,
      processing_since: currentBrand ? Math.round((Date.now() - currentStartTime) / 1000) : null,
    });
  }

  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const body = await req.json() as { brand?: string; country?: string };
    if (!body.brand?.trim()) return json({ error: 'brand is required' }, 400);

    const brand = body.brand.trim();
    const country = body.country || 'DE';

    // If already processing a brand, skip (pg_cron will retry next minute)
    if (currentBrand) {
      console.log(`[LIGHT-VPS] Busy with "${currentBrand}" (${Math.round((Date.now() - currentStartTime) / 1000)}s) — skipping "${brand}"`);
      return json({ status: 'busy', current_brand: currentBrand });
    }

    // Respond immediately, process in background
    console.log(`[LIGHT-VPS] Accepted "${brand}" — processing in background`);
    processBrand(brand, country).catch(err => console.error(`[LIGHT-VPS] Background error:`, err));

    return json({ status: 'accepted', brand });

  } catch (error) {
    return json({ error: String(error) }, 500);
  }
}

// ============================================
// Self-polling pipeline loop
// ============================================

const POLL_INTERVAL_MS = 60_000; // Check every 60 seconds

async function pipelineLoop(): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.log('[LIGHT-VPS] No Supabase credentials — pipeline loop disabled');
    return;
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  while (true) {
    try {
      // Check if pipeline is active
      const { data: setting } = await supabase
        .from('pipeline_settings')
        .select('value')
        .eq('key', 'light_pipeline_active')
        .maybeSingle();

      if (setting?.value !== 'true') {
        // Pipeline not active — wait and check again
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
        continue;
      }

      // Skip if already processing
      if (currentBrand) {
        console.log(`[LIGHT-VPS] Pipeline tick — busy with "${currentBrand}" (${Math.round((Date.now() - currentStartTime) / 1000)}s)`);
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
        continue;
      }

      // Find next uncached brand
      const { data: next } = await supabase
        .from('brand_list')
        .select('input_name, country')
        .is('light_cached_at', null)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .limit(1)
        .maybeSingle();

      if (!next) {
        // All done — deactivate pipeline
        console.log('[LIGHT-VPS] All brands cached — deactivating pipeline');
        await supabase.from('pipeline_settings')
          .update({ value: 'false', updated_at: new Date().toISOString() })
          .eq('key', 'light_pipeline_active');
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
        continue;
      }

      console.log(`[LIGHT-VPS] Pipeline tick — processing "${next.input_name}"`);
      await processBrand(next.input_name, next.country || 'DE');

      // Short delay between brands to avoid hammering the API
      await new Promise(r => setTimeout(r, 5_000));

    } catch (err) {
      console.error('[LIGHT-VPS] Pipeline loop error:', err);
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    }
  }
}

// ============================================
// Start Server + Pipeline Loop
// ============================================
Deno.serve({ port: PORT }, handleRequest);

// Start the self-polling pipeline loop
pipelineLoop().catch(err => console.error('[LIGHT-VPS] Pipeline loop crashed:', err));
