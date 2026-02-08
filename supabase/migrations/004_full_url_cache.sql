-- Full URL Cache - Speichert vollständige Landing Page URLs mit Pfad und UTM-Parametern
-- Im Gegensatz zu ad_url_cache speichert diese Tabelle die KOMPLETTE URL
-- z.B. de.weareholy.com/discount/HOLY?utm_source=facebook&utm_medium=paid

CREATE TABLE IF NOT EXISTS full_url_cache (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    ad_id TEXT NOT NULL,
    page_id TEXT,
    snapshot_url TEXT NOT NULL,
    -- URL-Stufen
    domain TEXT,                     -- Nur Domain (aus ad_creative_link_captions)
    extracted_url TEXT,               -- URL aus HTML-Parsing (Stufe 1)
    final_url TEXT,                   -- Nach allen Redirects (volle URL mit Pfad)
    full_path TEXT,                   -- Nur Pfad + Query params (/discount/HOLY?utm_source=...)
    -- Redirect-Kette
    redirect_chain JSONB DEFAULT '[]',
    -- Metadaten
    extraction_method TEXT,           -- 'html_parse', 'headless_browser', 'http_redirect'
    confidence DECIMAL(3,2) DEFAULT 0,
    scrape_success BOOLEAN DEFAULT false,
    scrape_error TEXT,
    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '7 days'),

    CONSTRAINT unique_full_url_ad_id UNIQUE (ad_id)
);

-- Indizes für schnelle Abfragen
CREATE INDEX IF NOT EXISTS idx_full_url_cache_page ON full_url_cache(page_id);
CREATE INDEX IF NOT EXISTS idx_full_url_cache_domain ON full_url_cache(domain);
CREATE INDEX IF NOT EXISTS idx_full_url_cache_final_url ON full_url_cache(final_url);
CREATE INDEX IF NOT EXISTS idx_full_url_cache_expires ON full_url_cache(expires_at);

-- RLS aktivieren
ALTER TABLE full_url_cache ENABLE ROW LEVEL SECURITY;

-- Public Read
CREATE POLICY "Allow public read access to full_url_cache"
    ON full_url_cache FOR SELECT
    USING (true);

-- Service Role Full Access
CREATE POLICY "Allow service role full access to full_url_cache"
    ON full_url_cache FOR ALL
    USING (auth.role() = 'service_role');

-- Anonymous INSERT/UPDATE für Edge Functions (--no-verify-jwt)
CREATE POLICY "Allow anon insert to full_url_cache"
    ON full_url_cache FOR INSERT
    WITH CHECK (true);

CREATE POLICY "Allow anon update to full_url_cache"
    ON full_url_cache FOR UPDATE
    USING (true);

-- Cleanup-Funktion erweitern
CREATE OR REPLACE FUNCTION cleanup_expired_cache()
RETURNS void AS $$
BEGIN
    DELETE FROM brand_search_cache WHERE expires_at < NOW();
    DELETE FROM domain_mapping_cache WHERE expires_at < NOW();
    DELETE FROM full_url_cache WHERE expires_at < NOW();
END;
$$ LANGUAGE plpgsql;
