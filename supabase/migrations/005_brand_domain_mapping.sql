-- Brand Domain Mapping - Speichert Beziehungen zwischen Brands und Domains
-- Ermöglicht das Finden von Drittseiten (Presell, Affiliate, Redirect)

-- Brand → Domain Beziehungen
CREATE TABLE IF NOT EXISTS brand_domain_mapping (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    brand TEXT NOT NULL,
    domain TEXT NOT NULL,
    domain_type TEXT NOT NULL DEFAULT 'unknown',  -- 'presell', 'redirect', 'shop', 'affiliate', 'unknown'
    confidence DECIMAL(3,2) DEFAULT 0,
    discovered_via TEXT,          -- 'checkout_match', 'redirect_chain', 'content_match', 'domain_match'
    page_id TEXT,                 -- Zugehörige Facebook Page
    page_name TEXT,
    sample_urls JSONB DEFAULT '[]',  -- Beispiel volle URLs
    ad_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    CONSTRAINT unique_brand_domain UNIQUE (brand, domain)
);

CREATE INDEX IF NOT EXISTS idx_brand_domain_brand ON brand_domain_mapping(brand);
CREATE INDEX IF NOT EXISTS idx_brand_domain_domain ON brand_domain_mapping(domain);
CREATE INDEX IF NOT EXISTS idx_brand_domain_type ON brand_domain_mapping(domain_type);

-- Drittseiten-Pages - Facebook Pages die für andere Brands werben
CREATE TABLE IF NOT EXISTS third_party_pages (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    brand TEXT NOT NULL,
    page_id TEXT NOT NULL,
    page_name TEXT NOT NULL,
    connection_type TEXT NOT NULL DEFAULT 'unknown',  -- 'domain_match', 'checkout_match', 'content_match', 'redirect_match'
    confidence DECIMAL(3,2) DEFAULT 0,
    discovered_via TEXT,
    domains_used JSONB DEFAULT '[]',  -- Welche Domains diese Page nutzt
    ad_count INTEGER DEFAULT 0,
    last_seen TIMESTAMPTZ DEFAULT NOW(),

    CONSTRAINT unique_brand_third_party UNIQUE (brand, page_id)
);

CREATE INDEX IF NOT EXISTS idx_third_party_brand ON third_party_pages(brand);
CREATE INDEX IF NOT EXISTS idx_third_party_page ON third_party_pages(page_id);

-- RLS für beide Tabellen
ALTER TABLE brand_domain_mapping ENABLE ROW LEVEL SECURITY;
ALTER TABLE third_party_pages ENABLE ROW LEVEL SECURITY;

-- Public Read
CREATE POLICY "Allow public read access to brand_domain_mapping"
    ON brand_domain_mapping FOR SELECT USING (true);
CREATE POLICY "Allow public read access to third_party_pages"
    ON third_party_pages FOR SELECT USING (true);

-- Service Role Full Access
CREATE POLICY "Allow service role full access to brand_domain_mapping"
    ON brand_domain_mapping FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Allow service role full access to third_party_pages"
    ON third_party_pages FOR ALL USING (auth.role() = 'service_role');

-- Anonymous INSERT/UPDATE/DELETE für Edge Functions
CREATE POLICY "Allow anon insert to brand_domain_mapping"
    ON brand_domain_mapping FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow anon update to brand_domain_mapping"
    ON brand_domain_mapping FOR UPDATE USING (true);
CREATE POLICY "Allow anon insert to third_party_pages"
    ON third_party_pages FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow anon update to third_party_pages"
    ON third_party_pages FOR UPDATE USING (true);
