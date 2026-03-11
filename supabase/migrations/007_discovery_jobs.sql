-- ============================================
-- Discovery Jobs: Persistent job tracking for crash-resume
-- ============================================

CREATE TABLE IF NOT EXISTS discovery_jobs (
  id TEXT PRIMARY KEY,                    -- job_1234567890_abc123
  brand TEXT NOT NULL,
  country TEXT DEFAULT 'DE',
  request JSONB NOT NULL,                 -- Original BrandDiscoveryRequest
  status TEXT NOT NULL DEFAULT 'queued',  -- queued | running | completed | error
  progress TEXT DEFAULT 'Queued',

  -- Checkpoint data for resume after crash
  checkpoint JSONB DEFAULT '{}',          -- { step: '6', domains_checked: 45, total_domains: 387 }
  partial_result JSONB,                   -- Intermediate matches found so far

  -- Timing
  created_at TIMESTAMPTZ DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,

  -- Results
  result JSONB,                           -- Final BrandDiscoveryResponse
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_discovery_jobs_status ON discovery_jobs(status);
CREATE INDEX IF NOT EXISTS idx_discovery_jobs_brand ON discovery_jobs(brand);

-- RLS: Allow service role full access
ALTER TABLE discovery_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access on discovery_jobs"
  ON discovery_jobs FOR ALL
  USING (true)
  WITH CHECK (true);

-- ============================================
-- Domain Check Cache: Cache Step 6 domain verification results
-- ============================================

CREATE TABLE IF NOT EXISTS domain_check_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand TEXT NOT NULL,
  domain TEXT NOT NULL,
  is_match BOOLEAN NOT NULL,
  match_type TEXT,
  confidence DECIMAL(3,2) DEFAULT 0,
  check_result JSONB NOT NULL,            -- Full DomainBrandCheck object
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '7 days'),
  CONSTRAINT unique_domain_check UNIQUE (brand, domain)
);

CREATE INDEX IF NOT EXISTS idx_domain_check_brand ON domain_check_cache(brand);
CREATE INDEX IF NOT EXISTS idx_domain_check_expires ON domain_check_cache(expires_at);

-- RLS: Allow service role full access
ALTER TABLE domain_check_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access on domain_check_cache"
  ON domain_check_cache FOR ALL
  USING (true)
  WITH CHECK (true);

-- ============================================
-- Cleanup function for expired entries
-- ============================================

CREATE OR REPLACE FUNCTION cleanup_expired_discovery_data()
RETURNS void AS $$
BEGIN
  -- Clean expired domain check cache
  DELETE FROM domain_check_cache WHERE expires_at < NOW();
  -- Clean old completed/error jobs (older than 30 days)
  DELETE FROM discovery_jobs WHERE status IN ('completed', 'error') AND completed_at < NOW() - INTERVAL '30 days';
END;
$$ LANGUAGE plpgsql;
