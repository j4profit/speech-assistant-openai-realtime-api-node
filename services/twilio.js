// Twilio operations service - handles call management and TwiML generation
const twilio = require('twilio');
const config = require('../config');

// Initialize Twilio client
const twilioClient = config.twilio.enabled
  ? twilio(config.twilio.accountSid, config.twilio.authToken)
  : null;

if (!twilioClient) {
  console.warn('Twilio credentials not provided - hangup functionality will be limited');
}

// Store for pending hangup TwiML (temporary in-memory storage)
const pendingHangupTwiML = new Map();

/**
 * Escape XML special characters
 * @param {string} text - Text to escape
 * @returns {string} XML-safe text
 */
function escapeXML(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Generate TwiML for hangup with Ring Two Tech branding
 * @param {string} callSid - Call SID
 * @param {string} restaurantName - Restaurant name (optional)
 * @returns {string} TwiML XML
 */
function generateHangupTwiML(callSid, restaurantName = '') {
  // Retrieve and remove pending hangup data
  const hangupData = pendingHangupTwiML.get(callSid);
  if (hangupData) {
    pendingHangupTwiML.delete(callSid);
    restaurantName = hangupData.restaurant?.name || restaurantName;
  }

  const message = restaurantName
    ? `Your call was processed by Ring two tech. Thank you for calling ${restaurantName}.`
    : 'Your call was processed by Ring two tech. Thank you for calling.';

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="${config.voice.model}">${escapeXML(message)}</Say>
    <Hangup/>
</Response>`;
}

/**
 * Generate TwiML for incoming call (WebSocket stream setup)
 * Note: Recording is handled via REST API in startRecording() since <Connect record="...">
 * only works for Twilio Video rooms, not <Stream>
 * @param {string} host - Request host
 * @param {Object} callParams - Call parameters (Called, From, CallSid)
 * @returns {string} TwiML XML
 */
function generateIncomingCallTwiML(host, callParams) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Connect>
        <Stream url="wss://${host}/media-stream">
            <Parameter name="Called" value="${callParams.Called || callParams.To}" />
            <Parameter name="From" value="${callParams.From || callParams.Caller}" />
            <Parameter name="CallSid" value="${callParams.CallSid}" />
        </Stream>
    </Connect>
</Response>`;
}

/**
 * Hang up a call (immediate or graceful)
 * @param {string} callSid - Twilio call SID
 * @param {Object} options - Hangup options
 * @param {string} options.message - Custom goodbye message
 * @param {string} options.method - 'immediate' or 'graceful' (default: 'graceful')
 * @param {string} options.reason - Reason for hangup
 * @param {Object} options.restaurant - Restaurant object
 * @param {number} options.delay - Delay in ms before hangup
 * @returns {Promise<Object>} Hangup result
 */
async function hangup(callSid, options = {}) {
  if (!callSid || !twilioClient) {
    console.error('hangup() called without callSid or Twilio not configured');
    return { success: false, error: 'Missing callSid or Twilio not configured' };
  }

  const {
    message = null,
    method = 'graceful',
    reason = 'system_initiated',
    restaurant = null,
    delay = 0
  } = options;

  console.log(`Hangup initiated: ${callSid} - Method: ${method}, Reason: ${reason}`);

  try {
    if (delay > 0) {
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    if (method === 'immediate') {
      await twilioClient.calls(callSid).update({ status: 'completed' });
      console.log(`Call terminated immediately: ${callSid}`);
      return { success: true, method: 'immediate', reason, call_sid: callSid };
    }

    if (method === 'graceful') {
      let finalMessage = message;
      if (!finalMessage) {
        finalMessage = restaurant
          ? `Thank you for calling ${restaurant.name}. Have a great day!`
          : 'Thank you for calling. Have a great day!';
      }

      // Store the TwiML data for the hangup endpoint
      pendingHangupTwiML.set(callSid, {
        message: finalMessage,
        restaurant: restaurant,
        timestamp: new Date().toISOString()
      });

      const hangupUrl = `${config.server.baseUrl}/hangup-twiml?call_sid=${callSid}`;

      await twilioClient.calls(callSid).update({
        url: hangupUrl,
        method: 'POST'
      });

      console.log(`Call redirected to graceful hangup: ${callSid}`);
      return {
        success: true,
        method: 'graceful',
        reason,
        message: finalMessage,
        call_sid: callSid
      };
    }

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

/**
 * Transfer a call to another number
 * @param {string} callSid - Twilio call SID
 * @param {string} transferNumber - Phone number to transfer to (E.164 format)
 * @param {string} reason - Reason for transfer (for logging)
 * @returns {Promise<Object>} Transfer result
 */
async function transferCall(callSid, transferNumber, reason = 'transfer') {
  if (!callSid || !twilioClient) {
    console.error('transferCall() called without callSid or Twilio not configured');
    return { success: false, error: 'Missing callSid or Twilio not configured' };
  }

  if (!transferNumber) {
    console.error('transferCall() called without transferNumber');
    return { success: false, error: 'Missing transfer number' };
  }

  console.log(`📞 Transferring call ${callSid} to ${transferNumber} (reason: ${reason})`);

  try {
    // Use Twilio's Dial verb to transfer the call
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="${config.voice.model}">Please hold while we transfer your call.</Say>
    <Dial>${transferNumber}</Dial>
    <Say voice="${config.voice.model}">The transfer could not be completed. Please try again later.</Say>
    <Hangup/>
</Response>`;

    const transferUrl = `${config.server.baseUrl}/transfer-twiml?call_sid=${callSid}&transfer_number=${encodeURIComponent(transferNumber)}&reason=${encodeURIComponent(reason)}`;

    await twilioClient.calls(callSid).update({
      url: transferUrl,
      method: 'POST'
    });

    console.log(`✅ Call ${callSid} transfer initiated to ${transferNumber}`);
    return {
      success: true,
      transfer_number: transferNumber,
      reason,
      call_sid: callSid
    };

  } catch (error) {
    console.error(`❌ Transfer failed for call ${callSid}:`, error);
    return {
      success: false,
      error: error.message,
      call_sid: callSid
    };
  }
}

/**
 * Generate TwiML for call transfer
 * @param {string} transferNumber - Phone number to transfer to
 * @returns {string} TwiML XML
 */
function generateTransferTwiML(transferNumber) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="${config.voice.model}">Please hold while we transfer your call.</Say>
    <Dial>${escapeXML(transferNumber)}</Dial>
    <Say voice="${config.voice.model}">The transfer could not be completed. Please try again later.</Say>
    <Hangup/>
</Response>`;
}

/**
 * Check if Twilio is properly configured
 * @returns {boolean} True if Twilio client is available
 */
function isTwilioConfigured() {
  return !!twilioClient;
}

/**
 * Start recording a call via Twilio REST API
 * Use this for calls using <Stream> since the record attribute on <Connect> only works for Video rooms
 * @param {string} callSid - Twilio call SID
 * @returns {Promise<Object>} Recording result with recording SID or error
 */
async function startRecording(callSid) {
  if (!callSid || !twilioClient) {
    console.log('startRecording() skipped - missing callSid or Twilio not configured');
    return { success: false, error: 'Missing callSid or Twilio not configured' };
  }

  // Check if recording is enabled
  const recordingMode = config.twilio.recording;
  if (recordingMode === 'do-not-record') {
    console.log('Recording disabled by config');
    return { success: false, error: 'Recording disabled' };
  }

  try {
    // Determine recording channels based on config
    // 'record-from-answer-dual' -> dual channel, 'record-from-answer' -> single channel
    const recordingChannels = recordingMode === 'record-from-answer-dual' ? 'dual' : 'mono';

    console.log(`📹 Starting ${recordingChannels} channel recording for call ${callSid}`);

    const recording = await twilioClient.calls(callSid)
      .recordings
      .create({
        recordingChannels: recordingChannels,
        recordingStatusCallback: `${config.server.baseUrl}/recording-status`,
        recordingStatusCallbackEvent: ['completed', 'failed']
      });

    console.log(`✅ Recording started: ${recording.sid} (${recordingChannels} channel)`);
    return {
      success: true,
      recording_sid: recording.sid,
      channels: recordingChannels,
      call_sid: callSid
    };

  } catch (error) {
    console.error(`❌ Failed to start recording for call ${callSid}:`, error.message);
    return {
      success: false,
      error: error.message,
      call_sid: callSid
    };
  }
}

module.exports = {
  twilioClient,
  escapeXML,
  generateHangupTwiML,
  generateIncomingCallTwiML,
  generateTransferTwiML,
  hangup,
  transferCall,
  isTwilioConfigured,
  startRecording,
  pendingHangupTwiML // Export for route access
};
