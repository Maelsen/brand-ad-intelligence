/**
 * Domains Mapping - Edge Function (Enhanced)
 * Teil 2: Drittseiten Finder + Full URL Support
 *
 * POST /domains-mapping
 * Body: { brand: string, country?: string, deep_scan?: boolean }
 *
 * Finds:
 * - All Facebook pages running ads for the brand (official vs third_party)
 * - Full landing page URLs with path and UTM parameters
 * - Presell domains → Final shop domains
 * - Shopify checkout detection for brand identification
 * - Redirect chains
 *
 * Stores results in:
 * - brand_domain_mapping table
 * - third_party_pages table
 * - domain_mapping_cache table
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  DomainsRequest,
  DomainsResponse,
  PageInfo,
  PagesMapping,
  LandingPageInfo,
  RedirectChain,
  MetaAd,
} from '../../../lib/types.ts';
import { MetaAdLibraryClient, MetaApiError } from '../../../lib/meta-api.ts';
import {
  extractDomainFromCaption,
  extractDomainsFromCaptions,
  extractDomain,
  extractLandingPageUrl,
  extractPathAndQuery,
} from '../../../lib/url-extractor.ts';
import { batchTrackRedirects, categorizeDomains } from '../../../lib/redirect-tracker.ts';
import { batchTrackPresellChains, PresellChainResult } from '../../../lib/presell-tracker.ts';
import { batchClassifyDomains, DomainClassification } from '../../../lib/domain-classifier.ts';
import { detectBrandFromCheckout, followToCheckout } from '../../../lib/checkout-detector.ts';

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Parse request
    const body = await req.json() as DomainsRequest & { deep_scan?: boolean };

    if (!body.brand) {
      return new Response(
        JSON.stringify({ success: false, error: 'Brand parameter is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Get Meta API access token from environment
    const metaAccessToken = Deno.env.get('META_ACCESS_TOKEN');
    if (!metaAccessToken) {
      return new Response(
        JSON.stringify({ success: false, error: 'Meta API access token not configured' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Initialize Supabase client
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_ANON_KEY');
    const supabase = supabaseUrl && supabaseKey
      ? createClient(supabaseUrl, supabaseKey)
      : null;

    // Check cache first
    if (supabase) {
      const { data: cached } = await supabase
        .from('domain_mapping_cache')
        .select('data, expires_at')
        .eq('brand', body.brand.toLowerCase())
        .eq('country', body.country || 'DE')
        .gt('expires_at', new Date().toISOString())
        .single();

      if (cached?.data && !body.deep_scan) {
        console.log(`[Domains] Cache hit for brand: ${body.brand}`);
        return new Response(JSON.stringify(cached.data), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    // Initialize Meta API client
    const metaClient = new MetaAdLibraryClient({
      access_token: metaAccessToken,
    });

    // Determine countries to search
    const countries = [body.country || 'DE'];
    const brandLower = body.brand.toLowerCase();

    console.log(`[Domains] Finding domains for brand: ${body.brand} (deep_scan: ${body.deep_scan})`);

    // Step 1: Fetch all ads mentioning the brand
    const ads = await metaClient.fetchAllAds({
      search_terms: body.brand,
      ad_reached_countries: countries,
      ad_active_status: 'ALL',
      search_type: 'KEYWORD_EXACT_PHRASE',
      max_results: 1000,
    });

    console.log(`[Domains] Found ${ads.length} ads for brand`);

    // Step 2: Filter to relevant ads
    const filteredAds = ads.filter((ad) => {
      if (ad.page_name?.toLowerCase().includes(brandLower)) return true;
      if (ad.ad_creative_bodies?.some((b) => b.toLowerCase().includes(brandLower))) return true;
      if (ad.ad_creative_link_captions?.some((c) => c.toLowerCase().includes(brandLower))) return true;
      return false;
    });

    console.log(`[Domains] After filtering: ${filteredAds.length} relevant ads`);

    // Step 3: Aggregate pages (official vs third_party)
    const pages = aggregatePages(filteredAds, brandLower);
    console.log(`[Domains] Found ${pages.official.length} official + ${pages.third_party.length} third-party pages`);

    // Step 4: Extract domains from ad_creative_link_captions (100% reliable)
    const allCaptions = filteredAds.flatMap((ad) => ad.ad_creative_link_captions || []);
    const allDomains = extractDomainsFromCaptions(allCaptions);
    console.log(`[Domains] Found ${allDomains.length} unique domains from captions`);

    // Step 5: Calculate top landing pages (domain-level first)
    const topLandingPages = calculateTopLandingPagesByDomain(filteredAds);

    // Step 6: Extract FULL URLs from a sample of ad snapshots
    // This gives us /path?utm_source=... instead of just domain
    const fullUrlResults = await extractFullUrlsFromAds(filteredAds.slice(0, 50));
    console.log(`[Domains] Extracted ${fullUrlResults.length} full URLs from ad snapshots`);

    // Merge full URLs into top landing pages
    const enhancedTopPages = enhanceTopPagesWithFullUrls(topLandingPages, fullUrlResults);

    // Step 7: Track redirects for domains
    const sampleUrls = allDomains.slice(0, 20).map((d) => `https://${d}`);
    let redirectChains: RedirectChain[] = [];

    if (sampleUrls.length > 0) {
      try {
        redirectChains = await batchTrackRedirects(sampleUrls, 3);
        console.log(`[Domains] Tracked ${redirectChains.length} redirect chains`);
      } catch (error) {
        console.log('[Domains] Redirect tracking failed (best effort):', error);
      }
    }

    // Step 8: Categorize domains
    const categorized = categorizeDomains(redirectChains);
    const brandDomains = allDomains.filter((d) => d.includes(brandLower));
    const thirdPartyDomains = allDomains.filter((d) => !d.includes(brandLower));

    // Step 9: Track presell chains for third-party domains
    let presellChains: PresellChainResult[] = [];
    if (thirdPartyDomains.length > 0) {
      try {
        const presellUrls = thirdPartyDomains.slice(0, 15).map((d) => `https://${d}`);
        console.log(`[Presell] Tracking chains for ${presellUrls.length} third-party domains`);
        presellChains = await batchTrackPresellChains(presellUrls, 5, { timeout: 8000 });
        const successCount = presellChains.filter(p => p.cta_url || p.is_presell).length;
        console.log(`[Presell] Found ${successCount} presell chains`);
      } catch (error) {
        console.log('[Presell] Tracking failed (best effort):', error);
      }
    }

    // Step 10: Shopify Checkout Detection for presell chains
    // Follow presell pages through to checkout to identify the actual brand
    const checkoutResults: Array<{ domain: string; brand_name: string | null; shop_domain: string | null; confidence: number }> = [];

    if (body.deep_scan && thirdPartyDomains.length > 0) {
      console.log(`[Checkout] Deep scanning ${Math.min(thirdPartyDomains.length, 10)} third-party domains`);
      const domainsToCheck = thirdPartyDomains.slice(0, 10);

      for (const domain of domainsToCheck) {
        try {
          const result = await followToCheckout(`https://${domain}`, { timeout: 10000, maxHops: 3 });
          if (result.brand_name || result.shop_domain) {
            checkoutResults.push({
              domain,
              brand_name: result.brand_name,
              shop_domain: result.shop_domain,
              confidence: result.confidence,
            });
            console.log(`[Checkout] ${domain} → Brand: ${result.brand_name}, Shop: ${result.shop_domain}`);
          }
        } catch (error) {
          console.log(`[Checkout] Error for ${domain}:`, error);
        }
      }

      console.log(`[Checkout] Identified ${checkoutResults.length} brand connections`);
    }

    // Step 11: Classify domains
    let domainClassifications: DomainClassification[] = [];
    if (allDomains.length > 0) {
      try {
        const domainsToClassify = allDomains.slice(0, 20);
        console.log(`[Classify] Classifying ${domainsToClassify.length} domains`);
        domainClassifications = await batchClassifyDomains(domainsToClassify, body.brand, 5, { timeout: 8000 });
        const classified = domainClassifications.filter(d => d.type !== 'unknown').length;
        console.log(`[Classify] Classified ${classified}/${domainsToClassify.length} domains`);
      } catch (error) {
        console.log('[Classify] Classification failed (best effort):', error);
      }
    }

    // Step 12: Store brand-domain mappings in DB
    if (supabase) {
      await storeBrandDomainMappings(supabase, body.brand, {
        allDomains,
        brandDomains,
        thirdPartyDomains,
        presellChains,
        checkoutResults,
        domainClassifications,
        pages,
        fullUrlResults,
      });
    }

    // Build response
    const response: DomainsResponse = {
      success: true,
      brand: body.brand,
      pages,
      domains: {
        presell: Array.from(categorized.presell).length > 0
          ? Array.from(categorized.presell)
          : thirdPartyDomains.slice(0, 10),
        redirect: Array.from(categorized.redirect),
        final_shop: Array.from(categorized.final_shop).length > 0
          ? Array.from(categorized.final_shop)
          : brandDomains,
        all: allDomains,
      },
      top_landing_pages: enhancedTopPages,
      redirect_chains: redirectChains,
      presell_chains: presellChains.filter(p => p.cta_url || p.is_presell || p.shop_domain),
      domain_classifications: domainClassifications,
      // NEW: Checkout detection results
      checkout_detections: checkoutResults.length > 0 ? checkoutResults : undefined,
    };

    // Cache the response
    if (supabase) {
      await supabase.from('domain_mapping_cache').upsert({
        brand: body.brand.toLowerCase(),
        country: body.country || 'DE',
        data: response,
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      }, { onConflict: 'brand,country' });
    }

    return new Response(JSON.stringify(response), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('[Domains] Error:', error);

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
 * Aggregate pages from ads - separate official from third_party
 */
function aggregatePages(ads: MetaAd[], brandLower: string): PagesMapping {
  const pageMap = new Map<string, PageInfo>();

  for (const ad of ads) {
    if (ad.page_id) {
      const existing = pageMap.get(ad.page_id);
      if (existing) {
        existing.ad_count++;
      } else {
        const pageName = ad.page_name || 'Unknown';
        const pageNameLower = pageName.toLowerCase();

        const isOfficial =
          pageNameLower.includes(brandLower) ||
          brandLower.includes(pageNameLower.replace(/[^a-z0-9]/g, ''));

        pageMap.set(ad.page_id, {
          page_id: ad.page_id,
          page_name: pageName,
          ad_count: 1,
          is_official: isOfficial,
        });
      }
    }
  }

  const allPages = Array.from(pageMap.values()).sort((a, b) => b.ad_count - a.ad_count);

  return {
    official: allPages.filter((p) => p.is_official),
    third_party: allPages.filter((p) => !p.is_official),
  };
}

/**
 * Calculate top landing pages by domain frequency
 */
function calculateTopLandingPagesByDomain(ads: MetaAd[]): LandingPageInfo[] {
  const domainCounts = new Map<string, number>();

  for (const ad of ads) {
    const captions = ad.ad_creative_link_captions || [];
    for (const caption of captions) {
      const domain = extractDomainFromCaption(caption);
      if (domain) {
        domainCounts.set(domain, (domainCounts.get(domain) || 0) + 1);
      }
    }
  }

  return Array.from(domainCounts.entries())
    .map(([domain, count]) => ({
      url: `https://${domain}`,
      count,
      domain,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);
}

/**
 * Extract full URLs from a sample of ad snapshots
 * Returns URLs with full path and UTM parameters
 */
async function extractFullUrlsFromAds(
  ads: MetaAd[],
  concurrency: number = 5
): Promise<Array<{ ad_id: string; full_url: string; full_path: string; domain: string }>> {
  const results: Array<{ ad_id: string; full_url: string; full_path: string; domain: string }> = [];

  // Only process ads that have snapshot URLs
  const adsWithSnapshots = ads.filter(ad => ad.ad_snapshot_url && ad.id);

  for (let i = 0; i < adsWithSnapshots.length; i += concurrency) {
    const batch = adsWithSnapshots.slice(i, i + concurrency);

    const promises = batch.map(async (ad) => {
      try {
        const url = await extractLandingPageUrl(ad.ad_snapshot_url!);
        if (url) {
          const path = extractPathAndQuery(url);
          const domain = extractDomainFromUrl(url);
          if (domain) {
            return { ad_id: ad.id, full_url: url, full_path: path || '/', domain };
          }
        }
      } catch {
        // Ignore individual failures
      }
      return null;
    });

    const batchResults = await Promise.all(promises);
    for (const r of batchResults) {
      if (r) results.push(r);
    }

    if (i + concurrency < adsWithSnapshots.length) {
      await new Promise(r => setTimeout(r, 100));
    }
  }

  return results;
}

/**
 * Enhance top landing pages with full URLs from ad snapshots
 * Replaces domain-only entries with full URL entries when available
 */
function enhanceTopPagesWithFullUrls(
  topPages: LandingPageInfo[],
  fullUrls: Array<{ ad_id: string; full_url: string; full_path: string; domain: string }>
): LandingPageInfo[] {
  // Count full URLs by URL (with path)
  const fullUrlCounts = new Map<string, { count: number; domain: string; full_path: string }>();

  for (const entry of fullUrls) {
    const existing = fullUrlCounts.get(entry.full_url);
    if (existing) {
      existing.count++;
    } else {
      fullUrlCounts.set(entry.full_url, {
        count: 1,
        domain: entry.domain,
        full_path: entry.full_path,
      });
    }
  }

  // If we have full URLs, use them as top landing pages
  if (fullUrlCounts.size > 0) {
    const fullUrlPages = Array.from(fullUrlCounts.entries())
      .map(([url, info]) => ({
        url,
        count: info.count,
        domain: info.domain,
        full_path: info.full_path,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);

    // If we got a good number of full URLs, prefer them
    if (fullUrlPages.length >= 3) {
      return fullUrlPages;
    }

    // Otherwise merge: full URLs first, then domain-only as fallback
    const coveredDomains = new Set(fullUrlPages.map(p => p.domain));
    const remainingDomainPages = topPages
      .filter(p => !coveredDomains.has(p.domain))
      .slice(0, 20 - fullUrlPages.length);

    return [...fullUrlPages, ...remainingDomainPages];
  }

  return topPages;
}

/**
 * Store brand-domain mappings in the database
 */
async function storeBrandDomainMappings(
  supabase: ReturnType<typeof createClient>,
  brand: string,
  data: {
    allDomains: string[];
    brandDomains: string[];
    thirdPartyDomains: string[];
    presellChains: PresellChainResult[];
    checkoutResults: Array<{ domain: string; brand_name: string | null; shop_domain: string | null; confidence: number }>;
    domainClassifications: DomainClassification[];
    pages: PagesMapping;
    fullUrlResults: Array<{ ad_id: string; full_url: string; full_path: string; domain: string }>;
  }
) {
  const brandLower = brand.toLowerCase();

  try {
    // Store domain mappings
    const domainMappings = [];

    // Brand domains = shop
    for (const domain of data.brandDomains) {
      const sampleUrls = data.fullUrlResults
        .filter(r => r.domain === domain)
        .map(r => r.full_url)
        .slice(0, 5);

      domainMappings.push({
        brand: brandLower,
        domain,
        domain_type: 'shop',
        confidence: 0.9,
        discovered_via: 'domain_match',
        sample_urls: sampleUrls,
        ad_count: data.fullUrlResults.filter(r => r.domain === domain).length,
      });
    }

    // Presell chains
    for (const chain of data.presellChains) {
      if (chain.shop_domain) {
        const domain = extractDomainFromUrl(chain.initial_url);
        if (domain) {
          domainMappings.push({
            brand: brandLower,
            domain,
            domain_type: 'presell',
            confidence: chain.confidence,
            discovered_via: 'presell_chain',
            sample_urls: [chain.initial_url, chain.final_url].filter(Boolean),
          });
        }
      }
    }

    // Checkout detections
    for (const checkout of data.checkoutResults) {
      domainMappings.push({
        brand: brandLower,
        domain: checkout.domain,
        domain_type: 'presell',
        confidence: checkout.confidence,
        discovered_via: 'checkout_match',
        sample_urls: [],
      });

      if (checkout.shop_domain && checkout.shop_domain !== checkout.domain) {
        domainMappings.push({
          brand: brandLower,
          domain: checkout.shop_domain,
          domain_type: 'shop',
          confidence: checkout.confidence,
          discovered_via: 'checkout_match',
          sample_urls: [],
        });
      }
    }

    // Domain classifications
    for (const classification of data.domainClassifications) {
      if (classification.type !== 'unknown') {
        const existing = domainMappings.find(m => m.domain === classification.domain);
        if (!existing) {
          domainMappings.push({
            brand: brandLower,
            domain: classification.domain,
            domain_type: classification.type,
            confidence: classification.confidence,
            discovered_via: 'content_match',
            sample_urls: [],
          });
        }
      }
    }

    // Upsert domain mappings
    if (domainMappings.length > 0) {
      await supabase.from('brand_domain_mapping').upsert(
        domainMappings,
        { onConflict: 'brand,domain' }
      );
      console.log(`[DB] Stored ${domainMappings.length} brand-domain mappings`);
    }

    // Store third-party pages
    const thirdPartyPageEntries = data.pages.third_party.map(page => {
      // Find domains used by this page
      const pageDomainsUsed = data.thirdPartyDomains.slice(0, 5);

      // Determine connection type based on checkout results
      const checkoutMatch = data.checkoutResults.find(c =>
        pageDomainsUsed.includes(c.domain)
      );

      return {
        brand: brandLower,
        page_id: page.page_id,
        page_name: page.page_name,
        connection_type: checkoutMatch ? 'checkout_match' : 'domain_match',
        confidence: checkoutMatch ? checkoutMatch.confidence : 0.5,
        discovered_via: checkoutMatch ? 'checkout_detection' : 'ad_search',
        domains_used: pageDomainsUsed,
        ad_count: page.ad_count,
        last_seen: new Date().toISOString(),
      };
    });

    if (thirdPartyPageEntries.length > 0) {
      await supabase.from('third_party_pages').upsert(
        thirdPartyPageEntries,
        { onConflict: 'brand,page_id' }
      );
      console.log(`[DB] Stored ${thirdPartyPageEntries.length} third-party pages`);
    }
  } catch (error) {
    console.log('[DB] Error storing mappings (non-critical):', error);
  }
}

function extractDomainFromUrl(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}
