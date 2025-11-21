import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.38.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const messageData = await req.json();

    // Validate required fields
    if (!messageData.restaurant_id) {
      return new Response(JSON.stringify({ error: 'Missing restaurant_id' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400
      });
    }

    if (!messageData.customer_phone) {
      return new Response(JSON.stringify({ error: 'Missing customer_phone' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400
      });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const { data, error } = await supabase
      .from('customer_messages')
      .insert([{
        restaurant_id: messageData.restaurant_id,
        customer_phone: messageData.customer_phone,
        customer_name: messageData.customer_name || 'Unknown',
        message_type: messageData.message_type || 'general',
        subject: messageData.subject || 'Customer Inquiry',
        message_content: messageData.message_content || 'No message content provided',
        call_sid: messageData.call_sid,
        order_reference: messageData.order_reference,
        priority: messageData.priority || 'normal',
        status: 'new'
      }])
      .select()
      .single();

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500
      });
    }

    return new Response(JSON.stringify({
      success: true,
      message_id: data.id,
      data: data
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500
    });
  }
});
