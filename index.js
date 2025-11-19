// Restaurant AI Ordering System - Refactored Architecture
// Main application entry point

const express = require('express');
const WebSocket = require('ws');
const config = require('./config');
const routes = require('./routes');
const twilioService = require('./services/twilio');
const database = require('./services/database');
const stateManager = require('./services/stateManager');
const audioProcessor = require('./services/audioProcessor');
const { shouldCreateCustomerMessage, generateAIInstructions } = require('./services/aiInstructions');
const { formatMenuForAI, createOrderTicket, calculateOrderReadyTime } = require('./utils/orderHelpers');

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
  let aiResponseCount = 0;
  let orderProcessed = false;
  let addressValidated = false;
  let validatedDeliveryAddress = null;
  let deliveryAddressId = null; // UUID of cached address record from customer_delivery_addresses table
  let deliveryInstructions = null; // Track delivery instructions separately
  let addressRequested = false;
  let addressProviderAttempts = 0;
  let addressValidationAttempts = 0;
  let maxAddressRetries = config.order.maxAddressRetries;
  let validationRetryInfo = null;
  let recentOrders = [];
  let prefetchedCustomerAddress = null; // Pre-loaded customer address to eliminate delay
  let customerHasSpoken = false;
  let greetingTimeout = null;
  let callFinalized = false;
  let hangupTimer = null;
  let referenceSignal = null; // For echo cancellation
  let currentModel = config.openai.model; // Track which model is being used
  let modelFallbackAttempted = false; // Prevent infinite fallback loops

  // Order state tracking (for parameter-free submit_order)
  let customerName = null;
  let orderType = null; // 'pickup' or 'delivery'
  let conversationLog = []; // Track AI responses to extract order details
  let lastCustomerActivityTime = Date.now(); // For call timeout
  let callStartTime = Date.now(); // Track total call duration
  let activityCheckInterval = null; // Interval timer for checking call timeout
  let isResponseInProgress = false; // Track if OpenAI is generating a response (prevent race condition)

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
    if (activityCheckInterval) {
      clearInterval(activityCheckInterval);
      activityCheckInterval = null;
    }

    // Don't attempt Twilio hangup if we don't have a callSid yet
    if (!callSid) {
      console.log('No callSid available, skipping Twilio hangup');
      return;
    }

    try {
      // ALWAYS use graceful hangup with Ring Two Tech branding message
      // Important: Redirect call to hangup TwiML BEFORE closing WebSocket
      // This prevents Twilio errors when stream ends
      const hangupResult = await twilioService.hangup(callSid, {
        method: 'graceful',
        reason: reason,
        restaurant: restaurant,
        ...options
      });

      if (!hangupResult.success) {
        console.error('⚠️  Graceful hangup failed (Ring Two Tech message may not have played):', hangupResult.error);
        console.log('Note: Call will end naturally. Message playback depends on call state.');
      } else {
        console.log('✅ Graceful hangup successful - Ring Two Tech message will play');
      }

      // Close OpenAI WebSocket AFTER successful redirect
      // This ensures Twilio has new TwiML instructions before stream ends
      if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
        console.log('Closing OpenAI WebSocket after hangup redirect');
        openaiWs.close();
      }
    } catch (error) {
      console.error('⚠️  Error during graceful hangup:', error);
      console.log('Note: Ring Two Tech message may not have played due to error');

      // Still try to close WebSocket on error
      if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.close();
      }
    }
  }

  // Initialize OpenAI connection
  async function initializeOpenAI(calledNumber, fromNumber, callId) {
    console.log('Loading restaurant data for:', calledNumber);

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

    // Pre-fetch customer's saved delivery address to eliminate delay when they choose delivery
    if (customerPhone && restaurant.delivery_enabled) {
      console.log('🚀 Pre-fetching customer delivery address for instant access...');
      try {
        prefetchedCustomerAddress = await database.getCustomerAddress(restaurant.id, customerPhone);
        if (prefetchedCustomerAddress && prefetchedCustomerAddress.is_valid) {
          console.log(`✅ Address pre-loaded: ${prefetchedCustomerAddress.delivery_address} (${prefetchedCustomerAddress.delivery_instructions || 'no instructions'})`);
        } else {
          console.log('ℹ️  No saved address found for customer');
        }
      } catch (error) {
        console.error('⚠️  Failed to pre-fetch customer address:', error);
        // Continue anyway - will fetch on demand if needed
      }
    }

    const menuText = formatMenuForAI(restaurant.menu_items, restaurant);

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
      console.error('Failed to create OpenAI WebSocket:', createError);
      await initiateHangup('websocket_creation_failed');
      return;
    }

    setupOpenAIHandlers(menuText);
  }

  // Setup OpenAI WebSocket event handlers
  function setupOpenAIHandlers(menuText) {
    openaiWs.on('open', () => {
      console.log('Connected to OpenAI Realtime API');

      const instructions = generateAIInstructions(restaurant, customerPhone, menuText);

      const sessionUpdate = {
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          instructions: instructions,
          voice: restaurant.ai_voice || 'coral',
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          turn_detection: {
            type: 'semantic_vad'
          },
          temperature: 0.6,
          max_response_output_tokens: 400,
          tools: getAITools()
        }
      };

      console.log('📤 Sending session.update to OpenAI:', JSON.stringify({
        model: currentModel,
        voice: restaurant.ai_voice || 'coral',
        turn_detection: { type: 'semantic_vad' },
        audio_formats: { input: 'g711_ulaw', output: 'g711_ulaw' }
      }, null, 2));

      openaiWs.send(JSON.stringify(sessionUpdate));
    });

    openaiWs.on('message', handleOpenAIMessage);
    openaiWs.on('error', async (error) => {
      console.error('OpenAI WebSocket error:', error);

      // Check if this is a model error and we haven't tried fallback yet
      if (!modelFallbackAttempted && config.openai.fallbackModel &&
          (error.message?.includes('model') || error.code === 'invalid_model')) {
        console.log(`⚠️  Primary model '${currentModel}' failed, attempting fallback to '${config.openai.fallbackModel}'`);
        modelFallbackAttempted = true;
        currentModel = config.openai.fallbackModel;

        // Close current WebSocket and retry with fallback model
        if (openaiWs) {
          openaiWs.removeAllListeners();
          openaiWs.close();
        }

        // Retry connection with fallback model
        await initializeOpenAI(restaurant.phone_number, customerPhone, callSid);
      }
    });
    openaiWs.on('close', () => {
      console.log('OpenAI WebSocket closed');
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
        description: "Validate delivery address for feasibility. Include customer_name if known.",
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
        name: "check_customer_address",
        description: "ONLY for DELIVERY orders: Check if customer has a saved delivery address on file. Call this BEFORE asking for delivery address. NEVER call this for pickup orders.",
        parameters: {
          type: "object",
          properties: {},
          required: []
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
        description: "Submit a complete order to the system. Call this when customer confirms they're done ordering. NO PARAMETERS NEEDED - order details are extracted from conversation.",
        parameters: {
          type: "object",
          properties: {}
        }
      }
    ];
  }

  // Handle OpenAI messages
  async function handleOpenAIMessage(data) {
    try {
      const response = JSON.parse(data);

      // Log session-related messages for debugging
      if (response.type === 'session.created' || response.type === 'session.updated') {
        console.log('📥 OpenAI session response:', response.type);
        if (response.session) {
          console.log('   Turn detection:', response.session.turn_detection);
          console.log('   Audio formats:', {
            input: response.session.input_audio_format,
            output: response.session.output_audio_format
          });
        }
      }

      switch (response.type) {
        case 'session.updated':
          // Session is ready - send greeting immediately
          console.log('✅ OpenAI session ready - sending greeting');
          if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
            openaiWs.send(JSON.stringify({
              type: 'conversation.item.create',
              item: {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: 'Greet the customer and ask how you can help them' }]
              }
            }));

            if (!isResponseInProgress) {
              openaiWs.send(JSON.stringify({ type: 'response.create' }));
              isResponseInProgress = true;
            } else {
              console.log('⚠️  Skipping response.create - response already in progress');
            }

            // Cancel backup greeting since we've sent the greeting
            if (greetingTimeout) {
              clearTimeout(greetingTimeout);
              greetingTimeout = null;
              console.log('Backup greeting canceled (session.updated greeting sent)');
            }

            // Start activity monitoring for automatic timeout
            if (!activityCheckInterval) {
              activityCheckInterval = setInterval(() => {
                const now = Date.now();
                const inactiveMs = now - lastCustomerActivityTime;
                const totalCallMs = now - callStartTime;

                // Timeout conditions
                const maxInactivityMs = 3 * 60 * 1000; // 3 minutes of silence
                const maxCallDurationMs = 10 * 60 * 1000; // 10 minutes total

                if (inactiveMs > maxInactivityMs) {
                  console.log(`⏰ Call timeout: ${Math.round(inactiveMs / 1000)}s of inactivity (max: ${Math.round(maxInactivityMs / 1000)}s)`);
                  initiateHangup('inactivity_timeout');
                } else if (totalCallMs > maxCallDurationMs) {
                  console.log(`⏰ Call timeout: ${Math.round(totalCallMs / 1000)}s total duration (max: ${Math.round(maxCallDurationMs / 1000)}s)`);
                  initiateHangup('max_duration_exceeded');
                }
              }, 10000); // Check every 10 seconds
              console.log('✅ Activity monitoring started (3min inactivity, 10min max duration)');
            }
          }
          break;
        case 'response.audio.delta':
          if (streamSid && ws.readyState === WebSocket.OPEN) {
            // Store reference signal for echo cancellation (AI output)
            if (config.audioProcessing.enabled && config.audioProcessing.echoCancellation) {
              try {
                const audioBuffer = Buffer.from(response.delta, 'base64');
                // Keep last 480 samples for echo reference
                if (audioBuffer.length > 0) {
                  referenceSignal = new Int16Array(audioBuffer.buffer.slice(0, Math.min(480, audioBuffer.length)));
                }
              } catch (err) {
                // Ignore errors in reference signal capture
              }
            }

            ws.send(JSON.stringify({
              event: 'media',
              streamSid: streamSid,
              media: { payload: response.delta }
            }));
          }
          break;

        case 'response.done':
          console.log('Response completed');
          isResponseInProgress = false; // Response finished, ready for next one

          // Capture usage data from response
          // Usage tracking removed per user request
          break;

        case 'response.audio_transcript.done':
          console.log('AI said:', response.transcript);
          aiResponseCount++;

          // Track conversation for order extraction
          conversationLog.push({
            timestamp: Date.now(),
            speaker: 'ai',
            text: response.transcript
          });

          // Mark customer as having spoken after second AI response
          // (First response is the greeting, second means customer actually spoke)
          if (!customerHasSpoken && aiResponseCount > 1) {
            customerHasSpoken = true;
            console.log('Customer has spoken (detected after AI response #' + aiResponseCount + ')');
          }

          // NOTE: Order confirmation now handled via submit_order function call (not transcript parsing)
          // The old ORDER_CONFIRMED transcript parsing has been deprecated

          // Detect AI goodbye phrases and trigger graceful hangup
          // Only after customer has interacted (not just the initial greeting)
          const transcript = response.transcript.toLowerCase();
          const goodbyePhrases = [
            'goodbye',
            'good bye',
            'bye',
            'have a great day',
            'have a good day',
            'have a nice day',
            'have a wonderful day',
            'take care',
            'thank you for calling',
            'thanks for calling',
            'feel free to call back',
            'call back anytime',
            'call us back',
            'have a good one',
            'talk to you later',
            'see you',
            'bye bye'
          ];

          const isGoodbye = goodbyePhrases.some(phrase => transcript.includes(phrase));

          // Only trigger hangup if:
          // 1. It's a goodbye phrase, AND
          // 2. Customer has spoken (detected by multiple AI responses), AND
          // 3. No order was processed, AND
          // 4. No hangup timer already set
          if (isGoodbye && aiResponseCount > 1 && !orderProcessed && !hangupTimer) {
            console.log('AI goodbye detected after customer interaction - scheduling hangup');
            // Give AI 2 seconds to finish speaking before hangup
            hangupTimer = setTimeout(async () => {
              await initiateHangup('conversation_ended');
            }, 2000);
          } else if (isGoodbye && aiResponseCount === 1) {
            console.log('AI goodbye detected in greeting - ignoring');
          }
          break;

        case 'conversation.item.created':
          if (response.item?.type === 'function_call') {
            await handleFunctionCall(response.item);
          }
          break;

        case 'error':
          console.error('OpenAI error:', response.error);

          // Check if this is a model-related error and fallback is available
          if (!modelFallbackAttempted && config.openai.fallbackModel &&
              response.error?.message?.includes('model')) {
            console.log(`⚠️  Model error detected: ${response.error.message}`);
            console.log(`🔄 Switching from '${currentModel}' to fallback model '${config.openai.fallbackModel}'`);
            modelFallbackAttempted = true;
            currentModel = config.openai.fallbackModel;

            // Close current WebSocket and retry with fallback model
            if (openaiWs) {
              openaiWs.removeAllListeners();
              openaiWs.close();
            }

            // Retry connection with fallback model
            await initializeOpenAI(restaurant.phone_number, customerPhone, callSid);
          }
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
        recentOrders = await database.searchRecentOrders(phoneToSearch, restaurant.id);
        result = { orders: recentOrders, count: recentOrders.length };
        break;

      case 'check_customer_address':
        // Use pre-fetched address data for instant response (no API delay)
        console.log('⚡ Using pre-fetched customer address data (instant)');

        if (prefetchedCustomerAddress && prefetchedCustomerAddress.is_valid) {
          // Store the address ID for later use in order creation
          deliveryAddressId = prefetchedCustomerAddress.id;
          validatedDeliveryAddress = prefetchedCustomerAddress.delivery_address;
          deliveryInstructions = prefetchedCustomerAddress.delivery_instructions;
          addressValidated = true;

          // Track order state
          customerName = prefetchedCustomerAddress.customer_name;
          orderType = 'delivery'; // Customer asking for address means delivery order

          result = {
            has_saved_address: true,
            address_id: prefetchedCustomerAddress.id,
            customer_name: prefetchedCustomerAddress.customer_name,
            delivery_address: prefetchedCustomerAddress.delivery_address,
            delivery_instructions: prefetchedCustomerAddress.delivery_instructions,
            distance: prefetchedCustomerAddress.distance_from_restaurant,
            times_used: prefetchedCustomerAddress.times_used
          };

          console.log(`✅ Using pre-loaded address (ID: ${deliveryAddressId}): ${validatedDeliveryAddress}`);
          console.log(`📝 Order state updated: customerName="${customerName}", orderType="${orderType}"`);
        } else {
          // Still a delivery order, just no saved address
          orderType = 'delivery';
          result = {
            has_saved_address: false,
            message: 'No saved delivery address found'
          };
        }
        break;

      case 'validate_delivery_address':
        addressValidationAttempts++;
        const validationResult = await database.validateDeliveryAddress(
          parsedArgs.address,
          restaurant,
          customerPhone,  // Pass customerPhone for caching
          parsedArgs.customer_name || null  // Pass customer name if provided
        );

        if (validationResult.valid) {
          addressValidated = true;
          validatedDeliveryAddress = parsedArgs.address;

          // Track order state
          orderType = 'delivery';
          if (parsedArgs.customer_name) {
            customerName = parsedArgs.customer_name;
            console.log(`📝 Customer name set from address validation: "${customerName}"`);
          }

          // Store the address ID if this address was saved to cache
          if (validationResult.address_id) {
            deliveryAddressId = validationResult.address_id;
            console.log(`✅ New address validated and saved (ID: ${deliveryAddressId})`);
          }

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
        if (shouldCreateCustomerMessage(parsedArgs.message_content)) {
          const messageResult = await database.createCustomerMessage({
            restaurant_id: restaurant.id,
            customer_name: parsedArgs.customer_name,
            customer_phone: customerPhone,
            message_content: parsedArgs.message_content,
            priority: parsedArgs.priority || 'normal',
            subject: parsedArgs.subject || 'Customer Message'
          });
          result = { success: !!messageResult, message_id: messageResult?.id };
        } else {
          result = { success: false, reason: 'Message intent not suitable for storage' };
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
            result = {
              success: false,
              should_create_message: true,
              message: "I've saved your request. The restaurant will call you back to help with this."
            };
            break;
          }

          // Check if this specific reason is in the forwarding reasons array
          const forwardingReasons = restaurant.call_forwarding_reasons || [];
          const shouldForward = forwardingReasons.includes(reason);

          if (!shouldForward) {
            console.log(`❌ Reason "${reason}" not in forwarding reasons: ${forwardingReasons.join(', ')}`);
            result = {
              success: false,
              should_create_message: true,
              message: "I've saved your request. The restaurant will call you back to help with this."
            };
            break;
          }

          // Check if forwarding number is configured
          if (!restaurant.call_forwarding_number) {
            console.error('❌ Call forwarding enabled but no number configured');
            result = {
              success: false,
              should_create_message: true,
              message: "I've saved your request. The restaurant will call you back to help with this."
            };
            break;
          }

          // Perform the transfer
          console.log(`✅ Transferring call to ${restaurant.call_forwarding_number} - Reason: ${reason}`);
          const transferMessages = {
            'transfer_call_for_catering': 'Transferring you to our catering specialist',
            'transfer_call_for_manager': 'Transferring you to the manager',
            'transfer_call_for_complaint': 'Transferring you to our staff to help with your concern',
            'transfer_call_for_credit_card': 'Transferring you to process your payment'
          };

          const transferResult = await twilioService.transferCall(
            callSid,
            restaurant.call_forwarding_number,
            transferMessages[functionName]
          );

          if (transferResult.success) {
            console.log(`✅ Call transferred successfully to ${restaurant.call_forwarding_number}`);
            result = {
              success: true,
              transferred_to: restaurant.call_forwarding_number,
              message: "Transferring you now. Please hold."
            };
          } else {
            console.error('❌ Transfer failed:', transferResult.error);
            result = {
              success: false,
              should_create_message: true,
              message: "I've saved your request. The restaurant will call you back to help with this."
            };
          }
        }
        break;

      case 'submit_order':
        console.log('📦 submit_order called (parameter-free)');

        // Extract order info from conversation and tracked state
        const orderInfo = {
          ...extractOrderFromConversation(),
          customerPhone: customerPhone,
          specialInstructions: ''
        };

        console.log('📦 Extracted order info:', JSON.stringify(orderInfo, null, 2));

        // Validate the order
        const validation = validateOrder(orderInfo);
        if (!validation.valid) {
          console.log('❌ INVALID ORDER REJECTED:', validation.reason);
          console.log('❌ Order details:', JSON.stringify(orderInfo, null, 2));
          result = {
            success: false,
            error: validation.reason,
            message: `Order validation failed: ${validation.reason}. Please check the order details and try again.`
          };
          break;
        }

        console.log('✅ Order validation passed');

        // Process the order (same logic as processOrderFromTranscript)
        try {
          orderProcessed = true;

          const isDelivery = orderInfo.orderType === 'delivery';
          const isCreditCard = orderInfo.paymentMethod && orderInfo.paymentMethod.toLowerCase() === 'credit card';

          // AI calculates the final total - we use it as-is
          const readyTimeInfo = calculateOrderReadyTime(restaurant, isDelivery);
          const finalTotal = orderInfo.totalAmount; // AI's calculated total (food + delivery + tax)

          // Back-calculate components for display purposes only
          const deliveryFee = isDelivery ? (restaurant.delivery_fee || 0) : 0;
          const taxRate = restaurant.tax_rate || 0;
          // Work backwards: finalTotal = subtotal + deliveryFee + tax
          // tax = (subtotal + deliveryFee) * taxRate
          // finalTotal = subtotal + deliveryFee + ((subtotal + deliveryFee) * taxRate)
          // finalTotal = (subtotal + deliveryFee) * (1 + taxRate)
          // subtotal + deliveryFee = finalTotal / (1 + taxRate)
          const subtotalPlusDelivery = finalTotal / (1 + taxRate);
          const subtotal = subtotalPlusDelivery - deliveryFee;
          const taxAmount = finalTotal - subtotalPlusDelivery;

          console.log('💰 Order pricing (AI calculated total, components for display):');
          console.log(`   AI provided total: $${finalTotal.toFixed(2)}`);
          console.log(`   Back-calculated food subtotal: $${subtotal.toFixed(2)}`);
          console.log(`   Delivery fee: $${deliveryFee.toFixed(2)}`);
          console.log(`   Tax amount: $${taxAmount.toFixed(2)}`);
          console.log(`   FINAL TOTAL: $${finalTotal.toFixed(2)} (from AI)`);

          // Determine order status
          let orderStatus = 'pending';
          if (isCreditCard) {
            orderStatus = 'credit_card';
          }

          // Create order ticket
          const ticket = createOrderTicket({
            customerName: orderInfo.customerName,
            customerPhone: orderInfo.customerPhone,
            orderType: orderInfo.orderType,
            deliveryAddress: orderInfo.deliveryAddress,
            deliveryInstructions: orderInfo.deliveryInstructions,
            paymentMethod: orderInfo.paymentMethod,
            items: orderInfo.items,
            specialInstructions: orderInfo.specialInstructions,
            subtotal: subtotal,
            deliveryFee: deliveryFee,
            taxRate: restaurant.tax_rate || 0,
            taxAmount: taxAmount,
            totalAmount: finalTotal,
            readyTime: readyTimeInfo.readyTimeString,
            restaurantName: restaurant.name
          });

          // Create order in database
          const orderData = {
            restaurant_id: restaurant.id,
            customer_name: orderInfo.customerName,
            customer_phone: orderInfo.customerPhone,
            order_type: orderInfo.orderType,
            delivery_address: orderInfo.deliveryAddress,
            delivery_instructions: orderInfo.deliveryInstructions,
            delivery_address_id: isDelivery ? deliveryAddressId : null,
            payment_method: orderInfo.paymentMethod || null,
            order_details: ticket,
            total_amount: finalTotal,
            special_instructions: orderInfo.specialInstructions || '',
            call_sid: callSid,
            ready_time: readyTimeInfo.readyTimeString,
            estimated_ready_at: readyTimeInfo.readyTime,
            status: orderStatus
          };

          console.log('Creating order with delivery_address_id:', deliveryAddressId);

          // Update delivery instructions if needed
          if (isDelivery && deliveryAddressId && orderInfo.deliveryInstructions) {
            await database.updateDeliveryInstructions(deliveryAddressId, orderInfo.deliveryInstructions);
          }

          const order = await database.createOrder(orderData);

          if (order) {
            console.log('Order created successfully:', order.id);
            console.log('\n' + ticket + '\n');

            stateManager.updateCallData(callSid, { order_id: order.id });

            // Check if we need to transfer for credit card payment
            if (isCreditCard) {
              const forwardingReasons = restaurant.call_forwarding_reasons || [];
              const shouldTransfer = restaurant.call_forwarding_enabled &&
                                    forwardingReasons.includes('credit_card_payment') &&
                                    restaurant.call_forwarding_number;

              if (shouldTransfer) {
                console.log('💳 Credit card order - transferring call for payment processing');

                const transferResult = await twilioService.transferCall(
                  callSid,
                  restaurant.call_forwarding_number,
                  'Your order has been placed. Transferring you now to the restaurant to process your credit card payment. If no one is available, someone will call you back shortly.'
                );

                if (transferResult.success) {
                  console.log(`✅ Call transferred successfully for credit card payment to ${restaurant.call_forwarding_number}`);
                  result = {
                    success: true,
                    order_id: order.id,
                    transferred: true,
                    ready_time: readyTimeInfo.readyTimeString,
                    total_minutes: readyTimeInfo.totalMinutes,
                    subtotal: subtotal,
                    final_total: finalTotal
                  };
                } else {
                  console.error('❌ Credit card payment transfer failed:', transferResult.error);
                  hangupTimer = setTimeout(async () => {
                    await initiateHangup('order_completed_transfer_failed');
                  }, 5000);
                  result = {
                    success: true,
                    order_id: order.id,
                    transferred: false,
                    ready_time: readyTimeInfo.readyTimeString,
                    total_minutes: readyTimeInfo.totalMinutes,
                    subtotal: subtotal,
                    final_total: finalTotal
                  };
                }
              } else {
                console.log('💳 Credit card order created but call forwarding not configured - normal hangup');
                hangupTimer = setTimeout(async () => {
                  await initiateHangup('order_completed');
                }, 5000);
                result = {
                  success: true,
                  order_id: order.id,
                  transferred: false,
                  ready_time: readyTimeInfo.readyTimeString,
                  total_minutes: readyTimeInfo.totalMinutes,
                  subtotal: subtotal,
                  final_total: finalTotal
                };
              }
            } else {
              // Cash order or no payment method - normal hangup
              hangupTimer = setTimeout(async () => {
                await initiateHangup('order_completed');
              }, 5000);
              result = {
                success: true,
                order_id: order.id,
                transferred: false,
                ready_time: readyTimeInfo.readyTimeString,
                total_minutes: readyTimeInfo.totalMinutes,
                subtotal: subtotal,
                final_total: finalTotal
              };
            }
          } else {
            result = {
              success: false,
              error: 'Failed to create order in database'
            };
          }
        } catch (error) {
          console.error('Error processing order:', error);
          result = {
            success: false,
            error: error.message
          };
        }
        break;

    }

    // Send function result back to OpenAI
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: item.call_id,
          output: JSON.stringify(result)
        }
      }));

      // CRITICAL: Trigger AI to respond after function result
      // Without this, AI receives the result but doesn't know to respond to customer
      // Check if response already in progress to prevent race condition
      if (!isResponseInProgress) {
        openaiWs.send(JSON.stringify({
          type: 'response.create'
        }));
        isResponseInProgress = true;
      } else {
        console.log('⚠️  Skipping response.create after function - response already in progress');
      }
    }
  }

  // Extract order details from conversation log
  function extractOrderFromConversation() {
    console.log('🔍 Extracting order details from conversation...');

    // Get recent conversation (last 10 messages)
    const recentMessages = conversationLog.slice(-10);
    const conversationText = recentMessages.map(m => m.text).join(' ').toLowerCase();

    console.log('📝 Analyzing conversation:', conversationText.substring(0, 200) + '...');

    // Extract items (look for quantity + food patterns)
    let items = '';
    let totalAmount = 0;
    let paymentMethod = null;

    // Parse items from conversation
    // Look for patterns like "one hamburger", "1 hamburger", "two burgers", etc.
    const itemPatterns = [
      /(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s*(x\s*)?([a-z\s]+(?:burger|pizza|fries|fry|sandwich|salad|drink|soda|chicken|wings))/gi,
      /(\d+)\s*([a-z\s]+)/gi // Generic number + item pattern
    ];

    const foundItems = [];
    for (const pattern of itemPatterns) {
      const matches = conversationText.matchAll(pattern);
      for (const match of matches) {
        const quantity = match[1];
        const item = (match[3] || match[2] || '').trim();
        if (item && item.length > 2) {
          // Convert word numbers to digits
          const quantityMap = {
            'one': '1', 'two': '2', 'three': '3', 'four': '4', 'five': '5',
            'six': '6', 'seven': '7', 'eight': '8', 'nine': '9', 'ten': '10'
          };
          const qty = quantityMap[quantity.toLowerCase()] || quantity;
          foundItems.push(`${qty}x ${item}`);
        }
      }
    }

    if (foundItems.length > 0) {
      items = foundItems.join(', ');
      console.log('🍔 Found items:', items);
    }

    // Extract total amount (look for $ amounts mentioned)
    const totalMatches = conversationText.match(/\$(\d+\.?\d*)/g);
    if (totalMatches && totalMatches.length > 0) {
      // Get the last mentioned price (likely the total)
      const lastPrice = totalMatches[totalMatches.length - 1];
      totalAmount = parseFloat(lastPrice.replace('$', ''));
      console.log('💰 Found total:', totalAmount);
    }

    // Extract payment method
    if (conversationText.includes('cash')) {
      paymentMethod = 'cash';
      console.log('💵 Payment method: cash');
    } else if (conversationText.includes('credit card') || conversationText.includes('card')) {
      paymentMethod = 'credit card';
      console.log('💳 Payment method: credit card');
    }

    // Use tracked state for customer name and order type
    const extractedCustomerName = customerName || 'Unknown';
    const extractedOrderType = orderType || 'pickup';

    console.log('📋 Order extraction complete:', {
      customerName: extractedCustomerName,
      orderType: extractedOrderType,
      items: items || '(none found)',
      totalAmount,
      paymentMethod: paymentMethod || 'N/A'
    });

    return {
      customerName: extractedCustomerName,
      orderType: extractedOrderType,
      deliveryAddress: validatedDeliveryAddress || 'N/A',
      deliveryInstructions: deliveryInstructions || null,
      paymentMethod: paymentMethod || null,
      items: items,
      totalAmount: totalAmount
    };
  }

  // Validate order to prevent fake/invalid orders
  function validateOrder(orderInfo) {
    // Check 1: Total must be greater than $0
    if (orderInfo.totalAmount <= 0) {
      return {
        valid: false,
        reason: 'Order total is $0 or negative'
      };
    }

    // Check 2: Items field must not be empty
    if (!orderInfo.items || orderInfo.items.trim().length === 0) {
      return {
        valid: false,
        reason: 'No items specified'
      };
    }

    // Check 3: Items must contain quantities or appear to be real orders
    // Reject vague items like just "Burgers" without quantity/specifics
    const items = orderInfo.items.toLowerCase();
    const hasQuantity = /\d+x|\d+ x|\d+\s+x|quantity|count/i.test(orderInfo.items);
    const hasPrice = /\$\d+/.test(orderInfo.items);
    const isVague = items === 'burgers' || items === 'pizza' || items === 'food' ||
                    items.length < 5 || items.split(' ').length <= 2;

    if (isVague && !hasQuantity && !hasPrice) {
      return {
        valid: false,
        reason: `Items too vague or incomplete: "${orderInfo.items}"`
      };
    }

    // Check 4: Customer name must not be empty
    if (!orderInfo.customerName || orderInfo.customerName === 'Unknown') {
      return {
        valid: false,
        reason: 'Customer name missing'
      };
    }

    // Order appears valid
    return { valid: true };
  }

  // Process order from transcript
  async function processOrderFromTranscript(transcript) {
    console.log('Processing order from transcript...');

    try {
      const orderInfo = parseOrderConfirmation(transcript);

      if (!orderInfo) {
        console.error('Failed to parse order confirmation');
        return;
      }

      // VALIDATION: Reject invalid/fake orders
      const isValidOrder = validateOrder(orderInfo);
      if (!isValidOrder.valid) {
        console.error('❌ INVALID ORDER REJECTED:', isValidOrder.reason);
        console.error('Order details:', orderInfo);
        console.log('⚠️  AI attempted to create invalid order - ignoring ORDER_CONFIRMED');
        return; // Don't set orderProcessed - allow call to continue normally
      }

      // Only mark as processed if order is valid
      orderProcessed = true;

      const readyTimeInfo = calculateOrderReadyTime(restaurant, orderInfo.orderType === 'delivery');

      // Calculate order totals with tax and delivery fee
      const subtotal = orderInfo.totalAmount;
      const isDelivery = orderInfo.orderType === 'delivery';
      const deliveryFee = isDelivery && restaurant.delivery_fee ? restaurant.delivery_fee : 0;
      const taxableAmount = subtotal + deliveryFee;
      const taxAmount = restaurant.tax_rate ? taxableAmount * restaurant.tax_rate : 0;
      const finalTotal = taxableAmount + taxAmount;

      console.log('Order pricing breakdown:', {
        subtotal,
        deliveryFee,
        taxRate: restaurant.tax_rate,
        taxAmount,
        finalTotal
      });

      // Determine order status based on payment method
      const isCreditCard = orderInfo.paymentMethod === 'credit card';
      const orderStatus = isCreditCard ? 'credit_card' : 'pending';

      // Generate complete order ticket BEFORE creating order
      const ticket = createOrderTicket({
        ...orderInfo,
        subtotal,
        deliveryFee,
        taxRate: restaurant.tax_rate,
        taxAmount,
        totalAmount: finalTotal,
        readyTime: readyTimeInfo.readyTimeString,
        restaurantName: restaurant.name
      });

      const orderData = {
        restaurant_id: restaurant.id,
        customer_name: orderInfo.customerName,
        customer_phone: customerPhone,
        order_type: orderInfo.orderType,
        delivery_address: orderInfo.deliveryAddress,
        delivery_instructions: orderInfo.deliveryInstructions,
        delivery_address_id: isDelivery ? deliveryAddressId : null, // Link to cached address if delivery
        payment_method: orderInfo.paymentMethod || null,
        order_details: ticket, // Store complete formatted ticket
        total_amount: finalTotal,
        special_instructions: orderInfo.specialInstructions || '',
        call_sid: callSid,
        ready_time: readyTimeInfo.readyTimeString,
        estimated_ready_at: readyTimeInfo.readyTime,
        status: orderStatus
      };

      console.log('Creating order with delivery_address_id:', deliveryAddressId);

      // If delivery order with address ID, update delivery instructions in cached address
      if (isDelivery && deliveryAddressId && orderInfo.deliveryInstructions) {
        await database.updateDeliveryInstructions(deliveryAddressId, orderInfo.deliveryInstructions);
      }

      const order = await database.createOrder(orderData);

      if (order) {
        console.log('Order created successfully:', order.id);
        console.log('\n' + ticket + '\n');

        // Update call data with order reference
        stateManager.updateCallData(callSid, { order_id: order.id });

        // Check if we need to transfer for credit card payment
        if (isCreditCard) {
          const forwardingReasons = restaurant.call_forwarding_reasons || [];
          const shouldTransfer = restaurant.call_forwarding_enabled &&
                                forwardingReasons.includes('credit_card_payment') &&
                                restaurant.call_forwarding_number;

          if (shouldTransfer) {
            console.log('💳 Credit card order - transferring call for payment processing');

            // Transfer call for credit card processing
            const transferResult = await twilioService.transferCall(
              callSid,
              restaurant.call_forwarding_number,
              'Your order has been placed. Transferring you now to the restaurant to process your credit card payment. If no one is available, someone will call you back shortly.'
            );

            if (transferResult.success) {
              console.log(`✅ Call transferred successfully for credit card payment to ${restaurant.call_forwarding_number}`);
            } else {
              console.error('❌ Credit card payment transfer failed:', transferResult.error);
              // Fallback to normal hangup if transfer fails
              hangupTimer = setTimeout(async () => {
                await initiateHangup('order_completed_transfer_failed');
              }, 3000);
            }
          } else {
            console.log('💳 Credit card order created but call forwarding not configured - normal hangup');
            // Schedule hangup after 3 seconds to allow AI to finish speaking goodbye message
            hangupTimer = setTimeout(async () => {
              await initiateHangup('order_completed');
            }, 3000);
          }
        } else {
          // Cash order or no payment method - normal hangup
          hangupTimer = setTimeout(async () => {
            await initiateHangup('order_completed');
          }, 3000);
        }
      }
    } catch (error) {
      console.error('Error processing order:', error);
    }
  }

  // Parse ORDER_CONFIRMED format from transcript
  function parseOrderConfirmation(transcript) {
    try {
      const lines = transcript.split('\n');
      const orderInfo = {
        customerName: '',
        customerPhone: customerPhone,
        orderType: 'pickup',
        deliveryAddress: 'N/A',
        deliveryInstructions: null,
        paymentMethod: null,
        items: '',
        totalAmount: 0,
        specialInstructions: ''
      };

      for (const line of lines) {
        if (line.includes('Customer Name:')) {
          orderInfo.customerName = line.split(':')[1]?.trim() || 'Unknown';
        } else if (line.includes('Order Type:')) {
          orderInfo.orderType = line.split(':')[1]?.trim().toLowerCase() || 'pickup';
        } else if (line.includes('Delivery Address:')) {
          const addr = line.split(':')[1]?.trim();
          orderInfo.deliveryAddress = addr && addr !== 'N/A' ? addr : 'N/A';
        } else if (line.includes('Delivery Instructions:')) {
          const instructions = line.split(':')[1]?.trim();
          orderInfo.deliveryInstructions = instructions && instructions !== 'N/A' ? instructions : null;
        } else if (line.includes('Payment Method:')) {
          const method = line.split(':')[1]?.trim().toLowerCase();
          orderInfo.paymentMethod = method && method !== 'n/a' ? method : null;
        } else if (line.includes('Items:')) {
          orderInfo.items = line.split(':')[1]?.trim() || '';
        } else if (line.includes('Total:')) {
          const totalMatch = line.match(/\$?(\d+\.?\d*)/);
          orderInfo.totalAmount = totalMatch ? parseFloat(totalMatch[1]) : 0;
        }
      }

      return orderInfo;
    } catch (error) {
      console.error('Error parsing order confirmation:', error);
      return null;
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

          const calledNumber = msg.start.customParameters?.Called;
          const fromNumber = msg.start.customParameters?.From;

          await initializeOpenAI(calledNumber, fromNumber, callSid);

          // Set greeting timeout as backup (in case session.updated doesn't trigger greeting)
          greetingTimeout = setTimeout(() => {
            if (!customerHasSpoken && openaiWs && openaiWs.readyState === WebSocket.OPEN) {
              console.log('⚠️  Backup greeting triggered (session.updated greeting did not fire)');
              openaiWs.send(JSON.stringify({
                type: 'conversation.item.create',
                item: {
                  type: 'message',
                  role: 'user',
                  content: [{ type: 'input_text', text: 'Greet the customer and ask how you can help them' }]
                }
              }));

              if (!isResponseInProgress) {
                openaiWs.send(JSON.stringify({ type: 'response.create' }));
                isResponseInProgress = true;
              } else {
                console.log('⚠️  Skipping backup greeting response.create - response already in progress');
              }
            }
          }, 3000); // 3 seconds - enough time for session.updated to arrive
          break;

        case 'media':
          if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
            // Update activity timestamp for timeout tracking
            lastCustomerActivityTime = Date.now();

            let audioPayload = msg.media.payload;
            const inputBuffer = Buffer.from(audioPayload, 'base64');

            // Apply audio processing if enabled
            if (config.audioProcessing.enabled) {
              try {
                const processedBuffer = audioProcessor.processAudio(inputBuffer, {
                  noiseSuppression: config.audioProcessing.noiseSuppression,
                  echoCancellation: config.audioProcessing.echoCancellation,
                  autoGainControl: config.audioProcessing.autoGainControl,
                  referenceSignal: referenceSignal
                });
                audioPayload = processedBuffer.toString('base64');
              } catch (error) {
                console.error('Audio processing error:', error);
                // Fall back to original audio on error
              }
            }

            const audioAppend = {
              type: 'input_audio_buffer.append',
              audio: audioPayload
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

    // Clear activity check interval
    if (activityCheckInterval) {
      clearInterval(activityCheckInterval);
      activityCheckInterval = null;
    }

    // Note: Call logging is handled by Twilio webhooks, not here

    // Clean up call state
    stateManager.removeCallData(callSid);

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

// Initialize audio processor
(async () => {
  if (config.audioProcessing.enabled) {
    console.log('🔊 Initializing audio processor...');
    await audioProcessor.initialize();
  }
})();

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
  console.log(`Audio Processing: ${config.audioProcessing.enabled ? '✅ ENABLED' : '❌ DISABLED'}`);
  if (config.audioProcessing.enabled) {
    console.log(`  • Noise Suppression: ${config.audioProcessing.noiseSuppression ? 'ON' : 'OFF'}`);
    console.log(`  • Echo Cancellation: ${config.audioProcessing.echoCancellation ? 'ON' : 'OFF'}`);
    console.log(`  • Auto Gain Control: ${config.audioProcessing.autoGainControl ? 'ON' : 'OFF'}`);
  }
  console.log(`${'='.repeat(60)}\n`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  audioProcessor.cleanup();
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully...');
  audioProcessor.cleanup();
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

// Periodic cleanup of old call data
setInterval(() => {
  stateManager.cleanupOldCalls(60);
}, 15 * 60 * 1000); // Every 15 minutes
