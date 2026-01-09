// HTTP Routes for the application
const express = require('express');
const config = require('../config');
const { createClient } = require('@supabase/supabase-js');
const twilioService = require('../services/twilio');
const stateManager = require('../services/stateManager');
const { getRestaurantByPhone } = require('../services/database');

const router = express.Router();

// Initialize Supabase client for direct queries
const supabase = createClient(config.supabase.url, config.supabase.anonKey);

/**
 * Hangup TwiML endpoint with Ring Two Tech branding
 */
router.post('/hangup-twiml', (req, res) => {
  const callSid = req.query.call_sid || req.body.CallSid;
  const twiml = twilioService.generateHangupTwiML(callSid);

  res.type('text/xml');
  res.send(twiml);

  console.log('TwiML hangup message sent with Google Chirp3 HD voice');
});

/**
 * Transfer TwiML endpoint for call forwarding
 */
router.post('/transfer-twiml', (req, res) => {
  const transferNumber = req.query.transfer_number;
  const reason = req.query.reason || 'transfer';
  const callSid = req.query.call_sid || req.body.CallSid;

  console.log(`📞 Generating transfer TwiML for call ${callSid} to ${transferNumber} (${reason})`);

  const twiml = twilioService.generateTransferTwiML(transferNumber);

  res.type('text/xml');
  res.send(twiml);
});

/**
 * Incoming call webhook - responds with WebSocket stream TwiML
 */
router.post('/voice', (req, res) => {
  console.log('Incoming call webhook:', req.body);

  // CRITICAL: Respond to Twilio immediately (within 15 second timeout)
  const twiml = twilioService.generateIncomingCallTwiML(req.get('host'), req.body);

  res.type('text/xml');
  res.send(twiml);

  // Do restaurant lookup and call data storage AFTER responding to Twilio
  setImmediate(async () => {
    try {
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
        call_ended_at: null,
        call_duration: null,
        conversation_transcript: null,
        order_id: null
      };

      // Look up restaurant to get restaurant_id for the call log (non-blocking)
      const restaurant = await getRestaurantByPhone(callData.to_number);
      if (restaurant) {
        callData.restaurant_id = restaurant.id;
        callData.restaurant = restaurant; // Store full restaurant object for WebSocket handler
      }

      // Store call data for final logging at call completion
      stateManager.storeCallData(req.body.CallSid, callData);

    } catch (error) {
      console.error('Error processing call data after TwiML response:', error);
    }
  });
});

/**
 * Twilio status callback webhook - receives call completion status
 * This handles the Twilio-side call logging (updates existing call log created by WebSocket)
 */
router.post('/call-status', async (req, res) => {
  console.log('📞 Twilio status callback received:', req.body);

  // Respond immediately to Twilio
  res.status(200).send('OK');

  // Process status callback asynchronously
  setImmediate(async () => {
    try {
      const { CallSid, CallStatus, CallDuration, From, To } = req.body;

      // Only process completed calls
      if (CallStatus !== 'completed') {
        console.log(`Call ${CallSid} status: ${CallStatus} (not completed, skipping log update)`);
        return;
      }

      console.log(`📊 Updating call log for completed call: ${CallSid}, duration: ${CallDuration}s`);

      // Prepare update data from Twilio webhook
      const callData = {
        call_sid: CallSid,
        from_number: From,
        to_number: To,
        call_status: CallStatus,
        call_duration: parseInt(CallDuration, 10),
        call_ended_at: new Date().toISOString(),
        twilio_data: req.body,
        source: 'twilio_webhook'
      };

      // UPSERT: This will update existing record if WebSocket already created it,
      // or create new record if WebSocket failed to log
      const { upsertCallLog } = require('../services/database');
      const result = await upsertCallLog(callData);

      if (result) {
        console.log(`✅ Call log updated from Twilio webhook: ${CallSid}`);
      } else {
        console.error(`❌ Failed to update call log from Twilio webhook: ${CallSid}`);
      }

    } catch (error) {
      console.error('Error processing Twilio status callback:', error);
    }
  });
});

/**
 * Recording status callback webhook
 * Downloads recording from Twilio, uploads to Supabase Storage, updates call_logs
 */
router.post('/recording-status', async (req, res) => {
  console.log('📹 Recording status callback:', req.body);

  const { RecordingSid, RecordingStatus, RecordingUrl, CallSid, RecordingDuration } = req.body;

  // Respond immediately to Twilio
  res.status(200).send('OK');

  // Process recording asynchronously
  setImmediate(async () => {
    if (RecordingStatus === 'completed') {
      console.log(`✅ Recording completed: ${RecordingSid} (${RecordingDuration}s) - ${RecordingUrl}`);

      try {
        // Download recording from Twilio (requires authentication)
        const twilioRecordingUrl = `${RecordingUrl}.mp3`;
        console.log(`📥 Downloading recording from: ${twilioRecordingUrl}`);

        const authHeader = 'Basic ' + Buffer.from(
          `${config.twilio.accountSid}:${config.twilio.authToken}`
        ).toString('base64');

        const recordingResponse = await fetch(twilioRecordingUrl, {
          headers: { 'Authorization': authHeader }
        });

        if (!recordingResponse.ok) {
          console.error(`❌ Failed to download recording: ${recordingResponse.status}`);
          return;
        }

        const recordingBuffer = Buffer.from(await recordingResponse.arrayBuffer());
        console.log(`📦 Downloaded recording: ${recordingBuffer.length} bytes`);

        // Upload to Supabase Storage
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `${CallSid}_${timestamp}.mp3`;
        const storageBucket = 'call-recordings';
        const storageUrl = `${config.supabase.url}/storage/v1/object/${storageBucket}/${filename}`;

        console.log(`📤 Uploading to Supabase Storage: ${filename}`);

        const uploadResponse = await fetch(storageUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${config.supabase.anonKey}`,
            'Content-Type': 'audio/mpeg',
            'x-upsert': 'true'
          },
          body: recordingBuffer
        });

        if (!uploadResponse.ok) {
          const errorText = await uploadResponse.text();
          console.error(`❌ Supabase Storage upload failed (${uploadResponse.status}):`, errorText);
          return;
        }

        // Construct public URL
        const publicRecordingUrl = `${config.supabase.url}/storage/v1/object/public/${storageBucket}/${filename}`;
        console.log(`✅ Recording uploaded to Supabase: ${publicRecordingUrl}`);

        // Update call_logs with recording URL
        const { upsertCallLog } = require('../services/database');
        const updateResult = await upsertCallLog({
          call_sid: CallSid,
          recording_url: publicRecordingUrl,
          source: 'recording_webhook'
        });

        if (updateResult) {
          console.log(`✅ Call log updated with recording URL for ${CallSid}`);
        } else {
          console.error(`❌ Failed to update call log with recording URL for ${CallSid}`);
        }

      } catch (error) {
        console.error(`❌ Error processing recording for ${CallSid}:`, error.message);
      }

    } else if (RecordingStatus === 'failed') {
      console.error(`❌ Recording failed: ${RecordingSid} for call ${CallSid}`);
    }
  });
});

/**
 * Health check endpoint with detailed status
 */
router.get('/health', (_req, res) => {
  const healthData = {
    status: 'healthy',
    port: config.server.port,
    timestamp: new Date().toISOString(),
    openai_configured: !!config.openai.apiKey,
    supabase_configured: !!(config.supabase.url && config.supabase.anonKey),
    twilio_configured: twilioService.isTwilioConfigured(),
    uptime: process.uptime(),
    migration_status: 'caller_id_fix_applied',
    architecture: 'twilio_websocket_with_automatic_caller_id',
    caller_id_usage: 'automatic_no_manual_entry_required',
    ring_two_tech_branding: true,
    google_chirp3_hd_voice: true,
    vad_threshold: config.voice.vadThreshold,
    silence_duration_ms: config.voice.silenceDurationMs,
    last_health_check: new Date().toISOString(),
    pending_calls: stateManager.getStats()
  };

  res.status(200).json(healthData);
});

/**
 * Simple ping endpoint
 */
router.get('/ping', (_req, res) => {
  res.status(200).send('pong');
});

/**
 * Root endpoint with system info
 */
router.get('/', (req, res) => {
  res.status(200).json({
    message: 'Restaurant AI Ordering System - Refactored',
    status: 'running',
    port: config.server.port,
    websocket_url: `wss://${req.get('host')}/media-stream`,
    server_time: new Date().toISOString(),
    caller_id_fix: 'APPLIED - AI will never ask for phone numbers',
    automatic_order_lookup: true,
    ring_two_tech_branding: true,
    google_chirp3_hd_voice: true,
    version: '2.0-refactored'
  });
});

/**
 * Get orders list (calls Edge Function)
 */
router.get('/orders', async (_req, res) => {
  try {
    const response = await fetch(`${config.supabase.url}/functions/v1/search-orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.supabase.anonKey}`
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

/**
 * Get customer messages list
 */
router.get('/messages', async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('customer_messages')
      .select('*, restaurants(name, delivery_enabled, delivery_hours)')
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

module.exports = router;
