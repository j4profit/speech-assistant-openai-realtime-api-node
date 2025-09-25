// Restaurant AI Ordering System - Complete Multi-Tenant Voice Agent for Busy Restaurants
const express = require('express');
const WebSocket = require('ws');
const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');

const app = express();
const port = process.env.PORT || 3000;

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
const activeCalls = new Map();

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

    console.log(`Hangup initiated: ${callSid} - Method: ${method}, Reason: ${reason}`);

    try {
        if (delay > 0) {
            await new Promise(resolve => setTimeout(resolve, delay));
        }

        if (method === 'immediate') {
            await twilioClient.calls(callSid).update({ status: 'completed' });
            console.log(`Call terminated immediately: ${callSid}`);
            return { success: true, method: 'immediate', reason: reason, call_sid: callSid };
        }

        if (method === 'graceful') {
            let finalMessage = message;
            if (!finalMessage) {
                finalMessage = restaurant ? 
                    `Thank you for calling ${restaurant.name}. Have a great day!` : 
                    'Thank you for calling. Have a great day!';
            }

            // Store the TwiML for the hangup endpoint
            global.pendingHangupTwiML = global.pendingHangupTwiML || {};
            global.pendingHangupTwiML[callSid] = {
                message: finalMessage,
                timestamp: new Date().toISOString()
            };

            const hangupUrl = BASE_URL ? 
                `${BASE_URL}/hangup-twiml?call_sid=${callSid}` : 
                `https://speech-assistant-openai-realtime-api-node-ddc4.onrender.com/hangup-twiml?call_sid=${callSid}`;
            
            await twilioClient.calls(callSid).update({
                url: hangupUrl,
                method: 'POST'
            });

            console.log(`Call redirected to graceful hangup: ${callSid}`);
            return {
                success: true,
                method: 'graceful',
                reason: reason,
                message: finalMessage,
                call_sid: callSid
            };
        }

        return { success: false, error: `Invalid method: ${method}` };

    } catch (error) {
        console.error(`Hangup failed for call ${callSid}:`, error);
        return { 
            success: false, 
            error: error.message,
            call_sid: callSid 
        };
    }
}

// =============================================================================
// HTTP ENDPOINTS
// =============================================================================

// Hangup TwiML endpoint
app.post('/hangup-twiml', (req, res) => {
    const callSid = req.query.call_sid || req.body.CallSid;
    
    let message = 'Thank you for calling. Goodbye!';
    
    if (global.pendingHangupTwiML?.[callSid]) {
        message = global.pendingHangupTwiML[callSid].message;
        delete global.pendingHangupTwiML[callSid];
    }
    
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">${message}</Say>
    <Hangup/>
</Response>`;
    
    res.type('text/xml');
    res.send(twiml);
});

// Twilio webhook endpoint for incoming calls
app.post('/voice', async (req, res) => {
    console.log('Incoming call webhook:', req.body);
    
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
        stream_sid: null,
        order_id: null
    };
    
    // Look up restaurant to get restaurant_id for the call log
    const restaurant = await getRestaurantByPhone(callData.to_number);
    if (restaurant) {
        callData.restaurant_id = restaurant.id;
    }
    
    // Create initial call log using Edge Function
    await createCallLog(callData);
    
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
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({ 
        status: 'healthy',
        port: process.env.PORT || 3000,
        timestamp: new Date().toISOString(),
        openai_configured: !!OPENAI_API_KEY,
        supabase_configured: !!(SUPABASE_URL && SUPABASE_ANON_KEY),
        twilio_configured: !!twilioClient,
        uptime: process.uptime()
    });
});

app.get('/ping', (req, res) => {
    res.status(200).send('pong');
});

app.get('/', (req, res) => {
    res.status(200).json({ 
        message: 'Restaurant AI Ordering and Messaging System - Busy Restaurant Mode',
        status: 'running',
        port: process.env.PORT || 3000,
        websocket_url: `wss://${req.get('host')}/media-stream`,
        server_time: new Date().toISOString()
    });
});

// API endpoints using Edge Functions
app.get('/orders', async (req, res) => {
    try {
        const response = await fetch('https://ujgpqnarhcegrpyzbxej.supabase.co/functions/v1/search-orders', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
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

app.get('/messages', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('customer_messages')
            .select(`
                *,
                restaurants(name, delivery_enabled, delivery_hours)
            `)
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
// HELPER FUNCTIONS - ALL EDGE FUNCTION CALLS
// =============================================================================

async function getRestaurantByPhone(phoneNumber) {
    try {
        const response = await fetch('https://ujgpqnarhcegrpyzbxej.supabase.co/functions/v1/get-restaurant', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
            },
            body: JSON.stringify({ phone_number: phoneNumber })
        });

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
        console.error('Error calling get-restaurant Edge Function:', error);
        return null;
    }
}

async function createCallLog(callData) {
    try {
        const response = await fetch('https://ujgpqnarhcegrpyzbxej.supabase.co/functions/v1/create-call-log', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
            },
            body: JSON.stringify(callData)
        });

        if (!response.ok) return null;
        const result = await response.json();
        if (result.error) return null;

        console.log('Call log created:', result.data?.id);
        return result.data;
    } catch (error) {
        console.error('Error calling create-call-log Edge Function:', error);
        return null;
    }
}

async function updateCallLog(callSid, updateData) {
    try {
        const response = await fetch('https://ujgpqnarhcegrpyzbxej.supabase.co/functions/v1/update-call-log', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
            },
            body: JSON.stringify({
                call_sid: callSid,
                ...updateData
            })
        });

        if (!response.ok) return null;
        return (await response.json()).data;
    } catch (error) {
        console.error('Error calling update-call-log Edge Function:', error);
        return null;
    }
}

async function searchRecentOrders(phoneNumber, restaurantId) {
    try {
        const response = await fetch('https://ujgpqnarhcegrpyzbxej.supabase.co/functions/v1/search-orders', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
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
        const response = await fetch('https://ujgpqnarhcegrpyzbxej.supabase.co/functions/v1/cancel-order', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
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
        const response = await fetch('https://ujgpqnarhcegrpyzbxej.supabase.co/functions/v1/update-order', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
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
        if (!address || address.trim().length < 10) {
            return {
                valid: false,
                message: 'Please provide a complete address with street number, street name, city, state, and zip code.',
                address: address
            };
        }
        
        const response = await fetch('https://ujgpqnarhcegrpyzbxej.supabase.co/functions/v1/validate-delivery', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
            },
            body: JSON.stringify({
                address: address.trim(),
                restaurant_id: restaurant.id,
                delivery_enabled: restaurant.delivery_enabled,
                delivery_radius: restaurant.delivery_radius,
                delivery_hours: restaurant.delivery_hours,
                delivery_time: restaurant.delivery_time,
                preparation_time: restaurant.preparation_time,
                restaurant_address: restaurant.address,
                restaurant_latitude: restaurant.latitude,
                restaurant_longitude: restaurant.longitude
            })
        });

        if (!response.ok) {
            return {
                valid: false,
                message: 'Unable to validate address at this time. Please provide a complete address or choose pickup.',
                address: address
            };
        }

        const result = await response.json();
        
        if (result.error) {
            return {
                valid: false,
                message: 'Unable to validate address. Please provide a complete address or choose pickup.',
                address: address
            };
        }

        return {
            valid: result.valid || false,
            message: result.message || 'Address validation completed',
            address: address,
            estimated_delivery_time: result.estimated_delivery_time,
            delivery_radius: result.delivery_radius,
            reason: result.reason
        };
        
    } catch (error) {
        console.error('Error calling validate-delivery Edge Function:', error);
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
        const response = await fetch('https://ujgpqnarhcegrpyzbxej.supabase.co/functions/v1/create-order', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
            },
            body: JSON.stringify(orderData)
        });

        if (!response.ok) return null;
        const result = await response.json();
        if (result.error) return null;

        console.log('Order created successfully:', result.data?.id);
        return result.data;
    } catch (error) {
        console.error('Error calling create-order Edge Function:', error);
        return null;
    }
}

async function createCustomerMessage(messageData) {
    try {
        const response = await fetch('https://ujgpqnarhcegrpyzbxej.supabase.co/functions/v1/create-message', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
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

function calculateOrderReadyTime(restaurant, isDelivery = false) {
    try {
        const now = new Date();
        const preparationMinutes = restaurant?.preparation_time || 20;
        let deliveryAddedMinutes = 0;
        
        if (isDelivery && restaurant?.delivery_enabled) {
            deliveryAddedMinutes = restaurant?.delivery_time || 15;
        }
        
        const totalMinutes = preparationMinutes + deliveryAddedMinutes;
        const readyTime = new Date(now.getTime() + totalMinutes * 60000);
        
        const hours = readyTime.getHours();
        const minutes = readyTime.getMinutes();
        const ampm = hours >= 12 ? 'PM' : 'AM';
        const displayHours = hours % 12 || 12;
        const displayMinutes = minutes.toString().padStart(2, '0');
        
        return {
            readyTime: readyTime,
            readyTimeString: `${displayHours}:${displayMinutes} ${ampm}`,
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
        menuText += `\n${category.toUpperCase()}:\n`;
        
        categories[category]
            .sort((a, b) => a.name.localeCompare(b.name))
            .forEach(item => {
                menuText += `- ${item.name}: ${item.description || 'No description'} - ${item.price}\n`;
            });
    });

    if (restaurant) {
        menuText += `\n\nDELIVERY INFORMATION:\n`;
        menuText += `- Delivery Available: ${restaurant.delivery_enabled ? 'Yes' : 'No'}\n`;
        
        if (restaurant.delivery_enabled) {
            menuText += `- Delivery Hours: ${restaurant.delivery_hours || 'Same as restaurant hours'}\n`;
            menuText += `- Delivery Radius: ${restaurant.delivery_radius || 'Contact restaurant'} miles\n`;
            menuText += `- Estimated Delivery Time: ${(restaurant.preparation_time || 20) + (restaurant.delivery_time || 15)} minutes\n`;
        } else {
            menuText += `- Pickup Only\n`;
        }
    }

    return menuText;
}

// =============================================================================
// WEBSOCKET CONNECTION HANDLER
// =============================================================================

wss.on('connection', (ws, req) => {
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
    let recentOrders = [];
    let anythingElseTimeout = null;

    // Initialize OpenAI connection
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

        customerPhone = fromNumber;
        callSid = callId;
        const menuText = formatMenuForAI(restaurant.menu_items, restaurant);
        
        console.log('Connecting to OpenAI Realtime API...');
        
        openaiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-mini-realtime-preview-2024-12-17', {
            headers: {
                'Authorization': `Bearer ${OPENAI_API_KEY}`,
                'OpenAI-Beta': 'realtime=v1'
            }
        });
        
        openaiWs.on('open', () => {
            console.log('Connected to OpenAI Realtime API');
            
            const deliveryOptions = restaurant.delivery_enabled ? 
                'Would you like this for pickup or delivery?' : 
                'All orders are for pickup only.';
            
            const instructions = `You are the AI assistant for ${restaurant.name}. The restaurant is extremely busy and cannot take phone calls right now, so you're helping customers place orders and take messages.

IMPORTANT: Start every call with: "Hello! Thank you for calling ${restaurant.name}. We're extremely busy right now and can't take calls, but I can help you! ${deliveryOptions}"

Keep responses SHORT and CONVERSATIONAL - maximum 2-3 sentences at a time.

**RESTAURANT STATUS: VERY BUSY**
- The restaurant is extremely busy and cannot take phone calls
- Staff are focused on preparing food and serving customers
- You are the only way customers can place orders or leave messages

**DELIVERY SETTINGS:**
- Delivery Enabled: ${restaurant.delivery_enabled ? 'YES' : 'NO'}
${!restaurant.delivery_enabled ? 
    'IMPORTANT: This restaurant does NOT offer delivery. Only offer PICKUP orders.' :
    'You can offer both pickup and delivery options.'}

${menuText}

**PRIMARY FUNCTIONS (in order of priority):**

1. **PENDING ORDER MODIFICATIONS/CANCELLATIONS**
   - If customer mentions changing/cancelling an order, immediately search their orders
   - Only PENDING orders can be modified or cancelled
   - For non-pending orders, create a message for restaurant staff

2. **NEW ORDERS** 
   - Get customer name, order type (pickup/delivery), items, and address (if delivery)
   - For delivery orders: validate address before confirming
   - Create ORDER_CONFIRMED format when complete

3. **CUSTOMER MESSAGES (for everything else)**
   - For ANY other request, question, complaint, compliment, or callback request
   - Always use create_customer_message function
   - Set clear expectations: "Since the restaurant is extremely busy, it may take until tomorrow for them to get back to you, but they will review your message and contact you."

**MESSAGE EXPECTATIONS - CRITICAL:**
- ALWAYS tell customers: "Since the restaurant is extremely busy, it may take until tomorrow for them to get back to you, but they will review your message and contact you."
- This applies to ALL messages: callback requests, complaints, questions, special requests
- Make it clear the restaurant is prioritizing food preparation and in-person customers

**CALL COMPLETION:**
After completing any task (order, cancellation, modification, or message):
1. Confirm the completed action
2. Ask: "Is there anything else I can help you with today?"
3. If customer says no/nothing/that's all - system will auto-hangup
4. If customer has another request - help them

**ORDER_CONFIRMED FORMAT:**
ORDER_CONFIRMED:
- Customer Name: [name]
- Phone: ${customerPhone || '[phone]'}
- Order Type: [pickup or delivery]
- Delivery Address: [address or N/A]
- Items: [items with prices]
- Total: $[amount]
- Ready Time: [minutes]
ORDER_END`;

            const sessionUpdate = {
                type: 'session.update',
                session: {
                    modalities: ['text', 'audio'],
                    instructions: instructions,
                    voice: 'alloy',
                    input_audio_format: 'g711_ulaw',
                    output_audio_format: 'g711_ulaw',
                    input_audio_transcription: { model: 'whisper-1' },
                    turn_detection: {
                        type: 'server_vad',
                        threshold: 0.7,
                        prefix_padding_ms: 300,
                        silence_duration_ms: 2000
                    },
                    tools: [
                        {
                            type: "function",
                            name: "search_recent_orders",
                            description: "Search for recent orders when customer wants to modify/cancel. System automatically uses caller ID.",
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
                            description: "ONLY for delivery orders when customer provides address. NEVER for pickup.",
                            parameters: {
                                type: "object",
                                properties: {
                                    address: { 
                                        type: "string", 
                                        description: "Complete delivery address provided by customer" 
                                    }
                                },
                                required: ["address"]
                            }
                        },
                        {
                            type: "function", 
                            name: "cancel_order",
                            description: "Cancel PENDING order only",
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
                            description: "Update PENDING order only",
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
                            description: "ALWAYS use for ANY message, callback request, complaint, question, or request that isn't placing/modifying orders. Critical for busy restaurant messaging.",
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
                            description: "Send message about non-pending order modifications",
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
        
        openaiWs.on('message', (data) => {
            try {
                const response = JSON.parse(data);
                
                switch (response.type) {
                    case 'response.audio.delta':
                        if (streamSid && ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify({
                                event: 'media',
                                streamSid: streamSid,
                                media: { payload: response.delta }
                            }));
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
                        
                        // Check for completion phrases that should trigger "anything else" flow
                        const completionPhrases = [
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
                        
                        if (isCompletionPhrase && !alreadyAskedAnythingElse) {
                            setTimeout(() => {
                                if (openaiWs && openaiWs.readyState === WebSocket.OPEN && callSid) {
                                    console.log('Triggering "anything else" flow after completion');
                                    openaiWs.send(JSON.stringify({
                                        type: 'response.create',
                                        response: {
                                            modalities: ['audio', 'text'],
                                            instructions: 'Say: "Is there anything else I can help you with today?"'
                                        }
                                    }));
                                    
                                    // Set timeout for no response - hangup after 10 seconds of silence
                                    anythingElseTimeout = setTimeout(async () => {
                                        if (callSid && ws.readyState === WebSocket.OPEN && anythingElseTimeout) {
                                            console.log('No response to "anything else" - hanging up');
                                            clearTimeout(anythingElseTimeout);
                                            anythingElseTimeout = null;
                                            await hangup(callSid, {
                                                method: 'graceful',
                                                reason: 'no_response_to_anything_else',
                                                restaurant: restaurant,
                                                message: `Thank you for calling ${restaurant.name}. Have a great day!`
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
                        
                        // Clear the "anything else" timeout since customer responded
                        if (anythingElseTimeout) {
                            clearTimeout(anythingElseTimeout);
                            anythingElseTimeout = null;
                        }
                        
                        // Enhanced detection for "no" responses to "anything else" question
                        const recentAIMessages = conversationTranscript
                            .filter(msg => msg.speaker === 'AI')
                            .slice(-3)
                            .map(msg => msg.text.toLowerCase());
                        
                        const hasRecentAnythingElse = recentAIMessages.some(msg => 
                            msg.includes('anything else') || 
                            msg.includes('help you with') ||
                            msg.includes('is there anything')
                        );
                        
                        const anythingElseResponses = /\b(no|nope|nothing|that's all|that's it|i'm good|i'm all good|i'm all set|no thank you|no thanks|all good|good|nah|we're good|i'm done|that's everything|we're all set)\b/i;
                        const startsWithNo = /^no[,\s]/i;
                        
                        if ((anythingElseResponses.test(customerMessage) || startsWithNo.test(customerMessage)) && hasRecentAnythingElse) {
                            console.log('Customer responded "no" to recent anything else question - initiating hangup');
                            
                            setTimeout(async () => {
                                if (callSid && ws.readyState === WebSocket.OPEN) {
                                    await hangup(callSid, {
                                        method: 'graceful',
                                        reason: 'customer_finished',
                                        restaurant: restaurant,
                                        message: `RING 4 FOOD, has handled your call! Thank you for calling ${restaurant.name}. Have a wonderful day!`
                                    });
                                }
                            }, 1500);
                            return;
                        }
                        break;
                        
                    case 'input_audio_buffer.speech_started':
                        if (anythingElseTimeout) {
                            clearTimeout(anythingElseTimeout);
                            anythingElseTimeout = null;
                        }
                        break;
                        
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
                        console.log('OpenAI session configured');
                        setTimeout(() => {
                            if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                                const deliveryOptions = restaurant.delivery_enabled ? 
                                    'Would you like this for pickup or delivery?' : 
                                    'All orders are for pickup only.';
                                    
                                openaiWs.send(JSON.stringify({
                                    type: 'response.create',
                                    response: {
                                        modalities: ['audio', 'text'],
                                        instructions: `Say: "Hello! Thank you for calling ${restaurant.name}. We're extremely busy right now and can't take calls, but I can help you! ${deliveryOptions}"`
                                    }
                                }));
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
            console.error('OpenAI WebSocket error:', error);
            if (callSid) {
                await hangup(callSid, {
                    message: 'We are experiencing technical difficulties. Please try calling again.',
                    reason: 'websocket_error'
                });
            }
        });
        
        openaiWs.on('close', () => {
            console.log('OpenAI connection closed');
        });
    }

    // Function call handler
    async function handleFunctionCall(functionCall) {
        try {
            const { name, call_id, arguments: args } = functionCall;
            let result = null;
            let parsedArgs = {};

            console.log(`Executing function: ${name} with args:`, args);

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
                            message: `Found ${pendingOrders.length} pending order(s) that can be modified.`,
                            phone_searched: phoneNumber,
                            has_pending: true
                        };
                    } else if (nonPendingOrders.length > 0) {
                        result = {
                            orders: [],
                            count: 0,
                            message: `I found your order, but it's already being prepared (status: ${nonPendingOrders[0].status}). I've sent a message to the restaurant about your request. Since the restaurant is extremely busy, it may take until tomorrow for them to get back to you, but they will review your message and contact you.`,
                            phone_searched: phoneNumber,
                            has_non_pending_only: true,
                            restaurant_message_sent: true
                        };
                    }
                    break;

                case 'validate_delivery_address':
                    const address = parsedArgs.address;
                    
                    if (!restaurant.delivery_enabled) {
                        result = {
                            valid: false,
                            message: 'We only offer pickup orders. Delivery is not available at this location.',
                            delivery_not_available: true
                        };
                        break;
                    }
                    
                    const validationResult = await validateDeliveryAddress(address, restaurant);
                    
                    if (validationResult.valid) {
                        result = {
                            ...validationResult,
                            instruction: 'SUCCESS! Address is valid for delivery. Create ORDER_CONFIRMED format immediately with all collected information.',
                            status: 'APPROVED',
                            confirmed_address: address,
                            proceed_to_order: true
                        };
                    } else {
                        result = {
                            ...validationResult,
                            instruction: 'Address validation failed. Ask customer for a complete address or suggest pickup.'
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
                    const messageData = {
                        restaurant_id: restaurant.id,
                        customer_phone: customerPhone || 'Unknown',
                        customer_name: parsedArgs.customer_name || 'Customer',
                        message_type: 'voice_call_issue',
                        subject: parsedArgs.subject || 'Customer Message',
                        message_content: parsedArgs.message_content,
                        call_sid: callSid,
                        order_reference: null,
                        priority: parsedArgs.priority || 'normal'
                    };

                    const messageResult = await createCustomerMessage(messageData);
                    
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
                    const messageContent = parsedArgs.message_content;
                    
                    if (!messageContent) {
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
                        message_content: messageContent,
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
                    result = { error: `Unknown function: ${name}` };
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
                        openaiWs.send(JSON.stringify({ type: 'response.create' }));
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
                            error: `Function execution failed: ${error.message}`,
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
            
            if (!hasOrderConfirmed || !hasOrderEnd) {
                console.log('Order format not found in transcript');
                return;
            }
            
            orderProcessed = true;
            console.log('Processing NEW order from transcript...');
            
            const orderSection = transcript.substring(
                transcript.indexOf('ORDER_CONFIRMED:') + 'ORDER_CONFIRMED:'.length,
                transcript.indexOf('ORDER_END')
            ).trim();
            
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
            
            // Validate required fields
            if (!customerName || customerName === 'Unknown Customer') {
                console.log('Order processing failed: Missing customer name');
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
            
            const timing = calculateOrderReadyTime(restaurant, orderType === 'delivery');
            
            const orderData = {
                restaurant_id: restaurant.id,
                customer_phone: customerPhone,
                customer_name: customerName,
                total_amount: totalAmount || 0,
                order_type: orderType,
                delivery_address: deliveryAddress,
                order_details: `Customer: ${customerName}\nPhone: ${customerPhone}\nOrder Type: ${orderType}\n${orderType === 'delivery' ? `Delivery Address: ${deliveryAddress}` : 'Pickup Order'}\nItems: ${items}\nSpecial Instructions: ${specialInstructions || 'None'}\nEstimated ${orderType === 'delivery' ? 'Delivery' : 'Pickup'} Time: ${timing.totalMinutes} minutes`,
                special_instructions: specialInstructions || '',
                call_sid: callSid,
                ready_time: timing.readyTimeString,
                estimated_ready_at: timing.readyTime?.toISOString(),
                items: []
            };

            console.log('Creating order with data:', orderData);
            
            const order = await createOrder(orderData);
            if (order) {
                console.log('NEW order saved successfully with ID:', order.id);
                
                // Update call log with order ID
                if (callSid) {
                    await updateCallLog(callSid, { order_id: order.id });
                }
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
                        openaiWs.send(JSON.stringify({
                            type: 'input_audio_buffer.append',
                            audio: data.media.payload
                        }));
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
    
    ws.on('close', async () => {
        console.log('Twilio connection closed');
        
        const callEndTime = new Date();
        const callDuration = Math.floor((callEndTime - callStartTime) / 1000);
        
        if (callSid) {
            const updateData = {
                call_ended_at: callEndTime.toISOString(),
                call_duration: callDuration,
                conversation_transcript: JSON.stringify(conversationTranscript),
                stream_sid: streamSid,
                call_status: 'completed'
            };

            console.log('Updating call log with complete data:', {
                call_sid: callSid,
                call_duration: callDuration,
                conversation_items: conversationTranscript.length
            });

            await updateCallLog(callSid, updateData);
            console.log(`Call completed. Duration: ${callDuration} seconds`);
        }
        
        if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
            openaiWs.close();
        }
    });
    
    ws.on('error', async (error) => {
        console.error('Twilio WebSocket error:', error);
        if (callSid) {
            await hangup(callSid, {
                message: 'We are experiencing technical difficulties. Please try calling again.',
                reason: 'websocket_error'
            });
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
    
    console.log(`Restaurant AI System running on port ${PORT}`);
    console.log(`Server address: https://0.0.0.0:${PORT}`);
    console.log(`Ready to handle calls for busy restaurants`);
    console.log(`WebSocket ready for Twilio Media Streams`);
    console.log(`OpenAI configured: ${!!OPENAI_API_KEY}`);
    console.log(`Supabase configured: ${!!(SUPABASE_URL && SUPABASE_ANON_KEY)}`);
    console.log(`Twilio configured: ${!!twilioClient}`);
    console.log(`BUSY RESTAURANT MODE: Calls handled by AI while staff focus on food prep`);
    console.log(`NATURAL CONVERSATION: OpenAI handles all conversation flow and intent detection`);
    console.log(`EDGE FUNCTIONS: All database operations through Supabase Edge Functions`);
    console.log(`MESSAGE SYSTEM: Customer messages for requests restaurant staff will handle`);
    console.log(`✅ Server successfully bound to port ${PORT} and ready for traffic`);
});

server.on('error', (error) => {
    console.error('Server error:', error);
    if (error.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} is already in use`);
    } else if (error.code === 'EACCES') {
        console.error(`Permission denied to bind to port ${PORT}`);
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
