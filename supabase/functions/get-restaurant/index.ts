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
    const { phone_number } = await req.json();

    console.log('Looking up restaurant for phone:', phone_number);

    if (!phone_number || phone_number === '9999999999') {
      return new Response(JSON.stringify({
        data: null,
        error: 'Invalid phone number'
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Modified database query - restaurants get all fields, optimize menu_items only
    const { data: restaurant, error } = await supabase
      .from('restaurants')
      .select(`
        *,
        menu_items(
          name,
          description,
          price,
          category,
          size
        )
      `)
      .eq('phone_number', phone_number)
      .eq('menu_items.available', true)
      .single();

    // DEBUG LOGGING
    console.log('Raw database query result:', restaurant);
    console.log('Restaurant name field:', restaurant?.name);
    console.log('Restaurant object keys:', restaurant ? Object.keys(restaurant) : 'null');
    console.log('Type of name field:', typeof restaurant?.name);
    console.log('Restaurant delivery_enabled:', restaurant?.delivery_enabled);
    console.log('Available menu items count:', restaurant?.menu_items?.length);
    console.log('Full restaurant object:', JSON.stringify(restaurant, null, 2));

    if (error) {
      console.error('Database error:', error);
      return new Response(JSON.stringify({
        data: null,
        error: error.message
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (!restaurant) {
      console.log('No restaurant found for phone number:', phone_number);
      return new Response(JSON.stringify({
        data: null,
        error: 'Restaurant not found'
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Group menu items by name to reduce repetition
    const groupedMenuItems = {};
    restaurant.menu_items?.forEach((item) => {
      const baseName = item.name;
      if (!groupedMenuItems[baseName]) {
        groupedMenuItems[baseName] = {
          name: baseName,
          description: item.description,
          category: item.category,
          sizes: []
        };
      }
      groupedMenuItems[baseName].sizes.push({
        size: item.size || 'Regular',
        price: item.price
      });
    });

    // Convert back to array and sort sizes by price
    const optimizedMenuItems = Object.values(groupedMenuItems).map((item) => ({
      ...item,
      sizes: item.sizes.sort((a, b) => a.price - b.price)
    }));

    // Replace original menu_items with optimized version
    restaurant.menu_items = optimizedMenuItems;

    console.log('About to return restaurant data with name:', restaurant.name);
    console.log('Optimized menu items count:', optimizedMenuItems.length);

    // Return the restaurant data
    return new Response(JSON.stringify({
      data: restaurant
    }), {
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
