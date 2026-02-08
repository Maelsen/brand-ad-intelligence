-- Fix: Add anon INSERT/UPDATE policies for domain_mapping_cache
-- Needed because Edge Functions run with --no-verify-jwt (anon role)

-- Drop and recreate to avoid "already exists" errors
DROP POLICY IF EXISTS "Allow anon insert to domain_mapping_cache" ON domain_mapping_cache;
DROP POLICY IF EXISTS "Allow anon update to domain_mapping_cache" ON domain_mapping_cache;
DROP POLICY IF EXISTS "Allow anon insert to brand_search_cache" ON brand_search_cache;
DROP POLICY IF EXISTS "Allow anon update to brand_search_cache" ON brand_search_cache;

-- Anon INSERT for domain_mapping_cache
CREATE POLICY "Allow anon insert to domain_mapping_cache"
    ON domain_mapping_cache FOR INSERT
    WITH CHECK (true);

-- Anon UPDATE for domain_mapping_cache
CREATE POLICY "Allow anon update to domain_mapping_cache"
    ON domain_mapping_cache FOR UPDATE
    USING (true);

-- Anon INSERT for brand_search_cache
CREATE POLICY "Allow anon insert to brand_search_cache"
    ON brand_search_cache FOR INSERT
    WITH CHECK (true);

-- Anon UPDATE for brand_search_cache
CREATE POLICY "Allow anon update to brand_search_cache"
    ON brand_search_cache FOR UPDATE
    USING (true);
