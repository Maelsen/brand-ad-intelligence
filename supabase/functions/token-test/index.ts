import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
serve(async () => {
  const tokens = Deno.env.get('META_LIGHT_TOKENS') || '';
  return new Response(JSON.stringify({ tokens }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
