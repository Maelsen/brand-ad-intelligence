-- Fix: Add total_reach column to page_ad_cache
-- Previously reach was extracted from JSONB at query time via get_brand_kpis() RPC,
-- but the JSONB extraction was returning 0 for unknown reasons.
-- Solution: store total_reach as a real column, populated during caching.

-- 1. Add column
ALTER TABLE page_ad_cache ADD COLUMN IF NOT EXISTS total_reach BIGINT DEFAULT 0;

-- 2. Backfill from existing JSONB data
UPDATE page_ad_cache
SET total_reach = COALESCE((data->'demographics'->>'total_sample')::bigint, 0)
WHERE total_reach = 0 OR total_reach IS NULL;

-- 3. Recreate get_brand_kpis to use the column directly (much faster, no JSONB parsing)
CREATE OR REPLACE FUNCTION public.get_brand_kpis()
RETURNS TABLE (
  page_id text,
  reach bigint,
  ad_spend bigint,
  ads_count integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT DISTINCT ON (page_id)
    page_id,
    COALESCE(total_reach, 0) as reach,
    0::bigint as ad_spend,
    COALESCE(total_ads, 0) as ads_count
  FROM public.page_ad_cache
  ORDER BY page_id, created_at DESC;
$$;
