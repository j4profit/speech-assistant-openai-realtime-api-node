// Restaurant AI Ordering System - Complete Multi-Tenant Voice Agent - ALL EDGE FUNCTIONS
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

// Initialize Supabase client (only for Edge Function calls)
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
    
    // Create initial call log with all webhook data using Edge Function
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

// API endpoint to get recent orders - using Edge Function
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

// API endpoint to get customer messages - you'll need to implement this Edge Function
app.get('/messages', async (req, res) => {
    try {
        // Note: You may need to create a search-messages Edge Function for this
        // For now, using direct query but should be replaced with Edge Function
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
async function searchRecentOrders(phoneNumber, restaurantId, daysBack = 7, statusFilter = null) {
    try {
        console.log('Searching orders for phone:', phoneNumber, 'restaurant:', restaurantId, 'status filter:', statusFilter);
        
        const requestBody = {
            phone_number: phoneNumber,
            restaurant_id: restaurantId,
            days_back: daysBack
        };

        const response = await fetch('https://ujgpqnarhcegrpyzbxej.supabase.co/functions/v1/search-orders', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
            },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            console.error('search-orders Edge Function failed:', response.status);
            return [];
        }

        const result = await response.json();
        console.log('Search orders result:', result);
        
        const orders = result.orders || [];
        console.log(`Found ${orders.length} orders for phone ${phoneNumber}`);
        
        return orders;
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

// Create order using Edge Function instead of direct Supabase call
async function createOrder(orderData) {
    try {
        console.log('Creating order using Edge Function:', orderData);

        const response = await fetch('https://ujgpqnarhcegrpyzbxej.supabase.co/functions/v1/create-order', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
            },
            body: JSON.stringify(orderData)
        });

        if (!response.ok) {
            console.error('create-order Edge Function response not ok:', response.status);
            return null;
        }

        const result = await response.json();
        
        if (result.error) {
            console.error('create-order Edge Function returned error:', result.error);
            return null;
        }

        console.log('Order created successfully:', result.data?.id);
        return result.data;
    } catch (error) {
        console.error('Error calling create-order Edge Function:', error);
        return null;
    }
}

// Create customer message using Edge Function
async function createCustomerMessage(messageData) {
    try {
        console.log('Creating customer message using Edge Function:', messageData);

        const response = await fetch('https://ujgpqnarhcegrpyzbxej.supabase.co/functions/v1/create-message', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
            },
            body: JSON.stringify(messageData)
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

        console.log('Customer message created successfully:', result.data?.id || result.message_id);
        return result.data || result;
    } catch (error) {
        console.error('Error calling create-message Edge Function:', error);
        return null;
    }
}

// Create restaurant message for non-pending order requests or customer messages
async function createRestaurantMessage(customerPhone, customerName, restaurant, orderReference, requestDetails, messageType = 'order_modification_request') {
    try {
        let subject, messageContent, priority;
        
        if (messageType === 'customer_message') {
            subject = 'Customer Message';
            messageContent = `Customer ${customerName || 'Unknown'} (${customerPhone}) has sent a message:\n\n${requestDetails}`;
            priority = 'normal';
        } else {
            subject = 'Customer Order Modification Request';
            messageContent = `Customer ${customerName || 'Unknown'} (${customerPhone}) is requesting changes to an order that is already in progress.\n\nOrder Reference: ${orderReference}\n\nRequest Details: ${requestDetails}\n\nThis order is beyond the pending status and requires restaurant attention.`;
            priority = 'high';
        }

        const messageData = {
            restaurant_id: restaurant.id,
            customer_phone: customerPhone,
            customer_name: customerName || 'Unknown Customer',
            message_type: messageType,
            subject: subject,
            message_content: messageContent,
            call_sid: null,
            order_reference: orderReference,
            priority: priority
        };

        console.log('Creating restaurant message:', messageData);

        const response = await fetch('https://ujgpqnarhcegrpyzbxej.supabase.co/functions/v1/create-message', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
            },
            body: JSON.stringify(messageData)
        });

        if (!response.ok) {
            console.error('Restaurant message creation failed:', response.status);
            return null;
        }

        const result = await response.json();
        console.log('Restaurant message created successfully:', result.message_id || result.data?.id);
        return result;
    } catch (error) {
        console.error('Error creating restaurant message:', error);
        return null;
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
    let initialOrderSearchCompleted = false; // Track if we've done initial search
    
    // Address validation state tracking
    let addressValidationCompleted = false;
    let lastValidationResult = null;
    let lastValidatedAddress = null;
    let addressValidationPending = false;

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

**CRITICAL ORDER MODIFICATION RULES:**
- ONLY orders with status "pending" can be modified or cancelled directly
- Orders with status "confirmed", "preparing", "ready", or "delivered" CANNOT be changed directly
- If customer has non-pending orders, say: "I see you have orders that are already being prepared. I've sent a message to the restaurant about your request. Since the restaurant is quite busy, it may take some time for them to get back to you, but they will review your message and contact you as soon as possible."

**CRITICAL ORDER MODIFICATION FLOW:**
When customer mentions wanting to change/modify/cancel an order:
1. AUTOMATICALLY call search_recent_orders WITHOUT asking for phone number first
2. The system will automatically search using their caller ID (${customerPhone})
3. ONLY if no orders are found, then ask: "I don't see any recent orders from this number. What phone number did you use when placing the order?"
4. If PENDING orders ARE found, immediately tell them about their order(s) and ask what they'd like to change
5. If only NON-PENDING orders are found, automatically create a message to the restaurant and inform customer
6. If customer wants to leave additional details or has other concerns, use send_message_to_restaurant function

**CRITICAL ADDRESS VALIDATION TIMING RULES - MUST FOLLOW EXACTLY:**

1. NEVER call validate_delivery_address function immediately after asking for address
2. NEVER call validate_delivery_address until customer provides address details  
3. When customer provides address, IMMEDIATELY call validate_delivery_address function
4. If validation succeeds, IMMEDIATELY create ORDER_CONFIRMED format - DO NOT ask for confirmation
5. DO NOT say "It seems there might be an issue" when validation is successful

**EXACT CONVERSATION FLOW:**
- Ask: "Could you please provide the delivery address?"
- Customer provides address: "7805 Old Harford Road, Parkville, Maryland, 21234"
- IMMEDIATELY call validate_delivery_address function
- If validation returns valid: true, proceed_to_order: true → CREATE ORDER_CONFIRMED FORMAT IMMEDIATELY
- DO NOT ask customer to confirm address after successful validation

**FORBIDDEN PHRASES AFTER SUCCESSFUL VALIDATION:**
- "It seems there might be an issue with the address"
- "Could you please confirm the address"
- "Let's make sure we have all the details"
- "Is this address correct?"

CRITICAL ORDER FLOW (Follow this EXACT sequence):
1. Get customer name first
2. SMART Order Type Detection:
   - If customer says "delivery", "deliver", "delivered", "put a delivery order" → DELIVERY CONFIRMED, skip to step 3
   - If customer says "pickup", "pick up", "pick it up" → PICKUP CONFIRMED, skip to step 4  
   - If unclear, ask: "Would you like this for pickup or delivery?"
3. FOR DELIVERY: Get their order items first, then get complete address
4. FOR PICKUP: Get their order items, then create ORDER_CONFIRMED
5. Create ORDER_CONFIRMED format IMMEDIATELY after getting all required info

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

CRITICAL TIMING RULE: After successful address validation, proceed IMMEDIATELY to ORDER_CONFIRMED format. Do NOT ask for confirmation.`;

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
                            description: "Search for recent orders. The system automatically uses the caller's phone number first. Only provide phone_number parameter if customer gives a different number.",
                            parameters: {
                                type: "object",
                                properties: {
                                    phone_number: { 
                                        type: "string", 
                                        description: "Phone number to search for orders - only use if customer provides a different number than their caller ID"
                                    }
                                },
                                required: []
                            }
                        },
                        {
                            type: "function",
                            name: "validate_delivery_address",
                            description: "Validate delivery address - ONLY call this when customer has provided what looks like a complete address with street number, street name, city, state, zip. CRITICAL: Call this IMMEDIATELY when customer provides address details.",
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
                            description: "Cancel an existing PENDING order only",
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
                            description: "Update an existing PENDING order only",
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
                            name: "send_message_to_restaurant", 
                            description: "Send a message to the restaurant for non-pending orders or general inquiries",
                            parameters: {
                                type: "object",
                                properties: {
                                    customer_name: { type: "string", description: "Customer's name" },
                                    message_content: { type: "string", description: "The message content from the customer" },
                                    order_reference: { type: "string", description: "Order ID if related to a specific order" },
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
                        
                        // Process order only after successful validation and not during modification calls
                        if (response.transcript.includes('ORDER_CONFIRMED:') && !isModificationCall && !orderProcessed) {
                            processOrderFromTranscript(response.transcript);
                        }
                        
                        // Update call log when order is successfully created
                        if (response.transcript.includes('ORDER_CONFIRMED:') && callSid) {
                            setTimeout(async () => {
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
                        
                        const customerMessage = response.transcript.trim();
                        
                        // Auto-search for orders when customer mentions modification
                        const modificationKeywords = /\b(change|modify|cancel|update|alter|edit)\s+(my\s+)?order\b/i;
                        if (modificationKeywords.test(customerMessage) && !initialOrderSearchCompleted) {
                            console.log('Customer wants to modify order, auto-searching...');
                            initialOrderSearchCompleted = true;
                            
                            // Trigger automatic search using caller ID
                            setTimeout(() => {
                                if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                                    // Send function call to search with caller ID
                                    openaiWs.send(JSON.stringify({
                                        type: 'conversation.item.create',
                                        item: {
                                            type: 'function_call',
                                            name: 'search_recent_orders',
                                            call_id: 'auto_search_' + Date.now(),
                                            arguments: JSON.stringify({}) // Use caller ID automatically
                                        }
                                    }));
                                }
                            }, 500);
                        }
                        
                        // Check if customer provided address and trigger validation
                        const hasAddressPattern = /\d+.*?(street|road|avenue|lane|drive|way|court|place|boulevard|blvd|ave|rd|st|ct|pl|ln|dr|maryland|md)/i.test(customerMessage);
                        
                        if (hasAddressPattern && !addressValidationInProgress && !addressValidationPending) {
                            console.log('Customer provided address, marking for validation:', customerMessage);
                            addressValidationPending = true;
                        }

                        // Create customer message record
                        if (restaurant && customerMessage && customerMessage.length > 3) {
                            const messageData = {
                                restaurant_id: restaurant.id,
                                customer_phone: customerPhone,
                                customer_name: 'Unknown',
                                message_type: 'voice_call',
                                subject: 'Voice Call Message',
                                message_content: customerMessage,
                                call_sid: callSid,
                                order_reference: null,
                                priority: 'normal'
                            };
                            
                            // Create customer message using Edge Function
                            createCustomerMessage(messageData).catch(error => {
                                console.error('Failed to create customer message:', error);
                            });
                        }
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

    // Enhanced function call handler with pending and non-pending order processing
    async function handleFunctionCall(functionCall) {
        try {
            const { name, call_id, arguments: args } = functionCall;
            let result = null;
            let parsedArgs = {};

            console.log(`Executing function: ${name} with args:`, args);

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
                    // Always try caller ID first, then provided number
                    let phoneNumber = customerPhone; // Start with caller ID
                    
                    // Only use provided phone number if it's different from caller ID
                    if (parsedArgs.phone_number && parsedArgs.phone_number !== customerPhone) {
                        phoneNumber = parsedArgs.phone_number;
                        console.log('Using provided phone number instead of caller ID:', phoneNumber);
                    } else {
                        console.log('Using caller ID for order search:', phoneNumber);
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
                    
                    console.log(`Found ${orders.length} orders for phone ${phoneNumber}`);
                    
                    // Separate pending and non-pending orders
                    const pendingOrders = orders.filter(order => order.status === 'pending');
                    const nonPendingOrders = orders.filter(order => order.status !== 'pending');
                    
                    if (orders.length === 0 && phoneNumber === customerPhone) {
                        // No orders found with caller ID - suggest asking for different number
                        result = {
                            orders: [],
                            count: 0,
                            message: 'No recent orders found for this phone number. If you placed the order using a different phone number, please let me know what number you used.',
                            phone_searched: phoneNumber,
                            suggest_different_number: true
                        };
                    } else if (pendingOrders.length > 0) {
                        // Has pending orders - can modify these
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
                        // Only has non-pending orders - create message for restaurant
                        const latestOrder = nonPendingOrders[0]; // Most recent non-pending order
                        const customerName = latestOrder.customer_name || 'Unknown Customer';
                        
                        // Create restaurant message about the modification request
                        await createRestaurantMessage(
                            phoneNumber, 
                            customerName, 
                            restaurant, 
                            latestOrder.id,
                            'Customer called requesting order modifications but order is already in progress',
                            'order_modification_request'
                        );

                        result = {
                            orders: [],
                            count: 0,
                            message: `I found your order, but it's already being prepared (status: ${latestOrder.status}). I've sent a message to the restaurant about your request. Since the restaurant is quite busy, it may take some time for them to get back to you, but they will review your message and contact you as soon as possible.`,
                            phone_searched: phoneNumber,
                            has_non_pending_only: true,
                            restaurant_message_sent: true
                        };
                    } else {
                        // Fallback
                        result = {
                            orders: [],
                            count: 0,
                            message: 'No recent orders found for this phone number.',
                            phone_searched: phoneNumber
                        };
                    }
                    
                    // Mark as modification call if any orders found
                    if (orders.length > 0) {
                        isModificationCall = true;
                    }
                    break;

                case 'validate_delivery_address':
                    // Prevent multiple validations and handle caching
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
                    addressValidationPending = false; // Clear pending flag
                    let address = parsedArgs.address;
                    
                    // Enhanced address extraction if not provided directly
                    if (!address || address.trim().length < 5) {
                        console.log('No address in function call, extracting from conversation...');
                        address = extractAddressFromConversation(conversationTranscript);
                        console.log('Extracted address from conversation:', address);
                    }
                    
                    // Check if this is the same address we just validated successfully
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
                    
                    // Check if customer actually provided address info
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
                        // Cache successful validation
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
                        // Cache failed validation too
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
                        // Only use first order if it's pending
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
                    isModificationCall = true;
                    let orderId = parsedArgs.order_id;
                    
                    if (!orderId && recentOrders?.length > 0) {
                        // Only use first order if it's pending
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

                case 'send_message_to_restaurant':
                    // Allow customers to send messages for non-pending orders or general inquiries
                    const customerName = parsedArgs.customer_name || 'Unknown Customer';
                    const messageContent = parsedArgs.message_content;
                    const orderReference = parsedArgs.order_reference || null;
                    const subject = parsedArgs.subject || 'Customer Message';
                    
                    if (!messageContent) {
                        result = {
                            success: false,
                            error: 'Message content is required'
                        };
                        break;
                    }

                    // Create the restaurant message
                    const messageResult = await createRestaurantMessage(
                        customerPhone,
                        customerName,
                        restaurant,
                        orderReference,
                        messageContent
                    );

                    if (messageResult) {
                        result = {
                            success: true,
                            message: 'Your message has been sent to the restaurant. Since they are quite busy, it may take some time for them to get back to you, but they will review your message and contact you as soon as possible.',
                            message_id: messageResult.message_id || messageResult.data?.id
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
                    ready_time: timing.readyTimeString,
                    estimated_ready_at: timing.readyTime?.toISOString(),
                    items: [] // Will be processed by Edge Function
                };

                console.log('Creating order with data:', orderData);
                
                const order = await createOrder(orderData);
                if (order) {
                    console.log('NEW order saved successfully with ID:', order.id);
                    console.log('Order type:', order.order_type);
                    if (order.order_type === 'delivery') {
                        console.log('Delivery address:', order.delivery_address);
                    }
                    
                    // Clear validation state after successful order
                    capturedDeliveryAddress = null;
                    addressValidationCompleted = false;
                    lastValidationResult = null;
                    lastValidatedAddress = null;
                    addressValidationPending = false;
                    
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
