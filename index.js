// Restaurant AI Ordering System with Fixed Delivery Address Validation - COMPLETE VERSION
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
    // Enhanced function call handler with delivery controls
    async function handleFunctionCall(functionCall) {
        try {
            const { name, call_id, arguments: args } = functionCall;
            let result = null;
            let parsedArgs = {};

            console.log(`Executing function: ${name}`);
            console.log('Raw function call object:', JSON.stringify(functionCall, null, 2));

            if (!args || args === '') {
                console.log('No arguments provided, using defaults');
                parsedArgs = {};
            // Process message from AI transcript
    async function processMessageFromTranscript(transcript) {
        try {
            if (messageProcessed) {
                console.log('Message already processed, skipping duplicate');
                return;
            }
            
            console.log('Processing customer message from transcript...');
            console.log('Full transcript:', transcript);
            
            if (!transcript.includes('MESSAGE_CONFIRMED')) {
                console.log('MESSAGE_CONFIRMED not found in transcript');
                return;
            }
            
            if (!transcript.includes('MESSAGE_END')) {
                console.log('MESSAGE_END not found in transcript - message may be incomplete');
                return;
            }
            
            let messageSection = '';
            
            let startIdx = transcript.indexOf('MESSAGE_CONFIRMED:');
            if (startIdx === -1) {
                startIdx = transcript.indexOf('MESSAGE_CONFIRMED');
                if (startIdx !== -1) {
                    startIdx += 'MESSAGE_CONFIRMED'.length;
                }
            } else {
                startIdx += 'MESSAGE_CONFIRMED:'.length;
            }
            
            const endIdx = transcript.indexOf('MESSAGE_END');
            
            if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
                messageSection = transcript.substring(startIdx, endIdx).trim();
                console.log('Extracted message section:', messageSection);
            } else {
                console.log('Could not extract valid message section');
                console.log('Start index:', startIdx, 'End index:', endIdx);
                return;
            }
            
            const messageData = parseMessageData(messageSection);
            
            if (!messageData.customer_name && !messageData.message_content) {
                console.log('Message lacks required data (name or content), skipping');
                return;
            }
            
            messageData.restaurant_id = restaurant.id;
            messageData.customer_phone = customerPhone;
            messageData.call_sid = callSid;
            
            console.log('Final message data to save:', messageData);
            
            const message = await createCustomerMessage(messageData);
            if (message) {
                console.log('Customer message saved successfully with ID:', message.id);
                messageProcessed = true;
                
                if (callSid) {
                    await updateCallLog(callSid, { 
                        conversation_transcript: JSON.stringify(conversationTranscript)
                    });
                }
            } else {
                console.error('Failed to save customer message to database');
            }
        } catch (error) {
            console.error('Error processing customer message:', error);
            console.error('Stack trace:', error.stack);
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
            const cleanLine = line.replace(/\*\*/g, '').replace(/^-\s*/, '');
            
            if (cleanLine.toLowerCase().includes('customer name:')) {
                messageData.customer_name = cleanLine.split(':').slice(1).join(':').trim();
            } else if (cleanLine.toLowerCase().includes('message type:')) {
                messageData.message_type = cleanLine.split(':').slice(1).join(':').trim();
            } else if (cleanLine.toLowerCase().includes('subject:')) {
                messageData.subject = cleanLine.split(':').slice(1).join(':').trim();
            } else if (cleanLine.toLowerCase().includes('message:') && !cleanLine.toLowerCase().includes('message type:')) {
                messageData.message_content = cleanLine.split(':').slice(1).join(':').trim();
            } else if (cleanLine.toLowerCase().includes('priority:')) {
                messageData.priority = cleanLine.split(':').slice(1).join(':').trim();
            }
        }
        
        Object.keys(messageData).forEach(key => {
            if (typeof messageData[key] === 'string') {
                messageData[key] = messageData[key].replace(/\*\*/g, '').trim();
            }
        });
        
        console.log('Parsed message data:', messageData);
        return messageData;
    }

    // Enhanced process order from AI transcript with delivery controls
    async function processOrderFromTranscript(transcript) {
        try {
            if (isModificationCall) {
                console.log('BLOCKING ORDER CREATION - This is a modification call, not a new order');
                return;
            }
            
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
                orderProcessed = true;
                console.log('Order processing started, flag set to prevent duplicates');
                
                const orderSection = transcript.substring(
                    transcript.indexOf('ORDER_CONFIRMED:') + 'ORDER_CONFIRMED:'.length,
                    transcript.indexOf('ORDER_END')
                ).trim();
                
                console.log('Found structured order:', orderSection);
                
                let customerName = '';
                let items = '';
                let specialInstructions = '';
                let orderType = 'pickup';
                let deliveryAddress = null;
                let readyTime = '';
                let totalAmount = 0;
                
                const lines = orderSection.split('\n').map(line => line.trim());
                
                for (const line of lines) {
                    if (line.startsWith('- Customer Name:') || line.startsWith('Customer Name:')) {
                        customerName = line.substring(line.indexOf(':') + 1).trim();
                        customerName = customerName.replace(/\[.*?\]/g, '').trim();
                    } else if (line.startsWith('- Order Type:') || line.startsWith('Order Type:')) {
                        orderType = line.substring(line.indexOf(':') + 1).trim().toLowerCase();
                    } else if (line.startsWith('- Delivery Address:') || line.startsWith('Delivery Address:')) {
                        const addr = line.substring(line.indexOf(':') + 1).trim();
                        if (addr && addr.toLowerCase() !== 'n/a' && addr !== 'N/A') {
                            deliveryAddress = addr;
                        } else if (orderType === 'delivery' && capturedDeliveryAddress) {
                            deliveryAddress = capturedDeliveryAddress;
                            console.log('Using captured delivery address:', deliveryAddress);
                        }
                    } else if (line.startsWith('- Items:') || line.startsWith('Items:')) {
                        items = line.substring(line.indexOf(':') + 1).trim();
                    } else if (line.startsWith('- Special Instructions:') || line.startsWith('Special Instructions:')) {
                        specialInstructions = line.substring(line.indexOf(':') + 1).trim();
                    } else if (line.startsWith('- Ready Time:') || line.startsWith('Ready Time:') || 
                              line.startsWith('- Pickup Time:') || line.startsWith('Pickup Time:')) {
                        readyTime = line.substring(line.indexOf(':') + 1).trim();
                    } else if (line.startsWith('- Total:') || line.startsWith('Total:')) {
                        totalAmount = extractTotal(line);
                    }
                }
                
                // Enhanced validation for delivery orders
                if (orderType === 'delivery') {
                    // Check if restaurant supports delivery
                    if (!restaurant.delivery_enabled) {
                        console.error('BLOCKING ORDER CREATION - Attempted delivery order for restaurant without delivery enabled');
                        orderProcessed = false;
                        return;
                    }
                    
                    // Check if we have a validated delivery address
                    if (!deliveryAddress) {
                        console.error('BLOCKING ORDER CREATION - Delivery order without valid delivery address');
                        orderProcessed = false;
                        return;
                    }
                    
                    // Check delivery hours
                    if (restaurant.delivery_hours) {
                        const deliveryStatus = await isWithinDeliveryHours(restaurant.delivery_hours);
                        if (!deliveryStatus.within) {
                            console.error('BLOCKING ORDER CREATION - Attempted delivery order outside delivery hours');
                            orderProcessed = false;
                            return;
                        }
                    }
                }
                
                if (!customerName || customerName === 'Not provided' || customerName === '[name if provided]') {
                    console.log('WARNING: Customer name not captured properly');
                    const nameConversation = conversationTranscript.filter(m => m.speaker === 'Customer');
                    for (const msg of nameConversation) {
                        const nameMatch = msg.text.match(/(?:my name is|this is|i'm|i am)\s+([A-Za-z]+(?:\s+[A-Za-z]+)?)/i);
                        if (nameMatch) {
                            customerName = nameMatch[1];
                            console.log('Found customer name from conversation:', customerName);
                            break;
                        }
                    }
                }
                
                // Calculate ready time with enhanced delivery controls
                const timing = calculateOrderReadyTime(restaurant, orderType === 'delivery');
                
                // Build comprehensive order details with delivery information
                const formattedOrderDetails = `Customer: ${customerName || 'Not provided'}
Phone: ${customerPhone}
Order Type: ${orderType}
${orderType === 'delivery' ? `Delivery Address: ${deliveryAddress || 'Not provided'}` : 'Pickup'}
${orderType === 'delivery' ? `Estimated Delivery Time: ${timing.totalMinutes} minutes (${timing.preparationMinutes}min prep + ${timing.deliveryMinutes}min delivery)` : `Estimated Pickup Time: ${timing.preparationMinutes} minutes`}
Items: ${items || 'No items specified'}
Special Instructions: ${specialInstructions || 'None'}
Ready Time: ${readyTime || timing.readyTimeString}
Order taken via AI phone system`;

                const orderData = {
                    restaurant_id: restaurant.id,
                    customer_phone: customerPhone,
                    customer_name: customerName || null,
                    total_amount: totalAmount || extractTotal(orderSection) || 0,
                    order_type: orderType,
                    delivery_address: deliveryAddress,
                    order_details: formattedOrderDetails,
                    special_instructions: specialInstructions || '',
                    call_sid: callSid,
                    items: []
                };

                console.log('Final order data to save with delivery controls:', orderData);

                const order = await createOrder(orderData);
                if (order) {
                    console.log('NEW order saved successfully with ID:', order.id);
                    console.log('Order type:', order.order_type);
                    if (order.order_type === 'delivery') {
                        console.log('Delivery address:', order.delivery_address);
                        console.log('Estimated delivery time:', timing.totalMinutes, 'minutes');
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

    // Extract total amount from text
    function extractTotal(text) {
        try {
            const totalMatch = text.match(/Total:\s*\$(\d+\.?\d*)/);
            if (totalMatch) {
                return parseFloat(totalMatch[1]);
            }
            
            const dollarPattern = /\$(\d+\.?\d*)/g;
            const matches = text.match(dollarPattern);
            
            if (matches && matches.length > 0) {
                let sum = 0;
                for (let i = 0; i < matches.length; i++) {
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

    // Process call end
    async function processCallEnd() {
        try {
            console.log('=== CALL END PROCESSING START ===');
            console.log('Order already processed:', orderProcessed);
            console.log('Message already processed:', messageProcessed);
            console.log('Was modification call:', isModificationCall);
            
            if (callSid) {
                const transcript = JSON.stringify(conversationTranscript);
                await updateCallLog(callSid, { 
                    conversation_transcript: transcript
                });
                console.log('Call log updated with conversation transcript');
            }
            
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
    console.log(`Restaurant AI System with Enhanced Delivery Controls running on port ${port}`);
    console.log(`Ready to take orders and messages via phone calls`);
    console.log(`WebSocket ready for Twilio Media Streams`);
    console.log(`OpenAI configured: ${!!OPENAI_API_KEY}`);
    console.log(`Supabase configured: ${!!(SUPABASE_URL && SUPABASE_ANON_KEY)}`);
    console.log(`Delivery controls enabled for restaurant management`);
}); else if (typeof args === 'string') {
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
                    const phoneNumber = parsedArgs.phone_number || customerPhone;
                    console.log('Searching PENDING orders for phone:', phoneNumber);
                    
                    if (!phoneNumber) {
                        result = { error: 'No phone number available to search orders' };
                        break;
                    }
                    
                    const orders = await searchRecentOrders(phoneNumber, restaurant.id);
                    recentOrders = orders;
                    
                    if (orders.length > 0) {
                        const recentCustomerText = conversationTranscript
                            .filter(m => m.speaker === 'Customer')
                            .slice(-5)
                            .map(m => m.text)
                            .join(' ')
                            .toLowerCase();
                        
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
                            order_type: order.order_type,
                            delivery_address: order.delivery_address,
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
                            ? 'No pending orders found. I can take a message for the restaurant about your order issue.' 
                            : `Found ${orders.length} pending order(s). Please tell me what changes you'd like to make.`,
                        modification_required: orders.length > 0 ? true : false
                    };
                    console.log(`Found ${orders.length} pending orders for ${phoneNumber}`);
                    break;

                case 'validate_delivery_address':
                    console.log('=== ADDRESS VALIDATION FUNCTION CALLED ===');
                    console.log('Parsed arguments:', parsedArgs);
                    
                    let address = parsedArgs.address;
                    
                    // If no address in arguments, try to extract from conversation
                    if (!address) {
                        console.log('No address in function arguments, extracting from conversation...');
                        address = extractAddressFromConversation(conversationTranscript);
                        console.log('Extracted address from conversation:', address);
                    }
                    
                    // If still no address, ask for it
                    if (!address) {
                        result = {
                            valid: false,
                            message: 'Please provide your complete delivery address including street number, street name, city, state, and zip code.',
                            address: null,
                            reason: 'no_address_provided',
                            instruction: 'Ask customer for their complete delivery address.'
                        };
                        console.log('Address validation failed - no address found');
                        break;
                    }
                    
                    // Check if restaurant supports delivery
                    if (!restaurant.delivery_enabled) {
                        result = {
                            valid: false,
                            message: 'We only offer pickup orders. Delivery is not available.',
                            address: address,
                            reason: 'delivery_not_enabled',
                            instruction: 'Offer pickup instead of delivery.'
                        };
                        console.log('Address validation failed - delivery not enabled');
                        break;
                    }
                    
                    console.log('Validating delivery address:', address);
                    console.log('Restaurant delivery settings:', {
                        delivery_enabled: restaurant.delivery_enabled,
                        delivery_radius: restaurant.delivery_radius,
                        delivery_hours: restaurant.delivery_hours,
                        delivery_time: restaurant.delivery_time
                    });
                    
                    const validationResult = await validateDeliveryAddress(address, restaurant);
                    
                    if (validationResult.valid) {
                        capturedDeliveryAddress = address;
                        console.log('DELIVERY ADDRESS VALIDATED AND CAPTURED:', capturedDeliveryAddress);
                        
                        // Enhanced successful validation response
                        validationResult.instruction = 'SUCCESS! Address is valid for delivery. Create ORDER_CONFIRMED format immediately.';
                        validationResult.delivery_time_info = `Estimated delivery time: ${validationResult.estimated_delivery_time || ((restaurant.preparation_time || 20) + (restaurant.delivery_time || 15))} minutes`;
                        validationResult.action_required = 'CREATE_ORDER_NOW';
                        validationResult.status = 'APPROVED';
                        validationResult.confirmed_address = address;
                    } else {
                        console.log('Delivery address validation failed:', validationResult.reason);
                        validationResult.action_required = 'OFFER_PICKUP_INSTEAD';
                        validationResult.status = 'REJECTED';
                    }
                    
                    result = validationResult;
                    console.log('Final address validation result:', result);
                    break;

                case 'cancel_order':
                    isModificationCall = true;
                    let cancelOrderId = parsedArgs.order_id;
                    const cancelReason = parsedArgs.reason || 'Customer requested cancellation';
                    
                    if (!cancelOrderId && recentOrders && recentOrders.length > 0) {
                        console.log('WARNING: No order ID provided, attempting to use most recent order from search');
                        cancelOrderId = recentOrders[0].id;
                        
                        result = {
                            warning: 'No order ID was provided. Using the most recent order from search results.',
                            retry_instruction: 'Please always extract and pass the order ID from search results when calling cancel_order.'
                        };
                    }
                    
                    if (!cancelOrderId) {
                        result = { 
                            error: 'No order ID provided and no recent orders found. You must first use search_recent_orders, then extract the order ID from the results.',
                            instruction: 'Call search_recent_orders first, then use the "id" field from the results when calling cancel_order.'
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
                    isModificationCall = true;
                    let orderId = parsedArgs.order_id;
                    let modifications = parsedArgs.modifications || 'Order modification requested';
                    let newTotal = parsedArgs.new_total || 0;
                    
                    if (!orderId && recentOrders && recentOrders.length > 0) {
                        console.log('WARNING: No order ID provided, attempting to use most recent order from search');
                        orderId = recentOrders[0].id;
                        
                        result = {
                            warning: 'No order ID was provided. Using the most recent order from search results.',
                            retry_instruction: 'Please always extract and pass the order ID from search results when calling update_order.',
                            attempting_with_id: orderId
                        };
                        
                        if (orderId) {
                            const updateData = {
                                modifications: modifications,
                                new_total: newTotal,
                                restaurant_menu: restaurant.menu_items
                            };
                            
                            const updateResult = await updateOrder(orderId, updateData);
                            
                            if (updateResult) {
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
                            error: 'No order ID provided and no recent orders found. You must first use search_recent_orders, then extract the order ID from the results.'
                        };
                        console.error('Update order called without order ID and no recent orders available');
                        break;
                    }
                    
                    console.log(`Attempting to update order: ${orderId}`);
                    console.log(`Modifications requested: ${modifications}`);
                    console.log(`New total provided: ${newTotal}`);
                    
                    const updateData = {
                        modifications: modifications,
                        new_total: newTotal,
                        restaurant_menu: restaurant.menu_items
                    };
                    
                    const updateResult = await updateOrder(orderId, updateData);
                    
                    if (updateResult) {
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
                
                setTimeout(() => {
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

// API endpoint to get messages by status
app.get('/messages/:status', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('customer_messages')
            .select(`
                *,
                restaurants(name, delivery_enabled, delivery_hours)
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

// API endpoint to get restaurant delivery settings
app.get('/restaurant/:phone/delivery-info', async (req, res) => {
    try {
        const restaurant = await getRestaurantByPhone(req.params.phone);
        
        if (!restaurant) {
            return res.status(404).json({ error: 'Restaurant not found' });
        }

        const deliveryInfo = {
            restaurant_name: restaurant.name,
            delivery_enabled: restaurant.delivery_enabled,
            delivery_radius: restaurant.delivery_radius,
            delivery_hours: restaurant.delivery_hours,
            delivery_time: restaurant.delivery_time,
            preparation_time: restaurant.preparation_time,
            current_status: await getDeliveryStatus(restaurant)
        };

        res.json(deliveryInfo);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Function to get current delivery status
async function getDeliveryStatus(restaurant) {
    if (!restaurant.delivery_enabled) {
        return { available: false, reason: 'Delivery service not offered' };
    }

    const now = new Date();
    const isWithinHours = await isWithinDeliveryHours(restaurant.delivery_hours, now);
    
    if (!isWithinHours.within) {
        return { 
            available: false, 
            reason: `Delivery only available ${restaurant.delivery_hours}`,
            next_available: isWithinHours.next_window
        };
    }

    return { 
        available: true, 
        radius: restaurant.delivery_radius,
        estimated_time: `${(restaurant.preparation_time || 20) + (restaurant.delivery_time || 15)} minutes`
    };
}

// Enhanced function to check if current time is within delivery hours
async function isWithinDeliveryHours(deliveryHours, currentTime = new Date()) {
    try {
        if (!deliveryHours) {
            return { within: true, next_window: null };
        }

        const currentHour = currentTime.getHours();
        const currentMinutes = currentTime.getMinutes();
        const currentTotalMinutes = currentHour * 60 + currentMinutes;
        
        // Parse delivery hours (e.g., "9:00am - 11:00pm" or "9:00 - 11p")
        const hoursString = deliveryHours.toLowerCase().replace(/\s/g, '');
        const [startTime, endTime] = hoursString.split('-');
        
        // Helper function to parse time string
        const parseTime = (timeStr) => {
            timeStr = timeStr.trim();
            
            const isPM = timeStr.includes('p');
            const isAM = timeStr.includes('a');
            
            timeStr = timeStr.replace(/[ap]m?/gi, '');
            
            let hours = 0;
            let minutes = 0;
            
            if (timeStr.includes(':')) {
                const [h, m] = timeStr.split(':');
                hours = parseInt(h) || 0;
                minutes = parseInt(m) || 0;
            } else {
                hours = parseInt(timeStr) || 0;
            }
            
            // Convert to 24-hour format
            if (isPM && hours !== 12) {
                hours += 12;
            } else if (isAM && hours === 12) {
                hours = 0;
            } else if (!isAM && !isPM) {
                if (hours <= 11 && hours >= 6) {
                    // Morning/day hours
                } else if (hours >= 1 && hours <= 5) {
                    // Evening hours, add 12
                    hours += 12;
                }
            }
            
            return hours * 60 + minutes;
        };
        
        let startMinutes = parseTime(startTime);
        let endMinutes = parseTime(endTime);
        
        // Calculate next delivery window
        const calculateNextWindow = () => {
            const tomorrow = new Date(currentTime);
            tomorrow.setDate(tomorrow.getDate() + 1);
            tomorrow.setHours(Math.floor(startMinutes / 60));
            tomorrow.setMinutes(startMinutes % 60);
            tomorrow.setSeconds(0);
            return tomorrow;
        };
        
        // Handle overnight hours
        if (endMinutes < startMinutes) {
            if (currentTotalMinutes >= startMinutes || currentTotalMinutes <= endMinutes) {
                return { within: true, next_window: null };
            } else {
                return { within: false, next_window: calculateNextWindow() };
            }
        } else {
            if (currentTotalMinutes >= startMinutes && currentTotalMinutes < endMinutes) {
                return { within: true, next_window: null };
            } else {
                return { within: false, next_window: calculateNextWindow() };
            }
        }
        
    } catch (error) {
        console.error('Error checking delivery hours:', error);
        return { within: true, next_window: null }; // Default to available if can't parse
    }
}

// Function to get restaurant data by phone number using Edge Function
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
                        
                        if (response.transcript.includes('MESSAGE_CONFIRMED') || 
                            (accumulatedMessageText && !messageProcessed)) {
                            console.log('Accumulating message text...');
                            accumulatedMessageText += response.transcript + '\n';
                            
                            if (accumulatedMessageText.includes('MESSAGE_CONFIRMED') && 
                                accumulatedMessageText.includes('MESSAGE_END')) {
                                console.log('Complete MESSAGE detected, processing...');
                                processMessageFromTranscript(accumulatedMessageText);
                                accumulatedMessageText = '';
                            }
                        } else if (response.transcript.includes('ORDER_CONFIRMED:') && !isModificationCall) {
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

        if (!response.ok) {
            console.error('Edge Function response not ok:', response.status, response.statusText);
            // Fallback to direct database query if Edge Function fails
            return await getRestaurantByPhoneFallback(phoneNumber);
        }

        const result = await response.json();
        
        if (result.error) {
            console.error('Edge Function returned error:', result.error);
            // Fallback to direct database query if Edge Function has error
            return await getRestaurantByPhoneFallback(phoneNumber);
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

        console.log('Restaurant loaded with delivery settings:', {
            name: restaurantWithDefaults.name,
            delivery_enabled: restaurantWithDefaults.delivery_enabled,
            delivery_radius: restaurantWithDefaults.delivery_radius,
            delivery_hours: restaurantWithDefaults.delivery_hours,
            delivery_time: restaurantWithDefaults.delivery_time
        });

        return restaurantWithDefaults;
    } catch (error) {
        console.error('Error calling get-restaurant Edge Function:', error);
        // Fallback to direct database query if Edge Function completely fails
        return await getRestaurantByPhoneFallback(phoneNumber);
    }
}

// Fallback function using direct database query with correct schema
async function getRestaurantByPhoneFallback(phoneNumber) {
    try {
        console.log('Using fallback direct database query for phone:', phoneNumber);
        
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
                    available,
                    display_order
                )
            `)
            .eq('phone_number', phoneNumber)
            .single();

        if (error) {
            console.error('Error fetching restaurant from database:', error);
            return null;
        }

        // Ensure delivery settings have defaults
        const restaurantWithDefaults = {
            ...data,
            delivery_enabled: data.delivery_enabled ?? false,
            delivery_radius: data.delivery_radius ?? 5,
            delivery_hours: data.delivery_hours ?? null,
            delivery_time: data.delivery_time ?? 15,
            preparation_time: data.preparation_time ?? 20
        };

        console.log('Restaurant loaded via fallback with delivery settings:', {
            name: restaurantWithDefaults.name,
            delivery_enabled: restaurantWithDefaults.delivery_enabled,
            delivery_radius: restaurantWithDefaults.delivery_radius,
            delivery_hours: restaurantWithDefaults.delivery_hours,
            delivery_time: restaurantWithDefaults.delivery_time
        });

        return restaurantWithDefaults;
    } catch (error) {
        console.error('Fallback database error:', error);
        return null;
    }
}

// Function to create call log using Edge Function
async function createCallLog(callData) {
    try {
        console.log('Calling create-call-log Edge Function with data:', callData);
        
        const response = await fetch('https://ujgpqnarhcegrpyzbxej.supabase.co/functions/v1/create-call-log', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
            },
            body: JSON.stringify({
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
            })
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

        console.log('Call log created via Edge Function:', result.data?.id);
        return result.data;
    } catch (error) {
        console.error('Error calling create-call-log Edge Function:', error);
        return null;
    }
}

// Function to update call log using Edge Function
async function updateCallLog(callSid, updateData) {
    try {
        console.log('Calling update-call-log Edge Function for:', callSid);
        
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
        
        if (result.error) {
            console.error('update-call-log Edge Function returned error:', result.error);
            return null;
        }

        console.log('Call log updated via Edge Function for:', callSid);
        return result.data;
    } catch (error) {
        console.error('Error calling update-call-log Edge Function:', error);
        return null;
    }
}

// Function to search for recent orders using Edge Function
async function searchRecentOrders(phoneNumber, restaurantId, daysBack = 7) {
    try {
        console.log('Calling search-orders Edge Function for phone:', phoneNumber);
        
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
                status: 'pending' // Only search for pending orders
            })
        });

        if (!response.ok) {
            console.error('search-orders Edge Function response not ok:', response.status);
            return [];
        }

        const result = await response.json();
        
        if (result.error) {
            console.error('search-orders Edge Function returned error:', result.error);
            return [];
        }

        const orders = result.data || [];
        console.log(`Found ${orders.length} pending orders for phone: ${phoneNumber}`);
        return orders;
    } catch (error) {
        console.error('Error calling search-orders Edge Function:', error);
        return [];
    }
}

// Function to cancel an existing order using Edge Function
async function cancelOrder(orderId, reason = 'Customer cancellation') {
    try {
        if (!orderId) {
            console.error('No order ID provided for cancellation');
            return null;
        }
        
        console.log('Calling cancel-order Edge Function for:', orderId);
        
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
            console.error('cancel-order Edge Function response not ok:', response.status);
            return null;
        }

        const result = await response.json();
        
        if (result.error) {
            console.error('cancel-order Edge Function returned error:', result.error);
            return null;
        }

        console.log('Order cancelled successfully via Edge Function:', orderId);
        return result.data;
    } catch (error) {
        console.error('Error calling cancel-order Edge Function:', error);
        return null;
    }
}

// Function to update an existing order using Edge Function
async function updateOrder(orderId, updateData) {
    try {
        if (!orderId) {
            console.error('No order ID provided for update');
            return null;
        }
        
        console.log(`Calling update-order Edge Function for ${orderId} with:`, updateData);
        
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
            console.error('update-order Edge Function response not ok:', response.status);
            return null;
        }

        const result = await response.json();
        
        if (result.error) {
            console.error('update-order Edge Function returned error:', result.error);
            return null;
        }

        console.log('Order updated successfully via Edge Function:', orderId);
        return result.data;
    } catch (error) {
        console.error('Error calling update-order Edge Function:', error);
        return null;
    }
}

// Function to create customer message using Edge Function
async function createCustomerMessage(messageData) {
    try {
        console.log('Calling create-message Edge Function with data:', messageData);
        
        if (!messageData.restaurant_id) {
            console.error('Missing restaurant_id for customer message');
            return null;
        }
        
        if (!messageData.customer_phone) {
            console.error('Missing customer_phone for customer message');
            return null;
        }
        
        const response = await fetch('https://ujgpqnarhcegrpyzbxej.supabase.co/functions/v1/create-message', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
            },
            body: JSON.stringify({
                restaurant_id: messageData.restaurant_id,
                customer_phone: messageData.customer_phone,
                customer_name: messageData.customer_name || 'Unknown',
                message_type: messageData.message_type || 'general',
                subject: messageData.subject || 'Customer Inquiry',
                message_content: messageData.message_content || 'No message content provided',
                call_sid: messageData.call_sid,
                order_reference: messageData.order_reference,
                priority: messageData.priority || 'normal'
            })
        });

        if (!response.ok) {
            console.error('create-message Edge Function response not ok:', response.status);
            return null;
        }

        const result = await response.json();
        
        if (result.error) {
            console.error('create-message Edge Function returned error:', result.error);
            return null;
        }

        console.log('Customer message created successfully via Edge Function:', result.data?.id);
        return result.data;
    } catch (error) {
        console.error('Error calling create-message Edge Function:', error);
        return null;
    }
}

// Function to calculate distance between two points (in miles)
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 3959; // Radius of the Earth in miles
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = 
        Math.sin(dLat/2) * Math.sin(dLat/2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
}

// Enhanced function to validate delivery address using Edge Function
async function validateDeliveryAddress(address, restaurant) {
    try {
        console.log('Calling validate-delivery Edge Function with address:', address);
        console.log('Restaurant delivery settings:', {
            delivery_enabled: restaurant.delivery_enabled,
            delivery_radius: restaurant.delivery_radius,
            delivery_hours: restaurant.delivery_hours,
            delivery_time: restaurant.delivery_time
        });
        
        if (!address) {
            return {
                valid: false,
                message: 'No address provided for validation.',
                address: null,
                reason: 'no_address'
            };
        }
        
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
            console.error('validate-delivery Edge Function response not ok:', response.status);
            return {
                valid: false,
                message: 'Unable to validate address at this time. Please provide a complete address or choose pickup.',
                address: address,
                reason: 'validation_service_error'
            };
        }

        const result = await response.json();
        
        if (result.error) {
            console.error('validate-delivery Edge Function returned error:', result.error);
            return {
                valid: false,
                message: 'Unable to validate address. Please provide a complete address or choose pickup.',
                address: address,
                reason: 'validation_error'
            };
        }

        console.log('Address validation result from Edge Function:', result);
        
        // Return the result from the Edge Function
        return {
            valid: result.valid || false,
            message: result.message || 'Address validation completed',
            address: address,
            reason: result.reason,
            estimated_delivery_time: result.estimated_delivery_time,
            delivery_radius: result.delivery_radius,
            delivery_fee_info: result.delivery_fee_info,
            next_available: result.next_available
        };
        
    } catch (error) {
        console.error('Error calling validate-delivery Edge Function:', error);
        return {
            valid: false,
            message: 'Unable to validate address at this time. Please provide a complete address or choose pickup.',
            address: address,
            reason: 'validation_error'
        };
    }
}

// Enhanced function to calculate pickup/delivery time with delivery controls
function calculateOrderReadyTime(restaurant, isDelivery = false) {
    try {
        const now = new Date();
        const preparationMinutes = restaurant?.preparation_time || 20;
        
        // Only add delivery time if this is actually a delivery order and delivery is enabled
        let deliveryAddedMinutes = 0;
        if (isDelivery && restaurant?.delivery_enabled) {
            deliveryAddedMinutes = restaurant?.delivery_time || 15;
        }
        
        const totalMinutes = preparationMinutes + deliveryAddedMinutes;
        const readyTime = new Date(now.getTime() + totalMinutes * 60000);
        
        // Format time as readable string
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
            totalMinutes: totalMinutes,
            estimatedTime: `approximately ${totalMinutes} minutes`,
            orderType: isDelivery ? 'delivery' : 'pickup'
        };
    } catch (error) {
        console.error('Error calculating ready time:', error);
        const defaultTime = new Date(Date.now() + 30 * 60000);
        const hours = defaultTime.getHours();
        const minutes = defaultTime.getMinutes();
        const ampm = hours >= 12 ? 'PM' : 'AM';
        const displayHours = hours % 12 || 12;
        const displayMinutes = minutes.toString().padStart(2, '0');
        
        return {
            readyTime: defaultTime,
            readyTimeString: `${displayHours}:${displayMinutes} ${ampm}`,
            preparationMinutes: 30,
            deliveryMinutes: 0,
            totalMinutes: 30,
            estimatedTime: 'approximately 30 minutes',
            orderType: isDelivery ? 'delivery' : 'pickup'
        };
    }
}

// Function to create order in database with enhanced delivery handling
async function createOrder(orderData) {
    try {
        let restaurantForTiming = null;
        if (orderData.restaurant_id) {
            const { data, error } = await supabase
                .from('restaurants')
                .select('*')
                .eq('id', orderData.restaurant_id)
                .single();
            
            if (data && !error) {
                restaurantForTiming = data;
            }
        }
        
        // Calculate pickup/delivery time based on restaurant settings and order type
        const isDelivery = orderData.order_type === 'delivery';
        const timing = calculateOrderReadyTime(restaurantForTiming, isDelivery);
        
        // Validate delivery constraints if this is a delivery order
        if (isDelivery && restaurantForTiming) {
            if (!restaurantForTiming.delivery_enabled) {
                console.error('Attempted to create delivery order for restaurant without delivery enabled');
                return null;
            }
            
            // Check delivery hours
            const deliveryStatus = await isWithinDeliveryHours(restaurantForTiming.delivery_hours);
            if (!deliveryStatus.within) {
                console.error('Attempted to create delivery order outside delivery hours');
                return null;
            }
        }
        
        // Add calculated ready time to order
        orderData.ready_time = timing.readyTimeString;
        orderData.estimated_ready_at = timing.readyTime.toISOString();
        
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
        console.log('Order type:', order.order_type);
        console.log('Estimated ready time:', order.ready_time);
        
        return order;
    } catch (error) {
        console.error('Error creating order:', error);
        return null;
    }
}

// Function to format menu for AI with delivery information (updated for correct schema)
function formatMenuForAI(menuItems, restaurant) {
    if (!menuItems || menuItems.length === 0) {
        return "No menu items available.";
    }

    // Group by category (string field, not foreign key)
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
    
    // Sort categories and items by display_order if available, then alphabetically
    const sortedCategories = Object.keys(categories).sort();
    
    sortedCategories.forEach(category => {
        menuText += `\n${category.toUpperCase()}:\n`;
        
        // Sort items within category
        categories[category]
            .sort((a, b) => a.name.localeCompare(b.name))
            .forEach(item => {
                menuText += `- ${item.name}: ${item.description || 'No description'} - ${item.price}\n`;
            });
    });

    // Add delivery information to menu context
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

// Enhanced function to extract address from customer conversation
function extractAddressFromConversation(conversationTranscript) {
    // Get recent customer messages
    const customerMessages = conversationTranscript
        .filter(msg => msg.speaker === 'Customer')
        .slice(-5) // Last 5 customer messages
        .map(msg => msg.text)
        .join(' ');
    
    console.log('Searching for address in conversation:', customerMessages);
    
    // Enhanced address patterns
    const addressPatterns = [
        // Complete address with Maryland/MD and 5-digit zip
        /\d+\s+[\w\s]+(?:street|road|avenue|lane|drive|way|court|place|boulevard|blvd|ave|rd|st|ct|pl|ln|dr)[\w\s,]*(?:maryland|md)[\w\s,]*\d{5}/i,
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
            console.log('Found address using pattern:', pattern.toString(), 'Result:', address);
            return address;
        }
    }
    
    console.log('No address pattern matched');
    return null;
}
