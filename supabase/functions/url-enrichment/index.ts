/**
 * URL Enrichment - Edge Function (Enhanced)
 * Extracts FULL landing page URLs with path and UTM parameters
 *
 * Three-stage extraction:
 * 1. HTML Parsing with enhanced patterns (~85% success)
 * 2. ScrapingBee headless browser fallback (~95% with this)
 * 3. Cache results in full_url_cache table
 *
 * POST /url-enrichment
 * Body: { page_id: string, ads: [{ad_id, snapshot_url, domain?}], use_headless?: boolean, clear_cache?: boolean }
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  extractFullUrlWithMetadata,
  extractPathAndQuery,
} from '../../../lib/url-extractor.ts';
import {
  scrapeWithHeadless,
  extractPathAndQuery as headlessExtractPath,
} from '../../../lib/headless-scraper.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const CONCURRENCY = 5;
const HEADLESS_CONCURRENCY = 2; // Lower concurrency for paid API
const MAX_SCRAPINGBEE_ADS = 20; // With Smart Sampling frontend sends ~20 ads total
const DEADLINE_MS = 26000; // Return partial results after 26s (edge function timeout is ~30s)

interface AdInput {
  ad_id: string;
  snapshot_url: string;
  domain?: string;
}

interface EnrichedResult {
  ad_id: string;
  full_url: string | null;
  full_path: string | null;
  domain: string | null;
  extraction_method: string | null;
  confidence: number;
  from_cache: boolean;
}

interface AdDiagnostic {
  ad_id: string;
  stages: string[];  // e.g. ['cache:MISS', 'html:FAIL(http_400)', 'scrapingbee:OK(extract)']
  result: 'success' | 'failed';
  url?: string;
  failure_reason?: string;
}

const platformDomains = ['facebook.com','fb.com','instagram.com','meta.com','meta.ai','fbcdn.net','facebook.net','threads.net'];

function isPlatformUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return platformDomains.some(d => h === d || h.endsWith('.'+d));
  } catch { return true; }
}

function normalizeUrlForGrouping(url: string): string {
  try {
    const parsed = new URL(url);
    // Keep path, remove UTM params for grouping
    const params = new URLSearchParams(parsed.search);
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'gclid'].forEach(p => params.delete(p));
    return `${parsed.origin}${parsed.pathname}${params.toString() ? '?' + params.toString() : ''}`.replace(/\/+$/, '');
  } catch {
    return url;
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();

  try {
    const body = await req.json();
    const { page_id, ads, use_headless = false, clear_cache = false } = body as {
      page_id: string;
      ads: AdInput[];
      use_headless?: boolean;
      clear_cache?: boolean;
    };

    if (!page_id || !ads?.length) {
      return new Response(
        JSON.stringify({ success: false, error: 'page_id and ads required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`[URL] Enriching ${ads.length} ads for page ${page_id} (headless: ${use_headless})`);

    // Get fresh META_ACCESS_TOKEN to replace potentially expired tokens in snapshot URLs
    const metaToken = Deno.env.get('META_ACCESS_TOKEN');

    // Replace expired access_tokens in snapshot URLs with fresh token
    if (metaToken) {
      for (const ad of ads) {
        if (ad.snapshot_url && ad.snapshot_url.includes('access_token=')) {
          // Replace the old token with the fresh one
          ad.snapshot_url = ad.snapshot_url.replace(
            /access_token=[^&]+/,
            `access_token=${metaToken}`
          );
        }
      }
      console.log(`[URL] Refreshed access tokens in ${ads.length} snapshot URLs`);
    }

    // Initialize Supabase client for caching
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_ANON_KEY');
    const supabase = supabaseUrl && supabaseKey
      ? createClient(supabaseUrl, supabaseKey)
      : null;

    // Clear cache if requested
    if (clear_cache && supabase) {
      console.log(`[URL] Clearing cache for page ${page_id}`);
      await supabase.from('full_url_cache').delete().eq('page_id', page_id);
    }

    // Diagnostics tracking
    const diagnostics: AdDiagnostic[] = [];
    let scrapingbeeCredits = 0;

    // Step 1: Check cache for already enriched URLs
    const cachedResults = new Map<string, EnrichedResult>();
    const uncachedAds: AdInput[] = [];

    if (supabase) {
      const adIds = ads.map(a => a.ad_id);
      const { data: cached } = await supabase
        .from('full_url_cache')
        .select('ad_id, final_url, full_path, domain, extraction_method, confidence')
        .in('ad_id', adIds)
        .gt('expires_at', new Date().toISOString());

      if (cached) {
        for (const entry of cached) {
          // Skip cached platform URLs (garbage from before filter was added)
          if (entry.final_url && !isPlatformUrl(entry.final_url)) {
            cachedResults.set(entry.ad_id, {
              ad_id: entry.ad_id,
              full_url: entry.final_url,
              full_path: entry.full_path,
              domain: entry.domain,
              extraction_method: entry.extraction_method,
              confidence: entry.confidence,
              from_cache: true,
            });
          }
        }
      }

      console.log(`[URL] Cache hits: ${cachedResults.size}/${ads.length}`);
    }

    // Separate uncached ads and record cache diagnostics
    for (const ad of ads) {
      if (!cachedResults.has(ad.ad_id)) {
        uncachedAds.push(ad);
      } else {
        diagnostics.push({
          ad_id: ad.ad_id,
          stages: ['cache:HIT'],
          result: 'success',
          url: cachedResults.get(ad.ad_id)!.full_url || undefined,
        });
      }
    }

    // Step 2: Extract URLs for uncached ads (Stage 1: HTML parsing)
    const htmlResults: EnrichedResult[] = [];
    const failedAds: AdInput[] = [];
    let firstDebugInfo: any = null; // Capture debug info from first extraction

    for (let i = 0; i < uncachedAds.length; i += CONCURRENCY) {
      const batch = uncachedAds.slice(i, i + CONCURRENCY);

      const promises = batch.map(async (ad) => {
        const diag: AdDiagnostic = {
          ad_id: ad.ad_id,
          stages: ['cache:MISS'],
          result: 'failed',
        };

        try {
          const result = await extractFullUrlWithMetadata(ad.ad_id, ad.snapshot_url, ad.domain);

          // Capture debug info from first attempt
          if (!firstDebugInfo && (result as any)._debug) {
            firstDebugInfo = (result as any)._debug;
          }

          if (result.scrape_success && result.final_url) {
            // Check if this is a platform URL - treat as failure
            if (isPlatformUrl(result.final_url)) {
              const reason = `platform_url(${new URL(result.final_url).hostname})`;
              diag.stages.push(`html:FAIL(${reason})`);
              diag.failure_reason = reason;
              console.log(`[URL] Ad ${ad.ad_id}: cache=MISS → html=FAIL(${reason})`);
              failedAds.push(ad);
              diagnostics.push(diag);
              return;
            }

            const enriched: EnrichedResult = {
              ad_id: ad.ad_id,
              full_url: result.final_url,
              full_path: result.full_path || extractPathAndQuery(result.final_url),
              domain: result.domain || extractDomainFromUrl(result.final_url),
              extraction_method: result.extraction_method || 'html_parse',
              confidence: result.confidence,
              from_cache: false,
            };
            htmlResults.push(enriched);

            diag.stages.push(`html:OK(${enriched.extraction_method})`);
            diag.result = 'success';
            diag.url = result.final_url;
            console.log(`[URL] Ad ${ad.ad_id}: cache=MISS → html=OK(${enriched.extraction_method}) → ${result.final_url.substring(0, 60)}`);

            // Capture debug info from first success too
            if (!firstDebugInfo) {
              firstDebugInfo = { status: 200, extraction_method: enriched.extraction_method, success: true };
            }

            // Cache successful result
            if (supabase) {
              await supabase.from('full_url_cache').upsert({
                ad_id: ad.ad_id,
                page_id: page_id,
                snapshot_url: ad.snapshot_url,
                domain: enriched.domain,
                extracted_url: result.extracted_url,
                final_url: result.final_url,
                full_path: enriched.full_path,
                redirect_chain: result.redirect_chain,
                extraction_method: enriched.extraction_method,
                confidence: result.confidence,
                scrape_success: true,
                expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
              }, { onConflict: 'ad_id' });
            }
          } else {
            const reason = (result as any)?.error || 'no_url_found';
            diag.stages.push(`html:FAIL(${reason})`);
            diag.failure_reason = reason;
            console.log(`[URL] Ad ${ad.ad_id}: cache=MISS → html=FAIL(${reason})`);
            failedAds.push(ad);
          }
        } catch (error) {
          const reason = `error(${String(error).substring(0, 50)})`;
          diag.stages.push(`html:FAIL(${reason})`);
          diag.failure_reason = reason;
          console.log(`[URL] Ad ${ad.ad_id}: cache=MISS → html=FAIL(${reason})`);
          console.log(`[URL] Error for ad ${ad.ad_id}:`, error);
          failedAds.push(ad);
        }

        diagnostics.push(diag);
      });

      await Promise.all(promises);

      if (i + CONCURRENCY < uncachedAds.length) {
        await new Promise(r => setTimeout(r, 100));
      }
    }

    // Step 3: Use ScrapingBee for failed ads (if enabled and API key exists)
    const headlessResults: EnrichedResult[] = [];
    const scrapingBeeKey = Deno.env.get('SCRAPINGBEE_API_KEY');

    // Limit ScrapingBee to max MAX_SCRAPINGBEE_ADS failed ads
    const adsForScrapingBee = failedAds.slice(0, MAX_SCRAPINGBEE_ADS);

    if (use_headless && scrapingBeeKey && adsForScrapingBee.length > 0) {
      console.log(`[URL] Using ScrapingBee for ${adsForScrapingBee.length} failed ads (limited from ${failedAds.length})`);

      for (let i = 0; i < adsForScrapingBee.length; i += HEADLESS_CONCURRENCY) {
        // Check deadline before starting new batch
        if (Date.now() - startTime > DEADLINE_MS) {
          console.log(`[URL] Deadline reached (${DEADLINE_MS}ms), stopping ScrapingBee after ${i} ads`);
          break;
        }

        const batch = adsForScrapingBee.slice(i, i + HEADLESS_CONCURRENCY);

        const promises = batch.map(async (ad) => {
          // Find existing diagnostic for this ad
          const diag = diagnostics.find(d => d.ad_id === ad.ad_id);

          try {
            const result = await scrapeWithHeadless(ad.snapshot_url, scrapingBeeKey, ad.ad_id);

            if (result.success && result.final_url) {
              // Check if this is a platform URL - treat as failure
              if (isPlatformUrl(result.final_url)) {
                const reason = `platform_url(${new URL(result.final_url).hostname})`;
                if (diag) {
                  diag.stages.push(`scrapingbee:FAIL(${reason})`);
                  diag.failure_reason = reason;
                }
                console.log(`[URL] Ad ${ad.ad_id}: scrapingbee=FAIL(${reason})`);
                scrapingbeeCredits += result.credits_used || 5;
                return;
              }

              const enriched: EnrichedResult = {
                ad_id: ad.ad_id,
                full_url: result.final_url,
                full_path: result.full_path,
                domain: extractDomainFromUrl(result.final_url) || ad.domain,
                extraction_method: result.method,
                confidence: 0.9,
                from_cache: false,
              };
              headlessResults.push(enriched);

              scrapingbeeCredits += result.credits_used || 5;

              if (diag) {
                diag.stages.push(`scrapingbee:OK(${result.method})`);
                diag.result = 'success';
                diag.url = result.final_url;
                diag.failure_reason = undefined;
              }
              console.log(`[URL] Ad ${ad.ad_id}: scrapingbee=OK(${result.method}) → ${result.final_url.substring(0, 60)}`);

              // Cache successful result
              if (supabase) {
                await supabase.from('full_url_cache').upsert({
                  ad_id: ad.ad_id,
                  page_id: page_id,
                  snapshot_url: ad.snapshot_url,
                  domain: enriched.domain,
                  extracted_url: result.url,
                  final_url: result.final_url,
                  full_path: result.full_path,
                  redirect_chain: result.redirect_chain,
                  extraction_method: result.method,
                  confidence: 0.9,
                  scrape_success: true,
                  expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
                }, { onConflict: 'ad_id' });
              }
            } else {
              const reason = (result as any)?.error || 'headless_no_url';
              if (diag) {
                diag.stages.push(`scrapingbee:FAIL(${reason})`);
                diag.failure_reason = reason;
              }
              console.log(`[URL] Ad ${ad.ad_id}: scrapingbee=FAIL(${reason})`);
              scrapingbeeCredits += result.credits_used || 5;
            }
          } catch (error) {
            const reason = `error(${String(error).substring(0, 50)})`;
            if (diag) {
              diag.stages.push(`scrapingbee:FAIL(${reason})`);
              diag.failure_reason = reason;
            }
            console.log(`[URL] Ad ${ad.ad_id}: scrapingbee=FAIL(${reason})`);
            console.log(`[URL] ScrapingBee error for ad ${ad.ad_id}:`, error);
          }
        });

        await Promise.all(promises);

        // Longer delay for paid API
        if (i + HEADLESS_CONCURRENCY < adsForScrapingBee.length) {
          await new Promise(r => setTimeout(r, 500));
        }
      }

      console.log(`[URL] ScrapingBee success: ${headlessResults.length}/${adsForScrapingBee.length} (credits used: ${scrapingbeeCredits})`);
    }

    // Step 4: Combine all results
    const allResults: EnrichedResult[] = [
      ...Array.from(cachedResults.values()),
      ...htmlResults,
      ...headlessResults,
    ];

    // Map results back by ad_id for consistent ordering
    const resultMap = new Map<string, EnrichedResult>();
    for (const r of allResults) {
      resultMap.set(r.ad_id, r);
    }

    const orderedResults = ads.map(ad =>
      resultMap.get(ad.ad_id) || {
        ad_id: ad.ad_id,
        full_url: null,
        full_path: null,
        domain: ad.domain || null,
        extraction_method: null,
        confidence: 0,
        from_cache: false,
      }
    );

    // Step 5: Calculate top landing pages by FULL URL frequency
    // Normalize URLs for grouping (remove UTM params) but keep first full URL for display
    const urlCounts = new Map<string, { count: number; domain: string; full_path: string; display_url: string }>();
    for (const r of orderedResults) {
      if (r.full_url) {
        const normalizedUrl = normalizeUrlForGrouping(r.full_url);
        const existing = urlCounts.get(normalizedUrl);
        if (existing) {
          existing.count++;
        } else {
          urlCounts.set(normalizedUrl, {
            count: 1,
            domain: r.domain || extractDomainFromUrl(r.full_url) || '',
            full_path: r.full_path || extractPathAndQuery(r.full_url) || '/',
            display_url: r.full_url,
          });
        }
      }
    }

    const topLandingPages = Array.from(urlCounts.entries())
      .map(([_normalizedUrl, info]) => ({
        url: info.display_url,
        count: info.count,
        domain: info.domain,
        full_path: info.full_path,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);

    // Stats
    const totalSuccess = orderedResults.filter(r => r.full_url).length;
    const successRate = Math.round((totalSuccess / orderedResults.length) * 100);

    // Summary log with failure reasons
    const failureReasons: Record<string, number> = {};
    for (const d of diagnostics) {
      if (d.failure_reason) failureReasons[d.failure_reason] = (failureReasons[d.failure_reason] || 0) + 1;
    }
    console.log(`[URL] === SUMMARY: ${totalSuccess}/${orderedResults.length} success (${successRate}%) ===`);
    console.log(`[URL] Cache: ${cachedResults.size} | HTML: ${htmlResults.length} | ScrapingBee: ${headlessResults.length} | Failed: ${orderedResults.length - totalSuccess}`);
    console.log(`[URL] Failed reasons:`, JSON.stringify(failureReasons));
    console.log(`[URL] Duration: ${Date.now() - startTime}ms`);

    return new Response(JSON.stringify({
      success: true,
      enriched_count: totalSuccess,
      total_count: orderedResults.length,
      success_rate: successRate,
      scrape_time_ms: Date.now() - startTime,
      breakdown: {
        from_cache: cachedResults.size,
        from_html_parse: htmlResults.length,
        from_headless: headlessResults.length,
        failed: orderedResults.length - totalSuccess,
      },
      urls: orderedResults,
      top_landing_pages: topLandingPages,
      _debug: firstDebugInfo || null,
      _diagnostics: {
        failed_ads: diagnostics.filter(d => d.result === 'failed').slice(0, 10).map(d => ({
          ad_id: d.ad_id,
          reason: d.failure_reason,
          stages: d.stages,
        })),
        scrapingbee_credits_used: scrapingbeeCredits,
        methods_breakdown: {
          from_cache: cachedResults.size,
          from_html_parse: htmlResults.length,
          from_headless: headlessResults.length,
          failed: orderedResults.length - totalSuccess,
        },
      },
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (e) {
    console.error('[URL] Error:', e);
    return new Response(
      JSON.stringify({ success: false, error: String(e) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

function extractDomainFromUrl(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}
