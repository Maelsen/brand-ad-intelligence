/**
 * Brand Ad Lookup - Edge Function
 * Schritt 2 des 2-Schritt-Prozesses
 *
 * POST /brand-search
 * Body: { page_id: string, country?: string }
 *
 * Lädt ALLE Ads von einer spezifischen Facebook Page
 * MIT CACHING: 24h TTL, sofortiges Laden aus Cache
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  BrandSearchResponse,
  ProcessedAd,
  PageInfo,
  PagesMapping,
  MetaAd,
  DemographicsData,
  AgeCountryGenderBreakdown,
} from '../../../lib/types.ts';
import { MetaAdLibraryClient, MetaApiError } from '../../../lib/meta-api.ts';
import {
  extractDomainFromCaption,
  extractDomainsFromCaptions,
  formatReach,
} from '../../../lib/url-extractor.ts';

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface BrandSearchRequest {
  page_id: string;
  country?: string;
  countries?: string[];
  skip_cache?: boolean;  // Optional: Cache überspringen für Force-Refresh
}

interface CachedData {
  id: string;
  page_id: string;
  page_name: string | null;
  country: string;
  total_ads: number;
  data: BrandSearchResponse;
  created_at: string;
  expires_at: string;
}

serve(async (req) => {
  const startTime = Date.now();

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Parse request
    const body: BrandSearchRequest = await req.json();

    if (!body.page_id) {
      return new Response(
        JSON.stringify({ success: false, error: 'page_id parameter is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Determine countries to search
    const countries = body.countries || [body.country || 'DE'];
    const countryKey = countries.sort().join(',');

    // Initialize Supabase client for caching
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_ANON_KEY');

    let supabase = null;
    if (supabaseUrl && supabaseKey) {
      supabase = createClient(supabaseUrl, supabaseKey);
    }

    // ========== CACHE CHECK ==========
    if (supabase && !body.skip_cache) {
      console.log(`[CACHE] Checking cache for page ${body.page_id} in ${countryKey}`);

      const { data: cached, error: cacheError } = await supabase
        .from('page_ad_cache')
        .select('*')
        .eq('page_id', body.page_id)
        .eq('country', countryKey)
        .gt('expires_at', new Date().toISOString())
        .single();

      if (cached && !cacheError) {
        const cacheAge = Date.now() - new Date(cached.created_at).getTime();
        const cacheAgeHours = (cacheAge / (1000 * 60 * 60)).toFixed(1);

        console.log(`[CACHE] HIT! Returning ${cached.total_ads} ads (cached ${cacheAgeHours}h ago)`);

        // Add cache info to response
        const cachedResponse = cached.data as BrandSearchResponse;
        return new Response(
          JSON.stringify({
            ...cachedResponse,
            from_cache: true,
            cache_age_hours: parseFloat(cacheAgeHours),
            load_time_ms: Date.now() - startTime,
          }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      if (cacheError && cacheError.code !== 'PGRST116') {
        // PGRST116 = no rows found (expected for cache miss)
        console.log(`[CACHE] Error checking cache:`, cacheError.message);
      } else {
        console.log(`[CACHE] MISS - fetching from Meta API`);
      }
    }

    // ========== META API FETCH ==========
    const metaSearchToken = Deno.env.get('META_SEARCH_TOKEN') || '';
    if (!metaSearchToken) {
      return new Response(
        JSON.stringify({ success: false, error: 'META_SEARCH_TOKEN not configured' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const metaClient = new MetaAdLibraryClient({
      access_token: metaSearchToken,
    });

    console.log(`[API] Loading ALL ads from page ${body.page_id} in countries: ${countries.join(', ')}`);

    // Fetch ALL ads from the specific page
    const ads = await metaClient.fetchAllAdsFromPage({
      page_id: body.page_id,
      ad_reached_countries: countries,
      ad_active_status: 'ALL',
      max_results: 10000,
    });

    console.log(`[API] Loaded ${ads.length} ads from page`);

    // Debug: check demographics availability
    const adsWithBreakdown = ads.filter(a => a.age_country_gender_reach_breakdown && a.age_country_gender_reach_breakdown.length > 0);
    console.log(`[API] Ads with age_country_gender_reach_breakdown: ${adsWithBreakdown.length}/${ads.length}`);
    if (ads.length > 0) {
      const sampleAd = ads[0];
      console.log(`[API] Sample ad keys: ${Object.keys(sampleAd).join(', ')}`);
      if (sampleAd.age_country_gender_reach_breakdown) {
        console.log(`[API] Sample breakdown: ${JSON.stringify(sampleAd.age_country_gender_reach_breakdown.slice(0, 2))}`);
      }
    }

    // Process and sort ads
    const processedAds = processAds(ads);
    processedAds.sort((a, b) => (b.reach || 0) - (a.reach || 0));

    // Get page info from first ad
    const pageName = ads[0]?.page_name || 'Unknown';

    // Create pages mapping
    const pages: PagesMapping = {
      official: [{
        page_id: body.page_id,
        page_name: pageName,
        ad_count: ads.length,
        is_official: true,
      }],
      third_party: [],
    };

    // Extract all unique domains
    const allCaptions = ads.flatMap((ad) => ad.ad_creative_link_captions || []);
    const domains = extractDomainsFromCaptions(allCaptions);

    // Aggregate demographics from raw ads
    const demographics = aggregateDemographics(ads);

    // Build response
    const response: BrandSearchResponse = {
      success: true,
      brand: pageName,
      total_ads: processedAds.length,
      pages,
      domains,
      ads: processedAds,
      demographics,
    };

    // ========== SAVE TO CACHE ==========
    if (supabase && ads.length > 0) {
      console.log(`[CACHE] Saving ${ads.length} ads to cache`);

      const { error: upsertError } = await supabase
        .from('page_ad_cache')
        .upsert({
          page_id: body.page_id,
          page_name: pageName,
          country: countryKey,
          total_ads: ads.length,
          total_reach: demographics?.total_sample || 0,
          data: response,
          created_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(), // 90 days
        }, {
          onConflict: 'page_id,country',
        });

      if (upsertError) {
        console.log(`[CACHE] Error saving to cache:`, upsertError.message);
      } else {
        console.log(`[CACHE] Saved successfully`);
      }
    }

    const loadTime = Date.now() - startTime;
    console.log(`[API] Total load time: ${loadTime}ms`);

    return new Response(
      JSON.stringify({
        ...response,
        from_cache: false,
        load_time_ms: loadTime,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Error:', error);

    const errorMessage =
      error instanceof MetaApiError
        ? `Meta API Error: ${error.message} (Code: ${error.code})`
        : error instanceof Error
        ? error.message
        : 'Unknown error';

    return new Response(
      JSON.stringify({ success: false, error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

/**
 * Process raw Meta ads into our format
 */
function processAds(ads: MetaAd[]): ProcessedAd[] {
  const processedAds: ProcessedAd[] = [];

  for (const ad of ads) {
    const rawCaption = ad.ad_creative_link_captions?.[0] || null;
    const landingPageDomain = rawCaption
      ? extractDomainFromCaption(rawCaption)
      : null;

    // Extract full URL from caption (preserves path if present)
    // Captions can be "MONAPURE.DE/COLLECTIONS/SALE" or just "MONAPURE.DE"
    const landingPageUrl = rawCaption
      ? extractFullUrlFromCaption(rawCaption)
      : null;

    const processedAd: ProcessedAd = {
      id: ad.id,
      creative_url: ad.ad_snapshot_url || null,
      primary_text: ad.ad_creative_bodies?.[0] || null,
      headline: ad.ad_creative_link_titles?.[0] || null,
      description: ad.ad_creative_link_descriptions?.[0] || null,
      start_date: ad.ad_delivery_start_time || null,
      status: ad.ad_delivery_stop_time ? 'inactive' : 'active',
      landing_page_url: landingPageUrl,
      landing_page_domain: landingPageDomain,
      reach: ad.eu_total_reach || null,
      reach_formatted: formatReach(ad.eu_total_reach),
      page_id: ad.page_id || null,
      page_name: ad.page_name || null,
      platforms: ad.publisher_platforms || [],
      languages: ad.languages || [],
    };

    processedAds.push(processedAd);
  }

  return processedAds;
}

/**
 * Extract full URL from ad_creative_link_captions
 * Preserves the path if present (e.g., "MONAPURE.DE/COLLECTIONS/SALE" → "https://monapure.de/collections/sale")
 * Falls back to just domain if no path (e.g., "MIAVOLA.DE" → "https://miavola.de")
 */
/**
 * Aggregate demographics from age_country_gender_reach_breakdown across all ads
 */
function aggregateDemographics(ads: MetaAd[]): DemographicsData | undefined {
  let totalMale = 0;
  let totalFemale = 0;
  let totalUnknown = 0;
  const ageMap: Record<string, number> = {};
  const countryMap: Record<string, number> = {};
  let totalSample = 0;

  for (const ad of ads) {
    const breakdown = ad.age_country_gender_reach_breakdown;
    if (!breakdown || !Array.isArray(breakdown)) continue;

    // Real API structure: [{country: "DE", age_gender_breakdowns: [{age_range, male?, female?, unknown?}]}]
    for (const countryEntry of breakdown) {
      const country = countryEntry.country || 'unknown';
      const ageBreakdowns = countryEntry.age_gender_breakdowns;
      if (!ageBreakdowns || !Array.isArray(ageBreakdowns)) continue;

      for (const ageEntry of ageBreakdowns) {
        const male = ageEntry.male || 0;
        const female = ageEntry.female || 0;
        const unknown = ageEntry.unknown || 0;
        const entryTotal = male + female + unknown;

        totalMale += male;
        totalFemale += female;
        totalUnknown += unknown;
        totalSample += entryTotal;

        // Age groups
        const age = ageEntry.age_range || 'unknown';
        ageMap[age] = (ageMap[age] || 0) + entryTotal;

        // Countries
        countryMap[country] = (countryMap[country] || 0) + entryTotal;
      }
    }
  }

  if (totalSample === 0) return undefined;

  const genderTotal = totalMale + totalFemale + totalUnknown;
  const gender = {
    male: Math.round((totalMale / genderTotal) * 100),
    female: Math.round((totalFemale / genderTotal) * 100),
    unknown: Math.round((totalUnknown / genderTotal) * 100),
  };

  const age_groups = Object.entries(ageMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([group, reach]) => ({
      group,
      pct: Math.round((reach / totalSample) * 100),
    }));

  const countries = Object.entries(countryMap)
    .sort(([, a], [, b]) => b - a)
    .map(([country, reach]) => ({
      country,
      reach,
      pct: Math.round((reach / totalSample) * 100),
    }));

  return { gender, age_groups, countries, total_sample: totalSample };
}

function extractFullUrlFromCaption(caption: string): string | null {
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
