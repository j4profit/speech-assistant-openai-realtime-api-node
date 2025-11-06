-- Create call_usage table to track OpenAI Realtime API costs per call
-- This table stores detailed token usage and cost breakdown for each call

CREATE TABLE IF NOT EXISTS public.call_usage (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    -- Call identification
    call_sid VARCHAR(34) NOT NULL,  -- Twilio Call SID
    restaurant_id UUID NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
    customer_phone VARCHAR(20),

    -- Call metadata
    call_duration_seconds INTEGER,  -- Total call duration in seconds
    ai_response_count INTEGER DEFAULT 0,  -- Number of AI responses during call
    model_used VARCHAR(100),  -- e.g., 'gpt-4o-mini-realtime-preview-2024-12-17'

    -- Token usage (raw counts)
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    total_tokens INTEGER GENERATED ALWAYS AS (input_tokens + output_tokens) STORED,

    -- Detailed token breakdown
    input_audio_tokens INTEGER DEFAULT 0,
    output_audio_tokens INTEGER DEFAULT 0,
    input_text_tokens INTEGER DEFAULT 0,
    output_text_tokens INTEGER DEFAULT 0,

    -- Cost breakdown (in USD)
    text_input_cost DECIMAL(10,6) DEFAULT 0,
    text_output_cost DECIMAL(10,6) DEFAULT 0,
    audio_input_cost DECIMAL(10,6) DEFAULT 0,
    audio_output_cost DECIMAL(10,6) DEFAULT 0,
    total_cost DECIMAL(10,6) GENERATED ALWAYS AS (
        text_input_cost + text_output_cost + audio_input_cost + audio_output_cost
    ) STORED,

    -- Pricing snapshot (rates at time of call, per 1M tokens)
    price_text_input DECIMAL(10,6) DEFAULT 2.50,
    price_text_output DECIMAL(10,6) DEFAULT 10.00,
    price_audio_input DECIMAL(10,6) DEFAULT 100.00,
    price_audio_output DECIMAL(10,6) DEFAULT 200.00,

    -- Additional metadata
    order_created BOOLEAN DEFAULT FALSE,  -- Was an order successfully created?
    order_id UUID REFERENCES public.orders(id) ON DELETE SET NULL,

    CONSTRAINT call_usage_call_sid_key UNIQUE(call_sid)
);

-- Create indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_call_usage_restaurant_id ON public.call_usage(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_call_usage_created_at ON public.call_usage(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_usage_call_sid ON public.call_usage(call_sid);
CREATE INDEX IF NOT EXISTS idx_call_usage_customer_phone ON public.call_usage(customer_phone);

-- Create composite index for restaurant analytics
CREATE INDEX IF NOT EXISTS idx_call_usage_restaurant_created ON public.call_usage(restaurant_id, created_at DESC);

-- Add helpful comment
COMMENT ON TABLE public.call_usage IS 'Tracks OpenAI Realtime API token usage and costs per call for system administrator billing and analytics';
