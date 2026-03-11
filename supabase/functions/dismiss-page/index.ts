/**
 * Dismiss Third-Party Page — Edge Function
 *
 * POST /dismiss-page
 * Body: { brand: string, page_id: string, reason?: string }
 *
 * 1. Insert into dismissed_third_party_pages (permanent)
 * 2. Delete from third_party_pages
 * 3. Update domain_mapping_cache JSONB to remove the page
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
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_ANON_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { brand, page_id, reason } = await req.json();

    if (!brand || !page_id) {
      return jsonResponse({ error: 'brand and page_id required' }, 400);
    }

    const brandLower = brand.toLowerCase().trim();

    // 1. Record dismissal permanently
    const { error: dismissError } = await supabase.from('dismissed_third_party_pages').upsert({
      brand: brandLower,
      page_id,
      reason: reason || null,
      dismissed_at: new Date().toISOString(),
    }, { onConflict: 'brand,page_id' });

    if (dismissError) {
      console.error('[Dismiss] Insert error:', dismissError);
      return jsonResponse({ error: 'Failed to record dismissal' }, 500);
    }

    // 2. Remove from third_party_pages table
    await supabase.from('third_party_pages')
      .delete()
      .eq('brand', brandLower)
      .eq('page_id', page_id);

    // 3. Update domain_mapping_cache JSONB — remove page from pages.third_party
    const { data: cached } = await supabase
      .from('domain_mapping_cache')
      .select('data')
      .eq('brand', brandLower)
      .single();

    if (cached?.data) {
      const cacheData = cached.data as any;
      if (cacheData.pages?.third_party) {
        cacheData.pages.third_party = cacheData.pages.third_party.filter(
          (p: any) => p.page_id !== page_id
        );
        await supabase.from('domain_mapping_cache')
          .update({ data: cacheData })
          .eq('brand', brandLower);
      }
    }

    // 4. Also update discovery_jobs result JSONB (latest completed job for this brand)
    const { data: jobData } = await supabase
      .from('discovery_jobs')
      .select('id, result')
      .eq('brand', brand)
      .eq('status', 'completed')
      .order('completed_at', { ascending: false })
      .limit(1)
      .single();

    if (jobData?.result) {
      const jobResult = jobData.result as any;
      if (jobResult.pages?.third_party) {
        jobResult.pages.third_party = jobResult.pages.third_party.filter(
          (p: any) => p.page_id !== page_id
        );
        await supabase.from('discovery_jobs')
          .update({ result: jobResult })
          .eq('id', jobData.id);
      }
    }

    console.log(`[Dismiss] Dismissed page ${page_id} for brand "${brandLower}"`);
    return jsonResponse({ success: true, brand: brandLower, page_id });

  } catch (error) {
    console.error('[Dismiss] Error:', error);
    return jsonResponse({ error: String(error) }, 500);
  }
});
