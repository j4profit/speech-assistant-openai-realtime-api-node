// Database operations service - handles all Supabase Edge Function calls
const config = require('../config');

/**
 * Get restaurant details by phone number
 * @param {string} phoneNumber - Restaurant's phone number
 * @returns {Promise<Object|null>} Restaurant details or null if not found
 */
async function getRestaurantByPhone(phoneNumber) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(`${config.supabase.url}/functions/v1/get-restaurant`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.supabase.anonKey}`
      },
      body: JSON.stringify({ phone_number: phoneNumber }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) return null;

    const result = await response.json();
    if (result.error) return null;

    const restaurant = result.data;
    if (!restaurant) return null;

    return {
      ...restaurant,
      delivery_enabled: restaurant.delivery_enabled ?? false,
      delivery_radius: restaurant.delivery_radius ?? 5,
      delivery_hours: restaurant.delivery_hours ?? null,
      delivery_time: restaurant.delivery_time ?? 15,
      preparation_time: restaurant.preparation_time ?? 20
    };

  } catch (error) {
    if (error.name === 'AbortError') {
      console.error('Restaurant lookup timed out for phone:', phoneNumber);
    } else {
      console.error('Error calling get-restaurant Edge Function:', error);
    }
    return null;
  }
}

/**
 * Create a call log entry
 * @param {Object} callData - Call information to log
 * @returns {Promise<Object|null>} Created call log or null on error
 */
async function createCallLog(callData) {
  try {
    console.log('Calling create-call-log Edge Function with data:', JSON.stringify(callData, null, 2));

    const response = await fetch(`${config.supabase.url}/functions/v1/create-call-log`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.supabase.anonKey}`
      },
      body: JSON.stringify(callData)
    });

    console.log('Edge Function response status:', response.status);

    const responseText = await response.text();
    console.log('Edge Function raw response:', responseText);

    if (!response.ok) {
      console.error('Edge Function error response:', responseText);
      return null;
    }

    const result = JSON.parse(responseText);
    if (result.error) {
      console.error('Edge Function returned error:', result.error);
      return null;
    }

    console.log('Call log created:', result.data?.id);
    return result.data;

  } catch (error) {
    console.error('Error calling create-call-log Edge Function:', error);
    return null;
  }
}

/**
 * Search for recent orders by phone number
 * @param {string} phoneNumber - Customer's phone number
 * @param {string} restaurantId - Restaurant ID
 * @param {number} daysBack - Number of days to search back (default: 7)
 * @returns {Promise<Array>} Array of recent orders
 */
async function searchRecentOrders(phoneNumber, restaurantId, daysBack = 7) {
  try {
    console.log('🔍 searchRecentOrders called with:', { phoneNumber, restaurantId, daysBack });

    const requestBody = {
      phone_number: phoneNumber,
      restaurant_id: restaurantId,
      days_back: daysBack
    };

    console.log('🔍 Calling edge function with body:', JSON.stringify(requestBody));

    const response = await fetch(`${config.supabase.url}/functions/v1/search-orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.supabase.anonKey}`
      },
      body: JSON.stringify(requestBody)
    });

    console.log('🔍 Edge function response status:', response.status);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('❌ Edge function failed:', {
        status: response.status,
        statusText: response.statusText,
        errorBody: errorText,
        url: `${config.supabase.url}/functions/v1/search-orders`
      });
      return [];
    }

    const result = await response.json();
    console.log('✅ Edge function success result:', JSON.stringify(result, null, 2));
    return result.orders || [];

  } catch (error) {
    console.error('❌ searchRecentOrders error:', {
      message: error.message,
      stack: error.stack,
      phoneNumber,
      restaurantId
    });
    return [];
  }
}

/**
 * Cancel an order
 * @param {string} orderId - Order ID to cancel
 * @param {string} reason - Reason for cancellation
 * @returns {Promise<Object|null>} Cancellation result or null on error
 */
async function cancelOrder(orderId, reason = 'Customer cancellation') {
  try {
    console.log('🚨 cancelOrder function called with:', { orderId, reason });

    const requestBody = {
      order_id: orderId,
      reason: reason
    };

    console.log('🚨 Calling cancel-order edge function with body:', JSON.stringify(requestBody));

    const response = await fetch(`${config.supabase.url}/functions/v1/cancel-order`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.supabase.anonKey}`
      },
      body: JSON.stringify(requestBody)
    });

    console.log('🚨 Cancel-order edge function response status:', response.status);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('❌ Cancel-order edge function failed:', {
        status: response.status,
        statusText: response.statusText,
        errorBody: errorText,
        url: `${config.supabase.url}/functions/v1/cancel-order`
      });
      return null;
    }

    const result = await response.json();
    console.log('✅ Cancel-order edge function success result:', JSON.stringify(result, null, 2));
    return result.data || result;

  } catch (error) {
    console.error('❌ cancelOrder error:', {
      message: error.message,
      stack: error.stack,
      orderId,
      reason
    });
    return null;
  }
}

/**
 * Update an existing order
 * @param {string} orderId - Order ID to update
 * @param {Object} updateData - Update data (modifications, new_total)
 * @returns {Promise<Object|null>} Updated order or null on error
 */
async function updateOrder(orderId, updateData) {
  try {
    const response = await fetch(`${config.supabase.url}/functions/v1/update-order`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.supabase.anonKey}`
      },
      body: JSON.stringify({
        order_id: orderId,
        modifications: updateData.modifications,
        new_total: updateData.new_total
      })
    });

    if (!response.ok) return null;

    return (await response.json()).data;

  } catch (error) {
    console.error('Error calling update-order Edge Function:', error);
    return null;
  }
}

/**
 * Validate a delivery address
 * @param {string} address - Delivery address to validate
 * @param {Object} restaurant - Restaurant object
 * @param {string} customerPhone - Customer's phone number (optional, for caching)
 * @param {string} customerName - Customer's name (optional, for caching)
 * @returns {Promise<Object>} Validation result with valid flag and message
 */
async function validateDeliveryAddress(address, restaurant, customerPhone = null, customerName = null) {
  try {
    if (!address || address.trim().length < 8) {
      return {
        valid: false,
        message: 'Please provide your delivery address.',
        address: address
      };
    }

    const hasStreetNumber = /^\d+/.test(address.trim());
    const hasStreetName = /\b(street|road|avenue|lane|drive|way|court|place|boulevard|blvd|ave|rd|st|ct|pl|ln|dr)\b/i.test(address) ||
                         /\b\w+\s+(st|street|rd|road|ave|avenue|ln|lane|dr|drive|way|ct|court|pl|place|blvd|boulevard)\b/i.test(address) ||
                         /(old|new|north|south|east|west)\s+\w+\s+(road|street|avenue|lane|drive|way|court|place|boulevard|blvd|ave|rd|st|ct|pl|ln|dr)\b/i.test(address);
    const hasFiveDigitZip = /\b\d{5}(-\d{4})?\b/.test(address);
    const hasCityState = /\b[A-Za-z\s]+,\s*[A-Za-z]{2,}/.test(address);

    console.log('Detailed validation for address:', address);
    console.log('hasStreetNumber:', hasStreetNumber);
    console.log('hasStreetName:', hasStreetName);
    console.log('hasFiveDigitZip:', hasFiveDigitZip);
    console.log('hasCityState:', hasCityState);

    if (!hasStreetNumber) {
      return {
        valid: false,
        message: 'Please include the street number.',
        address: address
      };
    }

    if (!hasStreetName) {
      return {
        valid: false,
        message: 'Please include the street name.',
        address: address
      };
    }

    if (!hasFiveDigitZip && !hasCityState) {
      return {
        valid: false,
        message: 'Please include either a 5-digit zip code or city and state (e.g., Baltimore, MD).',
        address: address
      };
    }

    const edgeFunctionUrl = `${config.supabase.url}/functions/v1/validate-delivery-address`;
    console.log('Calling Edge function:', edgeFunctionUrl);

    const requestBody = {
      address: address.trim(),
      restaurant_id: restaurant.id
    };

    // Include customer_phone for caching if available
    if (customerPhone) {
      requestBody.customer_phone = customerPhone;
      console.log('Including customer_phone for address caching');
    }

    const response = await fetch(edgeFunctionUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.supabase.anonKey}`
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      console.error('Edge function HTTP error:', {
        status: response.status,
        statusText: response.statusText,
        url: edgeFunctionUrl,
        address: address.trim()
      });
      const errorText = await response.text();
      console.error('Edge function error response:', errorText);

      return {
        valid: false,
        message: 'Unable to validate address at this time. Please provide a complete address or choose pickup.',
        address: address,
        error: `http_error_${response.status}`,
        edge_function_called: true,
        edge_function_url: edgeFunctionUrl
      };
    }

    const result = await response.json();
    console.log('Edge function response received:', {
      success: result.success,
      valid: result.data?.valid,
      reason: result.data?.reason,
      message: result.data?.message,
      address: address.trim(),
      url: edgeFunctionUrl
    });

    if (!result.success || result.error) {
      console.error('Edge function returned error:', result.error);
      return {
        valid: false,
        message: 'Unable to validate address. Please provide a complete address or choose pickup.',
        address: address,
        error: result.error,
        edge_function_called: true,
        edge_function_url: edgeFunctionUrl
      };
    }

    // Save address to cache if customer info is available and address was not already cached
    if (customerPhone && customerName && !result.data.cached) {
      console.log('💾 Saving validated address to cache');

      await saveCustomerAddress({
        restaurant_id: restaurant.id,
        customer_phone: customerPhone,
        customer_name: customerName,
        delivery_address: address.trim(),
        formatted_address: result.data.formatted_address || address.trim(),
        is_valid: result.data.valid || false,
        latitude: result.data.latitude || null,
        longitude: result.data.longitude || null,
        distance_from_restaurant: result.data.distance || null,
        validation_reason: result.data.reason || null,
        delivery_instructions: null // Will be set later when customer provides
      });
    }

    return {
      valid: result.data.valid || false,
      message: result.data.message || 'Address validation completed',
      address: address,
      estimated_delivery_time: result.data.estimated_delivery_time,
      delivery_radius: result.data.delivery_radius,
      reason: result.data.reason,
      distance: result.data.distance,
      cached: result.data.cached || false,
      edge_function_called: true,
      edge_function_url: edgeFunctionUrl
    };

  } catch (error) {
    console.error('Error calling Edge function:', {
      error: error.message,
      stack: error.stack,
      address
    });
    return {
      valid: false,
      message: 'Unable to validate address at this time. Please provide a complete address or choose pickup.',
      address: address,
      error: error.message
    };
  }
}

/**
 * Create a new order
 * @param {Object} orderData - Order information
 * @returns {Promise<Object|null>} Created order or null on error
 */
async function createOrder(orderData) {
  try {
    const response = await fetch(`${config.supabase.url}/functions/v1/create-order`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.supabase.anonKey}`
      },
      body: JSON.stringify(orderData)
    });

    if (!response.ok) {
      console.error('Order creation failed with status:', response.status);
      const errorText = await response.text();
      console.error('Order creation error response:', errorText);
      return null;
    }

    const result = await response.json();
    if (result.error) {
      console.error('Order creation returned error:', result.error);
      return null;
    }

    console.log('Order created successfully:', result.data?.id);
    return result.data;

  } catch (error) {
    console.error('Error calling create-order Edge Function:', error);
    return null;
  }
}

/**
 * Create a customer message
 * @param {Object} messageData - Message information
 * @returns {Promise<Object|null>} Created message or null on error
 */
async function createCustomerMessage(messageData) {
  try {
    const response = await fetch(`${config.supabase.url}/functions/v1/create-message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.supabase.anonKey}`
      },
      body: JSON.stringify(messageData)
    });

    if (!response.ok) return null;

    const result = await response.json();
    if (result.error) return null;

    console.log('Customer message created successfully:', result.data?.id || result.message_id);
    return result.data || result;

  } catch (error) {
    console.error('Error calling create-message Edge Function:', error);
    return null;
  }
}

/**
 * Get customer's saved delivery address
 * @param {string} restaurantId - Restaurant ID
 * @param {string} customerPhone - Customer's phone number
 * @returns {Promise<Object|null>} Customer address or null if not found
 */
async function getCustomerAddress(restaurantId, customerPhone) {
  try {
    console.log('🔍 Getting customer address:', { restaurantId, customerPhone });

    const response = await fetch(`${config.supabase.url}/functions/v1/get-customer-address`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.supabase.anonKey}`
      },
      body: JSON.stringify({
        restaurant_id: restaurantId,
        customer_phone: customerPhone
      })
    });

    if (!response.ok) {
      console.error('get-customer-address failed:', response.status);
      return null;
    }

    const result = await response.json();

    if (!result.success) {
      console.error('get-customer-address error:', result.error);
      return null;
    }

    console.log('✅ Customer address result:', result.data ? 'Found' : 'Not found');
    return result.data; // Will be null if no address found

  } catch (error) {
    console.error('❌ getCustomerAddress error:', error);
    return null;
  }
}

/**
 * Save customer's validated delivery address
 * @param {Object} addressData - Address data to save
 * @returns {Promise<Object|null>} Saved address or null on error
 */
async function saveCustomerAddress(addressData) {
  try {
    console.log('💾 Saving customer address:', {
      restaurant_id: addressData.restaurant_id,
      customer_phone: addressData.customer_phone,
      is_valid: addressData.is_valid
    });

    const response = await fetch(`${config.supabase.url}/functions/v1/save-customer-address`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.supabase.anonKey}`
      },
      body: JSON.stringify(addressData)
    });

    if (!response.ok) {
      console.error('save-customer-address failed:', response.status);
      return null;
    }

    const result = await response.json();

    if (!result.success) {
      console.error('save-customer-address error:', result.error);
      return null;
    }

    console.log('✅ Customer address saved:', result.address_id);
    return result.data;

  } catch (error) {
    console.error('❌ saveCustomerAddress error:', error);
    return null;
  }
}

module.exports = {
  getRestaurantByPhone,
  createCallLog,
  searchRecentOrders,
  cancelOrder,
  updateOrder,
  validateDeliveryAddress,
  createOrder,
  createCustomerMessage,
  getCustomerAddress,
  saveCustomerAddress
};
