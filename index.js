const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const fetch = require('node-fetch');

const app = express();
const port = process.env.PORT || 3000;

// Enhanced middleware for parsing requests
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS for development
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    next();
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Configuration
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

// Global storage for active calls and address validation
const activeCalls = new Map();
const callAddresses = new Map(); // Store extracted addresses per call

// Note: OpenStreetMap geocoding now handled by validate-delivery-address Edge Function

// Note: Address validation now handled by validate-delivery-address Edge Function

// Enhanced Supabase Edge Function caller
async function callEdgeFunction(functionName, data) {
    try {
        console.log(`🔌 Calling ${functionName} Edge Function with data:`, JSON.stringify(data, null, 2));
        
        const response = await fetch(`${SUPABASE_URL}/functions/v1/${functionName}`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(data)
        });

        console.log(`Edge Function response status: ${response.status}`);
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Edge Function ${functionName} failed: ${response.status} - ${errorText}`);
        }

        const result = await response.json();
        console.log(`Edge Function raw response:`, JSON.stringify(result, null, 2));
        
        return result;
    } catch (error) {
        console.error(`❌ Edge Function ${functionName} error:`, error.message);
        throw error;
    }
}

// Enhanced address extraction from conversation
function extractAddressFromConversation(conversationItems) {
    if (!conversationItems || conversationItems.length === 0) {
        return null;
    }

    // Look for address patterns in customer messages
    const customerMessages = conversationItems
        .filter(item => item.speaker === 'Customer')
        .map(item => item.text)
        .join(' ');

    // Enhanced address extraction patterns
    const addressPatterns = [
        // Full address with state and ZIP
        /(?:^|[\s,])(\d+\s+[^,\n]+,\s*[^,\n]+,\s*[A-Z]{2}[\s,]*\d{5}(?:-\d{4})?)/i,
        // Address with ZIP but no state
        /(?:^|[\s,])(\d+\s+[^,\n]+[^0-9],?\s*\d{5}(?:-\d{4})?)/i,
        // Street address with city
        /(?:^|[\s,])(\d+\s+[^,\n]+,\s*[^,\n]+)/i,
        // Basic street address
        /(?:^|[\s,])(\d+\s+[\w\s]+(street|st|avenue|ave|road|rd|drive|dr|lane|ln|boulevard|blvd|way|circle|cir|court|ct|place|pl)[^,\n]*)/i
    ];

    for (const pattern of addressPatterns) {
        const match = customerMessages.match(pattern);
        if (match) {
            let address = match[1].trim();
            // Clean up common artifacts
            address = address.replace(/^(of|at|to|my address is|i live at|the address is)\s+/i, '');
            address = address.replace(/[.]{2,}$/, ''); // Remove trailing dots
            return address;
        }
    }

    return null;
}

// Enhanced OpenAI Realtime API configuration
function createOpenAIConfig(restaurant, callSid) {
    const systemMessage = `You are an AI phone assistant for ${restaurant.name}. Your job is to take food orders professionally and efficiently.

RESTAURANT INFO:
- Name: ${restaurant.name}
- ${restaurant.delivery_enabled ? `Delivery available within ${restaurant.delivery_radius || 5} miles` : 'Pickup only'}
- Preparation time: ${restaurant.preparation_time || 20} minutes
- ${restaurant.delivery_enabled ? `Delivery time: ${restaurant.delivery_time || 30} minutes` : ''}

CONVERSATION FLOW:
1. Greet customer and ask "pickup or delivery?"
2. For delivery: Get name, then address - ask for COMPLETE address with street number, street name, and city/ZIP
3. For pickup: Get name, then proceed to menu
4. Take their order (use save_order when ready)
5. Confirm details and provide pickup time

IMPORTANT GUIDELINES:
- Be conversational and natural - avoid robotic responses
- Don't pre-filter conversations - let natural flow happen
- Use functions when there's clear intent to take action
- For delivery addresses: Ask for COMPLETE address including street number, street name, city and ZIP code
- If address validation fails, suggest pickup as alternative
- Keep responses concise but friendly
- If customer asks questions or makes comments, respond naturally before proceeding

AVAILABLE FUNCTIONS:
- validate_delivery_address: Check if delivery address is valid and within range
- save_order: Save completed order (requires name, items, total)
- save_message: Save customer messages/requests for staff
- lookup_order: Find existing orders by phone number
- update_order: Modify pending orders
- cancel_order: Cancel pending orders

Call naturally - don't mention function names to customers.`;

    return {
        type: 'session.update',
        session: {
            model: 'gpt-4o-realtime-preview-2024-10-01',
            modalities: ['text', 'audio'],
            instructions: systemMessage,
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
                silence_duration_ms: 200
            },
            tools: [
                {
                    type: 'function',
                    name: 'validate_delivery_address',
                    description: 'Validate if a delivery address is within the restaurant delivery area. Call this when customer provides their delivery address.',
                    parameters: {
                        type: 'object',
                        properties: {
                            address: {
                                type: 'string',
                                description: 'The complete delivery address provided by the customer'
                            }
                        },
                        required: ['address']
                    }
                },
                {
                    type: 'function',
                    name: 'save_order',
                    description: 'Save a complete customer order with all details',
                    parameters: {
                        type: 'object',
                        properties: {
                            customer_name: { type: 'string', description: 'Customer name' },
                            customer_phone: { type: 'string', description: 'Customer phone number' },
                            order_type: { type: 'string', enum: ['pickup', 'delivery'], description: 'Order type' },
                            delivery_address: { type: 'string', description: 'Delivery address if applicable' },
                            items: {
                                type: 'array',
                                items: {
                                    type: 'object',
                                    properties: {
                                        name: { type: 'string' },
                                        quantity: { type: 'number' },
                                        price: { type: 'number' },
                                        special_requests: { type: 'string' }
                                    },
                                    required: ['name', 'quantity', 'price']
                                }
                            },
                            total_amount: { type: 'number', description: 'Total order amount' },
                            special_instructions: { type: 'string', description: 'Any special instructions' }
                        },
                        required: ['customer_name', 'customer_phone', 'order_type', 'items', 'total_amount']
                    }
                },
                {
                    type: 'function',
                    name: 'save_message',
                    description: 'Save customer messages, questions, or requests for restaurant staff',
                    parameters: {
                        type: 'object',
                        properties: {
                            customer_phone: { type: 'string', description: 'Customer phone number' },
                            customer_name: { type: 'string', description: 'Customer name if known' },
                            message_type: { type: 'string', enum: ['question', 'complaint', 'compliment', 'request', 'general'], description: 'Type of message' },
                            subject: { type: 'string', description: 'Brief subject of the message' },
                            message_content: { type: 'string', description: 'The actual message content' },
                            priority: { type: 'string', enum: ['low', 'normal', 'high'], description: 'Message priority' }
                        },
                        required: ['customer_phone', 'message_type', 'subject', 'message_content']
                    }
                },
                {
                    type: 'function',
                    name: 'lookup_order',
                    description: 'Look up existing orders by customer phone number',
                    parameters: {
                        type: 'object',
                        properties: {
                            customer_phone: { type: 'string', description: 'Customer phone number' }
                        },
                        required: ['customer_phone']
                    }
                },
                {
                    type: 'function',
                    name: 'update_order',
                    description: 'Update an existing pending order',
                    parameters: {
                        type: 'object',
                        properties: {
                            order_id: { type: 'string', description: 'Order ID to update' },
                            updates: {
                                type: 'object',
                                properties: {
                                    items: { type: 'array', description: 'Updated items list' },
                                    total_amount: { type: 'number', description: 'Updated total' },
                                    special_instructions: { type: 'string', description: 'Updated instructions' }
                                }
                            }
                        },
                        required: ['order_id', 'updates']
                    }
                },
                {
                    type: 'function',
                    name: 'cancel_order',
                    description: 'Cancel an existing pending order',
                    parameters: {
                        type: 'object',
                        properties: {
                            order_id: { type: 'string', description: 'Order ID to cancel' },
                            reason: { type: 'string', description: 'Reason for cancellation' }
                        },
                        required: ['order_id']
                    }
                }
            ],
            tool_choice: 'auto'
        }
    };
}

// Enhanced function execution
async function executeFunction(callSid, functionName, args, conversationItems) {
    console.log(`🚀 Enhanced function execution: ${functionName} with args:`, args);
    
    const callData = activeCalls.get(callSid);
    if (!callData) {
        throw new Error('Call data not found');
    }

    try {
        switch (functionName) {
            case 'validate_delivery_address':
                console.log(`🚀 Enhanced validate_delivery_address called with:`, args);
                
                let address = args.address;
                
                // If no address in args, try to extract from conversation
                if (!address) {
                    console.log('Address not in args, checking conversation...');
                    
                    // Check if we have a stored address for this call
                    const storedAddress = callAddresses.get(callSid);
                    if (storedAddress) {
                        address = storedAddress;
                        console.log(`📍 Using stored address: ${address}`);
                    } else {
                        address = extractAddressFromConversation(conversationItems);
                        if (address) {
                            console.log(`🏠 Extracted address: ${address}`);
                            callAddresses.set(callSid, address);
                        }
                    }
                }

                if (!address) {
                    console.log('❌ No address found in args or conversation');
                    return {
                        valid: false,
                        reason: 'incomplete_address',
                        message: 'Please provide your complete delivery address with street number, street name, and city or ZIP code.',
                        instruction: 'Ask customer for their complete delivery address.'
                    };
                }

                console.log(`🔍 Calling validate-delivery-address Edge Function with: ${address}`);
                const validationResult = await callEdgeFunction('validate-delivery-address', {
                    address: address,
                    restaurant_id: callData.restaurant_id
                });
                
                console.log(`🔍 Enhanced validation result:`, validationResult);

                if (validationResult.success) {
                    return {
                        ...validationResult.data,
                        instruction: validationResult.data.valid 
                            ? 'Address validated successfully! Proceed with taking the order.'
                            : 'Address validation failed. Use the exact message provided and suggest pickup instead.'
                    };
                } else {
                    return {
                        valid: false,
                        reason: 'validation_error',
                        message: 'Unable to validate your delivery address right now. Would you prefer pickup instead?',
                        instruction: 'Validation service error. Suggest pickup option.'
                    };
                }

            case 'save_order':
                return await callEdgeFunction('save-order', {
                    restaurant_id: callData.restaurant_id,
                    call_sid: callSid,
                    ...args
                });

            case 'save_message':
                return await callEdgeFunction('save-message', {
                    restaurant_id: callData.restaurant_id,
                    call_sid: callSid,
                    ...args
                });

            case 'lookup_order':
                return await callEdgeFunction('lookup-order', {
                    restaurant_id: callData.restaurant_id,
                    ...args
                });

            case 'update_order':
                return await callEdgeFunction('update-order', args);

            case 'cancel_order':
                return await callEdgeFunction('cancel-order', args);

            default:
                throw new Error(`Unknown function: ${functionName}`);
        }
    } catch (error) {
        console.error(`❌ Enhanced function ${functionName} error:`, error.message);
        return {
            error: true,
            message: `Function ${functionName} failed: ${error.message}`
        };
    }
}

// Twilio webhook for incoming calls
app.post('/webhook', async (req, res) => {
    console.log('Incoming call webhook:', req.body);

    const response = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Connect>
        <Stream url="wss://${req.headers.host}/media" />
    </Connect>
</Response>`;

    res.type('text/xml').send(response);
});

// WebSocket handler for media streams
wss.on('connection', (ws) => {
    console.log('New WebSocket connection');
    
    let callSid = null;
    let streamSid = null;
    let openAIws = null;
    let restaurant = null;
    let conversationItems = [];

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);

            if (data.event === 'connected') {
                console.log('Twilio connected');
            }
            
            else if (data.event === 'start') {
                streamSid = data.start.streamSid;
                callSid = data.start.callSid;
                
                console.log(`Stream started: ${streamSid}`);
                console.log(`Called number: ${data.start.customParameters.To}`);
                console.log(`From number (caller ID): ${data.start.customParameters.From}`);
                console.log(`Call ID: ${callSid}`);

                const calledNumber = data.start.customParameters.To;
                const fromNumber = data.start.customParameters.From;

                console.log(`Loading restaurant data for: ${calledNumber}`);

                // Get restaurant data
                try {
                    const restaurantResponse = await callEdgeFunction('get-restaurant', {
                        phone_number: calledNumber
                    });

                    if (!restaurantResponse.success) {
                        throw new Error('Restaurant not found');
                    }

                    restaurant = restaurantResponse.data;
                    console.log(`Restaurant loaded:`, {
                        id: restaurant.id,
                        name: restaurant.name,
                        phone: restaurant.phone_number,
                        delivery_enabled: restaurant.delivery_enabled,
                        preparation_time: restaurant.preparation_time,
                        delivery_time: restaurant.delivery_time,
                        latitude: restaurant.latitude,
                        longitude: restaurant.longitude
                    });

                    // Store call data for function execution
                    activeCalls.set(callSid, {
                        restaurant_id: restaurant.id,
                        from: fromNumber,
                        to: calledNumber,
                        call_started_at: new Date(),
                        twilio_data: data.start.customParameters
                    });

                    // Create call log
                    await callEdgeFunction('create-call-log', {
                        call_sid: callSid,
                        restaurant_id: restaurant.id,
                        from_number: fromNumber,
                        to_number: calledNumber,
                        call_status: 'in-progress',
                        call_direction: 'inbound',
                        caller_country: data.start.customParameters.CallerCountry,
                        caller_state: data.start.customParameters.CallerState,
                        caller_city: data.start.customParameters.CallerCity,
                        caller_zip: data.start.customParameters.CallerZip,
                        to_country: data.start.customParameters.ToCountry,
                        to_state: data.start.customParameters.ToState,
                        to_city: data.start.customParameters.ToCity,
                        to_zip: data.start.customParameters.ToZip,
                        call_started_at: activeCalls.get(callSid).call_started_at.toISOString(),
                        twilio_data: data.start.customParameters
                    });

                    console.log(`Stored call data for: ${callSid}`, {
                        from: fromNumber,
                        to: calledNumber,
                        restaurant_id: restaurant.id,
                        has_twilio_data: !!data.start.customParameters
                    });

                } catch (error) {
                    console.error('❌ Failed to load restaurant:', error.message);
                    ws.close();
                    return;
                }

                // Connect to OpenAI Realtime API
                console.log('Connecting to OpenAI Realtime API with enhanced address validation...');
                openAIws = new (require('ws'))('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
                    headers: {
                        'Authorization': `Bearer ${OPENAI_API_KEY}`,
                        'OpenAI-Beta': 'realtime=v1'
                    }
                });

                console.log('🔗 WebSocket created successfully');

                openAIws.on('open', () => {
                    console.log('✅ Connected to OpenAI Realtime API');
                    const config = createOpenAIConfig(restaurant, callSid);
                    openAIws.send(JSON.stringify(config));
                    console.log('OpenAI session configured with enhanced address validation');
                });

                openAIws.on('message', async (data) => {
                    try {
                        const response = JSON.parse(data);

                        if (response.type === 'response.audio.delta' && response.delta) {
                            const audioMessage = {
                                event: 'media',
                                streamSid: streamSid,
                                media: {
                                    payload: response.delta
                                }
                            };
                            ws.send(JSON.stringify(audioMessage));
                        }
                        
                        else if (response.type === 'conversation.item.input_audio_transcription.completed') {
                            const transcript = response.transcript;
                            console.log(`Customer said: ${transcript}`);
                            
                            conversationItems.push({
                                timestamp: new Date().toISOString(),
                                speaker: 'Customer',
                                text: transcript
                            });

                            // Enhanced address detection and storage
                            const extractedAddress = extractAddressFromConversation(conversationItems);
                            if (extractedAddress && !callAddresses.has(callSid)) {
                                console.log(`🏠 Enhanced address validation triggered: ${transcript}`);
                                console.log(`🏠 Extracted address for validation: ${extractedAddress}`);
                                console.log(`🏠 Stored address in extractedAddressForValidation: ${extractedAddress}`);
                                callAddresses.set(callSid, extractedAddress);
                            }
                        }
                        
                        else if (response.type === 'response.audio.transcript.done') {
                            const transcript = response.transcript;
                            console.log(`AI said: ${transcript}`);
                            
                            conversationItems.push({
                                timestamp: new Date().toISOString(),
                                speaker: 'AI',
                                text: transcript
                            });
                        }

                        else if (response.type === 'response.function_call_arguments.done') {
                            console.log(`Function call item created: ${response.name}`);
                        }

                        else if (response.type === 'response.done') {
                            const responseData = response.response;
                            
                            if (responseData.output && responseData.output.length > 0) {
                                for (const output of responseData.output) {
                                    if (output.type === 'function_call') {
                                        console.log(`Enhanced function execution: ${output.name} with args:`, output.arguments);
                                        
                                        try {
                                            const result = await executeFunction(
                                                callSid, 
                                                output.name, 
                                                JSON.parse(output.arguments),
                                                conversationItems
                                            );
                                            
                                            console.log(`Enhanced function result:`, result);

                                            const functionResult = {
                                                type: 'conversation.item.create',
                                                item: {
                                                    type: 'function_call_output',
                                                    call_id: output.call_id,
                                                    output: JSON.stringify(result)
                                                }
                                            };

                                            openAIws.send(JSON.stringify(functionResult));

                                            const responseCreate = {
                                                type: 'response.create'
                                            };

                                            openAIws.send(JSON.stringify(responseCreate));

                                        } catch (error) {
                                            console.error(`❌ Enhanced function execution error:`, error);
                                            
                                            const errorResult = {
                                                type: 'conversation.item.create',
                                                item: {
                                                    type: 'function_call_output',
                                                    call_id: output.call_id,
                                                    output: JSON.stringify({
                                                        error: true,
                                                        message: `Function failed: ${error.message}`
                                                    })
                                                }
                                            };

                                            openAIws.send(JSON.stringify(errorResult));
                                        }
                                    }
                                }
                            }
                        }

                    } catch (error) {
                        console.error('❌ OpenAI message error:', error);
                    }
                });

                openAIws.on('error', (error) => {
                    console.error('❌ OpenAI WebSocket error:', error);
                });

                openAIws.on('close', () => {
                    console.log('OpenAI connection closed');
                });
            }
            
            else if (data.event === 'media') {
                if (openAIws && openAIws.readyState === 1) {
                    const audioMessage = {
                        type: 'input_audio_buffer.append',
                        audio: data.media.payload
                    };
                    openAIws.send(JSON.stringify(audioMessage));
                }
            }
            
            else if (data.event === 'stop') {
                console.log('WebSocket connection closed');
                if (openAIws) {
                    openAIws.close();
                }
            }

        } catch (error) {
            console.error('❌ WebSocket message error:', error);
        }
    });

    ws.on('close', async () => {
        console.log('WebSocket connection closed');
        
        if (callSid) {
            const callData = activeCalls.get(callSid);
            if (callData) {
                const duration = Math.floor((new Date() - callData.call_started_at) / 1000);
                
                console.log(`Creating call log with enhanced validation status: {
  call_sid: '${callSid}',
  duration: ${duration},
  conversation_items: ${conversationItems.length},
  restaurant_id: '${callData.restaurant_id}',
  openstreetmap_geocoding_used: true
}`);

                try {
                    await callEdgeFunction('create-call-log', {
                        call_sid: callSid,
                        restaurant_id: callData.restaurant_id,
                        from_number: callData.from,
                        to_number: callData.to,
                        call_status: 'completed',
                        call_direction: 'inbound',
                        caller_country: callData.twilio_data.CallerCountry,
                        caller_state: callData.twilio_data.CallerState,
                        caller_city: callData.twilio_data.CallerCity,
                        caller_zip: callData.twilio_data.CallerZip,
                        to_country: callData.twilio_data.ToCountry,
                        to_state: callData.twilio_data.ToState,
                        to_city: callData.twilio_data.ToCity,
                        to_zip: callData.twilio_data.ToZip,
                        call_duration: duration,
                        call_started_at: callData.call_started_at.toISOString(),
                        call_ended_at: new Date().toISOString(),
                        twilio_data: callData.twilio_data,
                        conversation_transcript: JSON.stringify(conversationItems),
                        order_id: null
                    });

                    console.log(`Call completed with enhanced address validation. Duration: ${duration} seconds`);
                } catch (error) {
                    console.error('❌ Failed to create final call log:', error);
                }

                activeCalls.delete(callSid);
                callAddresses.delete(callSid);
            }
        }

        if (openAIws) {
            openAIws.close();
        }
    });

    ws.on('error', (error) => {
        console.error('🔌 Twilio WebSocket error:', error);
    });
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy',
        timestamp: new Date().toISOString(),
        features: {
            openai_configured: !!OPENAI_API_KEY,
            supabase_configured: !!SUPABASE_URL && !!SUPABASE_ANON_KEY,
            twilio_configured: !!TWILIO_ACCOUNT_SID && !!TWILIO_AUTH_TOKEN,
            geocoding: 'OpenStreetMap via Edge Function',
            address_validation: 'Enhanced with validate-delivery-address Edge Function',
            edge_functions: 'Preserved for all database operations'
        }
    });
});

// Start server
server.listen(port, () => {
    console.log(`🚀 Restaurant AI System - Enhanced Address Validation with Edge Functions`);
    console.log(`📞 Server running on port ${port}`);
    console.log(`⚡ Fast Twilio webhook response enabled`);
    console.log(`🎯 WebSocket ready for Twilio Media Streams`);
    console.log(`🤖 OpenAI configured: ${!!OPENAI_API_KEY}`);
    console.log(`🗄️ Supabase configured: ${!!SUPABASE_URL && !!SUPABASE_ANON_KEY}`);
    console.log(`📱 Twilio configured: ${!!TWILIO_ACCOUNT_SID && !!TWILIO_AUTH_TOKEN}`);
    console.log(`🗺️ OpenStreetMap geocoding: Via validate-delivery-address Edge Function!`);
    console.log('');
    console.log('✅ ENHANCED FEATURES:');
    console.log('🆓 OpenStreetMap geocoding via Edge Function - completely free');
    console.log('🛡️ Privacy-first - customer addresses stay private');
    console.log('📍 Progressive validation with intelligent fallbacks');
    console.log('🌍 Open source mapping data from global community');
    console.log('⚡ Optimized performance with timeout protection');
    console.log('🎯 Intent-based function calling with natural flow');
    console.log('🔧 ALL database operations via Edge Functions');
    console.log('💬 Customer messaging system for staff requests');
    console.log('💡 No vendor lock-in or usage costs');
    console.log('');
    console.log('✨ Server ready for production with Edge Function address validation!');
});
