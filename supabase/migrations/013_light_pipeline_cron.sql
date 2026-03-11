-- Light Pipeline: settings table + tick function
-- pg_cron scheduling is in migration 014 (requires pg_cron extension enabled via Dashboard)

-- Settings table for pipeline flags
CREATE TABLE IF NOT EXISTS pipeline_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT 'false',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO pipeline_settings (key, value) VALUES ('light_pipeline_active', 'false')
ON CONFLICT DO NOTHING;

ALTER TABLE pipeline_settings ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "Service role full access on pipeline_settings"
    ON pipeline_settings FOR ALL
    USING (auth.role() = 'service_role');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Enable pg_net extension (pre-enabled on Supabase Pro)
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- Function that pg_cron calls every minute
CREATE OR REPLACE FUNCTION light_pipeline_tick() RETURNS void AS $$
DECLARE
  is_active BOOLEAN;
  next_brand TEXT;
  next_country TEXT;
BEGIN
  -- Check if pipeline is active
  SELECT (value = 'true') INTO is_active
  FROM pipeline_settings WHERE key = 'light_pipeline_active';

  IF NOT COALESCE(is_active, false) THEN RETURN; END IF;

  -- Find next uncached brand
  SELECT input_name, country INTO next_brand, next_country
  FROM brand_list
  WHERE light_cached_at IS NULL
  ORDER BY created_at ASC, id ASC
  LIMIT 1;

  IF next_brand IS NULL THEN
    -- All done — deactivate pipeline
    UPDATE pipeline_settings SET value = 'false', updated_at = NOW()
    WHERE key = 'light_pipeline_active';
    RETURN;
  END IF;

  -- Call brand-cache-light edge function via pg_net (fire-and-forget)
  PERFORM net.http_post(
    url := 'https://manedsrnsgfunopkaypx.supabase.co/functions/v1/brand-cache-light',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := json_build_object('brand', next_brand, 'country', COALESCE(next_country, 'DE'))::jsonb
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
