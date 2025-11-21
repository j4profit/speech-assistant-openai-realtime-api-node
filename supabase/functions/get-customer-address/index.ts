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
    const { restaurant_id, customer_phone } = await req.json();

    console.log('Looking up customer address:', { restaurant_id, customer_phone });

    // Validate required fields
    if (!restaurant_id) {
      return new Response(JSON.stringify({
        success: false,
        error: 'restaurant_id is required'
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400
      });
    }

    if (!customer_phone) {
      return new Response(JSON.stringify({
        success: false,
        error: 'customer_phone is required'
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400
      });
    }

    // Multi-tenant security: Query with both restaurant_id AND customer_phone
    const { data: address, error } = await supabase
      .from('customer_delivery_addresses')
      .select('*')
      .eq('restaurant_id', restaurant_id)
      .eq('customer_phone', customer_phone)
      .maybeSingle();

    if (error) {
      console.error('Database error:', error);
      return new Response(JSON.stringify({
        success: false,
        error: error.message
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500
      });
    }

    // Address not found - this is OK, not an error
    if (!address) {
      console.log('No saved address found for customer');
      return new Response(JSON.stringify({
        success: true,
        data: null,
        message: 'No saved address found'
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    console.log('Found saved address:', {
      id: address.id,
      is_valid: address.is_valid,
      times_used: address.times_used
    });

    return new Response(JSON.stringify({
      success: true,
      data: address
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Function error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500
    });
  }
});
