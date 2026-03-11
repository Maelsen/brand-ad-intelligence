/**
 * Pipeline Status — Edge Function
 *
 * Queries the discovery_jobs table directly from Supabase for batch status.
 * This avoids hitting the Worker for status (1 DB query vs N HTTP requests).
 *
 * POST /pipeline-status
 * Body: { job_ids: string[] }           — poll specific jobs (existing)
 * Body: { load_recent: true }           — load all active + recent jobs (cross-device)
 *
 * Response: { jobs: [{ id, brand, status, progress, started_at, completed_at, error }, ...] }
 */

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

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
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_ANON_KEY');

    if (!supabaseUrl || !supabaseKey) {
      return jsonResponse({ error: 'Supabase not configured' }, 500);
    }

    const supabase = createClient(supabaseUrl, supabaseKey);
    const body = await req.json() as { job_ids?: string[]; load_recent?: boolean };

    const selectFields = 'id, brand, country, status, progress, started_at, completed_at, updated_at, error';

    // Mode 2: Load all recent jobs (cross-device access)
    if (body.load_recent || !body.job_ids?.length) {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

      // Active jobs (queued/running) — no time limit
      const { data: activeJobs, error: err1 } = await supabase
        .from('discovery_jobs')
        .select(selectFields)
        .in('status', ['queued', 'running'])
        .order('created_at', { ascending: false });

      // Recently finished jobs — last 7 days
      const { data: recentDoneJobs, error: err2 } = await supabase
        .from('discovery_jobs')
        .select(selectFields)
        .in('status', ['completed', 'error'])
        .gte('completed_at', sevenDaysAgo)
        .order('completed_at', { ascending: false })
        .limit(200);

      if (err1 || err2) {
        console.error('[pipeline-status] DB query error:', err1 || err2);
        return jsonResponse({ error: (err1 || err2)!.message }, 500);
      }

      const allJobs = [...(activeJobs || []), ...(recentDoneJobs || [])];
      return jsonResponse({ jobs: allJobs });
    }

    // Mode 1: Poll specific job IDs (existing behavior, unchanged)
    const { data: jobs, error } = await supabase
      .from('discovery_jobs')
      .select(selectFields)
      .in('id', body.job_ids);

    if (error) {
      console.error('[pipeline-status] DB query error:', error);
      return jsonResponse({ error: error.message }, 500);
    }

    return jsonResponse({ jobs: jobs || [] });
  } catch (error) {
    console.error('[pipeline-status] Error:', error);
    return jsonResponse({ error: String(error) }, 500);
  }
});
