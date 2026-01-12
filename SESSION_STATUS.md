# Session Status - Recording Feature Implementation

**Last Updated:** January 12, 2026

## Current Status: PENDING DEPLOYMENT

### What Was Done:
1. ✅ Twilio REST API recording enabled (starts 1 second after call connects)
2. ✅ `/recording-status` webhook downloads recording from Twilio, uploads to Supabase Storage
3. ✅ Recording filename simplified to `{CallSid}.mp3`
4. ✅ Edge Function updated to handle recording_url without null field errors
5. ✅ Retry logic added (3 attempts, 2s delay) if call_log not ready when recording arrives
6. ✅ `recording_duration` now saved to database (was missing before)
7. ✅ Twilio recording deleted after successful Supabase upload (saves storage costs)
8. ✅ Graceful call ending when customer doesn't want to order (no forced message-taking)
9. ✅ Recording cleanup Edge Function created (auto-delete after 90 days)
10. ✅ `preserve_recording` column added to schema (skip auto-deletion for important calls)

---

## DEPLOYMENT CHECKLIST

### 1. Deploy Edge Function: `create-call-log`
- Copy contents of `supabase/functions/create-call-log/index.ts`
- Paste into Supabase Dashboard → Edge Functions → `create-call-log`
- Click Deploy

### 2. Deploy Edge Function: `cleanup-old-recordings` (NEW)
- Copy contents of `supabase/functions/cleanup-old-recordings/index.ts`
- Paste into Supabase Dashboard → Edge Functions → `cleanup-old-recordings`
- Click Deploy

### 3. Run SQL in Supabase SQL Editor:
```sql
-- Add preserve_recording column
ALTER TABLE call_logs
ADD COLUMN IF NOT EXISTS preserve_recording boolean DEFAULT false;

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;
```

### 4. Schedule Daily Cleanup Job (pg_cron):
See `supabase/RECORDING_CLEANUP_SETUP.sql` for full instructions.

Replace `YOUR_PROJECT_REF` and `YOUR_SERVICE_ROLE_KEY`:
```sql
SELECT cron.schedule(
  'cleanup-old-recordings',
  '0 3 * * *',  -- 3 AM UTC daily
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
```

### 5. Verify Render deployed (should auto-deploy from GitHub push)

---

## How Recording Flow Works:
```
1. Call starts → Twilio recording starts via REST API (1s delay)
2. Call ends → Twilio finishes recording
3. Twilio POSTs to /recording-status webhook
4. Node.js downloads MP3 from Twilio
5. Node.js uploads to Supabase Storage as {CallSid}.mp3
6. Node.js calls Edge Function to update call_logs with recording_url + recording_duration
7. Node.js deletes recording from Twilio (saves Twilio storage costs)
8. If call_log doesn't exist yet, retries 3 times (2s delay each)
```

## How Recording Cleanup Works:
```
1. pg_cron triggers cleanup Edge Function daily at 3 AM UTC
2. Edge Function queries call_logs for:
   - Records older than 90 days
   - Has recording_url (not null)
   - preserve_recording = false (or null)
3. For each matching record:
   - Delete file from Supabase Storage
   - Set recording_url to null in call_logs
4. Logs summary: deleted count, error count
```

## To Preserve a Recording (prevent auto-delete):
```sql
-- Mark specific call to keep forever
UPDATE call_logs SET preserve_recording = true WHERE call_sid = 'CAxxxxx';

-- Mark all calls for a restaurant
UPDATE call_logs SET preserve_recording = true WHERE restaurant_id = 'uuid-here';
```

---

## Files Changed:
- `routes/index.js` - Recording webhook with retry logic + Twilio deletion
- `services/aiInstructions.js` - Graceful call ending without forced messages
- `supabase/functions/create-call-log/index.ts` - Fixed null field issue + recording support
- `supabase/functions/cleanup-old-recordings/index.ts` - NEW: Auto-delete old recordings
- `supabase/schema.sql` - Updated with recording_url, recording_duration, preserve_recording
- `supabase/RECORDING_CLEANUP_SETUP.sql` - NEW: SQL setup guide for pg_cron

---

## Environment Variables Required:
- `TWILIO_RECORDING` = `record-from-answer` or `record-from-answer-dual`
- `BASE_URL` = Your public URL (e.g., https://ring2tech.com)

---

## Test After Deployment:

### Recording Upload Test:
1. Make a test call
2. Check Render logs for:
   - `📹 Recording started:`
   - `📹 Recording status callback:`
   - `✅ Recording uploaded to Supabase:`
   - `✅ Call log updated with recording URL`
   - `🗑️ Deleted recording RExxxx from Twilio`
3. Check Supabase `call_logs` table for `recording_url` and `recording_duration` populated

### Cleanup Test (manual):
```bash
curl -X POST https://YOUR_PROJECT.supabase.co/functions/v1/cleanup-old-recordings \
  -H "Authorization: Bearer YOUR_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json"
```

### Verify pg_cron Job:
```sql
SELECT * FROM cron.job;
SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 10;
```
