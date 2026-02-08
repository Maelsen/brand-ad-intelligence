/**
 * Page Search - Edge Function
 * Multi-Strategie Page Discovery
 *
 * POST /page-search
 * Body: { query: string, country?: string }
 *
 * Unterstützt:
 * 1. Facebook URL Eingabe (facebook.com/username) → Direkter Page Lookup
 * 2. Brand-Name Eingabe → Multi-Strategie Suche:
 *    - Keyword-Suche
 *    - Domain-Varianten Suche (brand → wearebrand, brandsquad, etc.)
 *    - Exakte Page-Name Priorisierung
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

interface PageSearchRequest {
  query: string;
  country?: string;
}

interface PageResult {
  page_id: string;
  page_name: string;
  ad_count: number;
  top_domain: string | null;
  sample_reach: number;
  match_type: 'direct' | 'exact_name' | 'domain_match' | 'keyword_match';
  match_score: number;
}

interface PageSearchResponse {
  success: boolean;
  query: string;
  search_type: 'facebook_url' | 'brand_name';
  pages: PageResult[];
  error?: string;
}

/**
 * Check if input is a Facebook URL
 */
function isFacebookUrl(input: string): boolean {
  const patterns = [
    /facebook\.com\//i,
    /fb\.com\//i,
    /fb\.me\//i,
    /^@/,  // @username format
  ];
  return patterns.some((p) => p.test(input));
}

/**
 * Extract username/page ID from Facebook URL
 */
function extractUsernameFromUrl(input: string): string | null {
  // Remove @ prefix
  if (input.startsWith('@')) {
    return input.slice(1);
  }

  // Handle full URLs
  const urlPatterns = [
    /(?:facebook|fb)\.com\/(?:pg\/)?([^\/\?]+)/i,
    /fb\.me\/([^\/\?]+)/i,
  ];

  for (const pattern of urlPatterns) {
    const match = input.match(pattern);
    if (match && match[1]) {
      // Skip common non-page paths
      const skipPaths = ['pages', 'profile.php', 'groups', 'events', 'ads'];
      if (!skipPaths.includes(match[1].toLowerCase())) {
        return match[1];
      }
    }
  }

  return null;
}

/**
 * Generate domain variants for a brand name
 */
function generateDomainVariants(brand: string): string[] {
  const clean = brand.toLowerCase().replace(/[^a-z0-9]/g, '');
  const variants = new Set<string>();

  // Common domain patterns
  variants.add(clean);
  variants.add(`${clean}.com`);
  variants.add(`${clean}.de`);
  variants.add(`weare${clean}`);
  variants.add(`${clean}squad`);
  variants.add(`${clean}official`);
  variants.add(`get${clean}`);
  variants.add(`the${clean}`);
  variants.add(`${clean}store`);
  variants.add(`${clean}shop`);

  // Handle multi-word brands (e.g., "Red Bull" → "redbull")
  if (brand.includes(' ')) {
    const noSpaces = brand.replace(/\s+/g, '').toLowerCase();
    variants.add(noSpaces);
    variants.add(`${noSpaces}.com`);
  }

  return Array.from(variants);
}

/**
 * Calculate match score for sorting
 * Prioritizes REACH over ad count (user feedback)
 */
function calculateMatchScore(
  pageName: string,
  query: string,
  matchType: string,
  adCount: number,
  reach: number
): number {
  let score = 0;
  const pageNameLower = pageName.toLowerCase();
  const queryLower = query.toLowerCase();

  // Match type base score
  switch (matchType) {
    case 'direct':
      score += 10000;
      break;
    case 'exact_name':
      score += 5000;
      break;
    case 'domain_match':
      score += 2000;
      break;
    case 'keyword_match':
      score += 1000;
      break;
  }

  // Exact name match bonus
  if (pageNameLower === queryLower) {
    score += 3000;
  } else if (pageNameLower.includes(queryLower)) {
    score += 1500;
  } else if (queryLower.includes(pageNameLower)) {
    score += 500;
  }

  // REACH bonus (PRIORITIZED - log scale * 200)
  // Higher reach = more relevant brand
  score += Math.log10(reach + 1) * 200;

  // Ad count bonus (secondary - log scale * 50)
  score += Math.log10(adCount + 1) * 50;

  return score;
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Parse request
    const body: PageSearchRequest = await req.json();

    if (!body.query || body.query.trim().length === 0) {
      return new Response(
        JSON.stringify({ success: false, error: 'Query parameter is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const query = body.query.trim();

    // Get Meta API access token from environment
    const metaAccessToken = Deno.env.get('META_ACCESS_TOKEN');
    if (!metaAccessToken) {
      return new Response(
        JSON.stringify({ success: false, error: 'Meta API access token not configured' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Initialize Meta API client
    const metaClient = new MetaAdLibraryClient({
      access_token: metaAccessToken,
    });

    const country = body.country || 'DE';
    let searchType: 'facebook_url' | 'brand_name' = 'brand_name';
    const pageMap = new Map<string, PageResult>();

    // Check if it's a Facebook URL
    if (isFacebookUrl(query)) {
      searchType = 'facebook_url';
      const username = extractUsernameFromUrl(query);

      if (username) {
        console.log(`Facebook URL detected, looking up: ${username}`);

        // Try Graph API lookup
        const pageInfo = await metaClient.getPageInfo(username);

        if (pageInfo) {
          console.log(`Found page: ${pageInfo.name} (${pageInfo.id})`);

          // Get ad count for this page
          const ads = await metaClient.fetchAllAds({
            search_terms: pageInfo.name,
            ad_reached_countries: [country],
            ad_active_status: 'ALL',
            search_type: 'KEYWORD_UNORDERED',
            max_results: 100,
          });

          const pageAds = ads.filter((ad) => ad.page_id === pageInfo.id);
          const totalReach = pageAds.reduce((sum, ad) => sum + (ad.eu_total_reach || 0), 0);

          // Get top domain
          let topDomain: string | null = null;
          const domainCounts = new Map<string, number>();
          for (const ad of pageAds) {
            for (const caption of ad.ad_creative_link_captions || []) {
              const domain = extractDomainFromCaption(caption);
              if (domain) {
                domainCounts.set(domain, (domainCounts.get(domain) || 0) + 1);
              }
            }
          }
          let maxCount = 0;
          for (const [domain, count] of domainCounts) {
            if (count > maxCount) {
              maxCount = count;
              topDomain = domain;
            }
          }

          pageMap.set(pageInfo.id, {
            page_id: pageInfo.id,
            page_name: pageInfo.name,
            ad_count: pageAds.length,
            top_domain: topDomain,
            sample_reach: totalReach,
            match_type: 'direct',
            match_score: 10000,
          });
        } else {
          console.log(`Could not find page for username: ${username}`);
        }
      }
    }

    // If not a URL or URL lookup failed, do multi-strategy search
    if (searchType === 'brand_name' || pageMap.size === 0) {
      searchType = 'brand_name';
      console.log(`Multi-strategy search for: "${query}" in ${country}`);

      // Generate search terms (brand name + domain variants)
      const searchTerms = [query, ...generateDomainVariants(query)];
      console.log(`Search terms: ${searchTerms.slice(0, 5).join(', ')}...`);

      // Search with each term and collect results
      for (const term of searchTerms.slice(0, 8)) {
        // Limit to 8 searches to avoid rate limits
        try {
          const ads = await metaClient.fetchAllAds({
            search_terms: term,
            ad_reached_countries: [country],
            ad_active_status: 'ALL',
            search_type: 'KEYWORD_UNORDERED',
            max_results: 200,
          });

          console.log(`Term "${term}": found ${ads.length} ads`);

          // Group by page
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
                match_type: 'keyword_match',
                match_score: 0,
              };
              pageMap.set(ad.page_id, pageData);
            }

            pageData.ad_count++;
            pageData.sample_reach += ad.eu_total_reach || 0;

            // Determine match type
            const pageNameLower = pageData.page_name.toLowerCase();
            const queryLower = query.toLowerCase();

            if (pageNameLower === queryLower || pageNameLower.includes(queryLower)) {
              pageData.match_type = 'exact_name';
            } else if (term !== query && pageData.match_type !== 'exact_name') {
              pageData.match_type = 'domain_match';
            }

            // Track domains
            if (ad.ad_creative_link_captions) {
              for (const caption of ad.ad_creative_link_captions) {
                const domain = extractDomainFromCaption(caption);
                if (domain && !pageData.top_domain) {
                  pageData.top_domain = domain;
                }
              }
            }
          }

          // Small delay between searches
          await new Promise((r) => setTimeout(r, 100));
        } catch (error) {
          console.log(`Search term "${term}" failed:`, error);
        }
      }
    }

    // Calculate match scores and sort
    const pages = Array.from(pageMap.values());
    for (const page of pages) {
      page.match_score = calculateMatchScore(
        page.page_name,
        query,
        page.match_type,
        page.ad_count,
        page.sample_reach
      );
    }

    // Sort by match score (highest first)
    pages.sort((a, b) => b.match_score - a.match_score);

    // Take top 20
    const topPages = pages.slice(0, 20);

    console.log(`Found ${pages.length} pages, returning top ${topPages.length}`);

    // Build response
    const response: PageSearchResponse = {
      success: true,
      query,
      search_type: searchType,
      pages: topPages,
    };

    return new Response(JSON.stringify(response), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
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
