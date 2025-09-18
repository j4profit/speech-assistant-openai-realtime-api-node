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

// Function to search for recent orders by phone number (only pending orders)
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
            .eq('status', 'pending') // Only show pending orders
            .gte('created_at', cutoffDate.toISOString())
            .order('created_at', { ascending: false })
            .limit(3);

        if (error) {
            console.error('Error searching orders:', error);
            return [];
        }

        console.log(`Found ${data?.length || 0} pending orders for phone: ${phoneNumber}`);
        return data || [];
    } catch (error) {
        console.error('Error searching orders:', error);
        return [];
    }
}

// Function to cancel an existing order
async function cancelOrder(orderId, reason = 'Customer cancellation') {
    try {
        if (!orderId) {
            console.error('No order ID provided for cancellation');
            return null;
        }
        
        const { data, error } = await supabase
            .from('orders')
            .update({
                status: 'cancelled',
                special_instructions: reason,
                updated_at: new Date().toISOString()
            })
            .eq('id', orderId)
            .eq('status', 'pending') // Only allow cancelling pending orders
            .select()
            .single();

        if (error) {
            console.error('Error cancelling order:', error);
            return null;
        }

        console.log('Order cancelled successfully:', orderId);
        return data;
    } catch (error) {
        console.error('Error cancelling order:', error);
        return null;
    }
}

// Function to update an existing order with modifications
async function updateOrder(orderId, updateData) {
    try {
        if (!orderId) {
            console.error('No order ID provided for update');
            return null;
        }
        
        console.log(`Updating order ${orderId} with:`, updateData);
        
        // First, fetch the existing order to preserve and update its details
        const { data: existingOrder, error: fetchError } = await supabase
            .from('orders')
            .select(`
                *,
                order_items (
                    id,
                    quantity,
                    price,
                    special_requests,
                    menu_items (
                        id,
                        name,
                        description,
                        price
                    )
                )
            `)
            .eq('id', orderId)
            .single();

        if (fetchError || !existingOrder) {
            console.error('Error fetching existing order:', fetchError);
            return null;
        }

        console.log('Existing order found:', existingOrder);

        // Parse the modifications to understand what's being changed
        const modifications = updateData.modifications || '';
        const modLower = modifications.toLowerCase();
        
        // Build the complete updated order details
        let updatedOrderDetails = existingOrder.order_details || '';
        let newTotal = existingOrder.total_amount || 0;
        
        // If modifications include adding items, append to order details
        if (modLower.includes('add')) {
            // Extract what's being added from the modifications string
            const addedItems = modifications;
            
            // Parse existing order details to rebuild them
            const existingLines = updatedOrderDetails.split('\n');
            let customerInfo = [];
            let itemsSection = [];
            let otherInfo = [];
            let currentSection = 'info';
            
            for (const line of existingLines) {
                if (line.toLowerCase().includes('items:')) {
                    currentSection = 'items';
                    itemsSection.push(line);
                } else if (line.toLowerCase().includes('special instructions:') || 
                          line.toLowerCase().includes('pickup time:') ||
                          line.toLowerCase().includes('order taken via')) {
                    currentSection = 'other';
                    otherInfo.push(line);
                } else if (currentSection === 'info') {
                    customerInfo.push(line);
                } else if (currentSection === 'items') {
                    itemsSection.push(line);
                } else {
                    otherInfo.push(line);
                }
            }
            
            // Add the new items to the items section
            if (itemsSection.length === 0) {
                itemsSection.push('Items:');
            }
            itemsSection.push(`- ${addedItems}`);
            
            // If a new total was provided, use it; otherwise try to calculate
            if (updateData.new_total && updateData.new_total > 0) {
                newTotal = updateData.new_total;
            } else {
                // Add the price from modifications if we can extract it
                const priceMatch = modifications.match(/\$(\d+\.?\d*)/);
                if (priceMatch) {
                    const addedPrice = parseFloat(priceMatch[1]);
                    newTotal = (existingOrder.total_amount || 0) + addedPrice;
                }
            }
            
            // Rebuild the order details
            updatedOrderDetails = [
                ...customerInfo,
                ...itemsSection,
                ...otherInfo.filter(line => !line.toLowerCase().includes('special instructions:'))
            ].join('\n');
            
            // Add modification note to special instructions
            const modificationNote = `MODIFIED: ${modifications} (${new Date().toLocaleString()})`;
            if (!updatedOrderDetails.includes('Special Instructions:')) {
                updatedOrderDetails += `\nSpecial Instructions: ${modificationNote}`;
            } else {
                updatedOrderDetails = updatedOrderDetails.replace(
                    /Special Instructions:.*$/m,
                    `Special Instructions: ${modificationNote}`
                );
            }
            
        } else if (modLower.includes('change') || modLower.includes('replace')) {
            // For changes/replacements, update the items section
            updatedOrderDetails = updatedOrderDetails.replace(/Items:[\s\S]*?(?=\n[A-Z]|\n$)/m, 
                `Items:\n- ${modifications}`);
            
            // Use provided total for replacements
            if (updateData.new_total && updateData.new_total > 0) {
                newTotal = updateData.new_total;
            }
            
            // Add modification note
            const modificationNote = `MODIFIED: ${modifications} (${new Date().toLocaleString()})`;
            updatedOrderDetails = updatedOrderDetails.replace(
                /Special Instructions:.*$/m,
                `Special Instructions: ${modificationNote}`
            );
        } else {
            // For other modifications, append to special instructions
            const modificationNote = `MODIFIED: ${modifications} (${new Date().toLocaleString()})`;
            if (updatedOrderDetails.includes('Special Instructions:')) {
                updatedOrderDetails = updatedOrderDetails.replace(
                    /Special Instructions:.*$/m,
                    `Special Instructions: ${modificationNote}`
                );
            } else {
                updatedOrderDetails += `\nSpecial Instructions: ${modificationNote}`;
            }
            
            if (updateData.new_total && updateData.new_total > 0) {
                newTotal = updateData.new_total;
            }
        }
        
        console.log('Updated order details:', updatedOrderDetails);
        console.log('New total:', newTotal);
        
        // Update the order in the database
        const { data, error } = await supabase
            .from('orders')
            .update({
                order_details: updatedOrderDetails,
                special_instructions: `${modifications} - Modified at ${new Date().toLocaleString()}`,
                total_amount: newTotal,
                status: 'modified',
                updated_at: new Date().toISOString()
            })
            .eq('id', orderId)
            .in('status', ['pending', 'modified']) // Allow updating both pending and previously modified orders
            .select()
            .single();

        if (error) {
            console.error('Error updating order in database:', error);
            return null;
        }

        console.log('Order updated successfully in database:', orderId);
        console.log('Final updated order:', data);
        return data;
    } catch (error) {
        console.error('Error in updateOrder function:', error);
        return null;
    }
}

// Function to create customer message in database
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
                customer_name: orderData.customer_name,
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
    let orderProcessed = false; // Track if order was already processed
    let messageProcessed = false; // Track if message was already processed
    let recentOrders = []; // Store recent orders for reference
    let isModificationCall = false; // Track if this is a modification call

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

3. For NEW ORDERING (ONLY when customer wants to place a completely new order, NOT modify existing):
   - Help them browse the menu and answer questions about items
   - Take orders clearly - ask for quantities and any special requests
   - When you need their phone number, say: "For your order, I see you're calling from a number ending in ${customerPhone ? customerPhone.slice(-4) : 'XXXX'}. Is this the number you'd like me to use for your order?"
   - If they say yes, use ${customerPhone} as their phone number
   - If they say no, ask them to provide the correct phone number
   - Confirm orders back to the customer including prices and totals
   - Ask for customer name and pickup time
   - ONLY use ORDER_CONFIRMED format for NEW orders, NEVER for modifications

4. For CHANGING EXISTING ORDERS:
   TRIGGER PHRASES that indicate modification (ALWAYS search for orders when hearing these):
   - "fix my order", "fix my last order"
   - "change my order", "modify my order"
   - "add to my order", "add another"
   - "update my order", "adjust my order"
   - Any mention of existing/previous/last order
   
   CRITICAL WORKFLOW FOR MODIFICATIONS:
   Step 1: Use search_recent_orders immediately when modification is mentioned
   Step 2: After finding orders, you'll see format like:
     {
       "orders": [
         {
           "id": "12345678-abcd-efgh-ijkl-123456789012",
           "items": [...],
           "total": 25.99
         }
       ]
     }
   Step 3: Ask what changes they want
   Step 4: MUST use update_order with the EXACT order ID, changes, AND new total
   
   ABSOLUTE RULE: If search_recent_orders finds an order and customer wants to add/change items:
   - YOU MUST USE update_order function
   - NEVER NEVER NEVER use ORDER_CONFIRMED format
   - Extract the order ID AND calculate new total
   - Example: {"order_id": "12345678-abcd-efgh-ijkl-123456789012", "modifications": "Add 1 large pepperoni pizza ($18.99)", "new_total": 44.98}
   - After update_order succeeds, say something like "I've updated your existing order with [changes]. Your new total is $[amount]."
   
   IF NO ORDERS ARE FOUND:
   - Say: "I couldn't find any pending orders for your phone number."
   - Then say: "I can take a message for the restaurant staff about your order issue."
   - Explain: "I should let you know that the restaurant is fairly busy and they may not be able to get to this message until later today or possibly tomorrow."
   - Ask: "Would you like me to send them a message about what you need?"
   - If yes, take a detailed message using MESSAGE_CONFIRMED format

5. For CANCELLATIONS:
   - Use the cancel_order tool with the ACTUAL ORDER ID from search results
   - Example: {"order_id": "12345678-abcd-efgh-ijkl-123456789012", "reason": "Customer requested"}
   - Confirm "Your order has been successfully cancelled"
   - DO NOT use ORDER_CONFIRMED format for cancellations

6. For MESSAGES/INQUIRIES:
   - For complaints, compliments, or questions - offer to send a message to management
   - When taking a message, confirm their phone number the same way
   - Ask for their name and specific details about their inquiry
   - If it's about an order issue and no order is found, mention the restaurant is busy and may respond later or next day

CRITICAL TOOL USAGE RULES:
- search_recent_orders: Returns orders with format {"orders": [{"id": "uuid-here", "items": [...]}]}
- update_order: MUST include {"order_id": "exact-uuid-from-search", "modifications": "description", "new_total": number}
- cancel_order: MUST include {"order_id": "exact-uuid-from-search", "reason": "optional reason"}

ABSOLUTE RULES FOR ORDER MODIFICATIONS:
1. If customer mentions ANY existing order ("fix my order", "change my order", etc.) → ALWAYS search first
2. If search finds orders → MUST use update_order function, NEVER create new order
3. NEVER output ORDER_CONFIRMED when modifying existing orders
4. Only use ORDER_CONFIRMED for brand new orders when no existing order is involved

EXAMPLE MODIFICATION FLOW:
Customer: "Fix my last order"
You: [Call search_recent_orders]
System: {"orders": [{"id": "abc-123", "items": [], "total": 0}]}
Customer: "Add a large pizza"
You: [Call update_order with {"order_id": "abc-123", "modifications": "Add 1 large pepperoni pizza", "new_total": 18.99}]
You: "I've updated your existing order to include a large pepperoni pizza. Your total is now $18.99."

IMPORTANT MESSAGE FORMAT (for messages to restaurant):
MESSAGE_CONFIRMED:
- Customer Name: [name if provided]
- Phone: ${customerPhone || '[provided phone]'}
- Message Type: [order_inquiry/complaint/compliment/question/general]
- Subject: [brief subject]
- Message: [detailed customer message]
- Priority: [normal/high based on urgency]
MESSAGE_END

IMPORTANT ORDER FORMAT (ONLY for NEW orders, NEVER for modifications):
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
                            description: "Search for recent PENDING orders by the customer's phone number. Only returns orders with 'pending' status that can be modified or cancelled.",
                            parameters: {
                                type: "object",
                                properties: {
                                    phone_number: {
                                        type: "string",
                                        description: "Customer's phone number (defaults to caller's number if not provided)"
                                    }
                                },
                                required: []
                            }
                        },
                        {
                            type: "function", 
                            name: "cancel_order",
                            description: "Cancel a pending order completely. Use when customer wants to cancel their order. REQUIRES the actual order ID from the search results.",
                            parameters: {
                                type: "object",
                                properties: {
                                    order_id: {
                                        type: "string",
                                        description: "The actual order ID (UUID) from the search results - REQUIRED"
                                    },
                                    reason: {
                                        type: "string",
                                        description: "Reason for cancellation (optional)"
                                    }
                                },
                                required: ["order_id"]
                            }
                        },
                        {
                            type: "function", 
                            name: "update_order",
                            description: "Update an existing pending order with modifications. Use when customer wants to change items, quantities, or details. REQUIRES the actual order ID from the search results.",
                            parameters: {
                                type: "object",
                                properties: {
                                    order_id: {
                                        type: "string",
                                        description: "The actual order ID (UUID) from the search results - REQUIRED"
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
                        } else if (response.transcript.includes('ORDER_CONFIRMED:') && !isModificationCall) {
                            // Only process ORDER_CONFIRMED if this is NOT a modification call
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
            let parsedArgs = {};

            console.log(`Executing function: ${name}`);
            console.log('Raw function call object:', JSON.stringify(functionCall, null, 2));

            // Handle different argument formats
            if (!args || args === '') {
                console.log('No arguments provided, using defaults');
                parsedArgs = {};
            } else if (typeof args === 'string') {
                try {
                    parsedArgs = JSON.parse(args);
                } catch (e) {
                    console.error('Error parsing JSON arguments, using as string:', e);
                    parsedArgs = { raw: args };
                }
            } else {
                parsedArgs = args;
            }

            console.log('Parsed function arguments:', parsedArgs);

            switch (name) {
                case 'search_recent_orders':
                    // Use the customer's phone from the call context if not provided
                    const phoneNumber = parsedArgs.phone_number || customerPhone;
                    console.log('Searching PENDING orders for phone:', phoneNumber);
                    
                    if (!phoneNumber) {
                        result = { error: 'No phone number available to search orders' };
                        break;
                    }
                    
                    const orders = await searchRecentOrders(phoneNumber, restaurant.id);
                    recentOrders = orders; // Store for reference
                    
                    // If orders found, automatically mark as modification call
                    if (orders.length > 0) {
                        // Check recent customer messages for modification intent
                        const recentCustomerText = conversationTranscript
                            .filter(m => m.speaker === 'Customer')
                            .slice(-5)
                            .map(m => m.text)
                            .join(' ')
                            .toLowerCase();
                        
                        // Expanded list of modification triggers
                        const modificationTriggers = [
                            'fix', 'change', 'modify', 'update', 'adjust',
                            'add to', 'add another', 'correct', 'edit',
                            'cancel', 'remove', 'delete', 'alter'
                        ];
                        
                        const hasModificationIntent = modificationTriggers.some(trigger => 
                            recentCustomerText.includes(trigger)
                        );
                        
                        if (hasModificationIntent) {
                            isModificationCall = true;
                            console.log('MODIFICATION CALL DETECTED - Found orders + modification intent');
                        }
                    }
                    
                    result = {
                        orders: orders.map(order => ({
                            id: order.id,
                            created_at: new Date(order.created_at).toLocaleDateString(),
                            status: order.status,
                            total: order.total_amount,
                            items: order.order_items?.map(item => ({
                                name: item.menu_items?.name || 'Item',
                                quantity: item.quantity,
                                price: item.price,
                                special_requests: item.special_requests
                            })) || [],
                            customer_name: order.customer_name,
                            order_details: order.order_details
                        })),
                        count: orders.length,
                        phone_searched: phoneNumber,
                        message: orders.length === 0 
                            ? 'No pending orders found. I can take a message for the restaurant about your order issue. Please note the restaurant is fairly busy and may not respond until later today or tomorrow.' 
                            : `Found ${orders.length} pending order(s). Please tell me what changes you'd like to make.`,
                        modification_required: orders.length > 0 ? true : false,
                        instruction: orders.length > 0 
                            ? `IMPORTANT: Customer wants to modify this order. You MUST use update_order function with order_id "${orders[0].id}" for any changes. DO NOT create a new order.`
                            : null
                    };
                    console.log(`Found ${orders.length} pending orders for ${phoneNumber}`);
                    break;

                case 'cancel_order':
                    isModificationCall = true; // Mark as modification to prevent new order creation
                    let cancelOrderId = parsedArgs.order_id;
                    const cancelReason = parsedArgs.reason || 'Customer requested cancellation';
                    
                    // If no order ID provided but we have recent orders from search, use the first one
                    if (!cancelOrderId && recentOrders && recentOrders.length > 0) {
                        console.log('WARNING: No order ID provided, attempting to use most recent order from search');
                        cancelOrderId = recentOrders[0].id;
                        
                        // Send a warning message back to AI
                        result = {
                            warning: 'No order ID was provided. Using the most recent order from search results.',
                            retry_instruction: 'Please always extract and pass the order ID from search results when calling cancel_order.'
                        };
                    }
                    
                    if (!cancelOrderId) {
                        result = { 
                            error: 'No order ID provided and no recent orders found. You must first use search_recent_orders, then extract the order ID from the results.',
                            instruction: 'Call search_recent_orders first, then use the "id" field from the results when calling cancel_order.',
                            example: 'If search returns {"orders": [{"id": "abc123"}]}, call cancel_order with {"order_id": "abc123"}'
                        };
                        console.error('Cancel order called without order ID and no recent orders available');
                        break;
                    }
                    
                    console.log(`Attempting to cancel order: ${cancelOrderId}`);
                    const cancelResult = await cancelOrder(cancelOrderId, cancelReason);
                    
                    result = {
                        success: !!cancelResult,
                        message: cancelResult ? 'Order cancelled successfully' : 'Failed to cancel order - order may not be pending or may not exist',
                        order_id: cancelOrderId,
                        status: cancelResult ? 'cancelled' : 'failed'
                    };
                    console.log(`Order cancellation result for ${cancelOrderId}:`, result.success);
                    break;

                case 'update_order':
                    isModificationCall = true; // Mark as modification to prevent new order creation
                    let orderId = parsedArgs.order_id;
                    let modifications = parsedArgs.modifications || 'Order modification requested';
                    let newTotal = parsedArgs.new_total || 0;
                    
                    // If no order ID provided but we have recent orders from search, use the first one
                    if (!orderId && recentOrders && recentOrders.length > 0) {
                        console.log('WARNING: No order ID provided, attempting to use most recent order from search');
                        orderId = recentOrders[0].id;
                        
                        // Send a warning message back to AI
                        result = {
                            warning: 'No order ID was provided. Using the most recent order from search results.',
                            retry_instruction: 'Please always extract and pass the order ID from search results when calling update_order.',
                            attempting_with_id: orderId
                        };
                        
                        // Still attempt the update with the found ID
                        if (orderId) {
                            // Build complete update data
                            const updateData = {
                                modifications: modifications,
                                new_total: newTotal,
                                restaurant_menu: restaurant.menu_items // Pass menu for price lookups
                            };
                            
                            const updateResult = await updateOrder(orderId, updateData);
                            
                            if (updateResult) {
                                // Mark the update as successful in our tracking
                                console.log('ORDER MODIFICATION SUCCESSFUL - Database updated');
                            }
                            
                            result = {
                                ...result,
                                success: !!updateResult,
                                message: updateResult 
                                    ? `Order modified successfully. ${modifications}. New total: ${updateResult.total_amount}` 
                                    : 'Failed to modify order',
                                order_id: orderId,
                                modifications: modifications,
                                new_total: updateResult ? updateResult.total_amount : newTotal,
                                status: updateResult ? 'modified' : 'failed',
                                database_updated: !!updateResult
                            };
                            console.log(`Order modification result for ${orderId}:`, result.success);
                            break;
                        }
                    }
                    
                    if (!orderId) {
                        result = { 
                            error: 'No order ID provided and no recent orders found. You must first use search_recent_orders, then extract the order ID from the results.',
                            instruction: 'Call search_recent_orders first, then use the "id" field from the results when calling update_order.',
                            example: 'If search returns {"orders": [{"id": "abc123"}]}, call update_order with {"order_id": "abc123", "modifications": "changes", "new_total": 25.99}'
                        };
                        console.error('Update order called without order ID and no recent orders available');
                        break;
                    }
                    
                    console.log(`Attempting to update order: ${orderId}`);
                    console.log(`Modifications requested: ${modifications}`);
                    console.log(`New total provided: ${newTotal}`);
                    
                    // Build complete update data
                    const updateData = {
                        modifications: modifications,
                        new_total: newTotal,
                        restaurant_menu: restaurant.menu_items // Pass menu for price lookups
                    };
                    
                    const updateResult = await updateOrder(orderId, updateData);
                    
                    if (updateResult) {
                        // Mark the update as successful in our tracking
                        console.log('ORDER MODIFICATION SUCCESSFUL - Database updated');
                    }
                    
                    result = {
                        success: !!updateResult,
                        message: updateResult 
                            ? `Order modified successfully. ${modifications}. New total: ${updateResult.total_amount}` 
                            : 'Failed to modify order - order may not be pending or may not exist',
                        order_id: orderId,
                        modifications: modifications,
                        new_total: updateResult ? updateResult.total_amount : newTotal,
                        status: updateResult ? 'modified' : 'failed',
                        database_updated: !!updateResult
                    };
                    console.log(`Order modification result for ${orderId}:`, result.success);
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
                
                // Add a small delay before triggering response to avoid race conditions
                setTimeout(() => {
                    // Trigger response generation
                    const responseMessage = {
                        type: 'response.create'
                    };
                    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                        openaiWs.send(JSON.stringify(responseMessage));
                    }
                }, 100);
            }

        } catch (error) {
            console.error('Error handling function call:', error);
            
            // Send error response back to OpenAI
            const errorResponse = {
                type: 'conversation.item.create',
                item: {
                    type: 'function_call_output',
                    call_id: functionCall.call_id || 'unknown',
                    output: JSON.stringify({ error: error.message })
                }
            };

            if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                openaiWs.send(JSON.stringify(errorResponse));
            }
        }
    }

    // Process message from AI transcript
    async function processMessageFromTranscript(transcript) {
        try {
            if (messageProcessed) {
                console.log('Message already processed, skipping duplicate');
                return;
            }
            
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
                messageProcessed = true; // Mark message as processed
                
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
            // CRITICAL CHECK: Don't create orders during modification calls
            if (isModificationCall) {
                console.log('BLOCKING ORDER CREATION - This is a modification call, not a new order');
                return;
            }
            
            // Check entire conversation for modification context
            const fullConversation = conversationTranscript.map(msg => msg.text).join(' ').toLowerCase();
            const hasModificationContext = 
                fullConversation.includes('fix my') ||
                fullConversation.includes('change my order') || 
                fullConversation.includes('modify my order') || 
                fullConversation.includes('update my order') ||
                fullConversation.includes('add another') ||
                fullConversation.includes('add to my order') ||
                fullConversation.includes('cancel my order') ||
                fullConversation.includes('found a pending order') ||
                fullConversation.includes('found 1 pending order') ||
                fullConversation.includes('your existing order');
            
            if (hasModificationContext) {
                console.log('BLOCKING ORDER CREATION - Modification context detected in conversation');
                return;
            }
            
            // Also check if search_recent_orders was used and found orders
            if (recentOrders && recentOrders.length > 0) {
                console.log('BLOCKING ORDER CREATION - Recent orders exist from search, should be modifying instead');
                return;
            }
            
            if (orderProcessed) {
                console.log('Order already processed, skipping duplicate');
                return;
            }
            
            console.log('Processing NEW order from transcript...');
            
            if (transcript.includes('ORDER_CONFIRMED:') && transcript.includes('ORDER_END')) {
                // IMMEDIATELY mark as processed to prevent race conditions
                orderProcessed = true;
                console.log('Order processing started, flag set to prevent duplicates');
                
                const orderSection = transcript.substring(
                    transcript.indexOf('ORDER_CONFIRMED:') + 'ORDER_CONFIRMED:'.length,
                    transcript.indexOf('ORDER_END')
                ).trim();
                
                console.log('Found structured order:', orderSection);
                
                // Extract all order details from the structured format
                let customerName = '';
                let items = '';
                let specialInstructions = '';
                let pickupTime = '';
                
                const lines = orderSection.split('\n').map(line => line.trim());
                
                for (const line of lines) {
                    if (line.startsWith('Customer Name:')) {
                        customerName = line.substring('Customer Name:'.length).trim();
                    } else if (line.startsWith('Items:')) {
                        items = line.substring('Items:'.length).trim();
                    } else if (line.startsWith('Special Instructions:')) {
                        specialInstructions = line.substring('Special Instructions:'.length).trim();
                    } else if (line.startsWith('Pickup Time:')) {
                        pickupTime = line.substring('Pickup Time:'.length).trim();
                    }
                }
                
                // Build comprehensive order details
                const formattedOrderDetails = `Customer: ${customerName || 'Not provided'}
Phone: ${customerPhone}
Items: ${items || 'No items specified'}
Special Instructions: ${specialInstructions || 'None'}
Pickup Time: ${pickupTime || 'ASAP'}
Order taken via AI phone system`;
                
                const orderData = {
                    restaurant_id: restaurant.id,
                    customer_phone: customerPhone,
                    customer_name: customerName || null,
                    total_amount: extractTotal(orderSection) || 0,
                    order_details: formattedOrderDetails,
                    special_instructions: specialInstructions || pickupTime || '',
                    call_sid: callSid,
                    items: []
                };

                const order = await createOrder(orderData);
                if (order) {
                    console.log('NEW order saved successfully with ID:', order.id);
                    
                    if (callSid) {
                        await updateCallLog(callSid, { order_id: order.id });
                    }
                } else {
                    // If order creation failed, reset the flag
                    orderProcessed = false;
                    console.log('Order creation failed, resetting flag');
                }
            }
        } catch (error) {
            console.error('Error processing order:', error);
            orderProcessed = false; // Reset on error
        }
    }

    // Extract total amount from text
    function extractTotal(text) {
        try {
            // Look for Total: $XX.XX pattern
            const totalMatch = text.match(/Total:\s*\$(\d+\.?\d*)/);
            if (totalMatch) {
                return parseFloat(totalMatch[1]);
            }
            
            // Look for any dollar amounts in the text
            const dollarPattern = /\$(\d+\.?\d*)/g;
            const matches = text.match(dollarPattern);
            
            if (matches && matches.length > 0) {
                let sum = 0;
                for (let i = 0; i < matches.length; i++) {
                    // Remove dollar sign and parse
                    const amount = matches[i].substring(1);
                    sum += parseFloat(amount);
                }
                return sum;
            }
            
            return 0;
        } catch (err) {
            console.error('Error in extractTotal:', err);
            return 0;
        }
    }

    // Process call end - COMPLETELY REVISED TO PREVENT DUPLICATES
    async function processCallEnd() {
        try {
            console.log('=== CALL END PROCESSING START ===');
            console.log('Order already processed:', orderProcessed);
            console.log('Message already processed:', messageProcessed);
            console.log('Was modification call:', isModificationCall);
            
            // Always update call log with conversation transcript
            if (callSid) {
                const transcript = JSON.stringify(conversationTranscript);
                await updateCallLog(callSid, { 
                    conversation_transcript: transcript
                });
                console.log('Call log updated with conversation transcript');
            }
            
            // NEVER create fallback orders - all orders should be explicitly confirmed
            console.log('=== CALL END PROCESSING COMPLETE - No fallback orders created ===');
            
        } catch (error) {
            console.error('Error in processCallEnd:', error);
        }
        return null;
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
        
        await processCallEnd();
        
        if (callSid) {
            const updateData = {
                call_ended_at: callEndTime.toISOString(),
                call_duration: callDuration
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
