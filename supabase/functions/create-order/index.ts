import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error('Missing environment variables');
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const {
      restaurant_id,
      customer_phone,
      customer_name,
      total_amount,
      order_type = 'pickup',
      delivery_address = null,
      delivery_instructions = null,
      order_details,
      special_instructions = '',
      ready_time,
      estimated_ready_at,
      call_sid
    } = await req.json();

    console.log('Creating order for restaurant:', restaurant_id);
    console.log('Order data received:', {
      customer_name,
      customer_phone,
      restaurant_id,
      total_amount,
      order_type,
      delivery_address,
      delivery_instructions,
      order_details: order_details ? order_details.substring(0, 100) + '...' : null,
      special_instructions,
      ready_time,
      estimated_ready_at,
      call_sid
    });

    // Validate required fields with detailed logging
    if (!restaurant_id) {
      console.error('Missing restaurant_id');
      return new Response(JSON.stringify({
        data: null,
        error: 'Missing required field: restaurant_id'
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400
      });
    }

    if (!customer_phone) {
      console.error('Missing customer_phone');
      return new Response(JSON.stringify({
        data: null,
        error: 'Missing required field: customer_phone'
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400
      });
    }

    // Check for invalid customer names and provide better fallback
    let finalCustomerName = customer_name;
    if (!customer_name ||
        customer_name === '[N/A]' ||
        customer_name === 'Unknown Customer' ||
        customer_name.includes('[') ||
        customer_name.trim().length === 0) {
      console.log('Invalid or missing customer name detected:', customer_name);
      finalCustomerName = 'Walk-in Customer';
      console.log('Using fallback customer name:', finalCustomerName);
    }

    console.log('Final customer name to be used:', finalCustomerName);

    // Create the order
    const orderInsertData = {
      restaurant_id,
      customer_phone,
      customer_name: finalCustomerName,
      total_amount: total_amount || 0,
      status: 'pending',
      order_type,
      delivery_address,
      delivery_instructions,
      order_details,
      special_instructions,
      ready_time,
      estimated_ready_at,
      call_sid
    };

    console.log('Inserting order with data:', JSON.stringify(orderInsertData, null, 2));

    const { data: order, error: orderError } = await supabase
      .from('orders')
      .insert([orderInsertData])
      .select()
      .single();

    if (orderError) {
      console.error('Error creating order:', JSON.stringify(orderError, null, 2));
      console.error('Order error details:', {
        message: orderError.message,
        details: orderError.details,
        hint: orderError.hint,
        code: orderError.code
      });
      return new Response(JSON.stringify({
        data: null,
        error: orderError.message
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500
      });
    }

    console.log('Order created successfully:', order.id);
    console.log('Returning successful order response:', order.id);

    return new Response(JSON.stringify({ data: order }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Function error:', error);
    console.error('Error details:', {
      message: error.message,
      stack: error.stack,
      name: error.name
    });
    return new Response(JSON.stringify({
      data: null,
      error: error.message
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500
    });
  }
});
