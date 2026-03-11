-- ============================================
-- AI Brand Verification: Extended columns for ai-brand-verifier.ts
-- ============================================

-- 1. Add AI verdict columns to third_party_pages
ALTER TABLE third_party_pages
  ADD COLUMN IF NOT EXISTS ai_verdict TEXT,          -- 'confirmed_false_positive', 'confirmed_match', 'uncertain'
  ADD COLUMN IF NOT EXISTS ai_confidence NUMERIC;    -- 0.0 - 1.0

-- 2. Add audit columns to dismissed_third_party_pages
ALTER TABLE dismissed_third_party_pages
  ADD COLUMN IF NOT EXISTS page_name TEXT,
  ADD COLUMN IF NOT EXISTS connection_type TEXT,
  ADD COLUMN IF NOT EXISTS confidence NUMERIC,
  ADD COLUMN IF NOT EXISTS ai_verdict TEXT,
  ADD COLUMN IF NOT EXISTS ai_confidence NUMERIC;

-- 3. Allow anon DELETE on third_party_pages (for cleanup endpoint)
CREATE POLICY "Allow anon delete on third_party_pages"
  ON third_party_pages FOR DELETE USING (true);
