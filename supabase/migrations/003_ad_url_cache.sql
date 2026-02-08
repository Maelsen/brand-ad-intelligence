-- Ad URL Cache - Speichert gescrapte volle URLs
-- Cache-Key: ad_id
-- TTL: 7 Tage

CREATE TABLE IF NOT EXISTS ad_url_cache (
    ad_id TEXT PRIMARY KEY,
    page_id TEXT NOT NULL,
    snapshot_url TEXT,
    domain TEXT,
    full_url TEXT,
    scrape_success BOOLEAN DEFAULT false,
    scrape_error TEXT,
    scraped_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '7 days')
);

-- Indizes
CREATE INDEX IF NOT EXISTS idx_ad_url_cache_page_id ON ad_url_cache(page_id);
CREATE INDEX IF NOT EXISTS idx_ad_url_cache_expires ON ad_url_cache(expires_at);
CREATE INDEX IF NOT EXISTS idx_ad_url_cache_full_url ON ad_url_cache(full_url) WHERE full_url IS NOT NULL;

-- RLS aktivieren
ALTER TABLE ad_url_cache ENABLE ROW LEVEL SECURITY;

-- Öffentlicher Lesezugriff
CREATE POLICY "Allow public read access to ad_url_cache"
    ON ad_url_cache FOR SELECT
    USING (true);

-- Anon-User können schreiben (für Edge Functions)
CREATE POLICY "Allow anon insert to ad_url_cache"
    ON ad_url_cache FOR INSERT
    WITH CHECK (true);

CREATE POLICY "Allow anon update to ad_url_cache"
    ON ad_url_cache FOR UPDATE
    USING (true);

-- Cleanup-Funktion erweitern
CREATE OR REPLACE FUNCTION cleanup_expired_cache()
RETURNS void AS $$
BEGIN
    DELETE FROM brand_search_cache WHERE expires_at < NOW();
    DELETE FROM domain_mapping_cache WHERE expires_at < NOW();
    DELETE FROM page_ad_cache WHERE expires_at < NOW();
    DELETE FROM ad_url_cache WHERE expires_at < NOW();
END;
$$ LANGUAGE plpgsql;
