// Restaurant AI Ordering System - Refactored Architecture
// Main application entry point

const express = require('express');
const WebSocket = require('ws');
const config = require('./config');
const routes = require('./routes');
const twilioService = require('./services/twilio');
const database = require('./services/database');
const stateManager = require('./services/stateManager');
const { shouldCreateCustomerMessage, generateAIInstructions } = require('./services/aiInstructions');
const { formatMenuForAI, createOrderTicket, calculateOrderReadyTime, validateAndRecalculatePrices } = require('./utils/orderHelpers');

// Initialize Express app
const app = express();
const server = require('http').createServer(app);

// Initialize WebSocket server
const wss = new WebSocket.Server({
  server,
  path: '/media-stream'
});

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Mount routes
app.use('/', routes);

// WebSocket connection handler
wss.on('connection', (ws, _req) => {
  console.log('New WebSocket connection established');

  // Connection state
  let openaiWs = null;
  let streamSid = null;
  let callSid = null;
  let customerPhone = null;
  let restaurant = null;
  let callStartTime = new Date();
  let conversationTranscript = [];
  let orderProcessed = false;
  let orderSubmitted = false; // Prevent duplicate submit_order calls
  let addressValidated = false;
  let validatedDeliveryAddress = null;
  let addressRequested = false;
  let addressProviderAttempts = 0;
  let addressValidationAttempts = 0;
  let maxAddressRetries = config.order.maxAddressRetries;
  let validationRetryInfo = null;
  let recentOrders = [];
  let customerHasSpoken = false;
  let greetingTimeout = null;
  let callFinalized = false;
  let hangupTimer = null;
  let currentModel = config.openai.model; // Track which model is being used
  let modelRetryAttempted = false; // Prevent infinite retry loops

  // Adaptive VAD: Track AI responses to detect background noise issues
  let aiResponseTimestamps = []; // Timestamps of recent AI responses
  let vadEagerness = 'high'; // Current VAD eagerness setting
  let vadAdjusted = false; // Whether we've already adjusted VAD (only do once per call)

  // Unified hangup handler - single source of truth for all hangup scenarios
  async function initiateHangup(reason, options = {}) {
    if (callFinalized) {
      console.log('Call already finalized, skipping hangup');
      return;
    }

    console.log(`Initiating hangup - Reason: ${reason}`);

    // Clear any pending timers
    if (hangupTimer) {
      clearTimeout(hangupTimer);
      hangupTimer = null;
    }
    if (greetingTimeout) {
      clearTimeout(greetingTimeout);
      greetingTimeout = null;
    }

    // Close OpenAI WebSocket first to stop audio streaming
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
      console.log('Closing OpenAI WebSocket before hangup');
      openaiWs.close();
    }

    // Don't attempt Twilio hangup if we don't have a callSid yet
    if (!callSid) {
      console.log('No callSid available, skipping Twilio hangup');
      return;
    }

    try {
      // Attempt graceful hangup with Ring Two Tech branding
      const hangupResult = await twilioService.hangup(callSid, {
        method: 'graceful',
        reason: reason,
        restaurant: restaurant,
        ...options
      });

      if (!hangupResult.success) {
        console.error('Graceful hangup failed:', hangupResult.error);
        console.log('Attempting immediate hangup as fallback...');

        // Fallback to immediate hangup
        await twilioService.hangup(callSid, {
          method: 'immediate',
          reason: `${reason}_fallback`
        });
      }
    } catch (error) {
      console.error('Error during hangup:', error);

      // Last resort: immediate hangup
      try {
        await twilioService.hangup(callSid, {
          method: 'immediate',
          reason: `${reason}_error`
        });
      } catch (fallbackError) {
        console.error('Fallback hangup also failed:', fallbackError);
      }
    }
  }

  // Initialize OpenAI connection
  async function initializeOpenAI(calledNumber, fromNumber, callId, retryWithFallback = false) {
    console.log('Loading restaurant data for:', calledNumber);

    // Use fallback model if this is a retry attempt
    if (retryWithFallback && !modelRetryAttempted) {
      currentModel = config.openai.fallbackModel;
      modelRetryAttempted = true;
      console.log(`⚠️ Retrying with fallback model: ${currentModel}`);
    }

    // First, check if restaurant data is already cached in stateManager
    const cachedCallData = stateManager.getCallData(callId);
    if (cachedCallData && cachedCallData.restaurant) {
      restaurant = cachedCallData.restaurant;
      console.log('Restaurant loaded from cache:', restaurant.name);
    } else {
      // Fallback to API lookup if not cached
      const phoneToLookup = calledNumber || '+14108880091';
      restaurant = await database.getRestaurantByPhone(phoneToLookup);
      console.log('Restaurant loaded from API:', restaurant?.name);
    }

    if (!restaurant) {
      console.error('Restaurant not found for phone:', calledNumber);
      await initiateHangup('restaurant_not_found');
      return;
    }

    console.log('Restaurant loaded:', {
      id: restaurant.id,
      name: restaurant.name,
      phone: restaurant.phone_number,
      delivery_enabled: restaurant.delivery_enabled,
      ai_voice: restaurant.ai_voice || 'coral (default)'
    });

    customerPhone = fromNumber;
    callSid = callId;

    console.log('Customer phone set to:', customerPhone);

    const menuText = formatMenuForAI(restaurant.menu_items, restaurant);

    // DEBUG: Log raw menu items structure
    console.log('🔴 RAW MENU ITEMS COUNT:', restaurant.menu_items?.length);
    if (restaurant.menu_items?.length > 0) {
      restaurant.menu_items.forEach((item, i) => {
        const sizesInfo = item.sizes ? `${item.sizes.length} sizes: ${item.sizes.map(s => `${s.size}=$${s.price}`).join(', ')}` : 'NO SIZES ARRAY';
        console.log(`🔴 ITEM ${i}: ${item.name} -> ${sizesInfo}`);
      });
    }

    // DEBUG: Log final menu text lines with prices
    const menuLines = menuText.split('\n').filter(line => line.startsWith('- ') && line.includes('$'));
    console.log('🔴 MENU LINES WITH PRICES:');
    menuLines.forEach(line => console.log('  ', line));

    // Pre-fetch customer address to include in AI instructions (v2.9.13 optimization)
    let prefetchedCustomerAddress = null;
    try {
      prefetchedCustomerAddress = await database.getCustomerAddress(customerPhone, restaurant.id);
      if (prefetchedCustomerAddress) {
        console.log('✅ Pre-fetched customer address:', prefetchedCustomerAddress.delivery_address);
      } else {
        console.log('ℹ️ No saved customer address found during pre-fetch');
      }
    } catch (error) {
      console.error('⚠️ Error pre-fetching customer address:', error.message);
    }

    console.log(`Connecting to OpenAI Realtime API with model: ${currentModel}...`);

    try {
      openaiWs = new WebSocket(`${config.openai.websocketUrl}?model=${currentModel}`, {
        headers: {
          'Authorization': `Bearer ${config.openai.apiKey}`,
          'OpenAI-Beta': 'realtime=v1'
        },
        perMessageDeflate: false,
        handshakeTimeout: 5000,
        maxPayload: 100 * 1024 * 1024
      });

      console.log(`WebSocket created successfully with model: ${currentModel}`);

    } catch (createError) {
      console.error(`Failed to create OpenAI WebSocket with ${currentModel}:`, createError);

      // Retry with fallback model if primary failed and we haven't retried yet
      if (!modelRetryAttempted && config.openai.fallbackModel) {
        console.log(`Attempting to retry with fallback model: ${config.openai.fallbackModel}`);
        await initializeOpenAI(calledNumber, fromNumber, callId, true);
        return;
      }

      await initiateHangup('websocket_creation_failed');
      return;
    }

    setupOpenAIHandlers(menuText, prefetchedCustomerAddress);
  }

  // Setup OpenAI WebSocket event handlers
  function setupOpenAIHandlers(menuText, prefetchedAddress) {
    openaiWs.on('open', () => {
      console.log('Connected to OpenAI Realtime API');

      const instructions = generateAIInstructions(restaurant, customerPhone, menuText, prefetchedAddress);
      const tools = getAITools();

      // Debug: Log instruction size and menu content
      console.log('📝 AI Instructions length:', instructions.length, 'characters');
      console.log('📋 Menu text being sent to AI:\n', menuText);

      // Debug: Log call forwarding configuration
      console.log('📞 Call Forwarding Config:', {
        enabled: restaurant.call_forwarding_enabled,
        reasons: restaurant.call_forwarding_reasons,
        number: restaurant.call_forwarding_number ? 'configured' : 'not configured'
      });

      const sessionUpdate = {
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          instructions: instructions,
          voice: restaurant.ai_voice || 'coral',
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          turn_detection: {
            type: 'semantic_vad',
            eagerness: 'high',
            create_response: true,
            interrupt_response: true
          },
          temperature: 0.8,
          max_response_output_tokens: 500,
          tools: tools,
          tool_choice: 'auto'
        }
      };

      console.log(`✅ Session configured with ${tools.length} function tools and tool_choice: 'auto'`);
      console.log('📋 Available tools:', tools.map(t => t.name).join(', '));

      openaiWs.send(JSON.stringify(sessionUpdate));
    });

    openaiWs.on('message', handleOpenAIMessage);

    openaiWs.on('error', async (error) => {
      console.error(`OpenAI WebSocket error with ${currentModel}:`, error);

      // Check if this is a model-related error and we haven't retried yet
      const errorMessage = error.message || error.toString();
      const isModelError = errorMessage.includes('model') ||
                          errorMessage.includes('404') ||
                          errorMessage.includes('invalid') ||
                          errorMessage.includes('not found');

      if (isModelError && !modelRetryAttempted && config.openai.fallbackModel) {
        console.log(`🔄 Model error detected. Retrying with fallback model: ${config.openai.fallbackModel}`);

        // Close current connection
        if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
          openaiWs.close();
        }

        // Retry with fallback
        await initializeOpenAI(restaurant.phone_number, customerPhone, callSid, true);
      }
    });

    openaiWs.on('close', (code, reason) => {
      console.log(`OpenAI WebSocket closed - Code: ${code}, Reason: ${reason || 'None'}, Model: ${currentModel}`);
    });
  }

  // Get AI function tools configuration
  function getAITools() {
    return [
      {
        type: "function",
        name: "search_recent_orders",
        description: "Search for recent orders when customer wants to check, modify, or cancel orders. AUTOMATICALLY uses caller ID - NO PARAMETERS NEEDED.",
        parameters: {
          type: "object",
          properties: {
            phone_number: {
              type: "string",
              description: "ONLY use if customer explicitly says they used a different number than their caller ID"
            }
          },
          required: []
        }
      },
      {
        type: "function",
        name: "validate_delivery_address",
        description: "🚨 DELIVERY ORDERS ONLY - NEVER use for pickup orders! Validate delivery address for feasibility. Only call this when customer has explicitly chosen DELIVERY (not pickup).",
        parameters: {
          type: "object",
          properties: {
            address: {
              type: "string",
              description: "Complete delivery address provided by customer"
            },
            customer_name: {
              type: "string",
              description: "Customer's name (used for saving address for future orders)"
            }
          },
          required: ["address"]
        }
      },
      {
        type: "function",
        name: "cancel_order",
        description: "Cancel a PENDING order",
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
        description: "Update a PENDING order",
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
        description: "Save customer messages, complaints, questions, or callback requests",
        parameters: {
          type: "object",
          properties: {
            customer_name: { type: "string", description: "Customer's name" },
            message_content: { type: "string", description: "The customer's message" },
            priority: {
              type: "string",
              enum: ["high", "medium", "normal"],
              description: "Priority level"
            },
            subject: { type: "string", description: "Brief subject" }
          },
          required: ["customer_name", "message_content", "priority", "subject"]
        }
      },
      {
        type: "function",
        name: "transfer_call_for_catering",
        description: "Transfer call to restaurant staff for catering inquiries or large orders (15+ people, bulk orders, corporate events, weddings, parties). Use when customer mentions catering.",
        parameters: {
          type: "object",
          properties: {}
        }
      },
      {
        type: "function",
        name: "transfer_call_for_manager",
        description: "Transfer call to restaurant manager when customer requests to speak with manager or owner.",
        parameters: {
          type: "object",
          properties: {}
        }
      },
      {
        type: "function",
        name: "transfer_call_for_complaint",
        description: "Transfer call to restaurant staff when customer has a complaint about food or service.",
        parameters: {
          type: "object",
          properties: {}
        }
      },
      {
        type: "function",
        name: "transfer_call_for_credit_card",
        description: "Transfer call to restaurant staff to process credit card payment for delivery order.",
        parameters: {
          type: "object",
          properties: {}
        }
      },
      {
        type: "function",
        name: "submit_order",
        description: "Submit the customer's order after confirming all details and payment method. Call this function SILENTLY without speaking - then speak only the brief closing message.",
        parameters: {
          type: "object",
          properties: {
            customer_name: {
              type: "string",
              description: "Customer's name"
            },
            order_type: {
              type: "string",
              enum: ["pickup", "delivery"],
              description: "Order type: pickup or delivery"
            },
            delivery_address: {
              type: "string",
              description: "Delivery address (or 'N/A' for pickup orders)"
            },
            items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string", description: "Item name" },
                  quantity: { type: "number", description: "Quantity" },
                  price: { type: "number", description: "Price per item" }
                },
                required: ["name", "quantity", "price"]
              },
              description: "Array of order items"
            },
            payment_method: {
              type: "string",
              enum: ["cash", "credit card"],
              description: "Payment method - ONLY required for DELIVERY orders. Do NOT include for pickup orders."
            },
            special_instructions: {
              type: "string",
              description: "Any special instructions from customer"
            }
          },
          required: ["customer_name", "order_type", "items"]
        }
      },
      {
        type: "function",
        name: "end_call",
        description: "End the call gracefully. Use ONLY after saying goodbye when: (1) customer confirms they have no more questions after a message was taken, or (2) customer explicitly wants to end the call without ordering.",
        parameters: {
          type: "object",
          properties: {
            reason: {
              type: "string",
              description: "Brief reason for ending call (e.g., 'message_complete_no_more_questions', 'customer_ended_call')"
            }
          },
          required: ["reason"]
        }
      }
    ];
  }

  // Handle OpenAI messages
  async function handleOpenAIMessage(data) {
    try {
      const response = JSON.parse(data);

      // Debug: Log all event types to diagnose function calling
      if (response.type && !response.type.includes('audio.delta')) {
        console.log(`📨 OpenAI event: ${response.type}`, response.type.includes('function') || response.type.includes('tool') ? JSON.stringify(response, null, 2) : '');
      }

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

          // Adaptive VAD: Track response timestamps and detect rapid-fire responses
          // If AI responds 3+ times within 10 seconds, background noise may be triggering
          if (!vadAdjusted && vadEagerness === 'high') {
            const now = Date.now();
            aiResponseTimestamps.push(now);

            // Keep only timestamps from last 10 seconds
            const tenSecondsAgo = now - 10000;
            aiResponseTimestamps = aiResponseTimestamps.filter(t => t > tenSecondsAgo);

            // If 3+ responses in 10 seconds, switch to medium eagerness
            if (aiResponseTimestamps.length >= 3) {
              console.log('🔊 ADAPTIVE VAD: Detected rapid AI responses - likely background noise');
              console.log(`   ${aiResponseTimestamps.length} responses in last 10 seconds`);
              console.log('   Switching semantic_vad eagerness from "high" to "medium"');

              vadEagerness = 'medium';
              vadAdjusted = true;

              // Send session update to change VAD eagerness
              if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                openaiWs.send(JSON.stringify({
                  type: 'session.update',
                  session: {
                    turn_detection: {
                      type: 'semantic_vad',
                      eagerness: 'medium',
                      create_response: true,
                      interrupt_response: true
                    }
                  }
                }));
                console.log('   ✅ Session updated with medium eagerness');
              }
            }
          }
          break;

        case 'input_audio_buffer.speech_started':
          // Customer started speaking - cancel greeting timeout
          if (greetingTimeout) {
            clearTimeout(greetingTimeout);
            greetingTimeout = null;
            customerHasSpoken = true;
          }
          break;

        case 'conversation.item.created':
          // Log for debugging (don't handle function calls here - use response.function_call_arguments.done)
          console.log(`📋 conversation.item.created - type: ${response.item?.type}, name: ${response.item?.name || 'N/A'}`);
          break;

        case 'response.output_item.done':
          // Log for debugging (don't handle function calls here - use response.function_call_arguments.done)
          console.log(`📋 response.output_item.done - type: ${response.item?.type}, name: ${response.item?.name || 'N/A'}`);
          break;

        // Handle function call arguments done event
        case 'response.function_call_arguments.done':
          console.log('📞 Function call arguments done:', response.name, response.arguments);
          await handleFunctionCall({
            name: response.name,
            arguments: response.arguments,
            call_id: response.call_id
          });
          break;

        case 'session.created':
          console.log('📡 Session created');
          break;

        case 'session.updated':
          console.log('📡 Session updated - tools configured:', response.session?.tools?.length || 0);
          break;

        case 'error':
          console.error('OpenAI error:', response.error);
          break;
      }
    } catch (error) {
      console.error('Error handling OpenAI message:', error);
    }
  }

  // Handle function calls from AI
  async function handleFunctionCall(item) {
    const functionName = item.name;
    let parsedArgs = {};

    try {
      parsedArgs = item.arguments ? JSON.parse(item.arguments) : {};
    } catch (e) {
      console.error('Failed to parse function arguments:', item.arguments);
    }

    console.log(`Function called: ${functionName}`, parsedArgs);

    let result = {};

    switch (functionName) {
      case 'search_recent_orders':
        const phoneToSearch = parsedArgs.phone_number || customerPhone;
        console.log('🔍 search_recent_orders - checking params:', {
          phoneToSearch,
          restaurantId: restaurant?.id,
          hasRestaurant: !!restaurant
        });
        if (!phoneToSearch || !restaurant?.id) {
          console.error('❌ search_recent_orders - missing required params:', {
            phoneToSearch: phoneToSearch || 'MISSING',
            restaurantId: restaurant?.id || 'MISSING'
          });
          result = { orders: [], count: 0, error: 'Missing required parameters' };
          break;
        }
        recentOrders = await database.searchRecentOrders(phoneToSearch, restaurant.id);
        result = { orders: recentOrders, count: recentOrders.length };
        break;

      case 'validate_delivery_address':
        addressValidationAttempts++;
        const validationResult = await database.validateDeliveryAddress(parsedArgs.address, restaurant);

        if (validationResult.valid) {
          addressValidated = true;
          validatedDeliveryAddress = parsedArgs.address;
          result = {
            ...validationResult,
            status: 'APPROVED',
            confirmed_address: parsedArgs.address
          };
        } else {
          if (addressValidationAttempts <= maxAddressRetries) {
            result = {
              ...validationResult,
              status: 'RETRY_ALLOWED',
              validation_attempt: addressValidationAttempts
            };
          } else {
            addressValidated = true;
            result = {
              ...validationResult,
              status: 'MAX_RETRIES_EXCEEDED',
              force_pickup: true
            };
          }
        }
        break;

      case 'cancel_order':
        const cancelOrderId = parsedArgs.order_id || recentOrders[0]?.id;
        if (cancelOrderId) {
          const cancelResult = await database.cancelOrder(cancelOrderId, parsedArgs.reason);
          result = { success: !!cancelResult, order_id: cancelOrderId };
        } else {
          result = { error: 'No pending order ID provided' };
        }
        break;

      case 'update_order':
        const updateResult = await database.updateOrder(parsedArgs.order_id, parsedArgs);
        result = { success: !!updateResult, data: updateResult };
        break;

      case 'create_customer_message':
        if (shouldCreateCustomerMessage(parsedArgs.message_content, conversationTranscript)) {
          const messageResult = await database.createCustomerMessage({
            restaurant_id: restaurant.id,
            customer_name: parsedArgs.customer_name,
            customer_phone: customerPhone,
            message_content: parsedArgs.message_content,
            priority: parsedArgs.priority || 'normal',
            subject: parsedArgs.subject || 'Customer Message'
          });
          result = { success: !!messageResult, message_id: messageResult?.id };

          if (messageResult) {
            console.log('📝 Message created successfully - AI will ask if anything else needed');
          }
        } else {
          result = { success: false, reason: 'Message intent not suitable for storage' };
        }
        break;

      case 'submit_order':
        {
          // Prevent duplicate order submissions
          if (orderSubmitted) {
            console.log('⚠️ submit_order already called - preventing duplicate');
            result = {
              success: true,
              already_submitted: true,
              message: 'Order was already submitted.'
            };
            break;
          }

          console.log('📦 submit_order function called with:', parsedArgs);

          let orderResult;
          try {
            // Process the order from the structured function call data
            // Returns pricing info with server-validated totals
            orderResult = await processOrderFromFunctionCall(parsedArgs);

            // Only mark as submitted AFTER successful processing
            orderSubmitted = true;
            console.log('✅ Order successfully submitted');
          } catch (orderError) {
            console.error('❌ Failed to process order:', orderError);
            result = {
              success: false,
              message: 'Failed to process order. Please try again.'
            };
            break;
          }

          // Return success with SERVER-CALCULATED pricing for AI to speak
          // CRITICAL: AI must use this total, not its own calculation
          result = {
            success: true,
            ready_time_minutes: orderResult.readyTimeMinutes,
            total_with_tax: orderResult.total,
            subtotal: orderResult.subtotal,
            tax: orderResult.tax,
            delivery_fee: orderResult.deliveryFee,
            message: `Order submitted successfully. The correct total is $${orderResult.total.toFixed(2)}. Ready in ${orderResult.readyTimeMinutes} minutes.`
          };

          console.log('📢 Returning corrected total to AI:', orderResult.total);
        }
        break;

      case 'transfer_call_for_catering':
      case 'transfer_call_for_manager':
      case 'transfer_call_for_complaint':
      case 'transfer_call_for_credit_card':
        {
          // Map function names to database reason strings
          const functionToReason = {
            'transfer_call_for_catering': 'Forward calls for catering orders',
            'transfer_call_for_manager': 'Forward calls when customer requests to speak with manager',
            'transfer_call_for_complaint': 'Forward calls for issues or complaints',
            'transfer_call_for_credit_card': 'Forward calls for credit card transactions'
          };

          const reason = functionToReason[functionName];
          console.log(`🔀 Transfer call request: ${functionName} → ${reason}`);

          // Check if call forwarding is enabled
          if (!restaurant.call_forwarding_enabled) {
            console.log('❌ Call forwarding not enabled for this restaurant');
            const fallbackMessage = functionName === 'transfer_call_for_credit_card'
              ? "Your order has been placed successfully. Someone from the restaurant will be reaching out to obtain payment. Thank you!"
              : "I've saved your request. The restaurant will call you back to help with this.";
            result = {
              success: false,
              should_create_message: true,
              message: fallbackMessage
            };
            break;
          }

          // Check if this specific reason is in the forwarding reasons array
          const forwardingReasons = restaurant.call_forwarding_reasons || [];
          const shouldForward = forwardingReasons.includes(reason);

          if (!shouldForward) {
            console.log(`❌ Reason "${reason}" not in forwarding reasons: ${forwardingReasons.join(', ')}`);
            const fallbackMessage = functionName === 'transfer_call_for_credit_card'
              ? "Your order has been placed successfully. Someone from the restaurant will be reaching out to obtain payment. Thank you!"
              : "I've saved your request. The restaurant will call you back to help with this.";
            result = {
              success: false,
              should_create_message: true,
              message: fallbackMessage
            };
            break;
          }

          // Check if forwarding number is configured
          if (!restaurant.call_forwarding_number) {
            console.error('❌ Call forwarding enabled but no number configured');
            const fallbackMessage = functionName === 'transfer_call_for_credit_card'
              ? "Your order has been placed successfully. Someone from the restaurant will be reaching out to obtain payment. Thank you!"
              : "I've saved your request. The restaurant will call you back to help with this.";
            result = {
              success: false,
              should_create_message: true,
              message: fallbackMessage
            };
            break;
          }

          // Return message for AI to speak, then transfer after delay
          console.log(`✅ Preparing transfer to ${restaurant.call_forwarding_number} - Reason: ${reason}`);

          const transferMessages = {
            'transfer_call_for_catering': 'Let me transfer you to our catering specialist. Please hold.',
            'transfer_call_for_manager': 'Let me transfer you to the manager. Please hold.',
            'transfer_call_for_complaint': 'Let me transfer you to someone who can help. Please hold.',
            'transfer_call_for_credit_card': 'Let me transfer you to process your payment. Please hold.'
          };

          // Return result immediately so AI can speak the message
          result = {
            success: true,
            transferred_to: restaurant.call_forwarding_number,
            message: transferMessages[functionName]
          };

          // Execute transfer after delay (non-blocking)
          setTimeout(async () => {
            console.log(`⏳ Executing delayed transfer to ${restaurant.call_forwarding_number}...`);
            const transferResult = await twilioService.transferCall(
              callSid,
              restaurant.call_forwarding_number,
              transferMessages[functionName]
            );

            if (transferResult.success) {
              console.log(`✅ Call transferred successfully to ${restaurant.call_forwarding_number}`);
            } else {
              console.error('❌ Transfer failed:', transferResult.error);

              // If credit card transfer fails, notify the customer
              if (functionName === 'transfer_call_for_credit_card' && openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                const fallbackMessage = "I apologize, but I'm unable to transfer your call at this time. Your order has been placed successfully, and someone from the restaurant will be reaching out to obtain payment. Thank you!";

                // Send the fallback message to AI to speak to customer
                openaiWs.send(JSON.stringify({
                  type: 'conversation.item.create',
                  item: {
                    type: 'message',
                    role: 'user',
                    content: [{
                      type: 'input_text',
                      text: `[SYSTEM: Transfer failed. Please say this to the customer: "${fallbackMessage}"]`
                    }]
                  }
                }));

                // Trigger AI response
                openaiWs.send(JSON.stringify({ type: 'response.create' }));

                console.log('📢 Sent fallback message to AI for credit card transfer failure');
              }
            }
          }, 3000);
        }
        break;

      case 'end_call':
        {
          const reason = parsedArgs.reason || 'conversation_complete';
          console.log(`📞 end_call function called with reason: ${reason}`);

          result = { success: true, message: 'Call ending' };

          // End the call immediately (no delay needed - AI has already said goodbye)
          setTimeout(async () => {
            await initiateHangup(reason);
          }, 1000); // 1 second delay to ensure goodbye is spoken
        }
        break;
    }

    // Send function result back to OpenAI
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
      // First, send the function output
      openaiWs.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: item.call_id,
          output: JSON.stringify(result)
        }
      }));

      // Then trigger a response so AI continues the conversation
      openaiWs.send(JSON.stringify({ type: 'response.create' }));
    }
  }

  // Process order from function call
  // Returns pricing info so AI can speak the correct total
  async function processOrderFromFunctionCall(orderData) {
    orderProcessed = true;
    console.log('Processing order from function call...');

    try {
      // SERVER-SIDE PRICE VALIDATION: Recalculate prices based on actual menu data
      // This corrects any arithmetic errors made by the AI
      const validationResult = validateAndRecalculatePrices(orderData.items, restaurant.menu_items);
      if (validationResult.validated && validationResult.corrections.length > 0) {
        console.log('🔧 AI price corrections applied to order');
        orderData.items = validationResult.items;
      }

      // Calculate subtotal from items (now using validated prices)
      const subtotal = orderData.items.reduce((sum, item) => {
        return sum + (item.price * item.quantity);
      }, 0);

      const isDelivery = orderData.order_type === 'delivery';
      const deliveryFee = isDelivery && restaurant.delivery_fee ? restaurant.delivery_fee : 0;
      const taxableAmount = subtotal + deliveryFee;
      const taxAmount = restaurant.tax_rate ? taxableAmount * restaurant.tax_rate : 0;
      const finalTotal = taxableAmount + taxAmount;

      // Round to 2 decimal places for currency
      const roundedSubtotal = Math.round(subtotal * 100) / 100;
      const roundedTax = Math.round(taxAmount * 100) / 100;
      const roundedTotal = Math.round(finalTotal * 100) / 100;

      console.log('Order pricing breakdown:', {
        subtotal: roundedSubtotal,
        deliveryFee,
        taxRate: restaurant.tax_rate,
        taxAmount: roundedTax,
        finalTotal: roundedTotal
      });

      const readyTimeInfo = calculateOrderReadyTime(restaurant, isDelivery);

      // Format items for ticket
      const itemsText = orderData.items.map(item =>
        `${item.quantity}x ${item.name} - $${item.price.toFixed(2)}`
      ).join('\n');

      // Create the full formatted ticket
      const ticket = createOrderTicket({
        customerName: orderData.customer_name,
        customerPhone: customerPhone,
        orderType: orderData.order_type,
        deliveryAddress: orderData.delivery_address || 'N/A',
        items: itemsText,
        specialInstructions: orderData.special_instructions || '',
        paymentMethod: orderData.payment_method,
        subtotal: roundedSubtotal,
        deliveryFee,
        taxRate: restaurant.tax_rate,
        taxAmount: roundedTax,
        totalAmount: roundedTotal,
        readyTime: readyTimeInfo.readyTimeString,
        restaurantName: restaurant.name
      });

      const dbOrderData = {
        restaurant_id: restaurant.id,
        customer_name: orderData.customer_name,
        customer_phone: customerPhone,
        order_type: orderData.order_type,
        delivery_address: orderData.delivery_address || 'N/A',
        order_details: ticket,
        total_amount: roundedTotal,
        special_instructions: orderData.special_instructions || '',
        payment_method: orderData.payment_method,
        call_sid: callSid,
        ready_time: readyTimeInfo.readyTimeString,
        estimated_ready_at: readyTimeInfo.readyTime,
        status: 'pending'
      };

      const order = await database.createOrder(dbOrderData);

      if (order) {
        console.log('Order created successfully:', order.id);
        console.log('\n' + ticket + '\n');

        // Update call data with order reference
        stateManager.updateCallData(callSid, { order_id: order.id });

        // Schedule hangup after 8 seconds to allow AI to finish speaking closing message
        hangupTimer = setTimeout(async () => {
          await initiateHangup('order_completed');
        }, 8000);

        // Return pricing info for AI to speak the CORRECT total
        return {
          success: true,
          subtotal: roundedSubtotal,
          tax: roundedTax,
          deliveryFee: deliveryFee,
          total: roundedTotal,
          readyTimeMinutes: readyTimeInfo.totalMinutes,
          readyTimeString: readyTimeInfo.readyTimeString
        };
      }

      return { success: false };
    } catch (error) {
      console.error('Error processing order from function call:', error);
      throw error;
    }
  }

  // Handle incoming Twilio messages
  ws.on('message', async (message) => {
    try {
      const msg = JSON.parse(message);

      switch (msg.event) {
        case 'start':
          streamSid = msg.start.streamSid;
          callSid = msg.start.callSid;
          console.log('Media stream started:', { streamSid, callSid });

          // Start Twilio-side recording via REST API (if enabled)
          // Delayed by 1 second to ensure call is connected
          if (config.twilio.recording !== 'do-not-record') {
            setTimeout(() => {
              setImmediate(async () => {
                try {
                  const result = await twilioService.startRecording(callSid);
                  if (result.success) {
                    console.log(`📹 Twilio recording started: ${result.recording_sid}`);
                  }
                } catch (err) {
                  console.error('Twilio recording error (non-blocking):', err.message);
                }
              });
            }, 1000);
          }

          const calledNumber = msg.start.customParameters?.Called;
          const fromNumber = msg.start.customParameters?.From;

          await initializeOpenAI(calledNumber, fromNumber, callSid);

          // Set greeting timeout
          greetingTimeout = setTimeout(() => {
            if (!customerHasSpoken && openaiWs && openaiWs.readyState === WebSocket.OPEN) {
              console.log('No customer response detected - initiating greeting');
              openaiWs.send(JSON.stringify({
                type: 'conversation.item.create',
                item: {
                  type: 'message',
                  role: 'user',
                  content: [{ type: 'input_text', text: 'Start the call greeting' }]
                }
              }));
              openaiWs.send(JSON.stringify({ type: 'response.create' }));
            }
          }, 1000);
          break;

        case 'media':
          if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
            const audioAppend = {
              type: 'input_audio_buffer.append',
              audio: msg.media.payload
            };
            openaiWs.send(JSON.stringify(audioAppend));
          }
          break;

        case 'stop':
          console.log('Media stream stopped');
          await finalizeCall();
          break;
      }
    } catch (error) {
      console.error('Error handling Twilio message:', error);
    }
  });

  // Finalize call and create call log
  async function finalizeCall() {
    // Guard against multiple executions
    if (callFinalized) {
      console.log('Call already finalized, skipping duplicate finalization');
      return;
    }

    callFinalized = true;
    console.log('Finalizing call (first time)');

    // Clear any pending hangup timer
    if (hangupTimer) {
      clearTimeout(hangupTimer);
      hangupTimer = null;
      console.log('Cleared pending hangup timer');
    }

    // Clear greeting timeout if still pending
    if (greetingTimeout) {
      clearTimeout(greetingTimeout);
      greetingTimeout = null;
    }

    const callEndTime = new Date();
    const callDuration = Math.round((callEndTime - callStartTime) / 1000);

    console.log('Finalizing call:', {
      callSid,
      duration: callDuration,
      transcript_length: conversationTranscript.length
    });

    const callData = stateManager.getCallData(callSid);
    if (callData) {
      callData.call_ended_at = callEndTime.toISOString();
      // DO NOT set call_duration - Twilio webhook will provide accurate duration
      // callData.call_duration = callDuration;  // REMOVED - only Twilio webhook sets this
      callData.conversation_transcript = JSON.stringify(conversationTranscript);
      callData.source = 'websocket';  // Mark source for Edge Function logging

      await database.createCallLog(callData);
      stateManager.removeCallData(callSid);
    }

    // Recording is handled by Twilio - recording URL will be available via Twilio Console/API

    // Close OpenAI WebSocket if still open
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
      console.log('Closing OpenAI WebSocket during finalization');
      openaiWs.close();
    }
  }

  // Cleanup on connection close
  ws.on('close', async () => {
    console.log('Twilio WebSocket closed');
    await finalizeCall();
  });

  ws.on('error', (error) => {
    console.error('Twilio WebSocket error:', error);
  });
});

// Start server
const PORT = config.server.port;
server.listen(PORT, () => {
  console.log(`\n${'='.repeat(60)}`);
  console.log('🚀 Restaurant AI Ordering System (Refactored)');
  console.log(`${'='.repeat(60)}`);
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${config.server.environment}`);
  console.log(`OpenAI configured: ${!!config.openai.apiKey}`);
  console.log(`Twilio configured: ${twilioService.isTwilioConfigured()}`);
  console.log(`Supabase configured: ${!!(config.supabase.url && config.supabase.anonKey)}`);
  console.log(`${'='.repeat(60)}\n`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

// Periodic cleanup of old call data
setInterval(() => {
  stateManager.cleanupOldCalls(60);
}, 15 * 60 * 1000); // Every 15 minutes
