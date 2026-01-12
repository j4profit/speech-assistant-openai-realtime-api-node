-- =====================================================
-- RECORDING CLEANUP SETUP
-- Run these commands in Supabase SQL Editor
-- =====================================================

-- STEP 1: Add preserve_recording column to call_logs
-- This allows marking specific recordings to keep forever
ALTER TABLE call_logs
ADD COLUMN IF NOT EXISTS preserve_recording boolean DEFAULT false;

-- Add a comment explaining the column
COMMENT ON COLUMN call_logs.preserve_recording IS
  'When true, recording will NOT be auto-deleted by cleanup job. Use for important calls.';

-- =====================================================
-- STEP 2: Enable pg_cron extension (if not already enabled)
-- Go to Supabase Dashboard -> Database -> Extensions -> Enable pg_cron
-- OR run:
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- =====================================================
-- STEP 3: Enable pg_net extension (required to call Edge Functions)
CREATE EXTENSION IF NOT EXISTS pg_net;

-- =====================================================
-- STEP 4: Schedule the cleanup job to run daily at 3 AM UTC
-- This calls the cleanup-old-recordings Edge Function

SELECT cron.schedule(
  'cleanup-old-recordings',           -- job name
  '0 3 * * *',                        -- cron schedule: 3 AM UTC daily
  $$
  SELECT net.http_post(
    url := current_setting('app.settings.supabase_url') || '/functions/v1/cleanup-old-recordings',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);

-- =====================================================
-- ALTERNATIVE: If app.settings aren't configured, use this with hardcoded values
-- Replace YOUR_PROJECT_REF and YOUR_SERVICE_ROLE_KEY with actual values

/*
SELECT cron.schedule(
  'cleanup-old-recordings',
  '0 3 * * *',
  $$
  SELECT net.http_post(
    url := 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/cleanup-old-recordings',
    headers := jsonb_build_object(
      'Authorization', 'Bearer YOUR_SERVICE_ROLE_KEY',
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);
*/

-- =====================================================
-- USEFUL COMMANDS
-- =====================================================

-- View all scheduled jobs:
SELECT * FROM cron.job;

-- View job run history:
SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 20;

-- Manually run the cleanup (for testing):
-- Just call the Edge Function directly from your app or via curl

-- Unschedule the job if needed:
-- SELECT cron.unschedule('cleanup-old-recordings');

-- =====================================================
-- MARK A RECORDING TO PRESERVE (don't auto-delete)
-- =====================================================

-- Mark a specific call's recording to keep forever:
-- UPDATE call_logs SET preserve_recording = true WHERE call_sid = 'CAxxxxx';

-- Mark all recordings for a specific restaurant to keep:
-- UPDATE call_logs SET preserve_recording = true WHERE restaurant_id = 'uuid-here';

-- View all preserved recordings:
-- SELECT call_sid, created_at, recording_url FROM call_logs WHERE preserve_recording = true;
