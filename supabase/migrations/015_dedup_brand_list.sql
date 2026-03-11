-- Deduplicate brand_list: merge duplicates, normalize input_name, add case-insensitive unique index

-- Step 1: Merge duplicates (keep oldest entry, enrich with newer data, delete rest)
DO $$
DECLARE
  rec RECORD;
  keep_id UUID;
  best_page_id TEXT;
  best_page_name TEXT;
  best_light TIMESTAMPTZ;
  best_discovery TIMESTAMPTZ;
BEGIN
  FOR rec IN
    SELECT LOWER(TRIM(input_name)) AS norm_name, country
    FROM brand_list
    GROUP BY LOWER(TRIM(input_name)), country
    HAVING COUNT(*) > 1
  LOOP
    -- Get the oldest entry's id (the one we keep)
    SELECT id INTO keep_id
    FROM brand_list
    WHERE LOWER(TRIM(input_name)) = rec.norm_name AND country = rec.country
    ORDER BY created_at ASC
    LIMIT 1;

    -- Get best page_id (first non-null)
    SELECT page_id INTO best_page_id
    FROM brand_list
    WHERE LOWER(TRIM(input_name)) = rec.norm_name AND country = rec.country
      AND page_id IS NOT NULL
    ORDER BY created_at DESC
    LIMIT 1;

    -- Get best page_name (first non-null)
    SELECT page_name INTO best_page_name
    FROM brand_list
    WHERE LOWER(TRIM(input_name)) = rec.norm_name AND country = rec.country
      AND page_name IS NOT NULL
    ORDER BY created_at DESC
    LIMIT 1;

    -- Get earliest light_cached_at that is set
    SELECT MIN(light_cached_at) INTO best_light
    FROM brand_list
    WHERE LOWER(TRIM(input_name)) = rec.norm_name AND country = rec.country
      AND light_cached_at IS NOT NULL;

    -- Get earliest discovery_cached_at that is set
    SELECT MIN(discovery_cached_at) INTO best_discovery
    FROM brand_list
    WHERE LOWER(TRIM(input_name)) = rec.norm_name AND country = rec.country
      AND discovery_cached_at IS NOT NULL;

    -- Update the keeper with best data
    UPDATE brand_list SET
      page_id = COALESCE(best_page_id, page_id),
      page_name = COALESCE(best_page_name, page_name),
      light_cached_at = best_light,
      discovery_cached_at = best_discovery
    WHERE id = keep_id;

    -- Delete all duplicates except the keeper
    DELETE FROM brand_list
    WHERE LOWER(TRIM(input_name)) = rec.norm_name
      AND country = rec.country
      AND id != keep_id;

    RAISE NOTICE 'Merged duplicates for "%" (country=%)', rec.norm_name, rec.country;
  END LOOP;
END $$;

-- Step 2: Normalize all input_name to lowercase trimmed
UPDATE brand_list SET input_name = LOWER(TRIM(input_name))
WHERE input_name != LOWER(TRIM(input_name));

-- Step 3: Create case-insensitive unique index (prevents future duplicates even without lowercase)
CREATE UNIQUE INDEX IF NOT EXISTS idx_brand_list_ci_unique
  ON brand_list (LOWER(TRIM(input_name)), country);
