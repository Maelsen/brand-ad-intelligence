/**
 * Brand Discovery Pipeline
 * THE CORE: Finds ALL Facebook Pages advertising for a brand, including
 * third-party pages that never mention the brand name.
 *
 * 7-Step Flow:
 * 1. Check cache
 * 2. Find brand's shop domain (Meta API + Shopify detection)
 * 3. Auto-generate product keywords from brand's ads
 * 4. Search Meta API for ALL advertisers using those keywords
 * 5. Extract unique domains from all found ads
 * 6. Brand-check each domain (redirect, Shopify vendor, presell CTA)
 * 7. Build result + store in DB
 */

import {
  MetaAd,
  BrandDiscoveryRequest,
  BrandDiscoveryResponse,
  BrandInfo,
  DomainBrandCheck,
  ThirdPartyPageInfo,
  PageInfo,
  LandingPageInfo,
  ProcessedAd,
  DemographicsData,
} from './types.ts';
import { MetaAdLibraryClient } from './meta-api.ts';
import { detectShopifyStore } from './shopify-detector.ts';
import { generateKeywords, refineKeywordsWithAI } from './keyword-generator.ts';
import { trackPresellChain } from './presell-tracker.ts';
import { extractDomainFromCaption, extractFullUrlFromCaption, extractDomainsFromCaptions, extractLandingPageUrl, formatReach } from './url-extractor.ts';
import { scrapeWithHeadless } from './headless-scraper.ts';
import { detectBrandFromCheckout } from './checkout-detector.ts';
import { deepCTAChainFollow } from './deep-cta-tracker.ts';
import { quickAIVerify } from './ai-brand-verifier.ts';

// ============================================
// Demographics Helper
// ============================================

function aggregateDemographicsFromAds(ads: MetaAd[]): DemographicsData | undefined {
  let totalMale = 0, totalFemale = 0, totalUnknown = 0;
  const ageMap: Record<string, number> = {};
  const countryMap: Record<string, number> = {};
  let totalSample = 0;

  for (const ad of ads) {
    const breakdown = ad.age_country_gender_reach_breakdown;
    if (!breakdown || !Array.isArray(breakdown)) continue;
    // Real API: [{country: "DE", age_gender_breakdowns: [{age_range, male?, female?, unknown?}]}]
    for (const countryEntry of breakdown) {
      const country = countryEntry.country || 'unknown';
      const ageBreakdowns = countryEntry.age_gender_breakdowns;
      if (!ageBreakdowns || !Array.isArray(ageBreakdowns)) continue;
      for (const ageEntry of ageBreakdowns) {
        const male = ageEntry.male || 0;
        const female = ageEntry.female || 0;
        const unknown = ageEntry.unknown || 0;
        const entryTotal = male + female + unknown;
        totalMale += male; totalFemale += female; totalUnknown += unknown;
        totalSample += entryTotal;
        ageMap[ageEntry.age_range || 'unknown'] = (ageMap[ageEntry.age_range || 'unknown'] || 0) + entryTotal;
        countryMap[country] = (countryMap[country] || 0) + entryTotal;
      }
    }
  }
  if (totalSample === 0) return undefined;
  const genderTotal = totalMale + totalFemale + totalUnknown;
  return {
    gender: {
      male: Math.round((totalMale / genderTotal) * 100),
      female: Math.round((totalFemale / genderTotal) * 100),
      unknown: Math.round((totalUnknown / genderTotal) * 100),
    },
    age_groups: Object.entries(ageMap).sort(([a], [b]) => a.localeCompare(b)).map(([group, reach]) => ({
      group, pct: Math.round((reach / totalSample) * 100),
    })),
    countries: Object.entries(countryMap).sort(([, a], [, b]) => b - a).map(([country, reach]) => ({
      country, reach, pct: Math.round((reach / totalSample) * 100),
    })),
    total_sample: totalSample,
  };
}

// ============================================
// Configuration
// ============================================

const DOMAIN_CHECK_CONCURRENCY = 12;  // Reduced from 15 — crash cascades at 15 tabs
const DOMAIN_CHECK_TIMEOUT = 12000;
const META_API_DELAY_MS = 2000;      // Between keyword API calls (adaptive pacing for rate limits)
const MAX_ADS_PER_KEYWORD = 500;
const MAX_KEYWORDS = 10;

// Spam domain patterns — domains that are NEVER legitimate affiliates
const SPAM_DOMAIN_PATTERNS = [
  /^sex\./i, /\.sex$/i, /porn/i, /xxx/i, /adult/i,
  /spicygirl/i, /videochat/i, /dating\./i, /hookup/i,
  /casino/i, /gambling/i, /lottery/i, /slots\./i,
  /malware/i, /phishing/i,
];

// Spam page name patterns — ad-farm pages with random alphanumeric names
const SPAM_PAGE_NAME_PATTERNS = [
  /^[A-Z][a-z]+ [A-Z]\d+ \d{4}/,   // "Corpus D36 0204-2", "Cc 0203 I5"
  /^[A-Z]{2,4} [a-z]\d{2,} \d{4}/,  // "LYF b99 0202-1"
  /\d{4}-\d+$/,                       // Ends with "0204-2"
  /^Feel my [A-Z] CUP/i,             // "Feel my G CUP 0202 C3"
];

/**
 * Check if a domain looks like spam
 */
function isSpamDomain(domain: string): boolean {
  return SPAM_DOMAIN_PATTERNS.some(p => p.test(domain));
}

/**
 * Check if a page name looks like an ad-farm/spam page
 */
function isSpamPageName(pageName: string): boolean {
  return SPAM_PAGE_NAME_PATTERNS.some(p => p.test(pageName));
}

interface DiscoveryOptions {
  country?: string;
  countries?: string[];
  keywords?: string[];
  max_keyword_ads?: number;
  max_keywords?: number;
  max_brand_ads?: number;      // Limit for brand search + domain search (default 1100)
  max_domains_to_check?: number; // Max domains to brand-check in Step 6 (default 20)
  use_headless?: boolean;
  use_headless_for_domains?: boolean; // Headless for domain checks (default: false in edge fn)
  page_id?: string;            // Facebook page_id — fetch ads directly from this page (skip keyword guessing)
  deep_cta_enabled?: boolean;  // Enable deep CTA chain following (Worker-only, default: false)
  access_token?: string;          // Single token (backward compat for Edge Functions)
  access_tokens?: string[];       // Multiple tokens for rotation (Worker)
  openai_key?: string;         // For AI keyword refinement
  timeout_ms?: number;
  onProgress?: (step: string, detail: string) => void;
  // Checkpoint/Resume support (Worker-only)
  supabase?: any;              // SupabaseClient for caching intermediate results
  onCheckpoint?: (data: { step: string; detail: string; matches_so_far?: number }) => void;
  resumeCheckpoint?: Record<string, unknown> | null; // Skip completed steps on resume
}

// ============================================
// Main Pipeline
// ============================================

/**
 * Run the complete brand discovery pipeline.
 * This is the main entry point — orchestrates all 7 steps.
 */
export async function discoverBrand(
  brandName: string,
  options: DiscoveryOptions
): Promise<BrandDiscoveryResponse> {
  const startTime = Date.now();
  const hasDeadline = options.timeout_ms !== 0; // 0 = no deadline (worker mode)
  const deadline = hasDeadline ? Date.now() + (options.timeout_ms || 55000) : Infinity;
  const progress = options.onProgress || (() => {});
  const countries = options.countries || [options.country || 'DE'];
  const maxDomainsToCheck = options.max_domains_to_check || 20; // 0 handled below
  const useHeadlessForDomains = options.use_headless_for_domains ?? false; // Off by default in edge fn

  /** Check if we're past the deadline (with buffer). Returns false if no deadline (worker mode). */
  function pastDeadline(bufferMs = 5000): boolean {
    if (!hasDeadline) return false;
    return Date.now() > (deadline - bufferMs);
  }

  const tokens = options.access_tokens || (options.access_token ? [options.access_token] : []);
  const metaClient = new MetaAdLibraryClient({
    access_tokens: tokens,
    wait_for_rate_limit: !hasDeadline, // Worker mode: wait forever on rate limits; Edge Function: throw after 3 rounds
  });

  const detectionMethods: Record<string, number> = {};

  try {
    // ================================================
    // STEP 2: Find brand's own shop domain
    // ================================================
    console.log(`[Discovery] ═══ STEP 2: Find Brand Domain ═══`);
    progress('step2', `Searching Meta API for "${brandName}"...`);

    // Fetch brand ads ONCE — used for Steps 2, 2b, and 3
    const brandSearchLimit = options.max_brand_ads ? Math.min(options.max_brand_ads, 300) : 300;
    let brandAds: MetaAd[];

    if (options.page_id) {
      // page_id known (from Light Pipeline) → fetch ads directly from this page
      // No keyword guessing needed — this gives us ONLY ads from the official page
      console.log(`[Discovery] Fetching ads directly from page ${options.page_id} (page_id provided)`);
      brandAds = await metaClient.fetchAllAdsFromPage({
        page_id: options.page_id,
        ad_reached_countries: countries,
        max_results: brandSearchLimit,
      });
    } else {
      // Fallback: keyword search (when no page_id available)
      console.log(`[Discovery] No page_id provided — falling back to keyword search`);
      brandAds = await metaClient.fetchAllAds({
        search_terms: brandName,
        ad_reached_countries: countries,
        search_type: 'KEYWORD_EXACT_PHRASE',
        max_results: brandSearchLimit,
      });
    }

    const brandInfo = await findBrandDomain(brandName, brandAds, options.page_id);

    if (!brandInfo.brand_domain) {
      return makeErrorResponse(brandName, 'Could not find brand domain from Meta ads');
    }

    console.log(`[Discovery] Brand domain: ${brandInfo.brand_domain} | Platform: ${brandInfo.platform} | Vendor: ${brandInfo.vendor_name || 'unknown'}`);
    console.log(`[Discovery] Official pages: ${brandInfo.official_page_ids?.length || 0}`);
    console.log(`[Discovery] Aliases: ${brandInfo.brand_aliases.join(', ')}`);
    progress('step2', `Found brand domain: ${brandInfo.brand_domain} (${brandInfo.platform || 'unknown'})`);

    // Cache brand ads in page_ad_cache (same format as brand-search edge fn)
    // → "Ads laden" in frontend loads instantly from cache
    // Use the OFFICIAL page ID (not first ad's page) — this must match what brand-search returns
    if (options.supabase && brandAds.length > 0 && brandInfo.official_page_ids.length > 0) {
      const pageId = brandInfo.official_page_ids[0];
      const pageName = brandAds.find(a => a.page_id === pageId)?.page_name || brandName;
      const countryKey = [...countries].sort().join(',');

      // Filter to official page ads only — matches what brand-search edge fn returns
      const officialAds = brandAds.filter(ad => ad.page_id === pageId);
      const processedAds: ProcessedAd[] = officialAds.map(ad => {
        const caption = ad.ad_creative_link_captions?.[0] || null;
        return {
          id: ad.id,
          creative_url: ad.ad_snapshot_url || null,
          primary_text: ad.ad_creative_bodies?.[0] || null,
          headline: ad.ad_creative_link_titles?.[0] || null,
          description: ad.ad_creative_link_descriptions?.[0] || null,
          start_date: ad.ad_delivery_start_time || null,
          status: (ad.ad_delivery_stop_time ? 'inactive' : 'active') as 'active' | 'inactive',
          landing_page_url: extractFullUrlFromCaption(caption),
          landing_page_domain: extractDomainFromCaption(caption),
          reach: ad.eu_total_reach || null,
          reach_formatted: formatReach(ad.eu_total_reach),
          page_id: ad.page_id || null,
          page_name: ad.page_name || null,
          platforms: ad.publisher_platforms || [],
          languages: ad.languages || [],
        };
      });
      processedAds.sort((a, b) => (b.reach || 0) - (a.reach || 0));

      const allCaptions = officialAds.flatMap(ad => ad.ad_creative_link_captions || []);
      const domains = extractDomainsFromCaptions(allCaptions);

      // Aggregate demographics from official page ads only
      const demographics = aggregateDemographicsFromAds(officialAds);

      await options.supabase.from('page_ad_cache').upsert({
        page_id: pageId,
        page_name: pageName,
        country: countryKey,
        total_ads: officialAds.length,
        data: {
          success: true,
          brand: pageName,
          total_ads: processedAds.length,
          pages: {
            official: [{ page_id: pageId, page_name: pageName, ad_count: brandAds.length, is_official: true }],
            third_party: [],
          },
          domains,
          ads: processedAds,
          demographics,
        },
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(), // 90 days
      }, { onConflict: 'page_id,country' });

      console.log(`[Discovery] Cached ${officialAds.length} official brand ads in page_ad_cache (page ${pageId}, total found: ${brandAds.length})`);
    }

    // Inter-step delay: Let rate limit budget recover before more API calls
    await delay(3000);

    // ================================================
    // STEP 2a: Search for brand DOMAIN as keyword (KEYWORD_UNORDERED)
    // Uses KEYWORD_UNORDERED like the frontend page-search does.
    // This finds third-party pages that mention the brand domain in their ad text.
    // E.g., "naturtreu.de" with UNORDERED matches ads containing "naturtreu" anywhere.
    // ================================================
    console.log(`[Discovery] ═══ STEP 2a: Domain Keyword Search ═══`);
    progress('step2a', `Searching for ads linking to "${brandInfo.brand_domain}"...`);

    const seenAdIds = new Set(brandAds.map(a => a.id));
    let newAdsCount = 0;

    // Search 1: Brand domain base (e.g., "naturtreu") with KEYWORD_UNORDERED
    // This is the most effective search — finds ALL ads mentioning the brand name.
    // Must be large enough to get past the official brand's own ads and find third-party ads.
    const domainBase = brandInfo.brand_domain.replace(/\.[a-z]+$/, ''); // "naturtreu.de" → "naturtreu"
    const domainSearchLimit = options.max_brand_ads ? Math.min(options.max_brand_ads, 400) : 400;
    const domainBaseAds = await metaClient.fetchAllAds({
      search_terms: domainBase,
      ad_reached_countries: countries,
      search_type: 'KEYWORD_UNORDERED',
      max_results: domainSearchLimit,
    });

    for (const ad of domainBaseAds) {
      if (!seenAdIds.has(ad.id)) {
        brandAds.push(ad);
        seenAdIds.add(ad.id);
        newAdsCount++;
      }
    }
    console.log(`[Discovery] Domain base search "${domainBase}" (UNORDERED): ${domainBaseAds.length} ads, ${newAdsCount} new`);

    // Search 2: Full domain (e.g., "naturtreu.de") with KEYWORD_UNORDERED
    // Some ads mention the domain literally in their text — skip if short on time
    let domainNewCount = 0;
    if (!pastDeadline(40000)) { // Only if >40s remaining
      const domainAds = await metaClient.fetchAllAds({
        search_terms: brandInfo.brand_domain,
        ad_reached_countries: countries,
        search_type: 'KEYWORD_UNORDERED',
        max_results: 200,
      });

      for (const ad of domainAds) {
        if (!seenAdIds.has(ad.id)) {
          brandAds.push(ad);
          seenAdIds.add(ad.id);
          domainNewCount++;
          newAdsCount++;
        }
      }
      console.log(`[Discovery] Domain search "${brandInfo.brand_domain}" (UNORDERED): ${domainAds.length} ads, ${domainNewCount} new`);
    } else {
      console.log(`[Discovery] Skipping full-domain search (${Math.round((Date.now() - startTime) / 1000)}s elapsed)`);
    }

    console.log(`[Discovery] Step 2a total: ${newAdsCount} new ads merged (brandAds total: ${brandAds.length})`);

    // Inter-step delay: Let rate limit budget recover
    await delay(3000);

    // ================================================
    // STEP 2b: Identify priority candidates from brand search
    // NOTE: This step does NOT create matches — only identifies domains
    // to prioritize in Step 6 (URL verification). ALL matches must
    // come from Step 6 verification. See CLAUDE.md rule.
    // ================================================
    console.log(`[Discovery] ═══ STEP 2b: Brand Search — Priority Candidates ═══`);
    progress('step2b', 'Analyzing brand search results for priority candidates...');

    const brandSearchResult = detectBrandSearchThirdParty(brandAds, brandInfo);
    const confirmedThirdPartyPageIds = brandSearchResult.confirmedThirdPartyPageIds;
    const priorityDomains = brandSearchResult.priorityDomains;

    console.log(`[Discovery] Priority candidate domains from brand search: ${priorityDomains.size}`);
    console.log(`[Discovery] Confirmed third-party pages (brand-domain-only): ${confirmedThirdPartyPageIds.size}`);
    if (confirmedThirdPartyPageIds.size > 0) {
      console.log(`[Discovery] Confirmed pages: ${[...confirmedThirdPartyPageIds.entries()].map(([id, name]) => `"${name}" (${id})`).join(', ')}`);
    }
    if (priorityDomains.size > 0) {
      console.log(`[Discovery] Priority domains: ${[...priorityDomains].join(', ')}`);
    }
    progress('step2b', `Found ${priorityDomains.size} priority candidates + ${confirmedThirdPartyPageIds.size} confirmed pages`);

    // ================================================
    // STEP 2c: Extract Ad Creative Previews (Worker-only)
    // Renders Facebook ad snapshots via local Chromium to extract
    // image/video URLs. Cached in ad_preview_cache for instant frontend display.
    // ================================================
    if (options.supabase && !hasDeadline) {  // Worker-only (no deadline = timeout_ms === 0)
      console.log(`[Discovery] ═══ STEP 2c: Extract Ad Creative Previews ═══`);
      progress('step2c', 'Extracting ad creative previews...');

      // Fetch ALL ads from the OFFICIAL page via search_page_ids (same as brand-search edge fn).
      // This serves TWO purposes:
      // 1. Update page_ad_cache with the COMPLETE ad set (not just keyword-search subset)
      // 2. Extract previews for the top 300 ads by reach
      const officialPageId = brandInfo.official_page_ids[0];
      let previewAds: MetaAd[] = [];
      if (officialPageId) {
        try {
          console.log(`[Discovery] Preview: Fetching ALL ads for official page ${officialPageId}...`);
          previewAds = await metaClient.fetchAllAdsFromPage({
            page_id: officialPageId,
            ad_reached_countries: [...countries],
            ad_active_status: 'ALL',
            max_results: 10000,  // Get ALL ads, same as brand-search edge fn
          });
          console.log(`[Discovery] Preview: Found ${previewAds.length} ads from official page`);

          // Update page_ad_cache with the COMPLETE ad set — this overwrites the
          // partial keyword-search data from Step 2 with the full set
          const countryKey = [...countries].sort().join(',');
          const pageName = previewAds[0]?.page_name || brandName;
          const fullProcessedAds: ProcessedAd[] = previewAds.map(ad => {
            const caption = ad.ad_creative_link_captions?.[0] || null;
            return {
              id: ad.id,
              creative_url: ad.ad_snapshot_url || null,
              primary_text: ad.ad_creative_bodies?.[0] || null,
              headline: ad.ad_creative_link_titles?.[0] || null,
              description: ad.ad_creative_link_descriptions?.[0] || null,
              start_date: ad.ad_delivery_start_time || null,
              status: (ad.ad_delivery_stop_time ? 'inactive' : 'active') as 'active' | 'inactive',
              landing_page_url: extractFullUrlFromCaption(caption),
              landing_page_domain: extractDomainFromCaption(caption),
              reach: ad.eu_total_reach || null,
              reach_formatted: formatReach(ad.eu_total_reach),
              page_id: ad.page_id || null,
              page_name: ad.page_name || null,
              platforms: ad.publisher_platforms || [],
              languages: ad.languages || [],
            };
          });
          fullProcessedAds.sort((a, b) => (b.reach || 0) - (a.reach || 0));

          const allCaptions = previewAds.flatMap(ad => ad.ad_creative_link_captions || []);
          const domains = extractDomainsFromCaptions(allCaptions);
          const demographics = aggregateDemographicsFromAds(previewAds);

          await options.supabase.from('page_ad_cache').upsert({
            page_id: officialPageId,
            page_name: pageName,
            country: countryKey,
            total_ads: previewAds.length,
            data: {
              success: true,
              brand: pageName,
              total_ads: fullProcessedAds.length,
              pages: {
                official: [{ page_id: officialPageId, page_name: pageName, ad_count: previewAds.length, is_official: true }],
                third_party: [],
              },
              domains,
              ads: fullProcessedAds,
              demographics,
            },
            created_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(), // 90 days
          }, { onConflict: 'page_id,country' });

          console.log(`[Discovery] Preview: Updated page_ad_cache with ${previewAds.length} complete ads (was ~${brandAds.filter(a => a.page_id === officialPageId).length} from keyword search)`);
        } catch (e) {
          console.log(`[Discovery] Preview: Failed to fetch page ads, using brandAds fallback: ${e}`);
          previewAds = brandAds.filter(ad => ad.page_id === officialPageId);
        }
      }
      // Build preview list: Top 100 by reach + 100 newest by date (deduped)
      // This fills both "Top Ads" and "Neueste" tabs in the dashboard
      const withSnapshot = previewAds.filter(ad => ad.ad_snapshot_url);
      const top100 = [...withSnapshot]
        .sort((a, b) => (b.eu_total_reach || 0) - (a.eu_total_reach || 0))
        .slice(0, 100);
      const topIds = new Set(top100.map(a => a.id));
      const newest100 = [...withSnapshot]
        .sort((a, b) => {
          if (!a.ad_delivery_start_time) return 1;
          if (!b.ad_delivery_start_time) return -1;
          return new Date(b.ad_delivery_start_time).getTime() - new Date(a.ad_delivery_start_time).getTime();
        })
        .filter(a => !topIds.has(a.id))
        .slice(0, 100);
      const adsWithSnapshot = [...top100, ...newest100];

      if (adsWithSnapshot.length > 0) {
        // Check which are already cached
        const { data: cached } = await options.supabase
          .from('ad_preview_cache')
          .select('ad_id')
          .in('ad_id', adsWithSnapshot.map((a: MetaAd) => a.id));
        const cachedIds = new Set((cached || []).map((c: any) => c.ad_id));

        const uncached = adsWithSnapshot.filter(a => !cachedIds.has(a.id));
        console.log(`[Discovery] Preview: ${adsWithSnapshot.length} ads with snapshots, ${cachedIds.size} cached, ${uncached.length} to extract`);

        if (uncached.length > 0) {
          const { BrowserRenderer } = await import('./browser-renderer.ts');
          const renderer = BrowserRenderer.getInstance();
          const previews: { ad_id: string; image_url: string | null; video_url: string | null; type: string }[] = [];
          const failedAds: typeof uncached = [];
          let savedCount = 0;  // Track how many previews have been flushed to DB

          // Timeout wrapper to prevent hanging on individual extractions
          const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
            Promise.race([
              promise,
              new Promise<T>((_, reject) => setTimeout(() => reject(new Error('Preview timeout')), ms)),
            ]);

          // Process 1 at a time — concurrent FB snapshot tabs crash Chromium
          // (Facebook's heavy React DOM + image loading causes "frame detached" cascades)
          const PREVIEW_CONCURRENCY = 1;
          for (let i = 0; i < uncached.length; i += PREVIEW_CONCURRENCY) {
            const chunk = uncached.slice(i, i + PREVIEW_CONCURRENCY);
            const results = await Promise.allSettled(
              chunk.map(async (ad) => {
                const result = await withTimeout(renderer.extractAdPreview(ad.ad_snapshot_url!), 25000);
                return { ad_id: ad.id, ...result };
              })
            );

            for (let j = 0; j < results.length; j++) {
              const r = results[j];
              if (r.status === 'fulfilled' && r.value.type !== 'unknown') {
                previews.push(r.value);
              } else {
                // Both rejected (timeout) and fulfilled-but-unknown (crash) count as failed
                failedAds.push(chunk[j]);
              }
            }

            // If entire chunk failed (crash cascade), wait for browser recovery
            const chunkSuccesses = results.filter(r => r.status === 'fulfilled' && r.value.type !== 'unknown').length;
            if (chunkSuccesses === 0 && chunk.length > 1) {
              console.log(`[Discovery] Preview: Entire chunk failed, waiting 5s for browser recovery...`);
              await new Promise(r => setTimeout(r, 5000));
            }

            // Save to DB progressively every 10 ads — previews appear in dashboard immediately
            if (i % 10 === 0 || i + PREVIEW_CONCURRENCY >= uncached.length) {
              progress('step2c', `Previews: ${previews.length} extracted (${Math.min(i + PREVIEW_CONCURRENCY, uncached.length)}/${uncached.length})`);
              // Flush unsaved previews to DB
              const unsaved = previews.slice(savedCount);
              if (unsaved.length > 0) {
                await options.supabase.from('ad_preview_cache').upsert(
                  unsaved.map(p => ({
                    ad_id: p.ad_id,
                    brand: brandName,
                    image_url: p.image_url,
                    video_url: p.video_url,
                    media_type: p.type,
                  }))
                );
                savedCount = previews.length;
              }
            }
          }

          // Retry failed extractions once (single concurrency for stability)
          if (failedAds.length > 0 && failedAds.length <= 50) {
            console.log(`[Discovery] Preview: Retrying ${failedAds.length} failed extractions...`);
            for (const ad of failedAds) {
              try {
                const result = await withTimeout(renderer.extractAdPreview(ad.ad_snapshot_url!), 25000);
                if (result.type !== 'unknown') {
                  previews.push({ ad_id: ad.id, ...result });
                }
              } catch {
                // Give up on this ad — ScrapingBee will try next
              }
            }
          }

          // ScrapingBee fallback for STILL-failed ads (after local retry)
          const stillFailed = failedAds.filter(ad => !previews.some(p => p.ad_id === ad.id));
          if (stillFailed.length > 0) {
            console.log(`[Discovery] Preview: ScrapingBee fallback for ${stillFailed.length} remaining failures...`);
            progress('step2c', `ScrapingBee fallback: ${stillFailed.length} remaining...`);

            const { scrapeAdPreviewWithScrapingBee } = await import('./headless-scraper.ts');
            // Process 3 at a time (ScrapingBee handles concurrency server-side)
            for (let i = 0; i < stillFailed.length; i += 3) {
              const chunk = stillFailed.slice(i, i + 3);
              const results = await Promise.allSettled(
                chunk.map(ad => scrapeAdPreviewWithScrapingBee(ad.ad_snapshot_url!, ad.id))
              );
              for (let j = 0; j < results.length; j++) {
                const r = results[j];
                if (r.status === 'fulfilled' && r.value.type !== 'unknown') {
                  previews.push({ ad_id: chunk[j].id, ...r.value });
                }
              }
              if (i % 9 === 0) {
                progress('step2c', `ScrapingBee: ${Math.min(i + 3, stillFailed.length)}/${stillFailed.length}`);
              }
            }
            console.log(`[Discovery] Preview: After ScrapingBee, total ${previews.length} previews`);
          }

          // Final flush — save any remaining unsaved previews (from retries + ScrapingBee)
          const finalUnsaved = previews.slice(savedCount);
          if (finalUnsaved.length > 0) {
            await options.supabase.from('ad_preview_cache').upsert(
              finalUnsaved.map(p => ({
                ad_id: p.ad_id,
                brand: brandName,
                image_url: p.image_url,
                video_url: p.video_url,
                media_type: p.type,
              }))
            );
          }

          console.log(`[Discovery] Preview: Cached ${previews.length}/${uncached.length} ad previews (${failedAds.length} failed)`);
          progress('step2c', `Cached ${previews.length}/${uncached.length} ad previews`);
        } else {
          console.log(`[Discovery] Preview: All ${adsWithSnapshot.length} already cached, skipping`);
          progress('step2c', `All ${adsWithSnapshot.length} previews already cached`);
        }
      } else {
        console.log(`[Discovery] Preview: No ads with snapshot URLs, skipping`);
      }
    }

    // Inter-step delay: Let rate limit budget recover before keyword searches
    await delay(3000);

    // ================================================
    // STEP 3: Auto-generate product keywords (reuse brandAds)
    // ================================================
    console.log(`[Discovery] ═══ STEP 3: Generate Keywords ═══`);
    progress('step3', 'Generating product keywords from brand ads...');

    // Merge user-provided keywords with auto-generated ones
    const effectiveMaxKeywords = options.max_keywords || MAX_KEYWORDS;
    const keywordResult = generateKeywords(brandAds, brandName, effectiveMaxKeywords * 3); // Get more candidates for AI
    const userKeywords = options.keywords || [];

    // Try AI refinement first (much better keyword quality) — skip if short on time
    let aiKeywords: string[] | null = null;
    if (options.openai_key && keywordResult.keywords.length > 0 && !pastDeadline(35000)) {
      progress('step3', 'Refining keywords with AI...');
      const officialPageName = brandInfo.official_page_ids.length > 0
        ? brandAds.find(a => a.page_id === brandInfo.official_page_ids[0])?.page_name || brandName
        : brandName;
      try {
        const aiResult = await refineKeywordsWithAI(
          keywordResult.keywords,
          brandName,
          officialPageName,
          effectiveMaxKeywords,
          options.openai_key
        );
        if (aiResult) {
          aiKeywords = aiResult.keywords;
          if (aiResult.brand_category) {
            brandInfo.brand_category = aiResult.brand_category;
            console.log(`[Discovery] Brand category: "${aiResult.brand_category}"`);
          }
          console.log(`[Discovery] AI keywords: ${JSON.stringify(aiKeywords)} (refined from ${keywordResult.keywords.length} candidates)`);
        }
      } catch (e) {
        console.log(`[Discovery] AI keyword refinement failed: ${e}`);
      }
    } else if (options.openai_key) {
      console.log(`[Discovery] Skipping AI keyword refinement (${Math.round((Date.now() - startTime) / 1000)}s elapsed)`);
    }

    // Use AI keywords if available, fallback to raw extraction
    const baseKeywords = aiKeywords || keywordResult.keywords.slice(0, effectiveMaxKeywords);
    const allKeywords = [...new Set([...userKeywords, ...baseKeywords])].slice(0, effectiveMaxKeywords);

    if (allKeywords.length === 0) {
      progress('step3', 'No keywords found, using brand name only');
      allKeywords.push(brandName);
    }

    console.log(`[Discovery] Keywords (${allKeywords.length}): ${JSON.stringify(allKeywords)}${aiKeywords ? ' [AI-refined]' : ' [raw extraction]'}`);
    progress('step3', `Keywords: ${allKeywords.join(', ')}${aiKeywords ? ' (AI)' : ''}`);

    // ================================================
    // STEP 4: Search ALL advertisers by keyword
    // ================================================
    console.log(`[Discovery] ═══ STEP 4: Search All Advertisers ═══`);
    progress('step4', `Searching ${allKeywords.length} keywords across all advertisers...`);

    const allAds = await searchAllAdsForKeywords(
      allKeywords,
      metaClient,
      countries,
      options.max_keyword_ads || MAX_ADS_PER_KEYWORD
    );

    // Count unique pages
    const uniquePageSet = new Set<string>();
    for (const ad of allAds) {
      if (ad.page_id) uniquePageSet.add(ad.page_id);
    }
    console.log(`[Discovery] Total after dedup: ${allAds.length} ads from ${uniquePageSet.size} pages`);
    progress('step4', `Found ${allAds.length} total ads from keyword searches`);

    // ================================================
    // STEP 5: Extract unique domains + page mapping
    // ================================================
    console.log(`[Discovery] ═══ STEP 5: Extract Domains ═══`);
    progress('step5', 'Extracting unique domains and pages...');

    // CRITICAL: Combine brandAds + keyword ads before domain extraction.
    // Without this, third-party domains found via brand name search (Step 2/2a)
    // would be missed if they don't appear in keyword search results.
    const combinedAdsMap = new Map<string, MetaAd>();
    for (const ad of brandAds) combinedAdsMap.set(ad.id, ad);
    for (const ad of allAds) combinedAdsMap.set(ad.id, ad);
    const allCombinedAds = [...combinedAdsMap.values()];
    console.log(`[Discovery] Combined ads: ${brandAds.length} brand + ${allAds.length} keyword = ${allCombinedAds.length} unique`);

    const { domainPageMap, domainAdCount, allPages, domainFullUrls } = extractUniqueDomains(
      allCombinedAds,
      brandInfo
    );

    // ================================================
    // STEP 5b: Resolve confirmed third-party pages from Step 2b
    // Pages that ran ads linking TO brand domain → find their OWN domains
    // and add to priority list for Step 6 verification
    // ================================================
    if (confirmedThirdPartyPageIds.size > 0) {
      console.log(`[Discovery] ═══ STEP 5b: Resolve Confirmed Third-Party Page Domains ═══`);

      // Build reverse map: pageId → domains (from keyword search ads)
      const pageIdToDomains = new Map<string, Set<string>>();
      for (const ad of allAds) {
        if (!ad.page_id || !confirmedThirdPartyPageIds.has(ad.page_id)) continue;
        if (ad.ad_creative_link_captions) {
          for (const caption of ad.ad_creative_link_captions) {
            const domain = extractDomainFromCaption(caption);
            if (!domain) continue;
            const d = domain.toLowerCase();
            // Skip brand domain and platform domains
            if (d === brandInfo.brand_domain?.toLowerCase()) continue;
            if (brandInfo.brand_aliases.some(alias => {
              const normalized = alias.replace(/[\s\-_.]+/g, '');
              return normalized.length >= 3 && d.includes(normalized);
            })) continue;
            if (!pageIdToDomains.has(ad.page_id)) {
              pageIdToDomains.set(ad.page_id, new Set());
            }
            pageIdToDomains.get(ad.page_id)!.add(d);
          }
        }
      }

      // Add resolved domains to priority list for Step 6 verification
      for (const [pageId, pageName] of confirmedThirdPartyPageIds) {
        const domains = pageIdToDomains.get(pageId);
        if (domains && domains.size > 0) {
          for (const domain of domains) {
            if (isSpamDomain(domain)) {
              console.log(`[Discovery] Step 5b: Page "${pageName}" → domain ${domain} → SKIP (spam domain)`);
              continue;
            }
            priorityDomains.add(domain);
            console.log(`[Discovery] Step 5b: Page "${pageName}" → resolved domain: ${domain} → PRIORITY CANDIDATE for Step 6`);
          }
        } else {
          console.log(`[Discovery] Step 5b: Page "${pageName}" → no non-brand domain found in keyword ads`);
        }
      }
      console.log(`[Discovery] Step 5b: ${priorityDomains.size} total priority domains after page resolution`);
    }

    // ================================================
    // STEP 5c: Cross-reference — pages linking to BOTH brand + non-brand domains
    // A page that links to naturtreu.de AND thehealingmagazine.com → priority candidate
    // These domains are prioritized in Step 6 but NOT auto-matched.
    // ================================================
    console.log(`[Discovery] ═══ STEP 5c: Cross-Reference Page Domains ═══`);
    {
      const brandDomain = brandInfo.brand_domain!.toLowerCase();
      const pageDomainMap2 = new Map<string, { name: string; domains: Set<string> }>();

      for (const ad of allAds) {
        if (!ad.page_id) continue;
        if (brandInfo.official_page_ids.includes(ad.page_id)) continue;
        if (ad.ad_creative_link_captions) {
          for (const caption of ad.ad_creative_link_captions) {
            const domain = extractDomainFromCaption(caption);
            if (!domain) continue;
            if (!pageDomainMap2.has(ad.page_id)) {
              pageDomainMap2.set(ad.page_id, { name: ad.page_name || 'Unknown', domains: new Set() });
            }
            pageDomainMap2.get(ad.page_id)!.domains.add(domain.toLowerCase());
          }
        }
      }

      let crossRefCount = 0;
      for (const [pageId, { name, domains }] of pageDomainMap2) {
        // Check if this page links to the brand domain
        const hasBrandDomain = [...domains].some(d => {
          if (d === brandDomain) return true;
          return brandInfo.brand_aliases.some(alias => {
            const normalized = alias.replace(/[\s\-_.]+/g, '');
            return normalized.length >= 3 && d.includes(normalized);
          });
        });

        if (!hasBrandDomain) continue;

        // Page links to brand domain — find its non-brand domains → priority for Step 6
        const nonBrandDomains = [...domains].filter(d => {
          if (d === brandDomain) return false;
          return !brandInfo.brand_aliases.some(alias => {
            const normalized = alias.replace(/[\s\-_.]+/g, '');
            return normalized.length >= 3 && d.includes(normalized);
          });
        });

        for (const domain of nonBrandDomains) {
          if (isSpamDomain(domain)) {
            console.log(`[Discovery] Step 5c: Page "${name}" → domain ${domain} → SKIP (spam domain)`);
            continue;
          }
          priorityDomains.add(domain);
          crossRefCount++;
          console.log(`[Discovery] Step 5c: Page "${name}" links to BOTH ${brandDomain} AND ${domain} → PRIORITY CANDIDATE for Step 6`);
        }
      }
      console.log(`[Discovery] Step 5c: Found ${crossRefCount} additional priority candidates via cross-reference`);
    }

    // ALL domains go through Step 6 verification — no bypassing
    let thirdPartyDomains = [...domainPageMap.keys()];
    console.log(`[Discovery] ${thirdPartyDomains.length} unique third-party domains to check (${priorityDomains.size} are priority candidates)`);

    // Sort: priority domains first (from brand search signals), then by ad count
    thirdPartyDomains.sort((a, b) => {
      const aPriority = priorityDomains.has(a.toLowerCase()) ? 1 : 0;
      const bPriority = priorityDomains.has(b.toLowerCase()) ? 1 : 0;
      if (aPriority !== bPriority) return bPriority - aPriority;
      return (domainAdCount.get(b) || 0) - (domainAdCount.get(a) || 0);
    });

    // Limit domains to check to prevent timeout (0 = unlimited, for worker mode)
    if (options.max_domains_to_check !== 0 && thirdPartyDomains.length > maxDomainsToCheck) {
      const skippedDomains = thirdPartyDomains.length - maxDomainsToCheck;
      thirdPartyDomains = thirdPartyDomains.slice(0, maxDomainsToCheck);
      console.log(`[Discovery] Limited to top ${maxDomainsToCheck} domains (priority first, then by ad count, skipped ${skippedDomains})`);
    }

    progress('step5', `Found ${thirdPartyDomains.length} third-party domains from ${allPages.size} pages`);

    // ================================================
    // STEP 5d: Build domain→ads map for Step 6f/6g
    // ================================================
    const domainToAds = new Map<string, MetaAd[]>();
    for (const ad of allCombinedAds) {
      if (ad.ad_creative_link_captions) {
        for (const caption of ad.ad_creative_link_captions) {
          const d = extractDomainFromCaption(caption)?.toLowerCase();
          if (d && domainPageMap.has(d)) {
            if (!domainToAds.has(d)) domainToAds.set(d, []);
            domainToAds.get(d)!.push(ad);
          }
        }
      }
    }
    console.log(`[Discovery] Built domain→ads map: ${domainToAds.size} domains with ad data`);

    // ================================================
    // STEP 5e: Extract REAL landing page URLs from ad snapshots
    // Meta captions only give domains (e.g., "lanuvi.com"), NOT full URLs.
    // The ad_snapshot_url is a Facebook JS-rendered page — needs headless browser.
    // We extract the actual landing page URL so Steps 6d/6f can check
    // the correct pages instead of just the homepage.
    //
    // CHECKPOINT: Uses full_url_cache table to persist results. On resume after crash,
    // already-extracted URLs are loaded from cache (no re-render needed).
    // ================================================
    // Check if we can skip Step 5e (resume from checkpoint)
    const checkpoint = options.resumeCheckpoint;
    const resumeFromStep6 = checkpoint?.step === '5e_done' || checkpoint?.step === 'step6';

    if (resumeFromStep6 && options.supabase) {
      // RESUME: Load cached URLs instead of re-rendering all snapshots
      console.log(`[Discovery] ═══ STEP 5e: SKIPPING (checkpoint: ${checkpoint!.step}) — loading URLs from cache ═══`);
      progress('step5e', 'Loading cached URLs (resume from checkpoint)...');

      let loadedUrlCount = 0;
      for (const domain of thirdPartyDomains) {
        try {
          const { data: cachedUrls } = await options.supabase
            .from('full_url_cache')
            .select('domain, extracted_url, final_url')
            .ilike('domain', domain)
            .gt('expires_at', new Date().toISOString());

          if (cachedUrls?.length) {
            const urlMap = new Map<string, number>();
            for (const row of cachedUrls) {
              const url = row.final_url || row.extracted_url;
              if (url) urlMap.set(url, (urlMap.get(url) || 0) + 1);
            }
            if (urlMap.size > 0) {
              domainFullUrls.set(domain.toLowerCase(), urlMap);
              loadedUrlCount += urlMap.size;
            }
          }
        } catch { /* skip domain on error */ }
      }
      console.log(`[Discovery] Step 5e: Loaded ${loadedUrlCount} cached URLs for ${domainFullUrls.size} domains (skipped re-rendering)`);
      progress('step5e', `Loaded ${loadedUrlCount} cached URLs (checkpoint resume)`);

    } else if (!pastDeadline(20000)) {
      const useHeadlessFor5e = options.use_headless !== false;
      console.log(`[Discovery] ═══ STEP 5e: Extract Landing Page URLs from Ad Snapshots (local headless) ═══`);
      progress('step5e', 'Extracting real landing page URLs from ad snapshots...');

      // Limit domains: headless rendering takes 5-15s each
      // Edge function: max 6 domains (~20s for 2 batches of 3), leaves time for Step 6
      // Worker (timeout_ms=0): ALL domains (deep CTA needs exact landing page URLs)
      const maxEnrich = useHeadlessFor5e
        ? (options.timeout_ms === 0 ? thirdPartyDomains.length : 6) // Worker: ALL, Edge fn: 6
        : Math.min(maxDomainsToCheck || 15, 20);
      const domainsToEnrich = thirdPartyDomains.slice(0, maxEnrich);
      let enriched = 0;
      let enrichFailed = 0;
      let enrichCacheHits = 0;
      const ENRICH_CONCURRENCY = 12;  // Reduced from 15 — crash cascades at 15 tabs

      console.log(`[Discovery] Step 5e: Enriching ${domainsToEnrich.length} domains (concurrent pool, ${ENRICH_CONCURRENCY} parallel)`);

      // Concurrent pool: keeps ENRICH_CONCURRENCY tasks in-flight at all times.
      // Unlike batch-based Promise.all, this starts new domains immediately as each finishes.
      const enrichPool = new Map<number, Promise<number>>();
      let nextEnrichIdx = 0;
      let enrichTimeoutHit = false;
      let lastEnrichProgress = Date.now();

      while (nextEnrichIdx < domainsToEnrich.length || enrichPool.size > 0) {
        if (!enrichTimeoutHit && pastDeadline(15000)) {
          console.log(`[Discovery] Step 5e: Stopping URL extraction (${Math.round((Date.now() - startTime) / 1000)}s elapsed)`);
          enrichTimeoutHit = true;
        }

        // Fill pool up to concurrency limit
        while (!enrichTimeoutHit && enrichPool.size < ENRICH_CONCURRENCY && nextEnrichIdx < domainsToEnrich.length) {
          const idx = nextEnrichIdx++;
          const domain = domainsToEnrich[idx];

          // CRITICAL: Outer try-catch prevents a single crash from breaking the entire pool.
          // Without this, Promise.race() propagates the error and kills the while-loop.
          const task = (async () => {
            try {
              const domainLower = domain.toLowerCase();
              const ads = domainToAds.get(domainLower);
              if (!ads || ads.length === 0) return idx;

              // Find ads with snapshot URLs
              // Worker mode: up to 10 unique snapshots per domain for comprehensive coverage
              // Edge fn: 2 per domain (fast)
              const maxSnapshotsPerDomain = options.timeout_ms === 0 ? 10 : 2;
              const adsWithSnapshot = ads.filter(a => a.ad_snapshot_url)
                .filter((ad, i, arr) => arr.findIndex(a => a.ad_snapshot_url === ad.ad_snapshot_url) === i) // Dedup snapshots
                .slice(0, maxSnapshotsPerDomain);
              if (adsWithSnapshot.length === 0) return idx;

              for (const ad of adsWithSnapshot) {
                try {
                  let extractedUrl: string | null = null;

                  // CHECKPOINT: Check full_url_cache first (avoids re-rendering on resume)
                  if (options.supabase) {
                    try {
                      const { data: cached } = await options.supabase
                        .from('full_url_cache')
                        .select('extracted_url, final_url')
                        .eq('ad_id', ad.id)
                        .gt('expires_at', new Date().toISOString())
                        .maybeSingle();
                      if (cached?.extracted_url || cached?.final_url) {
                        extractedUrl = cached.final_url || cached.extracted_url;
                        enrichCacheHits++;
                        console.log(`[Discovery] Step 5e: ${domain} → CACHED → ${extractedUrl}`);
                      }
                    } catch { /* cache miss, will render */ }
                  }

                  // No cache hit — render the ad snapshot
                  if (!extractedUrl) {
                    if (useHeadlessFor5e) {
                      // Headless browser: renders Facebook's JS and extracts CTA link
                      const scrapeResult = await scrapeWithHeadless(
                        ad.ad_snapshot_url!,
                        undefined,
                        ad.id
                      );
                      if (scrapeResult.success) {
                        extractedUrl = scrapeResult.final_url || scrapeResult.url;
                        console.log(`[Discovery] Step 5e: ${domain} → rendered → ${extractedUrl}`);
                      } else {
                        console.log(`[Discovery] Step 5e: ${domain} → render failed: ${scrapeResult.error}`);
                      }
                    } else {
                      // Fallback: plain fetch (usually fails on Facebook's JS pages)
                      extractedUrl = await extractLandingPageUrl(ad.ad_snapshot_url!);
                    }

                    // CHECKPOINT: Save to full_url_cache for resume
                    if (options.supabase && ad.ad_snapshot_url) {
                      try {
                        const urlDomain = extractedUrl ? extractDomainFromUrl(extractedUrl) : null;
                        await options.supabase.from('full_url_cache').upsert({
                          ad_id: ad.id,
                          page_id: ad.page_id || null,
                          snapshot_url: ad.ad_snapshot_url,
                          domain: urlDomain || domainLower,
                          extracted_url: extractedUrl,
                          final_url: extractedUrl,
                          extraction_method: useHeadlessFor5e ? 'headless_browser' : 'html_parse',
                          confidence: extractedUrl ? 0.9 : 0,
                          scrape_success: !!extractedUrl,
                          scrape_error: extractedUrl ? null : 'extraction_failed',
                          expires_at: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(), // 90 days
                        }, { onConflict: 'ad_id' });
                      } catch (cacheErr) {
                        console.log(`[Discovery] Step 5e: Cache write error: ${String(cacheErr).substring(0, 80)}`);
                      }
                    }
                  }

                  if (extractedUrl) {
                    // Store in domainFullUrls for Steps 6d/6f/6g
                    if (!domainFullUrls.has(domainLower)) {
                      domainFullUrls.set(domainLower, new Map());
                    }
                    const urlMap = domainFullUrls.get(domainLower)!;
                    urlMap.set(extractedUrl, (urlMap.get(extractedUrl) || 0) + 1);
                    enriched++;

                    // Check if URL points to the brand domain directly
                    const urlDomain = extractDomainFromUrl(extractedUrl);
                    if (urlDomain && isDomainMatch(urlDomain, brandInfo)) {
                      console.log(`[Discovery] Step 5e: ${domain} → ad links DIRECTLY to brand ${urlDomain}!`);
                    }
                    if (options.timeout_ms !== 0) break; // Edge fn: one URL per domain is enough
                    // Worker mode: continue extracting more URLs per domain
                  } else {
                    console.log(`[Discovery] Step 5e: ${domain} → extraction returned null`);
                  }
                } catch (e) {
                  enrichFailed++;
                  console.log(`[Discovery] Step 5e: ${domain} → error: ${String(e)}`);
                }
              }
              return idx;
            } catch (poolError) {
              // Outer catch: prevents browser crash from killing entire pool via Promise.race
              enrichFailed++;
              console.log(`[Discovery] Step 5e: Pool task CRASHED for ${domain}: ${String(poolError).substring(0, 100)}`);
              return idx;
            }
          })();

          enrichPool.set(idx, task);
        }

        // Wait for at least one to complete, then remove from pool
        if (enrichPool.size > 0) {
          const completedIdx = await Promise.race(enrichPool.values());
          enrichPool.delete(completedIdx);

          // Periodic progress update every 30s to keep watchdog alive
          if (Date.now() - lastEnrichProgress > 30000) {
            const totalProcessed = enriched + enrichFailed;
            progress('step5e', `Enriching URLs: ${totalProcessed}/${domainsToEnrich.length} domains (${enrichCacheHits} cached)`);
            lastEnrichProgress = Date.now();
          }
        } else {
          break;
        }
      }

      console.log(`[Discovery] Step 5e: Extracted ${enriched} landing page URLs (${enrichFailed} failed, ${enrichCacheHits} from cache)`);
      progress('step5e', `Extracted ${enriched} landing page URLs (${enrichCacheHits} cached)`);
      if (options.onCheckpoint) {
        options.onCheckpoint({ step: '5e_done', detail: `${enriched} URLs extracted, ${enrichCacheHits} cached` });
      }
    } else {
      console.log(`[Discovery] Step 5e: SKIP (timeout approaching)`);
    }

    // ================================================
    // STEP 6: Brand-check each domain (THE CORE)
    // ================================================
    if (pastDeadline(10000)) {
      console.log(`[Discovery] WARNING: Only ${Math.round((deadline - Date.now()) / 1000)}s left, skipping domain checks entirely`);
      progress('step6', `Skipped domain checks (timeout)`);
      thirdPartyDomains = []; // Skip all domain checks
    }
    console.log(`[Discovery] ═══ STEP 6: Check Domains (${thirdPartyDomains.length}) ═══`);
    progress('step6', `Checking ${thirdPartyDomains.length} domains for brand match...`);

    const matchedDomains: DomainBrandCheck[] = [];
    const checkedCount = { current: 0, total: thirdPartyDomains.length };
    const debugDomainChecks: { domain: string; priority: boolean; result: string; urls?: string[] }[] = [];

    // Use headless only if explicitly enabled for domain checks
    const domainCheckHeadless = useHeadlessForDomains && options.use_headless;
    const domainCheckTimeout = domainCheckHeadless ? DOMAIN_CHECK_TIMEOUT : 8000;

    // Concurrent pool: keep DOMAIN_CHECK_CONCURRENCY domains in-flight at all times.
    // Unlike batch-based Promise.all, this starts new domains as soon as one finishes,
    // so browser slots stay utilized instead of waiting for slow batch stragglers.
    const pool = new Map<number, Promise<number>>();
    let nextDomainIdx = 0;
    let timeoutHit = false;

    while (nextDomainIdx < thirdPartyDomains.length || pool.size > 0) {
      if (!timeoutHit && pastDeadline(3000)) {
        console.log(`[Discovery] WARNING: Timeout approaching (${Math.round((Date.now() - startTime) / 1000)}s), skipping remaining ${thirdPartyDomains.length - nextDomainIdx} domain checks`);
        timeoutHit = true;
        // Don't enqueue new domains, but let in-flight ones finish
      }

      // Fill pool up to concurrency limit (unless timeout hit)
      while (!timeoutHit && pool.size < DOMAIN_CHECK_CONCURRENCY && nextDomainIdx < thirdPartyDomains.length) {
        const idx = nextDomainIdx++;
        const domain = thirdPartyDomains[idx];
        const pageIds = domainPageMap.get(domain) || [];
        const adCount = domainAdCount.get(domain) || 0;

        const task = (async () => {
          try {
            let check: DomainBrandCheck | null = null;

            // CHECKPOINT: Check domain_check_cache first (avoids re-checking on resume)
            if (options.supabase) {
              try {
                const { data: cached } = await options.supabase
                  .from('domain_check_cache')
                  .select('check_result')
                  .eq('brand', brandName.toLowerCase().trim())
                  .eq('domain', domain.toLowerCase())
                  .gt('expires_at', new Date().toISOString())
                  .maybeSingle();
                if (cached?.check_result) {
                  check = cached.check_result as DomainBrandCheck;
                  console.log(`[Discovery] Step 6: ${domain} → CACHED (${check.is_match ? check.match_type : 'no_match'})`);
                }
              } catch { /* cache miss, will check */ }
            }

            // No cache hit — run the actual domain check
            if (!check) {
              try {
                check = await checkDomainForBrand(domain, brandInfo, {
                  timeout: domainCheckTimeout,
                  use_headless: domainCheckHeadless,
                  deep_cta_enabled: options.deep_cta_enabled,
                  domainAds: domainToAds.get(domain.toLowerCase()),
                  domainFullUrls: domainFullUrls.get(domain.toLowerCase()),
                  openai_key: options.openai_key,
                });
              } catch (checkError) {
                console.log(`[Discovery] Step 6: ${domain} check CRASHED: ${String(checkError).substring(0, 150)}`);
                check = {
                  domain,
                  is_match: false,
                  match_type: 'none',
                  confidence: 0,
                  final_url: null,
                  redirect_chain: [],
                  shop_domain: null,
                  vendor_name: null,
                  page_ids: [],
                  ad_count: 0,
                };
              }

              // CHECKPOINT: Save to domain_check_cache for resume
              if (options.supabase) {
                try {
                  await options.supabase.from('domain_check_cache').upsert({
                    brand: brandName.toLowerCase().trim(),
                    domain: domain.toLowerCase(),
                    is_match: check.is_match,
                    match_type: check.match_type,
                    confidence: check.confidence,
                    check_result: check,
                    expires_at: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(), // 90 days
                  }, { onConflict: 'brand,domain' });
                } catch (cacheErr) {
                  console.log(`[Discovery] Step 6: Cache write error for ${domain}: ${String(cacheErr).substring(0, 80)}`);
                }
              }
            }

            check.page_ids = pageIds;
            check.ad_count = adCount;

            checkedCount.current++;
            const isPriority = priorityDomains.has(domain.toLowerCase());
            const domUrls = domainFullUrls.get(domain.toLowerCase());
            debugDomainChecks.push({
              domain,
              priority: isPriority,
              result: check.is_match ? `MATCH(${check.match_type},${check.confidence})` : 'NO_MATCH',
              urls: domUrls ? [...domUrls.keys()].slice(0, 3) : undefined,
            });

            if (check.is_match) {
              matchedDomains.push(check);
              detectionMethods[check.match_type] = (detectionMethods[check.match_type] || 0) + 1;
            }

            progress('step6', `Checked ${checkedCount.current}/${checkedCount.total} domains, ${matchedDomains.length} matches`);

            // CHECKPOINT: Notify worker of progress every 10 domains
            if (options.onCheckpoint && checkedCount.current % 10 === 0) {
              options.onCheckpoint({
                step: 'step6',
                detail: `${checkedCount.current}/${checkedCount.total} domains`,
                matches_so_far: matchedDomains.length,
              });
            }
          } catch (error) {
            console.log(`[Discovery] Pool error for ${domain}:`, error);
            checkedCount.current++;
          }
          return idx;
        })();

        pool.set(idx, task);
      }

      // Wait for at least one domain to complete, then remove it from pool
      if (pool.size > 0) {
        const completedIdx = await Promise.race(pool.values());
        pool.delete(completedIdx);
      } else {
        break;
      }
    }

    progress('step6', `Brand check complete: ${matchedDomains.length} matching domains`);

    // ================================================
    // STEP 7: Build result (only verified matches from Step 6)
    // ================================================
    console.log(`[Discovery] ═══ RESULTS ═══`);
    progress('step7', 'Building discovery result...');

    // ALL matches are URL-chain verified (no content_match).
    // Every match has been proven through redirect, CTA, checkout, or Shopify vendor check.
    const allMatches = matchedDomains;

    const scanDuration = Math.round((Date.now() - startTime) / 1000);

    // Collect third-party pages for logging
    const thirdPartyPagesForLog = new Set<string>();
    for (const match of allMatches) {
      for (const pageId of match.page_ids) {
        if (!brandInfo.official_page_ids.includes(pageId)) {
          thirdPartyPagesForLog.add(pageId);
        }
      }
    }

    console.log(`[Discovery] Total verified matches: ${allMatches.length} (all from Step 6 URL verification)`);
    console.log(`[Discovery] Methods: ${JSON.stringify(detectionMethods)}`);
    console.log(`[Discovery] Third-party pages: ${thirdPartyPagesForLog.size}`);
    console.log(`[Discovery] Duration: ${scanDuration}s`);

    const result = buildDiscoveryResult(
      brandName,
      brandInfo,
      allMatches,
      allAds,
      allPages,
      allKeywords,
      detectionMethods,
      startTime,
      thirdPartyDomains.length,
      brandAds,
      domainFullUrls
    );

    // Add debug info for troubleshooting
    (result as any).debug = {
      brand_aliases: brandInfo.brand_aliases,
      brand_ads_count: brandAds.length,
      keyword_ads_count: allAds.length,
      combined_ads_count: allCombinedAds.length,
      total_domains_found: domainPageMap.size,
      priority_domains_count: priorityDomains.size,
      priority_domains: [...priorityDomains].slice(0, 30),
      domains_checked: debugDomainChecks,
      domains_skipped_timeout: thirdPartyDomains.length - checkedCount.current,
    };

    return result;

  } catch (error) {
    console.error('[Discovery] Pipeline error:', error);
    return makeErrorResponse(brandName, String(error));
  }
}

// ============================================
// Step 2: Find Brand Domain
// ============================================

/**
 * Find the brand's official shop domain and Shopify info.
 * Accepts pre-fetched brand ads to avoid duplicate API calls.
 */
async function findBrandDomain(
  brandName: string,
  brandAds: MetaAd[],
  knownPageId?: string
): Promise<BrandInfo> {
  // Generate smart aliases from brand name
  const aliases = new Set<string>();
  const fullNameLower = brandName.toLowerCase().trim();
  aliases.add(fullNameLower);

  // Split at common separators: " - ", " – ", " | ", " · "
  const separators = [' - ', ' – ', ' | ', ' · ', ' — '];
  for (const sep of separators) {
    if (fullNameLower.includes(sep)) {
      const firstPart = fullNameLower.split(sep)[0].trim();
      if (firstPart.length >= 3) aliases.add(firstPart);
    }
  }

  // Also add the input without any subtitle (shortest meaningful part)
  const shortName = fullNameLower.replace(/\s*[-–|·—].*$/, '').trim();
  if (shortName.length >= 3) aliases.add(shortName);

  console.log(`[Discovery] Brand aliases: ${JSON.stringify([...aliases])}`);

  const info: BrandInfo = {
    brand_name: brandName,
    brand_domain: null,
    brand_aliases: [...aliases],
    shopify_store: null,
    vendor_name: null,
    platform: null,
    official_page_ids: [],
  };

  if (brandAds.length === 0) {
    console.log(`[Discovery] No ads found for brand "${brandName}"`);
    return info;
  }

  // Find official page(s)
  if (knownPageId) {
    // page_id provided → use it directly (no guessing)
    info.official_page_ids = [knownPageId];
    console.log(`[Discovery] Official page set from provided page_id: ${knownPageId}`);
  } else {
    // Fallback: match page_name against brand name
    const brandLower = brandName.toLowerCase();
    const pageMap = new Map<string, { name: string; count: number }>();

    for (const ad of brandAds) {
      if (ad.page_id && ad.page_name) {
        const existing = pageMap.get(ad.page_id);
        if (existing) {
          existing.count++;
        } else {
          pageMap.set(ad.page_id, { name: ad.page_name, count: 1 });
        }
      }
    }

    // Find pages that match brand name
    for (const [pageId, { name }] of pageMap) {
      if (name.toLowerCase().includes(brandLower) ||
          brandLower.includes(name.toLowerCase().replace(/\s+/g, ''))) {
        info.official_page_ids.push(pageId);
      }
    }

    // If no exact match, use the page with the most ads
    if (info.official_page_ids.length === 0 && pageMap.size > 0) {
      const sorted = [...pageMap.entries()].sort((a, b) => b[1].count - a[1].count);
      info.official_page_ids.push(sorted[0][0]);
    }
  }

  // Extract domain from ad captions
  const domains = new Map<string, number>();
  for (const ad of brandAds) {
    if (ad.ad_creative_link_captions) {
      for (const caption of ad.ad_creative_link_captions) {
        const domain = extractDomainFromCaption(caption);
        if (domain) {
          domains.set(domain, (domains.get(domain) || 0) + 1);
        }
      }
    }
  }

  // Find the brand's REAL domain — prefer domain containing brand name
  if (domains.size > 0) {
    const sorted = [...domains.entries()].sort((a, b) => b[1] - a[1]);

    // Strategy 1: Check if any domain contains the brand name (or alias)
    // e.g., brand "Vitafant" → prefer "vitafant.de" over "naturgesundcheck.com"
    const brandMatchDomain = sorted.find(([domain]) => {
      const domBase = domain.replace(/\.[^.]+$/, '').replace(/^www\./, '').toLowerCase();
      return info.brand_aliases.some(alias => {
        const aliasClean = alias.replace(/\s+/g, '');
        return domBase === aliasClean || domBase.includes(aliasClean) || aliasClean.includes(domBase);
      });
    });

    // Strategy 2: Extract domain hints from beneficiary/payer names
    // e.g., payer "vitafant gmbh" → look for "vitafant" in domains
    let payerMatchDomain: [string, number] | undefined;
    if (!brandMatchDomain) {
      const payers = new Set<string>();
      for (const ad of brandAds) {
        if (ad.beneficiary_payers) {
          for (const bp of ad.beneficiary_payers) {
            if (bp.beneficiary) payers.add(bp.beneficiary.toLowerCase().replace(/\s*(gmbh|llc|inc|ltd|ug|ag|co|kg)\s*/gi, '').trim());
            if (bp.payer) payers.add(bp.payer.toLowerCase().replace(/\s*(gmbh|llc|inc|ltd|ug|ag|co|kg)\s*/gi, '').trim());
          }
        }
      }
      if (payers.size > 0) {
        info.brand_payers = [...payers];
        for (const payerName of payers) {
          if (payerName.length < 3) continue;
          const payerClean = payerName.replace(/\s+/g, '');
          payerMatchDomain = sorted.find(([domain]) => {
            const domBase = domain.replace(/\.[^.]+$/, '').replace(/^www\./, '').toLowerCase();
            return domBase === payerClean || domBase.includes(payerClean) || payerClean.includes(domBase);
          });
          if (payerMatchDomain) {
            // Add payer as alias
            if (!info.brand_aliases.includes(payerClean)) info.brand_aliases.push(payerClean);
            break;
          }
        }
      }
    }

    if (brandMatchDomain) {
      info.brand_domain = brandMatchDomain[0];
      console.log(`[Discovery] Brand domain selected by NAME MATCH: ${info.brand_domain} (${brandMatchDomain[1]} ads)`);
    } else if (payerMatchDomain) {
      info.brand_domain = payerMatchDomain[0];
      console.log(`[Discovery] Brand domain selected by PAYER MATCH: ${info.brand_domain} (${payerMatchDomain[1]} ads, payers: ${info.brand_payers?.join(', ')})`);
    } else {
      info.brand_domain = sorted[0][0];
      console.log(`[Discovery] Brand domain selected by FREQUENCY (no name/payer match): ${info.brand_domain} (${sorted[0][1]} ads)`);
    }

    // Add domain name without TLD as an alias (e.g., "glow25" from "glow25.de")
    const domainWithoutTld = info.brand_domain.replace(/\.[^.]+$/, '').toLowerCase();
    if (domainWithoutTld.length >= 3 && !info.brand_aliases.includes(domainWithoutTld)) {
      info.brand_aliases.push(domainWithoutTld);
    }
  }

  // Detect Shopify on the brand domain
  if (info.brand_domain) {
    try {
      const shopify = await detectShopifyStore(info.brand_domain);
      info.platform = shopify.platform;

      if (shopify.is_shopify) {
        info.shopify_store = shopify.store_name;
        info.vendor_name = shopify.vendor_name;

        if (shopify.myshopify_domain) {
          info.brand_aliases.push(
            shopify.myshopify_domain.replace('.myshopify.com', '').toLowerCase()
          );
        }
        // Only add vendor_name / og_site_name as alias if it resembles the brand name or domain
        // Prevents generic product words like "besenreiser", "kollagen" from becoming aliases
        const domainBase = info.brand_domain!.replace(/\.[^.]+$/, '').toLowerCase();
        const existingAliases = info.brand_aliases.join(' ');
        for (const name of [shopify.vendor_name, shopify.og_site_name]) {
          if (!name) continue;
          const nameLower = name.toLowerCase().replace(/\s+/g, '');
          // Only add if it overlaps with the brand name or domain
          const isBrandRelated = existingAliases.includes(nameLower) ||
            nameLower.includes(domainBase) || domainBase.includes(nameLower) ||
            info.brand_aliases.some(a => a.includes(nameLower) || nameLower.includes(a));
          if (isBrandRelated) {
            info.brand_aliases.push(nameLower);
            console.log(`[Discovery] Shopify name "${name}" matches brand → added as alias`);
          } else {
            console.log(`[Discovery] Shopify name "${name}" does NOT match brand "${domainBase}" → skipped`);
          }
        }
      }
    } catch (error) {
      console.log(`[Discovery] Shopify detection failed for ${info.brand_domain}:`, error);
    }
  }

  // Deduplicate aliases
  info.brand_aliases = [...new Set(info.brand_aliases)];

  console.log(`[Discovery] Brand info: domain=${info.brand_domain}, platform=${info.platform}, aliases=${info.brand_aliases.join(',')}`);
  return info;
}

// ============================================
// Step 2b: Detect Third-Party from Brand Search
// ============================================

/**
 * Detect third-party pages from brand name search results.
 *
 * KEY INSIGHT: If a page appears when searching for "MiaVola" but is NOT the
 * official page and uses a different domain → it's a third-party page that
 * advertises for the brand (e.g., presell pages).
 *
 * Also extracts beneficiary/payer from official brand ads for matching.
 * EU ads include transparency data showing who pays for the ad — if the same
 * entity pays for both the brand's ads and third-party ads, they're connected.
 */
interface BrandSearchResult {
  confirmedThirdPartyPageIds: Map<string, string>; // pageId → pageName
  priorityDomains: Set<string>; // domains to prioritize in Step 6 verification
}

function detectBrandSearchThirdParty(
  brandAds: MetaAd[],
  brandInfo: BrandInfo
): BrandSearchResult {
  const confirmedThirdPartyPageIds = new Map<string, string>();
  const priorityDomains = new Set<string>();

  if (!brandInfo.brand_domain) return { confirmedThirdPartyPageIds, priorityDomains };

  // Group ads by page
  const pageAds = new Map<string, { name: string; ads: MetaAd[] }>();
  for (const ad of brandAds) {
    if (!ad.page_id) continue;
    const entry = pageAds.get(ad.page_id) || { name: ad.page_name || 'Unknown', ads: [] };
    entry.ads.push(ad);
    pageAds.set(ad.page_id, entry);
  }

  // Extract beneficiary/payer from official brand ads
  const brandPayers = new Set<string>();
  for (const officialPageId of brandInfo.official_page_ids) {
    const entry = pageAds.get(officialPageId);
    if (!entry) continue;
    for (const ad of entry.ads) {
      if (ad.beneficiary_payers) {
        for (const bp of ad.beneficiary_payers) {
          if (bp.beneficiary) brandPayers.add(bp.beneficiary.toLowerCase().trim());
          if (bp.payer) brandPayers.add(bp.payer.toLowerCase().trim());
        }
      }
    }
  }

  if (brandPayers.size > 0) {
    console.log(`[Discovery] Brand payers/beneficiaries: ${JSON.stringify([...brandPayers])}`);
  }

  // Store payers in brandInfo for later use
  brandInfo.brand_payers = [...brandPayers];

  const brandDomain = brandInfo.brand_domain.toLowerCase();

  // Check each non-official page
  for (const [pageId, { name, ads }] of pageAds) {
    if (brandInfo.official_page_ids.includes(pageId)) continue;

    // Extract domains from this page's ads
    const pageDomains = new Set<string>();
    for (const ad of ads) {
      if (ad.ad_creative_link_captions) {
        for (const caption of ad.ad_creative_link_captions) {
          const domain = extractDomainFromCaption(caption);
          if (domain) pageDomains.add(domain.toLowerCase());
        }
      }
    }

    // Filter to third-party domains only (not brand's own, not platform domains)
    const PLATFORM_DOMAINS = [
      // Social / Platform
      'facebook.com', 'fb.com', 'fbcdn.net', 'instagram.com',
      'meta.com', 'meta.ai', 'facebook.net', 'threads.net',
      'whatsapp.com', 'messenger.com', 'google.com', 'youtube.com',
      'tiktok.com', 'twitter.com', 'x.com', 'linkedin.com',
      'pinterest.com', 'snapchat.com',
      // Marketplaces (multi-vendor — not third-party signals)
      'amazon.de', 'amazon.com', 'amazon.co.uk', 'amazon.fr', 'amazon.it', 'amazon.es', 'amazon.nl',
      'ebay.de', 'ebay.com', 'ebay.co.uk',
      'otto.de', 'kaufland.de', 'idealo.de', 'galaxus.de',
      'etsy.com', 'aliexpress.com', 'zalando.de', 'aboutyou.de',
      // Online pharmacies / drugstores (multi-vendor)
      'docmorris.de', 'shop-apotheke.com', 'medpex.de', 'apo-rot.de',
      'aponeo.de', 'versandapo.de', 'mycare.de', 'medikamente-per-klick.de',
      'dm.de', 'rossmann.de', 'mueller.de', 'douglas.de', 'flaconi.de',
      // Tracking / redirect domains
      'exactag.com', 'm.exactag.com', 'tradedoubler.com', 'awin1.com',
      'tradetracker.net', 'webgains.com', 'adcell.de', 'belboon.de',
    ];
    const thirdPartyDomains = [...pageDomains].filter(d => {
      if (d === brandDomain) return false;
      // Skip platform domains
      if (PLATFORM_DOMAINS.some(pd => d === pd || d.endsWith('.' + pd))) return false;
      // Also skip if domain contains a brand alias
      return !brandInfo.brand_aliases.some(alias => {
        const normalized = alias.replace(/[\s\-_.]+/g, '');
        return normalized.length >= 3 && d.includes(normalized);
      });
    });

    if (thirdPartyDomains.length === 0 && pageDomains.size === 0) {
      console.log(`[Discovery] Brand search → Page "${name}" (${pageId}): ${ads.length} ads, no domain in captions → SKIP`);
      continue;
    }

    if (thirdPartyDomains.length === 0) {
      // Check if this page actually links to the brand domain (not just platform domains)
      const linksToBrand = [...pageDomains].some(d => d === brandDomain);
      if (linksToBrand) {
        // Page runs ads linking TO the brand — confirmed third-party advertiser
        confirmedThirdPartyPageIds.set(pageId, name);
        console.log(`[Discovery] Brand search → Page "${name}" (${pageId}): ${ads.length} ads, links to brand domain only → CONFIRMED THIRD-PARTY (domain TBD from keyword search)`);
      } else {
        console.log(`[Discovery] Brand search → Page "${name}" (${pageId}): ${ads.length} ads, only platform domains → SKIP`);
      }
      continue;
    }

    // Add non-brand domains as priority candidates for Step 6 verification
    // NOTE: We do NOT create matches here — only identify candidates.
    // All verification happens in Step 6 (checkDomainForBrand).
    for (const domain of thirdPartyDomains) {
      if (isSpamDomain(domain)) {
        console.log(`[Discovery] Brand search → "${name}" (${pageId}): domain ${domain} → SKIP (spam domain)`);
        continue;
      }
      if (isSpamPageName(name)) {
        console.log(`[Discovery] Brand search → "${name}" (${pageId}): domain ${domain} → SKIP (spam page name)`);
        continue;
      }

      priorityDomains.add(domain);
      console.log(`[Discovery] Brand search → "${name}" (${pageId}): domain ${domain} → PRIORITY CANDIDATE for Step 6`);
    }
  }

  return { confirmedThirdPartyPageIds, priorityDomains };
}

// ============================================
// Step 4: Search All Ads by Keywords
// ============================================

/**
 * Search Meta API for each keyword, collecting all ads.
 * Deduplicates by ad ID across keywords.
 */
async function searchAllAdsForKeywords(
  keywords: string[],
  metaClient: MetaAdLibraryClient,
  countries: string[],
  maxPerKeyword: number
): Promise<MetaAd[]> {
  const allAdsMap = new Map<string, MetaAd>();

  for (const keyword of keywords) {
    try {
      console.log(`[Discovery] Searching keyword: "${keyword}" ...`);

      const ads = await metaClient.fetchAllAds({
        search_terms: keyword,
        ad_reached_countries: countries,
        search_type: 'KEYWORD_UNORDERED',
        ad_active_status: 'ALL',
        max_results: maxPerKeyword,
      });

      for (const ad of ads) {
        if (!allAdsMap.has(ad.id)) {
          allAdsMap.set(ad.id, ad);
        }
      }

      console.log(`[Discovery] "${keyword}" → ${ads.length} ads`);

      // Rate limit protection
      await delay(META_API_DELAY_MS);
    } catch (error) {
      console.log(`[Discovery] Error searching keyword "${keyword}":`, error);
    }
  }

  return [...allAdsMap.values()];
}

// ============================================
// Step 5: Extract Unique Domains
// ============================================

interface DomainExtractionResult {
  domainPageMap: Map<string, string[]>;   // domain → [page_ids]
  domainAdCount: Map<string, number>;     // domain → ad count
  allPages: Map<string, { name: string; count: number; domains: Set<string> }>;
  domainFullUrls: Map<string, Map<string, number>>;  // domain → {fullUrl → count} (all domains incl. brand)
}

/**
 * Extract unique domains from ads, filter out brand's own domains.
 */
function extractUniqueDomains(
  ads: MetaAd[],
  brandInfo: BrandInfo
): DomainExtractionResult {
  const domainPageMap = new Map<string, string[]>();
  const domainAdCount = new Map<string, number>();
  const allPages = new Map<string, { name: string; count: number; domains: Set<string> }>();
  const domainFullUrls = new Map<string, Map<string, number>>();

  const brandDomains = new Set<string>();
  if (brandInfo.brand_domain) {
    brandDomains.add(brandInfo.brand_domain.toLowerCase());
    // Also exclude myshopify variant
    if (brandInfo.shopify_store) {
      brandDomains.add(`${brandInfo.shopify_store}.myshopify.com`);
    }
  }

  const excludedDomains = new Set([
    // Social / Platform
    'facebook.com', 'fb.com', 'instagram.com', 'meta.com',
    'google.com', 'youtube.com', 'twitter.com', 'pinterest.com',
    'tiktok.com', 'bit.ly', 'linktr.ee', 'l.facebook.com',
    'linkedin.com', 'x.com', 'snapchat.com', 'threads.net',
    // Marketplaces (multi-vendor — brand match on ONE product ≠ third-party page)
    'amazon.de', 'amazon.com', 'amazon.co.uk', 'amazon.fr', 'amazon.it', 'amazon.es', 'amazon.nl',
    'ebay.de', 'ebay.com', 'ebay.co.uk',
    'otto.de', 'kaufland.de', 'idealo.de', 'galaxus.de',
    'etsy.com', 'aliexpress.com', 'zalando.de', 'aboutyou.de',
    // Online pharmacies / drugstores (multi-vendor)
    'docmorris.de', 'shop-apotheke.com', 'medpex.de', 'apo-rot.de',
    'aponeo.de', 'versandapo.de', 'mycare.de', 'medikamente-per-klick.de',
    'dm.de', 'rossmann.de', 'mueller.de', 'douglas.de', 'flaconi.de',
    // Tracking / redirect domains
    'exactag.com', 'm.exactag.com', 'tradedoubler.com', 'awin1.com',
    'tradetracker.net', 'webgains.com', 'adcell.de', 'belboon.de',
  ]);

  for (const ad of ads) {
    const pageId = ad.page_id || 'unknown';
    const pageName = ad.page_name || 'Unknown';

    // Track page info
    const pageInfo = allPages.get(pageId) || { name: pageName, count: 0, domains: new Set<string>() };
    pageInfo.count++;
    allPages.set(pageId, pageInfo);

    // Extract domain from captions
    if (ad.ad_creative_link_captions) {
      for (const caption of ad.ad_creative_link_captions) {
        const domain = extractDomainFromCaption(caption);
        if (!domain) continue;

        const domainLower = domain.toLowerCase();

        // Track full URL for ALL domains (including brand) before filtering
        const fullUrl = extractFullUrlFromCaption(caption);
        if (fullUrl) {
          if (!domainFullUrls.has(domainLower)) {
            domainFullUrls.set(domainLower, new Map());
          }
          const urlMap = domainFullUrls.get(domainLower)!;
          urlMap.set(fullUrl, (urlMap.get(fullUrl) || 0) + 1);
        }

        // Skip brand's own domain (for domain matching only, URLs already tracked above)
        if (brandDomains.has(domainLower)) continue;

        // Skip social/platform domains
        if (excludedDomains.has(domainLower) ||
            [...excludedDomains].some(ed => domainLower.endsWith(`.${ed}`))) {
          continue;
        }

        // Skip if domain contains brand name (likely official)
        const isBrandDomain = brandInfo.brand_aliases.some(alias =>
          domainLower.includes(alias.replace(/\s+/g, ''))
        );
        if (isBrandDomain) {
          brandDomains.add(domainLower);
          continue;
        }

        // Track domain → pages mapping
        const existingPages = domainPageMap.get(domainLower) || [];
        if (!existingPages.includes(pageId)) {
          existingPages.push(pageId);
        }
        domainPageMap.set(domainLower, existingPages);

        // Track ad count per domain
        domainAdCount.set(domainLower, (domainAdCount.get(domainLower) || 0) + 1);

        // Track domain in page info
        pageInfo.domains.add(domainLower);
      }
    }
  }

  return { domainPageMap, domainAdCount, allPages, domainFullUrls };
}

// ============================================
// Step 6: Brand-Check Each Domain (THE CORE)
// ============================================

interface DomainCheckOptions {
  timeout?: number;
  use_headless?: boolean;
  deep_cta_enabled?: boolean;              // Enable deep CTA chain following (Worker-only)
  domainAds?: MetaAd[];                    // Ads from this domain (for Step 6f)
  domainFullUrls?: Map<string, number>;    // Full URLs from ad captions → count (for Step 6f/6g)
  openai_key?: string;                     // For quick AI verification of checkout matches
}

/**
 * Check if a domain leads to the brand's shop.
 * Tries multiple detection methods in order of reliability and cost:
 *
 * 6a. Direct domain comparison
 * 6b. HTTP redirect check → does it redirect to brand domain?
 * 6c. Shopify /products.json vendor check
 * 6d. Presell CTA → follow redirect chain → brand domain?
 * 6e. Headless browser fallback (if enabled)
 */
async function checkDomainForBrand(
  domain: string,
  brandInfo: BrandInfo,
  options: DomainCheckOptions
): Promise<DomainBrandCheck> {
  const timeout = options?.timeout || DOMAIN_CHECK_TIMEOUT;

  const result: DomainBrandCheck = {
    domain,
    is_match: false,
    match_type: 'none',
    confidence: 0,
    final_url: null,
    redirect_chain: [],
    shop_domain: null,
    vendor_name: null,
    page_ids: [],
    ad_count: 0,
  };

  if (!brandInfo.brand_domain) return result;

  const brandDomain = brandInfo.brand_domain.toLowerCase();

  console.log(`[Discovery] ${domain}:`);

  try {
    // ----------------------------------------
    // 6a. DIRECT CHECK: domain === brand_domain?
    // ----------------------------------------
    if (domain.toLowerCase() === brandDomain) {
      result.is_match = true;
      result.match_type = 'direct';
      result.confidence = 1.0;
      result.shop_domain = domain;
      console.log(`[Discovery]   RESULT: ✓ MATCH (direct, confidence: 1.0)`);
      return result;
    }

    // ----------------------------------------
    // 6b. REDIRECT CHECK: fetch domain → follow redirects → brand domain?
    // ----------------------------------------
    const fetchResult = await fetchWithRedirects(domain, timeout);
    if (fetchResult) {
      result.final_url = fetchResult.final_url;
      result.redirect_chain = fetchResult.chain;

      const finalDomain = extractDomainFromUrl(fetchResult.final_url);
      const redirectMatch = finalDomain ? isDomainMatch(finalDomain, brandInfo) : false;
      console.log(`[Discovery]   redirect → ${redirectMatch ? `MATCH (→ ${finalDomain})` : `MISS (stays on ${finalDomain})`}`);

      if (finalDomain && redirectMatch) {
        result.is_match = true;
        result.match_type = 'redirect';
        result.confidence = 0.90;
        result.shop_domain = finalDomain;
        console.log(`[Discovery]   RESULT: ✓ MATCH (redirect, confidence: 0.90)`);
        return result;
      }

      if (fetchResult.html) {
        // Check if the HTML contains links to the brand domain
        if (fetchResult.html.includes(brandDomain)) {
          // Page links to or mentions the brand domain — this is a presell/affiliate
          result.is_match = true;
          result.match_type = 'content_link';
          result.confidence = 0.75;
          result.shop_domain = brandDomain;
          console.log(`[Discovery]   content → HTML contains "${brandDomain}" → MATCH`);
          console.log(`[Discovery]   RESULT: ✓ MATCH (content_link, confidence: 0.75)`);
          return result;
        }

        // Note: We intentionally do NOT match on brand alias in HTML (content_match).
        // Just because "glow25" appears somewhere on a page doesn't mean it's an affiliate.
        // Only URL-chain verified matches count (redirect, CTA, checkout).
      }

      // ----------------------------------------
      // 6d. PRESELL CTA CHECK
      // ----------------------------------------
      // Check BOTH homepage AND specific ad landing page URLs for CTAs.
      // Presell pages often have the CTA only on specific paths, not the homepage.
      {
        // Collect URLs to check: homepage + landing page URLs from ads
        // Worker mode (deep_cta): ALL landing page URLs for comprehensive coverage
        // Edge fn: homepage + top 3 only
        const presellUrlsToCheck: string[] = [`https://${domain}`];
        if (options.domainFullUrls) {
          const sortedUrls = [...options.domainFullUrls.entries()]
            .filter(([url]) => {
              try { return new URL(url).pathname !== '/'; } catch { return false; }
            })
            .sort((a, b) => b[1] - a[1]);
          const maxUrls = options.deep_cta_enabled ? sortedUrls.length : 3;
          for (const [url] of sortedUrls.slice(0, maxUrls)) {
            if (!presellUrlsToCheck.includes(url)) {
              presellUrlsToCheck.push(url);
            }
          }
        }

        for (const presellUrl of presellUrlsToCheck) {
          const presellResult = await trackPresellChain(presellUrl, {
            timeout,
            maxRedirects: 10,
          });

          if (presellResult.final_url) {
            const ctaFinalDomain = extractDomainFromUrl(presellResult.final_url);
            const ctaMatch = ctaFinalDomain ? isDomainMatch(ctaFinalDomain, brandInfo) : false;
            console.log(`[Discovery]   presell CTA (${presellUrl.substring(0, 60)}) → ${presellResult.cta_url || 'unknown'} → ${presellResult.final_url} → ${ctaMatch ? 'MATCH' : 'MISS'}`);

            if (ctaFinalDomain && ctaMatch) {
              result.is_match = true;
              result.match_type = 'presell_cta';
              result.confidence = 0.85;
              result.shop_domain = ctaFinalDomain;
              result.redirect_chain = presellResult.chain;
              console.log(`[Discovery]   RESULT: ✓ MATCH (presell_cta, confidence: 0.85)`);
              return result;
            }

            // CTA led to a non-brand domain — check if the checkout page mentions the brand
            // Covers WooCommerce, Digistore24, Magento, custom shops
            if (ctaFinalDomain && presellResult.final_url) {
              try {
                const checkoutResult = await detectBrandFromCheckout(presellResult.final_url, { timeout: 8000 });
                if (checkoutResult.brand_name) {
                  const brandMatch = isCheckoutBrandMatch(checkoutResult.brand_name, brandInfo);
                  if (brandMatch) {
                    // Quick AI guard: verify the match isn't a false positive
                    const aiConfirmed = await quickAIVerify(checkoutResult.brand_name, brandInfo, options.openai_key);
                    if (aiConfirmed) {
                      result.is_match = true;
                      result.match_type = 'checkout_match';
                      result.confidence = Math.min(checkoutResult.confidence, 0.85);
                      result.vendor_name = checkoutResult.brand_name;
                      result.shop_domain = ctaFinalDomain;
                      result.redirect_chain = presellResult.chain;
                      console.log(`[Discovery]   checkout → brand "${checkoutResult.brand_name}" (${checkoutResult.platform}, ${checkoutResult.detection_method}) → MATCH (strict+AI)`);
                      console.log(`[Discovery]   RESULT: ✓ MATCH (checkout_brand, confidence: ${result.confidence})`);
                      return result;
                    } else {
                      console.log(`[Discovery]   checkout → brand "${checkoutResult.brand_name}" — strict match passed but AI rejected`);
                    }
                  } else {
                    console.log(`[Discovery]   checkout → brand "${checkoutResult.brand_name}" ≠ ${brandInfo.brand_name} (strict match rejected)`);
                  }
                }
              } catch {
                // Checkout detection failed, continue
              }
            }
          } else {
            console.log(`[Discovery]   presell CTA (${presellUrl.substring(0, 60)}) → no CTA found`);
          }
        }
      }
    } else {
      console.log(`[Discovery]   redirect → MISS (fetch failed)`);
      console.log(`[Discovery]   shopify → NOT shopify`);
      console.log(`[Discovery]   presell CTA → no CTA found`);
    }

    // ----------------------------------------
    // 6f. AD LANDING PAGE URL CHECK (FREE)
    // Check URLs extracted from ad snapshots (by Step 5e)
    // ----------------------------------------
    if (options.domainFullUrls && options.domainFullUrls.size > 0) {
      for (const [fullUrl] of options.domainFullUrls) {
        // Check 1: Does the URL domain match the brand?
        const urlDomain = extractDomainFromUrl(fullUrl);
        if (urlDomain && isDomainMatch(urlDomain, brandInfo)) {
          result.is_match = true;
          result.match_type = 'redirect';
          result.confidence = 0.85;
          result.shop_domain = urlDomain;
          console.log(`[Discovery]   6f: Landing page URL "${fullUrl}" → domain ${urlDomain} → MATCH`);
          console.log(`[Discovery]   RESULT: ✓ MATCH (ad_landing_url, confidence: 0.85)`);
          return result;
        }

        // Check 2: Does the URL PATH contain the brand name?
        try {
          const urlPath = new URL(fullUrl).pathname.toLowerCase();
          for (const alias of brandInfo.brand_aliases) {
            if (alias.length >= 4 && urlPath.includes(alias)) {
              result.is_match = true;
              result.match_type = 'content_link';
              result.confidence = 0.80;
              result.shop_domain = brandInfo.brand_domain;
              console.log(`[Discovery]   6f: URL path "${urlPath}" contains brand "${alias}" → MATCH`);
              console.log(`[Discovery]   RESULT: ✓ MATCH (url_path_brand, confidence: 0.80)`);
              return result;
            }
          }
        } catch { /* ignore URL parse errors */ }
      }

      // Check 3: Fetch specific landing pages and check HTML for brand domain/aliases
      const specificUrls = [...options.domainFullUrls.entries()]
        .filter(([url]) => {
          try { return new URL(url).pathname !== '/'; } catch { return false; }
        })
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2); // Max 2 specific URLs to fetch

      for (const [specificUrl] of specificUrls) {
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 6000);
          const resp = await fetch(specificUrl, {
            signal: ctrl.signal,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
            },
          });
          clearTimeout(timer);

          if (resp.ok) {
            const html = await resp.text();
            const htmlLower = html.toLowerCase();

            // Check for brand domain in HTML
            if (htmlLower.includes(brandDomain)) {
              result.is_match = true;
              result.match_type = 'content_link';
              result.confidence = 0.75;
              result.shop_domain = brandDomain;
              console.log(`[Discovery]   6f: Landing page HTML contains "${brandDomain}" → MATCH`);
              console.log(`[Discovery]   RESULT: ✓ MATCH (landing_content_link, confidence: 0.75)`);
              return result;
            }

            // Note: No content_match on landing page HTML — only URL-chain verified matches count.
            console.log(`[Discovery]   6f: Landing page ${specificUrl.substring(0, 60)} → no brand in HTML`);
          }
        } catch {
          console.log(`[Discovery]   6f: Failed to fetch ${specificUrl.substring(0, 60)}`);
        }
      }

      console.log(`[Discovery]   6f: Ad landing pages → no brand match found`);
    }

    // Check if same ad links to BOTH this domain AND the brand domain
    if (options.domainAds && options.domainAds.length > 0) {
      for (const ad of options.domainAds) {
        if (!ad.ad_creative_link_captions) continue;
        for (const caption of ad.ad_creative_link_captions) {
          const captionDomain = extractDomainFromCaption(caption)?.toLowerCase();
          if (captionDomain && captionDomain !== domain.toLowerCase() && isDomainMatch(captionDomain, brandInfo)) {
            result.is_match = true;
            result.match_type = 'content_link';
            result.confidence = 0.80;
            result.shop_domain = captionDomain;
            console.log(`[Discovery]   6f: Ad ${ad.id} links to BOTH ${domain} AND ${captionDomain} → MATCH`);
            console.log(`[Discovery]   RESULT: ✓ MATCH (ad_dual_domain, confidence: 0.80)`);
            return result;
          }
        }
      }
    }

    // ----------------------------------------
    // 6g. HEADLESS PRESELL PAGE RENDER (local Chromium, FREE)
    // Render landing pages with JS and check for brand links.
    // KEY: presell pages load CTAs via JavaScript — plain HTTP can't see them.
    // Now renders ALL extracted URLs per domain (not just the best one).
    // Tracks whether external links exist for smart 6h gating.
    // ----------------------------------------
    let domainHasExternalLinks = false;  // Track for 6h gating
    if (options.use_headless !== false) {
      // Collect ALL URLs to render: homepage + all landing page URLs
      const renderUrls: string[] = [`https://${domain}`];
      if (options.domainFullUrls && options.domainFullUrls.size > 0) {
        const specificUrls = [...options.domainFullUrls.entries()]
          .filter(([url]) => {
            try { return new URL(url).pathname.length > 1; } catch { return false; }
          })
          .sort((a, b) => b[1] - a[1]);
        for (const [url] of specificUrls) {
          if (!renderUrls.includes(url)) renderUrls.push(url);
        }
      }

      console.log(`[Discovery]   6g: Headless rendering ${renderUrls.length} URLs for ${domain}...`);
      const { BrowserRenderer } = await import('./browser-renderer.ts');
      const renderer = BrowserRenderer.getInstance();

      for (const targetUrl of renderUrls) {
        try {
          const sbResult = await renderer.renderPage(targetUrl, { wait_ms: 3000, timeout_ms: 20000 });

          if (sbResult.html) {
            const html = sbResult.html;
            const htmlLower = html.toLowerCase();

            // Check 1: Does rendered HTML contain a link to the brand domain?
            const linkRegex = /href=["']([^"']*?)["']/gi;
            let linkMatch;
            while ((linkMatch = linkRegex.exec(html)) !== null) {
              try {
                const linkDomain = extractDomainFromUrl(linkMatch[1]);
                if (linkDomain && isDomainMatch(linkDomain, brandInfo)) {
                  result.is_match = true;
                  result.match_type = 'presell_cta';
                  result.confidence = 0.85;
                  result.shop_domain = linkDomain;
                  console.log(`[Discovery]   6g: Found brand link on ${targetUrl.substring(0, 60)}: ${linkMatch[1].substring(0, 80)} → MATCH`);
                  console.log(`[Discovery]   RESULT: ✓ MATCH (presell_rendered, confidence: 0.85)`);
                  return result;
                }
                // Track if there are ANY external links (for 6h gating)
                if (linkDomain && linkDomain !== domain.toLowerCase().replace(/^www\./, '')) {
                  domainHasExternalLinks = true;
                }
              } catch { /* skip invalid URLs */ }
            }

            // Check 2: Does rendered HTML mention the brand domain in text?
            if (htmlLower.includes(brandDomain)) {
              result.is_match = true;
              result.match_type = 'content_link';
              result.confidence = 0.80;
              result.shop_domain = brandDomain;
              console.log(`[Discovery]   6g: Rendered HTML of ${targetUrl.substring(0, 60)} contains "${brandDomain}" → MATCH`);
              console.log(`[Discovery]   RESULT: ✓ MATCH (presell_content, confidence: 0.80)`);
              return result;
            }

            // Check 3: Follow CTA-like links through redirects (tracking links etc.)
            const ctaPatterns = ['shop', 'kauf', 'bestell', 'checkout', 'angebot', 'buy', 'order', '/go/', '/out/', '/click', '/redirect', '/track'];
            const allLinks: string[] = [];
            const linkExtract = /href=["'](https?:\/\/[^"']+)["']/gi;
            let le;
            while ((le = linkExtract.exec(html)) !== null) {
              allLinks.push(le[1]);
            }

            // Track external links for 6h gating
            const externalLinks = allLinks.filter(l => {
              try {
                const lDomain = new URL(l).hostname.replace(/^www\./, '');
                return lDomain !== domain.toLowerCase().replace(/^www\./, '');
              } catch { return false; }
            });
            if (externalLinks.length > 0) domainHasExternalLinks = true;

            const ctaLinks = allLinks.filter(l => {
              const lLower = l.toLowerCase();
              return ctaPatterns.some(p => lLower.includes(p));
            }).slice(0, 3);

            for (const ctaLink of ctaLinks) {
              try {
                const redirectResult = await fetchWithRedirects(ctaLink, 8000);
                if (redirectResult) {
                  const ctaFinalDomain = extractDomainFromUrl(redirectResult.final_url);
                  if (ctaFinalDomain && isDomainMatch(ctaFinalDomain, brandInfo)) {
                    result.is_match = true;
                    result.match_type = 'presell_cta';
                    result.confidence = 0.85;
                    result.shop_domain = ctaFinalDomain;
                    result.redirect_chain = redirectResult.chain;
                    console.log(`[Discovery]   6g: CTA redirect ${ctaLink.substring(0, 60)} → ${redirectResult.final_url} → MATCH`);
                    console.log(`[Discovery]   RESULT: ✓ MATCH (presell_cta_redirect, confidence: 0.85)`);
                    return result;
                  }

                  // CTA led to non-brand domain — check checkout page for brand
                  if (ctaFinalDomain) {
                    try {
                      const checkoutResult = await detectBrandFromCheckout(redirectResult.final_url, { timeout: 8000 });
                      if (checkoutResult.brand_name) {
                        const brandMatch = isCheckoutBrandMatch(checkoutResult.brand_name, brandInfo);
                        if (brandMatch) {
                          const aiConfirmed = await quickAIVerify(checkoutResult.brand_name, brandInfo, options.openai_key);
                          if (aiConfirmed) {
                            result.is_match = true;
                            result.match_type = 'checkout_match';
                            result.confidence = Math.min(checkoutResult.confidence, 0.85);
                            result.vendor_name = checkoutResult.brand_name;
                            result.shop_domain = ctaFinalDomain;
                            result.redirect_chain = redirectResult.chain;
                            console.log(`[Discovery]   6g: Checkout brand "${checkoutResult.brand_name}" (${checkoutResult.platform}) → MATCH (strict+AI)`);
                            console.log(`[Discovery]   RESULT: ✓ MATCH (checkout_brand_rendered, confidence: ${result.confidence})`);
                            return result;
                          } else {
                            console.log(`[Discovery]   6g: Checkout "${checkoutResult.brand_name}" — strict match passed but AI rejected`);
                          }
                        }
                      }
                    } catch { /* checkout detection failed */ }
                  }
                }
              } catch { /* skip this CTA */ }
            }

            console.log(`[Discovery]   6g: ${targetUrl.substring(0, 60)} → no brand links (${allLinks.length} links, ${externalLinks.length} external)`);
          } else {
            console.log(`[Discovery]   6g: ${targetUrl.substring(0, 60)} → render failed`);
          }
        } catch (error) {
          console.log(`[Discovery]   6g: ${targetUrl.substring(0, 60)} → error: ${String(error).substring(0, 80)}`);
        }
      }

      console.log(`[Discovery]   6g: All ${renderUrls.length} URLs rendered → no brand match (external links: ${domainHasExternalLinks})`);
    }

    // ----------------------------------------
    // 6h. DEEP CTA CHAIN FOLLOW (Worker-Mode, headless browser)
    // Renders each landing page with JS, finds CTAs, follows them
    // through multiple hops until reaching checkout.
    // This catches presell → offer → checkout chains like:
    // naturgesundcheck.com → CTA → CTA → vitafant.com/checkouts/
    //
    // Runs for EVERY unmatched domain — no smart gate.
    // Domains without CTAs bail out after one free HTTP fetch (no credits).
    // ----------------------------------------
    if (options.deep_cta_enabled) {
      // Collect landing page URLs: homepage + top 2 specific URLs (max 3 total)
      // Brand-affiliated accounts push ONE brand — 3 URLs is sufficient
      const deepCheckUrls: string[] = [`https://${domain}`];
      if (options.domainFullUrls) {
        const sortedUrls = [...options.domainFullUrls.entries()]
          .filter(([url]) => {
            try { return new URL(url).pathname !== '/'; } catch { return false; }
          })
          .sort((a, b) => b[1] - a[1]);
        for (const [url] of sortedUrls.slice(0, 2)) {  // Max 2 specific URLs + homepage = 3 total
          if (!deepCheckUrls.includes(url)) {
            deepCheckUrls.push(url);
          }
        }
      }

      console.log(`[Discovery]   6h: Deep CTA chain follow (${deepCheckUrls.length} URLs)...`);

      for (const targetUrl of deepCheckUrls) {
        try {
          const deepResult = await deepCTAChainFollow(targetUrl, {
            brand_info: brandInfo,
            max_hops: 5,
            render_wait_ms: 3000,
            timeout_per_hop_ms: 20000,
            total_timeout_ms: 90000,
          });

          if (deepResult.is_brand_match) {
            result.is_match = true;
            result.match_type = 'deep_cta';
            result.confidence = deepResult.confidence;
            result.shop_domain = deepResult.final_domain;
            result.redirect_chain = deepResult.chain.map(h => h.page_url);
            console.log(`[Discovery]   6h: MATCH via deep CTA chain: ${targetUrl} → ${deepResult.chain.map(h => h.page_url).join(' → ')} → ${deepResult.final_domain}`);
            console.log(`[Discovery]   RESULT: ✓ MATCH (deep_cta, confidence: ${deepResult.confidence})`);
            return result;
          } else {
            console.log(`[Discovery]   6h: ${targetUrl.substring(0, 60)} → no match (${deepResult.total_hops} hops)`);
          }
        } catch (error) {
          console.log(`[Discovery]   6h: Error for ${targetUrl.substring(0, 60)}: ${String(error)}`);
        }
      }

      console.log(`[Discovery]   6h: Deep CTA → no brand match found in any URL`);
    }

    console.log(`[Discovery]   RESULT: ✗ NO MATCH`);
    return result;
  } catch (error) {
    console.log(`[Discovery] Domain check error for ${domain}:`, error);
    console.log(`[Discovery]   RESULT: ✗ NO MATCH`);
    return result;
  }
}

/**
 * Check if a domain matches the brand (including aliases)
 */
function isDomainMatch(domain: string, brandInfo: BrandInfo): boolean {
  const domainLower = domain.toLowerCase().replace(/^www\./, '');

  // Exact domain match
  if (brandInfo.brand_domain && domainLower === brandInfo.brand_domain.toLowerCase()) {
    return true;
  }

  // Myshopify match
  if (brandInfo.shopify_store &&
      domainLower === `${brandInfo.shopify_store}.myshopify.com`) {
    return true;
  }

  // Domain contains brand alias
  for (const alias of brandInfo.brand_aliases) {
    const normalized = alias.replace(/[\s\-_.]+/g, '');
    if (normalized.length >= 3 && domainLower.includes(normalized)) {
      return true;
    }
  }

  return false;
}

/**
 * Strict checkout brand match — replaces the old loose substring matching.
 *
 * Prevents false positives like "nutrition" matching "Best Body Nutrition"
 * when the checkout says "MORE Nutrition".
 *
 * 3-Tier logic:
 * Tier 1: Domain-core match (strongest — strip TLD, normalize)
 * Tier 2: Alias match with 60% length ratio + full containment
 * Tier 3: Exact vendor_name match
 */
function isCheckoutBrandMatch(
  checkoutBrandName: string,
  brandInfo: BrandInfo
): boolean {
  const checkoutNorm = checkoutBrandName.toLowerCase().replace(/[\s\-_.]+/g, '');
  if (checkoutNorm.length < 3) return false;

  // Tier 1: Domain-core match
  // "best-body-shop.de" → "bestbodyshop"
  if (brandInfo.brand_domain) {
    const domainCore = brandInfo.brand_domain
      .replace(/^www\./, '')
      .replace(/\.[a-z]{2,6}$/, '')  // strip TLD (.de, .com, .co.uk)
      .replace(/[\s\-_.]+/g, '')
      .toLowerCase();
    if (domainCore.length >= 4) {
      if (checkoutNorm === domainCore) return true;
      // Full containment with 60% length ratio
      const longer = Math.max(checkoutNorm.length, domainCore.length);
      const shorter = Math.min(checkoutNorm.length, domainCore.length);
      if (shorter / longer >= 0.6) {
        if (checkoutNorm.includes(domainCore) || domainCore.includes(checkoutNorm)) {
          return true;
        }
      }
    }
  }

  // Tier 2: Alias match (strict — 60% length ratio + full containment)
  for (const alias of brandInfo.brand_aliases) {
    const aliasNorm = alias.replace(/[\s\-_.]+/g, '').toLowerCase();
    if (aliasNorm.length < 4) continue;

    // Exact match
    if (checkoutNorm === aliasNorm) return true;

    // Length ratio check: shorter must be >= 60% of longer
    const longer = Math.max(checkoutNorm.length, aliasNorm.length);
    const shorter = Math.min(checkoutNorm.length, aliasNorm.length);
    if (shorter / longer < 0.6) continue;

    // Full containment required
    if (checkoutNorm.includes(aliasNorm) || aliasNorm.includes(checkoutNorm)) {
      return true;
    }
  }

  // Tier 3: Exact vendor_name match
  if (brandInfo.vendor_name) {
    const vendorNorm = brandInfo.vendor_name.replace(/[\s\-_.]+/g, '').toLowerCase();
    if (vendorNorm.length >= 4 && checkoutNorm === vendorNorm) {
      return true;
    }
  }

  return false;
}

// ============================================
// Step 7: Build Result
// ============================================

function buildDiscoveryResult(
  brandName: string,
  brandInfo: BrandInfo,
  matchedDomains: DomainBrandCheck[],
  allAds: MetaAd[],
  allPages: Map<string, { name: string; count: number; domains: Set<string> }>,
  keywords: string[],
  detectionMethods: Record<string, number>,
  startTime: number,
  totalDomainsChecked: number = 0,
  brandAds: MetaAd[] = [],
  domainFullUrls: Map<string, Map<string, number>> = new Map()
): BrandDiscoveryResponse {
  // Build official pages
  const officialPages: PageInfo[] = [];
  for (const pageId of brandInfo.official_page_ids) {
    const pageData = allPages.get(pageId);
    officialPages.push({
      page_id: pageId,
      page_name: pageData?.name || brandName,
      ad_count: pageData?.count || 0,
      is_official: true,
    });
  }

  // Build page name lookup from ALL ads (brandAds + keyword ads)
  const pageNameLookup = new Map<string, string>();
  for (const ad of brandAds) {
    if (ad.page_id && ad.page_name && !pageNameLookup.has(ad.page_id)) {
      pageNameLookup.set(ad.page_id, ad.page_name);
    }
  }
  for (const ad of allAds) {
    if (ad.page_id && ad.page_name && !pageNameLookup.has(ad.page_id)) {
      pageNameLookup.set(ad.page_id, ad.page_name);
    }
  }

  // Build third-party pages from matched domains
  const thirdPartyPagesMap = new Map<string, ThirdPartyPageInfo>();

  for (const match of matchedDomains) {
    for (const pageId of match.page_ids) {
      // Skip official pages
      if (brandInfo.official_page_ids.includes(pageId)) continue;

      const existing = thirdPartyPagesMap.get(pageId);
      if (existing) {
        // Update with higher confidence match
        if (match.confidence > existing.confidence) {
          existing.connection_type = match.match_type as ThirdPartyPageInfo['connection_type'];
          existing.confidence = match.confidence;
        }
        if (!existing.domains_used.includes(match.domain)) {
          existing.domains_used.push(match.domain);
        }
        existing.ad_count += match.ad_count;
      } else {
        const pageData = allPages.get(pageId);
        const pageName = pageData?.name || pageNameLookup.get(pageId) || 'Unknown';
        thirdPartyPagesMap.set(pageId, {
          page_id: pageId,
          page_name: pageName,
          ad_count: match.ad_count,
          connection_type: match.match_type as ThirdPartyPageInfo['connection_type'],
          confidence: match.confidence,
          discovered_via: match.domain,
          domains_used: [match.domain],
        });
      }
    }
  }

  // NOTE: Only URL-verified matches from Step 6 are included.
  // Pages without verified domain connections are intentionally excluded.
  // This ensures 100% precision — every listed page is verified.

  const thirdPartyPages = [...thirdPartyPagesMap.values()]
    .sort((a, b) => b.confidence - a.confidence || b.ad_count - a.ad_count);

  // Categorize domains
  const presellDomains: string[] = [];
  const redirectDomains: string[] = [];
  const shopDomains: string[] = [];

  for (const match of matchedDomains) {
    if (match.match_type === 'presell_cta' || match.match_type === 'content_link' || match.match_type === 'checkout_match') {
      // Pages that advertise for/link to the brand = presell/affiliate pages
      presellDomains.push(match.domain);
    } else if (match.match_type === 'redirect') {
      redirectDomains.push(match.domain);
    } else if (match.match_type === 'direct') {
      shopDomains.push(match.domain);
    }
  }

  // Brand's own domain always in final_shop
  if (brandInfo.brand_domain && !shopDomains.includes(brandInfo.brand_domain)) {
    shopDomains.unshift(brandInfo.brand_domain);
  }

  const allDomains = [...new Set([...presellDomains, ...redirectDomains, ...shopDomains])];

  // Build domain_urls: for each domain, include top full URLs from ad captions
  const domain_urls: Record<string, { url: string; count: number }[]> = {};
  const allRelevantDomains = [...new Set([...presellDomains, ...redirectDomains, ...shopDomains])];
  // Also include brand domain if not already present
  if (brandInfo.brand_domain && !allRelevantDomains.includes(brandInfo.brand_domain)) {
    allRelevantDomains.push(brandInfo.brand_domain);
  }

  // Enrich domainFullUrls with redirect chain results from matched domains
  // This adds final_url paths discovered during Step 6 domain checks
  for (const match of matchedDomains) {
    const domainLower = match.domain.toLowerCase();
    // Add final_url if it has a meaningful path
    if (match.final_url) {
      try {
        const parsed = new URL(match.final_url);
        if (parsed.pathname !== '/' && parsed.pathname !== '') {
          if (!domainFullUrls.has(domainLower)) {
            domainFullUrls.set(domainLower, new Map());
          }
          const urlMap = domainFullUrls.get(domainLower)!;
          urlMap.set(match.final_url, (urlMap.get(match.final_url) || 0) + 1);
        }
      } catch { /* skip invalid URLs */ }
    }
    // Add redirect chain URLs that have paths
    for (const chainUrl of match.redirect_chain) {
      try {
        const parsed = new URL(chainUrl);
        const chainDomain = parsed.hostname.replace(/^www\./, '').toLowerCase();
        if (parsed.pathname !== '/' && parsed.pathname !== '' && chainDomain === domainLower) {
          if (!domainFullUrls.has(domainLower)) {
            domainFullUrls.set(domainLower, new Map());
          }
          const urlMap = domainFullUrls.get(domainLower)!;
          urlMap.set(chainUrl, (urlMap.get(chainUrl) || 0) + 1);
        }
      } catch { /* skip invalid URLs */ }
    }
  }

  for (const domain of allRelevantDomains) {
    const urlMap = domainFullUrls.get(domain.toLowerCase());
    if (urlMap && urlMap.size > 0) {
      const urls = [...urlMap.entries()]
        .map(([url, count]) => ({ url, count }))
        .filter(u => {
          // Only include URLs with actual paths (not just base domain)
          try {
            const parsed = new URL(u.url);
            return parsed.pathname !== '/' && parsed.pathname !== '';
          } catch { return false; }
        })
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);
      if (urls.length > 0) {
        domain_urls[domain] = urls;
      }
    }
  }

  // Build top landing pages from matched domains with full URLs where available
  const landingPages: LandingPageInfo[] = matchedDomains
    .filter(m => m.domain)
    .map(m => {
      // Use best available URL: full URL from captions > final_url from redirect > base domain
      const captionUrls = domainFullUrls.get(m.domain.toLowerCase());
      let bestUrl = `https://${m.domain}`;
      let fullPath = '/';
      if (captionUrls && captionUrls.size > 0) {
        // Get the most common full URL with a path
        const sorted = [...captionUrls.entries()]
          .filter(([url]) => { try { return new URL(url).pathname !== '/'; } catch { return false; } })
          .sort((a, b) => b[1] - a[1]);
        if (sorted.length > 0) {
          bestUrl = sorted[0][0];
          try { fullPath = new URL(bestUrl).pathname + new URL(bestUrl).search; } catch { /* keep / */ }
        }
      } else if (m.final_url) {
        try {
          const parsed = new URL(m.final_url);
          if (parsed.pathname !== '/') {
            bestUrl = m.final_url;
            fullPath = parsed.pathname + parsed.search;
          }
        } catch { /* keep base domain */ }
      }
      return {
        url: bestUrl,
        count: m.ad_count,
        domain: m.domain,
        full_path: fullPath,
        leads_to: m.shop_domain || brandInfo.brand_domain || undefined,
        extraction_method: m.match_type,
      };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  const scanDuration = Math.round((Date.now() - startTime) / 1000);

  return {
    success: true,
    status: 'completed',
    brand: brandName,
    brand_domain: brandInfo.brand_domain,
    brand_platform: brandInfo.platform,
    brand_category: brandInfo.brand_category || null,

    pages: {
      official: officialPages,
      third_party: thirdPartyPages,
    },

    domains: {
      presell: presellDomains,
      redirect: redirectDomains,
      final_shop: shopDomains,
      all: allDomains,
    },

    domain_urls,

    top_landing_pages: landingPages,

    presell_chains: matchedDomains
      .filter(m => m.match_type === 'presell_cta' && m.redirect_chain && m.redirect_chain.length > 0)
      .map(m => ({
        presell_domain: m.domain,
        chain: m.redirect_chain || [],
        final_domain: m.shop_domain || brandInfo.brand_domain || '',
      })),

    scan_stats: {
      keywords_used: keywords,
      total_ads_scanned: allAds.length,
      unique_domains_checked: totalDomainsChecked,
      matches_found: matchedDomains.length,
      scan_duration_seconds: scanDuration,
      detection_methods: detectionMethods,
    },
  };
}

// ============================================
// Utility Functions
// ============================================

interface FetchWithRedirectsResult {
  final_url: string;
  chain: string[];
  html: string | null;
}

/**
 * Fetch a URL or domain following all redirects, return final URL + HTML.
 * Accepts either a bare domain (e.g. "example.com") or a full URL (e.g. "https://example.com/path").
 */
async function fetchWithRedirects(
  domainOrUrl: string,
  timeout: number
): Promise<FetchWithRedirectsResult | null> {
  try {
    const startUrl = domainOrUrl.startsWith('http') ? domainOrUrl : `https://${domainOrUrl}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);

    const response = await fetch(startUrl, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
      },
    });

    clearTimeout(timer);

    if (!response.ok) return null;

    const html = await response.text();
    const chain = [startUrl];
    if (response.url !== startUrl && response.url !== `${startUrl}/`) {
      chain.push(response.url);
    }

    return {
      final_url: response.url,
      chain,
      html,
    };
  } catch {
    return null;
  }
}

function extractDomainFromUrl(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

function makeErrorResponse(brand: string, error: string): BrandDiscoveryResponse {
  return {
    success: false,
    status: 'error',
    brand,
    brand_domain: null,
    brand_platform: null,
    pages: { official: [], third_party: [] },
    domains: { presell: [], redirect: [], final_shop: [], all: [] },
    top_landing_pages: [],
    scan_stats: {
      keywords_used: [],
      total_ads_scanned: 0,
      unique_domains_checked: 0,
      matches_found: 0,
      scan_duration_seconds: 0,
      detection_methods: {},
    },
    error,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
