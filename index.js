// Function to get restaurant data with direct database calls
async function getRestaurantByPhone(phoneNumber) {
    try {
        console.log('Looking up restaurant for phone:', phoneNumber);

        if (!phoneNumber || phoneNumber === '9999999999') {
            console.log('Invalid phone number provided');
            return null;
        }

        // Query restaurant using phone_number column
        const { data: restaurant, error } = await supabase
            .from('restaurants')
            .select('*')
            .eq('phone_number', phoneNumber)
            .single();

        console.log('Restaurant lookup result:', restaurant);
        console.log('Restaurant lookup error:', error);

        if (error || !restaurant) {
            console.log('Restaurant not found:', error?.message || 'No data returned');
            
            // Let's see all restaurants to debug
            const { data: allRestaurants } = await supabase
                .from('restaurants')
                .select('id, name, phone_number')
                .limit(5);
            
            console.log('Sample restaurants in database:', allRestaurants);
            return null;
        }

        // Try to get menu items separately to avoid relationship issues
        try {
            console.log('Fetching menu items for restaurant:', restaurant.id);
            const { data: menuItems, error: menuError } = await supabase
                .from('menu_items')
                .select('*')
                .eq('restaurant_id', restaurant.id);

            if (menuItems && !menuError) {
                restaurant.menu_items = menuItems.map(item => ({
                    ...item,
                    category: 'General' // Default category for now
                }));
                console.log(`Found ${menuItems.length} menu items`);
            } else {
                console.log('Menu items error or none found:', menuError);
                restaurant.menu_items = [];
            }
        } catch (menuErr) {
            console.log('Exception getting menu items:', menuErr);
            restaurant.menu_items = [];
        }

        console.log('Restaurant found:', restaurant.name);
        return restaurant;

    } catch (error) {
        console.error('Error fetching restaurant:', error);
        console.error('Error stack:', error.stack);
        return null;
    }
}// Restaurant AI Ordering System with Edge Functions Integration
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
        from_number: req.body.From || req.body.Caller || '9999999999',
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
    
    // Look up restaurant using edge function
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
            <Parameter name="From" value="${req.body.From || req.body.Caller || '9999999999'}" />
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

// Function to get restaurant data with direct database calls
async function getRestaurantByPhone(phoneNumber) {
    try {
        console.log('Looking up restaurant for phone:', phoneNumber);

        if (!phoneNumber || phoneNumber === '9999999999') {
            console.log('Invalid phone number provided');
            return null;
        }

        // First, let's see what columns actually exist
        console.log('Checking what columns exist in restaurants table...');
        
        // Try different possible column names for phone
        const possiblePhoneColumns = ['phone', 'phone_number', 'contact_phone', 'number'];
        let restaurant = null;
        let workingPhoneColumn = null;

        // First try to get any restaurant to see the structure
        const { data: sampleRestaurants, error: sampleError } = await supabase
            .from('restaurants')
            .select('*')
            .limit(1);

        console.log('Sample restaurant data:', sampleRestaurants);
        console.log('Sample error:', sampleError);

        if (sampleRestaurants && sampleRestaurants.length > 0) {
            console.log('Restaurant table columns:', Object.keys(sampleRestaurants[0]));
        }

        // Try different phone column names
        for (const phoneCol of possiblePhoneColumns) {
            try {
                console.log(`Trying phone column: ${phoneCol}`);
                const { data: result, error } = await supabase
                    .from('restaurants')
                    .select('*')
                    .eq(phoneCol, phoneNumber)
                    .single();

                if (!error && result) {
                    console.log(`Found restaurant using column: ${phoneCol}`);
                    restaurant = result;
                    workingPhoneColumn = phoneCol;
                    break;
                } else if (error) {
                    console.log(`Error with column ${phoneCol}:`, error.message);
                }
            } catch (err) {
                console.log(`Exception with column ${phoneCol}:`, err.message);
                continue;
            }
        }

        if (!restaurant) {
            console.log('No restaurant found with any phone column variations');
            
            // Let's try a broader search - maybe the phone format is different
            const { data: allRestaurants, error: allError } = await supabase
                .from('restaurants')
                .select('*');

            console.log('All restaurants in database:', allRestaurants);
            
            if (allRestaurants && allRestaurants.length > 0) {
                console.log('Available restaurants:', allRestaurants.map(r => ({
                    id: r.id,
                    name: r.name,
                    phone_related_fields: Object.keys(r).filter(key => 
                        key.toLowerCase().includes('phone') || 
                        key.toLowerCase().includes('number') ||
                        key.toLowerCase().includes('contact')
                    ).map(key => ({ [key]: r[key] }))
                })));
            }
            
            return null;
        }

        // Try to get menu items separately to avoid relationship issues
        try {
            console.log('Fetching menu items for restaurant:', restaurant.id);
            const { data: menuItems, error: menuError } = await supabase
                .from('menu_items')
                .select('*')
                .eq('restaurant_id', restaurant.id);

            if (menuItems && !menuError) {
                restaurant.menu_items = menuItems.map(item => ({
                    ...item,
                    category: 'General' // Default category for now
                }));
                console.log(`Found ${menuItems.length} menu items`);
            } else {
                console.log('Menu items error or none found:', menuError);
                restaurant.menu_items = [];
            }
        } catch (menuErr) {
            console.log('Exception getting menu items:', menuErr);
            restaurant.menu_items = [];
        }

        console.log('Restaurant found:', restaurant.name);
        return restaurant;

    } catch (error) {
        console.error('Error fetching restaurant:', error);
        console.error('Error stack:', error.stack);
        return null;
    }
}

// Function to create call log in database (stays local)
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

// Function to update call log when call ends (stays local)
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

// Function to search for recent orders with direct database calls
async function searchRecentOrders(phoneNumber, restaurantId, daysBack = 7) {
    try {
        console.log('Searching orders for phone:', phoneNumber, 'restaurant:', restaurantId);

        if (!phoneNumber || phoneNumber === '9999999999') {
            console.log('Invalid phone number provided');
            return [];
        }

        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - daysBack);

        // Search for pending orders
        const { data: orders, error } = await supabase
            .from('orders')
            .select(`
                id,
                customer_phone,
                customer_name,
                total_amount,
                status,
                order_type,
                order_details,
                special_instructions,
                created_at,
                updated_at,
                order_items(
                    id,
                    quantity,
                    price,
                    special_requests,
                    menu_items(
                        id,
                        name,
                        description,
                        price
                    )
                )
            `)
            .eq('customer_phone', phoneNumber)
            .eq('restaurant_id', restaurantId)
            .in('status', ['pending', 'confirmed', 'modified'])
            .gte('created_at', cutoffDate.toISOString())
            .order('created_at', { ascending: false });

        if (error) {
            console.error('Error searching orders:', error);
            return [];
        }

        console.log(`Found ${orders?.length || 0} orders for phone: ${phoneNumber}`);
        return orders || [];

    } catch (error) {
        console.error('Error searching orders:', error);
        return [];
    }
}

// Function to cancel an existing order (stays local for real-time response)
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
            .eq('status', 'pending')
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

// Function to update an existing order (stays local for real-time response)
async function updateOrder(orderId, updateData) {
    try {
        if (!orderId) {
            console.error('No order ID provided for update');
            return null;
        }
        
        console.log(`Updating order ${orderId} with:`, updateData);
        
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

        const modifications = updateData.modifications || '';
        const modLower = modifications.toLowerCase();
        
        let updatedOrderDetails = existingOrder.order_details || '';
        let newTotal = existingOrder.total_amount || 0;
        
        if (modLower.includes('add')) {
            const addedItems = modifications;
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
            
            if (itemsSection.length === 0) {
                itemsSection.push('Items:');
            }
            itemsSection.push(`- ${addedItems}`);
            
            if (updateData.new_total && updateData.new_total > 0) {
                newTotal = updateData.new_total;
            } else {
                const priceMatch = modifications.match(/\$(\d+\.?\d*)/);
                if (priceMatch) {
                    const addedPrice = parseFloat(priceMatch[1]);
                    newTotal = (existingOrder.total_amount || 0) + addedPrice;
                }
            }
            
            updatedOrderDetails = [
                ...customerInfo,
                ...itemsSection,
                ...otherInfo.filter(line => !line.toLowerCase().includes('special instructions:'))
            ].join('\n');
            
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
            updatedOrderDetails = updatedOrderDetails.replace(/Items:[\s\S]*?(?=\n[A-Z]|\n$)/m, 
                `Items:\n- ${modifications}`);
            
            if (updateData.new_total && updateData.new_total > 0) {
                newTotal = updateData.new_total;
            }
            
            const modificationNote = `MODIFIED: ${modifications} (${new Date().toLocaleString()})`;
            updatedOrderDetails = updatedOrderDetails.replace(
                /Special Instructions:.*$/m,
                `Special Instructions: ${modificationNote}`
            );
        } else {
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
            .in('status', ['pending', 'modified'])
            .select()
            .single();

        if (error) {
            console.error('Error updating order in database:', error);
            return null;
        }

        console.log('Order updated successfully in database:', orderId);
        return data;
    } catch (error) {
        console.error('Error in updateOrder function:', error);
        return null;
    }
}

// Function to create customer message with direct database calls
async function createCustomerMessage(messageData) {
    try {
        console.log('Creating customer message:', messageData);
        
        // Validate required fields
        if (!messageData.restaurant_id || !messageData.message_content) {
            console.error('Missing required fields for message creation');
            return null;
        }

        // Set defaults for missing fields
        const finalMessageData = {
            restaurant_id: messageData.restaurant_id,
            customer_phone: messageData.customer_phone || '9999999999',
            customer_name: messageData.customer_name || 'Unknown Customer',
            message_type: messageData.message_type || 'general',
            subject: messageData.subject || 'Customer Inquiry',
            message_content: messageData.message_content,
            priority: messageData.priority || 'normal',
            status: 'unread',
            call_sid: messageData.call_sid || null
        };

        // Insert the message
        const { data: message, error } = await supabase
            .from('customer_messages')
            .insert([finalMessageData])
            .select()
            .single();

        if (error) {
            console.error('Error creating message:', error);
            return null;
        }

        console.log('Message created successfully:', message.id);
        return message;

    } catch (error) {
        console.error('Error creating customer message:', error);
        return null;
    }
}

// Function to calculate distance (stays local for performance)
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 3959;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = 
        Math.sin(dLat/2) * Math.sin(dLat/2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
}

// Function to validate delivery address with direct database calls
async function validateDeliveryAddress(address, restaurant) {
    try {
        console.log('Validating delivery address:', address);
        
        if (!address || !restaurant) {
            return {
                valid: false,
                message: 'Address and restaurant information are required',
                address: null
            };
        }

        if (!restaurant.delivery_enabled) {
            return {
                valid: false,
                message: 'Delivery is not available for this restaurant',
                address: address
            };
        }

        // Basic address validation
        const hasStreetNumber = /\d+/.test(address);
        const hasStreetName = /(street|st|avenue|ave|road|rd|drive|dr|lane|ln|way|court|ct|place|pl|boulevard|blvd)/i.test(address);
        const hasZipCode = /\d{5}/.test(address);
        
        if (!hasStreetNumber || !hasStreetName) {
            return {
                valid: false,
                message: 'Please provide a complete street address with street number and name',
                address: address,
                needs_retry: true
            };
        }

        // Check delivery zones if they exist
        const { data: deliveryZones } = await supabase
            .from('delivery_zones')
            .select('*')
            .eq('restaurant_id', restaurant.id)
            .eq('active', true);

        if (deliveryZones && deliveryZones.length > 0) {
            // Check if address is in any delivery zone
            let inDeliveryZone = false;
            
            for (const zone of deliveryZones) {
                if (zone.zip_codes && hasZipCode) {
                    const addressZip = address.match(/\d{5}/)?.[0];
                    if (addressZip && zone.zip_codes.includes(addressZip)) {
                        inDeliveryZone = true;
                        break;
                    }
                }
                
                if (zone.cities && zone.cities.length > 0) {
                    for (const city of zone.cities) {
                        if (address.toLowerCase().includes(city.toLowerCase())) {
                            inDeliveryZone = true;
                            break;
                        }
                    }
                }
            }
            
            if (!inDeliveryZone) {
                return {
                    valid: false,
                    message: `Sorry, we don't deliver to that area. Our delivery radius is ${restaurant.delivery_radius_miles || 5} miles from the restaurant.`,
                    address: address
                };
            }
        }

        // If we get here, the address appears valid
        return {
            valid: true,
            message: 'Address is valid for delivery',
            address: address,
            delivery_fee: restaurant.delivery_fee || 0,
            estimated_time: '30-45 minutes'
        };

    } catch (error) {
        console.error('Error validating delivery address:', error);
        return {
            valid: false,
            message: 'Unable to validate address at this time',
            address: address
        };
    }
}

// Function to calculate pickup/delivery time (stays local)
function calculateOrderReadyTime(restaurant, isDelivery = false) {
    try {
        const now = new Date();
        const preparationMinutes = restaurant?.preparation_time || 20;
        const deliveryAddedMinutes = isDelivery ? (restaurant?.delivery_time || 15) : 0;
        
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
            preparationMinutes: totalMinutes,
            estimatedTime: `approximately ${totalMinutes} minutes`
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
            estimatedTime: 'approximately 30 minutes'
        };
    }
}

// Function to create order in database (stays local for real-time)
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
        
        const isDelivery = orderData.order_type === 'delivery';
        const timing = calculateOrderReadyTime(restaurantForTiming, isDelivery);
        
        orderData.ready_time = timing.readyTimeString;
        orderData.estimated_ready_at = timing.readyTime.toISOString();
        
        const { data: order, error: orderError } = await supabase
            .from('orders')
            .insert([{
                restaurant_id: orderData.restaurant_id,
                customer_phone: orderData.customer_phone || '9999999999',
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
        return order;
    } catch (error) {
        console.error('Error creating order:', error);
        return null;
    }
}

// Function to format menu for AI (stays local)
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

// WebSocket connection handler (STAYS THE SAME - CANNOT MOVE TO EDGE FUNCTIONS)
wss.on('connection', (ws, req) => {
    console.log('New WebSocket connection');
    
    let openaiWs = null;
    let streamSid = null;
    let callSid = null;
    let customerPhone = null;
    let restaurant = null;
    let callStartTime = new Date();
    let conversationTranscript = [];
    let orderProcessed = false;
    let messageProcessed = false;
    let recentOrders = [];
    let isModificationCall = false;
    let accumulatedMessageText = '';
    let capturedDeliveryAddress = null;

    // Initialize OpenAI connection with restaurant context
    async function initializeOpenAI(calledNumber, fromNumber, callId) {
        console.log('Loading restaurant data for:', calledNumber);
        
        // UPDATED: Changed fallback from +14108880091 to +19999999999
        const phoneToLookup = calledNumber || '+19999999999';
        console.log('Using phone number for lookup:', phoneToLookup);
        
        restaurant = await getRestaurantByPhone(phoneToLookup);
        
        if (!restaurant) {
            console.error('Restaurant not found for phone:', phoneToLookup);
            return;
        }

        console.log('Restaurant loaded:', restaurant.name);
        customerPhone = fromNumber || '9999999999';
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

CRITICAL CONVERSATION RULES:
1. KEEP RESPONSES SHORT AND CONCISE - no more than 2-3 sentences at a time
2. WAIT for customers to finish speaking completely before responding
3. If unclear what customer wants, ask ONE clarifying question at a time
4. Don't repeat information unless asked
5. Let the customer lead the conversation pace

CALLER INFORMATION:
- Caller's phone number: ${customerPhone}
- Last 4 digits of caller's number: ${customerPhone ? customerPhone.slice(-4) : 'unknown'}

RESTAURANT INFORMATION:
- Name: ${restaurant.name}
- Description: ${restaurant.description || ''}
- Hours: ${restaurant.hours || 'Call for hours'}
- Location: ${restaurant.address || ''}
- Delivery Enabled: ${restaurant.delivery_enabled ? 'Yes' : 'No'}
- Delivery Radius: ${restaurant.delivery_radius || 'Not specified'} miles
- Delivery Hours: ${restaurant.delivery_hours || 'Same as restaurant hours'}

${menuText}

INSTRUCTIONS FOR NEW ORDERS:
1. ALWAYS START by asking for the customer's name FIRST before taking any order details
2. For DELIVERY orders:
   - After getting their name, ask for items they want to order
   - Once items are confirmed, ask for the complete delivery address
   - Use validate_delivery_address function with the full address
   - If address is VALID: IMMEDIATELY output the ORDER_CONFIRMED format, THEN give verbal confirmation
   - If address is invalid, explain the issue and offer pickup instead
3. For PICKUP orders:
   - After getting their name, take the order items
   - Confirm pickup time preferences
   - IMMEDIATELY output the ORDER_CONFIRMED format, THEN give verbal confirmation
4. Always include all captured information in the ORDER_CONFIRMED format

ORDER TAKING WORKFLOW:
Step 1: "May I have your name for the order?" [REMEMBER the name they give you]
Step 2: "What would you like to order today?"
Step 3a: If delivery: "What's your complete delivery address including zip code?"
Step 3b: If pickup: "When would you like to pick this up?"
Step 4: After successful validation, IMMEDIATELY output ORDER_CONFIRMED format
Step 5: THEN provide verbal confirmation to customer

ORDER_CONFIRMED:
- Customer Name: [actual name provided]
- Phone: ${customerPhone || '9999999999'}
- Order Type: [delivery or pickup]
- Delivery Address: [FULL address for delivery, or "N/A" for pickup]
- Items: [detailed list with quantities and prices]
- Special Instructions: [any special requests or "None"]
- Total: $[calculated total]
- Ready Time: [estimated time]
ORDER_END

For MODIFICATIONS to existing orders:
- Use search_recent_orders function first
- Use update_order for changes, cancel_order ONLY for complete cancellations

For MESSAGES/INQUIRIES:
- If no orders found or customer wants to leave a message, format as:
MESSAGE_CONFIRMED:
- Customer Name: [name]
- Message Type: [complaint/question/feedback/general]
- Subject: [brief subject]
- Message: [their message]
- Priority: [low/normal/high/urgent]
MESSAGE_END

Keep responses conversational and VERY BRIEF for phone calls.`;

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
                        threshold: 0.7,
                        prefix_padding_ms: 300,
                        silence_duration_ms: 1800
                    },
                    tools: [
                        {
                            type: "function",
                            name: "search_recent_orders",
                            description: "Search for recent PENDING orders by the customer's phone number",
                            parameters: {
                                type: "object",
                                properties: {
                                    phone_number: {
                                        type: "string",
                                        description: "Customer's phone number"
                                    }
                                },
                                required: []
                            }
                        },
                        {
                            type: "function",
                            name: "validate_delivery_address",
                            description: "Validate if a delivery address is within the restaurant's delivery area",
                            parameters: {
                                type: "object",
                                properties: {
                                    address: {
                                        type: "string",
                                        description: "Complete delivery address"
                                    }
                                },
                                required: ["address"]
                            }
                        },
                        {
                            type: "function", 
                            name: "cancel_order",
                            description: "ONLY use this to COMPLETELY CANCEL an entire order",
                            parameters: {
                                type: "object",
                                properties: {
                                    order_id: {
                                        type: "string",
                                        description: "The order ID from search results"
                                    },
                                    reason: {
                                        type: "string",
                                        description: "Reason for cancellation"
                                    }
                                },
                                required: ["order_id"]
                            }
                        },
                        {
                            type: "function", 
                            name: "update_order",
                            description: "Use this for ANY changes to an existing order",
                            parameters: {
                                type: "object",
                                properties: {
                                    order_id: {
                                        type: "string",
                                        description: "The order ID from search results"
                                    },
                                    modifications: {
                                        type: "string",
                                        description: "Description of changes"
                                    },
                                    new_total: {
                                        type: "number",
                                        description: "New total amount"
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
                        
                        if (response.transcript.includes('MESSAGE_CONFIRMED') || 
                            (accumulatedMessageText && !messageProcessed)) {
                            accumulatedMessageText += response.transcript + '\n';
                            
                            if (accumulatedMessageText.includes('MESSAGE_CONFIRMED') && 
                                accumulatedMessageText.includes('MESSAGE_END')) {
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
                        
                    case 'response.function_call_done':
                        console.log('Function call completed:', response.name);
                        // Don't handle here to avoid duplicate calls
                        break;
                        
                    case 'conversation.item.created':
                        if (response.item?.type === 'function_call' && response.item.call_id) {
                            console.log('Function call item created:', response.item.name);
                            // Only handle if we have a call_id
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

    // FIXED: Handle function calls from OpenAI - properly capture delivery address
    async function handleFunctionCall(functionCall) {
        try {
            const { name, call_id, arguments: args } = functionCall;
            let result = null;
            let parsedArgs = {};

            console.log(`Executing function: ${name}`);
            console.log('Raw function call object:', JSON.stringify(functionCall, null, 2));

            // FIXED: Better argument parsing
            if (!args || args === '') {
                console.log('No arguments provided, using defaults');
                parsedArgs = {};
            } else if (typeof args === 'string') {
                try {
                    // Clean the string first - remove any extra whitespace or newlines
                    const cleanedArgs = args.trim().replace(/\n/g, ' ').replace(/\s+/g, ' ');
                    parsedArgs = JSON.parse(cleanedArgs);
                } catch (e) {
                    console.error('Error parsing JSON arguments:', e);
                    console.log('Raw args string:', args);
                    
                    // Try to extract address from string directly if JSON parsing fails
                    if (name === 'validate_delivery_address') {
                        // Look for address pattern in the string
                        const addressMatch = args.match(/["']?address["']?\s*:\s*["']([^"']+)["']/);
                        if (addressMatch) {
                            parsedArgs = { address: addressMatch[1] };
                        } else {
                            // If no JSON structure found, use the whole string as address
                            parsedArgs = { address: args };
                        }
                    } else {
                        parsedArgs = { raw: args };
                    }
                }
            } else if (typeof args === 'object') {
                parsedArgs = args;
            }

            console.log('Parsed function arguments:', parsedArgs);

            switch (name) {
                case 'search_recent_orders':
                    const phoneNumber = parsedArgs.phone_number || customerPhone || '9999999999';
                    console.log('Searching PENDING orders for phone:', phoneNumber);
                    
                    if (!phoneNumber || phoneNumber === '9999999999') {
                        result = { error: 'No valid phone number available to search orders' };
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
                            console.log('MODIFICATION CALL DETECTED');
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
                            ? 'No pending orders found.' 
                            : `Found ${orders.length} pending order(s).`,
                        modification_required: orders.length > 0 ? true : false
                    };
                    break;

                case 'validate_delivery_address':
                    // FIXED: Properly handle address extraction
                    let address = parsedArgs.address;
                    
                    // If no address in arguments, try to find it from recent conversation
                    if (!address || address === 'undefined' || address === undefined) {
                        console.log('No valid address in arguments, searching conversation for address...');
                        
                        // Look in the last few customer messages for an address
                        const recentCustomerMessages = conversationTranscript
                            .filter(m => m.speaker === 'Customer')
                            .slice(-5); // Look at last 5 customer messages
                        
                        console.log('Recent customer messages:', recentCustomerMessages);
                        
                        // Try to find address patterns in recent messages
                        for (let i = recentCustomerMessages.length - 1; i >= 0; i--) {
                            const msgText = recentCustomerMessages[i].text;
                            console.log(`Checking message: "${msgText}"`);
                            
                            // Look for street addresses with numbers
                            const streetPattern = /\d+\s+[\w\s]+(?:road|rd|street|st|avenue|ave|drive|dr|lane|ln|way|court|ct|place|pl|boulevard|blvd)/i;
                            const hasStreetAddress = streetPattern.test(msgText);
                            
                            // Look for zip codes
                            const hasZipCode = /\d{5}/.test(msgText);
                            
                            // Look for state abbreviations or full state names
                            const hasState = /\b(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|Maryland|maryland)\b/i.test(msgText);
                            
                            // If message looks like it contains address components, use it
                            if (hasStreetAddress || (hasZipCode && msgText.length > 10)) {
                                address = msgText;
                                console.log('Found potential address in conversation:', address);
                                break;
                            }
                            
                            // Also check if the message is just after "What's your delivery address?"
                            if (i > 0 && conversationTranscript[conversationTranscript.indexOf(recentCustomerMessages[i]) - 1]?.text?.toLowerCase().includes('delivery address')) {
                                address = msgText;
                                console.log('Found address as response to delivery address question:', address);
                                break;
                            }
                        }
                        
                        // If still no address found, check the most recent customer message specifically
                        if (!address) {
                            const lastCustomerMessage = recentCustomerMessages[recentCustomerMessages.length - 1];
                            if (lastCustomerMessage) {
                                console.log('Using last customer message as address:', lastCustomerMessage.text);
                                address = lastCustomerMessage.text;
                            }
                        }
                    }
                    
                    console.log('Final address to validate:', address);
                    
                    if (!address || address === 'undefined') {
                        result = { 
                            valid: false,
                            message: 'I didn\'t catch your address. Could you please repeat your complete delivery address including street number, street name, city, state, and zip code?',
                            address: null,
                            needs_retry: true
                        };
                        break;
                    }
                    
                    // Call the validation function
                    const validationResult = await validateDeliveryAddress(address, restaurant);
                    
                    // FIXED: Store the address if validation was successful
                    if (validationResult.valid) {
                        capturedDeliveryAddress = validationResult.address || address;
                        console.log('DELIVERY ADDRESS CAPTURED AND VALIDATED:', capturedDeliveryAddress);
                        
                        // Add instruction to output ORDER_CONFIRMED format
                        validationResult.instruction = 'CRITICAL: Address is valid! You MUST now output the ORDER_CONFIRMED format immediately with all the order details including this address: ' + capturedDeliveryAddress + ', THEN provide verbal confirmation to the customer. Without the ORDER_CONFIRMED format, the order will NOT be saved!';
                        validationResult.captured_address = capturedDeliveryAddress;
                    }
                    
                    result = validationResult;
                    console.log('Address validation result:', result);
                    break;

                case 'cancel_order':
                    isModificationCall = true;
                    let cancelOrderId = parsedArgs.order_id;
                    const cancelReason = parsedArgs.reason || 'Customer requested cancellation';
                    
                    if (!cancelOrderId && recentOrders && recentOrders.length > 0) {
                        cancelOrderId = recentOrders[0].id;
                    }
                    
                    if (!cancelOrderId) {
                        result = { 
                            error: 'No order ID provided.',
                            instruction: 'Call search_recent_orders first.'
                        };
                        break;
                    }
                    
                    const cancelResult = await cancelOrder(cancelOrderId, cancelReason);
                    
                    result = {
                        success: !!cancelResult,
                        message: cancelResult ? 'Order cancelled successfully' : 'Failed to cancel order',
                        order_id: cancelOrderId,
                        status: cancelResult ? 'cancelled' : 'failed'
                    };
                    break;

                case 'update_order':
                    isModificationCall = true;
                    let orderId = parsedArgs.order_id;
                    let modifications = parsedArgs.modifications || 'Order modification requested';
                    let newTotal = parsedArgs.new_total || 0;
                    
                    if (!orderId && recentOrders && recentOrders.length > 0) {
                        orderId = recentOrders[0].id;
                    }
                    
                    if (!orderId) {
                        result = { 
                            error: 'No order ID provided.',
                            instruction: 'Call search_recent_orders first.'
                        };
                        break;
                    }
                    
                    const updateData = {
                        modifications: modifications,
                        new_total: newTotal,
                        restaurant_menu: restaurant.menu_items
                    };
                    
                    const updateResult = await updateOrder(orderId, updateData);
                    
                    result = {
                        success: !!updateResult,
                        message: updateResult 
                            ? `Order modified successfully. ${modifications}` 
                            : 'Failed to modify order',
                        order_id: orderId,
                        modifications: modifications,
                        new_total: updateResult ? updateResult.total_amount : newTotal,
                        status: updateResult ? 'modified' : 'failed'
                    };
                    break;

                default:
                    result = { error: `Unknown function: ${name}` };
            }

            // FIXED: Don't send response immediately to avoid race condition
            // Wait for OpenAI to be ready
            const waitForReady = () => {
                return new Promise((resolve) => {
                    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                        resolve();
                    } else {
                        setTimeout(() => waitForReady().then(resolve), 100);
                    }
                });
            };

            await waitForReady();

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
                
                // FIXED: Only trigger response if no error occurred
                // Add a longer delay to ensure OpenAI processes the function result
                setTimeout(() => {
                    // Check if OpenAI is ready for a new response
                    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                        const responseMessage = {
                            type: 'response.create',
                            response: {
                                modalities: ['audio', 'text']
                            }
                        };
                        openaiWs.send(JSON.stringify(responseMessage));
                        console.log('Triggered response generation');
                    }
                }, 500); // Increased delay to 500ms
            }

        } catch (error) {
            console.error('Error handling function call:', error);
            console.error('Stack trace:', error.stack);
            
            // Send error response back to OpenAI
            const errorResponse = {
                type: 'conversation.item.create',
                item: {
                    type: 'function_call_output',
                    call_id: functionCall.call_id || 'unknown',
                    output: JSON.stringify({ 
                        error: error.message,
                        instruction: 'An error occurred. Please try again or ask the customer to repeat their information.'
                    })
                }
            };

            if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                openaiWs.send(JSON.stringify(errorResponse));
                console.log('Error response sent to OpenAI');
            }
        }
    }

    // Process message from AI transcript
    async function processMessageFromTranscript(transcript) {
        try {
            if (messageProcessed) {
                console.log('Message already processed, skipping');
                return;
            }
            
            console.log('Processing customer message...');
            
            if (!transcript.includes('MESSAGE_CONFIRMED') || !transcript.includes('MESSAGE_END')) {
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
            } else {
                return;
            }
            
            const messageData = parseMessageData(messageSection);
            
            if (!messageData.customer_name && !messageData.message_content) {
                return;
            }
            
            messageData.restaurant_id = restaurant.id;
            messageData.customer_phone = customerPhone || '9999999999';
            messageData.call_sid = callSid;
            
            const message = await createCustomerMessage(messageData);
            if (message) {
                console.log('Customer message saved successfully with ID:', message.id);
                messageProcessed = true;
                
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
        
        return messageData;
    }

    // Process order from AI transcript
    async function processOrderFromTranscript(transcript) {
        try {
            if (isModificationCall) {
                console.log('BLOCKING ORDER CREATION - This is a modification call');
                return;
            }
            
            const fullConversation = conversationTranscript.map(msg => msg.text).join(' ').toLowerCase();
            const hasModificationContext = 
                fullConversation.includes('fix my') ||
                fullConversation.includes('change my order') || 
                fullConversation.includes('modify my order') ||
                fullConversation.includes('found a pending order');
            
            if (hasModificationContext) {
                console.log('BLOCKING ORDER CREATION - Modification context detected');
                return;
            }
            
            if (recentOrders && recentOrders.length > 0) {
                console.log('BLOCKING ORDER CREATION - Recent orders exist');
                return;
            }
            
            if (orderProcessed) {
                console.log('Order already processed');
                return;
            }
            
            console.log('Processing NEW order...');
            
            if (transcript.includes('ORDER_CONFIRMED:') && transcript.includes('ORDER_END')) {
                orderProcessed = true;
                
                const orderSection = transcript.substring(
                    transcript.indexOf('ORDER_CONFIRMED:') + 'ORDER_CONFIRMED:'.length,
                    transcript.indexOf('ORDER_END')
                ).trim();
                
                let customerName = '';
                let items = '';
                let specialInstructions = '';
                let orderType = 'pickup';
                let deliveryAddress = null;
                let readyTime = '';
                let totalAmount = 0;
                
                const lines = orderSection.split('\n').map(line => line.trim());
                
                for (const line of lines) {
                    if (line.includes('Customer Name:')) {
                        customerName = line.substring(line.indexOf(':') + 1).trim();
                        customerName = customerName.replace(/\[.*?\]/g, '').trim();
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
                    } else if (line.includes('Ready Time:') || line.includes('Pickup Time:')) {
                        readyTime = line.substring(line.indexOf(':') + 1).trim();
                    } else if (line.includes('Total:')) {
                        totalAmount = extractTotal(line);
                    }
                }
                
                if (!customerName || customerName === 'Not provided') {
                    const nameConversation = conversationTranscript.filter(m => m.speaker === 'Customer');
                    for (const msg of nameConversation) {
                        const nameMatch = msg.text.match(/(?:my name is|this is|i'm|i am)\s+([A-Za-z]+(?:\s+[A-Za-z]+)?)/i);
                        if (nameMatch) {
                            customerName = nameMatch[1];
                            break;
                        }
                    }
                }
                
                const timing = calculateOrderReadyTime(restaurant, orderType === 'delivery');
                
                const formattedOrderDetails = `Customer: ${customerName || 'Not provided'}
Phone: ${customerPhone || '9999999999'}
Order Type: ${orderType}
${orderType === 'delivery' ? `Delivery Address: ${deliveryAddress || 'Not provided'}` : 'Pickup'}
Items: ${items || 'No items specified'}
Special Instructions: ${specialInstructions || 'None'}
Ready Time: ${readyTime || timing.readyTimeString}
Order taken via AI phone system`;
                
                const orderData = {
                    restaurant_id: restaurant.id,
                    customer_phone: customerPhone || '9999999999',
                    customer_name: customerName || null,
                    total_amount: totalAmount || extractTotal(orderSection) || 0,
                    order_type: orderType,
                    delivery_address: deliveryAddress,
                    order_details: formattedOrderDetails,
                    special_instructions: specialInstructions || '',
                    call_sid: callSid,
                    items: []
                };

                const order = await createOrder(orderData);
                if (order) {
                    console.log('NEW order saved successfully with ID:', order.id);
                    capturedDeliveryAddress = null;
                    
                    if (callSid) {
                        await updateCallLog(callSid, { order_id: order.id });
                    }
                } else {
                    orderProcessed = false;
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
            
            console.log('=== CALL END PROCESSING COMPLETE ===');
            
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
                                      data.start.customParameters?.Caller || '9999999999';
                    
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
