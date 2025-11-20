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
          input_audio_transcription: {
            model: 'whisper-1'
          },
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
        name: "set_order_type",
        description: "Store whether this is a pickup or delivery order. Call IMMEDIATELY when customer says 'pickup' or 'delivery'.",
        parameters: {
          type: "object",
          properties: {
            order_type: {
              type: "string",
              enum: ["pickup", "delivery"],
              description: "The order type customer requested"
            }
          },
          required: ["order_type"]
        }
      },
      {
        type: "function",
        name: "set_customer_name",
        description: "Store customer's name. Call IMMEDIATELY after customer provides their name.",
        parameters: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Customer's name as they said it (e.g., 'Mike', 'Sarah Johnson')"
            }
          },
          required: ["name"]
        }
      },
      {
        type: "function",
        name: "add_order_item",
        description: "Add a food item to the order. Call this EACH TIME customer mentions a food item.",
        parameters: {
          type: "object",
          properties: {
            item_name: {
              type: "string",
              description: "Name of the food item (e.g., 'pizza', 'cheeseburger', 'fries')"
            },
            size: {
              type: "string",
              description: "Size if mentioned (e.g., 'large', 'medium', 'small')"
            },
            quantity: {
              type: "number",
              description: "Quantity ordered (default: 1)"
            },
            customizations: {
              type: "string",
              description: "Any customizations mentioned (e.g., 'no pickles', 'extra cheese', 'well done')"
            }
          },
          required: ["item_name", "quantity"]
        }
      },
      {
        type: "function",
        name: "set_delivery_instructions",
        description: "Store delivery instructions for delivery orders. Call when customer provides delivery instructions.",
        parameters: {
          type: "object",
          properties: {
            instructions: {
              type: "string",
              description: "Delivery instructions (e.g., 'Leave at front door', 'Ring doorbell', 'Side entrance')"
            }
          },
          required: ["instructions"]
        }
      },
      {
        type: "function",
        name: "set_payment_method",
        description: "Record payment method for delivery orders. Call when customer says 'cash' or 'credit card'.",
        parameters: {
          type: "object",
          properties: {
            method: {
              type: "string",
              enum: ["cash", "credit card"],
              description: "Payment method customer chose"
            }
          },
          required: ["method"]
        }
      },
      {
        type: "function",
        name: "finalize_order",
        description: "Create order from all collected data. Call this when customer confirms they're done ordering and you have all required information.",
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

        case 'input_audio_buffer.speech_started':
          console.log('🎤 Customer started speaking');
          break;

        case 'input_audio_buffer.speech_stopped':
          console.log('🎤 Customer stopped speaking');
          break;

        case 'conversation.item.input_audio_transcription.completed':
          const customerText = response.transcript || '';
          console.log('👤 Customer said:', customerText);

          // Track customer speech in conversation log
          conversationLog.push({
            timestamp: Date.now(),
            speaker: 'customer',
            text: customerText
          });
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
          // ⚠️ DO NOT set customerName from cached address - customer will provide name during call
          // The cached name is just for reference (different person might be calling)
          orderType = 'delivery'; // Customer asking for address means delivery order

          result = {
            has_saved_address: true,
            address_id: prefetchedCustomerAddress.id,
            delivery_address: prefetchedCustomerAddress.delivery_address,
            delivery_instructions: prefetchedCustomerAddress.delivery_instructions,
            distance: prefetchedCustomerAddress.distance_from_restaurant,
            times_used: prefetchedCustomerAddress.times_used
            // NOTE: customer_name intentionally excluded - AI should NOT confirm/validate names
            // The stored name is just for database reference, not for customer validation
          };

          console.log(`✅ Using pre-loaded address (ID: ${deliveryAddressId}): ${validatedDeliveryAddress}`);
          console.log(`📝 Order state updated: orderType="${orderType}" (customer name will be extracted from conversation)`);
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

      case 'set_order_type':
        console.log('📋 set_order_type called:', parsedArgs.order_type);
        orderType = parsedArgs.order_type;
        stateManager.updateCallData(callSid, { order_type: parsedArgs.order_type });
        result = {
          success: true,
          order_type: parsedArgs.order_type,
          next_action: 'ask_for_name',
          message: `Order type set to ${parsedArgs.order_type}. Now ask for customer name.`
        };
        break;

      case 'set_customer_name':
        console.log('👤 set_customer_name called:', parsedArgs.name);
        customerName = parsedArgs.name;
        stateManager.updateCallData(callSid, { customer_name: parsedArgs.name });

        // Return success with next step instructions based on order type
        if (orderType === 'delivery') {
          result = {
            success: true,
            stored_name: parsedArgs.name,
            next_action: 'check_customer_address',
            message: 'Name stored. Now checking for saved delivery address...'
          };
        } else if (orderType === 'pickup') {
          result = {
            success: true,
            stored_name: parsedArgs.name,
            next_action: 'ask_for_order',
            message: 'Name stored. Now ask customer what they want to order.'
          };
        } else {
          result = {
            success: true,
            stored_name: parsedArgs.name
          };
        }
        break;

      case 'set_delivery_instructions':
        console.log('📝 set_delivery_instructions called:', parsedArgs.instructions);
        stateManager.updateCallData(callSid, {
          deliveryInstructions: parsedArgs.instructions,
          deliveryAddress: validatedDeliveryAddress
        });
        // Also update the global variable for backward compatibility
        deliveryInstructions = parsedArgs.instructions;
        result = {
          success: true,
          instructions: parsedArgs.instructions,
          message: 'Delivery instructions stored.'
        };
        break;

      case 'add_order_item':
        console.log('🍕 add_order_item called:', parsedArgs);
        const callData = stateManager.getCallData(callSid) || {};
        const currentItems = callData.order_items || [];

        // Create new item object
        const newItem = {
          item_name: parsedArgs.item_name,
          size: parsedArgs.size || null,
          quantity: parsedArgs.quantity || 1,
          customizations: parsedArgs.customizations || null
        };

        currentItems.push(newItem);
        stateManager.updateCallData(callSid, { order_items: currentItems });

        result = {
          success: true,
          item_added: newItem,
          total_items: currentItems.length
        };
        break;

      case 'set_payment_method':
        console.log('💳 set_payment_method called:', parsedArgs.method);
        stateManager.updateCallData(callSid, { payment_method: parsedArgs.method });
        result = {
          success: true,
          payment_method: parsedArgs.method,
          next_action: 'finalize_order',
          message: 'Payment method recorded. Now call finalize_order immediately.'
        };
        break;

      case 'finalize_order':
        console.log('✅ finalize_order called - creating order from collected data');

        // Get all collected data from state
        const orderCallData = stateManager.getCallData(callSid) || {};
        const collectedItems = orderCallData.order_items || [];
        const collectedName = orderCallData.customer_name || customerName || 'Unknown';
        const collectedPaymentMethod = orderCallData.payment_method || null;

        console.log('📦 Collected order data:', {
          name: collectedName,
          items: collectedItems,
          payment: collectedPaymentMethod,
          orderType: orderType
        });

        // Process the order
        try {
          orderProcessed = true;

          const isDelivery = orderType === 'delivery';
          const isCreditCard = collectedPaymentMethod && collectedPaymentMethod.toLowerCase() === 'credit card';

          // Calculate pricing from collected structured items
          let subtotal = 0;
          let itemsWithPrices = [];
          let itemsText = '';

          for (const collectedItem of collectedItems) {
            // Find matching menu item in database
            const menuItem = restaurant.menu_items?.find(item =>
              item.name.toLowerCase().includes(collectedItem.item_name.toLowerCase()) ||
              collectedItem.item_name.toLowerCase().includes(item.name.toLowerCase())
            );

            if (menuItem) {
              let itemPrice = 0;
              let sizeText = '';

              // Get price based on size
              if (collectedItem.size && menuItem.sizes && menuItem.sizes.length > 0) {
                const sizeOption = menuItem.sizes.find(s =>
                  s.size.toLowerCase() === collectedItem.size.toLowerCase()
                );
                if (sizeOption) {
                  itemPrice = sizeOption.price;
                  sizeText = sizeOption.size;
                } else {
                  // Use first size as default if specified size not found
                  itemPrice = menuItem.sizes[0].price;
                  sizeText = menuItem.sizes[0].size;
                }
              } else if (menuItem.sizes && menuItem.sizes.length > 0) {
                // No size specified, use first/default size
                itemPrice = menuItem.sizes[0].price;
                sizeText = menuItem.sizes.length > 1 ? menuItem.sizes[0].size : '';
              }

              const lineTotal = itemPrice * collectedItem.quantity;
              subtotal += lineTotal;

              itemsWithPrices.push({
                qty: collectedItem.quantity,
                name: menuItem.name,
                size: sizeText || null,
                price: itemPrice,
                lineTotal: lineTotal,
                customizations: collectedItem.customizations
              });

              const customText = collectedItem.customizations ? ` (${collectedItem.customizations})` : '';
              const sizePrefix = sizeText ? `${sizeText} ` : '';
              itemsText += `${collectedItem.quantity}x ${sizePrefix}${menuItem.name}${customText}, `;

              console.log(`✅ Matched: ${collectedItem.quantity}x ${sizePrefix}${menuItem.name} @ $${itemPrice.toFixed(2)} = $${lineTotal.toFixed(2)}${customText}`);
            } else {
              console.log(`⚠️  Could not find menu item for: ${collectedItem.item_name}`);
              // Add item anyway with $0 price so restaurant sees the order
              itemsWithPrices.push({
                qty: collectedItem.quantity,
                name: collectedItem.item_name,
                size: collectedItem.size || null,
                price: 0,
                lineTotal: 0,
                customizations: collectedItem.customizations
              });
              const customText = collectedItem.customizations ? ` (${collectedItem.customizations})` : '';
              itemsText += `${collectedItem.quantity}x ${collectedItem.item_name}${customText} (price unknown), `;
            }
          }

          // Remove trailing comma and space
          itemsText = itemsText.replace(/, $/, '');

          const readyTimeInfo = calculateOrderReadyTime(restaurant, isDelivery);
          const deliveryFee = isDelivery ? (restaurant.delivery_fee || 0) : 0;
          const taxRate = restaurant.tax_rate || 0;

          // Calculate tax on (subtotal + delivery fee)
          const taxableAmount = subtotal + deliveryFee;
          const taxAmount = taxableAmount * taxRate;

          // Calculate final total and round to 2 decimal places
          const finalTotal = Math.round((subtotal + deliveryFee + taxAmount) * 100) / 100;

          console.log('💰 Order pricing (calculated from database menu prices):');
          console.log(`   Food subtotal: $${subtotal.toFixed(2)} (from menu prices)`);
          console.log(`   Delivery fee: $${deliveryFee.toFixed(2)}`);
          console.log(`   Taxable amount: $${taxableAmount.toFixed(2)}`);
          console.log(`   Tax (${(taxRate * 100).toFixed(2)}%): $${taxAmount.toFixed(2)}`);
          console.log(`   FINAL TOTAL: $${finalTotal.toFixed(2)}`);

          // Determine order status
          let orderStatus = 'pending';
          if (isCreditCard) {
            orderStatus = 'credit_card';
          }

          // Get delivery info if delivery order
          let deliveryAddress = '';
          let deliveryInstructions = '';
          if (isDelivery && deliveryAddressId) {
            const addressData = stateManager.getCallData(callSid);
            deliveryAddress = addressData?.deliveryAddress || validatedDeliveryAddress || '';
            deliveryInstructions = addressData?.deliveryInstructions || '';
          }

          // Create order ticket
          const ticket = createOrderTicket({
            customerName: collectedName,
            customerPhone: customerPhone,
            orderType: orderType,
            deliveryAddress: deliveryAddress,
            deliveryInstructions: deliveryInstructions,
            paymentMethod: collectedPaymentMethod,
            items: itemsText,
            itemsWithPrices: itemsWithPrices,
            specialInstructions: '',
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
            customer_name: collectedName,
            customer_phone: customerPhone,
            order_type: orderType,
            delivery_address: deliveryAddress,
            delivery_instructions: deliveryInstructions,
            delivery_address_id: isDelivery ? deliveryAddressId : null,
            payment_method: collectedPaymentMethod || null,
            order_details: ticket,
            total_amount: finalTotal,
            special_instructions: '',
            call_sid: callSid,
            ready_time: readyTimeInfo.readyTimeString,
            estimated_ready_at: readyTimeInfo.readyTime,
            status: orderStatus
          };

          console.log('Creating order with delivery_address_id:', deliveryAddressId);

          // Update delivery instructions if needed
          if (isDelivery && deliveryAddressId && deliveryInstructions) {
            await database.updateDeliveryInstructions(deliveryAddressId, deliveryInstructions);
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
                    final_total: finalTotal,
                    order_type: orderType,
                    customer_name: collectedName
                  };
                } else {
                  console.error('❌ Credit card payment transfer failed:', transferResult.error);
                  // Let AI handle goodbye naturally - no forced hangup timer
                  result = {
                    success: true,
                    order_id: order.id,
                    transferred: false,
                    ready_time: readyTimeInfo.readyTimeString,
                    total_minutes: readyTimeInfo.totalMinutes,
                    subtotal: subtotal,
                    final_total: finalTotal,
                    order_type: orderType,
                    customer_name: collectedName
                  };
                }
              } else {
                console.log('💳 Credit card order created - AI will announce and end call naturally');
                // Let AI handle goodbye naturally - no forced hangup timer
                result = {
                  success: true,
                  order_id: order.id,
                  transferred: false,
                  ready_time: readyTimeInfo.readyTimeString,
                  total_minutes: readyTimeInfo.totalMinutes,
                  subtotal: subtotal,
                  final_total: finalTotal,
                  order_type: orderType,
                  customer_name: collectedName
                };
              }
            } else {
              // Cash order - AI will announce order details and thank customer naturally
              console.log('💵 Cash order created - AI will announce and end call naturally');
              // Let AI handle goodbye naturally - no forced hangup timer
              result = {
                success: true,
                order_id: order.id,
                transferred: false,
                ready_time: readyTimeInfo.readyTimeString,
                total_minutes: readyTimeInfo.totalMinutes,
                subtotal: subtotal,
                final_total: finalTotal,
                order_type: orderType,
                customer_name: collectedName
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

      // CRITICAL: Always trigger response.create after function results
      // Even with semantic VAD, we need to explicitly tell AI to respond
      // Only skip for functions that absolutely don't need a response
      const noResponseTriggerFunctions = []; // Empty - always trigger for now

      if (!noResponseTriggerFunctions.includes(functionName)) {
        // CRITICAL: Trigger AI to respond after function result
        // Without this, AI receives the result but doesn't know to respond to customer
        // Wait 100ms before triggering to avoid race condition
        setTimeout(() => {
          if (!isResponseInProgress && openaiWs && openaiWs.readyState === WebSocket.OPEN) {
            // Build response.create payload
            const responsePayload = {
              type: 'response.create'
            };

            // For finalize_order, add explicit instructions to use the function result
            if (functionName === 'finalize_order' && result.success) {
              const announcementInstructions = `CRITICAL: You just called finalize_order and received this result: ${JSON.stringify(result)}. You MUST now announce to the customer using this EXACT format:

"Your estimated total is $${result.final_total}. Order confirmed for [customer name] for ${result.order_type || 'delivery'}. Your order will ${result.order_type === 'pickup' ? 'be ready' : 'arrive'} in approximately ${result.total_minutes} minutes, around ${result.ready_time}. Thank you!"

Example: "Your estimated total is $${result.final_total}. Order confirmed for ${result.customer_name || 'the customer'} for ${result.order_type || 'delivery'}. Your order will ${result.order_type === 'pickup' ? 'be ready' : 'arrive'} in approximately ${result.total_minutes} minutes, around ${result.ready_time}. Thank you!"

DO NOT skip any part of this announcement. The customer MUST hear the estimated total, the timing in minutes, and the ready time.`;

              responsePayload.response = {
                instructions: announcementInstructions
              };

              console.log('🔥 INJECTING ANNOUNCEMENT INSTRUCTIONS INTO response.create:');
              console.log(announcementInstructions);
            }

            // For set_order_type, add explicit instructions to ask for name
            if (functionName === 'set_order_type') {
              const askNameInstructions = `CRITICAL: You just stored the order type "${result.order_type}".

You MUST NOW IMMEDIATELY ask the customer: "May I have your name for the order?"

DO NOT wait. DO NOT do anything else. Ask for their name RIGHT NOW.`;

              responsePayload.response = {
                instructions: askNameInstructions
              };

              console.log('🔥 INJECTING ASK NAME INSTRUCTIONS for set_order_type:');
              console.log(askNameInstructions);
            }

            // For set_customer_name (delivery orders), add explicit instructions to proceed
            if (functionName === 'set_customer_name' && result.next_action === 'check_customer_address') {
              const nextStepInstructions = `CRITICAL: You just stored the customer's name "${result.stored_name}". This is a DELIVERY order.

You MUST NOW IMMEDIATELY call the function: check_customer_address

DO NOT wait for the customer to say anything. DO NOT ask any questions. Call check_customer_address RIGHT NOW.`;

              responsePayload.response = {
                instructions: nextStepInstructions
              };

              console.log('🔥 INJECTING NEXT STEP INSTRUCTIONS for set_customer_name (delivery):');
              console.log(nextStepInstructions);
            }

            // For set_payment_method, add explicit instructions to call finalize_order
            if (functionName === 'set_payment_method' && result.next_action === 'finalize_order') {
              const finalizeInstructions = `CRITICAL: You just stored the payment method "${result.payment_method}".

You MUST NOW IMMEDIATELY call the function: finalize_order

DO NOT say anything. DO NOT acknowledge the payment method. Just call finalize_order RIGHT NOW with NO parameters.`;

              responsePayload.response = {
                instructions: finalizeInstructions
              };

              console.log('🔥 INJECTING FINALIZE INSTRUCTIONS for set_payment_method:');
              console.log(finalizeInstructions);
            }

            openaiWs.send(JSON.stringify(responsePayload));
            isResponseInProgress = true;
            console.log(`✅ Triggered response.create after function: ${functionName}`);
          } else if (isResponseInProgress) {
            console.log(`⚠️  Skipping response.create after ${functionName} - response already in progress`);
          }
        }, 100);
      } else {
        console.log(`ℹ️  No response trigger needed for ${functionName}`);
      }
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // DEPRECATED FUNCTIONS REMOVED (v2.9.0 - Option A Implementation)
  // ════════════════════════════════════════════════════════════════════════════
  // The following regex-based order extraction functions have been removed:
  //   - extractItemCustomizations()
  //   - extractOrderFromConversation()
  //   - validateOrder()
  //   - processOrderFromTranscript()
  //   - parseOrderConfirmation()
  //
  // Replaced with AI-powered structured data collection via function calls:
  //   1. set_customer_name(name) - Stores customer name
  //   2. add_order_item(item_name, size?, quantity, customizations?) - Adds each item
  //   3. set_payment_method(method) - Records payment choice (delivery only)
  //   4. finalize_order() - Creates order from collected data
  //
  // Benefits of new approach:
  //   ✅ Leverages AI's natural language understanding
  //   ✅ No brittle regex patterns to maintain
  //   ✅ Real-time validation as data is collected
  //   ✅ Cleaner codebase (~650 lines removed)
  // ════════════════════════════════════════════════════════════════════════════

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
