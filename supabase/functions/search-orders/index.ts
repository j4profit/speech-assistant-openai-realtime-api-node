import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    console.log('=== search-orders function started ===');

    // Parse and validate request
    let requestBody;
    try {
      requestBody = await req.json();
      console.log('Request received:', JSON.stringify(requestBody));
    } catch (parseError) {
      console.error('JSON parse error:', parseError.message);
      return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400
      });
    }

    const { phone_number, restaurant_id, days_back = 7 } = requestBody;

    // Validate required parameters for multi-tenant security
    if (!phone_number) {
      console.error('Missing phone_number parameter - caller ID required for customer identification');
      return new Response(JSON.stringify({ error: 'phone_number is required for customer identification' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400
      });
    }

    if (!restaurant_id) {
      console.error('Missing restaurant_id parameter - required for tenant isolation');
      return new Response(JSON.stringify({ error: 'restaurant_id is required for data isolation' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400
      });
    }

    console.log('Multi-tenant security check - Parameters validated:', {
      phone_number: phone_number,
      restaurant_id: restaurant_id,
      days_back: days_back,
      security_note: 'Both phone and restaurant required for data isolation'
    });

    // Initialize Supabase client
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!supabaseUrl || !supabaseKey) {
      console.error('Missing environment variables');
      return new Response(JSON.stringify({ error: 'Server configuration error' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500
      });
    }

    console.log('Creating Supabase client...');
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Calculate cutoff date
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days_back);
    console.log('Searching orders since:', cutoffDate.toISOString());

    // MULTI-TENANT SECURITY: Query with both customer phone AND restaurant isolation
    console.log('Executing multi-tenant secure query...');
    console.log('Security filters: phone =', phone_number, ', restaurant =', restaurant_id);

    const { data: orders, error: ordersError } = await supabase
      .from('orders')
      .select(`
        id,
        customer_phone,
        customer_name,
        total_amount,
        status,
        order_details,
        special_instructions,
        created_at,
        order_type,
        delivery_address
      `)
      .eq('customer_phone', phone_number)     // Customer identification
      .eq('restaurant_id', restaurant_id)      // Tenant isolation
      .eq('status', 'pending')                 // Only modifiable orders
      .gte('created_at', cutoffDate.toISOString())
      .order('created_at', { ascending: false })
      .limit(3);

    if (ordersError) {
      console.error('Orders query failed:', ordersError);
      return new Response(JSON.stringify({
        error: 'Database query failed',
        details: ordersError.message,
        code: ordersError.code
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500
      });
    }

    console.log(`Found ${orders?.length || 0} orders`);

    // Return orders without trying to fetch order_items
    console.log('Returning', orders?.length || 0, 'orders');

    return new Response(JSON.stringify({
      success: true,
      orders: orders || [],
      count: orders?.length || 0,
      phone_searched: phone_number,
      restaurant_id: restaurant_id
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200
    });

  } catch (error) {
    console.error('=== CRITICAL ERROR ===');
    console.error('Error type:', error.constructor.name);
    console.error('Error message:', error.message);
    console.error('Error stack:', error.stack);
    console.error('=== END ERROR ===');

    return new Response(JSON.stringify({
      error: 'Internal server error',
      message: error.message,
      type: error.constructor.name
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500
    });
  }
});
