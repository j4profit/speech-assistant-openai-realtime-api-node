// Restaurant AI Ordering System with Customer Messaging
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
    console.error('Missing required environment variables');
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
    console.log('Incoming call webhook:', req.body);
    
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

app.get('/', (req, res) => {
    res.json({ 
        message: 'Restaurant AI Ordering and Messaging System',
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

// API endpoint to get customer messages
app.get('/messages', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('customer_messages')
            .select(`
                *,
                restaurants(name)
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

// API endpoint to get messages by status
app.get('/messages/:status', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('customer_messages')
            .select(`
                *,
                restaurants(name)
            `)
            .eq('status', req.params.status)
            .order('created_at', { ascending: false });

        if (error) {
            return res.status(500).json({ error: error.message });
        }

        res.json({ messages: data });
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
            console.error('Error fetching restaurant:', error);
            return null;
        }

        return data;
    } catch (error) {
        console.error('Database error:', error);
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
            console.error('Error creating call log:', error);
            return null;
        }

        console.log('Call log created:', data.id);
        return data;
    } catch (error) {
        console.error('Error creating call log:', error);
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
            console.error('Error updating call log:', error);
            return null;
        }

        console.log('Call log updated for:', callSid);
        return data;
    } catch (error) {
        console.error('Error updating call log:', error);
        return null;
    }
}

// Function to search for recent orders by phone number
async function searchRecentOrders(phoneNumber, restaurantId, daysBack = 7) {
    try {
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - daysBack);
        
        const { data, error } = await supabase
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
                order_items (
                    id,
                    quantity,
                    price,
                    special_requests,
                    menu_items (name, description, price)
                )
            `)
            .eq('customer_phone', phoneNumber)
            .eq('restaurant_id', restaurantId)
            .gte('created_at', cutoffDate.toISOString())
            .in('status', ['pending', 'confirmed', 'preparing'])
            .order('created_at', { ascending: false })
            .limit(5);

        if (error) {
            console.error('Error searching orders:', error);
            return [];
        }

        return data || [];
    } catch (error) {
        console.error('Error searching orders:', error);
        return [];
    }
}

// Function to update an existing order
async function updateOrder(orderId, updateData) {
    try {
        const { data, error } = await supabase
            .from('orders')
            .update({
                order_details: updateData.order_details,
                special_instructions: updateData.special_instructions,
                total_amount: updateData.total_amount,
                status: 'modified',
                updated_at: new Date().toISOString()
            })
            .eq('id', orderId)
            .select()
            .single();

        if (error) {
            console.error('Error updating order:', error);
            return null;
        }

        console.log('Order updated successfully:', orderId);
        return data;
    } catch (error) {
        console.error('Error updating order:', error);
        return null;
    }
}
async function createCustomerMessage(messageData) {
    try {
        const { data, error } = await supabase
            .from('customer_messages')
            .insert([{
                restaurant_id: messageData.restaurant_id,
                customer_phone: messageData.customer_phone,
                customer_name: messageData.customer_name,
                message_type: messageData.message_type,
                subject: messageData.subject,
                message_content: messageData.message_content,
                call_sid: messageData.call_sid,
                order_reference: messageData.order_reference,
                priority: messageData.priority || 'normal'
            }])
            .select()
            .single();

        if (error) {
            console.error('Error creating customer message:', error);
            return null;
        }

        console.log('Customer message created:', data.id);
        return data;
    } catch (error) {
        console.error('Error creating customer message:', error);
        return null;
    }
}

// Function to create order in database
async function createOrder(orderData) {
    try {
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
            console.error('Error creating order:', orderError);
            return null;
        }

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
                console.error('Error creating order items:', itemsError);
            }
        }

        console.log('Order created successfully:', order.id);
        return order;
    } catch (error) {
        console.error('Error creating order:', error);
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
    console.log('New WebSocket connection');
    
    let openaiWs = null;
    let streamSid = null;
    let callSid = null;
    let customerPhone = null;
    let restaurant = null;
    let callStartTime = new Date();
    let conversationTranscript = [];

    // Initialize OpenAI connection with restaurant context
    async function initializeOpenAI(calledNumber, fromNumber, callId) {
        console.log('Loading restaurant data for:', calledNumber);
        
        const phoneToLookup = calledNumber || '+14108880091';
        console.log('Using phone number for lookup:', phoneToLookup);
        
        restaurant = await getRestaurantByPhone(phoneToLookup);
        
        if (!restaurant) {
            console.error('Restaurant not found for phone:', phoneToLookup);
            return;
        }

        console.log('Restaurant loaded:', restaurant.name);
        customerPhone = fromNumber;
        callSid = callId;

        const menuText = formatMenuForAI(restaurant.menu_items);
        
        console.log('Connecting to OpenAI Realtime API with GPT-4o mini...');
        
        openaiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-mini-realtime-preview-2024-12-17', {
            headers: {
                'Authorization': `Bearer ${OPENAI_API_KEY}`,
                'OpenAI-Beta': 'realtime=v1'
            }
        });
        
        openaiWs.on('open', () => {
            console.log('Connected to OpenAI Realtime API with GPT-4o mini');
            
            const instructions = `You are an AI assistant for ${restaurant.name}. 

IMPORTANT: As soon as the session starts, immediately greet the caller with: "Hello! Thank you for calling ${restaurant.name}. How can I help you today?"

CALLER INFORMATION:
- Caller's phone number: ${customerPhone}
- Last 4 digits of caller's number: ${customerPhone ? customerPhone.slice(-4) : 'unknown'}

RESTAURANT INFORMATION:
- Name: ${restaurant.name}
- Description: ${restaurant.description || ''}
- Hours: ${restaurant.hours || 'Call for hours'}
- Location: ${restaurant.address || ''}

${menuText}

INSTRUCTIONS:
1. Start EVERY call with the greeting above mentioning the restaurant name
2. Help customers with THREE main things:
   a) PLACING NEW ORDERS - Take orders clearly with quantities and special requests
   b) CHANGING EXISTING ORDERS - Use the search_recent_orders tool to find and modify orders
   c) SENDING MESSAGES - For complaints, compliments, or general inquiries

3. For NEW ORDERING:
   - Help them browse the menu and answer questions about items
   - Take orders clearly - ask for quantities and any special requests
   - When you need their phone number, say: "For your order, I see you're calling from a number ending in ${customerPhone ? customerPhone.slice(-4) : 'XXXX'}. Is this the number you'd like me to use for your order?"
   - If they say yes, use ${customerPhone} as their phone number
   - If they say no, ask them to provide the correct phone number
   - Confirm orders back to the customer including prices and totals
   - Ask for customer name and pickup time

4. For CHANGING EXISTING ORDERS:
   - If customer says they want to "change my order", "modify my order", "cancel my order", or mentions a recent order they placed, immediately use the search_recent_orders tool with their phone number: ${customerPhone}
   - Once you find their recent orders, read back the details and ask what they'd like to change
   - Use the update_order tool to make the changes they request
   - Confirm the changes and new total if applicable
   - Let them know their order has been successfully updated

5. For MESSAGES/INQUIRIES:
   - For complaints, compliments, or questions - offer to send a message to management
   - When taking a message, confirm their phone number the same way: "I'll send this message and have someone follow up with you at the number ending in ${customerPhone ? customerPhone.slice(-4) : 'XXXX'}. Is that correct?"
   - Ask for their name and specific details about their inquiry
   - Reassure them that staff will review their message and follow up if needed

6. Be helpful, friendly, and efficient
7. If asked about items not on the menu, politely explain they're not available

TOOL USAGE:
- Use search_recent_orders whenever customer mentions wanting to change, modify, cancel, or asks about their recent order
- Use update_order after confirming what changes they want to make to an existing order

IMPORTANT MESSAGE FORMAT:
When taking a message (not an order), format it like this:
MESSAGE_CONFIRMED:
- Customer Name: [name if provided]
- Phone: ${customerPhone || '[provided phone]'}
- Message Type: [order_inquiry/complaint/compliment/question/general]
- Subject: [brief subject]
- Message: [detailed customer message]
- Priority: [normal/high based on urgency]
MESSAGE_END

IMPORTANT ORDER FORMAT:
When an order is confirmed, format it like this:
ORDER_CONFIRMED:
- Customer Name: [name if provided]
- Phone: ${customerPhone || '[provided phone]'}
- Items: [list each item with quantity and price]
- Special Instructions: [any special requests]
- Total: $[total amount]
- Pickup Time: [if specified]
ORDER_END

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
                    },
                    tools: [
                        {
                            type: "function",
                            name: "search_recent_orders",
                            description: "Search for recent orders by the customer's phone number. Use this when customer mentions wanting to change, modify, or asks about their recent order.",
                            parameters: {
                                type: "object",
                                properties: {
                                    phone_number: {
                                        type: "string",
                                        description: "Customer's phone number"
                                    }
                                },
                                required: ["phone_number"]
                            }
                        },
                        {
                            type: "function", 
                            name: "update_order",
                            description: "Update an existing order with modifications. Use after finding an order the customer wants to change.",
                            parameters: {
                                type: "object",
                                properties: {
                                    order_id: {
                                        type: "string",
                                        description: "ID of the order to update"
                                    },
                                    modifications: {
                                        type: "string",
                                        description: "Description of what changes the customer wants to make"
                                    },
                                    new_total: {
                                        type: "number",
                                        description: "New total amount if calculable"
                                    }
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
                        console.log('AI said:', response.transcript);
                        
                        conversationTranscript.push({
                            timestamp: new Date().toISOString(),
                            speaker: 'AI',
                            text: response.transcript
                        });
                        
                        // Check for message or order confirmation
                        if (response.transcript.includes('MESSAGE_CONFIRMED:')) {
                            processMessageFromTranscript(response.transcript);
                        } else if (response.transcript.includes('ORDER_CONFIRMED:')) {
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
                        
                    case 'response.function_call_delta':
                        // Handle function call deltas if needed
                        break;
                        
                    case 'response.function_call_done':
                        console.log('Function call completed:', response.name);
                        handleFunctionCall(response);
                        break;
                        
                    case 'error':
                        console.error('OpenAI error:', response.error);
                        break;
                        console.error('OpenAI error:', response.error);
                        break;
                        
                    case 'session.updated':
                        console.log('OpenAI session configured for', restaurant.name);
                        
                        const greetingMessage = {
                            type: 'response.create',
                            response: {
                                modalities: ['audio', 'text'],
                                instructions: `Immediately say: "Hello! Thank you for calling ${restaurant.name}. How can I help you today?"`
                            }
                        };
                        openaiWs.send(JSON.stringify(greetingMessage));
                        console.log('Sending immediate greeting...');
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

            console.log(`Executing function: ${name} with args:`, args);

            switch (name) {
                case 'search_recent_orders':
                    const orders = await searchRecentOrders(args.phone_number, restaurant.id);
                    result = {
                        orders: orders.map(order => ({
                            id: order.id,
                            created_at: order.created_at,
                            status: order.status,
                            total: order.total_amount,
                            items: order.order_items?.map(item => ({
                                name: item.menu_items?.name || 'Item',
                                quantity: item.quantity,
                                price: item.price,
                                special_requests: item.special_requests
                            })) || [],
                            customer_name: order.customer_name
                        })),
                        count: orders.length
                    };
                    console.log(`Found ${orders.length} recent orders for customer`);
                    break;

                case 'update_order':
                    const updateResult = await updateOrder(args.order_id, {
                        order_details: args.modifications,
                        special_instructions: args.modifications,
                        total_amount: args.new_total || 0
                    });
                    result = {
                        success: !!updateResult,
                        message: updateResult ? 'Order updated successfully' : 'Failed to update order',
                        order_id: args.order_id
                    };
                    console.log(`Order update result for ${args.order_id}:`, result.success);
                    break;

                default:
                    result = { error: `Unknown function: ${name}` };
            }

            // Send the function result back to OpenAI
            const functionResponse = {
                type: 'conversation.item.create',
                item: {
                    type: 'function_call_output',
                    call_id: call_id,
                    output: JSON.stringify(result)
                }
            };

            if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                openaiWs.send(JSON.stringify(functionResponse));
                console.log('Function result sent back to OpenAI');
            }

        } catch (error) {
            console.error('Error handling function call:', error);
            
            // Send error response back to OpenAI
            const errorResponse = {
                type: 'conversation.item.create',
                item: {
                    type: 'function_call_output',
                    call_id: functionCall.call_id,
                    output: JSON.stringify({ error: error.message })
                }
            };

            if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                openaiWs.send(JSON.stringify(errorResponse));
            }
        }
    }
    async function processMessageFromTranscript(transcript) {
        try {
            console.log('Processing customer message from transcript...');
            
            const messageSection = transcript.substring(
                transcript.indexOf('MESSAGE_CONFIRMED:') + 'MESSAGE_CONFIRMED:'.length,
                transcript.indexOf('MESSAGE_END')
            ).trim();
            
            console.log('Found customer message:', messageSection);
            
            // Parse the message data
            const messageData = parseMessageData(messageSection);
            messageData.restaurant_id = restaurant.id;
            messageData.customer_phone = customerPhone;
            messageData.call_sid = callSid;
            
            const message = await createCustomerMessage(messageData);
            if (message) {
                console.log('Customer message saved successfully!');
                
                if (callSid) {
                    await updateCallLog(callSid, { 
                        conversation_transcript: JSON.stringify(conversationTranscript)
                    });
                }
            }
        } catch (error) {
            console.error('Error processing customer message:', error);
        }
    }

    // Parse message data from transcript
    function parseMessageData(messageText) {
        const lines = messageText.split('\n').map(line => line.trim()).filter(line => line);
        
        const messageData = {
            customer_name: '',
            message_type: 'general',
            subject: '',
            message_content: '',
            priority: 'normal'
        };
        
        for (const line of lines) {
            if (line.includes('Customer Name:')) {
                messageData.customer_name = line.split('Customer Name:')[1].trim();
            } else if (line.includes('Message Type:')) {
                messageData.message_type = line.split('Message Type:')[1].trim();
            } else if (line.includes('Subject:')) {
                messageData.subject = line.split('Subject:')[1].trim();
            } else if (line.includes('Message:')) {
                messageData.message_content = line.split('Message:')[1].trim();
            } else if (line.includes('Priority:')) {
                messageData.priority = line.split('Priority:')[1].trim();
            }
        }
        
        return messageData;
    }

    // Process order from AI transcript
    async function processOrderFromTranscript(transcript) {
        try {
            console.log('Processing order from transcript...');
            
            if (transcript.includes('ORDER_CONFIRMED:') && transcript.includes('ORDER_END')) {
                const orderSection = transcript.substring(
                    transcript.indexOf('ORDER_CONFIRMED:') + 'ORDER_CONFIRMED:'.length,
                    transcript.indexOf('ORDER_END')
                ).trim();
                
                console.log('Found structured order:', orderSection);
                
                const orderData = {
                    restaurant_id: restaurant.id,
                    customer_phone: customerPhone,
                    total_amount: extractTotal(orderSection) || 0,
                    order_details: transcript,
                    special_instructions: '',
                    call_sid: callSid,
                    items: []
                };

                const order = await createOrder(orderData);
                if (order) {
                    console.log('Order saved successfully!');
                    
                    if (callSid) {
                        await updateCallLog(callSid, { order_id: order.id });
                    }
                }
            }
        } catch (error) {
            console.error('Error processing order:', error);
        }
    }

    // Extract total amount from text
    function extractTotal(text) {
        const totalMatch = text.match(/\$(\d+\.?\d*)/);
        return totalMatch ? parseFloat(totalMatch[1]) : null;
    }

    // Process call end
    async function processCallEnd() {
        try {
            const fullConversation = conversationTranscript.map(msg => 
                `${msg.speaker}: ${msg.text}`
            ).join('\n');
            
            console.log('Analyzing conversation for missed orders or messages...');
            
            // Check for potential orders or messages that weren't structured
            if (fullConversation.toLowerCase().includes('pizza') || 
                fullConversation.toLowerCase().includes('order') ||
                fullConversation.includes('$')) {
                
                console.log('Potential order detected in conversation');
                
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
                    console.log('Conversation order saved!');
                    
                    if (callSid) {
                        await updateCallLog(callSid, { order_id: order.id });
                    }
                    return order;
                }
            }
            
        } catch (error) {
            console.error('Error processing call end:', error);
        }
        return null;
    }
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            switch (data.event) {
                case 'connected':
                    console.log('Twilio connected');
                    break;
                    
                case 'start':
                    streamSid = data.start.streamSid;
                    
                    const calledNumber = data.start.customParameters?.Called || 
                                       data.start.customParameters?.To;
                    
                    const fromNumber = data.start.customParameters?.From ||
                                      data.start.customParameters?.Caller;
                    
                    const callId = data.start.customParameters?.CallSid || data.start.callSid;
                    
                    console.log('Stream started:', streamSid);
                    console.log('Called number:', calledNumber);
                    console.log('From number:', fromNumber);
                    console.log('Call ID:', callId);
                    
                    initializeOpenAI(calledNumber, fromNumber, callId);
                    break;
                    
                case 'media':
                    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                        const audioData = {
                            type: 'input_audio_buffer.append',
                            audio: data.media.payload
                        };
                        openaiWs.send(JSON.stringify(audioData));
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
        
        console.log('Processing call end...');
        await processCallEnd();
        
        if (callSid) {
            const updateData = {
                call_ended_at: callEndTime.toISOString(),
                call_duration: callDuration,
                conversation_transcript: JSON.stringify(conversationTranscript)
            };
            
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

wss.on('error', (error) => {
    console.error('WebSocket Server error:', error);
});

server.listen(port, '0.0.0.0', () => {
    console.log(`Restaurant AI System running on port ${port}`);
    console.log(`Ready to take orders and messages via phone calls`);
    console.log(`WebSocket ready for Twilio Media Streams`);
    console.log(`OpenAI configured: ${!!OPENAI_API_KEY}`);
    console.log(`Supabase configured: ${!!(SUPABASE_URL && SUPABASE_ANON_KEY)}`);
});
