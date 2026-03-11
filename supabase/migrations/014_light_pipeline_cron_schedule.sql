-- Schedule light_pipeline_tick via pg_cron (every minute)
-- Prerequisites: pg_cron must be enabled via Supabase Dashboard > Database > Extensions

SELECT cron.schedule('light-pipeline-tick', '* * * * *', 'SELECT light_pipeline_tick()');
