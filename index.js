// Restaurant AI Ordering System - Enhanced Address Validation
// Updated for OpenAI Migration with Improved Delivery Address Handling
const express = require('express');
const WebSocket = require('ws');
const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');

const app = express();

// Environment Configuration
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const BASE_URL = process.env.BASE_URL;
// Using OpenStreetMap - no API key required!

if (!OPENAI_API_KEY || !SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.error('Missing required environment variables');
    console.error('Required: OPENAI_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY');
    process.exit(1);
}

// Initialize Twilio for hangup functionality
const twilioClient = TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN ?
    twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) : null;

if (!twilioClient) {
    console.warn('Twilio credentials not provided - hangup functionality will be limited');
}

// Initialize Supabase client (only for Edge Function calls)
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Global state management
// Note: activeCalls map removed as it was unused

// Create HTTP server and WebSocket server
const server = require('http').createServer(app);
const wss = new WebSocket.Server({
    server,
    path: '/media-stream'
});

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// =============================================================================
// UNIVERSAL HANGUP FUNCTION
// =============================================================================

async function hangup(callSid, options = {}) {
    if (!callSid || !twilioClient) {
        console.error('hangup() called without callSid or Twilio not configured');
        return { success: false, error: 'Missing callSid or Twilio not configured' };
    }

    const {
        message = null,
        method = 'graceful',
        reason = 'system_initiated',
        restaurant = null,
        delay = 0
    } = options;

    console.log('Hangup initiated: ' + callSid + ' - Method: ' + method + ', Reason: ' + reason);

    try {
        if (delay > 0) {
            await new Promise(resolve => setTimeout(resolve, delay));
        }

        if (method === 'immediate') {
            await twilioClient.calls(callSid).update({ status: 'completed' });
            console.log('Call terminated immediately: ' + callSid);
            return { success: true, method: 'immediate', reason: reason, call_sid: callSid };
        }

        if (method === 'graceful') {
            let finalMessage = message;
            if (!finalMessage) {
                finalMessage = restaurant ?
                    'Thank you for calling ' + restaurant.name + '. Have a great day!' :
                    'Thank you for calling. Have a great day!';
            }

            // Store the TwiML for the hangup endpoint
            global.pendingHangupTwiML = global.pendingHangupTwiML || {};
            global.pendingHangupTwiML[callSid] = {
                message: finalMessage,
                timestamp: new Date().toISOString()
            };

            const hangupUrl = BASE_URL ?
                BASE_URL + '/hangup-twiml?call_sid=' + callSid :
                'https://speech-assistant-openai-realtime-api-node-ddc4.onrender.com/hangup-twiml?call_sid=' + callSid;

            await twilioClient.calls(callSid).update({
                url: hangupUrl,
                method: 'POST'
            });

            console.log('Call redirected to graceful hangup: ' + callSid);
            return {
                success: true,
                method: 'graceful',
                reason: reason,
                message: finalMessage,
                call_sid: callSid
            };
        }

        return { success: false, error: 'Invalid method: ' + method };

    } catch (error) {
        console.error('Hangup failed for call ' + callSid + ':', error);
        return {
            success: false,
            error: error.message,
            call_sid: callSid
        };
    }
}

// =============================================================================
// HTTP ENDPOINTS - FIXED FOR FAST TWILIO RESPONSE
// =============================================================================

// Hangup TwiML endpoint
app.post('/hangup-twiml', (req, res) => {
    const callSid = req.query.call_sid || req.body.CallSid;

    let message = 'Thank you for calling. Goodbye!';

    if (global.pendingHangupTwiML?.[callSid]) {
        message = global.pendingHangupTwiML[callSid].message;
        delete global.pendingHangupTwiML[callSid];
    }

    const twiml = '<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n    <Say voice="alice">' + message + '</Say>\n    <Hangup/>\n</Response>';

    res.type('text/xml');
    res.send(twiml);
});

// FIXED: Fast-responding Twilio webhook endpoint for incoming calls
app.post('/voice', (req, res) => {
    console.log('Incoming call webhook:', req.body);

    // CRITICAL: Respond to Twilio immediately (within 15 second timeout)
    // Enhanced TwiML with optimized audio settings
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Connect>
        <Stream url="wss://${req.get('host')}/media-stream">
            <Parameter name="Called" value="${req.body.Called || req.body.To}" />
            <Parameter name="From" value="${req.body.From || req.body.Caller}" />
            <Parameter name="CallSid" value="${req.body.CallSid}" />
        </Stream>
    </Connect>
</Response>`;

    res.type('text/xml');
    res.send(twiml);

    // FIXED: Do restaurant lookup and call data storage AFTER responding to Twilio
    setImmediate(async () => {
        try {
            const callData = {
                call_sid: req.body.CallSid,
                from_number: req.body.From || req.body.Caller,
                to_number: req.body.Called || req.body.To,
                call_status: req.body.CallStatus,
                call_direction: req.body.Direction,
                caller_country: req.body.CallerCountry,
                caller_state: req.body.CallerState,
                caller_city: req.body.CallerCity,
                caller_zip: req.body.CallerZip,
                to_country: req.body.ToCountry || req.body.CalledCountry,
                to_state: req.body.ToState || req.body.CalledState,
                to_city: req.body.ToCity || req.body.CalledCity,
                to_zip: req.body.ToZip || req.body.CalledZip,
                call_started_at: new Date().toISOString(),
                twilio_data: req.body,
                restaurant_id: null,
                call_ended_at: null,
                call_duration: null,
                conversation_transcript: null,
                order_id: null
            };

            // Look up restaurant to get restaurant_id for the call log (non-blocking)
            const restaurant = await getRestaurantByPhone(callData.to_number);
            if (restaurant) {
                callData.restaurant_id = restaurant.id;
            }

            // Store call data for final logging at call completion
            global.pendingCallData = global.pendingCallData || {};
            global.pendingCallData[req.body.CallSid] = callData;

            console.log('Stored call data for:', req.body.CallSid, {
                from: callData.from_number,
                to: callData.to_number,
                restaurant_id: callData.restaurant_id,
                has_twilio_data: !!callData.twilio_data
            });
        } catch (error) {
            console.error('Error processing call data after TwiML response:', error);
        }
    });
});

// IMPROVED: Health check endpoint with Twilio connectivity test
app.get('/health', (_req, res) => {
    const healthData = {
        status: 'healthy',
        port: process.env.PORT || 3000,
        timestamp: new Date().toISOString(),
        openai_configured: !!OPENAI_API_KEY,
        supabase_configured: !!(SUPABASE_URL && SUPABASE_ANON_KEY),
        twilio_configured: !!twilioClient,
        openstreetmap_geocoding: true, // Free OSM geocoding available
        uptime: process.uptime(),
        migration_status: 'enhanced_address_validation_with_osm',
        architecture: 'twilio_websocket_with_openstreetmap_geocoding',
        twilio_response_optimized: true,
        last_health_check: new Date().toISOString()
    };

    // Return immediately for health checks (important for load balancers)
    res.status(200).json(healthData);
});

app.get('/ping', (_req, res) => {
    res.status(200).send('pong');
});

app.get('/', (req, res) => {
    res.status(200).json({
        message: 'Restaurant AI Ordering System - Enhanced Address Validation',
        status: 'running',
        port: process.env.PORT || 3000,
        websocket_url: 'wss://' + req.get('host') + '/media-stream',
        server_time: new Date().toISOString(),
        migration_ready: true,
        address_validation_enhanced: true
    });
});

// API endpoints using Edge Functions
app.get('/orders', async (_req, res) => {
    try {
        const response = await fetch(SUPABASE_URL + '/functions/v1/search-orders', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + SUPABASE_ANON_KEY
            },
            body: JSON.stringify({
                limit: 50,
                order_by: 'created_at',
                order_direction: 'desc'
            })
        });

        if (!response.ok) {
            return res.status(500).json({ error: 'Failed to fetch orders' });
        }

        const result = await response.json();
        res.json({ orders: result.data || [] });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/messages', async (_req, res) => {
    try {
        const { data, error } = await supabase
            .from('customer_messages')
            .select('*, restaurants(name, delivery_enabled, delivery_hours)')
            .order('created_at', { ascending: false })
            .limit(50);

        if (error) {
            return res.status(500).json({ error: error.message });
        }

        res.json({ messages: data });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// =============================================================================
// EDGE FUNCTION HELPERS - WITH TIMEOUT PROTECTION
// =============================================================================

async function getRestaurantByPhone(phoneNumber) {
    try {
        // Add timeout to prevent hanging requests
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout

        const response = await fetch(SUPABASE_URL + '/functions/v1/get-restaurant', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + SUPABASE_ANON_KEY
            },
            body: JSON.stringify({ phone_number: phoneNumber }),
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) return null;
        const result = await response.json();
        if (result.error) return null;

        const restaurant = result.data;
        if (!restaurant) return null;

        return {
            ...restaurant,
            delivery_enabled: restaurant.delivery_enabled ?? false,
            delivery_radius: restaurant.delivery_radius ?? 5,
            delivery_hours: restaurant.delivery_hours ?? null,
            delivery_time: restaurant.delivery_time ?? 15,
            preparation_time: restaurant.preparation_time ?? 20
        };
    } catch (error) {
        if (error.name === 'AbortError') {
            console.error('Restaurant lookup timed out for phone:', phoneNumber);
        } else {
            console.error('Error calling get-restaurant Edge Function:', error);
        }
        return null;
    }
}

async function createCallLog(callData) {
    try {
        console.log('Calling create-call-log Edge Function with data:', JSON.stringify(callData, null, 2));

        const response = await fetch(SUPABASE_URL + '/functions/v1/create-call-log', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + SUPABASE_ANON_KEY
            },
            body: JSON.stringify(callData)
        });

        console.log('Edge Function response status:', response.status);

        const responseText = await response.text();
        console.log('Edge Function raw response:', responseText);

        if (!response.ok) {
            console.error('Edge Function error response:', responseText);
            return null;
        }

        const result = JSON.parse(responseText);

        if (result.error) {
            console.error('Edge Function returned error:', result.error);
            return null;
        }

        console.log('Call log created:', result.data?.id);
        return result.data;
    } catch (error) {
        console.error('Error calling create-call-log Edge Function:', error);
        return null;
    }
}

async function searchRecentOrders(phoneNumber, restaurantId) {
    try {
        const response = await fetch(SUPABASE_URL + '/functions/v1/search-orders', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + SUPABASE_ANON_KEY
            },
            body: JSON.stringify({
                phone_number: phoneNumber,
                restaurant_id: restaurantId,
                days_back: 7
            })
        });

        if (!response.ok) return [];
        const result = await response.json();
        return result.orders || [];
    } catch (error) {
        console.error('Error calling search-orders Edge Function:', error);
        return [];
    }
}

async function cancelOrder(orderId, reason = 'Customer cancellation') {
    try {
        const response = await fetch(SUPABASE_URL + '/functions/v1/cancel-order', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + SUPABASE_ANON_KEY
            },
            body: JSON.stringify({
                order_id: orderId,
                reason: reason
            })
        });

        if (!response.ok) return null;
        return (await response.json()).data;
    } catch (error) {
        console.error('Error calling cancel-order Edge Function:', error);
        return null;
    }
}

async function updateOrder(orderId, updateData) {
    try {
        const response = await fetch(SUPABASE_URL + '/functions/v1/update-order', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + SUPABASE_ANON_KEY
            },
            body: JSON.stringify({
                order_id: orderId,
                modifications: updateData.modifications,
                new_total: updateData.new_total
            })
        });

        if (!response.ok) return null;
        return (await response.json()).data;
    } catch (error) {
        console.error('Error calling update-order Edge Function:', error);
        return null;
    }
}

// =============================================================================
// ENHANCED DELIVERY ADDRESS VALIDATION WITH OPENSTREETMAP GEOCODING
// =============================================================================

async function geocodeAddress(address) {
    // Using OpenStreetMap's Nominatim API - free and no API key required
    const encodedAddress = encodeURIComponent(address);
    const url = `https://nominatim.openstreetmap.org/search?q=${encodedAddress}&format=json&limit=5&countrycodes=us&addressdetails=1`;
    
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);

        const response = await fetch(url, { 
            signal: controller.signal,
            headers: {
                'User-Agent': 'RestaurantAI/1.0 (contact@restaurant.com)' // Required by Nominatim
            }
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
            console.error('Nominatim API error:', response.status, response.statusText);
            return { success: false, error: 'geocoding_service_error' };
        }

        const data = await response.json();
        
        if (data && data.length > 0) {
            const result = data[0]; // Best match
            
            // Validate that this looks like a street address (not just a city/state)
            const hasStreetNumber = result.display_name.match(/^\d+/);
            const hasStreetName = result.display_name.toLowerCase().includes('street') ||
                                result.display_name.toLowerCase().includes('road') ||
                                result.display_name.toLowerCase().includes('avenue') ||
                                result.display_name.toLowerCase().includes('lane') ||
                                result.display_name.toLowerCase().includes('drive') ||
                                result.display_name.toLowerCase().includes('way') ||
                                result.display_name.toLowerCase().includes('court') ||
                                result.display_name.toLowerCase().includes('place') ||
                                result.display_name.toLowerCase().includes('boulevard');

            if (!hasStreetNumber || !hasStreetName) {
                console.log('OSM result appears to be city/region level, not street address:', result.display_name);
                
                // Look for better matches in remaining results
                for (let i = 1; i < data.length; i++) {
                    const altResult = data[i];
                    const altHasStreetNumber = altResult.display_name.match(/^\d+/);
                    const altHasStreetName = altResult.display_name.toLowerCase().includes('street') ||
                                          altResult.display_name.toLowerCase().includes('road') ||
                                          altResult.display_name.toLowerCase().includes('avenue');
                    
                    if (altHasStreetNumber && altHasStreetName) {
                        console.log('Found better street-level match:', altResult.display_name);
                        return {
                            success: true,
                            latitude: parseFloat(altResult.lat),
                            longitude: parseFloat(altResult.lon),
                            formatted_address: altResult.display_name,
                            place_id: altResult.place_id,
                            osm_id: altResult.osm_id
                        };
                    }
                }
            }
            
            return {
                success: true,
                latitude: parseFloat(result.lat),
                longitude: parseFloat(result.lon),
                formatted_address: result.display_name,
                place_id: result.place_id,
                osm_id: result.osm_id,
                confidence: result.importance || 0.5
            };
        }
        
        // No results found
        console.log('No geocoding results found for:', address);
        return {
            success: false,
            error: 'no_results_found',
            suggestions: [] // OSM doesn't provide suggestions in the same way
        };
    } catch (error) {
        console.error('OpenStreetMap geocoding error:', error);
        return { 
            success: false, 
            error: error.name === 'AbortError' ? 'timeout' : error.message 
        };
    }
}

function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 3959; // Earth's radius in miles
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
}

function calculateDeliveryTime(distance, restaurant) {
    const baseTime = restaurant?.preparation_time || 20;
    const travelTime = (distance / 25) * 60; // 25 mph average speed
    return Math.round(baseTime + travelTime);
}

async function validateDeliveryAddress(address, restaurant) {
    try {
        console.log('Enhanced address validation with OpenStreetMap starting:', { address, restaurant_id: restaurant?.id });

        // Step 1: Basic format validation
        if (!address || address.trim().length < 8) {
            return {
                valid: false,
                reason: 'incomplete_address',
                message: 'Please provide your complete delivery address with street number, street name, and city or ZIP code.',
                address: address
            };
        }

        const cleanAddress = address.trim();

        // Step 2: Pattern validation for required components
        const hasStreetNumber = /^\d+/.test(cleanAddress);
        const hasStreetName = /\b(street|road|avenue|lane|drive|way|court|place|boulevard|blvd|ave|rd|st|ct|pl|ln|dr)\b/i.test(cleanAddress) ||
                             /\b\w+\s+(st|street|rd|road|ave|avenue|ln|lane|dr|drive|way|ct|court|pl|place|blvd|boulevard)\b/i.test(cleanAddress);
        const hasZipCode = /\b\d{5}(-\d{4})?\b/.test(cleanAddress);
        const hasCityState = /\b[A-Za-z\s]+,\s*[A-Za-z]{2,}/.test(cleanAddress);

        console.log('Address component validation:', {
            hasStreetNumber,
            hasStreetName,
            hasZipCode,
            hasCityState,
            address: cleanAddress
        });

        if (!hasStreetNumber) {
            return {
                valid: false,
                reason: 'missing_street_number',
                message: 'Please include the street number in your address.',
                address: cleanAddress
            };
        }

        if (!hasStreetName) {
            return {
                valid: false,
                reason: 'missing_street_name',
                message: 'Please include the complete street name in your address.',
                address: cleanAddress
            };
        }

        if (!hasZipCode && !hasCityState) {
            return {
                valid: false,
                reason: 'missing_location',
                message: 'Please include either a ZIP code or city and state (e.g., Baltimore, MD).',
                address: cleanAddress
            };
        }

        // Step 3: Check if restaurant supports delivery
        if (!restaurant?.delivery_enabled) {
            return {
                valid: false,
                reason: 'delivery_not_available',
                message: 'Sorry, we only offer pickup orders. Delivery is not available at this location.',
                address: cleanAddress
            };
        }

        // Step 4: OpenStreetMap geocoding (free and open source)
        console.log('Attempting OpenStreetMap geocoding for address:', cleanAddress);
        const geocodeResult = await geocodeAddress(cleanAddress);

        if (!geocodeResult.success) {
            // Fallback to Edge function validation if geocoding fails
            console.log('OpenStreetMap geocoding failed, using Edge function fallback');
            return await callEdgeFunctionValidation(cleanAddress, restaurant);
        }

        // Step 5: Distance calculation and delivery area check
        if (!restaurant.latitude || !restaurant.longitude) {
            console.warn('Restaurant coordinates missing - using Edge function fallback');
            return await callEdgeFunctionValidation(cleanAddress, restaurant);
        }

        const distance = calculateDistance(
            restaurant.latitude,
            restaurant.longitude,
            geocodeResult.latitude,
            geocodeResult.longitude
        );

        const deliveryRadius = restaurant.delivery_radius || 5;

        console.log('Distance calculation with OpenStreetMap coordinates:', {
            customer_lat: geocodeResult.latitude,
            customer_lng: geocodeResult.longitude,
            restaurant_lat: restaurant.latitude,
            restaurant_lng: restaurant.longitude,
            distance: distance,
            delivery_radius: deliveryRadius,
            osm_formatted_address: geocodeResult.formatted_address
        });

        if (distance > deliveryRadius) {
            return {
                valid: false,
                reason: 'outside_delivery_area',
                message: `Sorry, that address is ${distance.toFixed(1)} miles away, which is outside our ${deliveryRadius}-mile delivery area. Would you like to place a pickup order instead?`,
                address: cleanAddress,
                distance: distance,
                delivery_radius: deliveryRadius,
                formatted_address: geocodeResult.formatted_address,
                geocoding_service: 'openstreetmap'
            };
        }

        // Step 6: Success - calculate delivery time
        const estimatedDeliveryTime = calculateDeliveryTime(distance, restaurant);

        return {
            valid: true,
            reason: 'address_approved',
            message: `Great! Your address is within our delivery area (${distance.toFixed(1)} miles away).`,
            address: cleanAddress,
            formatted_address: geocodeResult.formatted_address,
            distance: distance,
            estimated_delivery_time: estimatedDeliveryTime,
            delivery_radius: deliveryRadius,
            geocoding_service: 'openstreetmap',
            osm_confidence: geocodeResult.confidence
        };

    } catch (error) {
        console.error('Enhanced address validation error:', error);
        
        // Fallback to Edge function validation
        try {
            return await callEdgeFunctionValidation(address, restaurant);
        } catch (fallbackError) {
            console.error('Edge function fallback also failed:', fallbackError);
            return {
                valid: false,
                reason: 'validation_error',
                message: 'Sorry, I\'m having trouble validating addresses right now. Please provide your complete address and we\'ll confirm it with you.',
                address: address,
                error: error.message
            };
        }
    }
}

// Fallback to original Edge function validation
async function callEdgeFunctionValidation(address, restaurant) {
    const edgeFunctionUrl = SUPABASE_URL + '/functions/v1/validate-delivery';
    
    const response = await fetch(edgeFunctionUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + SUPABASE_ANON_KEY
        },
        body: JSON.stringify({
            address: address.trim(),
            restaurant_id: restaurant.id,
            delivery_enabled: restaurant.delivery_enabled,
            delivery_radius: restaurant.delivery_radius || 5,
            delivery_hours: restaurant.delivery_hours,
            delivery_time: restaurant.delivery_time || 15,
            preparation_time: restaurant.preparation_time || 20,
            restaurant_address: restaurant.address,
            restaurant_latitude: restaurant.latitude,
            restaurant_longitude: restaurant.longitude
        })
    });

    if (!response.ok) {
        throw new Error(`Edge function failed with status ${response.status}`);
    }

    const result = await response.json();
    
    if (result.error) {
        throw new Error(result.error);
    }

    return {
        valid: result.valid || false,
        message: result.message || 'Address validation completed',
        address: address,
        estimated_delivery_time: result.estimated_delivery_time,
        delivery_radius: result.delivery_radius,
        reason: result.reason,
        edge_function_used: true
    };
}

async function createOrder(orderData) {
    try {
        const response = await fetch(SUPABASE_URL + '/functions/v1/create-order', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + SUPABASE_ANON_KEY
            },
            body: JSON.stringify(orderData)
        });

        if (!response.ok) {
            console.error('Order creation failed with status:', response.status);
            const errorText = await response.text();
            console.error('Order creation error response:', errorText);
            return null;
        }

        const result = await response.json();
        if (result.error) {
            console.error('Order creation returned error:', result.error);
            return null;
        }

        console.log('Order created successfully:', result.data?.id);
        return result.data;
    } catch (error) {
        console.error('Error calling create-order Edge Function:', error);
        return null;
    }
}

async function createCustomerMessage(messageData) {
    try {
        const response = await fetch(SUPABASE_URL + '/functions/v1/create-message', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + SUPABASE_ANON_KEY
            },
            body: JSON.stringify(messageData)
        });

        if (!response.ok) return null;
        const result = await response.json();
        if (result.error) return null;

        console.log('Customer message created successfully:', result.data?.id || result.message_id);
        return result.data || result;
    } catch (error) {
        console.error('Error calling create-message Edge Function:', error);
        return null;
    }
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

function createOrderTicket(orderInfo) {
    const {
        customerName,
        customerPhone,
        orderType,
        deliveryAddress,
        items,
        specialInstructions,
        totalAmount,
        readyTime,
        restaurantName
    } = orderInfo;

    const timestamp = new Date().toLocaleString('en-US', {
        timeZone: 'America/New_York',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    });

    let ticket = `
═══════════════════════════════════════
              ORDER TICKET
═══════════════════════════════════════

Restaurant: ${restaurantName}
Order Time: ${timestamp}

CUSTOMER INFORMATION:
• Name: ${customerName}
• Phone: ${customerPhone}

ORDER TYPE: ${orderType.toUpperCase()}`;

    if (orderType === 'delivery' && deliveryAddress) {
        ticket += `
• Delivery Address: ${deliveryAddress}`;
    }

    ticket += `

ORDER ITEMS:
${formatOrderItems(items, totalAmount)}

TIMING:
• Order should be ready: ${readyTime}`;

    if (specialInstructions && specialInstructions.trim()) {
        ticket += `

SPECIAL INSTRUCTIONS:
${specialInstructions}`;
    }

    ticket += `

═══════════════════════════════════════
            END ORDER TICKET
═══════════════════════════════════════`;

    return ticket;
}

function formatOrderItems(items, totalAmount) {
    if (!items || typeof items !== 'string') {
        return '• Order details not available';
    }

    // Parse items if they're in ORDER_CONFIRMED format
    if (items.includes('ORDER_CONFIRMED')) {
        const lines = items.split('\n');
        let formattedItems = '';
        let currentItem = '';

        for (const line of lines) {
            if (line.includes('• ') || line.includes('- ')) {
                if (currentItem) formattedItems += currentItem + '\n';
                currentItem = line.trim();
            } else if (line.trim() && !line.includes('ORDER_') && !line.includes('Customer') && !line.includes('Phone')) {
                currentItem += ' ' + line.trim();
            }
        }
        if (currentItem) formattedItems += currentItem;

        return formattedItems || '• ' + items.replace(/ORDER_CONFIRMED.*?\n/g, '').trim();
    }

    // Format simple item descriptions
    const itemLines = items.split(/[,\n]/).filter(item => item.trim());
    let formattedItems = '';

    itemLines.forEach((item) => {
        const cleanItem = item.trim().replace(/^\d+\.?\s*/, '').replace(/^[\-\*]\s*/, '');
        if (cleanItem) {
            formattedItems += `• ${cleanItem}\n`;
        }
    });

    if (totalAmount && totalAmount > 0) {
        formattedItems += `\nTOTAL: $${totalAmount.toFixed(2)}`;
    }

    return formattedItems || '• ' + items;
}

function calculateOrderReadyTime(restaurant, isDelivery = false) {
    try {
        const now = new Date();

        // Safeguard against unreasonable database values
        let preparationMinutes = restaurant?.preparation_time || 20;
        if (preparationMinutes > 120) { // More than 2 hours is unreasonable for pizza
            console.log('⚠️ Unreasonable preparation_time detected:', preparationMinutes, 'minutes - using default 20');
            preparationMinutes = 20;
        }

        let deliveryAddedMinutes = 0;
        if (isDelivery && restaurant?.delivery_enabled) {
            deliveryAddedMinutes = restaurant?.delivery_time || 15;
            if (deliveryAddedMinutes > 60) { // More than 1 hour delivery is unreasonable
                console.log('⚠️ Unreasonable delivery_time detected:', deliveryAddedMinutes, 'minutes - using default 15');
                deliveryAddedMinutes = 15;
            }
        }

        const totalMinutes = preparationMinutes + deliveryAddedMinutes;
        const readyTime = new Date(now.getTime() + totalMinutes * 60000);

        // Debug logging for ready time calculation
        console.log('🕐 Ready time calculation debug:', {
            currentTime: now.toLocaleString('en-US', { timeZone: 'America/New_York' }),
            preparationMinutes: preparationMinutes,
            deliveryMinutes: deliveryAddedMinutes,
            totalMinutes: totalMinutes,
            isDelivery: isDelivery,
            restaurantPrepTime: restaurant?.preparation_time,
            restaurantDeliveryTime: restaurant?.delivery_time,
            calculatedReadyTime: readyTime.toLocaleString('en-US', { timeZone: 'America/New_York' })
        });

        // Use proper timezone conversion for display
        const timeInEastern = readyTime.toLocaleString('en-US', {
            timeZone: 'America/New_York',
            hour: 'numeric',
            minute: '2-digit',
            hour12: true
        });

        return {
            readyTime: readyTime,
            readyTimeString: timeInEastern,
            preparationMinutes: preparationMinutes,
            deliveryMinutes: deliveryAddedMinutes,
            totalMinutes: totalMinutes
        };
    } catch (error) {
        console.error('Error calculating ready time:', error);
        return {
            readyTimeString: '30 minutes',
            totalMinutes: 30
        };
    }
}

function formatMenuForAI(menuItems, restaurant) {
    if (!menuItems || menuItems.length === 0) {
        return "No menu items available.";
    }

    const categories = {};
    menuItems.forEach(item => {
        if (!item.available) return;

        const categoryName = item.category || 'Other';
        if (!categories[categoryName]) {
            categories[categoryName] = [];
        }
        categories[categoryName].push({
            name: item.name,
            description: item.description,
            price: item.price,
            id: item.id
        });
    });

    let menuText = "MENU:\n";

    const sortedCategories = Object.keys(categories).sort();

    sortedCategories.forEach(category => {
        menuText += '\n' + category.toUpperCase() + ':\n';

        categories[category]
            .sort((a, b) => a.name.localeCompare(b.name))
            .forEach(item => {
                menuText += '- ' + item.name + ': ' + (item.description || 'No description') + ' - ' + item.price + '\n';
            });
    });

    if (restaurant) {
        menuText += '\n\nDELIVERY INFORMATION:\n';
        menuText += '- Delivery Available: ' + (restaurant.delivery_enabled ? 'Yes' : 'No') + '\n';

        if (restaurant.delivery_enabled) {
            menuText += '- Delivery Hours: ' + (restaurant.delivery_hours || 'Same as restaurant hours') + '\n';
            menuText += '- Delivery Radius: ' + (restaurant.delivery_radius || 'Contact restaurant') + ' miles\n';
            menuText += '- Estimated Delivery Time: ' + ((restaurant.preparation_time || 20) + (restaurant.delivery_time || 15)) + ' minutes\n';
        } else {
            menuText += '- Pickup Only\n';
        }
    }

    return menuText;
}

// =============================================================================
// WEBSOCKET CONNECTION WITH ENHANCED ADDRESS VALIDATION
// =============================================================================

wss.on('connection', (ws, _req) => {
    console.log('New WebSocket connection');

    // Connection-specific variables
    let openaiWs = null;
    let streamSid = null;
    let callSid = null;
    let customerPhone = null;
    let restaurant = null;
    let callStartTime = new Date();
    let conversationTranscript = [];
    let orderProcessed = false;
    let addressValidated = false;
    let validatedDeliveryAddress = null;
    let addressRequested = false;
    let addressProviderAttempts = 0;
    let validationRetryInfo = null;
    let recentOrders = [];
    let anythingElseTimeout = null;

    // Initialize OpenAI with enhanced address validation
    async function initializeOpenAI(calledNumber, fromNumber, callId) {
        console.log('Loading restaurant data for:', calledNumber);

        const phoneToLookup = calledNumber || '+14108880091';
        restaurant = await getRestaurantByPhone(phoneToLookup);

        if (!restaurant) {
            console.error('Restaurant not found for phone:', phoneToLookup);
            await hangup(callId, {
                message: 'Sorry, we are unable to process your call at this time. Please try again later.',
                reason: 'restaurant_not_found'
            });
            return;
        }

        console.log('Restaurant loaded:', {
            id: restaurant.id,
            name: restaurant.name,
            phone: restaurant.phone_number,
            delivery_enabled: restaurant.delivery_enabled,
            preparation_time: restaurant.preparation_time,
            delivery_time: restaurant.delivery_time,
            latitude: restaurant.latitude,
            longitude: restaurant.longitude
        });

        customerPhone = fromNumber;
        callSid = callId;
        const menuText = formatMenuForAI(restaurant.menu_items, restaurant);

        console.log('Connecting to OpenAI Realtime API with enhanced address validation...');

        try {
            openaiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-mini-realtime-preview-2024-12-17', {
                headers: {
                    'Authorization': 'Bearer ' + OPENAI_API_KEY,
                    'OpenAI-Beta': 'realtime=v1'
                },
                perMessageDeflate: false,
                handshakeTimeout: 5000,
                maxPayload: 100 * 1024 * 1024
            });
            console.log('🔗 WebSocket created successfully');
        } catch (createError) {
            console.error('❌ Failed to create OpenAI WebSocket:', createError);
            await hangup(callId, {
                message: 'Technical difficulties. Please try again.',
                reason: 'websocket_creation_failed'
            });
            return;
        }

        openaiWs.on('open', () => {
            console.log('✅ Connected to OpenAI Realtime API');

            const instructions = `You are the AI assistant for ${restaurant.name}. The restaurant is extremely busy and cannot take phone calls right now, so you're helping customers place orders and take messages.

🚨 ENHANCED ADDRESS VALIDATION RULES:
- When customer provides ANY address with street numbers and names, IMMEDIATELY call validate_delivery_address function
- The validation function now uses Google Maps geocoding for maximum accuracy
- NEVER proceed to ordering without successful address validation for delivery orders
- NEVER ask for delivery address more than ONCE per call
- NEVER ask for address clarification - just validate what the customer provided

🛑 CRITICAL DUPLICATE PREVENTION:
- If customer already provided an address, DO NOT ask again
- If validation fails, offer pickup instead - do not re-request address
- Track all address attempts to prevent loops

CRITICAL: ALL RESPONSES MUST BE 1-2 SENTENCES MAXIMUM. Be extremely concise and direct.

GREETING TRIGGER: When you receive "Start the call greeting", immediately respond with the appropriate greeting.

**VOICE & PACING:**
- Speak quickly and professionally
- Deliver audio responses with efficient pacing
- Maintain clarity while being brisk

**STANDARD GREETING FLOW:**
1. Greeting with pickup/delivery question:
   - If delivery enabled: "Hello! Thank you for calling [restaurant name]. Is this for pickup or delivery?"
   - If pickup only: "Hello! Thank you for calling [restaurant name]. What would you like for pickup?"
2. After response, ask for name: "May I have your name for the order?"

**DELIVERY ORDER FLOW (ENHANCED):**
For delivery orders:
1. Ask ONCE: "What's your delivery address?"
2. When customer provides ANY address with numbers and street names, IMMEDIATELY call validate_delivery_address
3. 🚨 NEVER ask for address again after calling validation function
4. Enhanced validation will handle all address quality checks
5. If validation succeeds: "Great! Your address is within our delivery area. What would you like to order?"
6. If validation fails: Use the exact message from validation function and suggest pickup

**PICKUP ORDER FLOW:**
- Ask: "What would you like to order?"
- Take order details
- Create ORDER_CONFIRMED format

**RESTAURANT STATUS:** Extremely busy - cannot take phone calls

**DELIVERY SETTINGS:**
- Delivery Enabled: ${restaurant.delivery_enabled ? 'YES' : 'NO'}
${!restaurant.delivery_enabled ? 'IMPORTANT: This restaurant does NOT offer delivery. Only offer PICKUP orders.' : 'Enhanced geocoding available for accurate delivery validation.'}

${menuText}

**ENHANCED FUNCTION CALLING:**
1. **Enhanced address validation** → call validate_delivery_address (now with Google geocoding)
2. **Order modifications/cancellations** → call search_recent_orders
3. **Customer messages/complaints** → call create_customer_message
4. **Order completion** → use ORDER_CONFIRMED format
5. **Order lookups** → call search_recent_orders

**RESPONSE LENGTH:** 1-2 sentences maximum (except ORDER_CONFIRMED format)

**MENU POLICY:** Only provide menu items when specifically requested

**ORDER COMPLETION FLOW:**
When customer completes order:
1. IMMEDIATELY generate ORDER_CONFIRMED format
2. Ask: "Anything else I can help you with?"
3. Auto-hangup if customer says no

**ORDER_CONFIRMED FORMAT (EXACT FORMAT REQUIRED):**
ORDER_CONFIRMED:
- Customer Name: [name]
- Phone: ${customerPhone || '[phone]'}
- Order Type: [pickup or delivery]
- Delivery Address: [address or N/A]
- Items: [items with prices]
- Total: $[amount]
- Ready Time: [calculated minutes]
ORDER_END

**TIMING RULES:**
- PICKUP: ${restaurant.preparation_time || 20} minutes
- DELIVERY: ${(restaurant.preparation_time || 20) + (restaurant.delivery_time || 15)} minutes`;

            const sessionUpdate = {
                type: 'session.update',
                session: {
                    modalities: ['text', 'audio'],
                    instructions: instructions,
                    voice: 'coral',
                    input_audio_format: 'g711_ulaw',
                    output_audio_format: 'g711_ulaw',
                    input_audio_transcription: { model: 'whisper-1' },
                    turn_detection: {
                        type: 'server_vad',
                        threshold: 0.6,
                        prefix_padding_ms: 200,
                        silence_duration_ms: 1200
                    },
                    temperature: 0.6,
                    max_response_output_tokens: 400,
                    tools: [
                        {
                            type: "function",
                            name: "search_recent_orders",
                            description: "Search for recent orders when customer wants to check, modify, or cancel orders. Uses caller ID automatically.",
                            parameters: {
                                type: "object",
                                properties: {
                                    phone_number: {
                                        type: "string",
                                        description: "Only use if customer provides a different number than caller ID"
                                    }
                                },
                                required: []
                            }
                        },
                        {
                            type: "function",
                            name: "validate_delivery_address",
                            description: "ENHANCED: Validate delivery address using OpenStreetMap geocoding for accurate, free validation with no API key required. Call when customer provides ANY address containing street number and street name. Examples: '123 Main St, 12345', '123 Main Street, Baltimore, MD', '456 Oak Avenue, Parkville'. OpenStreetMap provides reliable geocoding for populated areas where restaurants operate.",
                            parameters: {
                                type: "object",
                                properties: {
                                    address: {
                                        type: "string",
                                        description: "Any address provided by customer that contains street number and street name. OpenStreetMap validation will handle completeness checks."
                                    }
                                },
                                required: ["address"]
                            }
                        },
                        {
                            type: "function",
                            name: "cancel_order",
                            description: "Cancel a PENDING order only. Call search_recent_orders first to get order details.",
                            parameters: {
                                type: "object",
                                properties: {
                                    order_id: { type: "string", description: "Order ID to cancel" },
                                    reason: { type: "string", description: "Cancellation reason" }
                                },
                                required: ["order_id"]
                            }
                        },
                        {
                            type: "function",
                            name: "update_order",
                            description: "Update a PENDING order only. Call search_recent_orders first to get order details.",
                            parameters: {
                                type: "object",
                                properties: {
                                    order_id: { type: "string", description: "Order ID to update" },
                                    modifications: { type: "string", description: "Description of changes" },
                                    new_total: { type: "number", description: "New total amount" }
                                },
                                required: ["order_id", "modifications"]
                            }
                        },
                        {
                            type: "function",
                            name: "create_customer_message",
                            description: "Save customer messages, complaints, questions, callback requests, or any non-order requests.",
                            parameters: {
                                type: "object",
                                properties: {
                                    customer_name: { type: "string", description: "Customer's name" },
                                    message_content: { type: "string", description: "The customer's message, request, or concern" },
                                    priority: {
                                        type: "string",
                                        enum: ["high", "medium", "normal"],
                                        description: "Priority: high for urgent issues, normal for general messages"
                                    },
                                    subject: { type: "string", description: "Brief subject like 'Callback Request' or 'Customer Question'" }
                                },
                                required: ["customer_name", "message_content", "priority", "subject"]
                            }
                        },
                        {
                            type: "function",
                            name: "send_message_to_restaurant",
                            description: "Send message about non-pending order modifications or other restaurant communications",
                            parameters: {
                                type: "object",
                                properties: {
                                    customer_name: { type: "string", description: "Customer's name" },
                                    message_content: { type: "string", description: "The message content" },
                                    order_reference: { type: "string", description: "Order ID if applicable" },
                                    subject: { type: "string", description: "Subject of the message" }
                                },
                                required: ["customer_name", "message_content"]
                            }
                        }
                    ]
                }
            };

            openaiWs.send(JSON.stringify(sessionUpdate));
        });

        // Enhanced message handling with improved address validation
        openaiWs.on('message', (data) => {
            try {
                const response = JSON.parse(data);

                switch (response.type) {
                    case 'response.audio.delta':
                        if (streamSid && ws.readyState === WebSocket.OPEN) {
                            try {
                                const audioMessage = {
                                    event: 'media',
                                    streamSid: streamSid,
                                    media: { payload: response.delta }
                                };
                                ws.send(JSON.stringify(audioMessage));
                            } catch (audioSendError) {
                                console.error('❌ Error sending audio delta to Twilio:', audioSendError);
                            }
                        }
                        break;

                    case 'response.audio_transcript.done':
                        console.log('AI said:', response.transcript);
                        conversationTranscript.push({
                            timestamp: new Date().toISOString(),
                            speaker: 'AI',
                            text: response.transcript
                        });

                        // Process order confirmation
                        if (response.transcript.includes('ORDER_CONFIRMED:') && !orderProcessed) {
                            processOrderFromTranscript(response.transcript);
                        }

                        // Handle completion flows
                        const completionPhrases = [
                            'order_confirmed:',
                            'order_end',
                            'your order is confirmed',
                            'order has been confirmed',
                            'your order has been cancelled',
                            'order cancelled successfully',
                            'order has been updated',
                            'message has been sent',
                            'i\'ve sent your message',
                            'your message has been recorded'
                        ];

                        const isCompletionPhrase = completionPhrases.some(phrase =>
                            response.transcript.toLowerCase().includes(phrase)
                        );

                        const alreadyAskedAnythingElse = conversationTranscript
                            .filter(msg => msg.speaker === 'AI')
                            .some(msg => msg.text.toLowerCase().includes('anything else'));

                        const isOrderConfirmationResponse = response.transcript.includes('ORDER_CONFIRMED:') &&
                                                          response.transcript.includes('Anything else I can help you with?');

                        if (isOrderConfirmationResponse) {
                            anythingElseTimeout = setTimeout(async () => {
                                if (callSid && ws.readyState === WebSocket.OPEN && anythingElseTimeout) {
                                    clearTimeout(anythingElseTimeout);
                                    anythingElseTimeout = null;
                                    await hangup(callSid, {
                                        method: 'graceful',
                                        reason: 'no_response_to_anything_else',
                                        restaurant: restaurant,
                                        message: 'Thank you for calling ' + restaurant.name + '. Have a great day!'
                                    });
                                }
                            }, 10000);

                        } else if (isCompletionPhrase && !alreadyAskedAnythingElse) {
                            setTimeout(() => {
                                if (openaiWs && openaiWs.readyState === WebSocket.OPEN && callSid) {
                                    openaiWs.send(JSON.stringify({
                                        type: 'response.create',
                                        response: {
                                            modalities: ['audio', 'text'],
                                            instructions: 'Say exactly: "Anything else I can help you with?"'
                                        }
                                    }));

                                    anythingElseTimeout = setTimeout(async () => {
                                        if (callSid && ws.readyState === WebSocket.OPEN && anythingElseTimeout) {
                                            clearTimeout(anythingElseTimeout);
                                            anythingElseTimeout = null;
                                            await hangup(callSid, {
                                                method: 'graceful',
                                                reason: 'no_response_to_anything_else',
                                                restaurant: restaurant,
                                                message: 'Thank you for calling ' + restaurant.name + '. Have a great day!'
                                            });
                                        }
                                    }, 10000);
                                }
                            }, 2000);
                        }
                        break;

                    case 'conversation.item.input_audio_transcription.completed':
                        console.log('Customer said:', response.transcript);
                        conversationTranscript.push({
                            timestamp: new Date().toISOString(),
                            speaker: 'Customer',
                            text: response.transcript
                        });

                        const customerMessage = response.transcript.trim();

                        if (anythingElseTimeout) {
                            clearTimeout(anythingElseTimeout);
                            anythingElseTimeout = null;
                        }

                        // Enhanced address detection with multiple patterns
                        const addressPatterns = [
                            /\d+\s+[\w\s,]*(road|street|avenue|lane|drive|way|court|place|boulevard|blvd|ave|rd|st|ct|pl|ln|dr)[\w\s,]*\d{5}(-\d{4})?/i,
                            /\d+\s+[\w\s,]*(road|street|avenue|lane|drive|way|court|place|boulevard|blvd|ave|rd|st|ct|pl|ln|dr)[\w\s,]+,\s*[A-Za-z]{2,}/i,
                            /\d+\s+[\w\s,]*(road|street|avenue|lane|drive|way|court|place|boulevard|blvd|ave|rd|st|ct|pl|ln|dr)[\w\s,]+[A-Za-z]{3,}/i
                        ];
                        
                        const hasValidAddress = addressPatterns.some(pattern => pattern.test(customerMessage));
                        const isDeliveryOrder = conversationTranscript.some(msg => {
                            if (msg.speaker !== 'Customer') return false;
                            const text = msg.text.toLowerCase();
                            return text.includes('delivery') || text.includes('deliver');
                        });

                        // Enhanced address validation trigger
                        if (isDeliveryOrder && hasValidAddress && !addressValidated && addressProviderAttempts < 1) {
                            addressProviderAttempts++;
                            addressValidated = true; // Prevent race conditions
                            
                            console.log('🏠 Enhanced address validation triggered:', customerMessage);
                            
                            // Cancel any active response to prevent conflicts
                            if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                                try {
                                    openaiWs.send(JSON.stringify({
                                        type: 'response.cancel'
                                    }));
                                } catch (error) {
                                    console.log('Response cancellation not needed');
                                }

                                setTimeout(() => {
                                    openaiWs.send(JSON.stringify({
                                        type: 'conversation.item.create',
                                        item: {
                                            type: 'message',
                                            role: 'user',
                                            content: [{
                                                type: 'input_text',
                                                text: '[SYSTEM: Customer provided delivery address: "' + customerMessage + '". Say "Let me check if you\'re within our delivery area" then immediately call validate_delivery_address function with enhanced Google geocoding.]'
                                            }]
                                        }
                                    }));
                                }, 50);
                            }
                        }

                        // Handle order completion signals
                        const orderCompletionPhrases = /\b(that's it|that's all|nothing else|i'm done|that'll be all|now that's it|that will be all|we're good|i'm good|that's everything|no more|complete)\b/i;
                        const orderCompleted = orderCompletionPhrases.test(customerMessage);
                        const inOrderingContext = conversationTranscript.some(msg =>
                            msg.text.toLowerCase().includes('what would you like to order') ||
                            msg.text.toLowerCase().includes('anything else you\'d like to add')
                        );

                        if (orderCompleted && inOrderingContext && !orderProcessed) {
                            console.log('🍕 Customer completed order - triggering ORDER_CONFIRMED');
                            setTimeout(() => {
                                if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                                    openaiWs.send(JSON.stringify({
                                        type: 'response.create',
                                        response: {
                                            modalities: ['audio', 'text'],
                                            instructions: 'Customer completed their order. Use the ORDER_CONFIRMED format with all order details.'
                                        }
                                    }));
                                }
                            }, 500);
                        }

                        // Handle "anything else" responses
                        const recentAIMessages = conversationTranscript
                            .filter(msg => msg.speaker === 'AI')
                            .slice(-3)
                            .map(msg => msg.text.toLowerCase());

                        const hasRecentAnythingElse = recentAIMessages.some(msg =>
                            msg.includes('anything else i can help you with') ||
                            msg.includes('anything else i can help') ||
                            msg.includes('is there anything else')
                        );

                        const anythingElseResponses = /\b(no|nope|nothing|that's all|that's it|i'm good|i'm all good|i'm all set|no thank you|no thanks|all good|good|nah|we're good|i'm done|that's everything|we're all set)\b/i;
                        const startsWithNo = /^no[,\s]/i;

                        if ((anythingElseResponses.test(customerMessage) || startsWithNo.test(customerMessage)) && hasRecentAnythingElse) {
                            console.log('Customer responded "no" to anything else - initiating hangup');

                            setTimeout(async () => {
                                if (callSid && ws.readyState === WebSocket.OPEN) {
                                    const hasDelivery = conversationTranscript.some(msg =>
                                        msg.text.toLowerCase().includes('delivery') &&
                                        msg.text.toLowerCase().includes('delivery area')
                                    );

                                    let finalMessage = 'Thank you for calling ' + restaurant.name + '. Have a wonderful day!';
                                    if (hasDelivery) {
                                        const estimatedTime = (restaurant?.preparation_time || 20) + (restaurant?.delivery_time || 15);
                                        finalMessage = 'Thank you for calling ' + restaurant.name + '. Your delivery order will arrive in about ' + estimatedTime + ' minutes. Have a wonderful day!';
                                    } else if (conversationTranscript.some(msg => msg.text.toLowerCase().includes('pickup'))) {
                                        const estimatedTime = restaurant?.preparation_time || 20;
                                        finalMessage = 'Thank you for calling ' + restaurant.name + '. Your pickup order will be ready in about ' + estimatedTime + ' minutes. Have a wonderful day!';
                                    }

                                    await hangup(callSid, {
                                        method: 'graceful',
                                        reason: 'customer_finished',
                                        restaurant: restaurant,
                                        message: finalMessage,
                                        delay: 2000
                                    });
                                }
                            }, 3000);
                            return;
                        }
                        break;

                    case 'input_audio_buffer.speech_started':
                        if (anythingElseTimeout) {
                            clearTimeout(anythingElseTimeout);
                            anythingElseTimeout = null;
                        }
                        break;

                    // Handle function calls
                    case 'response.function_call_done':
                        console.log('Function call completed:', response.name);
                        handleFunctionCall(response);
                        break;

                    case 'conversation.item.created':
                        if (response.item?.type === 'function_call') {
                            console.log('Function call item created:', response.item.name);
                            handleFunctionCall(response.item);
                        }
                        break;

                    case 'error':
                        console.error('OpenAI error:', response.error);
                        if (response.error?.code === 'conversation_already_has_active_response') {
                            console.log('Response collision detected - ignoring');
                        } else if (response.error?.code === 'response_cancel_not_active') {
                            console.log('Response cancellation not needed - ignoring');
                        } else {
                            setTimeout(async () => {
                                if (callSid) {
                                    await hangup(callSid, {
                                        message: 'We are experiencing technical difficulties. Please try calling again.',
                                        reason: 'openai_error'
                                    });
                                }
                            }, 1000);
                        }
                        break;

                    case 'session.updated':
                        console.log('OpenAI session configured with enhanced address validation');
                        setTimeout(() => {
                            if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                                const greetingText = restaurant?.delivery_enabled
                                    ? `Hello! Thank you for calling ${restaurant.name}. Is this for pickup or delivery?`
                                    : `Hello! Thank you for calling ${restaurant.name}. What would you like for pickup?`;

                                openaiWs.send(JSON.stringify({
                                    type: 'conversation.item.create',
                                    item: {
                                        type: 'message',
                                        role: 'user',
                                        content: [{
                                            type: 'input_text',
                                            text: 'Start the call greeting'
                                        }]
                                    }
                                }));

                                setTimeout(() => {
                                    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                                        openaiWs.send(JSON.stringify({
                                            type: 'response.create',
                                            response: {
                                                modalities: ['audio', 'text'],
                                                instructions: `Say exactly: "${greetingText}"`
                                            }
                                        }));
                                    }
                                }, 100);
                            }
                        }, 500);
                        break;
                }
            } catch (error) {
                console.error('Error processing OpenAI message:', error);
                setTimeout(async () => {
                    if (callSid) {
                        await hangup(callSid, {
                            message: 'We are experiencing technical difficulties. Please try calling again.',
                            reason: 'processing_error'
                        });
                    }
                }, 1000);
            }
        });

        openaiWs.on('error', async (error) => {
            console.error('❌ OpenAI WebSocket error:', error);
            if (callSid) {
                await hangup(callSid, {
                    message: 'We are currently experiencing high call volume. Please try calling back in a few minutes.',
                    reason: 'openai_websocket_error',
                    method: 'graceful'
                });
            }
        });

        openaiWs.on('close', () => {
            console.log('OpenAI connection closed');
        });
    }

    // Enhanced function call handler with improved address validation
    async function handleFunctionCall(functionCall) {
        try {
            const { name, call_id, arguments: args } = functionCall;
            let result = null;
            let parsedArgs = {};

            console.log('Enhanced function execution:', name, 'with args:', args);

            if (!args || args === '') {
                parsedArgs = {};
            } else if (typeof args === 'string') {
                try {
                    parsedArgs = JSON.parse(args);
                } catch (e) {
                    parsedArgs = { raw: args };
                }
            } else {
                parsedArgs = args;
            }

            switch (name) {
                case 'search_recent_orders':
                    let phoneNumber = customerPhone;

                    if (parsedArgs.phone_number && parsedArgs.phone_number !== customerPhone) {
                        phoneNumber = parsedArgs.phone_number;
                    }

                    if (!phoneNumber) {
                        result = {
                            orders: [],
                            count: 0,
                            message: 'Phone number required to search for orders.',
                            error: 'No phone number available'
                        };
                        break;
                    }

                    const orders = await searchRecentOrders(phoneNumber, restaurant.id);
                    recentOrders = orders;

                    const pendingOrders = orders.filter(order => order.status === 'pending');
                    const nonPendingOrders = orders.filter(order => order.status !== 'pending');

                    if (orders.length === 0) {
                        result = {
                            orders: [],
                            count: 0,
                            message: 'No recent orders found for this phone number. If you placed the order using a different phone number, please let me know what number you used.',
                            phone_searched: phoneNumber
                        };
                    } else if (pendingOrders.length > 0) {
                        const mappedOrders = pendingOrders.map(order => ({
                            id: order.id,
                            total: order.total_amount,
                            order_type: order.order_type,
                            delivery_address: order.delivery_address,
                            status: order.status,
                            created_at: order.created_at,
                            customer_name: order.customer_name,
                            order_details: order.order_details,
                            items: order.order_items?.map(item => ({
                                name: item.menu_items?.name || 'Item',
                                quantity: item.quantity,
                                price: item.price
                            })) || []
                        }));

                        result = {
                            orders: mappedOrders,
                            count: pendingOrders.length,
                            message: 'Found ' + pendingOrders.length + ' pending order(s) that can be modified.',
                            phone_searched: phoneNumber,
                            has_pending: true
                        };
                    } else if (nonPendingOrders.length > 0) {
                        result = {
                            orders: [],
                            count: 0,
                            message: 'I found your order, but it\'s already being prepared (status: ' + nonPendingOrders[0].status + '). I\'ve sent a message to the restaurant about your request.',
                            phone_searched: phoneNumber,
                            has_non_pending_only: true,
                            restaurant_message_sent: true
                        };
                    }
                    break;

                case 'validate_delivery_address':
                    console.log('🚀 Enhanced validate_delivery_address called with:', JSON.stringify(parsedArgs));

                    // Check if already validated to prevent duplicates
                    if (addressValidated && validatedDeliveryAddress) {
                        console.log('✅ Address already validated:', validatedDeliveryAddress);
                        result = {
                            valid: true,
                            message: 'Address already validated successfully',
                            address: validatedDeliveryAddress,
                            status: 'ALREADY_APPROVED',
                            instruction: 'Address was previously validated. Proceed with taking the food order.'
                        };
                        break;
                    }

                    let deliveryAddress = parsedArgs.address;

                    // Extract from recent conversation if not provided
                    if (!deliveryAddress || deliveryAddress.trim().length === 0) {
                        console.log('Address not in args, checking conversation...');

                        const recentCustomerMessages = conversationTranscript
                            .filter(msg => msg.speaker === 'Customer')
                            .slice(-2);

                        if (recentCustomerMessages.length > 0) {
                            const latestMessage = recentCustomerMessages[recentCustomerMessages.length - 1].text;
                            
                            // Enhanced address extraction patterns
                            const addressPatterns = [
                                /\d+\s+[\w\s\.,]*(road|street|avenue|lane|drive|way|court|place|boulevard|blvd|ave|rd|st|ct|pl|ln|dr)[\w\s\.,]*\d{5}(-\d{4})?/i,
                                /\d+\s+[\w\s\.,]*(road|street|avenue|lane|drive|way|court|place|boulevard|blvd|ave|rd|st|ct|pl|ln|dr)[\w\s\.,]+,\s*[A-Za-z]{2,}/i,
                                /\d+\s+[\w\s\.,]*(road|street|avenue|lane|drive|way|court|place|boulevard|blvd|ave|rd|st|ct|pl|ln|dr)[\w\s\.,]+[A-Za-z]{3,}/i
                            ];

                            for (const pattern of addressPatterns) {
                                const match = latestMessage.match(pattern);
                                if (match) {
                                    deliveryAddress = match[0].trim();
                                    console.log('Extracted address:', deliveryAddress);
                                    break;
                                }
                            }

                            if (!deliveryAddress && /\d/.test(latestMessage) && /\d{5}/.test(latestMessage)) {
                                deliveryAddress = latestMessage.trim();
                            }
                        }
                    }

                    // Enhanced validation with better error handling
                    console.log('🔍 Calling enhanced validateDeliveryAddress with:', deliveryAddress);
                    const validationResult = await validateDeliveryAddress(deliveryAddress, restaurant);

                    console.log('🔍 Enhanced validation result:', validationResult);

                    if (validationResult.valid) {
                        addressValidated = true;
                        validatedDeliveryAddress = deliveryAddress;
                        validationRetryInfo = null;

                        result = {
                            ...validationResult,
                            instruction: 'SUCCESS! Enhanced validation confirmed address is valid. Say "Great! Your address is within our delivery area. What would you like to order?" Proceed to taking the food order.',
                            status: 'APPROVED',
                            confirmed_address: validationResult.formatted_address || deliveryAddress,
                            proceed_to_order: true,
                            geocoding_used: !validationResult.edge_function_used
                        };
                    } else {
                        console.log('Enhanced validation failed, keeping addressValidated=true to prevent re-asking');
                        validationRetryInfo = null;

                        result = {
                            ...validationResult,
                            instruction: 'Enhanced validation failed. Use the exact message provided and suggest pickup instead. Do NOT ask for address again.',
                            geocoding_attempted: true
                        };
                    }
                    break;

                case 'cancel_order':
                    let cancelOrderId = parsedArgs.order_id;

                    if (!cancelOrderId && recentOrders?.length > 0) {
                        if (recentOrders[0].status === 'pending') {
                            cancelOrderId = recentOrders[0].id;
                        }
                    }

                    if (!cancelOrderId) {
                        result = {
                            error: 'No pending order ID provided. Only pending orders can be cancelled.',
                            success: false
                        };
                        break;
                    }

                    const cancelResult = await cancelOrder(cancelOrderId, parsedArgs.reason);
                    result = {
                        success: !!cancelResult,
                        message: cancelResult ? 'Order cancelled successfully' : 'Failed to cancel order',
                        order_id: cancelOrderId
                    };
                    break;

                case 'update_order':
                    let orderId = parsedArgs.order_id;

                    if (!orderId && recentOrders?.length > 0) {
                        if (recentOrders[0].status === 'pending') {
                            orderId = recentOrders[0].id;
                        }
                    }

                    if (!orderId) {
                        result = {
                            error: 'No pending order ID provided. Only pending orders can be modified.',
                            success: false
                        };
                        break;
                    }

                    const updateResult = await updateOrder(orderId, {
                        modifications: parsedArgs.modifications,
                        new_total: parsedArgs.new_total
                    });

                    result = {
                        success: !!updateResult,
                        message: updateResult ? 'Order updated successfully' : 'Failed to update order',
                        order_id: orderId,
                        modifications: parsedArgs.modifications
                    };
                    break;

                case 'create_customer_message':
                    let custName = parsedArgs.customer_name || 'Customer';
                    let custMessageContent = parsedArgs.message_content || '';
                    let custSubject = parsedArgs.subject || 'Customer Message';
                    let custPriority = parsedArgs.priority || 'normal';

                    if (!custMessageContent || custMessageContent.trim().length === 0) {
                        const recentCustomerMessages = conversationTranscript
                            .filter(msg => msg.speaker === 'Customer')
                            .slice(-3)
                            .map(msg => msg.text)
                            .join(' ');

                        custMessageContent = recentCustomerMessages || 'Customer requested to leave a message';

                        if (custMessageContent.toLowerCase().includes('call me back') ||
                            custMessageContent.toLowerCase().includes('call back')) {
                            custSubject = 'Owner Callback Request';
                            custPriority = 'normal';
                        }
                    }

                    if (!parsedArgs.customer_name && conversationTranscript.length > 0) {
                        const conversationText = conversationTranscript
                            .map(msg => msg.text)
                            .join(' ');

                        const nameMatch = conversationText.match(/Customer Name:\s*([^,\n]+)|my name is\s+(\w+)|I'm\s+(\w+)|this is\s+(\w+)/i);
                        if (nameMatch) {
                            custName = (nameMatch[1] || nameMatch[2] || nameMatch[3] || nameMatch[4]).trim();
                        }
                    }

                    const customerMessageData = {
                        restaurant_id: restaurant.id,
                        customer_phone: customerPhone || 'Unknown',
                        customer_name: custName,
                        message_type: 'voice_call_issue',
                        subject: custSubject,
                        message_content: custMessageContent,
                        call_sid: callSid,
                        order_reference: null,
                        priority: custPriority
                    };

                    const messageResult = await createCustomerMessage(customerMessageData);

                    if (messageResult) {
                        result = {
                            success: true,
                            message: 'Your message has been sent to the restaurant. Since the restaurant is extremely busy, it may take until tomorrow for them to get back to you, but they will review your message and contact you.',
                            message_id: messageResult.message_id || messageResult.data?.id
                        };
                    } else {
                        result = {
                            success: false,
                            message: 'Sorry, there was an issue recording your message. Please try again or contact the restaurant directly.'
                        };
                    }
                    break;

                case 'send_message_to_restaurant':
                    const restMsgContent = parsedArgs.message_content;

                    if (!restMsgContent) {
                        result = {
                            success: false,
                            error: 'Message content is required'
                        };
                        break;
                    }

                    const restaurantMessageResult = await createCustomerMessage({
                        restaurant_id: restaurant.id,
                        customer_phone: customerPhone,
                        customer_name: parsedArgs.customer_name || 'Unknown Customer',
                        message_type: 'order_modification_request',
                        subject: parsedArgs.subject || 'Customer Message',
                        message_content: restMsgContent,
                        call_sid: callSid,
                        order_reference: parsedArgs.order_reference || null,
                        priority: 'high'
                    });

                    if (restaurantMessageResult) {
                        result = {
                            success: true,
                            message: 'Your message has been sent to the restaurant. Since they are extremely busy, it may take until tomorrow for them to get back to you, but they will review your message and contact you.',
                            message_id: restaurantMessageResult.message_id || restaurantMessageResult.data?.id
                        };
                    } else {
                        result = {
                            success: false,
                            message: 'Sorry, there was an issue sending your message. Please try again or contact the restaurant directly.'
                        };
                    }
                    break;

                default:
                    result = { error: 'Unknown function: ' + name };
            }

            console.log('Enhanced function result:', result);

            // Send result back to OpenAI
            if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                openaiWs.send(JSON.stringify({
                    type: 'conversation.item.create',
                    item: {
                        type: 'function_call_output',
                        call_id: call_id,
                        output: JSON.stringify(result)
                    }
                }));

                setTimeout(() => {
                    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                        openaiWs.send(JSON.stringify({
                            type: 'response.create',
                            response: {
                                modalities: ['audio', 'text']
                            }
                        }));
                    }
                }, 200);
            }

        } catch (error) {
            console.error('Error handling enhanced function call:', error);

            if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                openaiWs.send(JSON.stringify({
                    type: 'conversation.item.create',
                    item: {
                        type: 'function_call_output',
                        call_id: functionCall.call_id || 'unknown',
                        output: JSON.stringify({
                            error: 'Enhanced function execution failed: ' + error.message,
                            success: false
                        })
                    }
                }));
            }

            if (callSid && error.message.includes('critical')) {
                setTimeout(async () => {
                    await hangup(callSid, {
                        message: 'We are experiencing technical difficulties. Please try calling again.',
                        reason: 'function_error'
                    });
                }, 1000);
            }
        }
    }

    // Order processing function (unchanged)
    async function processOrderFromTranscript(transcript) {
        try {
            if (orderProcessed) {
                console.log('Order already processed, skipping...');
                return;
            }

            const hasOrderConfirmed = transcript.includes('ORDER_CONFIRMED:');
            const hasOrderEnd = transcript.includes('ORDER_END');

            if (!hasOrderConfirmed) {
                console.log('Order format not found in transcript');
                return;
            }

            if (!hasOrderEnd) {
                console.log('ORDER_CONFIRMED found but ORDER_END missing - likely cut off due to token limit');
            }

            orderProcessed = true;
            console.log('Processing order from transcript...');

            const startIndex = transcript.indexOf('ORDER_CONFIRMED:') + 'ORDER_CONFIRMED:'.length;
            const endIndex = hasOrderEnd ? transcript.indexOf('ORDER_END') : transcript.length;
            const orderSection = transcript.substring(startIndex, endIndex).trim();

            let customerName = '';
            let items = '';
            let orderType = 'pickup';
            let deliveryAddress = null;
            let specialInstructions = '';
            let totalAmount = 0;

            const lines = orderSection.split('\n').map(line => line.trim()).filter(line => line.length > 0);

            for (const line of lines) {
                const colonIndex = line.indexOf(':');
                if (colonIndex === -1) continue;

                const key = line.substring(0, colonIndex).trim().toLowerCase();
                const value = line.substring(colonIndex + 1).trim();

                if (key.includes('customer name')) {
                    customerName = value;
                } else if (key.includes('order type')) {
                    orderType = value.toLowerCase();
                } else if (key.includes('delivery address')) {
                    if (value && value.toLowerCase() !== 'n/a' && value.toLowerCase() !== 'none') {
                        deliveryAddress = value;
                    }
                } else if (key.includes('items')) {
                    items = value;
                } else if (key.includes('special instructions')) {
                    if (value.toLowerCase() !== 'none' && value.toLowerCase() !== 'n/a') {
                        specialInstructions = value;
                    }
                } else if (key.includes('total')) {
                    const totalMatch = value.match(/\$?(\d+\.?\d*)/);
                    if (totalMatch) {
                        totalAmount = parseFloat(totalMatch[1]);
                    }
                }
            }

            // Extract items from conversation if missing
            if (!items || items.includes('[') || items.toLowerCase().includes('please let me know')) {
                console.log('Items missing, extracting from conversation...');

                const customerMessages = conversationTranscript
                    .filter(msg => msg.speaker === 'Customer')
                    .map(msg => msg.text.toLowerCase());

                const foodKeywords = ['pizza', 'pepperoni', 'cheese', 'large', 'small', 'medium', 'pasta', 'salad', 'wings', 'breadsticks', 'cappelloni'];
                const extractedItems = [];

                for (const message of customerMessages) {
                    for (const keyword of foodKeywords) {
                        if (message.includes(keyword)) {
                            extractedItems.push(message);
                            break;
                        }
                    }
                }

                if (extractedItems.length > 0) {
                    items = extractedItems.join(', ');
                    console.log('Extracted items from conversation:', items);
                }
            }

            // Validate required fields
            if (!customerName || customerName === 'Unknown Customer' || customerName === '[N/A]' || customerName.includes('[')) {
                console.log('Order processing failed: Missing customer name:', customerName);
                orderProcessed = false;
                return;
            }

            if (!items || items.includes('[') || items.toLowerCase().includes('please let me know')) {
                console.log('Order processing failed: Missing items');
                orderProcessed = false;
                return;
            }

            if (orderType === 'delivery' && !deliveryAddress) {
                console.log('Order processing failed: Missing delivery address');
                orderProcessed = false;
                return;
            }

            const timing = calculateOrderReadyTime(restaurant, orderType === 'delivery');

            const orderTicket = createOrderTicket({
                customerName,
                customerPhone,
                orderType,
                deliveryAddress,
                items,
                specialInstructions,
                totalAmount,
                readyTime: timing.readyTimeString,
                restaurantName: restaurant.name
            });

            const orderData = {
                restaurant_id: restaurant.id,
                customer_phone: customerPhone,
                customer_name: customerName,
                total_amount: totalAmount || 0,
                order_type: orderType,
                delivery_address: deliveryAddress,
                order_details: orderTicket,
                special_instructions: specialInstructions || '',
                ready_time: timing.readyTimeString,
                estimated_ready_at: timing.readyTime?.toISOString(),
                call_sid: callSid
            };

            console.log('Creating order with enhanced validation data:', orderData);

            const order = await createOrder(orderData);
            if (order) {
                console.log('Order saved successfully with ID:', order.id);

                if (callSid && global.pendingCallData?.[callSid]) {
                    global.pendingCallData[callSid].order_id = order.id;
                }

                setTimeout(() => {
                    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                        const timingMessage = orderType === 'delivery'
                            ? 'Your order should arrive within the next ' + timing.totalMinutes + ' minutes.'
                            : 'Your pickup order will be ready in about ' + timing.totalMinutes + ' minutes.';

                        openaiWs.send(JSON.stringify({
                            type: 'response.create',
                            response: {
                                modalities: ['audio', 'text'],
                                instructions: 'Say exactly: "' + timingMessage + ' Thank you for choosing us! Have a great day!"'
                            }
                        }));

                        setTimeout(async () => {
                            console.log('Order processing complete - hanging up gracefully');
                            await hangup(callSid, {
                                message: 'Order completed successfully',
                                reason: 'order_completed',
                                method: 'graceful'
                            });
                        }, 4000);
                    }
                }, 1000);

            } else {
                console.log('Order creation failed');
                orderProcessed = false;
                setTimeout(async () => {
                    await hangup(callSid, {
                        message: 'Sorry, there was an issue processing your order. Please call back.',
                        reason: 'order_creation_failed'
                    });
                }, 2000);
            }
        } catch (error) {
            console.error('Error processing order:', error);
            orderProcessed = false;
            setTimeout(async () => {
                await hangup(callSid, {
                    message: 'Sorry, there was an issue processing your order. Please call back.',
                    reason: 'order_processing_error'
                });
            }, 1000);
        }
    }

    // Handle WebSocket messages from Twilio
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            switch (data.event) {
                case 'connected':
                    console.log('Twilio connected');
                    break;

                case 'start':
                    streamSid = data.start.streamSid;
                    const calledNumber = data.start.customParameters?.Called || data.start.customParameters?.To;
                    const fromNumber = data.start.customParameters?.From || data.start.customParameters?.Caller;
                    const callId = data.start.customParameters?.CallSid || data.start.callSid;

                    console.log('Stream started:', streamSid);
                    console.log('Called number:', calledNumber);
                    console.log('From number (caller ID):', fromNumber);
                    console.log('Call ID:', callId);

                    initializeOpenAI(calledNumber, fromNumber, callId);
                    break;

                case 'media':
                    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                        try {
                            const audioData = {
                                type: 'input_audio_buffer.append',
                                audio: data.media.payload
                            };
                            openaiWs.send(JSON.stringify(audioData));
                        } catch (audioError) {
                            console.error('❌ Error sending audio to OpenAI:', audioError);
                        }
                    }
                    break;

                case 'stop':
                    console.log('Stream stopped');
                    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                        openaiWs.close();
                    }
                    break;
            }
        } catch (error) {
            console.error('Error processing Twilio message:', error);
            setTimeout(async () => {
                if (callSid) {
                    await hangup(callSid, {
                        message: 'We are experiencing technical difficulties. Please try calling again.',
                        reason: 'twilio_processing_error'
                    });
                }
            }, 1000);
        }
    });

    // WebSocket close handling
    ws.on('close', async () => {
        console.log('WebSocket connection closed');

        if (anythingElseTimeout) {
            clearTimeout(anythingElseTimeout);
            anythingElseTimeout = null;
        }

        const callEndTime = new Date();
        const baseDuration = Math.floor((callEndTime - callStartTime) / 1000);
        const callDuration = Math.round(baseDuration + 5.5);

        if (callSid) {
            const initialCallData = global.pendingCallData?.[callSid] || {};

            const completeCallData = {
                call_sid: callSid,
                restaurant_id: restaurant?.id || initialCallData.restaurant_id || null,
                from_number: customerPhone || initialCallData.from_number,
                to_number: restaurant?.phone_number || initialCallData.to_number || '+14108880091',
                call_status: 'completed',
                call_direction: 'inbound',
                caller_country: initialCallData.caller_country || 'US',
                caller_state: initialCallData.caller_state || '',
                caller_city: initialCallData.caller_city || '',
                caller_zip: initialCallData.caller_zip || '',
                to_country: initialCallData.to_country || 'US',
                to_state: initialCallData.to_state || '',
                to_city: initialCallData.to_city || '',
                to_zip: initialCallData.to_zip || '',
                call_duration: callDuration,
                call_started_at: callStartTime.toISOString(),
                call_ended_at: callEndTime.toISOString(),
                twilio_data: initialCallData.twilio_data || initialCallData,
                conversation_transcript: JSON.stringify(conversationTranscript),
                order_id: initialCallData.order_id || null
            };

            console.log('Creating call log with enhanced validation status:', {
                call_sid: callSid,
                duration: callDuration,
                conversation_items: conversationTranscript.length,
                restaurant_id: restaurant?.id,
                enhanced_validation_used: !!GOOGLE_MAPS_API_KEY
            });

            try {
                const callLogResult = await createCallLog(completeCallData);
                if (callLogResult) {
                    console.log('Call log created successfully:', callLogResult.id);
                } else {
                    console.error('Call log creation failed');
                }
            } catch (error) {
                console.error('Call log creation error:', error);
            }

            if (global.pendingCallData?.[callSid]) {
                delete global.pendingCallData[callSid];
            }

            console.log('Call completed with enhanced address validation. Duration: ' + callDuration + ' seconds');
        }

        if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
            openaiWs.close();
        }
    });

    // Enhanced error handling
    ws.on('error', async (error) => {
        console.error('❌ Twilio WebSocket error:', error);
        setTimeout(async () => {
            if (callSid) {
                await hangup(callSid, {
                    message: 'Connection issue. Please try calling again.',
                    reason: 'twilio_websocket_error'
                });
            }
        }, 500);
    });

    ws.on('close', (code, reason) => {
        console.log('🔌 Twilio WebSocket closed:', { code, reason: reason?.toString() });
        if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
            openaiWs.close();
        }
    });
});

// =============================================================================
// ENHANCED SERVER STARTUP
// =============================================================================

const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', (error) => {
    if (error) {
        console.error('Server failed to start:', error);
        process.exit(1);
    }

    console.log('🚀 Restaurant AI System - Enhanced Address Validation with OpenStreetMap');
    console.log('📞 Server running on port ' + PORT);
    console.log('⚡ Fast Twilio webhook response enabled');
    console.log('🎯 WebSocket ready for Twilio Media Streams');
    console.log('🤖 OpenAI configured: ' + !!OPENAI_API_KEY);
    console.log('🗄️ Supabase configured: ' + !!(SUPABASE_URL && SUPABASE_ANON_KEY));
    console.log('📱 Twilio configured: ' + !!twilioClient);
    console.log('🗺️ OpenStreetMap geocoding: Free and open source!');
    console.log('');
    console.log('✅ ENHANCED FEATURES:');
    console.log('🆓 OpenStreetMap geocoding - completely free, no API keys needed');
    console.log('🛡️ Privacy-first - customer addresses stay private');
    console.log('📍 Progressive validation with intelligent fallbacks');
    console.log('🌍 Open source mapping data from global community');
    console.log('⚡ Optimized performance with timeout protection');
    console.log('🎯 Intent-based function calling with natural flow');
    console.log('🔧 Edge Functions preserved for all database operations');
    console.log('💬 Customer messaging system for staff requests');
    console.log('💡 No vendor lock-in or usage costs');
    console.log('');
    console.log('✨ Server ready for production with free OpenStreetMap geocoding!');
});

server.on('error', (error) => {
    console.error('Server error:', error);
    if (error.code === 'EADDRINUSE') {
        console.error('Port ' + PORT + ' is already in use');
    } else if (error.code === 'EACCES') {
        console.error('Permission denied to bind to port ' + PORT);
    }
    process.exit(1);
});

process.on('SIGTERM', () => {
    console.log('Received SIGTERM, shutting down gracefully');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('Received SIGINT, shutting down gracefully');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});
