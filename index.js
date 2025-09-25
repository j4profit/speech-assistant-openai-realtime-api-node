// Restaurant AI Ordering System - Complete Multi-Tenant Voice Agent with Universal Hangup
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
const activeResponses = new Map(); // Track active OpenAI responses

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
// INTENT-BASED MESSAGE HANDLING
// =============================================================================

// Let OpenAI determine when messages need restaurant attention through function calls
// This removes pre-filtering and allows natural conversation flow

// =============================================================================
// UNIVERSAL HANGUP FUNCTION
// =============================================================================

/**
 * Universal hangup function that can be called from anywhere in the system
 * @param {string} callSid - The Twilio Call SID
 * @param {Object} options - Hangup options
 * @param {string} options.message - Custom goodbye message (optional)
 * @param {string} options.method - 'immediate' or 'graceful' (default: 'graceful')
 * @param {string} options.reason - Reason for hangup for logging
 * @param {Object} options.orderData - Order data for confirmation messages (optional)
 * @param {Object} options.restaurant - Restaurant data for personalized messages (optional)
 * @param {number} options.delay - Delay in milliseconds before hangup (default: 0)
 * @returns {Promise<Object>} - Result object with success status
 */
async function hangup(callSid, options = {}) {
    if (!callSid) {
        console.error('hangup() called without callSid');
        return { success: false, error: 'Missing callSid' };
    }

    if (!twilioClient) {
        console.error('hangup() called but Twilio client not configured');
        return { success: false, error: 'Twilio not configured' };
    }

    // Default options
    const {
        message = null,
        method = 'graceful',
        reason = 'system_initiated',
        orderData = null,
        restaurant = null,
        delay = 0
    } = options;

    console.log(`Hangup initiated: ${callSid} - Method: ${method}, Reason: ${reason}`);

    try {
        // Apply delay if specified
        if (delay > 0) {
            console.log(`Delaying hangup by ${delay}ms`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }

        // Immediate hangup via REST API
        if (method === 'immediate') {
            const call = await twilioClient.calls(callSid).update({
                status: 'completed'
            });
            
            console.log(`Call terminated immediately: ${callSid}`);
            return {
                success: true,
                method: 'immediate',
                reason: reason,
                call_sid: callSid
            };
        }

        // Graceful hangup with TwiML
        if (method === 'graceful') {
            let finalMessage = message;

            // Only use fallback if no message provided - let OpenAI handle context-specific messages
            if (!finalMessage) {
                // Simple fallback - OpenAI should provide context-appropriate messages
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

            // Redirect call to hangup endpoint
            const hangupUrl = BASE_URL ? 
                `${BASE_URL}/hangup-twiml?call_sid=${callSid}` : 
                `https://speech-assistant-openai-realtime-api-node-ddc4.onrender.com/hangup-twiml?call_sid=${callSid}`;
            const call = await twilioClient.calls(callSid).update({
                url: hangupUrl,
                method: 'POST'
            });

            console.log(`Call redirected to graceful hangup: ${callSid}`);
            console.log(`Hangup message: ${finalMessage}`);

            return {
                success: true,
                method: 'graceful',
                reason: reason,
                message: finalMessage,
                call_sid: callSid
            };
        }

        // Invalid method
        console.error(`Invalid hangup method: ${method}`);
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

// Convenience hangup functions
async function hangupAfterOrder(callSid, orderData, restaurant, delay = 3000) {
    return await hangup(callSid, {
        method: 'graceful',
        reason: 'order_completed',
        orderData: orderData,
        restaurant: restaurant,
        delay: delay
    });
}

async function hangupAfterCancellation(callSid, restaurant, delay = 2000) {
    return await hangup(callSid, {
        method: 'graceful',
        reason: 'order_cancelled',
        restaurant: restaurant,
        delay: delay
    });
}

async function hangupAfterModification(callSid, restaurant, delay = 2000) {
    return await hangup(callSid, {
        method: 'graceful',
        reason: 'order_modified',
        restaurant: restaurant,
        delay: delay
    });
}

async function hangupOnError(callSid, errorMessage = null, immediate = false) {
    return await hangup(callSid, {
        method: immediate ? 'immediate' : 'graceful',
        reason: 'error',
        message: errorMessage || 'We apologize for the technical difficulty. Please try calling again.'
    });
}

async function hangupOnCustomerRequest(callSid, restaurant) {
    return await hangup(callSid, {
        method: 'graceful',
        reason: 'customer_request',
        restaurant: restaurant
    });
}

async function hangupOnTimeout(callSid, restaurant) {
    return await hangup(callSid, {
        method: 'graceful',
        reason: 'timeout',
        restaurant: restaurant,
        message: `Thank you for calling ${restaurant?.name || 'us'}. If you need further assistance, please call back.`
    });
}

// =============================================================================
// HTTP ENDPOINTS
// =============================================================================

// Hangup TwiML endpoint
app.post('/hangup-twiml', (req, res) => {
    const callSid = req.query.call_sid || req.body.CallSid;
    
    let message = 'Thank you for calling. Goodbye!';
    
    // Retrieve stored message
    if (global.pendingHangupTwiML?.[callSid]) {
        message = global.pendingHangupTwiML[callSid].message;
        // Clean up stored TwiML
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
        twilio_configured: !!twilioClient,
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
            console.error('lookup-order Edge Function failed:', response.status);
            return [];
        }

        const result = await response.json();
        console.log('Search orders result:', result);
        
        const orders = result.orders || [];
        console.log(`Found ${orders.length} orders for phone ${phoneNumber}`);
        
        return orders;
    } catch (error) {
        console.error('Error calling lookup-order Edge Function:', error);
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
        
        const response = await fetch('https://ujgpqnarhcegrpyzbxej.supabase.co/functions/v1/validate-delivery-address', {
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
        console.error('Error calling validate-delivery-address Edge Function:', error);
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

        const response = await fetch('https://ujgpqnarhcegrpyzbxej.supabase.co/functions/v1/save-order', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
            },
            body: JSON.stringify(orderData)
        });

        if (!response.ok) {
            console.error('save-order Edge Function response not ok:', response.status);
            return null;
        }

        const result = await response.json();
        
        if (result.error) {
            console.error('save-order Edge Function returned error:', result.error);
            return null;
        }

        console.log('Order created successfully:', result.data?.id);
        return result.data;
    } catch (error) {
        console.error('Error calling save-order Edge Function:', error);
        return null;
    }
}

// Create customer message using Edge Function
async function createCustomerMessage(messageData) {
    try {
        console.log('Creating customer message using Edge Function:', messageData);

        const response = await fetch('https://ujgpqnarhcegrpyzbxej.supabase.co/functions/v1/save-message', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
            },
            body: JSON.stringify(messageData)
        });

        if (!response.ok) {
            console.error('save-message Edge Function response not ok:', response.status);
            return null;
        }

        const result = await response.json();
        
        if (result.error) {
            console.error('save-message Edge Function returned error:', result.error);
            return null;
        }

        console.log('Customer message created successfully:', result.data?.id || result.message_id);
        return result.data || result;
    } catch (error) {
        console.error('Error calling save-message Edge Function:', error);
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

        const response = await fetch('https://ujgpqnarhcegrpyzbxej.supabase.co/functions/v1/save-message', {
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
    let customerName = null; // Track customer name throughout call
    let currentOrderType = null; // Track whether pickup or delivery
    let collectedItems = []; // Track items being ordered
    let anythingElseTimeout = null; // Track timeout for anything else question
    let completionMessageSent = false; // Track if we've sent completion message
    
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
            // Hangup on error if no restaurant found
            await hangupOnError(callId, 'Sorry, we are unable to process your call at this time. Please try again later.');
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

**NATURAL CONVERSATION FLOW:**
- Handle all conversations naturally and conversationally
- You have access to functions when needed, but let conversation flow naturally
- Use functions based on actual customer intent and context, not rigid rules

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
5. If only NON-PENDING orders are found, automatically call send_message_to_restaurant and inform customer
6. If customer wants to leave additional details or has other concerns, use send_message_to_restaurant function

**NEW ORDER FLOW - FOLLOW THIS EXACT SEQUENCE:**

1. **CUSTOMER NAME FIRST**: Always ask "Can I get your name for the order?" before anything else for new orders

2. **ORDER TYPE DETECTION**: 
   - If customer says "delivery", "deliver", "delivered", "delivery order" → DELIVERY CONFIRMED, skip to step 3
   - If customer says "pickup", "pick up", "pick it up", "pickup order" → PICKUP CONFIRMED, skip to step 4  
   - If unclear, ask: "Would you like this for pickup or delivery?"

3. **FOR DELIVERY ORDERS**:
   - Get order items FIRST
   - THEN ask for delivery address: "What's your delivery address?"
   - When customer provides address, IMMEDIATELY call validate_delivery_address
   - If validation succeeds, create ORDER_CONFIRMED immediately
   - If validation fails, ask for corrected address or suggest pickup

4. **FOR PICKUP ORDERS**:
   - Get order items
   - NEVER call validate_delivery_address for pickup orders
   - Create ORDER_CONFIRMED immediately after getting items

**CRITICAL VALIDATION RULES:**
- NEVER call validate_delivery_address for pickup orders
- ONLY call validate_delivery_address when order type is "delivery" AND customer has provided an address
- DO NOT call validate_delivery_address until customer provides address details

**ORDER_CONFIRMED FORMAT** (Create THIS EXACT format when ready):
ORDER_CONFIRMED:
- Customer Name: [actual customer name]
- Phone: ${customerPhone || '[phone]'}
- Order Type: [delivery or pickup]
- Delivery Address: [complete validated address for delivery, or N/A for pickup]
- Items: [items with individual prices like "Large Pepperoni Pizza - $18.99"]
- Special Instructions: [instructions or None]
- Total: $[total amount]
- Ready Time: [estimated minutes for pickup or delivery]
ORDER_END

**IMPORTANT**: Only create ORDER_CONFIRMED after you have:
- Customer name
- Order type (pickup or delivery)
- Items ordered
- For delivery: validated address
- For pickup: just the above items

**CALL COMPLETION FLOW**: 
After successfully completing an order, cancellation, modification, or sending a message:
1. Confirm the completed action
2. Ask: "You're all set! Is there anything else I can help you with today?"  
3. If customer says "no", "nothing", "that's all", "I'm good", "I'm all set", "no thank you", "no thanks", "all good", "nope", "nah", "that's it" etc. - the system will automatically hang up gracefully
4. If customer asks for something else - help them with their new request
5. If no response for 8 seconds after asking "anything else" - automatically hang up with goodbye message

**IMPORTANT**: Do NOT use the hangup_call function after completing orders/tasks. Let the natural "anything else" flow handle call completion.`;

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
                            description: "CRITICAL: ONLY call this for DELIVERY orders when customer has provided a complete address. NEVER call for pickup orders.",
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
                            name: "create_customer_message",
                            description: "Create a message for restaurant staff when customers have issues, complaints, or special requests that need human attention",
                            parameters: {
                                type: "object",
                                properties: {
                                    customer_name: { type: "string", description: "Customer's name" },
                                    message_content: { type: "string", description: "The customer's message or concern" },
                                    priority: { 
                                        type: "string", 
                                        enum: ["high", "medium", "normal"],
                                        description: "Priority level based on urgency" 
                                    },
                                    subject: { type: "string", description: "Brief subject describing the issue" }
                                },
                                required: ["customer_name", "message_content", "priority"]
                            }
                        },
                        {
                            type: "function",
                            name: "send_message_to_restaurant", 
                            description: "Send a message to restaurant staff about order-related requests or customer needs",
                            parameters: {
                                type: "object",
                                properties: {
                                    customer_name: { type: "string", description: "Customer's name" },
                                    message_content: { type: "string", description: "The message content" },
                                    order_reference: { type: "string", description: "Order ID if related to a specific order" },
                                    subject: { type: "string", description: "Subject of the message" }
                                },
                                required: ["customer_name", "message_content"]
                            }
                        },
                        {
                            type: "function",
                            name: "hangup_call",
                            description: "End the call gracefully with a custom message after completing the customer's request",
                            parameters: {
                                type: "object",
                                properties: {
                                    message: { 
                                        type: "string", 
                                        description: "Goodbye message to say before hanging up" 
                                    },
                                    reason: {
                                        type: "string",
                                        description: "Reason for hangup: order_complete, order_cancelled, order_modified, customer_request, etc."
                                    }
                                },
                                required: ["message"]
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
                        
                        // Extract customer name from AI responses
                        if (!customerName && response.transcript.includes('Customer Name:')) {
                            const nameMatch = response.transcript.match(/Customer Name:\s*([^\n\r-]+)/);
                            if (nameMatch) {
                                customerName = nameMatch[1].trim();
                                console.log('Customer name captured:', customerName);
                            }
                        }
                        
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

                        // Check for completion phrases that should trigger "anything else" flow
                        const completionPhrases = [
                            'your order is confirmed',
                            'order has been confirmed',
                            'your order has been cancelled',
                            'order cancelled successfully',
                            'order has been updated',
                            'message has been sent'
                        ];
                        
                        const isCompletionPhrase = completionPhrases.some(phrase => 
                            response.transcript.toLowerCase().includes(phrase)
                        );
                        
                        // Only trigger if it's a completion phrase AND we haven't already asked "anything else"
                        const alreadyAskedAnythingElse = conversationTranscript
                            .filter(msg => msg.speaker === 'AI')
                            .some(msg => msg.text.toLowerCase().includes('anything else'));
                        
                        if (isCompletionPhrase && !alreadyAskedAnythingElse && !completionMessageSent) {
                            completionMessageSent = true;
                            // Trigger "anything else" flow after order/task completion
                            setTimeout(() => {
                                if (openaiWs && openaiWs.readyState === WebSocket.OPEN && callSid) {
                                    console.log('Triggering "anything else" flow after completion');
                                    openaiWs.send(JSON.stringify({
                                        type: 'response.create',
                                        response: {
                                            modalities: ['audio', 'text'],
                                            instructions: 'Say: "You\'re all set! Is there anything else I can help you with today?"'
                                        }
                                    }));
                                    
                                    // Set timeout for no response - hangup after 8 seconds of silence
                                    anythingElseTimeout = setTimeout(async () => {
                                        if (callSid && ws.readyState === WebSocket.OPEN) {
                                            console.log('No response to "anything else" - hanging up');
                                            await hangup(callSid, {
                                                method: 'graceful',
                                                reason: 'no_response_to_anything_else',
                                                restaurant: restaurant,
                                                message: `Thank you for calling ${restaurant.name}. Have a great day!`
                                            });
                                        }
                                    }, 8000);
                                }
                            }, 1500); // Give a moment after completion statement
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
                        
                        // Extract customer name from conversation
                        if (!customerName && !isModificationCall) {
                            // Look for name patterns in responses to name questions
                            const namePatterns = [
                                /my name is (\w+)/i,
                                /I'm (\w+)/i,
                                /this is (\w+)/i,
                                /(\w+) here/i
                            ];
                            
                            const lastAIMessage = conversationTranscript
                                .filter(msg => msg.speaker === 'AI')
                                .slice(-1)[0]?.text || '';
                            
                            if (lastAIMessage.toLowerCase().includes('name')) {
                                for (let pattern of namePatterns) {
                                    const match = customerMessage.match(pattern);
                                    if (match) {
                                        customerName = match[1].trim();
                                        console.log('Customer name extracted:', customerName);
                                        break;
                                    }
                                }
                            }
                        }
                        
                        // Enhanced detection for "no" responses to "anything else" question
                        const anythingElseResponses = /\b(no|nope|nothing|that's all|that's it|i'm good|i'm all good|i'm all set|no thank you|no thanks|all good|good|nah|we're good|i'm done)\b/i;
                        const lastAIMessage = conversationTranscript
                            .filter(msg => msg.speaker === 'AI')
                            .slice(-1)[0]?.text || '';
                        
                        if (anythingElseResponses.test(customerMessage) && 
                            lastAIMessage.toLowerCase().includes('anything else')) {
                            console.log('Customer responded "no" to anything else question - initiating hangup');
                            
                            // Customer said no to anything else, hangup gracefully
                            setTimeout(async () => {
                                if (callSid && ws.readyState === WebSocket.OPEN) {
                                    console.log('Executing hangup for customer finished response');
                                    await hangup(callSid, {
                                        method: 'graceful',
                                        reason: 'customer_finished',
                                        restaurant: restaurant,
                                        message: `Perfect! Thank you for calling ${restaurant.name}. Have a wonderful day!`
                                    });
                                }
                            }, 2000); // Increased delay to let AI finish speaking
                            return; // Stop processing this message further
                        }
                        // Let OpenAI handle all conversation naturally - no forced function calls
                        break;
                        
                    case 'input_audio_buffer.speech_started':
                        console.log('Customer started speaking');
                        // Clear timeout when customer starts speaking
                        if (anythingElseTimeout) {
                            clearTimeout(anythingElseTimeout);
                            anythingElseTimeout = null;
                        }
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
                        
                        // Handle specific error types
                        if (response.error?.code === 'conversation_already_has_active_response') {
                            console.log('Response collision detected - ignoring (these are expected)');
                        } else {
                            console.error('Unexpected OpenAI error:', response.error);
                            // Hangup on critical errors only
                            setTimeout(async () => {
                                if (callSid) {
                                    await hangupOnError(callSid, 'We are experiencing technical difficulties. Please try calling again.');
                                }
                            }, 1000);
                        }
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
                // Hangup on processing errors
                setTimeout(async () => {
                    if (callSid) {
                        await hangupOnError(callSid);
                    }
                }, 1000);
            }
        });
        
        openaiWs.on('error', async (error) => {
            console.error('OpenAI WebSocket error:', error);
            if (callSid) {
                await hangupOnError(callSid, 'We are experiencing technical difficulties. Please try calling again.');
            }
        });
        
        openaiWs.on('close', () => {
            console.log('OpenAI connection closed');
        });
    }

    // Enhanced function call handler with hangup integration
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
                case 'hangup_call':
                    console.log('AI requested hangup:', parsedArgs);
                    const hangupMessage = parsedArgs.message || 'Thank you for calling. Have a great day!';
                    const hangupReason = parsedArgs.reason || 'ai_initiated';
                    
                    // Hangup with the provided message and reason
                    const hangupResult = await hangup(callSid, {
                        method: 'graceful',
                        reason: hangupReason,
                        message: hangupMessage,
                        restaurant: restaurant,
                        delay: 1000 // Give a moment for the AI to finish speaking
                    });
                    
                    result = {
                        success: hangupResult.success,
                        message: 'Call will be terminated',
                        reason: hangupReason
                    };
                    break;

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
                    // CRITICAL: Prevent validation for pickup orders
                    if (currentOrderType === 'pickup') {
                        console.log('BLOCKING address validation for pickup order');
                        result = {
                            valid: false,
                            message: 'Address validation is not needed for pickup orders.',
                            pickup_order: true,
                            instruction: 'This is a pickup order. Do not validate address. Create ORDER_CONFIRMED immediately.'
                        };
                        break;
                    }

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

                case 'create_customer_message':
                    // Intent-based customer message creation - let AI decide when this is needed
                    const customerMessageData = {
                        restaurant_id: restaurant.id,
                        customer_phone: customerPhone,
                        customer_name: parsedArgs.customer_name || customerName || 'Unknown Customer',
                        message_type: 'voice_call_issue',
                        subject: parsedArgs.subject || 'Customer Issue - Voice Call',
                        message_content: parsedArgs.message_content,
                        call_sid: callSid,
                        order_reference: null,
                        priority: parsedArgs.priority || 'normal'
                    };

                    const customerMessageResult = await createCustomerMessage(customerMessageData);
                    
                    if (customerMessageResult) {
                        result = {
                            success: true,
                            message: 'I\'ve recorded your message and sent it to the restaurant. They will review it and get back to you as soon as possible.',
                            message_id: customerMessageResult.message_id || customerMessageResult.data?.id
                        };
                    } else {
                        result = {
                            success: false,
                            message: 'Sorry, there was an issue recording your message. Please try again or contact the restaurant directly.'
                        };
                    }
                    break;

                case 'send_message_to_restaurant':
                    // Handle order modification requests for non-pending orders
                    const messageCustomerName = parsedArgs.customer_name || customerName || 'Unknown Customer';
                    const messageContent = parsedArgs.message_content;
                    const orderReference = parsedArgs.order_reference || null;
                    const messageSubject = parsedArgs.subject || 'Customer Message';
                    
                    if (!messageContent) {
                        result = {
                            success: false,
                            error: 'Message content is required'
                        };
                        break;
                    }

                    // Create the restaurant message for order modifications
                    const messageResult = await createRestaurantMessage(
                        customerPhone,
                        messageCustomerName,
                        restaurant,
                        orderReference,
                        messageContent,
                        'order_modification_request'
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

            // Hangup on critical function call errors
            if (callSid && error.message.includes('critical')) {
                setTimeout(async () => {
                    await hangupOnError(callSid);
                }, 1000);
            }
        }
    }

    // Enhanced order processing with automatic hangup
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
                
                let extractedCustomerName = '';
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
                        extractedCustomerName = value;
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
                
                // Use extracted customer name or fallback to stored name
                const finalCustomerName = extractedCustomerName || customerName || 'Unknown Customer';
                
                // Validate required fields
                if (!finalCustomerName || finalCustomerName === 'Unknown Customer') {
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
                    customer_name: finalCustomerName,
                    total_amount: totalAmount || 0,
                    order_type: orderType,
                    delivery_address: deliveryAddress,
                    order_details: `Customer: ${finalCustomerName}\nPhone: ${customerPhone}\nOrder Type: ${orderType}\n${orderType === 'delivery' ? `Delivery Address: ${deliveryAddress}` : 'Pickup Order'}\nItems: ${items}\nSpecial Instructions: ${specialInstructions || 'None'}\nEstimated ${orderType === 'delivery' ? 'Delivery' : 'Pickup'} Time: ${timing.totalMinutes} minutes`,
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

                    // AUTO-HANGUP replaced with "ANYTHING ELSE" flow after successful order creation
                    setTimeout(() => {
                        if (openaiWs && openaiWs.readyState === WebSocket.OPEN && callSid) {
                            console.log('Order completed - triggering "anything else" flow');
                            openaiWs.send(JSON.stringify({
                                type: 'response.create',
                                response: {
                                    modalities: ['audio', 'text'],
                                    instructions: 'Say: "You\'re all set! Is there anything else I can help you with today?"'
                                }
                            }));
                        }
                    }, 3000); // Give AI time to confirm order first

                } else {
                    console.log('Order creation failed, resetting flag');
                    orderProcessed = false;
                    // Hangup on order creation failure
                    setTimeout(async () => {
                        await hangupOnError(callSid, 'Sorry, there was an issue processing your order. Please call back.');
                    }, 2000);
                }
            }
        } catch (error) {
            console.error('Error processing order:', error);
            orderProcessed = false;
            // Hangup on processing errors
            setTimeout(async () => {
                await hangupOnError(callSid);
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
            // Hangup on Twilio message processing errors
            setTimeout(async () => {
                if (callSid) {
                    await hangupOnError(callSid);
                }
            }, 1000);
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
    
    ws.on('error', async (error) => {
        console.error('Twilio WebSocket error:', error);
        // Hangup on WebSocket errors
        if (callSid) {
            await hangupOnError(callSid, 'We are experiencing technical difficulties. Please try calling again.');
        }
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
    console.log(`Server address: https://0.0.0.0:${PORT}`);
    console.log(`Ready to take orders and messages via phone calls`);
    console.log(`WebSocket ready for Twilio Media Streams`);
    console.log(`OpenAI configured: ${!!OPENAI_API_KEY}`);
    console.log(`Supabase configured: ${!!(SUPABASE_URL && SUPABASE_ANON_KEY)}`);
    console.log(`Twilio configured: ${!!twilioClient}`);
    console.log(`Multi-tenant delivery controls enabled`);
    console.log(`Enhanced address validation and error handling active`);
    console.log(`All Edge Functions integrated and active`);
    console.log(`FIXED: Automatic caller ID lookup for order modifications`);
    console.log(`FIXED: Only PENDING orders can be modified or cancelled`);
    console.log(`FIXED: Address validation only for delivery orders`);
    console.log(`FIXED: Customer name collection improved`);
    console.log(`FIXED: Order type detection and processing`);
    console.log(`NEW: Message system for non-pending orders instead of phone calls`);
    console.log(`NEW: Auto-search orders when modification keywords detected`);
    console.log(`NEW: Universal hangup system with automatic call completion`);
    console.log(`NEW: Graceful error handling with appropriate hangups`);
    console.log(`NEW: Intent-based customer messaging - OpenAI decides when messages need restaurant attention`);
    console.log(`IMPROVED: Natural conversation flow without pre-filtering`);
    console.log(`IMPROVED: AI-driven function calling based on customer intent`);
    console.log(`IMPROVED: OpenAI-driven farewell messages respect AI's context understanding`);
    
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
