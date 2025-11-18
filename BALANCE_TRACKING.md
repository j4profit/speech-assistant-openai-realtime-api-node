# Call Log Balance Tracking

## Overview

The `call_logs` table now includes `balance_before_call` and `balance_after_call` fields that record the restaurant's balance (in minutes) before and after each call deduction. This provides a complete transaction-style audit trail for billing and accounting purposes.

## What Was Added

### Database Fields

**Table:** `call_logs`
**New Columns:**
- `balance_before_call` (NUMERIC) - Balance BEFORE call deduction
- `balance_after_call` (NUMERIC) - Balance AFTER call deduction

These fields store the value of `restaurant_balances.current_balance_minutes` immediately before and after the call minutes are deducted, giving you a complete transaction record.

### How It Works

```
1. Call completes
   ↓
2. Twilio webhook calls create-call-log edge function
   ↓
3. Edge function fetches current balance → saves to balance_before_call
   ↓
4. Edge function deducts minutes from restaurant_balances.total_used_minutes
   ↓
5. Edge function fetches updated balance → saves to balance_after_call
   ↓
6. Complete transaction record created
```

### Example Data

| call_sid | call_duration | minutes_billed | balance_before_call | balance_after_call | difference |
|----------|---------------|----------------|--------------------|--------------------|-----------|
| CA123... | 127           | 3              | 300.0              | 297.0              | -3.0      |
| CA124... | 65            | 2              | 297.0              | 295.0              | -2.0      |
| CA125... | 180           | 3              | 295.0              | 292.0              | -3.0      |

This shows a complete transaction ledger - you can see the balance before, the deduction, and the balance after for every call.

## Deployment Steps

### Step 1: Run Database Migration

Run this SQL in your Supabase SQL Editor:

```sql
-- Add balance tracking fields to call_logs table
ALTER TABLE public.call_logs
ADD COLUMN balance_before_call NUMERIC,
ADD COLUMN balance_after_call NUMERIC;

-- Add helpful comments
COMMENT ON COLUMN public.call_logs.balance_before_call IS 'Restaurant balance (in minutes) BEFORE this call was deducted from restaurant_balances.current_balance_minutes';
COMMENT ON COLUMN public.call_logs.balance_after_call IS 'Restaurant balance (in minutes) AFTER this call was deducted from restaurant_balances.current_balance_minutes';

-- Create indexes for balance queries
CREATE INDEX IF NOT EXISTS idx_call_logs_balance_before_call ON public.call_logs(balance_before_call);
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
  balance_before_call,
  balance_after_call,
  (balance_before_call - balance_after_call) as actual_deduction,
  billing_status,
  billing_processed_at
FROM call_logs
ORDER BY created_at DESC
LIMIT 5;
```

You should see both `balance_before_call` and `balance_after_call` populated for billed calls, and the difference should equal `minutes_billed`.

## Use Cases

### 1. Complete Transaction Ledger

View complete transaction history with before/after balances:

```sql
SELECT
  created_at,
  call_sid,
  call_duration,
  minutes_billed,
  balance_before_call,
  balance_after_call,
  (balance_before_call - balance_after_call) as actual_deduction
FROM call_logs
WHERE restaurant_id = 'your-restaurant-uuid'
  AND billing_status = 'billed'
ORDER BY created_at DESC;
```

### 2. Verify Billing Accuracy

Check if deductions match expected amounts:

```sql
-- Verify that balance_before - minutes_billed = balance_after
SELECT
  call_sid,
  minutes_billed,
  balance_before_call,
  balance_after_call,
  (balance_before_call - minutes_billed) as expected_balance_after,
  (balance_before_call - balance_after_call) as actual_deduction,
  CASE
    WHEN (balance_before_call - minutes_billed) = balance_after_call
    THEN '✅ Correct'
    WHEN ABS((balance_before_call - minutes_billed) - balance_after_call) < 0.01
    THEN '✅ Correct (rounding)'
    ELSE '❌ Mismatch'
  END as accuracy_check
FROM call_logs
WHERE restaurant_id = 'your-restaurant-uuid'
  AND billing_status = 'billed'
  AND balance_before_call IS NOT NULL
ORDER BY created_at DESC;
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

Generate monthly billing reports with balance trends:

```sql
SELECT
  DATE_TRUNC('month', created_at) as month,
  COUNT(*) as total_calls,
  SUM(minutes_billed) as total_minutes_used,
  MIN(balance_after_call) as lowest_balance,
  MAX(balance_before_call) as highest_balance,
  (MAX(balance_before_call) - MIN(balance_after_call)) as total_balance_decrease
FROM call_logs
WHERE restaurant_id = 'your-restaurant-uuid'
  AND billing_status = 'billed'
GROUP BY DATE_TRUNC('month', created_at)
ORDER BY month DESC;
```

## Important Notes

### When Balance is NOT Saved

The `balance_before_call` and `balance_after_call` fields will be `NULL` in these cases:

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

Balance snapshots are taken:
1. **Before deduction:** Captured from initial query
2. **After deduction:** Fetched immediately after update

This provides accurate transaction records. However:

- If multiple calls end simultaneously, there may be minor race conditions
- The after-balance is fetched in a separate query, so there's a small time window
- For critical accuracy, consider using database transactions (future enhancement)

**Verification:** You can verify accuracy by checking if `balance_before_call - minutes_billed = balance_after_call`

## Troubleshooting

### balance_before_call or balance_after_call is NULL for new calls

**Check:**
1. Was the database migration applied? Run: `SELECT balance_before_call, balance_after_call FROM call_logs LIMIT 1;`
2. Was the edge function updated? Check deployment timestamp in Supabase dashboard
3. Is the call being billed? Check: `SELECT billing_status FROM call_logs WHERE call_sid = 'CA...'`

### Deduction doesn't match (balance_before - balance_after ≠ minutes_billed)

**Possible causes:**
1. Restaurant had purchases added between the before/after snapshots
2. Manual adjustments were made to `restaurant_balances` during the call
3. Multiple concurrent calls processed simultaneously
4. Database transaction timing issue

**Verify:**
```sql
SELECT
  call_sid,
  minutes_billed,
  balance_before_call,
  balance_after_call,
  (balance_before_call - balance_after_call) as actual_deduction,
  (balance_before_call - balance_after_call) - minutes_billed as discrepancy
FROM call_logs
WHERE restaurant_id = 'your-restaurant-uuid'
  AND billing_status = 'billed'
  AND balance_before_call IS NOT NULL
  AND ABS((balance_before_call - balance_after_call) - minutes_billed) > 0.01
ORDER BY created_at DESC;
```

## Future Enhancements

Potential improvements:

1. **Transaction support** - Use database transactions to ensure atomic balance updates
2. **Balance alerts** - Trigger alerts when balance drops below threshold
3. **Billing reports dashboard** - Web UI to visualize balance history
4. **Refund tracking** - Track balance increases from refunds or adjustments

## Summary

✅ **Added:** `balance_before_call` and `balance_after_call` fields to `call_logs` table
✅ **Purpose:** Complete transaction-style audit trail for billing and accounting
✅ **Populated:** Automatically by `create-call-log` edge function
✅ **Use Cases:** Complete transaction ledger, billing verification, accounting reports, discrepancy detection

This feature provides full transparency and accountability for the prepaid minutes billing system with a complete before/after snapshot for every call deduction.
