-- Brand List — central brand tracking table
-- Stores ALL brands (even before they are cached by any pipeline).
-- light_cached_at / discovery_cached_at track pipeline completion.

CREATE TABLE IF NOT EXISTS brand_list (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  input_name TEXT NOT NULL,
  page_id TEXT,
  page_name TEXT,
  country TEXT DEFAULT 'DE',
  light_cached_at TIMESTAMPTZ,
  discovery_cached_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(input_name, country)
);

CREATE INDEX idx_brand_list_country ON brand_list(country);
CREATE INDEX idx_brand_list_created ON brand_list(created_at DESC);

ALTER TABLE brand_list ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on brand_list"
  ON brand_list FOR ALL
  USING (auth.role() = 'service_role');
