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
  let callStartTime = new Date();
  let conversationTranscript = [];
  let orderProcessed = false;
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
      await twilioService.hangup(callId, {
        message: 'Sorry, we are unable to process your call at this time. Please try again later.',
        reason: 'restaurant_not_found'
      });
      return;
    }

    console.log('Restaurant loaded:', {
      id: restaurant.id,
      name: restaurant.name,
      phone: restaurant.phone_number,
      delivery_enabled: restaurant.delivery_enabled
    });

    customerPhone = fromNumber;
    callSid = callId;

    console.log('Customer phone set to:', customerPhone);

    const menuText = formatMenuForAI(restaurant.menu_items, restaurant);

    console.log('Connecting to OpenAI Realtime API...');

    try {
      openaiWs = new WebSocket(`${config.openai.websocketUrl}?model=${config.openai.model}`, {
        headers: {
          'Authorization': `Bearer ${config.openai.apiKey}`,
          'OpenAI-Beta': 'realtime=v1'
        },
        perMessageDeflate: false,
        handshakeTimeout: 5000,
        maxPayload: 100 * 1024 * 1024
      });

      console.log('WebSocket created successfully');

    } catch (createError) {
      console.error('Failed to create OpenAI WebSocket:', createError);
      await twilioService.hangup(callId, {
        message: 'Technical difficulties. Please try again.',
        reason: 'websocket_creation_failed'
      });
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
          voice: 'coral',
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          turn_detection: {
            type: 'server_vad',
            threshold: config.voice.vadThreshold,
            prefix_padding_ms: 200,
            silence_duration_ms: config.voice.silenceDurationMs
          },
          temperature: 0.6,
          max_response_output_tokens: 400,
          tools: getAITools()
        }
      };

      openaiWs.send(JSON.stringify(sessionUpdate));
    });

    openaiWs.on('message', handleOpenAIMessage);
    openaiWs.on('error', (error) => {
      console.error('OpenAI WebSocket error:', error);
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
        description: "Validate delivery address for feasibility",
        parameters: {
          type: "object",
          properties: {
            address: {
              type: "string",
              description: "Complete delivery address provided by customer"
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
      }
    ];
  }

  // Handle OpenAI messages
  async function handleOpenAIMessage(data) {
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

          if (response.transcript.includes('ORDER_CONFIRMED:') && !orderProcessed) {
            await processOrderFromTranscript(response.transcript);
          }
          break;

        case 'conversation.item.input_audio_transcription.completed':
          console.log('Customer said:', response.transcript);
          conversationTranscript.push({
            timestamp: new Date().toISOString(),
            speaker: 'Customer',
            text: response.transcript
          });

          if (greetingTimeout) {
            clearTimeout(greetingTimeout);
            greetingTimeout = null;
            customerHasSpoken = true;
          }
          break;

        case 'conversation.item.created':
          if (response.item?.type === 'function_call') {
            await handleFunctionCall(response.item);
          }
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
        } else {
          result = { success: false, reason: 'Message intent not suitable for storage' };
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
    }
  }

  // Process order from transcript
  async function processOrderFromTranscript(transcript) {
    orderProcessed = true;
    console.log('Processing order from transcript...');

    try {
      const orderInfo = parseOrderConfirmation(transcript);

      if (!orderInfo) {
        console.error('Failed to parse order confirmation');
        return;
      }

      const readyTimeInfo = calculateOrderReadyTime(restaurant, orderInfo.orderType === 'delivery');

      const orderData = {
        restaurant_id: restaurant.id,
        customer_name: orderInfo.customerName,
        customer_phone: customerPhone,
        order_type: orderInfo.orderType,
        delivery_address: orderInfo.deliveryAddress,
        items: orderInfo.items,
        total_amount: orderInfo.totalAmount,
        special_instructions: orderInfo.specialInstructions || '',
        estimated_ready_time: readyTimeInfo.readyTime,
        status: 'pending'
      };

      const order = await database.createOrder(orderData);

      if (order) {
        console.log('Order created successfully:', order.id);

        const ticket = createOrderTicket({
          ...orderInfo,
          readyTime: readyTimeInfo.readyTimeString,
          restaurantName: restaurant.name
        });

        console.log('\n' + ticket + '\n');

        // Update call data with order reference
        stateManager.updateCallData(callSid, { order_id: order.id });

        setTimeout(async () => {
          await twilioService.hangup(callSid, {
            method: 'graceful',
            reason: 'order_completed',
            restaurant: restaurant
          });
        }, 3000);
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
      callData.call_duration = callDuration;
      callData.conversation_transcript = JSON.stringify(conversationTranscript);

      await database.createCallLog(callData);
      stateManager.removeCallData(callSid);
    }

    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
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
