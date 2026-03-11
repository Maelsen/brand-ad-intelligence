-- ============================================
-- False Positive Detection: AI flags + User dismissals
-- ============================================

-- 1. Add flagging columns to third_party_pages
ALTER TABLE third_party_pages
  ADD COLUMN IF NOT EXISTS flagged_suspicious BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS flag_reason TEXT;

-- 2. Dismissed pages table (permanent user dismissals)
CREATE TABLE IF NOT EXISTS dismissed_third_party_pages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand TEXT NOT NULL,
  page_id TEXT NOT NULL,
  dismissed_at TIMESTAMPTZ DEFAULT NOW(),
  reason TEXT,
  CONSTRAINT unique_dismissed_brand_page UNIQUE (brand, page_id)
);

CREATE INDEX IF NOT EXISTS idx_dismissed_brand ON dismissed_third_party_pages(brand);

-- RLS: Allow all access (service role + anon for frontend)
ALTER TABLE dismissed_third_party_pages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access on dismissed_third_party_pages"
  ON dismissed_third_party_pages FOR ALL
  USING (true)
  WITH CHECK (true);
