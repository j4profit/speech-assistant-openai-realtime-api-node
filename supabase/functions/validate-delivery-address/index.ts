import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};

// Enhanced OpenStreetMap geocoding with fallback strategies
async function geocodeWithOpenStreetMap(address: string, timeoutMs = 8000) {
  try {
    console.log(`🗺️ OpenStreetMap geocoding: ${address}`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    // Enhanced query with structured format
    const query = encodeURIComponent(address);
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${query}&countrycodes=us&addressdetails=1&limit=1`;

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Restaurant-Delivery-Service/1.0'
      }
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const results = await response.json();

    if (results && results.length > 0) {
      const result = results[0];
      console.log(`✅ OpenStreetMap found: ${result.display_name}`);
      return {
        latitude: parseFloat(result.lat),
        longitude: parseFloat(result.lon),
        formatted_address: result.display_name,
        accuracy: result.class === 'building' ? 'high' : 'medium'
      };
    } else {
      console.log(`❌ OpenStreetMap: No results for ${address}`);
      return null;
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      console.log(`⏱️ OpenStreetMap timeout for: ${address}`);
    } else {
      console.log(`❌ OpenStreetMap error: ${error.message}`);
    }
    return null;
  }
}

// Enhanced address validation with OpenStreetMap
async function validateDeliveryAddress(address: string, restaurantId: string, supabase: any) {
  console.log(`📍 Enhanced validation starting: {
  address: ${address},
  restaurant_id: ${restaurantId}
}`);

  // Basic validation
  if (!address || typeof address !== 'string' || address.trim().length < 10) {
    return {
      valid: false,
      reason: 'incomplete_address',
      message: 'Please provide your complete delivery address with street number, street name, and city or ZIP code.',
      address: address
    };
  }

  const cleanAddress = address.trim();

  // Enhanced address pattern validation
  const addressPatterns = [
    /^\d+\s+[\w\s]+\s+(street|st|avenue|ave|road|rd|drive|dr|lane|ln|boulevard|blvd|way|circle|cir|court|ct|place|pl)/i,
    /^\d+\s+[\w\s]+,\s*[\w\s]+,\s*[a-z]{2}\s*\d{5}/i,
    /^\d+\s+[\w\s]+\s+[\w\s]+,?\s*\d{5}/i
  ];

  const hasValidPattern = addressPatterns.some(pattern => pattern.test(cleanAddress));

  if (!hasValidPattern) {
    return {
      valid: false,
      reason: 'invalid_format',
      message: 'Please provide a complete address with street number, street name, and city or ZIP code.',
      address: cleanAddress
    };
  }

  try {
    // Get restaurant location from database
    const { data: restaurant, error: restaurantError } = await supabase
      .from('restaurants')
      .select('*')
      .eq('id', restaurantId)
      .single();

    if (restaurantError || !restaurant) {
      console.log(`❌ Failed to get restaurant data:`, restaurantError);
      return {
        valid: false,
        reason: 'system_error',
        message: 'Unable to validate delivery area right now. Would you prefer pickup instead?',
        address: cleanAddress,
        geocoding_attempted: false
      };
    }

    // Note: Delivery availability already checked in greeting message
    // If customer is providing address, delivery was already offered

    // Geocode with OpenStreetMap
    const geocodeResult = await geocodeWithOpenStreetMap(cleanAddress);

    if (!geocodeResult) {
      return {
        valid: false,
        reason: 'address_not_found',
        message: 'I could not locate that address. Please verify the address and try again, or choose pickup instead.',
        address: cleanAddress,
        geocoding_attempted: true
      };
    }

    // Calculate distance using Haversine formula
    const R = 3959; // Earth's radius in miles
    const dLat = (geocodeResult.latitude - restaurant.latitude) * Math.PI / 180;
    const dLon = (geocodeResult.longitude - restaurant.longitude) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(restaurant.latitude * Math.PI / 180) * Math.cos(geocodeResult.latitude * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const distance = R * c;

    const deliveryRadius = restaurant.delivery_radius || 5.0;

    if (distance > deliveryRadius) {
      return {
        valid: false,
        reason: 'outside_delivery_area',
        message: `That address is ${distance.toFixed(1)} miles away, but we only deliver within ${deliveryRadius} miles. Would you prefer pickup instead?`,
        address: cleanAddress,
        distance: distance.toFixed(1),
        geocoding_attempted: true
      };
    }

    console.log(`✅ Enhanced validation success: {
  address: ${cleanAddress},
  distance: ${distance.toFixed(1)} miles,
  within_radius: ${deliveryRadius} miles
}`);

    return {
      valid: true,
      address: cleanAddress,
      formatted_address: geocodeResult.formatted_address,
      distance: distance.toFixed(1),
      delivery_radius: deliveryRadius,
      geocoding_attempted: true,
      preparation_time: restaurant.preparation_time || 20,
      delivery_time: restaurant.delivery_time || 30
    };

  } catch (error) {
    console.log(`❌ Enhanced validation error: ${error.message}`);
    return {
      valid: false,
      reason: 'validation_error',
      message: 'Unable to validate your delivery address right now. Would you prefer pickup instead?',
      address: cleanAddress,
      geocoding_attempted: true
    };
  }
}

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // Create Supabase client
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const { address, restaurant_id, customer_phone } = await req.json();

    console.log(`🔍 Validate delivery address request:`, { address, restaurant_id, customer_phone });

    // Validate required fields
    if (!address) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Address is required'
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400
      });
    }

    if (!restaurant_id) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Restaurant ID is required'
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400
      });
    }

    // NEW: Check cache first if customer_phone is provided
    if (customer_phone) {
      console.log(`💾 Checking cache for customer: ${customer_phone}`);

      const { data: cachedAddress } = await supabaseClient
        .from('customer_delivery_addresses')
        .select('*')
        .eq('restaurant_id', restaurant_id)
        .eq('customer_phone', customer_phone)
        .maybeSingle();

      if (cachedAddress) {
        console.log(`✅ Found cached address: ${cachedAddress.delivery_address}`);

        // Update usage stats
        await supabaseClient
          .from('customer_delivery_addresses')
          .update({
            last_used_at: new Date().toISOString(),
            times_used: cachedAddress.times_used + 1
          })
          .eq('id', cachedAddress.id);

        // Return cached validation result
        if (cachedAddress.is_valid) {
          console.log(`🚀 Fast path: Returning cached VALID address`);
          return new Response(JSON.stringify({
            success: true,
            data: {
              valid: true,
              address: cachedAddress.delivery_address,
              formatted_address: cachedAddress.formatted_address,
              distance: cachedAddress.distance_from_restaurant,
              cached: true,
              times_used: cachedAddress.times_used + 1
            }
          }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 200
          });
        } else {
          console.log(`⚠️ Fast path: Returning cached INVALID address`);
          return new Response(JSON.stringify({
            success: true,
            data: {
              valid: false,
              reason: cachedAddress.validation_reason || 'outside_delivery_area',
              message: cachedAddress.validation_reason || 'This address is outside our delivery area. Would you prefer pickup?',
              address: cachedAddress.delivery_address,
              distance: cachedAddress.distance_from_restaurant,
              cached: true
            }
          }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 200
          });
        }
      } else {
        console.log(`📍 No cached address found, proceeding with full validation`);
      }
    }

    // Validate delivery address (not in cache or customer_phone not provided)
    const validationResult = await validateDeliveryAddress(address, restaurant_id, supabaseClient);

    console.log(`✅ Address validation completed:`, validationResult);

    return new Response(JSON.stringify({
      success: true,
      data: {
        ...validationResult,
        cached: false
      }
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200
    });

  } catch (error) {
    console.error('❌ Validate delivery address error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500
    });
  }
});
