// Supabase Edge Function: create-call-log
// Handles UPSERT of call logs (prevents duplicates using call_sid as unique key)
// Supports hybrid logging: WebSocket + Twilio webhook

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const callData = await req.json()
    console.log('Received call data:', JSON.stringify(callData, null, 2))

    // Validate required fields
    if (!callData.call_sid) {
      return new Response(
        JSON.stringify({ error: 'Missing required field: call_sid' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Initialize Supabase client
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, supabaseKey)

    // UPSERT: Insert or update based on call_sid (unique constraint)
    const { data, error } = await supabase
      .from('call_logs')
      .upsert(
        {
          call_sid: callData.call_sid,
          restaurant_id: callData.restaurant_id,
          from_number: callData.from_number,
          to_number: callData.to_number,
          call_status: callData.call_status,
          call_direction: callData.call_direction,
          caller_country: callData.caller_country,
          caller_state: callData.caller_state,
          caller_city: callData.caller_city,
          caller_zip: callData.caller_zip,
          to_country: callData.to_country,
          to_state: callData.to_state,
          to_city: callData.to_city,
          to_zip: callData.to_zip,
          call_started_at: callData.call_started_at,
          call_ended_at: callData.call_ended_at,
          call_duration: callData.call_duration,
          conversation_transcript: callData.conversation_transcript,
          twilio_data: callData.twilio_data,
          order_id: callData.order_id,
          updated_at: new Date().toISOString()
        },
        {
          onConflict: 'call_sid', // Use call_sid as unique key
          ignoreDuplicates: false  // Update if exists
        }
      )
      .select()
      .single()

    if (error) {
      console.error('Database error:', error)
      return new Response(
        JSON.stringify({ error: error.message, details: error }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Determine if this was an insert or update
    const action = callData.conversation_transcript ? 'insert_or_update_with_transcript' : 'update_from_webhook'

    console.log(`Call log ${action}:`, data.id)

    return new Response(
      JSON.stringify({
        success: true,
        data: data,
        action: action,
        call_sid: callData.call_sid
      }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    )

  } catch (error) {
    console.error('Error in create-call-log function:', error)
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
