// Restaurant AI Ordering System - Complete Multi-Tenant Voice Agent - FULLY FIXED
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
        restaurant_id: null,
        // Initialize fields that will be updated later
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
    
    console.log('Creating call log with complete webhook data:', {
        call_sid: callData.call_sid,
        from_number: callData.from_number,
        to_number: callData.to_number,
        to_city: callData.to_city,
        to_zip: callData.to_zip,
        restaurant_id: callData.restaurant_id
    });
    
    // Create initial call log with all webhook data
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

// Health check endpoint - responds immediately
app.get('/health', (req, res) => {
    res.status(200).json({ 
        status: 'healthy',
        port: process.env.PORT || 3000,
        timestamp: new Date().toISOString(),
        openai_configured: !!OPENAI_API_KEY,
        supabase_configured: !!(SUPABASE_URL && SUPABASE_ANON_KEY),
        uptime: process.uptime()
    });
});

// Simple ping endpoint for port detection
app.get('/ping', (req, res) => {
    res.status(200).send('pong');
});

// Root endpoint
app.get('/', (req, res) => {
    res.status(200).json({ 
        message: 'Restaurant AI Ordering and Messaging System',
        status: 'running',
        port: process.env.PORT || 3000,
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

// Validate delivery address using Edge Function with improved error handling
async function validateDeliveryAddress(address, restaurant) {
    try {
        console.log('Validating delivery address:', address);
        
        // Ensure we have a valid address before making the call
        if (!address || address.trim().length < 10) {
            return {
                valid: false,
                message: 'Please provide a complete address with street number, street name, city, state, and zip code.',
                address: address
            };
        }
        
        const requestData = {
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
        };

        console.log('Sending validation request:', requestData);
        
        const response = await fetch('https://ujgpqnarhcegrpyzbxej.supabase.co/functions/v1/validate-delivery', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
            },
            body: JSON.stringify(requestData)
        });

        if (!response.ok) {
            console.error('Delivery validation API error:', response.status, response.statusText);
            return {
                valid: false,
                message: 'Unable to validate address at this time. Please provide a complete address or choose pickup.',
                address: address
            };
        }

        const result = await response.json();
        console.log('Validation result:', result);
        
        if (result.error) {
            console.error('Validation error:', result.error);
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

// Enhanced address extraction that looks for address patterns
function extractAddressFromConversation(conversationTranscript) {
    // Get all customer messages, prioritizing recent ones
    const customerMessages = conversationTranscript
        .filter(msg => msg.speaker === 'Customer')
        .slice(-10) // Look at last 10 customer messages
        .map(msg => msg.text)
        .join(' ');
    
    console.log('Searching for address in conversation:', customerMessages);
    
    // Enhanced address patterns with more flexibility
    const addressPatterns = [
        // Complete address: number + street + city + state + 5-digit zip
        /\b\d+\s+[\w\s]+(?:street|road|avenue|lane|drive|way|court|place|boulevard|blvd|ave|rd|st|ct|pl|ln|dr)\b[\w\s,]*?[\w\s,]*?\b\d{5}\b/gi,
        
        // Address with common abbreviations
        /\b\d+\s+[\w\s]+(?:rd|st|ave|ln|dr|ct|pl|way|blvd)\b[\w\s,]*?\b\d{5}\b/gi,
        
        // Number + any text + 5-digit zip (more liberal)
        /\b\d+\s+[\w\s,.-]+?\b\d{5}\b/g,
        
        // Street number + words ending with common suffixes
        /\b\d+\s+[\w\s]+(?:street|road|avenue|lane|drive|way|court|place|boulevard|blvd|ave|rd|st|ct|pl|ln|dr)\b[\w\s,]*/gi,
        
        // Very liberal: any sequence with a street number at the start
        /\b\d+\s+[A-Za-z][\w\s,.-]*(?:street|road|avenue|lane|drive|way|court|place|boulevard|blvd|ave|rd|st|ct|pl|ln|dr|maryland|md|baltimore|laurel)[\w\s,.-]*/gi
    ];
    
    for (let i = 0; i < addressPatterns.length; i++) {
        const pattern = addressPatterns[i];
        const matches = customerMessages.match(pattern);
        
        if (matches && matches.length > 0) {
            // Get the longest match (most likely to be complete)
            const bestMatch = matches.reduce((longest, current) => 
                current.length > longest.length ? current : longest
            );
            
            const address = bestMatch.trim().replace(/^[,\s]+|[,\s]+$/g, '');
            console.log(`Found address with pattern ${i + 1}:`, address);
            
            // Basic validation - must have number and some text
            if (address.length >= 10 && /^\d+\s/.test(address)) {
                return address;
            }
        }
    }
    
    // Fallback: look for any sequence that might be an address
    const words = customerMessages.split(/\s+/);
    let possibleAddress = '';
    let foundNumber = false;
    
    for (let i = 0; i < words.length; i++) {
        const word = words[i];
        
        // Start capturing when we find a number
        if (/^\d+$/.test(word) && !foundNumber) {
            foundNumber = true;
            possibleAddress = word;
            continue;
        }
        
        // Continue capturing if we've started
        if (foundNumber) {
            possibleAddress += ' ' + word;
            
            // Stop if we hit punctuation that suggests end of address
            if (word.includes('.') || word.includes('?') || word.includes('!')) {
                break;
            }
            
            // Stop if we've captured a reasonable amount
            if (possibleAddress.length > 50) {
                break;
            }
        }
    }
    
    if (foundNumber && possibleAddress.length >= 10) {
        console.log('Fallback address found:', possibleAddress.trim());
        return possibleAddress.trim();
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
    let addressValidationInProgress = false;
    let callData = null; // Store original call data for updates
    
    // **CRITICAL FIX** - Add address validation state tracking
    let addressValidationCompleted = false;
    let lastValidationResult = null;
    let lastValidatedAddress = null;

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

Keep responses SHORT and CONVERSATIONAL - maximum 2-3 sentences at a time.

DELIVERY SETTINGS:
- Delivery Enabled: ${restaurant.delivery_enabled ? 'YES' : 'NO'}
${!restaurant.delivery_enabled ? 
    'IMPORTANT: This restaurant does NOT offer delivery. Only offer PICKUP orders.' :
    'You can offer both pickup and delivery options.'}

${menuText}

**CRITICAL ADDRESS VALIDATION TIMING RULES:**
1. NEVER call validate_delivery_address function immediately after asking for address
2. ONLY call validate_delivery_address AFTER the customer provides what looks like a complete address
3. If validation succeeds (returns valid: true, proceed_to_order: true), CREATE ORDER_CONFIRMED format IMMEDIATELY
4. Do NOT ask for address confirmation after successful validation
5. Do NOT call the function multiple times for the same address

CRITICAL ORDER FLOW (Follow this EXACT sequence):
1. Get customer name first
2. SMART Order Type Detection:
   - If customer says "delivery", "deliver", "delivered", "put a delivery order" → DELIVERY CONFIRMED, skip to step 3
   - If customer says "pickup", "pick up", "pick it up" → PICKUP CONFIRMED, skip to step 4  
   - If unclear, ask: "Would you like this for pickup or delivery?"
3. FOR DELIVERY: Get their order items first, then get complete address
4. FOR PICKUP: Get their order items, then create ORDER_CONFIRMED
5. Create ORDER_CONFIRMED format IMMEDIATELY after getting all required info

DELIVERY ADDRESS VALIDATION - CRITICAL TIMING RULES:
- NEVER call validate_delivery_address immediately after asking "Could you provide your address?"
- ONLY call validate_delivery_address AFTER you receive and read the customer's address response
- Wait to see what the customer actually says before deciding to validate
- The customer must provide something that looks like: "123 Main Street, City, State, 12345"
- Do NOT validate if customer just says "okay" or "yes" or asks questions

STEP-BY-STEP ADDRESS PROCESS:
1. Ask: "Could you please provide the delivery address?"
2. WAIT for customer response
3. READ what customer said
4. IF it looks like a complete address → call validate_delivery_address
5. IF it doesn't look like an address → ask again politely
6. After successful validation → create ORDER_CONFIRMED

CONVERSATION EXAMPLES:
Customer: "I want to put a delivery order in"
AI: "Great! May I have your name, please?" (DON'T ask about delivery again!)

ORDER_CONFIRMED FORMAT (Create THIS EXACT format - no asterisks):
ORDER_CONFIRMED:
- Customer Name: [name]
- Phone: ${customerPhone || '[phone]'}
- Order Type: [delivery or pickup]
- Delivery Address: [complete validated address or N/A for pickup]
- Items: [items with individual prices like "Large Pepperoni Pizza - $18.99"]
- Special Instructions: [instructions or None]
- Total: $[total amount]
- Ready Time: [estimated minutes]
ORDER_END

CRITICAL FUNCTION CALL RULES:
- Do NOT call any functions immediately after asking a question
- ALWAYS wait for and process the customer's response first
- Only call validate_delivery_address when you have an actual address to validate
- If unsure, ask the customer to clarify rather than calling functions prematurely

CRITICAL TIMING RULE: Never call functions immediately after asking for information. Always wait for the customer's response first.`;

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
                            description: "Validate delivery address - ONLY call this when customer has provided what looks like a complete address with street number, street name, city, state, zip. DO NOT call immediately after asking for address.",
                            parameters: {
                                type: "object",
                                properties: {
                                    address: { 
                                        type: "string", 
                                        description: "Complete delivery address that customer just provided - must include street number, street name, city, state, and zip code" 
                                    }
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
                        
                        // Process order only after successful validation and not during modification calls
                        if (response.transcript.includes('ORDER_CONFIRMED:') && !isModificationCall && !orderProcessed) {
                            processOrderFromTranscript(response.transcript);
                        }
                        
                        // Also update call log with order ID when order is successfully created
                        if (response.transcript.includes('ORDER_CONFIRMED:') && callSid) {
                            setTimeout(async () => {
                                // Give time for order creation to complete
                                const conversationText = conversationTranscript
                                    .map(msg => `${msg.speaker}: ${msg.text}`)
                                    .join('\n');
                                
                                await updateCallLog(callSid, {
                                    conversation_transcript: JSON.stringify(conversationTranscript),
                                    conversation_text: conversationText,
                                    has_order: true,
                                    call_status: 'active'
                                });
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
                        // Send initial greeting
                        setTimeout(() => {
                            if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                                openaiWs.send(JSON.stringify({
                                    type: 'response.create',
                                    response: {
                                        modalities: ['audio', 'text'],
                                        instructions: `Say: "Hello! Thank you for calling ${restaurant.name}. How can I help you today?"`
                                    }
                                }));
                            }
                        }, 500);
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

    // Enhanced function call handler with better error handling and validation
    async function handleFunctionCall(functionCall) {
        try {
            const { name, call_id, arguments: args } = functionCall;
            let result = null;
            let parsedArgs = {};

            console.log(`Executing function: ${name}`);

            // Parse arguments more robustly
            if (!args || args === '') {
                parsedArgs = {};
            } else if (typeof args === 'string') {
                try {
                    parsedArgs = JSON.parse(args);
                } catch (e) {
                    console.log('Could not parse args as JSON, treating as raw:', args);
                    parsedArgs = { raw: args };
                }
            } else {
                parsedArgs = args;
            }

            console.log('Parsed function arguments:', parsedArgs);

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
                    // **CRITICAL FIX** - Prevent multiple validations and handle caching
                    if (addressValidationInProgress) {
                        console.log('Validation already in progress, skipping...');
                        result = {
                            valid: false,
                            message: 'Please wait while we validate your address.',
                            needs_complete_address: false,
                            instruction: 'Address validation is already in progress.'
                        };
                        break;
                    }

                    addressValidationInProgress = true;
                    let address = parsedArgs.address;
                    
                    // Enhanced address extraction if not provided directly
                    if (!address || address.trim().length < 5) {
                        console.log('No address in function call, extracting from conversation...');
                        address = extractAddressFromConversation(conversationTranscript);
                        console.log('Extracted address from conversation:', address);
                    }
                    
                    // **KEY FIX** - Check if this is the same address we just validated successfully
                    if (address === lastValidatedAddress && addressValidationCompleted && lastValidationResult?.valid) {
                        console.log('Address already validated successfully, returning cached result');
                        result = {
                            ...lastValidationResult,
                            instruction: 'SUCCESS! Address is already validated. Create ORDER_CONFIRMED format immediately with all the information you have collected.',
                            status: 'APPROVED',
                            confirmed_address: address,
                            proceed_to_order: true
                        };
                        addressValidationInProgress = false;
                        break;
                    }
                    
                    // Check if customer actually provided address info vs just said "delivered" or similar
                    const lastMessage = conversationTranscript
                        .filter(msg => msg.speaker === 'Customer')
                        .slice(-1)[0]?.text || '';
                    
                    const hasAddressInfo = /\d+.*?(street|road|avenue|lane|drive|way|court|place|boulevard|blvd|ave|rd|st|ct|pl|ln|dr|maryland|md)/i.test(lastMessage);
                    
                    console.log('Address validation check:', {
                        hasAddressInfo,
                        lastMessage,
                        extractedAddress: address
                    });
                    
                    if (!address || address.trim().length < 10 || !hasAddressInfo) {
                        console.log('Customer has not provided address yet. Last message:', lastMessage);
                        result = {
                            valid: false,
                            message: 'I need your complete delivery address. Please provide the street number, street name, city, state, and zip code.',
                            needs_complete_address: true,
                            instruction: 'Customer has not provided delivery address yet. Wait for them to provide it before calling this function again.'
                        };
                        addressValidationInProgress = false;
                        break;
                    }
                    
                    // Check if restaurant supports delivery first
                    if (!restaurant.delivery_enabled) {
                        result = {
                            valid: false,
                            message: 'We only offer pickup orders. Delivery is not available at this location.',
                            delivery_not_available: true
                        };
                        addressValidationInProgress = false;
                        break;
                    }
                    
                    console.log('Validating address:', address);
                    const validationResult = await validateDeliveryAddress(address, restaurant);
                    console.log('Validation result received:', validationResult);
                    
                    if (validationResult.valid) {
                        capturedDeliveryAddress = address;
                        // **CRITICAL FIX** - Cache successful validation
                        addressValidationCompleted = true;
                        lastValidationResult = validationResult;
                        lastValidatedAddress = address;
                        
                        console.log('DELIVERY ADDRESS VALIDATED SUCCESSFULLY:', address);
                        
                        result = {
                            ...validationResult,
                            instruction: 'SUCCESS! Address is valid for delivery. Create ORDER_CONFIRMED format immediately with all the information you have collected.',
                            status: 'APPROVED',
                            confirmed_address: address,
                            proceed_to_order: true
                        };
                    } else {
                        console.log('Address validation failed:', validationResult.message);
                        // **CRITICAL FIX** - Cache failed validation too
                        addressValidationCompleted = false;
                        lastValidationResult = validationResult;
                        lastValidatedAddress = address;
                        
                        result = {
                            ...validationResult,
                            instruction: 'Address validation failed. Ask customer for a complete address or suggest pickup.'
                        };
                    }
                    
                    addressValidationInProgress = false;
                    break;

                case 'cancel_order':
                    isModificationCall = true;
                    let cancelOrderId = parsedArgs.order_id;
                    
                    if (!cancelOrderId && recentOrders?.length > 0) {
                        cancelOrderId = recentOrders[0].id;
                    }
                    
                    if (!cancelOrderId) {
                        result = { 
                            error: 'No order ID provided. Please search for recent orders first.',
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
                    isModificationCall = true;
                    let orderId = parsedArgs.order_id;
                    
                    if (!orderId && recentOrders?.length > 0) {
                        orderId = recentOrders[0].id;
                    }
                    
                    if (!orderId) {
                        result = { 
                            error: 'No order ID provided. Please search for recent orders first.',
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
                
                // Trigger response generation
                setTimeout(() => {
                    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                        openaiWs.send(JSON.stringify({ type: 'response.create' }));
                    }
                }, 200);
            }

        } catch (error) {
            console.error('Error handling function call:', error);
            addressValidationInProgress = false;
            
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
        }
    }

    // Enhanced order processing with better validation
    async function processOrderFromTranscript(transcript) {
        try {
            if (isModificationCall || orderProcessed) {
                console.log('Skipping order processing - already processed or modification call');
                return;
            }
            
            if (addressValidationInProgress) {
                console.log('Skipping order processing - address validation in progress');
                return;
            }
            
            // Look for both formatted versions of ORDER_CONFIRMED
            const hasOrderConfirmed = transcript.includes('ORDER_CONFIRMED:') || transcript.includes('**ORDER_CONFIRMED**');
            const hasOrderEnd = transcript.includes('ORDER_END');
            
            if (hasOrderConfirmed && hasOrderEnd) {
                orderProcessed = true;
                console.log('Processing NEW order from transcript...');
                
                // Handle both formats
                let orderStartMarker = 'ORDER_CONFIRMED:';
                if (!transcript.includes('ORDER_CONFIRMED:')) {
                    orderStartMarker = '**ORDER_CONFIRMED**';
                }
                
                const orderSection = transcript.substring(
                    transcript.indexOf(orderStartMarker) + orderStartMarker.length,
                    transcript.indexOf('ORDER_END')
                ).trim();
                
                let customerName = '';
                let items = '';
                let orderType = 'pickup';
                let deliveryAddress = null;
                let specialInstructions = '';
                let totalAmount = 0;
                let readyTime = '';
                
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
                        } else if (orderType === 'delivery' && capturedDeliveryAddress) {
                            deliveryAddress = capturedDeliveryAddress;
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
                    } else if (key.includes('ready time')) {
                        readyTime = value;
                    }
                }
                
                // Validate required fields
                if (!customerName) {
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
                    restaurant_settings: restaurant,
                    items: []
                };

                console.log('Creating order with data:', orderData);
                
                const order = await createOrder(orderData);
                if (order) {
                    console.log('NEW order saved successfully with ID:', order.id);
                    console.log('Order type:', order.order_type);
                    if (order.order_type === 'delivery') {
                        console.log('Delivery address:', order.delivery_address);
                    }
                    
                    // **CRITICAL FIX** - Clear validation state after successful order
                    capturedDeliveryAddress = null;
                    addressValidationCompleted = false;
                    lastValidationResult = null;
                    lastValidatedAddress = null;
                    
                    // Update call log with order ID
                    if (callSid) {
                        await updateCallLog(callSid, { order_id: order.id });
                    }
                } else {
                    console.log('Order creation failed, resetting flag');
                    orderProcessed = false;
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
                    
                    // Store call data for later updates
                    callData = {
                        call_sid: callId,
                        from_number: fromNumber,
                        to_number: calledNumber,
                        stream_sid: streamSid,
                        call_started_at: new Date().toISOString()
                    };
                    
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
            // Prepare comprehensive call log update with all required fields
            const updateData = {
                call_ended_at: callEndTime.toISOString(),
                call_duration: callDuration,
                conversation_transcript: JSON.stringify(conversationTranscript),
                stream_sid: streamSid,
                call_status: 'completed'
            };

            // Add additional fields if we have them from the original webhook
            if (callData) {
                updateData.call_started_at = callData.call_started_at;
                updateData.from_number = callData.from_number;
                updateData.to_number = callData.to_number;
            }

            console.log('Updating call log with complete data:', {
                call_sid: callSid,
                call_duration: callDuration,
                conversation_items: conversationTranscript.length,
                call_ended_at: callEndTime.toISOString()
            });

            await updateCallLog(callSid, updateData);
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

// Ensure port is properly configured
const PORT = process.env.PORT || 3000;
console.log('Configured to run on port:', PORT);
console.log('NODE_ENV:', process.env.NODE_ENV);

wss.on('error', (error) => {
    console.error('WebSocket Server error:', error);
});

// Start server with explicit error handling and immediate port binding
server.listen(PORT, '0.0.0.0', (error) => {
    if (error) {
        console.error('Server failed to start:', error);
        process.exit(1);
    }
    
    console.log(`Restaurant AI System running on port ${PORT}`);
    console.log(`Server address: http://0.0.0.0:${PORT}`);
    console.log(`Ready to take orders and messages via phone calls`);
    console.log(`WebSocket ready for Twilio Media Streams`);
    console.log(`OpenAI configured: ${!!OPENAI_API_KEY}`);
    console.log(`Supabase configured: ${!!(SUPABASE_URL && SUPABASE_ANON_KEY)}`);
    console.log(`Multi-tenant delivery controls enabled`);
    console.log(`Enhanced address validation and error handling active`);
    
    // Immediately log that the server is ready for connections
    console.log(`✅ Server successfully bound to port ${PORT} and ready for traffic`);
});

// Handle server errors
server.on('error', (error) => {
    console.error('Server error:', error);
    if (error.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} is already in use`);
    } else if (error.code === 'EACCES') {
        console.error(`Permission denied to bind to port ${PORT}`);
    }
    process.exit(1);
});

// Handle process termination gracefully
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
