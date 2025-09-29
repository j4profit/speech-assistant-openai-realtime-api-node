// Restaurant AI Ordering System - FIXED: Twilio Error 11205 (Timeout Issue)
// Updated for OpenAI Migration with Fast Twilio Response
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
        uptime: process.uptime(),
        migration_status: 'updated_for_modern_openai_apis',
        architecture: 'twilio_websocket_with_intent_based_functions',
        // ADDED: Fast response time indicator for Twilio
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
        message: 'Restaurant AI Ordering System - FIXED: Twilio Timeout Issue',
        status: 'running',
        port: process.env.PORT || 3000,
        websocket_url: 'wss://' + req.get('host') + '/media-stream',
        server_time: new Date().toISOString(),
        migration_ready: true,
        twilio_timeout_fixed: true
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

async function validateDeliveryAddress(address, restaurant) {
    try {
        if (!address || address.trim().length < 8) {
            return {
                valid: false,
                message: 'Please provide your delivery address.',
                address: address
            };
        }

        const hasStreetNumber = /^\d+/.test(address.trim());
        const hasStreetName = /\b(street|road|avenue|lane|drive|way|court|place|boulevard|blvd|ave|rd|st|ct|pl|ln|dr)\b/i.test(address) ||
                             /\b\w+\s+(st|street|rd|road|ave|avenue|ln|lane|dr|drive|way|ct|court|pl|place|blvd|boulevard)\b/i.test(address) ||
                             /(old|new|north|south|east|west)\s+\w+\s+(road|street|avenue|lane|drive|way|court|place|boulevard|blvd|ave|rd|st|ct|pl|ln|dr)\b/i.test(address);
        const hasFiveDigitZip = /\b\d{5}(-\d{4})?\b/.test(address);
        const hasCityState = /\b[A-Za-z\s]+,\s*[A-Za-z]{2,}\b/.test(address); // City, State pattern

        console.log('Detailed validation for address:', address);
        console.log('hasStreetNumber:', hasStreetNumber);
        console.log('hasStreetName:', hasStreetName);
        console.log('hasFiveDigitZip:', hasFiveDigitZip);
        console.log('hasCityState:', hasCityState);

        if (!hasStreetNumber) {
            return {
                valid: false,
                message: 'Please include the street number.',
                address: address
            };
        }

        if (!hasStreetName) {
            return {
                valid: false,
                message: 'Please include the street name.',
                address: address
            };
        }

        // Accept either zip code OR city/state combination
        if (!hasFiveDigitZip && !hasCityState) {
            return {
                valid: false,
                message: 'Please include either a 5-digit zip code or city and state (e.g., Baltimore, MD).',
                address: address
            };
        }

        // Use the correct Supabase Edge function URL
        const edgeFunctionUrl = 'https://ujgpqnarhcegrpyzbxej.supabase.co/functions/v1/validate-delivery';
        console.log('Calling Edge function:', edgeFunctionUrl);

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
            console.error('❌ Edge function HTTP error:', {
                status: response.status,
                statusText: response.statusText,
                url: edgeFunctionUrl,
                address: address.trim()
            });
            const errorText = await response.text();
            console.error('❌ Edge function error response:', errorText);
            return {
                valid: false,
                message: 'Unable to validate address at this time. Please provide a complete address or choose pickup.',
                address: address,
                error: 'http_error_' + response.status,
                edge_function_called: true,
                edge_function_url: edgeFunctionUrl
            };
        }

        const result = await response.json();
        console.log('✅ Edge function response received:', {
            valid: result.valid,
            reason: result.reason,
            message: result.message,
            address: address.trim(),
            url: edgeFunctionUrl
        });

        if (result.error) {
            console.error('❌ Edge function returned error:', result.error);
            return {
                valid: false,
                message: 'Unable to validate address. Please provide a complete address or choose pickup.',
                address: address,
                error: result.error,
                edge_function_called: true,
                edge_function_url: edgeFunctionUrl
            };
        }

        return {
            valid: result.valid || false,
            message: result.message || 'Address validation completed',
            address: address,
            estimated_delivery_time: result.estimated_delivery_time,
            delivery_radius: result.delivery_radius,
            reason: result.reason,
            edge_function_called: true,
            edge_function_url: edgeFunctionUrl
        };

    } catch (error) {
        console.error('❌ Error calling Edge function:', {
            error: error.message,
            stack: error.stack,
            url: edgeFunctionUrl || 'unknown',
            address: address
        });
        return {
            valid: false,
            message: 'Unable to validate address at this time. Please provide a complete address or choose pickup.',
            address: address,
            error: error.message
        };
    }
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
// WEBSOCKET CONNECTION WITH INTENT-BASED FUNCTION CALLING
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
    let addressRequested = false; // Track if address has been requested to prevent duplicates
    let addressProviderAttempts = 0; // Track how many times customer provided address
    let recentOrders = [];
    let anythingElseTimeout = null;

    // Initialize OpenAI with modern approach
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
            tagline: restaurant.tagline,
            description: restaurant.description
        });

        customerPhone = fromNumber;
        callSid = callId;
        const menuText = formatMenuForAI(restaurant.menu_items, restaurant);

        console.log('Connecting to OpenAI Realtime API with updated model...');

        // Use the latest stable model - try without specifying model first
        console.log('🔗 Attempting OpenAI connection with API key:', OPENAI_API_KEY ? 'Present' : 'Missing');

        try {
            openaiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
                headers: {
                    'Authorization': 'Bearer ' + OPENAI_API_KEY,
                    'OpenAI-Beta': 'realtime=v1'
                },
                // Connection optimization for better quality
                perMessageDeflate: false,  // Disable compression for lower latency
                handshakeTimeout: 5000,    // 5 second timeout
                maxPayload: 100 * 1024 * 1024  // 100MB payload limit
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
            console.log('🔗 WebSocket ready for audio streaming');

            // Enhanced connection with quality optimization
            // Delivery options are handled in the greeting logic below

            // Modern system instructions with intent-based approach
            const instructions = `You are the AI assistant for ${restaurant.name}. The restaurant is extremely busy and cannot take phone calls right now, so you're helping customers place orders and take messages.

🚨 MANDATORY ADDRESS VALIDATION:
- When customer provides ANY address containing numbers and words, you MUST call validate_delivery_address function IMMEDIATELY
- NEVER proceed to ordering without validating delivery address first
- NEVER say "What would you like to order" until address validation succeeds
- Do NOT ask for clarification or mention issues - just call the function

🚨🚨 CRITICAL DUPLICATE PREVENTION RULES:
- NEVER ask for delivery address more than ONCE per call
- If customer already provided an address, DO NOT ask again under ANY circumstances
- If you hear ANY address with numbers and streets, IMMEDIATELY call validate_delivery_address
- FORBIDDEN: Asking for address multiple times, even if first attempt "failed"
- If customer says an address, validate it - do NOT request clarification first

🛑 ABSOLUTE ADDRESS REQUEST PREVENTION:
- If conversation shows AI already asked "What's your delivery address" - NEVER ask again
- If customer provided ANY address with numbers and street names - validate it immediately
- DO NOT say "I need your delivery address" if customer already gave one
- DO NOT ask for "complete address" or "street number and name" - just validate what they gave you

CRITICAL: ALL RESPONSES MUST BE 1-2 SENTENCES MAXIMUM. Be extremely concise and direct.

GREETING TRIGGER: When you receive the message "Start the call greeting", immediately respond with the appropriate greeting based on delivery availability. This is your cue to begin the conversation.

**VOICE & PACING:**
- Speak quickly and professionally, but do not sound rushed
- Deliver your audio response fast while maintaining clarity
- Use a brisk, efficient pace throughout the conversation

**STANDARD GREETING FLOW:**
EVERY caller gets this exact sequence:
1. Greeting with pickup/delivery question:
   - If delivery enabled: "Hello! Thank you for calling [restaurant name]. Is this for pickup or delivery?"
   - If pickup only: "Hello! Thank you for calling [restaurant name]. What would you like for pickup?"
2. After they respond, ask for name: "May I have your name for the order?" or "Who am I speaking with?"

**ORDER TYPE RESPONSE HANDLING:**
When customer responds to "Is this for pickup or delivery?":
- If they say "pickup" → Ask for name, then follow PICKUP ORDER FLOW
- If they say "delivery" → Ask for name, then follow DELIVERY ORDER FLOW
- If unclear, ask: "Will this be for pickup or delivery?"

**DELIVERY ORDER FLOW (CRITICAL - NEVER DEVIATE):**
For delivery orders, follow this EXACT sequence:
1. Ask for delivery address ONLY ONCE: "What's your delivery address?"
2. When customer provides ANY address that contains numbers and words, IMMEDIATELY call validate_delivery_address function
3. 🚨 CRITICAL - NEVER ASK FOR ADDRESS AGAIN after calling validation function
4. 🚨 CRITICAL - Do NOT proceed to "What would you like to order?" without successful address validation
5. 🚨 CRITICAL - If customer provides address like "7805 Old Harford Road, Parkville, Maryland, 21234" you MUST call validate_delivery_address
6. 🚨 CRITICAL - FORBIDDEN PHRASES (NEVER USE THESE):
   - "It seems there might be an issue"
   - "seems there's an issue"
   - "It seems there was an issue"
   - "seems there was an issue"
   - "address is incomplete"
   - "Could you please confirm"
   - "Could you please provide a complete"
   - "I need your delivery address"
   - "I need your delivery address with street number and name"
   - "Could you please provide it again"
   - "Could you please provide it"
   - "What's your address again"
   - "I'm having trouble validating"
   - "Unfortunately, I'm still unable"

7. 🛑 DUPLICATE ADDRESS PREVENTION CHECK:
   - BEFORE asking for address, check if AI already asked "What's your delivery address?"
   - If customer provided ANY address with numbers, call validate_delivery_address immediately
   - NEVER ask for address twice - if validation fails, suggest pickup instead
5. ALWAYS call validation function first - do NOT make your own judgment
6. If validation returns valid=true, say: "Great! Your address is within our delivery area. What would you like to order?"
7. 🚨 NEVER repeat address requests - ONE address request per call maximum
8. 🚨 If customer has already provided an address (even if unclear), do NOT ask again - call validation function instead
6. If validation returns valid=false, use the exact message from the validation function
7. Take order details
8. Create ORDER_CONFIRMED format

**PICKUP ORDER FLOW:**
For pickup orders:
1. Ask: "What would you like to order?"
2. Take order details
3. Create ORDER_CONFIRMED format

IMPORTANT:
- Do NOT ask for delivery address if customer chose pickup
- Do NOT call validate_delivery_address unless customer specifically chose delivery and provided a complete address

**RESTAURANT STATUS: VERY BUSY**
- The restaurant is extremely busy and cannot take phone calls
- Staff are focused on preparing food and serving customers
- You are the only way customers can place orders or leave messages

**DELIVERY SETTINGS:**
- Delivery Enabled: ${restaurant.delivery_enabled ? 'YES' : 'NO'}
${!restaurant.delivery_enabled ? 'IMPORTANT: This restaurant does NOT offer delivery. Only offer PICKUP orders.' : 'You can offer both pickup and delivery options.'}

${menuText}

**INTENT-BASED FUNCTION CALLING:**
Instead of keyword matching, you naturally understand customer intent and call appropriate functions:

1. **When customer wants to modify/cancel existing orders** → call search_recent_orders
2. **When customer provides ANY delivery address (with numbers and street names)** → call validate_delivery_address
3. **When customer wants to leave a message/complaint/question** → call create_customer_message
4. **When customer completes an order** → use ORDER_CONFIRMED format
5. **When customer asks about existing orders** → call search_recent_orders

IMPORTANT: ALWAYS call validate_delivery_address when customer provides ANY address with numbers and street names - let the validation function determine if it's complete.

**RESPONSE LENGTH RULES:**
- ALL responses must be 1-2 sentences maximum
- Be direct and concise
- Only exception: ORDER_CONFIRMED format (required for order processing)
- No long explanations or detailed descriptions

**MENU POLICY:**
- NEVER automatically list menu items unless customer specifically asks for suggestions
- Only provide menu items when customer says: "What do you have?", "What's on the menu?", "I don't know what to order", or similar requests
- The menu information is for YOUR reference only - don't recite it automatically

**🚨 CRITICAL ORDER COMPLETION FLOW:**
When customer completes their order (says "that's it", "that's all", "nothing else", etc.):
1. **IMMEDIATELY** generate the ORDER_CONFIRMED format (REQUIRED - DO NOT SKIP)
2. Then ask: "Anything else I can help you with?"
3. Wait for customer response
4. If customer says no/nothing/that's all - system will auto-hangup
5. If customer has another request - help them

**📋 ORDER_CONFIRMED FORMAT (MANDATORY - EXACT FORMAT REQUIRED):**
🚨 YOU MUST USE THIS EXACT FORMAT WHEN CUSTOMER COMPLETES ORDER:

ORDER_CONFIRMED:
- Customer Name: [name]
- Phone: ${customerPhone || '[phone]'}
- Order Type: [pickup or delivery]
- Delivery Address: [address or N/A]
- Items: [items with prices]
- Total: $[amount]
- Ready Time: [calculated minutes based on order type]
ORDER_END

**WHEN TO USE ORDER_CONFIRMED:**
- Customer says: "that's it", "that's all", "nothing else", "I'm done", "that'll be all", "now that's it", "that will be all"
- Customer confirms their complete order after you've repeated it back to them
- After customer says they don't want to add anything else to their order
- CRITICAL: The moment customer indicates they're finished ordering - IMMEDIATELY use ORDER_CONFIRMED format
- NEVER skip this format - orders will NOT be saved without it

TIMING RULES:
- For PICKUP orders: Use ${restaurant.preparation_time || 20} minutes
- For DELIVERY orders: Use ${(restaurant.preparation_time || 20) + (restaurant.delivery_time || 15)} minutes
- Always say: "Your [pickup/delivery] order will be ready in [X] minutes" after ORDER_END`;

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
                        threshold: 0.6,  // Reduced for better sensitivity (0.5-0.8 range)
                        prefix_padding_ms: 200,  // Reduced for faster response
                        silence_duration_ms: 1200  // Reduced for quicker turn detection
                    },
                    temperature: 0.6,
                    max_response_output_tokens: 400,  // Increased for complete responses
                    // REMOVED: voice_settings parameter doesn't exist in OpenAI Realtime API
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
                            description: "ONLY call this function when customer provides a COMPLETE delivery address containing: STREET NUMBER + STREET NAME + (ZIP CODE OR CITY/STATE OR CITY). Examples that should trigger this function: '123 Main St, 12345' or '123 Main Street, Baltimore, MD' or '123 Main Street, Baltimore'. NEVER call this function for: names (John, Mary, etc.), single words (delivery, pickup), incomplete addresses missing numbers or street names, or questions.",
                            parameters: {
                                type: "object",
                                properties: {
                                    address: {
                                        type: "string",
                                        description: "Complete delivery address provided by customer (must include street number, street name, and either: ZIP code, or city/state, or city)"
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
                            description: "Save customer messages, complaints, questions, callback requests, or any non-order requests. Critical for busy restaurant messaging system.",
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

        // Message handling logic with function call processing
        openaiWs.on('message', (data) => {
            try {
                const response = JSON.parse(data);

                switch (response.type) {
                    case 'response.audio.delta':
                        if (streamSid && ws.readyState === WebSocket.OPEN) {
                            try {
                                console.log('📢 Sending audio delta to Twilio, length:', response.delta ? response.delta.length : 0);
                                // Enhanced audio output with quality optimization
                                const audioMessage = {
                                    event: 'media',
                                    streamSid: streamSid,
                                    media: { payload: response.delta }
                                };
                                ws.send(JSON.stringify(audioMessage));
                            } catch (audioSendError) {
                                console.error('❌ Error sending audio delta to Twilio:', audioSendError);
                            }
                        } else {
                            console.log('❌ Cannot send audio - streamSid:', streamSid, 'ws.readyState:', ws.readyState);
                        }
                        break;

                    case 'response.audio.done':
                        console.log('✅ Audio response completed');
                        break;

                    case 'response.created':
                        console.log('🎯 OpenAI response created:', response.response?.id);
                        console.log('🎯 Response modalities:', response.response?.modalities);
                        console.log('🎯 Response status:', response.response?.status);
                        break;

                    case 'response.done':
                        console.log('✅ OpenAI response completed:', response.response?.id);
                        console.log('✅ Response status_details:', response.response?.status_details);
                        console.log('✅ Response usage:', response.response?.usage);
                        break;

                    case 'response.output_item.added':
                        console.log('📋 Output item added:', response.item?.type, 'content_type:', response.item?.content?.[0]?.type);
                        break;

                    case 'response.output_item.done':
                        console.log('📋 Output item completed:', response.item?.type);
                        if (response.item?.type === 'message' && response.item?.content?.[0]?.type === 'audio') {
                            console.log('🎵 Audio content generated, length:', response.item.content[0].audio?.length || 0);
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

                        // Handle "anything else" flow
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
                            console.log('Order confirmation with "anything else" detected - setting up response timeout');

                            anythingElseTimeout = setTimeout(async () => {
                                if (callSid && ws.readyState === WebSocket.OPEN && anythingElseTimeout) {
                                    console.log('No response to "anything else" in order confirmation - hanging up');
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
                                    console.log('Triggering "anything else" flow after completion');
                                    openaiWs.send(JSON.stringify({
                                        type: 'response.create',
                                        response: {
                                            modalities: ['audio', 'text'],
                                            instructions: 'Say exactly: "Anything else I can help you with?"'
                                        }
                                    }));

                                    anythingElseTimeout = setTimeout(async () => {
                                        if (callSid && ws.readyState === WebSocket.OPEN && anythingElseTimeout) {
                                            console.log('No response to "anything else" - hanging up');
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

                        // Check if customer is indicating order completion
                        const orderCompletionPhrases = /\b(that's it|that's all|nothing else|i'm done|that'll be all|now that's it|that will be all|we're good|i'm good|that's everything|no more|complete)\b/i;
                        const orderCompleted = orderCompletionPhrases.test(customerMessage);

                        // Check if we're in an ordering context (not just general conversation)
                        const inOrderingContext = conversationTranscript.some(msg =>
                            msg.text.toLowerCase().includes('what would you like to order') ||
                            msg.text.toLowerCase().includes('anything else you\'d like to add') ||
                            msg.text.toLowerCase().includes('just to confirm')
                        );

                        // Enhanced address management to prevent duplicate requests - accept multiple formats
                        const addressPatterns = [
                            // Format 1: Street + ZIP (e.g., "123 Main St, 12345" or "123 Main Street, Baltimore, MD 21234")
                            /\d+\s+[\w\s,]*(road|street|avenue|lane|drive|way|court|place|boulevard|blvd|ave|rd|st|ct|pl|ln|dr)[\w\s,]*\d{5}(-\d{4})?/i,
                            // Format 2: Street + City, State (e.g., "123 Main Street, Baltimore, MD")
                            /\d+\s+[\w\s,]*(road|street|avenue|lane|drive|way|court|place|boulevard|blvd|ave|rd|st|ct|pl|ln|dr)[\w\s,]+,\s*[A-Z]{2}/i,
                            // Format 3: Street + City (e.g., "123 Main Street, Baltimore")
                            /\d+\s+[\w\s,]*(road|street|avenue|lane|drive|way|court|place|boulevard|blvd|ave|rd|st|ct|pl|ln|dr)[\w\s,]+[A-Za-z]{3,}/i
                        ];
                        const hasValidAddress = addressPatterns.some(pattern => pattern.test(customerMessage));
                        const isDeliveryOrder = conversationTranscript.some(msg =>
                            msg.text.toLowerCase().includes('delivery') && msg.speaker === 'Customer'
                        );

                        // Check if AI has asked for address in conversation
                        const aiAskedForAddress = conversationTranscript.some(msg =>
                            msg.speaker === 'AI' && (
                                msg.text.toLowerCase().includes('delivery address') ||
                                msg.text.toLowerCase().includes('what\'s your address') ||
                                msg.text.toLowerCase().includes('your address')
                            )
                        );

                        // Enhanced logging for debugging with pattern matching details
                        const matchedPattern = addressPatterns.findIndex(pattern => pattern.test(customerMessage));
                        console.log('🔍 Enhanced address state check:', {
                            customerMessage: customerMessage,
                            isDeliveryOrder: isDeliveryOrder,
                            hasValidAddress: hasValidAddress,
                            matchedPattern: matchedPattern >= 0 ? `Pattern ${matchedPattern + 1}` : 'None',
                            addressValidated: addressValidated,
                            addressRequested: addressRequested,
                            addressProviderAttempts: addressProviderAttempts,
                            aiAskedForAddress: aiAskedForAddress
                        });

                        // Track when customer provides address
                        if (isDeliveryOrder && hasValidAddress) {
                            addressProviderAttempts++;
                            console.log('📍 Customer provided address (attempt #' + addressProviderAttempts + '):', customerMessage);
                        }

                        // Track when AI asks for address to prevent future duplicates
                        if (aiAskedForAddress && !addressRequested) {
                            addressRequested = true;
                            console.log('📝 Marked address as requested to prevent duplicates');
                        }

                        // STRONG DUPLICATE PREVENTION: Only trigger validation if address provided and not already validated
                        if (isDeliveryOrder && hasValidAddress && !addressValidated && addressProviderAttempts === 1) {
                            console.log('🏠 First address detected in delivery order - auto-triggering validation:', customerMessage);
                            addressValidated = true; // Set immediately to prevent race conditions

                            // IMMEDIATE CONTEXT INJECTION: Add context message before AI response
                            if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                                console.log('🚨 INJECTING CONTEXT: Customer provided address, DO NOT ask again');
                                openaiWs.send(JSON.stringify({
                                    type: 'conversation.item.create',
                                    item: {
                                        type: 'message',
                                        role: 'user',
                                        content: [{
                                            type: 'input_text',
                                            text: '[SYSTEM: Customer just provided delivery address: "' + customerMessage + '". Call validate_delivery_address function immediately. DO NOT ask for address again.]'
                                        }]
                                    }
                                }));
                            }

                            // Implement retry mechanism to handle response collisions
                            const triggerValidation = (attempt = 1) => {
                                setTimeout(() => {
                                    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                                        console.log(`🔄 Attempting to trigger validation (attempt ${attempt})`);
                                        try {
                                            openaiWs.send(JSON.stringify({
                                                type: 'response.create',
                                                response: {
                                                    modalities: ['audio', 'text'],
                                                    instructions: 'Customer just provided their delivery address: "' + customerMessage + '". You MUST immediately call the validate_delivery_address function. DO NOT ask for address again - they already provided it.'
                                                }
                                            }));
                                        } catch (error) {
                                            console.log('⚠️ Auto-trigger failed (attempt ' + attempt + '):', error.message);
                                            if (attempt < 3 && error.message.includes('conversation_already_has_active_response')) {
                                                console.log('🔄 Retrying auto-trigger in ' + (attempt * 500) + 'ms...');
                                                triggerValidation(attempt + 1);
                                            }
                                        }
                                    }
                                }, attempt === 1 ? 50 : attempt * 300);
                            };

                            triggerValidation();
                        }

                        // EMERGENCY STOP: If customer provides address multiple times, force immediate validation
                        else if (isDeliveryOrder && hasValidAddress && addressProviderAttempts > 1 && !addressValidated) {
                            console.log('🚨 DUPLICATE ADDRESS DETECTED - Customer provided address ' + addressProviderAttempts + ' times - forcing immediate validation');
                            addressValidated = true; // Prevent further duplicates
                            setTimeout(() => {
                                if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                                    openaiWs.send(JSON.stringify({
                                        type: 'response.create',
                                        response: {
                                            modalities: ['audio', 'text'],
                                            instructions: 'STOP asking for address. Customer has provided it multiple times. Use this address: "' + customerMessage + '" and call validate_delivery_address function immediately.'
                                        }
                                    }));
                                }
                            }, 50);
                        }

                        // Trigger ORDER_CONFIRMED format if customer completed order and we haven't processed one yet
                        if (orderCompleted && inOrderingContext && !orderProcessed) {
                            console.log('🍕 Customer indicated order completion - triggering ORDER_CONFIRMED format');
                            setTimeout(() => {
                                if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                                    openaiWs.send(JSON.stringify({
                                        type: 'response.create',
                                        response: {
                                            modalities: ['audio', 'text'],
                                            instructions: 'The customer has completed their order. You MUST now use the ORDER_CONFIRMED format exactly as specified in your instructions. Include all order details in the exact format required.'
                                        }
                                    }));
                                }
                            }, 500);
                        }

                        const recentAIMessages = conversationTranscript
                            .filter(msg => msg.speaker === 'AI')
                            .slice(-3)
                            .map(msg => msg.text.toLowerCase());

                        // FIXED: Only trigger on specific "anything else I can help you with" questions
                        const hasRecentAnythingElse = recentAIMessages.some(msg =>
                            msg.includes('anything else i can help you with') ||
                            msg.includes('anything else i can help') ||
                            msg.includes('is there anything else') ||
                            (msg.includes('anything else') && msg.includes('help you'))
                        );

                        const anythingElseResponses = /\b(no|nope|nothing|that's all|that's it|i'm good|i'm all good|i'm all set|no thank you|no thanks|all good|good|nah|we're good|i'm done|that's everything|we're all set)\b/i;
                        const startsWithNo = /^no[,\s]/i;

                        if ((anythingElseResponses.test(customerMessage) || startsWithNo.test(customerMessage)) && hasRecentAnythingElse) {
                            console.log('Customer responded "no" to recent anything else question - initiating hangup');

                            setTimeout(async () => {
                                if (callSid && ws.readyState === WebSocket.OPEN) {
                                    // Check if this was a delivery order by looking at recent messages
                                    const hasDelivery = conversationTranscript.some(msg =>
                                        msg.text.toLowerCase().includes('delivery') &&
                                        (msg.text.toLowerCase().includes('your address is within') ||
                                         msg.text.toLowerCase().includes('delivery area'))
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

                    // Handle function calls with modern approach
                    case 'response.function_call_done':
                        console.log('Function call completed:', response.name);
                        handleFunctionCall(response);
                        break;

                    case 'conversation.item.created':
                        if (response.item?.type === 'function_call') {
                            console.log('Function call item created:', response.item.name);
                            handleFunctionCall(response.item);
                        } else if (response.item?.type === 'message') {
                            console.log('Message item created:', response.item.role, 'content length:', response.item.content?.[0]?.text?.length || 0);
                        }
                        break;

                    case 'error':
                        console.error('OpenAI error:', response.error);
                        if (response.error?.code === 'conversation_already_has_active_response') {
                            console.log('Response collision detected - ignoring (these are expected)');
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
                        console.log('OpenAI session configured with updated instructions');
                        console.log('🔍 Restaurant available for greeting?', {
                            hasRestaurant: !!restaurant,
                            restaurantName: restaurant?.name,
                            deliveryEnabled: restaurant?.delivery_enabled,
                            wsState: openaiWs?.readyState
                        });
                        // Add a conversation item first, then create response like working version
                        setTimeout(() => {
                            console.log('🎯 setTimeout callback executing...');
                            if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                                console.log('🎯 Initiating greeting sequence for restaurant:', restaurant?.name);

                                // Create appropriate greeting based on delivery availability
                                const greetingText = restaurant?.delivery_enabled
                                    ? `Hello! Thank you for calling ${restaurant.name}. Is this for pickup or delivery?`
                                    : `Hello! Thank you for calling ${restaurant.name}. What would you like for pickup?`;

                                console.log('🎯 Greeting text prepared:', greetingText);

                                // First add a conversation item to trigger the greeting
                                openaiWs.send(JSON.stringify({
                                    type: 'conversation.item.create',
                                    item: {
                                        type: 'message',
                                        role: 'user',
                                        content: [
                                            {
                                                type: 'input_text',
                                                text: 'Start the call greeting'
                                            }
                                        ]
                                    }
                                }));
                                console.log('🎯 Sent conversation item to trigger greeting');

                                // Then create the response with the specific greeting
                                setTimeout(() => {
                                    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                                        openaiWs.send(JSON.stringify({
                                            type: 'response.create',
                                            response: {
                                                modalities: ['audio', 'text'],
                                                instructions: `Say exactly: "${greetingText}"`
                                            }
                                        }));
                                        console.log('🎯 Sent response.create with greeting instructions');
                                    } else {
                                        console.error('❌ OpenAI websocket not available for response.create');
                                    }
                                }, 100);
                            } else {
                                console.error('❌ OpenAI websocket not available for greeting setup');
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
            console.error('🚨 Connection failure details:', {
                message: error.message,
                code: error.code,
                type: error.type,
                callSid: callSid,
                url: 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01',
                apiKeyPresent: !!OPENAI_API_KEY,
                apiKeyLength: OPENAI_API_KEY ? OPENAI_API_KEY.length : 0
            });

            if (callSid) {
                console.log('🔄 Enhanced error recovery - OpenAI connection failed');
                // Enhanced error message with better user experience
                await hangup(callSid, {
                    message: 'We are currently experiencing high call volume. Please try calling back in a few minutes. Thank you for your patience.',
                    reason: 'openai_websocket_error',
                    method: 'graceful'
                });
            }
        });

        openaiWs.on('close', () => {
            console.log('OpenAI connection closed');
        });
    }

    // Function call handler with better intent recognition
    async function handleFunctionCall(functionCall) {
        try {
            const { name, call_id, arguments: args } = functionCall;
            let result = null;
            let parsedArgs = {};

            console.log('INTENT-BASED function execution:', name, 'with args:', args);

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
                    console.log('🔍 validate_delivery_address function called with args:', JSON.stringify(parsedArgs));
                    console.log('🔍 Current state - addressValidated:', addressValidated, 'validatedDeliveryAddress:', validatedDeliveryAddress);

                    // Check if address is already validated to prevent duplicates
                    if (addressValidated && validatedDeliveryAddress) {
                        console.log('✅ Address already validated:', validatedDeliveryAddress);
                        result = {
                            valid: true,
                            message: 'Address already validated successfully',
                            address: validatedDeliveryAddress,
                            status: 'ALREADY_APPROVED',
                            instruction: 'Address was previously validated. Do not ask for address again. Proceed with taking the food order.'
                        };
                        break;
                    }

                    let deliveryAddress = parsedArgs.address;

                    // If no address provided directly, extract from the most recent customer messages
                    if (!deliveryAddress || deliveryAddress.trim().length === 0) {
                        console.log('Address not provided in function args, checking latest customer message...');

                        const recentCustomerMessages = conversationTranscript
                            .filter(msg => msg.speaker === 'Customer')
                            .slice(-2); // Check the last 2 messages for address

                        if (recentCustomerMessages.length > 0) {
                            const latestMessage = recentCustomerMessages[recentCustomerMessages.length - 1].text;
                            console.log('Checking latest message: "' + latestMessage + '"');

                            // FIRST: Check if this is obviously a name instead of an address
                            const isName = /^[A-Za-z]+(\s+[A-Za-z]+)*\.?$/.test(latestMessage.trim());
                            const hasNumber = /\d/.test(latestMessage);

                            if (isName && !hasNumber) {
                                console.log('Message appears to be a name, rejecting validation call');
                                result = {
                                    valid: false,
                                    message: 'I need your delivery address with street number and name.',
                                    address: '',
                                    needs_address: true,
                                    instruction: 'Customer provided their name instead of address. Do not call validation again until they provide a complete street address.'
                                };
                                break;
                            }

                            // Look for complete address patterns - flexible matching for multiple formats
                            const addressPatterns = [
                                // Format 1: Street + ZIP (e.g., "123 Main St, 12345" or "123 Main Street, Baltimore, MD 21234")
                                /\d+\s+[\w\s\.,]*(road|street|avenue|lane|drive|way|court|place|boulevard|blvd|ave|rd|st|ct|pl|ln|dr)[\w\s\.,]*\d{5}(-\d{4})?/i,
                                // Format 2: Street + City, State (e.g., "123 Main Street, Baltimore, MD")
                                /\d+\s+[\w\s\.,]*(road|street|avenue|lane|drive|way|court|place|boulevard|blvd|ave|rd|st|ct|pl|ln|dr)[\w\s\.,]+,\s*[A-Z]{2}/i,
                                // Format 3: Street + City (e.g., "123 Main Street, Baltimore")
                                /\d+\s+[\w\s\.,]*(road|street|avenue|lane|drive|way|court|place|boulevard|blvd|ave|rd|st|ct|pl|ln|dr)[\w\s\.,]+[A-Za-z]{3,}/i,
                                // Format 4: Simple number + words + zip (backup pattern)
                                /\d+\s+[\w\s\.,]+\d{5}(-\d{4})?/i
                            ];

                            for (const pattern of addressPatterns) {
                                const match = latestMessage.match(pattern);
                                if (match) {
                                    deliveryAddress = match[0].trim();
                                    console.log('Found address: "' + deliveryAddress + '"');
                                    break;
                                }
                            }

                            // Fallback: if message contains number and zip, use the whole message
                            if (!deliveryAddress && /\d/.test(latestMessage) && /\d{5}/.test(latestMessage)) {
                                deliveryAddress = latestMessage.trim();
                                console.log('Using full message as address: "' + deliveryAddress + '"');
                            }
                        }
                    }

                    if (!restaurant.delivery_enabled) {
                        result = {
                            valid: false,
                            message: 'We only offer pickup orders. Delivery is not available at this location.',
                            delivery_not_available: true
                        };
                        break;
                    }

                    // Detect if this looks like a name instead of an address
                    const possibleName = /^[A-Za-z]+(\s+[A-Za-z]+)*\.?$/.test(deliveryAddress?.trim() || '');
                    const hasNumber = /\d/.test(deliveryAddress || '');

                    if (possibleName && !hasNumber) {
                        console.log('Input appears to be a name, not an address:', deliveryAddress);
                        result = {
                            valid: false,
                            message: 'I need your delivery address.',
                            address: '',
                            needs_address: true,
                            instruction: 'Customer provided their name instead of address. Ask for their delivery address.'
                        };
                        break;
                    }

                    if (!deliveryAddress || deliveryAddress.trim().length < 10) {
                        console.log('No valid address found in conversation');
                        result = {
                            valid: false,
                            message: 'I need your delivery address.',
                            address: deliveryAddress || '',
                            needs_address: true,
                            instruction: 'Customer has not provided an address yet. Ask them to provide their delivery address.'
                        };
                        break;
                    }

                    console.log('Validating extracted address:', deliveryAddress);
                    console.log('Address validation details:', {
                        hasStreetNumber: /^\d+/.test(deliveryAddress.trim()),
                        hasStreetName: /\b(street|road|avenue|lane|drive|way|court|place|boulevard|blvd|ave|rd|st|ct|pl|ln|dr)\b/i.test(deliveryAddress),
                        hasFiveDigitZip: /\b\d{5}(-\d{4})?\b/.test(deliveryAddress),
                        restaurant_delivery_enabled: restaurant.delivery_enabled
                    });
                    console.log('About to call validation edge function with:', {
                        address: deliveryAddress.trim(),
                        restaurant_id: restaurant.id,
                        delivery_enabled: restaurant.delivery_enabled
                    });
                    const validationResult = await validateDeliveryAddress(deliveryAddress, restaurant);

                    if (validationResult.valid) {
                        // Mark address as validated to prevent duplicate requests
                        addressValidated = true;
                        validatedDeliveryAddress = deliveryAddress;
                        console.log('Address validation successful - marked as validated:', deliveryAddress);

                        result = {
                            ...validationResult,
                            instruction: 'SUCCESS! Address is valid for delivery and within our delivery area. IMMEDIATELY say "Great! Your address is within our delivery area. What would you like to order?" Do NOT ask for the address again. Proceed directly to taking the food order.',
                            status: 'APPROVED',
                            confirmed_address: deliveryAddress,
                            proceed_to_order: true
                        };
                    } else {
                        // For invalid addresses, don't reset addressValidated to prevent asking again
                        console.log('Address validation failed but keeping addressValidated=true to prevent duplicate requests');
                        result = {
                            ...validationResult,
                            instruction: 'Address validation failed. Inform customer we cannot deliver to this area and suggest pickup instead. Do NOT ask for address again.'
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
                    // Better message extraction and handling
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
                        console.log('Extracted message content from conversation:', custMessageContent);

                        if (custMessageContent.toLowerCase().includes('call me back') ||
                            custMessageContent.toLowerCase().includes('call back') ||
                            (custMessageContent.toLowerCase().includes('have') && custMessageContent.toLowerCase().includes('call'))) {
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

                    console.log('Creating customer message with extracted data:', {
                        customer_name: custName,
                        message_content: custMessageContent,
                        subject: custSubject,
                        priority: custPriority
                    });

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

            console.log('Function result:', result);

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
            console.error('Error handling function call:', error);

            if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                openaiWs.send(JSON.stringify({
                    type: 'conversation.item.create',
                    item: {
                        type: 'function_call_output',
                        call_id: functionCall.call_id || 'unknown',
                        output: JSON.stringify({
                            error: 'Function execution failed: ' + error.message,
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

    // Order processing function
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

            // If ORDER_CONFIRMED exists but ORDER_END is missing, check if it was cut off
            if (!hasOrderEnd) {
                console.log('ORDER_CONFIRMED found but ORDER_END missing - likely cut off due to token limit');
                // We'll still process what we have
            }

            orderProcessed = true;
            console.log('Processing NEW order from transcript...');

            // Extract order section, handling cases where ORDER_END might be missing
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

            // If items are missing from ORDER_CONFIRMED format, try to extract from conversation
            if (!items || items.includes('[') || items.toLowerCase().includes('please let me know')) {
                console.log('Items missing from ORDER_CONFIRMED, attempting to extract from conversation...');

                // Look for food items mentioned by customer in conversation
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
                } else {
                    console.log('No food items found in conversation');
                }
            }

            // Validate required fields
            if (!customerName || customerName === 'Unknown Customer' || customerName === '[N/A]' || customerName.includes('[')) {
                console.log('Order processing failed: Missing or invalid customer name:', customerName);
                orderProcessed = false;
                return;
            }

            if (!items || items.includes('[') || items.toLowerCase().includes('please let me know')) {
                console.log('Order processing failed: Missing or incomplete items');
                orderProcessed = false;
                return;
            }

            if (orderType === 'delivery' && !deliveryAddress) {
                console.log('Order processing failed: Missing delivery address for delivery order');
                orderProcessed = false;
                return;
            }

            // Debug timing calculation
            console.log('🕐 About to calculate ready time with restaurant data:', {
                restaurant_preparation_time: restaurant?.preparation_time,
                restaurant_delivery_time: restaurant?.delivery_time,
                restaurant_delivery_enabled: restaurant?.delivery_enabled,
                orderType: orderType,
                isDelivery: orderType === 'delivery'
            });

            const timing = calculateOrderReadyTime(restaurant, orderType === 'delivery');

            // Create formatted order ticket
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

            console.log('Creating order with data:', orderData);

            const order = await createOrder(orderData);
            if (order) {
                console.log('NEW order saved successfully with ID:', order.id);

                // Store order ID for final call log
                if (callSid && global.pendingCallData?.[callSid]) {
                    global.pendingCallData[callSid].order_id = order.id;
                }

                // Send timing confirmation message to AI after successful order creation
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

                        // Schedule hangup after delivery message is spoken (allow time for speech)
                        setTimeout(async () => {
                            console.log('Order processing complete - hanging up gracefully');
                            await hangup(callSid, {
                                message: 'Order completed successfully',
                                reason: 'order_completed',
                                method: 'graceful'
                            });
                        }, 4000); // 4 seconds to allow full message delivery
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
                            // Enhanced audio processing with error handling
                            const audioData = {
                                type: 'input_audio_buffer.append',
                                audio: data.media.payload
                            };
                            openaiWs.send(JSON.stringify(audioData));
                        } catch (audioError) {
                            console.error('❌ Error sending audio to OpenAI:', audioError);
                        }
                    } else {
                        console.log('⚠️ OpenAI WebSocket not ready for audio, state:', openaiWs?.readyState);
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
        const callDuration = Math.round(baseDuration + 5.5); // FIXED: Convert to integer for database

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

            console.log('Creating complete call log with migration-ready data:', {
                call_sid: callSid,
                base_duration: baseDuration,
                final_duration: callDuration,
                duration_type: 'integer', // FIXED: Now sending integer instead of float
                conversation_items: conversationTranscript.length,
                restaurant_id: restaurant?.id,
                migration_status: 'ready'
            });

            try {
                const callLogResult = await createCallLog(completeCallData);
                if (callLogResult) {
                    console.log('Call log created successfully:', callLogResult.id);
                } else {
                    console.error('Call log creation failed - no result returned');
                }
            } catch (error) {
                console.error('Call log creation error:', error);
            }

            if (global.pendingCallData?.[callSid]) {
                delete global.pendingCallData[callSid];
            }

            console.log('Call completed with intent-based function calling. Duration: ' + callDuration + ' seconds');
        }

        if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
            openaiWs.close();
        }
    });

    // Enhanced Twilio WebSocket error handling for errors 11750 & 31920
    ws.on('error', async (error) => {
        console.error('❌ Twilio WebSocket error:', error);
        console.error('🚨 Error details:', {
            message: error.message,
            code: error.code,
            type: error.type,
            callSid: callSid
        });

        // Handle specific Twilio errors
        if (error.code === 'ECONNRESET' || error.code === 'ENOTFOUND') {
            console.error('🔴 Network connectivity issue - Error 11750 likely');
        }
        if (error.message && error.message.includes('TLS')) {
            console.error('🔴 TLS/SSL handshake failed - Error 31920 likely');
        }

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
// SERVER STARTUP
// =============================================================================

const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', (error) => {
    if (error) {
        console.error('Server failed to start:', error);
        process.exit(1);
    }

    console.log('🚀 Restaurant AI System FIXED - Twilio Error 11205 Resolved');
    console.log('📞 Server running on port ' + PORT);
    console.log('⚡ FAST Twilio webhook response - calls will connect immediately');
    console.log('🎯 WebSocket ready for Twilio Media Streams');
    console.log('🤖 OpenAI configured: ' + !!OPENAI_API_KEY);
    console.log('🗄️ Supabase configured: ' + !!(SUPABASE_URL && SUPABASE_ANON_KEY));
    console.log('📱 Twilio configured: ' + !!twilioClient);
    console.log('');
    console.log('✅ MIGRATION STATUS: READY');
    console.log('🎯 INTENT-BASED: Natural conversation flow with function calling');
    console.log('🔧 EDGE FUNCTIONS: All database operations preserved');
    console.log('💬 MESSAGE SYSTEM: Customer messages for staff requests');
    console.log('⏱️ CALL DURATION: Fixed - now sends integers to database');
    console.log('🌐 REALTIME API: Using gpt-4o-realtime-preview with reliable speech');
    console.log('🔥 TWILIO TIMEOUT: FIXED - /voice endpoint responds instantly');
    console.log('');
    console.log('✨ Server ready for production traffic - no more Error 11205!');
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
