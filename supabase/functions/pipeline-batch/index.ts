/**
 * Pipeline Batch — Edge Function Gateway
 *
 * Receives a list of brand names and forwards them to the VPS Worker's /api/batch endpoint.
 *
 * POST /pipeline-batch
 * Body: { brands: string[], country?: string }
 *
 * Response: { status: "queued", total: N, job_ids: [...], queue_length: N }
 */

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

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

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  try {
    const workerUrl = Deno.env.get('WORKER_URL');
    const workerSecret = Deno.env.get('WORKER_API_SECRET');

    if (!workerUrl) {
      return jsonResponse({ error: 'WORKER_URL not configured' }, 500);
    }

    const body = await req.json() as { brands?: Array<string | { brand: string; page_id?: string }>; country?: string };

    if (!body.brands?.length) {
      return jsonResponse({ error: 'brands array is required' }, 400);
    }

    const country = body.country || 'DE';

    // Transform into BrandDiscoveryRequest[] for the Worker
    // Supports both string[] (backward compat) and {brand, page_id}[]
    const brandRequests = body.brands.map((entry) => {
      if (typeof entry === 'string') {
        return { brand: entry, country, use_headless: true };
      }
      return { brand: entry.brand, page_id: entry.page_id, country, use_headless: true };
    });

    console.log(`[pipeline-batch] Forwarding ${brandRequests.length} brands to Worker...`);

    const workerResponse = await fetch(`${workerUrl}/api/batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(workerSecret ? { 'Authorization': `Bearer ${workerSecret}` } : {}),
      },
      body: JSON.stringify({ brands: brandRequests }),
    });

    const workerData = await workerResponse.json();

    console.log(`[pipeline-batch] Worker response: ${workerResponse.status}, ${JSON.stringify(workerData).substring(0, 200)}`);

    return jsonResponse(workerData, workerResponse.status);
  } catch (error) {
    console.error('[pipeline-batch] Error:', error);
    return jsonResponse({ error: String(error) }, 500);
  }
});
