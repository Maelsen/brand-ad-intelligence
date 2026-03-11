/**
 * Light Batch Status — Edge Function
 *
 * CRUD for light_batches table (cross-device state sharing for quick pipeline).
 * Pattern matches pipeline-status for discovery_jobs.
 *
 * POST /light-batch-status
 *
 * Modes:
 *   { load_recent: true }                          → Load all active + last 30 days
 *   { create: true, id, brands, country }          → Create new batch
 *   { batch_id, update: { results?, ... } }        → Update existing batch
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
    const body = await req.json() as {
      load_recent?: boolean;
      create?: boolean;
      id?: string;
      brands?: string[];
      country?: string;
      batch_id?: string;
      update?: {
        results?: Record<string, unknown>;
        current_index?: number;
        current_brand?: string | null;
        status?: string;
        brands?: string[];
      };
    };

    // ============================================
    // Mode 1: Load recent batches (cross-device)
    // ============================================
    if (body.load_recent) {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

      // Active batches (running) — no time limit
      const { data: activeBatches, error: err1 } = await supabase
        .from('light_batches')
        .select('*')
        .eq('status', 'running')
        .order('created_at', { ascending: false });

      // Recent batches (done/idle) — last 30 days
      const { data: recentBatches, error: err2 } = await supabase
        .from('light_batches')
        .select('*')
        .in('status', ['done', 'idle'])
        .gte('created_at', thirtyDaysAgo)
        .order('created_at', { ascending: false })
        .limit(50);

      if (err1 || err2) {
        console.error('[light-batch-status] DB query error:', err1 || err2);
        return jsonResponse({ error: (err1 || err2)!.message }, 500);
      }

      const allBatches = [...(activeBatches || []), ...(recentBatches || [])];
      return jsonResponse({ batches: allBatches });
    }

    // ============================================
    // Mode 2: Create new batch
    // ============================================
    if (body.create && body.id && body.brands) {
      const { error } = await supabase
        .from('light_batches')
        .insert({
          id: body.id,
          country: body.country || 'DE',
          brands: body.brands,
          results: {},
          current_index: 0,
          status: 'running',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });

      if (error) {
        console.error('[light-batch-status] Insert error:', error);
        return jsonResponse({ error: error.message }, 500);
      }

      return jsonResponse({ success: true, id: body.id });
    }

    // ============================================
    // Mode 3: Update existing batch
    // ============================================
    if (body.batch_id && body.update) {
      const updateData: Record<string, unknown> = {
        updated_at: new Date().toISOString(),
      };

      if (body.update.results !== undefined) updateData.results = body.update.results;
      if (body.update.current_index !== undefined) updateData.current_index = body.update.current_index;
      if (body.update.current_brand !== undefined) updateData.current_brand = body.update.current_brand;
      if (body.update.status !== undefined) updateData.status = body.update.status;
      if (body.update.brands !== undefined) updateData.brands = body.update.brands;

      const { error } = await supabase
        .from('light_batches')
        .update(updateData)
        .eq('id', body.batch_id);

      if (error) {
        console.error('[light-batch-status] Update error:', error);
        return jsonResponse({ error: error.message }, 500);
      }

      return jsonResponse({ success: true });
    }

    return jsonResponse({ error: 'Invalid request — use load_recent, create, or batch_id+update' }, 400);
  } catch (error) {
    console.error('[light-batch-status] Error:', error);
    return jsonResponse({ error: String(error) }, 500);
  }
});
