-- Add balance tracking fields to call_logs table
-- This tracks the restaurant's balance before and after each call deduction for complete accounting

ALTER TABLE public.call_logs
ADD COLUMN balance_before_call NUMERIC,
ADD COLUMN balance_after_call NUMERIC;

-- Add helpful comments
COMMENT ON COLUMN public.call_logs.balance_before_call IS 'Restaurant balance (in minutes) BEFORE this call was deducted from restaurant_balances.current_balance_minutes';
COMMENT ON COLUMN public.call_logs.balance_after_call IS 'Restaurant balance (in minutes) AFTER this call was deducted from restaurant_balances.current_balance_minutes';

-- Create indexes for balance queries
CREATE INDEX IF NOT EXISTS idx_call_logs_balance_before_call ON public.call_logs(balance_before_call);
CREATE INDEX IF NOT EXISTS idx_call_logs_balance_after_call ON public.call_logs(balance_after_call);
