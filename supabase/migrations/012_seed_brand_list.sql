-- Seed brand_list from existing page_ad_cache data
-- All brands that already have Light Pipeline results get imported with light_cached_at set.
-- Also check domain_mapping_cache for discovery completion.

INSERT INTO brand_list (input_name, page_id, page_name, country, light_cached_at, discovery_cached_at)
SELECT DISTINCT ON (pac.page_name, pac.country)
  LOWER(pac.page_name) AS input_name,
  pac.page_id,
  pac.page_name,
  pac.country,
  pac.created_at AS light_cached_at,
  dmc.created_at AS discovery_cached_at
FROM page_ad_cache pac
LEFT JOIN domain_mapping_cache dmc
  ON LOWER(dmc.brand) = LOWER(pac.page_name)
  AND dmc.country = pac.country
WHERE pac.page_name IS NOT NULL
  AND pac.page_name != ''
ON CONFLICT (input_name, country) DO NOTHING;
