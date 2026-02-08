/**
 * Page Search Quick - Edge Function
 * SCHNELLE SUCHE: 1 API-Call, 2-3 Sekunden
 *
 * POST /page-search-quick
 * Body: { query: string, country?: string }
 *
 * Verwendet parallel zur vollständigen Suche (/page-search)
 * Zeigt sofort erste Ergebnisse während Vollsuche läuft
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { MetaAd } from '../../../lib/types.ts';
import { MetaAdLibraryClient, MetaApiError } from '../../../lib/meta-api.ts';
import { extractDomainFromCaption } from '../../../lib/url-extractor.ts';

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface QuickSearchRequest {
  query: string;
  country?: string;
}

interface QuickPageResult {
  page_id: string;
  page_name: string;
  ad_count: number;
  top_domain: string | null;
  sample_reach: number;
  match_score: number;
  is_quick_result: true;  // Marker für Frontend
}

interface QuickSearchResponse {
  success: boolean;
  query: string;
  pages: QuickPageResult[];
  search_time_ms: number;
  is_quick_search: true;  // Marker für Frontend
  error?: string;
}

/**
 * Calculate quick match score
 * Prioritizes: Exact name match > High reach > Ad count
 */
function calculateQuickScore(
  pageName: string,
  query: string,
  reach: number,
  adCount: number
): number {
  let score = 0;
  const pageNameLower = pageName.toLowerCase();
  const queryLower = query.toLowerCase();

  // Exact name match = highest priority
  if (pageNameLower === queryLower) {
    score += 10000;
  } else if (pageNameLower.includes(queryLower)) {
    score += 5000;
  } else if (queryLower.includes(pageNameLower)) {
    score += 2000;
  }

  // Reach bonus (primary factor)
  score += Math.log10(reach + 1) * 300;

  // Ad count bonus (secondary)
  score += Math.log10(adCount + 1) * 50;

  return score;
}

/**
 * Check if result is relevant enough for quick display
 * Now considers the cleaned query (without spaces) for matching
 */
function isRelevantQuickResult(
  pageName: string,
  query: string,
  reach: number
): boolean {
  const pageNameLower = pageName.toLowerCase();
  const queryLower = query.toLowerCase();
  const cleanQuery = query.toLowerCase().replace(/[^a-z0-9]/g, '');
  const cleanPageName = pageName.toLowerCase().replace(/[^a-z0-9]/g, '');

  // Name contains query (with or without spaces)
  const nameMatch =
    pageNameLower.includes(queryLower) ||
    queryLower.includes(pageNameLower) ||
    cleanPageName.includes(cleanQuery) ||
    cleanQuery.includes(cleanPageName);

  // High reach (> 50K - lowered threshold for quick results)
  const highReach = reach > 50000;

  // At least one must be true
  return nameMatch || highReach;
}

serve(async (req) => {
  const startTime = Date.now();

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Parse request
    const body: QuickSearchRequest = await req.json();

    if (!body.query || body.query.trim().length === 0) {
      return new Response(
        JSON.stringify({ success: false, error: 'Query parameter is required', is_quick_search: true }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const query = body.query.trim();
    const country = body.country || 'DE';

    // Get Meta API access token
    const metaAccessToken = Deno.env.get('META_ACCESS_TOKEN');
    if (!metaAccessToken) {
      return new Response(
        JSON.stringify({ success: false, error: 'Meta API access token not configured', is_quick_search: true }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Initialize Meta API client
    const metaClient = new MetaAdLibraryClient({
      access_token: metaAccessToken,
    });

    console.log(`[QUICK] Searching for: "${query}" in ${country}`);

    // Generate quick search variants (most effective patterns)
    const cleanQuery = query.toLowerCase().replace(/[^a-z0-9]/g, '');
    const searchVariants: string[] = [];

    // Priority order (most effective first):
    // 1. Original query
    searchVariants.push(query);

    // 2. Without spaces (Red Bull → redbull) - if applicable
    if (query.includes(' ') && !searchVariants.includes(cleanQuery)) {
      searchVariants.push(cleanQuery);
    }

    // 3. Domain patterns (.de is very effective for German brands)
    searchVariants.push(`${cleanQuery}.de`);

    // 4. weare pattern (common for DTC brands)
    searchVariants.push(`weare${cleanQuery}`);

    // Take first 4 unique variants
    const variantsArray = [...new Set(searchVariants)].slice(0, 4);

    console.log(`[QUICK] Search variants: ${variantsArray.join(', ')}`);

    // PARALLEL API CALLS - Fast but thorough
    const searchPromises = variantsArray.map(async (term) => {
      try {
        const termAds = await metaClient.fetchAllAds({
          search_terms: term,
          ad_reached_countries: [country],
          ad_active_status: 'ALL',
          search_type: 'KEYWORD_UNORDERED',
          max_results: 100,
        });
        console.log(`[QUICK] "${term}": ${termAds.length} ads`);
        return termAds;
      } catch (err) {
        console.log(`[QUICK] "${term}" failed:`, err);
        return [] as MetaAd[];
      }
    });

    // Wait for all searches to complete
    const results = await Promise.all(searchPromises);
    const ads = results.flat();

    console.log(`[QUICK] Total: ${ads.length} ads from ${variantsArray.length} parallel searches`);

    // Group ads by page
    const pageMap = new Map<string, QuickPageResult>();

    for (const ad of ads) {
      if (!ad.page_id) continue;

      let pageData = pageMap.get(ad.page_id);
      if (!pageData) {
        pageData = {
          page_id: ad.page_id,
          page_name: ad.page_name || 'Unknown',
          ad_count: 0,
          top_domain: null,
          sample_reach: 0,
          match_score: 0,
          is_quick_result: true,
        };
        pageMap.set(ad.page_id, pageData);
      }

      pageData.ad_count++;
      pageData.sample_reach += ad.eu_total_reach || 0;

      // Extract domain from first caption
      if (!pageData.top_domain && ad.ad_creative_link_captions) {
        for (const caption of ad.ad_creative_link_captions) {
          const domain = extractDomainFromCaption(caption);
          if (domain) {
            pageData.top_domain = domain;
            break;
          }
        }
      }
    }

    // Calculate scores and filter
    const pages = Array.from(pageMap.values());

    // Filter to only relevant results
    const relevantPages = pages.filter(page =>
      isRelevantQuickResult(page.page_name, query, page.sample_reach)
    );

    // Calculate match scores
    for (const page of relevantPages) {
      page.match_score = calculateQuickScore(
        page.page_name,
        query,
        page.sample_reach,
        page.ad_count
      );
    }

    // Sort by score (highest first)
    relevantPages.sort((a, b) => b.match_score - a.match_score);

    // Take top 5 for quick results
    const topPages = relevantPages.slice(0, 5);

    const searchTime = Date.now() - startTime;
    console.log(`[QUICK] Returning ${topPages.length} results in ${searchTime}ms`);

    // Build response
    const response: QuickSearchResponse = {
      success: true,
      query,
      pages: topPages,
      search_time_ms: searchTime,
      is_quick_search: true,
    };

    return new Response(JSON.stringify(response), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('[QUICK] Error:', error);

    const errorMessage =
      error instanceof MetaApiError
        ? `Meta API Error: ${error.message} (Code: ${error.code})`
        : error instanceof Error
        ? error.message
        : 'Unknown error';

    return new Response(
      JSON.stringify({
        success: false,
        error: errorMessage,
        is_quick_search: true,
        search_time_ms: Date.now() - startTime
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
