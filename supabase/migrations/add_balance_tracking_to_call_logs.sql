-- Add balance tracking field to call_logs table
-- This tracks the restaurant's remaining balance after each call deduction

ALTER TABLE public.call_logs
ADD COLUMN balance_after_call NUMERIC;

-- Add helpful comment
COMMENT ON COLUMN public.call_logs.balance_after_call IS 'Restaurant balance (in minutes) remaining after this call was deducted from restaurant_balances.current_balance_minutes';

-- Create index for balance queries
CREATE INDEX IF NOT EXISTS idx_call_logs_balance_after_call ON public.call_logs(balance_after_call);
