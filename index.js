// Restaurant AI Ordering System with Supabase Integration
const express = require('express');
const WebSocket = require('ws');
const { createClient } = require('@supabase/supabase-js');
const app = express();
const port = process.env.PORT || 3000;

// Configuration
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!OPENAI_API_KEY || !SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.error('❌ Missing required environment variables');
    console.error('Required: OPENAI_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY');
    process.exit(1);
}

// Initialize Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Create HTTP server
const server = require('http').createServer(app);

// Create WebSocket server
const wss = new WebSocket.Server({ 
    server,
    path: '/media-stream'
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Twilio webhook endpoint for incoming calls
app.post('/voice', async (req, res) => {
    console.log('📞 Incoming call webhook:', req.body);
    
    // Extract call data from Twilio webhook
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
        twilio_data: req.body, // Store complete Twilio data
        restaurant_id: null // Will be populated after restaurant lookup
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

app.get('/', (req, res) => {
    res.json({ 
        message: 'Restaurant AI Ordering System',
        websocket_url: `wss://${req.get('host')}/media-stream`,
        server_time: new Date().toISOString()
    });
});

app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy',
        openai_configured: !!OPENAI_API_KEY,
        supabase_configured: !!(SUPABASE_URL && SUPABASE_ANON_KEY),
        timestamp: new Date().toISOString() 
    });
});

// API endpoint to get recent orders
app.get('/orders', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('orders')
            .select(`
                *,
                restaurants(name),
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

// API endpoint to get orders for a specific restaurant
app.get('/orders/:restaurantId', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('orders')
            .select(`
                *,
                restaurants(name),
                call_logs(call_duration, from_number),
                order_items(quantity, price, special_requests, menu_items(name))
            `)
            .eq('restaurant_id', req.params.restaurantId)
            .order('created_at', { ascending: false });

        if (error) {
            return res.status(500).json({ error: error.message });
        }

        res.json({ orders: data });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Function to get restaurant data by phone number
async function getRestaurantByPhone(phoneNumber) {
    try {
        const { data, error } = await supabase
            .from('restaurants')
            .select(`
                *,
                menu_items (
                    id,
                    name,
                    description,
                    price,
                    category,
                    available
                )
            `)
            .eq('phone_number', phoneNumber)
            .single();

        if (error) {
            console.error('❌ Error fetching restaurant:', error);
            return null;
        }

        return data;
    } catch (error) {
        console.error('❌ Database error:', error);
        return null;
    }
}

// Function to create call log in database
async function createCallLog(callData) {
    try {
        const { data, error } = await supabase
            .from('call_logs')
            .insert([{
                call_sid: callData.call_sid,
                restaurant_id: callData.restaurant_id,
                from_number: callData.from_number,
                to_number: callData.to_number,
                call_status: callData.call_status,
                call_direction: callData.call_direction,
                caller_country: callData.caller_country,
                caller_state: callData.caller_state,
                caller_city: callData.caller_city,
                caller_zip: callData.caller_zip,
                to_country: callData.to_country,
                to_state: callData.to_state,
                to_city: callData.to_city,
                to_zip: callData.to_zip,
                call_started_at: callData.call_started_at,
                twilio_data: callData.twilio_data
            }])
            .select()
            .single();

        if (error) {
            console.error('❌ Error creating call log:', error);
            return null;
        }

        console.log('📞 Call log created:', data.id);
        return data;
    } catch (error) {
        console.error('❌ Error creating call log:', error);
        return null;
    }
}

// Function to update call log when call ends
async function updateCallLog(callSid, updateData) {
    try {
        const { data, error } = await supabase
            .from('call_logs')
            .update(updateData)
            .eq('call_sid', callSid)
            .select()
            .single();

        if (error) {
            console.error('❌ Error updating call log:', error);
            return null;
        }

        console.log('📞 Call log updated for:', callSid);
        return data;
    } catch (error) {
        console.error('❌ Error updating call log:', error);
        return null;
    }
}
async function createOrder(orderData) {
    try {
        // Insert order
        const { data: order, error: orderError } = await supabase
            .from('orders')
            .insert([{
                restaurant_id: orderData.restaurant_id,
                customer_phone: orderData.customer_phone,
                total_amount: orderData.total_amount,
                status: 'pending',
                order_details: orderData.order_details,
                special_instructions: orderData.special_instructions,
                call_sid: orderData.call_sid
            }])
            .select()
            .single();

        if (orderError) {
            console.error('❌ Error creating order:', orderError);
            return null;
        }

        // Insert order items
        if (orderData.items && orderData.items.length > 0) {
            const orderItems = orderData.items.map(item => ({
                order_id: order.id,
                menu_item_id: item.menu_item_id,
                quantity: item.quantity,
                price: item.price,
                special_requests: item.special_requests
            }));

            const { error: itemsError } = await supabase
                .from('order_items')
                .insert(orderItems);

            if (itemsError) {
                console.error('❌ Error creating order items:', itemsError);
            }
        }

        console.log('✅ Order created successfully:', order.id);
        return order;
    } catch (error) {
        console.error('❌ Error creating order:', error);
        return null;
    }
}

// Function to format menu for AI
function formatMenuForAI(menuItems) {
    if (!menuItems || menuItems.length === 0) {
        return "No menu items available.";
    }

    const categories = {};
    menuItems.forEach(item => {
        if (!item.available) return;
        
        if (!categories[item.category]) {
            categories[item.category] = [];
        }
        categories[item.category].push({
            name: item.name,
            description: item.description,
            price: item.price,
            id: item.id
        });
    });

    let menuText = "MENU:\n";
    Object.keys(categories).forEach(category => {
        menuText += `\n${category.toUpperCase()}:\n`;
        categories[category].forEach(item => {
            menuText += `- ${item.name}: ${item.description} - $${item.price}\n`;
        });
    });

    return menuText;
}

// WebSocket connection handler
wss.on('connection', (ws, req) => {
    console.log('🔌 New WebSocket connection');
    
    let openaiWs = null;
    let streamSid = null;
    let callSid = null;
    let customerPhone = null;
    let restaurant = null;
    let callStartTime = new Date();
    let conversationTranscript = [];
    let currentOrder = {
        items: [],
        total: 0,
        special_instructions: ''
    };

    // Initialize OpenAI connection with restaurant context
    async function initializeOpenAI(calledNumber, fromNumber, callId) {
        console.log('🍽️ Loading restaurant data for:', calledNumber);
        
        // Fallback to a test number if calledNumber is undefined/null
        const phoneToLookup = calledNumber || '+14108880091'; // Your Twilio number
        console.log('📞 Using phone number for lookup:', phoneToLookup);
        
        // Get restaurant data
        restaurant = await getRestaurantByPhone(phoneToLookup);
        
        if (!restaurant) {
            console.error('❌ Restaurant not found for phone:', calledNumber);
            return;
        }

        console.log('✅ Restaurant loaded:', restaurant.name);
        customerPhone = fromNumber;
        callSid = callId;

        const menuText = formatMenuForAI(restaurant.menu_items);
        
        console.log('🤖 Connecting to OpenAI Realtime API...');
        
        openaiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
            headers: {
                'Authorization': `Bearer ${OPENAI_API_KEY}`,
                'OpenAI-Beta': 'realtime=v1'
            }
        });
        
        openaiWs.on('open', () => {
            console.log('✅ Connected to OpenAI Realtime API');
            
            // Configure the session with restaurant context
            const instructions = `You are an AI assistant for ${restaurant.name}. 

IMPORTANT: As soon as the session starts, immediately greet the caller with: "Hello! Thank you for calling ${restaurant.name}. How can I help you today?"

RESTAURANT INFORMATION:
- Name: ${restaurant.name}
- Description: ${restaurant.description || ''}
- Hours: ${restaurant.hours || 'Call for hours'}
- Location: ${restaurant.address || ''}

${menuText}

INSTRUCTIONS:
1. Start EVERY call with the greeting above mentioning the restaurant name
2. Help customers browse the menu and answer questions about items
3. Take orders clearly - ask for quantities and any special requests
4. Confirm orders back to the customer including prices
5. Calculate totals accurately
6. Ask for customer information if needed (name, pickup time, etc.)
7. Be helpful, friendly, and efficient
8. If asked about items not on the menu, politely explain they're not available

IMPORTANT ORDER PROCESSING:
When an order is confirmed, you MUST format it exactly like this:
ORDER_CONFIRMED:
- Customer Name: [name if provided]
- Items: [list each item with quantity and price]
- Special Instructions: [any special requests]
- Total: $[total amount]
- Pickup Time: [if specified]
ORDER_END

This format is critical for our system to process the order correctly.
Keep responses conversational and brief for phone calls.`;

            const sessionUpdate = {
                type: 'session.update',
                session: {
                    modalities: ['text', 'audio'],
                    instructions: instructions,
                    voice: 'alloy',
                    input_audio_format: 'g711_ulaw',
                    output_audio_format: 'g711_ulaw',
                    input_audio_transcription: {
                        model: 'whisper-1'
                    },
                    turn_detection: {
                        type: 'server_vad',
                        threshold: 0.5,
                        prefix_padding_ms: 300,
                        silence_duration_ms: 500
                    }
                }
            };
            openaiWs.send(JSON.stringify(sessionUpdate));
        });
        
        openaiWs.on('message', (data) => {
            try {
                const response = JSON.parse(data);
                
                switch (response.type) {
                    case 'response.audio.delta':
                        // Send AI audio back to Twilio
                        if (streamSid && ws.readyState === WebSocket.OPEN) {
                            const mediaMessage = {
                                event: 'media',
                                streamSid: streamSid,
                                media: {
                                    payload: response.delta
                                }
                            };
                            ws.send(JSON.stringify(mediaMessage));
                        }
                        break;
                        
                    case 'response.audio_transcript.done':
                        console.log('🤖 AI said:', response.transcript);
                        
                        // Add to conversation transcript
                        conversationTranscript.push({
                            timestamp: new Date().toISOString(),
                            speaker: 'AI',
                            text: response.transcript
                        });
                        
                        // Check if this looks like a confirmed order
                        if (response.transcript.toLowerCase().includes('your order') && 
                            response.transcript.toLowerCase().includes('total')) {
                            processOrderFromTranscript(response.transcript);
                        }
                        break;
                        
                    case 'conversation.item.input_audio_transcription.completed':
                        console.log('👤 Customer said:', response.transcript);
                        
                        // Add to conversation transcript
                        conversationTranscript.push({
                            timestamp: new Date().toISOString(),
                            speaker: 'Customer',
                            text: response.transcript
                        });
                        break;
                        
                    case 'input_audio_buffer.speech_started':
                        console.log('👤 Customer started speaking');
                        break;
                        
                    case 'input_audio_buffer.speech_stopped':
                        console.log('👤 Customer stopped speaking');
                        break;
                        
                    case 'response.done':
                        console.log('✅ AI response complete');
                        break;
                        
                    case 'error':
                        console.error('❌ OpenAI error:', response.error);
                        break;
                        
                    case 'session.updated':
                        console.log('⚙️ OpenAI session configured for', restaurant.name);
                        
                        // Immediately send a greeting to break the silence
                        const greetingMessage = {
                            type: 'response.create',
                            response: {
                                modalities: ['audio'],
                                instructions: `Immediately say: "Hello! Thank you for calling ${restaurant.name}. How can I help you today?"`
                            }
                        };
                        openaiWs.send(JSON.stringify(greetingMessage));
                        console.log('👋 Sending immediate greeting...');
                        break;
                }
            } catch (error) {
                console.error('❌ Error processing OpenAI message:', error);
            }
        });
        
        openaiWs.on('error', (error) => {
            console.error('❌ OpenAI WebSocket error:', error);
        });
        
        openaiWs.on('close', () => {
            console.log('🔌 OpenAI connection closed');
        });
    }

    // Improved order processing from AI transcript
    async function processOrderFromTranscript(transcript) {
        try {
            console.log('📝 Processing order from transcript...');
            
            // Look for the structured order format
            if (transcript.includes('ORDER_CONFIRMED:') && transcript.includes('ORDER_END')) {
                const orderSection = transcript.substring(
                    transcript.indexOf('ORDER_CONFIRMED:') + 'ORDER_CONFIRMED:'.length,
                    transcript.indexOf('ORDER_END')
                ).trim();
                
                console.log('📋 Found structured order:', orderSection);
                
                // Parse the structured order
                const orderData = parseStructuredOrder(orderSection);
                
                if (orderData) {
                    orderData.restaurant_id = restaurant.id;
                    orderData.customer_phone = customerPhone;
                    orderData.call_sid = callSid;
                    orderData.order_details = transcript;
                    
                    const order = await createOrder(orderData);
                    if (order) {
                        console.log('🎉 Structured order saved successfully!');
                        
                        // Link the order to the call log
                        if (callSid) {
                            await updateCallLog(callSid, { order_id: order.id });
                        }
                        return order;
                    }
                }
            }
            
            // Fallback: Check for order-like keywords
            if (transcript.toLowerCase().includes('your order') || 
                transcript.toLowerCase().includes('total') ||
                transcript.toLowerCase().includes('
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            switch (data.event) {
                case 'connected':
                    console.log('📞 Twilio connected');
                    break;
                    
                case 'start':
                    streamSid = data.start.streamSid;
                    
                    // Debug: Log the entire start data to see what's available
                    console.log('📋 Start data:', JSON.stringify(data.start, null, 2));
                    
                    // Try multiple ways to get the phone numbers
                    const calledNumber = data.start.customParameters?.Called || 
                                       data.start.customParameters?.To ||
                                       data.start.callSid?.split('CA')[0]; // Extract from callSid if needed
                    
                    const fromNumber = data.start.customParameters?.From ||
                                      data.start.customParameters?.Caller;
                    
                    const callId = data.start.customParameters?.CallSid || data.start.callSid;
                    
                    console.log('🎙️ Stream started:', streamSid);
                    console.log('📞 Called number:', calledNumber);
                    console.log('📞 From number:', fromNumber);
                    console.log('📞 Call ID:', callId);
                    
                    // Initialize OpenAI with restaurant context
                    initializeOpenAI(calledNumber, fromNumber, callId);
                    break;
                    
                case 'media':
                    // Forward audio to OpenAI
                    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                        const audioData = {
                            type: 'input_audio_buffer.append',
                            audio: data.media.payload
                        };
                        openaiWs.send(JSON.stringify(audioData));
                    }
                    break;
                    
                case 'stop':
                    console.log('🛑 Stream stopped');
                    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                        openaiWs.close();
                    }
                    break;
            }
        } catch (error) {
            console.error('❌ Error processing Twilio message:', error);
        }
    });
    
    ws.on('close', async () => {
        console.log('📞 Twilio connection closed');
        
        // Calculate call duration and update call log
        const callEndTime = new Date();
        const callDuration = Math.floor((callEndTime - callStartTime) / 1000); // in seconds
        
        // Process any orders from the conversation before closing
        console.log('🔍 Checking for orders before call ends...');
        await processCallEndOrder();
        
        if (callSid) {
            const updateData = {
                call_ended_at: callEndTime.toISOString(),
                call_duration: callDuration,
                conversation_transcript: JSON.stringify(conversationTranscript)
            };
            
            await updateCallLog(callSid, updateData);
            console.log(`📞 Call completed. Duration: ${callDuration} seconds`);
        }
        
        if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
            openaiWs.close();
        }
    });
    
    ws.on('error', (error) => {
        console.error('❌ Twilio WebSocket error:', error);
    });
});

wss.on('error', (error) => {
    console.error('❌ WebSocket Server error:', error);
});

server.listen(port, '0.0.0.0', () => {
    console.log(`🚀 Restaurant AI System running on port ${port}`);
    console.log(`🍽️ Ready to take orders via phone calls`);
    console.log(`📡 WebSocket ready for Twilio Media Streams`);
    console.log(`🤖 OpenAI configured: ${!!OPENAI_API_KEY}`);
    console.log(`🗄️ Supabase configured: ${!!(SUPABASE_URL && SUPABASE_ANON_KEY)}`);
});
)) {
                
                console.log('📝 Found potential order in transcript');
                
                const orderData = {
                    restaurant_id: restaurant.id,
                    customer_phone: customerPhone,
                    total_amount: extractTotal(transcript) || 0,
                    order_details: transcript,
                    special_instructions: '',
                    call_sid: callSid,
                    items: []
                };

                const order = await createOrder(orderData);
                if (order) {
                    console.log('🎉 Basic order saved successfully!');
                    
                    if (callSid) {
                        await updateCallLog(callSid, { order_id: order.id });
                    }
                    return order;
                }
            }
            
        } catch (error) {
            console.error('❌ Error processing order:', error);
        }
        return null;
    }

    // Parse structured order format
    function parseStructuredOrder(orderText) {
        try {
            const lines = orderText.split('\n').map(line => line.trim()).filter(line => line);
            
            const orderData = {
                customer_name: '',
                total_amount: 0,
                special_instructions: '',
                pickup_time: null,
                items: []
            };
            
            for (const line of lines) {
                if (line.includes('Customer Name:')) {
                    orderData.customer_name = line.split('Customer Name:')[1].trim();
                } else if (line.includes('Total:')) {
                    const totalMatch = line.match(/\$(\d+\.?\d*)/);
                    if (totalMatch) {
                        orderData.total_amount = parseFloat(totalMatch[1]);
                    }
                } else if (line.includes('Special Instructions:')) {
                    orderData.special_instructions = line.split('Special Instructions:')[1].trim();
                } else if (line.includes('Pickup Time:')) {
                    orderData.pickup_time = line.split('Pickup Time:')[1].trim();
                } else if (line.includes('Items:')) {
                    // Items are on the same line or following lines
                    const itemsText = line.split('Items:')[1].trim();
                    if (itemsText) {
                        // Simple parsing - you could make this more sophisticated
                        orderData.items = parseItems(itemsText);
                    }
                }
            }
            
            return orderData;
        } catch (error) {
            console.error('❌ Error parsing structured order:', error);
            return null;
        }
    }

    // Simple item parsing (can be enhanced)
    function parseItems(itemsText) {
        // This is a simple implementation - you could make it more sophisticated
        return [{
            menu_item_id: null, // Would need to match against menu
            quantity: 1,
            price: 0,
            special_requests: itemsText
        }];
    }

    // Extract total amount from transcript
    function extractTotal(text) {
        const totalMatch = text.match(/(?:total|amount).*?\$(\d+\.?\d*)/i);
        return totalMatch ? parseFloat(totalMatch[1]) : null;
    }

    // Function to manually process order at call end
    async function processCallEndOrder() {
        try {
            // Look through the entire conversation for order information
            const fullConversation = conversationTranscript.map(msg => 
                `${msg.speaker}: ${msg.text}`
            ).join('\n');
            
            console.log('🔍 Analyzing full conversation for orders...');
            
            // Check if any AI response contained order confirmation
            const aiResponses = conversationTranscript
                .filter(msg => msg.speaker === 'AI')
                .map(msg => msg.text);
            
            for (const response of aiResponses) {
                const order = await processOrderFromTranscript(response);
                if (order) {
                    console.log('✅ Order found and processed from conversation!');
                    return order;
                }
            }
            
            // Check if conversation contains order-like content
            if (fullConversation.toLowerCase().includes('pizza') || 
                fullConversation.toLowerCase().includes('order') ||
                fullConversation.toLowerCase().includes('
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            switch (data.event) {
                case 'connected':
                    console.log('📞 Twilio connected');
                    break;
                    
                case 'start':
                    streamSid = data.start.streamSid;
                    
                    // Debug: Log the entire start data to see what's available
                    console.log('📋 Start data:', JSON.stringify(data.start, null, 2));
                    
                    // Try multiple ways to get the phone numbers
                    const calledNumber = data.start.customParameters?.Called || 
                                       data.start.customParameters?.To ||
                                       data.start.callSid?.split('CA')[0]; // Extract from callSid if needed
                    
                    const fromNumber = data.start.customParameters?.From ||
                                      data.start.customParameters?.Caller;
                    
                    const callId = data.start.customParameters?.CallSid || data.start.callSid;
                    
                    console.log('🎙️ Stream started:', streamSid);
                    console.log('📞 Called number:', calledNumber);
                    console.log('📞 From number:', fromNumber);
                    console.log('📞 Call ID:', callId);
                    
                    // Initialize OpenAI with restaurant context
                    initializeOpenAI(calledNumber, fromNumber, callId);
                    break;
                    
                case 'media':
                    // Forward audio to OpenAI
                    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                        const audioData = {
                            type: 'input_audio_buffer.append',
                            audio: data.media.payload
                        };
                        openaiWs.send(JSON.stringify(audioData));
                    }
                    break;
                    
                case 'stop':
                    console.log('🛑 Stream stopped');
                    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                        openaiWs.close();
                    }
                    break;
            }
        } catch (error) {
            console.error('❌ Error processing Twilio message:', error);
        }
    });
    
    ws.on('close', async () => {
        console.log('📞 Twilio connection closed');
        
        // Calculate call duration and update call log
        const callEndTime = new Date();
        const callDuration = Math.floor((callEndTime - callStartTime) / 1000); // in seconds
        
        if (callSid) {
            const updateData = {
                call_ended_at: callEndTime.toISOString(),
                call_duration: callDuration,
                conversation_transcript: JSON.stringify(conversationTranscript)
            };
            
            await updateCallLog(callSid, updateData);
            console.log(`📞 Call completed. Duration: ${callDuration} seconds`);
        }
        
        if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
            openaiWs.close();
        }
    });
    
    ws.on('error', (error) => {
        console.error('❌ Twilio WebSocket error:', error);
    });
});

wss.on('error', (error) => {
    console.error('❌ WebSocket Server error:', error);
});

server.listen(port, '0.0.0.0', () => {
    console.log(`🚀 Restaurant AI System running on port ${port}`);
    console.log(`🍽️ Ready to take orders via phone calls`);
    console.log(`📡 WebSocket ready for Twilio Media Streams`);
    console.log(`🤖 OpenAI configured: ${!!OPENAI_API_KEY}`);
    console.log(`🗄️ Supabase configured: ${!!(SUPABASE_URL && SUPABASE_ANON_KEY)}`);
});
)) {
                
                console.log('📝 Potential order detected in conversation');
                
                const orderData = {
                    restaurant_id: restaurant.id,
                    customer_phone: customerPhone,
                    total_amount: 0,
                    order_details: fullConversation,
                    special_instructions: 'Order extracted from conversation',
                    call_sid: callSid,
                    items: []
                };

                const order = await createOrder(orderData);
                if (order) {
                    console.log('🎉 Conversation order saved!');
                    
                    if (callSid) {
                        await updateCallLog(callSid, { order_id: order.id });
                    }
                    return order;
                }
            }
            
        } catch (error) {
            console.error('❌ Error processing call end order:', error);
        }
        return null;
    }
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            switch (data.event) {
                case 'connected':
                    console.log('📞 Twilio connected');
                    break;
                    
                case 'start':
                    streamSid = data.start.streamSid;
                    
                    // Debug: Log the entire start data to see what's available
                    console.log('📋 Start data:', JSON.stringify(data.start, null, 2));
                    
                    // Try multiple ways to get the phone numbers
                    const calledNumber = data.start.customParameters?.Called || 
                                       data.start.customParameters?.To ||
                                       data.start.callSid?.split('CA')[0]; // Extract from callSid if needed
                    
                    const fromNumber = data.start.customParameters?.From ||
                                      data.start.customParameters?.Caller;
                    
                    const callId = data.start.customParameters?.CallSid || data.start.callSid;
                    
                    console.log('🎙️ Stream started:', streamSid);
                    console.log('📞 Called number:', calledNumber);
                    console.log('📞 From number:', fromNumber);
                    console.log('📞 Call ID:', callId);
                    
                    // Initialize OpenAI with restaurant context
                    initializeOpenAI(calledNumber, fromNumber, callId);
                    break;
                    
                case 'media':
                    // Forward audio to OpenAI
                    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                        const audioData = {
                            type: 'input_audio_buffer.append',
                            audio: data.media.payload
                        };
                        openaiWs.send(JSON.stringify(audioData));
                    }
                    break;
                    
                case 'stop':
                    console.log('🛑 Stream stopped');
                    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                        openaiWs.close();
                    }
                    break;
            }
        } catch (error) {
            console.error('❌ Error processing Twilio message:', error);
        }
    });
    
    ws.on('close', async () => {
        console.log('📞 Twilio connection closed');
        
        // Calculate call duration and update call log
        const callEndTime = new Date();
        const callDuration = Math.floor((callEndTime - callStartTime) / 1000); // in seconds
        
        if (callSid) {
            const updateData = {
                call_ended_at: callEndTime.toISOString(),
                call_duration: callDuration,
                conversation_transcript: JSON.stringify(conversationTranscript)
            };
            
            await updateCallLog(callSid, updateData);
            console.log(`📞 Call completed. Duration: ${callDuration} seconds`);
        }
        
        if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
            openaiWs.close();
        }
    });
    
    ws.on('error', (error) => {
        console.error('❌ Twilio WebSocket error:', error);
    });
});

wss.on('error', (error) => {
    console.error('❌ WebSocket Server error:', error);
});

server.listen(port, '0.0.0.0', () => {
    console.log(`🚀 Restaurant AI System running on port ${port}`);
    console.log(`🍽️ Ready to take orders via phone calls`);
    console.log(`📡 WebSocket ready for Twilio Media Streams`);
    console.log(`🤖 OpenAI configured: ${!!OPENAI_API_KEY}`);
    console.log(`🗄️ Supabase configured: ${!!(SUPABASE_URL && SUPABASE_ANON_KEY)}`);
});
