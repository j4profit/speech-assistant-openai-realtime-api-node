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
app.post('/voice', (req, res) => {
    console.log('📞 Incoming call webhook:', req.body);
    
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

// Function to create order in database
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
            
RESTAURANT INFORMATION:
- Name: ${restaurant.name}
- Description: ${restaurant.description || ''}
- Hours: ${restaurant.hours || 'Call for hours'}
- Location: ${restaurant.address || ''}

${menuText}

INSTRUCTIONS:
1. Greet customers warmly and mention the restaurant name
2. Help customers browse the menu and answer questions about items
3. Take orders clearly - ask for quantities and any special requests
4. Confirm orders back to the customer including prices
5. Calculate totals accurately
6. Ask for customer information if needed (name, pickup time, etc.)
7. Be helpful, friendly, and efficient
8. If asked about items not on the menu, politely explain they're not available

When an order is confirmed, format it clearly for processing.
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
                        
                        // Check if this looks like a confirmed order
                        if (response.transcript.toLowerCase().includes('your order') && 
                            response.transcript.toLowerCase().includes('total')) {
                            processOrderFromTranscript(response.transcript);
                        }
                        break;
                        
                    case 'conversation.item.input_audio_transcription.completed':
                        console.log('👤 Customer said:', response.transcript);
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

    // Process order from AI transcript (simple pattern matching)
    async function processOrderFromTranscript(transcript) {
        try {
            console.log('📝 Processing potential order from transcript...');
            
            // This is a simplified order extraction
            // In production, you'd want more sophisticated parsing
            const orderData = {
                restaurant_id: restaurant.id,
                customer_phone: customerPhone,
                total_amount: 0, // You'd calculate this based on items
                order_details: transcript,
                special_instructions: '',
                call_sid: callSid,
                items: [] // You'd parse items from the transcript
            };

            const order = await createOrder(orderData);
            if (order) {
                console.log('🎉 Order saved successfully!');
            }
        } catch (error) {
            console.error('❌ Error processing order:', error);
        }
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
    
    ws.on('close', () => {
        console.log('📞 Twilio connection closed');
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
