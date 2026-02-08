-- Brand Ad Intelligence System - Cache Tables
-- Diese Tabellen speichern API-Ergebnisse für schnelleren Zugriff

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Cache für Brand Search Ergebnisse
CREATE TABLE IF NOT EXISTS brand_search_cache (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    brand TEXT NOT NULL,
    country TEXT NOT NULL DEFAULT 'DE',
    data JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '24 hours'),

    -- Index für schnelle Suche
    CONSTRAINT unique_brand_country UNIQUE (brand, country)
);

-- Cache für Domain Mapping Ergebnisse
CREATE TABLE IF NOT EXISTS domain_mapping_cache (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    brand TEXT NOT NULL,
    country TEXT NOT NULL DEFAULT 'DE',
    data JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '24 hours'),

    -- Index für schnelle Suche
    CONSTRAINT unique_domain_brand_country UNIQUE (brand, country)
);

-- Tabelle für bekannte Landing Pages und deren Redirect-Chains
CREATE TABLE IF NOT EXISTS landing_page_redirects (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    initial_url TEXT NOT NULL UNIQUE,
    final_url TEXT NOT NULL,
    redirect_chain JSONB NOT NULL DEFAULT '[]',
    domain_type TEXT, -- 'presell', 'redirect', 'final_shop'
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Tabelle für Facebook Pages die für bestimmte Brands werben
CREATE TABLE IF NOT EXISTS brand_pages (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    brand TEXT NOT NULL,
    page_id TEXT NOT NULL,
    page_name TEXT,
    ad_count INTEGER DEFAULT 0,
    last_seen TIMESTAMPTZ DEFAULT NOW(),

    CONSTRAINT unique_brand_page UNIQUE (brand, page_id)
);

-- Indizes für bessere Performance
CREATE INDEX IF NOT EXISTS idx_brand_search_cache_brand ON brand_search_cache(brand);
CREATE INDEX IF NOT EXISTS idx_brand_search_cache_expires ON brand_search_cache(expires_at);
CREATE INDEX IF NOT EXISTS idx_domain_mapping_cache_brand ON domain_mapping_cache(brand);
CREATE INDEX IF NOT EXISTS idx_landing_page_redirects_domain ON landing_page_redirects(final_url);
CREATE INDEX IF NOT EXISTS idx_brand_pages_brand ON brand_pages(brand);

-- Funktion zum automatischen Löschen abgelaufener Cache-Einträge
CREATE OR REPLACE FUNCTION cleanup_expired_cache()
RETURNS void AS $$
BEGIN
    DELETE FROM brand_search_cache WHERE expires_at < NOW();
    DELETE FROM domain_mapping_cache WHERE expires_at < NOW();
END;
$$ LANGUAGE plpgsql;

-- Row Level Security (RLS) aktivieren
ALTER TABLE brand_search_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain_mapping_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE landing_page_redirects ENABLE ROW LEVEL SECURITY;
ALTER TABLE brand_pages ENABLE ROW LEVEL SECURITY;

-- Policies für öffentlichen Lesezugriff (da keine User-Auth benötigt)
CREATE POLICY "Allow public read access to brand_search_cache"
    ON brand_search_cache FOR SELECT
    USING (true);

CREATE POLICY "Allow public read access to domain_mapping_cache"
    ON domain_mapping_cache FOR SELECT
    USING (true);

CREATE POLICY "Allow public read access to landing_page_redirects"
    ON landing_page_redirects FOR SELECT
    USING (true);

CREATE POLICY "Allow public read access to brand_pages"
    ON brand_pages FOR SELECT
    USING (true);

-- Service Role kann alles (für Edge Functions)
CREATE POLICY "Allow service role full access to brand_search_cache"
    ON brand_search_cache FOR ALL
    USING (auth.role() = 'service_role');

CREATE POLICY "Allow service role full access to domain_mapping_cache"
    ON domain_mapping_cache FOR ALL
    USING (auth.role() = 'service_role');

CREATE POLICY "Allow service role full access to landing_page_redirects"
    ON landing_page_redirects FOR ALL
    USING (auth.role() = 'service_role');

CREATE POLICY "Allow service role full access to brand_pages"
    ON brand_pages FOR ALL
    USING (auth.role() = 'service_role');
