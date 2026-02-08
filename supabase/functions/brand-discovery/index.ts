/**
 * Brand Discovery — Edge Function Gateway
 *
 * API Gateway that:
 * 1. Checks cache → returns immediately if valid
 * 2. If no cache → forwards request to VPS Worker
 * 3. Returns job_id for polling
 *
 * Can also run the pipeline DIRECTLY for small/quick scans
 * when WORKER_URL is not configured.
 *
 * POST /brand-discovery
 * Body: { brand: string, country?: string, keywords?: string[], use_headless?: boolean }
 *
 * Response (cached):
 *   { success: true, status: "cached", brand: "MiaVola", ... }
 *
 * Response (processing):
 *   { success: true, status: "processing", job_id: "job_123..." }
 *
 * GET /brand-discovery?job_id=xxx
 *   Returns job status from worker
 */

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { discoverBrand } from '../../../lib/brand-discovery.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_ANON_KEY');
    const metaToken = Deno.env.get('META_ACCESS_TOKEN');
    const workerUrl = Deno.env.get('WORKER_URL');         // e.g., "http://your-vps:8787"
    const workerSecret = Deno.env.get('WORKER_API_SECRET');
    const scrapingBeeKey = Deno.env.get('SCRAPINGBEE_API_KEY');
    const openaiKey = Deno.env.get('OPENAI_API_KEY');

    const supabase = supabaseUrl && supabaseKey
      ? createClient(supabaseUrl, supabaseKey)
      : null;

    // ============================================
    // GET: Poll job status
    // ============================================
    if (req.method === 'GET') {
      const url = new URL(req.url);
      const jobId = url.searchParams.get('job_id');

      if (!jobId) {
        return jsonResponse({ error: 'job_id parameter required' }, 400);
      }

      if (!workerUrl) {
        return jsonResponse({ error: 'Worker not configured' }, 500);
      }

      // Forward status request to worker
      try {
        const statusResponse = await fetch(`${workerUrl}/api/status/${jobId}`, {
          headers: workerSecret ? { 'Authorization': `Bearer ${workerSecret}` } : {},
        });

        const statusData = await statusResponse.json();
        return jsonResponse(statusData);
      } catch (error) {
        return jsonResponse({ error: `Worker unreachable: ${String(error)}` }, 502);
      }
    }

    // ============================================
    // POST: Start discovery
    // ============================================
    if (req.method === 'POST') {
      const body = await req.json();
      const { brand, country, countries, keywords, use_headless, max_keyword_ads, force_refresh, mode } = body;

      if (!brand) {
        return jsonResponse({ error: 'brand is required' }, 400);
      }

      // mode: 'quick' = direct edge function execution (skip worker)
      // mode: 'deep' or unset = use worker if available
      const useWorker = mode !== 'quick';

      if (!metaToken) {
        return jsonResponse({ error: 'META_ACCESS_TOKEN not configured' }, 500);
      }

      const brandLower = brand.toLowerCase().trim();

      // ----------------------------------------
      // Step 1: Check cache (skip if force_refresh)
      // ----------------------------------------
      const effectiveCountry = country || 'DE';

      if (supabase && !force_refresh) {
        const { data: cached } = await supabase
          .from('domain_mapping_cache')
          .select('data, expires_at')
          .eq('brand', brandLower)
          .eq('country', effectiveCountry)
          .gt('expires_at', new Date().toISOString())
          .single();

        if (cached?.data) {
          console.log(`[Discovery] Cache hit for "${brand}"`);
          return jsonResponse({
            ...cached.data,
            status: 'cached',
          });
        }
      }

      // ----------------------------------------
      // Step 2: Forward to worker (if configured)
      // ----------------------------------------
      if (workerUrl && useWorker) {
        try {
          const workerResponse = await fetch(`${workerUrl}/api/discover`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(workerSecret ? { 'Authorization': `Bearer ${workerSecret}` } : {}),
            },
            body: JSON.stringify({ brand, country, countries, keywords, use_headless, max_keyword_ads, force_refresh }),
          });

          const workerData = await workerResponse.json();
          return jsonResponse(workerData, workerResponse.status);
        } catch (error) {
          console.log(`[Discovery] Worker unreachable, falling back to direct execution: ${error}`);
          // Fall through to direct execution
        }
      }

      // ----------------------------------------
      // Step 3: Direct execution (no worker / worker down)
      // Edge Function has 30s timeout — this only works for
      // brands with few keywords and domains
      // ----------------------------------------
      console.log(`[Discovery] Running direct discovery for "${brand}" (no worker)`);

      const result = await discoverBrand(brand, {
        country: country || 'DE',
        countries: countries || [country || 'DE'],
        keywords,
        max_keyword_ads: max_keyword_ads || 50,   // Edge fn: tight limit (50 per keyword)
        max_keywords: 3,                            // Edge fn: 3 keywords max
        max_brand_ads: 200,                         // Edge fn: 200 brand ads (was 300)
        max_domains_to_check: 15,                   // Edge fn: max 15 domains to brand-check
        use_headless: use_headless && !!scrapingBeeKey,
        use_headless_for_domains: use_headless && !!scrapingBeeKey, // Enable ScrapingBee for domain checks when requested
        access_token: metaToken,
        scrapingbee_key: scrapingBeeKey || undefined,
        openai_key: openaiKey || undefined,
        timeout_ms: 50000,                          // 50s hard deadline (Supabase Pro = 60s)
        onProgress: (step, detail) => {
          console.log(`[Discovery] ${step}: ${detail}`);
        },
      });

      // Store in cache
      if (supabase && result.success) {
        await supabase.from('domain_mapping_cache').upsert({
          brand: brandLower,
          country: effectiveCountry,
          data: result,
          created_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        }, { onConflict: 'brand,country' });
      }

      return jsonResponse(result);
    }

    return jsonResponse({ error: 'Method not allowed' }, 405);

  } catch (error) {
    console.error('[Discovery] Error:', error);
    return jsonResponse({
      success: false,
      status: 'error',
      error: String(error),
    }, 500);
  }
});

function jsonResponse(data: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
