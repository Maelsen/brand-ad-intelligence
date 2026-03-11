-- Light Pipeline Batches — cross-device state sharing
-- Stores batch definition, progress, and results so any device can see the status.

CREATE TABLE IF NOT EXISTS light_batches (
  id TEXT PRIMARY KEY,
  country TEXT DEFAULT 'DE',
  brands TEXT[] NOT NULL,
  results JSONB DEFAULT '{}',
  current_index INTEGER DEFAULT -1,
  current_brand TEXT,
  status TEXT DEFAULT 'idle',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_light_batches_status ON light_batches(status);
CREATE INDEX idx_light_batches_created ON light_batches(created_at DESC);

ALTER TABLE light_batches ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on light_batches"
  ON light_batches FOR ALL
  USING (auth.role() = 'service_role');
