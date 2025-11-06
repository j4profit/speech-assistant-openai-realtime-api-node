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

    // Set default pricing if not provided (gpt-4o-mini-realtime rates per 1M tokens)
    const priceTextInput = usageData.price_text_input ?? 0.60
    const priceTextOutput = usageData.price_text_output ?? 2.40
    const priceAudioInput = usageData.price_audio_input ?? 60.00
    const priceAudioOutput = usageData.price_audio_output ?? 120.00

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
