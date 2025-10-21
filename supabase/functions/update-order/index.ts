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
    const { order_id, modifications, new_total, order_details, special_instructions } = await req.json();

    console.log('Updating order:', order_id);

    if (!order_id) {
      return new Response(JSON.stringify({
        data: null,
        error: 'order_id is required'
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400
      });
    }

    // Build update object
    const updateData: any = {
      updated_at: new Date().toISOString()
    };

    if (order_details) updateData.order_details = order_details;
    if (special_instructions) updateData.special_instructions = special_instructions;
    if (new_total !== undefined) updateData.total_amount = new_total;

    if (modifications) {
      updateData.special_instructions = `${modifications} - Modified at ${new Date().toLocaleString()}`;
      updateData.status = 'modified';
    }

    // Update the order - only if status is pending or modified
    const { data: order, error } = await supabase
      .from('orders')
      .update(updateData)
      .eq('id', order_id)
      .in('status', ['pending', 'modified'])
      .select()
      .single();

    if (error) {
      console.error('Error updating order:', error);
      return new Response(JSON.stringify({
        data: null,
        error: error.message
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500
      });
    }

    return new Response(JSON.stringify({ data: order }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Function error:', error);
    return new Response(JSON.stringify({
      data: null,
      error: error.message
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500
    });
  }
});
