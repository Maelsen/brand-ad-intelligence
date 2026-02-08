-- Page Ad Cache - Speichert Ads pro Facebook Page
-- Cache-Key: page_id + country
-- TTL: 24 Stunden

CREATE TABLE IF NOT EXISTS page_ad_cache (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    page_id TEXT NOT NULL,
    page_name TEXT,
    country TEXT NOT NULL DEFAULT 'DE',
    total_ads INTEGER DEFAULT 0,
    data JSONB NOT NULL,  -- Komplette BrandSearchResponse
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '24 hours'),

    -- Unique constraint für Cache-Lookup
    CONSTRAINT unique_page_country UNIQUE (page_id, country)
);

-- Index für schnellen Lookup
CREATE INDEX IF NOT EXISTS idx_page_ad_cache_page_id ON page_ad_cache(page_id);
CREATE INDEX IF NOT EXISTS idx_page_ad_cache_expires ON page_ad_cache(expires_at);

-- RLS aktivieren
ALTER TABLE page_ad_cache ENABLE ROW LEVEL SECURITY;

-- Öffentlicher Lesezugriff
CREATE POLICY "Allow public read access to page_ad_cache"
    ON page_ad_cache FOR SELECT
    USING (true);

-- Service Role kann alles (für Edge Functions)
CREATE POLICY "Allow service role full access to page_ad_cache"
    ON page_ad_cache FOR ALL
    USING (auth.role() = 'service_role');

-- Anon-User können auch schreiben (für Edge Functions ohne JWT)
CREATE POLICY "Allow anon insert to page_ad_cache"
    ON page_ad_cache FOR INSERT
    WITH CHECK (true);

CREATE POLICY "Allow anon update to page_ad_cache"
    ON page_ad_cache FOR UPDATE
    USING (true);

-- Cleanup-Funktion erweitern
CREATE OR REPLACE FUNCTION cleanup_expired_cache()
RETURNS void AS $$
BEGIN
    DELETE FROM brand_search_cache WHERE expires_at < NOW();
    DELETE FROM domain_mapping_cache WHERE expires_at < NOW();
    DELETE FROM page_ad_cache WHERE expires_at < NOW();
END;
$$ LANGUAGE plpgsql;
