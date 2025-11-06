# Quick Start: Usage Tracking (Web UI Only) 🚀

**Time to complete: ~5 minutes**

This guide is for deploying OpenAI usage tracking using **only** the Supabase web dashboard (no terminal commands needed).

---

## Step 1: Create Database Table (2 minutes)

### 1.1 Open Supabase SQL Editor

1. Go to https://app.supabase.com
2. Select your project
3. Click **SQL Editor** in left sidebar
4. Click **New Query**

### 1.2 Copy & Paste This SQL

Copy the entire block below and paste into the SQL Editor, then click **Run**:

```sql
-- Create call_usage table to track OpenAI Realtime API costs per call
CREATE TABLE IF NOT EXISTS public.call_usage (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    -- Call identification
    call_sid VARCHAR(34) NOT NULL,
    restaurant_id UUID NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
    customer_phone VARCHAR(20),

    -- Call metadata
    call_duration_seconds INTEGER,
    ai_response_count INTEGER DEFAULT 0,
    model_used VARCHAR(100),

    -- Token usage
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    total_tokens INTEGER GENERATED ALWAYS AS (input_tokens + output_tokens) STORED,

    -- Token breakdown
    input_audio_tokens INTEGER DEFAULT 0,
    output_audio_tokens INTEGER DEFAULT 0,
    input_text_tokens INTEGER DEFAULT 0,
    output_text_tokens INTEGER DEFAULT 0,

    -- Cost breakdown (USD)
    text_input_cost DECIMAL(10,6) DEFAULT 0,
    text_output_cost DECIMAL(10,6) DEFAULT 0,
    audio_input_cost DECIMAL(10,6) DEFAULT 0,
    audio_output_cost DECIMAL(10,6) DEFAULT 0,
    total_cost DECIMAL(10,6) GENERATED ALWAYS AS (
        text_input_cost + text_output_cost + audio_input_cost + audio_output_cost
    ) STORED,

    -- Pricing snapshot (per 1M tokens)
    price_text_input DECIMAL(10,6) DEFAULT 2.50,
    price_text_output DECIMAL(10,6) DEFAULT 10.00,
    price_audio_input DECIMAL(10,6) DEFAULT 100.00,
    price_audio_output DECIMAL(10,6) DEFAULT 200.00,

    -- Metadata
    order_created BOOLEAN DEFAULT FALSE,
    order_id UUID REFERENCES public.orders(id) ON DELETE SET NULL,

    CONSTRAINT call_usage_call_sid_key UNIQUE(call_sid)
);

-- Create indexes for fast queries
CREATE INDEX IF NOT EXISTS idx_call_usage_restaurant_id ON public.call_usage(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_call_usage_created_at ON public.call_usage(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_usage_call_sid ON public.call_usage(call_sid);
CREATE INDEX IF NOT EXISTS idx_call_usage_customer_phone ON public.call_usage(customer_phone);
CREATE INDEX IF NOT EXISTS idx_call_usage_restaurant_created ON public.call_usage(restaurant_id, created_at DESC);
```

### 1.3 Verify

Run this to confirm:

```sql
SELECT * FROM pg_tables WHERE tablename = 'call_usage';
```

You should see one row with `call_usage`. ✅

---

## Step 2: Deploy Edge Function (3 minutes)

### 2.1 Open Edge Functions

1. Stay in your Supabase dashboard
2. Click **Edge Functions** in left sidebar
3. Click **Create a new function**
4. Name: `save-call-usage`

### 2.2 Paste Function Code

Copy the entire code block below and paste into the function editor:

```typescript
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface UsageData {
  call_sid: string
  restaurant_id: string
  customer_phone?: string
  call_duration_seconds?: number
  ai_response_count?: number
  model_used?: string
  input_tokens: number
  output_tokens: number
  input_audio_tokens: number
  output_audio_tokens: number
  input_text_tokens: number
  output_text_tokens: number
  price_text_input?: number
  price_text_output?: number
  price_audio_input?: number
  price_audio_output?: number
  order_created?: boolean
  order_id?: string
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    const usageData: UsageData = await req.json()

    if (!usageData.call_sid) {
      return new Response(
        JSON.stringify({ error: 'call_sid is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (!usageData.restaurant_id) {
      return new Response(
        JSON.stringify({ error: 'restaurant_id is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const priceTextInput = usageData.price_text_input ?? 2.50
    const priceTextOutput = usageData.price_text_output ?? 10.00
    const priceAudioInput = usageData.price_audio_input ?? 100.00
    const priceAudioOutput = usageData.price_audio_output ?? 200.00

    const textInputCost = (usageData.input_text_tokens * priceTextInput) / 1_000_000
    const textOutputCost = (usageData.output_text_tokens * priceTextOutput) / 1_000_000
    const audioInputCost = (usageData.input_audio_tokens * priceAudioInput) / 1_000_000
    const audioOutputCost = (usageData.output_audio_tokens * priceAudioOutput) / 1_000_000

    const { data, error } = await supabase
      .from('call_usage')
      .insert({
        call_sid: usageData.call_sid,
        restaurant_id: usageData.restaurant_id,
        customer_phone: usageData.customer_phone,
        call_duration_seconds: usageData.call_duration_seconds,
        ai_response_count: usageData.ai_response_count,
        model_used: usageData.model_used,
        input_tokens: usageData.input_tokens,
        output_tokens: usageData.output_tokens,
        input_audio_tokens: usageData.input_audio_tokens,
        output_audio_tokens: usageData.output_audio_tokens,
        input_text_tokens: usageData.input_text_tokens,
        output_text_tokens: usageData.output_text_tokens,
        text_input_cost: textInputCost,
        text_output_cost: textOutputCost,
        audio_input_cost: audioInputCost,
        audio_output_cost: audioOutputCost,
        price_text_input: priceTextInput,
        price_text_output: priceTextOutput,
        price_audio_input: priceAudioInput,
        price_audio_output: priceAudioOutput,
        order_created: usageData.order_created ?? false,
        order_id: usageData.order_id
      })
      .select()
      .single()

    if (error) {
      return new Response(
        JSON.stringify({ error: error.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    return new Response(
      JSON.stringify({
        success: true,
        usage_id: data.id,
        total_cost: (textInputCost + textOutputCost + audioInputCost + audioOutputCost).toFixed(6)
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
```

### 2.3 Deploy

Click **Deploy** button. Wait for deployment to complete. ✅

### 2.4 Test It

1. Go to your deployed function
2. Click **Invoke** tab
3. Paste this test payload:

```json
{
  "call_sid": "CAtest123",
  "restaurant_id": "YOUR-RESTAURANT-UUID-HERE",
  "customer_phone": "+14105551234",
  "call_duration_seconds": 120,
  "ai_response_count": 8,
  "model_used": "gpt-4o-mini-realtime-preview",
  "input_tokens": 1234,
  "output_tokens": 567,
  "input_audio_tokens": 234,
  "output_audio_tokens": 283,
  "input_text_tokens": 1000,
  "output_text_tokens": 284,
  "order_created": true
}
```

**Replace `YOUR-RESTAURANT-UUID-HERE`** with a real restaurant ID from your `restaurants` table.

To find a restaurant ID, go to SQL Editor and run:

```sql
SELECT id, name FROM restaurants LIMIT 1;
```

Click **Invoke**. You should see:

```json
{
  "success": true,
  "usage_id": "some-uuid",
  "total_cost": "0.085800"
}
```

### 2.5 Verify Data Saved

Go to SQL Editor and run:

```sql
SELECT * FROM call_usage ORDER BY created_at DESC LIMIT 1;
```

You should see your test record! ✅

---

## Step 3: That's It! 🎉

Your system is now tracking OpenAI usage costs automatically. Every call will now save cost data to the database.

The Node.js code changes are already in place - no restart needed if your app is already running the latest code.

---

## View Your Cost Data

Go to **SQL Editor** and try these queries:

### Today's Total Cost

```sql
SELECT
  COUNT(*) AS calls_today,
  ROUND(SUM(total_cost)::numeric, 2) AS total_cost,
  ROUND(AVG(total_cost)::numeric, 4) AS avg_per_call
FROM call_usage
WHERE DATE(created_at) = CURRENT_DATE;
```

### Cost by Restaurant

```sql
SELECT
  r.name,
  COUNT(cu.id) AS calls,
  ROUND(SUM(cu.total_cost)::numeric, 2) AS total_cost
FROM call_usage cu
JOIN restaurants r ON r.id = cu.restaurant_id
GROUP BY r.name
ORDER BY total_cost DESC;
```

### Most Expensive Calls

```sql
SELECT
  call_sid,
  customer_phone,
  ROUND(total_cost::numeric, 4) AS cost,
  call_duration_seconds,
  created_at
FROM call_usage
ORDER BY total_cost DESC
LIMIT 10;
```

---

## What's Being Tracked

Every call now automatically tracks:

- ✅ **Total cost** (broken down by audio/text tokens)
- ✅ **Token usage** (input/output, audio/text)
- ✅ **Call duration**
- ✅ **Restaurant** (which restaurant the call was for)
- ✅ **Customer** (phone number)
- ✅ **Order link** (if order was created)

**Typical call cost: $0.08 - $0.15**

---

## Need Help?

- **Edge function not working?** Check the Logs tab in Edge Functions
- **No data showing?** Verify your Node.js app restarted with the new code
- **Permission errors?** Check RLS policies in Database → Policies

For detailed analytics queries, see: `supabase/migrations/usage_analytics_queries.sql`

**Done! Your system is now tracking all OpenAI costs.** 🎊
