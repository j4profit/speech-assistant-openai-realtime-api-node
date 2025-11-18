# Call Log Balance Tracking

## Overview

The `call_logs` table now includes a `balance_after_call` field that records the restaurant's remaining balance (in minutes) after each call deduction. This provides a complete audit trail for billing and accounting purposes.

## What Was Added

### Database Field

**Table:** `call_logs`
**New Column:** `balance_after_call` (NUMERIC)

This field stores the value of `restaurant_balances.current_balance_minutes` immediately after the call minutes are deducted.

### How It Works

```
1. Call completes
   ↓
2. Twilio webhook calls create-call-log edge function
   ↓
3. Edge function deducts minutes from restaurant_balances.total_used_minutes
   ↓
4. Edge function fetches updated restaurant_balances.current_balance_minutes
   ↓
5. Edge function saves balance to call_logs.balance_after_call
   ↓
6. Complete audit trail created
```

### Example Data

| call_sid | restaurant_id | call_duration | minutes_billed | balance_after_call |
|----------|---------------|---------------|----------------|-------------------|
| CA123... | rest-uuid-1   | 127           | 3              | 297.0             |
| CA124... | rest-uuid-1   | 65            | 2              | 295.0             |
| CA125... | rest-uuid-1   | 180           | 3              | 292.0             |

This shows the restaurant started with 300 minutes, and you can track the balance decreasing with each call.

## Deployment Steps

### Step 1: Run Database Migration

Run this SQL in your Supabase SQL Editor:

```sql
-- Add balance tracking field to call_logs table
ALTER TABLE public.call_logs
ADD COLUMN balance_after_call NUMERIC;

-- Add helpful comment
COMMENT ON COLUMN public.call_logs.balance_after_call IS 'Restaurant balance (in minutes) remaining after this call was deducted from restaurant_balances.current_balance_minutes';

-- Create index for balance queries
CREATE INDEX IF NOT EXISTS idx_call_logs_balance_after_call ON public.call_logs(balance_after_call);
```

Or use the migration file:
```bash
# The SQL is saved in:
supabase/migrations/add_balance_tracking_to_call_logs.sql
```

### Step 2: Deploy Updated Edge Function

The `create-call-log` edge function has been updated to fetch and save the balance.

**Using Supabase CLI:**
```bash
supabase functions deploy create-call-log
```

**Using Supabase Dashboard:**
1. Go to Edge Functions → create-call-log
2. Copy contents from `supabase/functions/create-call-log/index.ts`
3. Paste and deploy

### Step 3: Verify

After deployment, make a test call and check:

```sql
SELECT
  call_sid,
  call_duration,
  minutes_billed,
  balance_after_call,
  billing_status,
  billing_processed_at
FROM call_logs
ORDER BY created_at DESC
LIMIT 5;
```

You should see `balance_after_call` populated for billed calls.

## Use Cases

### 1. Balance Audit Trail

Track exactly when and how the restaurant's balance decreased:

```sql
SELECT
  created_at,
  call_duration,
  minutes_billed,
  balance_after_call,
  balance_after_call + minutes_billed as balance_before_call
FROM call_logs
WHERE restaurant_id = 'your-restaurant-uuid'
  AND billing_status = 'billed'
ORDER BY created_at ASC;
```

### 2. Verify Billing Accuracy

Check if balance calculations are correct:

```sql
-- Compare expected vs actual balance changes
WITH balance_changes AS (
  SELECT
    id,
    call_sid,
    minutes_billed,
    balance_after_call,
    LAG(balance_after_call) OVER (ORDER BY created_at) as previous_balance
  FROM call_logs
  WHERE restaurant_id = 'your-restaurant-uuid'
    AND billing_status = 'billed'
  ORDER BY created_at
)
SELECT
  call_sid,
  minutes_billed,
  previous_balance,
  balance_after_call,
  (previous_balance - minutes_billed) as expected_balance,
  CASE
    WHEN (previous_balance - minutes_billed) = balance_after_call
    THEN '✅ Correct'
    ELSE '❌ Mismatch'
  END as status
FROM balance_changes
WHERE previous_balance IS NOT NULL;
```

### 3. Low Balance Detection

Find when balance dropped below threshold:

```sql
SELECT
  created_at,
  call_sid,
  minutes_billed,
  balance_after_call
FROM call_logs
WHERE restaurant_id = 'your-restaurant-uuid'
  AND balance_after_call < 50  -- Less than 50 minutes remaining
ORDER BY created_at DESC;
```

### 4. Monthly Accounting Report

Generate monthly billing reports:

```sql
SELECT
  DATE_TRUNC('month', created_at) as month,
  COUNT(*) as total_calls,
  SUM(minutes_billed) as total_minutes_used,
  MIN(balance_after_call) as lowest_balance,
  MAX(balance_after_call) as highest_balance
FROM call_logs
WHERE restaurant_id = 'your-restaurant-uuid'
  AND billing_status = 'billed'
GROUP BY DATE_TRUNC('month', created_at)
ORDER BY month DESC;
```

## Important Notes

### When Balance is NOT Saved

The `balance_after_call` field will be `NULL` in these cases:

1. **billing_status = 'skipped'** - Call had no duration or didn't complete
2. **billing_status = 'failed'** - Balance update failed (e.g., restaurant_balances record not found)
3. **Old call logs** - Created before this feature was deployed

### Balance Calculation

The `current_balance_minutes` in `restaurant_balances` is a GENERATED column:

```sql
current_balance_minutes = total_purchased_minutes - total_used_minutes
```

So when the edge function:
1. Updates `total_used_minutes += minutes_billed`
2. Then fetches `current_balance_minutes`

The database automatically calculates the new balance using the updated `total_used_minutes`.

### Accuracy

The balance snapshot is taken **immediately after** the deduction, so it represents the exact state at that moment. However:

- If multiple calls end simultaneously, there may be minor race conditions
- The balance is fetched in a separate query, so there's a small time window
- For critical accuracy, consider using database transactions (future enhancement)

## Troubleshooting

### balance_after_call is NULL for new calls

**Check:**
1. Was the database migration applied? Run: `SELECT balance_after_call FROM call_logs LIMIT 1;`
2. Was the edge function updated? Check deployment timestamp in Supabase dashboard
3. Is the call being billed? Check: `SELECT billing_status FROM call_logs WHERE call_sid = 'CA...'`

### balance_after_call doesn't match expected value

**Possible causes:**
1. Restaurant had purchases between calls
2. Manual adjustments were made to `restaurant_balances`
3. Multiple concurrent calls processed simultaneously

**Verify:**
```sql
SELECT
  total_purchased_minutes,
  total_used_minutes,
  current_balance_minutes
FROM restaurant_balances
WHERE restaurant_id = 'your-restaurant-uuid';
```

## Future Enhancements

Potential improvements:

1. **Add balance_before_call** - Capture balance before deduction for easier auditing
2. **Transaction support** - Use database transactions to ensure atomic balance updates
3. **Balance alerts** - Trigger alerts when balance drops below threshold
4. **Billing reports dashboard** - Web UI to visualize balance history

## Summary

✅ **Added:** `balance_after_call` field to `call_logs` table
✅ **Purpose:** Complete audit trail for billing and accounting
✅ **Populated:** Automatically by `create-call-log` edge function
✅ **Use Cases:** Balance tracking, billing verification, accounting reports

This feature provides transparency and accountability for the prepaid minutes billing system.
