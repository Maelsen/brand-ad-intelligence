/**
 * Brand List — Edge Function
 *
 * CRUD for brand_list table + status enrichment from cache tables.
 *
 * POST /brand-list
 *
 * Modes:
 *   { load_all: true, country? }                    → Load all brands with pipeline status
 *   { add_brands: [{name, country?}] }              → Insert brands (upsert)
 *   { remove_brand: id }                            → Delete brand
 *   { update_brand: {id, ...fields} }               → Update brand fields
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
    const body = await req.json();

    // ============================================
    // Mode 1: Load all brands with pipeline status
    // ============================================
    if (body.load_all) {
      const countryFilter = body.country;

      // 1. Load all brands from brand_list
      let query = supabase
        .from('brand_list')
        .select('*')
        .order('created_at', { ascending: false });

      if (countryFilter) {
        query = query.eq('country', countryFilter);
      }

      const { data: brands, error: err1 } = await query;

      if (err1) {
        console.error('[brand-list] DB query error:', err1);
        return jsonResponse({ error: err1.message }, 500);
      }

      // 2. Get KPIs from page_ad_cache for brands that have page_id
      const pageIds = (brands || []).filter(b => b.page_id).map(b => b.page_id);
      let kpiMap: Record<string, { total_ads: number }> = {};

      if (pageIds.length > 0) {
        const { data: pacRows } = await supabase
          .from('page_ad_cache')
          .select('page_id, total_ads')
          .in('page_id', pageIds);

        if (pacRows) {
          for (const row of pacRows) {
            kpiMap[row.page_id] = { total_ads: row.total_ads || 0 };
          }
        }
      }

      // 3. Get reach KPIs via RPC
      let reachMap: Record<string, number> = {};
      const { data: kpiRows } = await supabase.rpc('get_brand_kpis');
      if (kpiRows) {
        for (const kpi of kpiRows as any[]) {
          reachMap[kpi.page_id] = kpi.reach || 0;
        }
      }

      // 4. Get discovery job status for brands without discovery_cached_at
      const uncachedBrands = (brands || []).filter(b => !b.discovery_cached_at);
      let jobMap: Record<string, { status: string; progress: string }> = {};

      if (uncachedBrands.length > 0) {
        const brandNames = uncachedBrands.map(b => (b.page_name || b.input_name).toLowerCase());
        const { data: jobs } = await supabase
          .from('discovery_jobs')
          .select('brand, status, progress')
          .in('brand', brandNames)
          .in('status', ['queued', 'running'])
          .order('created_at', { ascending: false });

        if (jobs) {
          for (const job of jobs) {
            if (!jobMap[job.brand]) {
              jobMap[job.brand] = { status: job.status, progress: job.progress };
            }
          }
        }
      }

      // 5. Enrich brands with KPIs and status
      const enriched = (brands || []).map(brand => {
        const pac = brand.page_id ? kpiMap[brand.page_id] : null;
        const reach = brand.page_id ? (reachMap[brand.page_id] || 0) : 0;
        const brandKey = (brand.page_name || brand.input_name).toLowerCase();
        const discoveryJob = jobMap[brandKey];

        return {
          ...brand,
          display_name: brand.page_name || brand.input_name,
          total_ads: pac?.total_ads || 0,
          reach,
          light_done: !!brand.light_cached_at,
          discovery_done: !!brand.discovery_cached_at,
          discovery_status: discoveryJob?.status || null,
          discovery_progress: discoveryJob?.progress || null,
        };
      });

      return jsonResponse({ brands: enriched });
    }

    // ============================================
    // Mode 2: Add brands (upsert)
    // ============================================
    if (body.add_brands && Array.isArray(body.add_brands)) {
      const rows = body.add_brands.map((entry: { name: string; country?: string }) => ({
        input_name: entry.name.trim().toLowerCase(),
        country: entry.country || body.country || 'DE',
      }));

      // Deduplicate within this batch (same name+country → keep first)
      const seen = new Set<string>();
      const uniqueRows = rows.filter((r: { input_name: string; country: string }) => {
        const key = `${r.input_name}|${r.country}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      const { data, error } = await supabase
        .from('brand_list')
        .upsert(uniqueRows, { onConflict: 'input_name,country', ignoreDuplicates: true })
        .select();

      if (error) {
        console.error('[brand-list] Insert error:', error);
        return jsonResponse({ error: error.message }, 500);
      }

      return jsonResponse({ success: true, added: data?.length || 0 });
    }

    // ============================================
    // Mode 3: Remove brand
    // ============================================
    if (body.remove_brand) {
      const { error } = await supabase
        .from('brand_list')
        .delete()
        .eq('id', body.remove_brand);

      if (error) {
        console.error('[brand-list] Delete error:', error);
        return jsonResponse({ error: error.message }, 500);
      }

      return jsonResponse({ success: true });
    }

    // ============================================
    // Mode 4: Update brand
    // ============================================
    if (body.update_brand) {
      const { id, ...fields } = body.update_brand;
      if (!id) return jsonResponse({ error: 'update_brand.id required' }, 400);

      const { error } = await supabase
        .from('brand_list')
        .update(fields)
        .eq('id', id);

      if (error) {
        console.error('[brand-list] Update error:', error);
        return jsonResponse({ error: error.message }, 500);
      }

      return jsonResponse({ success: true });
    }

    // ============================================
    // Mode 5: Light Pipeline Start
    // ============================================
    if (body.light_start) {
      await supabase
        .from('pipeline_settings')
        .upsert({ key: 'light_pipeline_active', value: 'true', updated_at: new Date().toISOString() });

      // Count remaining
      const { count } = await supabase
        .from('brand_list')
        .select('id', { count: 'exact', head: true })
        .is('light_cached_at', null);

      console.log(`[brand-list] Light pipeline started (${count || 0} brands remaining)`);
      return jsonResponse({ success: true, active: true, remaining: count || 0 });
    }

    // ============================================
    // Mode 6: Light Pipeline Stop
    // ============================================
    if (body.light_stop) {
      await supabase
        .from('pipeline_settings')
        .upsert({ key: 'light_pipeline_active', value: 'false', updated_at: new Date().toISOString() });

      console.log('[brand-list] Light pipeline stopped');
      return jsonResponse({ success: true, active: false });
    }

    // ============================================
    // Mode 7: Light Pipeline Status
    // ============================================
    if (body.light_status) {
      const { data: setting } = await supabase
        .from('pipeline_settings')
        .select('value, updated_at')
        .eq('key', 'light_pipeline_active')
        .maybeSingle();

      const active = setting?.value === 'true';

      const { count: totalCount } = await supabase
        .from('brand_list')
        .select('id', { count: 'exact', head: true });

      const { count: cachedCount } = await supabase
        .from('brand_list')
        .select('id', { count: 'exact', head: true })
        .not('light_cached_at', 'is', null);

      const { count: remainingCount } = await supabase
        .from('brand_list')
        .select('id', { count: 'exact', head: true })
        .is('light_cached_at', null);

      return jsonResponse({
        active,
        total: totalCount || 0,
        cached: cachedCount || 0,
        remaining: remainingCount || 0,
        updated_at: setting?.updated_at || null,
      });
    }

    return jsonResponse({ error: 'Invalid request' }, 400);
  } catch (error) {
    console.error('[brand-list] Error:', error);
    return jsonResponse({ error: String(error) }, 500);
  }
});
