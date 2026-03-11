/**
 * Ad Creative Preview Cache Lookup — Edge Function
 *
 * POST /ad-preview
 * Body: { ad_ids: string[] }   (max 300, fetched in batches)
 * Returns: { previews: { [ad_id]: { image_url, video_url, type } } }
 *
 * Pure DB lookup — NO rendering. Previews are cached by the Worker
 * pipeline during brand discovery (Step 2c in browser-renderer).
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await req.json();
    const adIds: string[] = body.ad_ids || [];

    if (!adIds.length) {
      return new Response(JSON.stringify({ error: 'ad_ids array required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') || '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
    );

    // Limit to 300 IDs, fetch in batches of 150 (safe for PostgREST .in())
    const limitedIds = adIds.slice(0, 300);
    const BATCH_SIZE = 150;
    const allRows: any[] = [];

    for (let i = 0; i < limitedIds.length; i += BATCH_SIZE) {
      const batch = limitedIds.slice(i, i + BATCH_SIZE);
      const { data, error } = await supabase
        .from('ad_preview_cache')
        .select('ad_id, image_url, video_url, media_type')
        .in('ad_id', batch);

      if (error) {
        console.log(`[ad-preview] DB error (batch ${i}): ${error.message}`);
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      if (data) allRows.push(...data);
    }

    const previews: Record<string, { image_url: string | null; video_url: string | null; type: string }> = {};
    allRows.forEach((row: any) => {
      previews[row.ad_id] = {
        image_url: row.image_url,
        video_url: row.video_url,
        type: row.media_type,
      };
    });

    console.log(`[ad-preview] Returned ${Object.keys(previews).length}/${limitedIds.length} cached previews`);

    return new Response(JSON.stringify({ previews }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
