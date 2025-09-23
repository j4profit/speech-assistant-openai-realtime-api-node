// Restaurant AI Ordering System - Complete Multi-Tenant Voice Agent
const express = require('express');
const WebSocket = require('ws');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const port = process.env.PORT || 3000;

// Environment Configuration
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!OPENAI_API_KEY || !SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.error('Missing required environment variables');
    console.error('Required: OPENAI_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY');
    process.exit(1);
}

// Initialize Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

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
// HTTP ENDPOINTS
// =============================================================================

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
        restaurant_id: null
    };
    
    // Look up restaurant to get restaurant_id for the call log
    const restaurant = await getRestaurantByPhone(callData.to_number);
    if (restaurant) {
        callData.restaurant_id = restaurant.id;
    }
    
    // Create initial call log
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
    res.json({ 
        status: 'healthy',
        openai_configured: !!OPENAI_API_KEY,
        supabase_configured: !!(SUPABASE_URL && SUPABASE_ANON_KEY),
        timestamp: new Date().toISOString() 
    });
});

// Root endpoint
app.get('/', (req, res) => {
    res.json({ 
        message: 'Restaurant AI Ordering and Messaging System',
        websocket_url: `wss://${req.get('host')}/media-stream`,
        server_time: new Date().toISOString()
    });
});

// API endpoint to get recent orders
app.get('/orders', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('orders')
            .select(`
                *,
                restaurants(name, delivery_enabled, delivery_radius, delivery_hours),
                call_logs(call_duration, from_number)
            `)
            .order('created_at', { ascending: false })
            .limit(50);

        if (error) {
            return res.status(500).json({ error: error.message });
        }

        res.json({ orders: data });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// API endpoint to get customer messages
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
// HELPER FUNCTIONS - DATABASE & EXTERNAL SERVICES
// =============================================================================

// Get restaurant data by phone number using Edge Function
async function getRestaurantByPhone(phoneNumber) {
    try {
        console.log('Calling get-restaurant Edge Function for phone:', phoneNumber);
        
        const response = await fetch('https://ujgpqnarhcegrpyzbxej.supabase.co/functions/v1/get-restaurant', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
            },
            body: JSON.stringify({
                phone_number: phoneNumber
            })
        });

        if (!response.ok) {
            console.error('Edge Function response not ok:', response.status);
            return null;
        }

        const result = await response.json();
        
        if (result.error) {
            console.error('Edge Function returned error:', result.error);
            return null;
        }

        const restaurant = result.data;
        if (!restaurant) {
            console.log('No restaurant found for phone:', phoneNumber);
            return null;
        }

        // Ensure delivery settings have defaults
        const restaurantWithDefaults = {
            ...restaurant,
            delivery_enabled: restaurant.delivery_enabled ?? false,
            delivery_radius: restaurant.delivery_radius ?? 5,
            delivery_hours: restaurant.delivery_hours ?? null,
            delivery_time: restaurant.delivery_time ?? 15,
            preparation_time: restaurant.preparation_time ?? 20
        };

        console.log('Restaurant loaded:', {
            name: restaurantWithDefaults.name,
            delivery_enabled: restaurantWithDefaults.delivery_enabled,
            delivery_radius: restaurantWithDefaults.delivery_radius,
            delivery_hours: restaurantWithDefaults.delivery_hours
        });

        return restaurantWithDefaults;
    } catch (error) {
        console.error('Error calling get-restaurant Edge Function:', error);
        return null;
    }
}

// Create call log using Edge Function
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

        if (!response.ok) {
            console.error('create-call-log Edge Function response not ok:', response.status);
            return null;
        }

        const result = await response.json();
        
        if (result.error) {
            console.error('create-call-log Edge Function returned error:', result.error);
            return null;
        }

        console.log('Call log created:', result.data?.id);
        return result.data;
    } catch (error) {
        console.error('Error calling create-call-log Edge Function:', error);
        return null;
    }
}

// Update call log using Edge Function
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

        if (!response.ok) {
            console.error('update-call-log Edge Function response not ok:', response.status);
            return null;
        }

        const result = await response.json();
        return result.data;
    } catch (error) {
        console.error('Error calling update-call-log Edge Function:', error);
        return null;
    }
}

// Search for recent orders using Edge Function
async function searchRecentOrders(phoneNumber, restaurantId, daysBack = 7) {
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
                days_back: daysBack,
                status: 'pending'
            })
        });

        if (!response.ok) {
            return [];
        }

        const result = await response.json();
        return result.data || [];
    } catch (error) {
        console.error('Error calling search-orders Edge Function:', error);
        return [];
    }
}

// Cancel order using Edge Function
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

        if (!response.ok) {
            return null;
        }

        const result = await response.json();
        return result.data;
    } catch (error) {
        console.error('Error calling cancel-order Edge Function:', error);
        return null;
    }
}

// Update order using Edge Function
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

        if (!response.ok) {
            return null;
        }

        const result = await response.json();
        return result.data;
    } catch (error) {
        console.error('Error calling update-order Edge Function:', error);
        return null;
    }
}

// Validate delivery address using Edge Function
async function validateDeliveryAddress(address, restaurant) {
    try {
        console.log('Validating delivery address:', address);
        
        const response = await fetch('https://ujgpqnarhcegrpyzbxej.supabase.co/functions/v1/validate-delivery', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
            },
            body: JSON.stringify({
                address: address,
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
            address: address
        };
    }
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

// Calculate order ready time
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

// Create order in database
async function createOrder(orderData) {
    try {
        const isDelivery = orderData.order_type === 'delivery';
        const timing = calculateOrderReadyTime(orderData.restaurant_settings, isDelivery);
        
        orderData.ready_time = timing.readyTimeString;
        orderData.estimated_ready_at = timing.readyTime?.toISOString();
        
        const { data: order, error: orderError } = await supabase
            .from('orders')
            .insert([{
                restaurant_id: orderData.restaurant_id,
                customer_phone: orderData.customer_phone,
                customer_name: orderData.customer_name,
                total_amount: orderData.total_amount,
                status: 'pending',
                order_type: orderData.order_type || 'pickup',
                delivery_address: orderData.delivery_address || null,
                order_details: orderData.order_details,
                special_instructions: orderData.special_instructions,
                ready_time: orderData.ready_time,
                estimated_ready_at: orderData.estimated_ready_at,
                call_sid: orderData.call_sid
            }])
            .select()
            .single();

        if (orderError) {
            console.error('Error creating order:', orderError);
            return null;
        }

        console.log('Order created successfully:', order.id);
        return order;
    } catch (error) {
        console.error('Error creating order:', error);
        return null;
    }
}

// Format menu for AI
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

// Extract address from conversation
function extractAddressFromConversation(conversationTranscript) {
    const customerMessages = conversationTranscript
        .filter(msg => msg.speaker === 'Customer')
        .slice(-5)
        .map(msg => msg.text)
        .join(' ');
    
    console.log('Searching for address in conversation:', customerMessages);
    
    const addressPatterns = [
        // Complete address with state and 5-digit zip
        /\d+\s+[\w\s]+(?:street|road|avenue|lane|drive|way|court|place|boulevard|blvd|ave|rd|st|ct|pl|ln|dr)[\w\s,]*[\w\s,]*\d{5}/i,
        // Address with road/street and 5-digit zip
        /\d+\s+[\w\s]+(?:road|rd|street|st|avenue|ave|lane|ln|drive|dr|way|court|ct|place|pl|boulevard|blvd)[\w\s,]*\d{5}/i,
        // Any street number + name + 5-digit zip
        /\d+\s+[\w\s,]+\d{5}/,
        // Street number + name with common suffixes
        /\d+\s+[\w\s]+(?:street|road|avenue|lane|drive|way|court|place|boulevard|blvd|ave|rd|st|ct|pl|ln|dr)[\w\s,]*/i
    ];
    
    for (const pattern of addressPatterns) {
        const match = customerMessages.match(pattern);
        if (match) {
            const address = match[0].trim().replace(/\.$/, '');
            console.log('Found address:', address);
            return address;
        }
    }
    
    console.log('No address pattern matched');
    return null;
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
    let isModificationCall = false;
    let capturedDeliveryAddress = null;

    // Initialize OpenAI connection
    async function initializeOpenAI(calledNumber, fromNumber, callId) {
        console.log('Loading restaurant data for:', calledNumber);
        
        const phoneToLookup = calledNumber || '+14108880091';
        restaurant = await getRestaurantByPhone(phoneToLookup);
        
        if (!restaurant) {
            console.error('Restaurant not found for phone:', phoneToLookup);
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
            
            const instructions = `You are an AI assistant for ${restaurant.name}. 

IMPORTANT: Immediately greet with: "Hello! Thank you for calling ${restaurant.name}. How can I help you today?"

Keep responses SHORT - maximum 2-3 sentences at a time.

DELIVERY SETTINGS:
- Delivery Enabled: ${restaurant.delivery_enabled ? 'YES' : 'NO'}
${!restaurant.delivery_enabled ? 
    'IMPORTANT: This restaurant does NOT offer delivery. Only offer PICKUP orders.' :
    'You can offer both pickup and delivery options.'}

${menuText}

ORDER PROCESS:
1. Get customer name first
2. Ask if they want pickup or delivery  
3. Take their order items
4. For delivery: get complete address then call validate_delivery_address("exact address")
5. Create ORDER_CONFIRMED format immediately after successful validation

CRITICAL: When calling validate_delivery_address, ALWAYS include the address parameter.
Example: validate_delivery_address("123 Main Street, City, State, 12345")

ORDER_CONFIRMED:
- Customer Name: [name]
- Phone: ${customerPhone || '[phone]'}
- Order Type: [delivery or pickup]
- Delivery Address: [full address or N/A]
- Items: [items with prices]
- Special Instructions: [instructions or None]
- Total: $[amount]
- Ready Time: [estimated time]
ORDER_END

Keep all responses conversational and brief.`;

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
                        silence_duration_ms: 1800
                    },
                    tools: [
                        {
                            type: "function",
                            name: "search_recent_orders",
                            description: "Search for recent pending orders by customer's phone number",
                            parameters: {
                                type: "object",
                                properties: {
                                    phone_number: { type: "string", description: "Customer's phone number" }
                                },
                                required: []
                            }
                        },
                        {
                            type: "function",
                            name: "validate_delivery_address",
                            description: "Validate delivery address for the restaurant",
                            parameters: {
                                type: "object",
                                properties: {
                                    address: { type: "string", description: "Complete delivery address with street, city, state, zip" }
                                },
                                required: ["address"]
                            }
                        },
                        {
                            type: "function", 
                            name: "cancel_order",
                            description: "Cancel an existing order",
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
                            description: "Update an existing order",
                            parameters: {
                                type: "object",
                                properties: {
                                    order_id: { type: "string", description: "Order ID to update" },
                                    modifications: { type: "string", description: "Description of changes" },
                                    new_total: { type: "number", description: "New total amount" }
                                },
                                required: ["order_id", "modifications"]
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
                        
                        if (response.transcript.includes('ORDER_CONFIRMED:') && !isModificationCall) {
                            processOrderFromTranscript(response.transcript);
                        }
                        break;
                        
                    case 'conversation.item.input_audio_transcription.completed':
                        console.log('Customer said:', response.transcript);
                        conversationTranscript.push({
                            timestamp: new Date().toISOString(),
                            speaker: 'Customer',
                            text: response.transcript
                        });
                        break;
                        
                    case 'input_audio_buffer.speech_started':
                        console.log('Customer started speaking');
                        break;
                        
                    case 'input_audio_buffer.speech_stopped':
                        console.log('Customer stopped speaking');
                        break;
                        
                    case 'response.done':
                        console.log('AI response complete');
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
                        break;
                        
                    case 'session.updated':
                        console.log('OpenAI session configured');
                        openaiWs.send(JSON.stringify({
                            type: 'response.create',
                            response: {
                                modalities: ['audio', 'text'],
                                instructions: `Say: "Hello! Thank you for calling ${restaurant.name}. How can I help you today?"`
                            }
                        }));
                        break;
                }
            } catch (error) {
                console.error('Error processing OpenAI message:', error);
            }
        });
        
        openaiWs.on('error', (error) => {
            console.error('OpenAI WebSocket error:', error);
        });
        
        openaiWs.on('close', () => {
            console.log('OpenAI connection closed');
        });
    }

    // Handle function calls from OpenAI
    async function handleFunctionCall(functionCall) {
        try {
            const { name, call_id, arguments: args } = functionCall;
            let result = null;
            let parsedArgs = {};

            console.log(`Executing function: ${name}`);

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
                    const phoneNumber = parsedArgs.phone_number || customerPhone;
                    const orders = await searchRecentOrders(phoneNumber, restaurant.id);
                    recentOrders = orders;
                    
                    result = {
                        orders: orders.map(order => ({
                            id: order.id,
                            total: order.total_amount,
                            order_type: order.order_type,
                            delivery_address: order.delivery_address,
                            items: order.order_items?.map(item => ({
                                name: item.menu_items?.name || 'Item',
                                quantity: item.quantity,
                                price: item.price
                            })) || []
                        })),
                        count: orders.length,
                        message: orders.length === 0 ? 'No pending orders found.' : `Found ${orders.length} pending order(s).`
                    };
                    break;

                case 'validate_delivery_address':
                    let address = parsedArgs.address;
                    
                    // If no address in arguments, extract from conversation
                    if (!address) {
                        address = extractAddressFromConversation(conversationTranscript);
                        console.log('Extracted address from conversation:', address);
                    }
                    
                    if (!address) {
                        result = {
                            valid: false,
                            message: 'Please provide your complete delivery address including street number, street name, city, state, and zip code.'
                        };
                        break;
                    }
                    
                    // Check if restaurant supports delivery
                    if (!restaurant.delivery_enabled) {
                        result = {
                            valid: false,
                            message: 'We only offer pickup orders. Delivery is not available.'
                        };
                        break;
                    }
                    
                    const validationResult = await validateDeliveryAddress(address, restaurant);
                    
                    if (validationResult.valid) {
                        capturedDeliveryAddress = address;
                        console.log('DELIVERY ADDRESS VALIDATED:', address);
                        
                        validationResult.instruction = 'SUCCESS! Address is valid. Create ORDER_CONFIRMED format immediately.';
                        validationResult.status = 'APPROVED';
                        validationResult.confirmed_address = address;
                    }
                    
                    result = validationResult;
                    break;

                case 'cancel_order':
                    isModificationCall = true;
                    let cancelOrderId = parsedArgs.order_id;
                    
                    if (!cancelOrderId && recentOrders?.length > 0) {
                        cancelOrderId = recentOrders[0].id;
                    }
                    
                    if (!cancelOrderId) {
                        result = { error: 'No order ID provided' };
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
                    isModificationCall = true;
                    let orderId = parsedArgs.order_id;
                    
                    if (!orderId && recentOrders?.length > 0) {
                        orderId = recentOrders[0].id;
                    }
                    
                    if (!orderId) {
                        result = { error: 'No order ID provided' };
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

                default:
                    result = { error: `Unknown function: ${name}` };
            }

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
                }, 100);
            }

        } catch (error) {
            console.error('Error handling function call:', error);
            
            if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                openaiWs.send(JSON.stringify({
                    type: 'conversation.item.create',
                    item: {
                        type: 'function_call_output',
                        call_id: functionCall.call_id || 'unknown',
                        output: JSON.stringify({ error: error.message })
                    }
                }));
            }
        }
    }

    // Process order from AI transcript
    async function processOrderFromTranscript(transcript) {
        try {
            if (isModificationCall || orderProcessed) {
                console.log('Skipping order processing - already processed or modification call');
                return;
            }
            
            if (transcript.includes('ORDER_CONFIRMED:') && transcript.includes('ORDER_END')) {
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
                
                const lines = orderSection.split('\n').map(line => line.trim());
                
                for (const line of lines) {
                    if (line.includes('Customer Name:')) {
                        customerName = line.substring(line.indexOf(':') + 1).trim();
                    } else if (line.includes('Order Type:')) {
                        orderType = line.substring(line.indexOf(':') + 1).trim().toLowerCase();
                    } else if (line.includes('Delivery Address:')) {
                        const addr = line.substring(line.indexOf(':') + 1).trim();
                        if (addr && addr.toLowerCase() !== 'n/a') {
                            deliveryAddress = addr;
                        } else if (orderType === 'delivery' && capturedDeliveryAddress) {
                            deliveryAddress = capturedDeliveryAddress;
                        }
                    } else if (line.includes('Items:')) {
                        items = line.substring(line.indexOf(':') + 1).trim();
                    } else if (line.includes('Special Instructions:')) {
                        specialInstructions = line.substring(line.indexOf(':') + 1).trim();
                    } else if (line.includes('Total:')) {
                        const totalMatch = line.match(/\$(\d+\.?\d*)/);
                        if (totalMatch) {
                            totalAmount = parseFloat(totalMatch[1]);
                        }
                    }
                }
                
                const timing = calculateOrderReadyTime(restaurant, orderType === 'delivery');
                
                const orderData = {
                    restaurant_id: restaurant.id,
                    customer_phone: customerPhone,
                    customer_name: customerName || null,
                    total_amount: totalAmount || 0,
                    order_type: orderType,
                    delivery_address: deliveryAddress,
                    order_details: `Customer: ${customerName}\nPhone: ${customerPhone}\nOrder Type: ${orderType}\n${orderType === 'delivery' ? `Delivery Address: ${deliveryAddress}` : 'Pickup'}\nItems: ${items}\nSpecial Instructions: ${specialInstructions || 'None'}\nEstimated ${orderType === 'delivery' ? 'Delivery' : 'Pickup'} Time: ${timing.totalMinutes} minutes`,
                    special_instructions: specialInstructions || '',
                    call_sid: callSid,
                    restaurant_settings: restaurant,
                    items: []
                };

                const order = await createOrder(orderData);
                if (order) {
                    console.log('NEW order saved successfully with ID:', order.id);
                    console.log('Order type:', order.order_type);
                    if (order.order_type === 'delivery') {
                        console.log('Delivery address:', order.delivery_address);
                    }
                    
                    capturedDeliveryAddress = null;
                    
                    if (callSid) {
                        await updateCallLog(callSid, { order_id: order.id });
                    }
                } else {
                    orderProcessed = false;
                    console.log('Order creation failed, resetting flag');
                }
            }
        } catch (error) {
            console.error('Error processing order:', error);
            orderProcessed = false;
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
                    console.log('From number:', fromNumber);
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
        }
    });
    
    ws.on('close', async () => {
        console.log('Twilio connection closed');
        
        const callEndTime = new Date();
        const callDuration = Math.floor((callEndTime - callStartTime) / 1000);
        
        if (callSid) {
            await updateCallLog(callSid, {
                conversation_transcript: JSON.stringify(conversationTranscript),
                call_ended_at: callEndTime.toISOString(),
                call_duration: callDuration
            });
            console.log(`Call completed. Duration: ${callDuration} seconds`);
        }
        
        if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
            openaiWs.close();
        }
    });
    
    ws.on('error', (error) => {
        console.error('Twilio WebSocket error:', error);
    });
});

// =============================================================================
// SERVER STARTUP
// =============================================================================

wss.on('error', (error) => {
    console.error('WebSocket Server error:', error);
});

server.listen(port, '0.0.0.0', () => {
    console.log(`Restaurant AI System running on port ${port}`);
    console.log(`Ready to take orders and messages via phone calls`);
    console.log(`WebSocket ready for Twilio Media Streams`);
    console.log(`OpenAI configured: ${!!OPENAI_API_KEY}`);
    console.log(`Supabase configured: ${!!(SUPABASE_URL && SUPABASE_ANON_KEY)}`);
    console.log(`Multi-tenant delivery controls enabled`);
});
