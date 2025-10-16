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
const audioAnalyzer = require('./services/audioAnalyzer');
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
  let callFinalized = false;
  let hangupTimer = null;
  let referenceSignal = null; // For echo cancellation
  let analyzer = audioAnalyzer.createAnalyzer(); // Dynamic VAD adjustment
  let vadAdjusted = false; // Track if we've already adjusted VAD

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

  // Update VAD settings based on audio analysis
  function updateVADSettings(analysisResults) {
    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) {
      console.log('Cannot update VAD: OpenAI WebSocket not open');
      return;
    }

    const { recommendedThreshold, recommendedSilenceDuration, environmentType } = analysisResults;

    console.log(`🎚️  Adjusting VAD for ${environmentType} environment:`, {
      threshold: `${config.voice.vadThreshold} → ${recommendedThreshold}`,
      silenceDuration: `${config.voice.silenceDurationMs}ms → ${recommendedSilenceDuration}ms`
    });

    // Send session.update to adjust VAD settings mid-call
    const vadUpdate = {
      type: 'session.update',
      session: {
        turn_detection: {
          type: 'server_vad',
          threshold: recommendedThreshold,
          prefix_padding_ms: 200,
          silence_duration_ms: recommendedSilenceDuration
        }
      }
    };

    openaiWs.send(JSON.stringify(vadUpdate));
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

        case 'response.audio_transcript.done':
          console.log('AI said:', response.transcript);
          conversationTranscript.push({
            timestamp: new Date().toISOString(),
            speaker: 'AI',
            text: response.transcript
          });

          // Check for order confirmation
          if (response.transcript.includes('ORDER_CONFIRMED:') && !orderProcessed) {
            await processOrderFromTranscript(response.transcript);
          }

          // Detect goodbye/call-ending phrases and trigger graceful hangup
          // ONLY after customer has spoken (to avoid triggering on greeting)
          const transcript = response.transcript.toLowerCase();
          const goodbyePhrases = [
            'goodbye',
            'have a great day',
            'have a good day',
            'have a nice day',
            'thank you for calling',
            'thanks for calling',
            'feel free to call back',
            'call back anytime'
          ];

          const isGoodbye = goodbyePhrases.some(phrase => transcript.includes(phrase));

          // Only trigger hangup if:
          // 1. It's a goodbye phrase, AND
          // 2. Customer has spoken (not just the greeting), AND
          // 3. No order was processed, AND
          // 4. No hangup timer already set
          if (isGoodbye && customerHasSpoken && !orderProcessed && !hangupTimer) {
            console.log('Goodbye phrase detected after customer interaction - scheduling hangup');
            // Give AI 2 seconds to finish speaking before hangup
            hangupTimer = setTimeout(async () => {
              await initiateHangup('conversation_ended');
            }, 2000);
          } else if (isGoodbye && !customerHasSpoken) {
            console.log('Goodbye phrase detected in greeting - ignoring (customer hasn\'t spoken yet)');
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

      const orderData = {
        restaurant_id: restaurant.id,
        customer_name: orderInfo.customerName,
        customer_phone: customerPhone,
        order_type: orderInfo.orderType,
        delivery_address: orderInfo.deliveryAddress,
        order_details: orderInfo.items,
        total_amount: finalTotal,
        special_instructions: orderInfo.specialInstructions || '',
        call_sid: callSid,
        ready_time: readyTimeInfo.readyTimeString,
        estimated_ready_at: readyTimeInfo.readyTime,
        status: 'pending'
      };

      const order = await database.createOrder(orderData);

      if (order) {
        console.log('Order created successfully:', order.id);

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

        console.log('\n' + ticket + '\n');

        // Update call data with order reference
        stateManager.updateCallData(callSid, { order_id: order.id });

        // Schedule hangup after 3 seconds to allow AI to finish speaking goodbye message
        hangupTimer = setTimeout(async () => {
          await initiateHangup('order_completed');
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
            let audioPayload = msg.media.payload;
            const inputBuffer = Buffer.from(audioPayload, 'base64');

            // Analyze audio for dynamic VAD adjustment (only during initial period)
            if (!vadAdjusted) {
              analyzer.analyzeChunk(inputBuffer);

              // Check if analysis is complete and adjust VAD if needed
              const analysisResults = analyzer.getResults();
              if (analysisResults && !vadAdjusted) {
                vadAdjusted = true;
                updateVADSettings(analysisResults);
              }
            }

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
