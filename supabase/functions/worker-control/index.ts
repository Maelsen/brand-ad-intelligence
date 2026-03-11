/**
 * Worker Control — Edge Function Proxy
 *
 * Proxies control commands to the VPS Worker (pause, resume, cancel, queue status).
 *
 * POST /worker-control
 *   { action: "pause" }    → Pause after current job
 *   { action: "resume" }   → Resume processing
 *   { action: "cancel" }   → Cancel current job + clear queue
 *   { action: "status" }   → Get queue status
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

    const body = await req.json() as { action: string };

    if (!body.action) {
      return jsonResponse({ error: 'action is required (pause, resume, cancel, queue)' }, 400);
    }

    const endpoint = `/api/${body.action}`;
    const isGet = body.action === 'status' || body.action === 'queue' || body.action === 'cleanup-fp/status';
    const method = isGet ? 'GET' : 'POST';

    const workerResponse = await fetch(`${workerUrl}${endpoint}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(workerSecret ? { 'Authorization': `Bearer ${workerSecret}` } : {}),
      },
    });

    const workerData = await workerResponse.json();
    return jsonResponse(workerData, workerResponse.status);
  } catch (error) {
    console.error('[worker-control] Error:', error);
    return jsonResponse({ error: `Worker unreachable: ${String(error)}` }, 502);
  }
});
