-- Disable pg_cron light_pipeline_tick — VPS now self-polls the DB directly
-- pg_net couldn't reach the VPS (5s timeout), so the VPS polls brand_list itself
CREATE OR REPLACE FUNCTION light_pipeline_tick() RETURNS void AS $$
BEGIN
  -- VPS at 89.167.51.0 now polls brand_list directly every 60s
  -- This function is kept as a no-op for backwards compatibility with pg_cron
  NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
