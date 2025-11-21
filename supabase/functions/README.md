# Supabase Edge Functions

This directory contains Supabase Edge Functions for the restaurant ordering system.

## Deployment Instructions

### Prerequisites
1. Install Supabase CLI: `npm install -g supabase`
2. Login to Supabase: `supabase login`
3. Link to your project: `supabase link --project-ref ujgpqnarhcegrpyzbxej`

### Deploy create-call-log Function

```bash
# Deploy the function
supabase functions deploy create-call-log

# Set environment variables (if not already set)
supabase secrets set SUPABASE_URL=https://ujgpqnarhcegrpyzbxej.supabase.co
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

### Test the Function

```bash
# Test locally
supabase functions serve create-call-log

# Test with curl
curl -X POST https://ujgpqnarhcegrpyzbxej.supabase.co/functions/v1/create-call-log \
  -H "Authorization: Bearer YOUR_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "call_sid": "test123",
    "from_number": "+14435061908",
    "to_number": "+14108880091",
    "call_status": "completed",
    "call_duration": 30
  }'
```

## Function: create-call-log

**Purpose**: UPSERT call logs to prevent duplicates

**Key Features**:
- Uses `call_sid` as unique key
- Supports hybrid logging (WebSocket + Twilio webhook)
- First call creates record, second call updates it
- Returns `action` field indicating insert or update

**UPSERT Behavior**:
- If `call_sid` doesn't exist → INSERT new record
- If `call_sid` exists → UPDATE existing record
- No duplicate entries possible

**Database Requirement**:
The `call_logs` table must have a UNIQUE constraint on `call_sid`:

```sql
ALTER TABLE call_logs ADD CONSTRAINT call_logs_call_sid_key UNIQUE (call_sid);
```

## Version

Current version: v2.9.19 (Hybrid Call Logging with UPSERT)
