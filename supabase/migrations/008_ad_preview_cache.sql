-- Ad Creative Preview Cache
-- Stores extracted image/video URLs from Facebook ad snapshots.
-- Populated by Worker pipeline (Step 2c), queried by ad-preview Edge Function.

CREATE TABLE IF NOT EXISTS ad_preview_cache (
  ad_id TEXT PRIMARY KEY,
  brand TEXT NOT NULL,
  image_url TEXT,
  video_url TEXT,
  media_type TEXT NOT NULL DEFAULT 'unknown',  -- 'image', 'video', 'unknown'
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '7 days')
);

CREATE INDEX idx_ad_preview_brand ON ad_preview_cache(brand);

-- RLS: allow all access (service role key used by edge functions)
ALTER TABLE ad_preview_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all access to ad_preview_cache" ON ad_preview_cache FOR ALL USING (true) WITH CHECK (true);
