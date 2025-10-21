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
      delivery_address,
      formatted_address,
      is_valid,
      latitude,
      longitude,
      distance_from_restaurant,
      validation_reason,
      delivery_instructions
    } = await req.json();

    console.log('Saving customer address:', {
      restaurant_id,
      customer_phone,
      delivery_address,
      is_valid
    });

    // Validate required fields
    if (!restaurant_id || !customer_phone || !customer_name || !delivery_address) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Missing required fields: restaurant_id, customer_phone, customer_name, delivery_address'
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400
      });
    }

    // Check if address already exists for this customer/restaurant
    const { data: existingAddress } = await supabase
      .from('customer_delivery_addresses')
      .select('id')
      .eq('restaurant_id', restaurant_id)
      .eq('customer_phone', customer_phone)
      .maybeSingle();

    let result;
    let isNew = false;

    if (existingAddress) {
      // Update existing address
      console.log('Updating existing address:', existingAddress.id);

      const { data: updatedAddress, error: updateError } = await supabase
        .from('customer_delivery_addresses')
        .update({
          customer_name,
          delivery_address,
          formatted_address,
          is_valid,
          latitude,
          longitude,
          distance_from_restaurant,
          validation_reason,
          delivery_instructions,
          last_used_at: new Date().toISOString(),
          times_used: supabase.raw('times_used + 1'),
          updated_at: new Date().toISOString()
        })
        .eq('id', existingAddress.id)
        .select()
        .single();

      if (updateError) {
        console.error('Update error:', updateError);
        return new Response(JSON.stringify({
          success: false,
          error: updateError.message
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 500
        });
      }

      result = updatedAddress;
      isNew = false;

    } else {
      // Insert new address
      console.log('Creating new address entry');

      const { data: newAddress, error: insertError } = await supabase
        .from('customer_delivery_addresses')
        .insert([{
          restaurant_id,
          customer_phone,
          customer_name,
          delivery_address,
          formatted_address,
          is_valid,
          latitude,
          longitude,
          distance_from_restaurant,
          validation_reason,
          delivery_instructions,
          last_used_at: new Date().toISOString(),
          times_used: 1
        }])
        .select()
        .single();

      if (insertError) {
        console.error('Insert error:', insertError);
        return new Response(JSON.stringify({
          success: false,
          error: insertError.message
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 500
        });
      }

      result = newAddress;
      isNew = true;
    }

    console.log('Address saved successfully:', result.id);

    return new Response(JSON.stringify({
      success: true,
      address_id: result.id,
      is_new: isNew,
      data: result
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
