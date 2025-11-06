# OpenAI Usage Tracking & Cost Monitoring - Deployment Guide

This guide explains how to deploy and use the OpenAI Realtime API usage tracking feature.

## Overview

The system now tracks detailed OpenAI token usage and calculates costs per call, storing data in a `call_usage` table. This enables:

- **Real-time cost monitoring** during calls
- **Per-call cost breakdowns** (text vs audio tokens)
- **Restaurant-level analytics** (track costs per restaurant)
- **Budget monitoring** and profitability analysis
- **Order correlation** (link usage to orders)

## Deployment Steps

### 1. Create the `call_usage` Table (Using Supabase SQL Editor)

**Step 1.1: Open Supabase SQL Editor**

1. Go to your Supabase dashboard: https://app.supabase.com
2. Select your project
3. Click **SQL Editor** in the left sidebar
4. Click **New Query** button

**Step 1.2: Copy and Run the Migration SQL**

Copy the entire contents of `supabase/migrations/create_call_usage_table.sql` and paste it into the SQL Editor, then click **Run**.

Or copy this SQL directly:

<details>
<summary>Click to expand SQL migration (copy all of this)</summary>

```sql
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
```

</details>

**Step 1.3: Verify Table Creation**

Run this query in the SQL Editor to confirm the table was created:

```sql
SELECT * FROM pg_tables WHERE tablename = 'call_usage';
```

You should see one row returned with the table name `call_usage`.

### 2. Deploy the Supabase Edge Function

You have two options for deploying the edge function:

#### Option A: Using Supabase Web Dashboard (Easiest)

**Step 2.1: Open Edge Functions**

1. Go to your Supabase dashboard: https://app.supabase.com
2. Select your project
3. Click **Edge Functions** in the left sidebar
4. Click **Create a new function** button
5. Name it: `save-call-usage`

**Step 2.2: Copy the Function Code**

Copy the entire contents of `supabase/functions/save-call-usage/index.ts` and paste it into the function editor.

<details>
<summary>Click to expand Edge Function code (copy all of this)</summary>

```typescript
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3'

// CORS headers
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

  // Token counts
  input_tokens: number
  output_tokens: number
  input_audio_tokens: number
  output_audio_tokens: number
  input_text_tokens: number
  output_text_tokens: number

  // Pricing (per 1M tokens)
  price_text_input?: number
  price_text_output?: number
  price_audio_input?: number
  price_audio_output?: number

  // Optional metadata
  order_created?: boolean
  order_id?: string
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // Initialize Supabase client
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    // Parse request body
    const usageData: UsageData = await req.json()

    console.log('Saving call usage:', {
      call_sid: usageData.call_sid,
      restaurant_id: usageData.restaurant_id,
      total_tokens: usageData.input_tokens + usageData.output_tokens
    })

    // Validate required fields
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

    // Set default pricing if not provided (current OpenAI rates per 1M tokens)
    const priceTextInput = usageData.price_text_input ?? 2.50
    const priceTextOutput = usageData.price_text_output ?? 10.00
    const priceAudioInput = usageData.price_audio_input ?? 100.00
    const priceAudioOutput = usageData.price_audio_output ?? 200.00

    // Calculate costs (convert from per-1M to per-token)
    const textInputCost = (usageData.input_text_tokens * priceTextInput) / 1_000_000
    const textOutputCost = (usageData.output_text_tokens * priceTextOutput) / 1_000_000
    const audioInputCost = (usageData.input_audio_tokens * priceAudioInput) / 1_000_000
    const audioOutputCost = (usageData.output_audio_tokens * priceAudioOutput) / 1_000_000

    console.log('Cost breakdown:', {
      text_input: `$${textInputCost.toFixed(6)}`,
      text_output: `$${textOutputCost.toFixed(6)}`,
      audio_input: `$${audioInputCost.toFixed(6)}`,
      audio_output: `$${audioOutputCost.toFixed(6)}`,
      total: `$${(textInputCost + textOutputCost + audioInputCost + audioOutputCost).toFixed(6)}`
    })

    // Insert usage data into database
    const { data, error } = await supabase
      .from('call_usage')
      .insert({
        call_sid: usageData.call_sid,
        restaurant_id: usageData.restaurant_id,
        customer_phone: usageData.customer_phone,
        call_duration_seconds: usageData.call_duration_seconds,
        ai_response_count: usageData.ai_response_count,
        model_used: usageData.model_used,

        // Token counts
        input_tokens: usageData.input_tokens,
        output_tokens: usageData.output_tokens,
        input_audio_tokens: usageData.input_audio_tokens,
        output_audio_tokens: usageData.output_audio_tokens,
        input_text_tokens: usageData.input_text_tokens,
        output_text_tokens: usageData.output_text_tokens,

        // Cost breakdown
        text_input_cost: textInputCost,
        text_output_cost: textOutputCost,
        audio_input_cost: audioInputCost,
        audio_output_cost: audioOutputCost,

        // Pricing snapshot
        price_text_input: priceTextInput,
        price_text_output: priceTextOutput,
        price_audio_input: priceAudioInput,
        price_audio_output: priceAudioOutput,

        // Metadata
        order_created: usageData.order_created ?? false,
        order_id: usageData.order_id
      })
      .select()
      .single()

    if (error) {
      console.error('Database error:', error)
      return new Response(
        JSON.stringify({ error: error.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    console.log('✅ Call usage saved successfully:', data.id)

    return new Response(
      JSON.stringify({
        success: true,
        usage_id: data.id,
        total_cost: (textInputCost + textOutputCost + audioInputCost + audioOutputCost).toFixed(6)
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    console.error('Error in save-call-usage:', error)
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
```

</details>

**Step 2.3: Deploy the Function**

Click **Deploy** button in the Supabase dashboard.

---

#### Option B: Using Supabase CLI (Advanced)

If you prefer using the command line:

```bash
cd /workspaces/speech-assistant-openai-realtime-api-node

# Login to Supabase (if not already)
supabase login

# Link to your project (if not already)
supabase link --project-ref [YOUR-PROJECT-REF]

# Deploy the edge function
supabase functions deploy save-call-usage
```

---

**Step 2.4: Test the Edge Function**

After deployment, test it using the Supabase dashboard:

1. Go to **Edge Functions** → **save-call-usage**
2. Click on the **Invoke** tab
3. Use this test payload (replace `[YOUR-RESTAURANT-ID]` with a real restaurant ID from your database):

```json
{
  "call_sid": "CA123test",
  "restaurant_id": "[YOUR-RESTAURANT-ID]",
  "customer_phone": "+14105551234",
  "call_duration_seconds": 120,
  "ai_response_count": 8,
  "model_used": "gpt-4o-mini-realtime-preview-2024-12-17",
  "input_tokens": 1234,
  "output_tokens": 567,
  "input_audio_tokens": 234,
  "output_audio_tokens": 283,
  "input_text_tokens": 1000,
  "output_text_tokens": 284,
  "order_created": true
}
```

**Expected response:**

```json
{
  "success": true,
  "usage_id": "some-uuid-here",
  "total_cost": "0.085800"
}
```

**Step 2.5: Verify Data Was Saved**

Go back to **SQL Editor** and run:

```sql
SELECT * FROM call_usage ORDER BY created_at DESC LIMIT 1;
```

You should see your test record!

### 3. Restart Your Application

The code changes are already in place. Simply restart your Node.js application:

```bash
# If running with npm
npm run dev

# Or if running with PM2
pm2 restart all

# Or with systemd
sudo systemctl restart your-service-name
```

## How It Works

### 1. **Real-Time Token Tracking**

Every time OpenAI sends a `response.done` event, the system captures:

```javascript
{
  input_tokens: 1234,
  output_tokens: 567,
  input_token_details: {
    audio: 234,
    text: 1000
  },
  output_token_details: {
    audio: 283,
    text: 284
  }
}
```

### 2. **Cost Calculation**

Costs are calculated using OpenAI Realtime API pricing:

| Token Type | Price per 1M tokens |
|-----------|-------------------|
| Text Input | $2.50 |
| Text Output | $10.00 |
| Audio Input | $100.00 |
| Audio Output | $200.00 |

**Example calculation for a typical 2-minute call:**

```
Text Input:   1,000 tokens × $2.50/1M   = $0.0025
Text Output:    284 tokens × $10.00/1M  = $0.0028
Audio Input:    234 tokens × $100.00/1M = $0.0234
Audio Output:   283 tokens × $200.00/1M = $0.0566
                                   Total = $0.0853
```

### 3. **Console Output**

During calls, you'll see real-time cost updates:

```
📊 Usage data received: {
  input_tokens: 1234,
  output_tokens: 567,
  input_audio_tokens: 234,
  output_audio_tokens: 283,
  input_text_tokens: 1000,
  output_text_tokens: 284
}

💰 Current call cost: {
  text_input: '$0.0025',
  text_output: '$0.0028',
  audio_input: '$0.0234',
  audio_output: '$0.0566',
  total: '$0.0853'
}
```

At call end:

```
📊 Call Statistics: {
  callSid: 'CA1234...',
  duration: 127,
  ai_responses: 8,
  total_cost: '$0.0853',
  usage: {
    input_tokens: 1234,
    output_tokens: 567,
    input_audio_tokens: 234,
    output_audio_tokens: 283,
    input_text_tokens: 1000,
    output_text_tokens: 284
  }
}

💰 Saving call usage for call: CA1234...
✅ Call usage saved successfully - Total cost: $0.085300
```

## Querying Usage Data

### Get Total Costs by Restaurant

```sql
SELECT
  r.name AS restaurant_name,
  COUNT(*) AS total_calls,
  SUM(cu.total_cost) AS total_cost,
  AVG(cu.total_cost) AS avg_cost_per_call,
  SUM(cu.input_tokens) AS total_input_tokens,
  SUM(cu.output_tokens) AS total_output_tokens
FROM call_usage cu
JOIN restaurants r ON r.id = cu.restaurant_id
GROUP BY r.id, r.name
ORDER BY total_cost DESC;
```

### Get Costs by Date Range

```sql
SELECT
  DATE(created_at) AS date,
  COUNT(*) AS calls,
  SUM(total_cost) AS daily_cost,
  AVG(total_cost) AS avg_cost,
  SUM(CASE WHEN order_created THEN 1 ELSE 0 END) AS orders_created
FROM call_usage
WHERE created_at >= NOW() - INTERVAL '7 days'
GROUP BY DATE(created_at)
ORDER BY date DESC;
```

### Get Most Expensive Calls

```sql
SELECT
  call_sid,
  customer_phone,
  call_duration_seconds,
  ai_response_count,
  total_cost,
  order_created,
  created_at
FROM call_usage
ORDER BY total_cost DESC
LIMIT 20;
```

### Get Average Cost Per Order

```sql
SELECT
  AVG(total_cost) AS avg_cost_per_order,
  COUNT(*) AS orders_with_cost_data,
  SUM(total_cost) AS total_cost
FROM call_usage
WHERE order_created = true;
```

### Get Token Usage Breakdown

```sql
SELECT
  model_used,
  SUM(input_audio_tokens) AS total_audio_input,
  SUM(output_audio_tokens) AS total_audio_output,
  SUM(input_text_tokens) AS total_text_input,
  SUM(output_text_tokens) AS total_text_output,
  SUM(audio_input_cost + audio_output_cost) AS audio_costs,
  SUM(text_input_cost + text_output_cost) AS text_costs,
  COUNT(*) AS call_count
FROM call_usage
GROUP BY model_used;
```

## Monitoring & Alerts

### Set Up Cost Alerts

Create a Supabase Edge Function or database trigger to send alerts when costs exceed thresholds:

```sql
-- Example: Alert when daily costs exceed $50
CREATE OR REPLACE FUNCTION check_daily_cost_threshold()
RETURNS TRIGGER AS $$
BEGIN
  IF (
    SELECT SUM(total_cost)
    FROM call_usage
    WHERE DATE(created_at) = CURRENT_DATE
  ) > 50.00 THEN
    -- Send alert (implement with your notification system)
    RAISE NOTICE 'Daily cost threshold exceeded!';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER daily_cost_check
  AFTER INSERT ON call_usage
  FOR EACH ROW
  EXECUTE FUNCTION check_daily_cost_threshold();
```

### Dashboard Metrics

Useful metrics for dashboards:

- **Cost per call** (overall average)
- **Cost per order** (calls that resulted in orders)
- **Daily/weekly/monthly cost trends**
- **Restaurant cost ranking**
- **Audio vs text token ratio**
- **Model cost comparison** (if using multiple models)

## Pricing Updates

When OpenAI updates pricing, update these constants in `index.js:287-290`:

```javascript
const PRICE_TEXT_INPUT = 2.50 / 1_000_000;
const PRICE_TEXT_OUTPUT = 10.00 / 1_000_000;
const PRICE_AUDIO_INPUT = 100.00 / 1_000_000;
const PRICE_AUDIO_OUTPUT = 200.00 / 1_000_000;
```

The system stores pricing snapshots in the database, so historical data remains accurate.

## Cost Optimization Tips

### 1. **Reduce AI Response Length**

Adjust `max_response_output_tokens` in `index.js:231`:

```javascript
max_response_output_tokens: 400  // Reduce to 300 or 200 for shorter responses
```

### 2. **Optimize AI Instructions**

Shorter system prompts = fewer input tokens. Review `services/aiInstructions.js`.

### 3. **Monitor Expensive Calls**

Query for outliers:

```sql
SELECT * FROM call_usage
WHERE total_cost > 0.20  -- Calls costing more than $0.20
ORDER BY total_cost DESC;
```

### 4. **Use Model Fallback**

Configure a cheaper fallback model in `.env`:

```bash
OPENAI_MODEL=gpt-4o-mini-realtime-preview-2024-12-17
OPENAI_FALLBACK_MODEL=gpt-4o-mini-realtime-preview-2024-12-17  # Same or cheaper model
```

## Troubleshooting

### Usage data not saving

**Check:**
1. Edge function deployed: `supabase functions list`
2. Table exists: `SELECT * FROM call_usage LIMIT 1;`
3. Environment variables set: `SUPABASE_URL`, `SUPABASE_ANON_KEY`
4. Console logs: Look for `💰 Saving call usage` and any errors

### Costs seem incorrect

**Verify:**
1. Pricing constants in `index.js:287-290`
2. Check OpenAI's latest pricing: https://openai.com/api/pricing/
3. Review token counts in database

### No usage data captured

**Check:**
1. OpenAI API is sending `response.done` events (check logs)
2. WebSocket connection stable
3. Calls are completing normally (not dropping mid-call)

## Support

For issues with this feature:
1. Check console logs for errors
2. Verify Supabase Edge Function logs in Supabase dashboard
3. Test edge function with curl (see Deployment Steps)
4. Review database RLS policies if getting permission errors

## Version

- **Feature Version**: v2.8
- **Added**: 2025-11-06
- **OpenAI Pricing as of**: January 2025
