// Twilio Function: call-status-changes
// Deploy this to Twilio Functions
// Environment variables needed: SUPABASE_URL, SUPABASE_ANON_KEY

const axios = require('axios');

exports.handler = async function(context, event, callback) {
  // Map Twilio webhook fields to Supabase format
  const callData = {
    call_sid: event.CallSid,
    from_number: event.From,
    to_number: event.To,
    call_status: event.CallStatus,
    call_direction: event.Direction,
    caller_country: event.FromCountry,
    caller_state: event.FromState,
    caller_city: event.FromCity,
    caller_zip: event.FromZip,
    to_country: event.ToCountry,
    to_state: event.ToState,
    to_city: event.ToCity,
    to_zip: event.ToZip,
    call_duration: parseInt(event.CallDuration) || null,
    call_started_at: event.Timestamp || null,
    call_ended_at: event.Timestamp || null,
    recording_url: event.RecordingUrl || null,
    recording_duration: parseInt(event.RecordingDuration) || null,
    twilio_data: event
  };

  try {
    await axios.post(
      `${context.SUPABASE_URL}/functions/v1/create-call-log`,
      callData,
      {
        headers: {
          'Authorization': `Bearer ${context.SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    return callback(null, 'OK');
  } catch (error) {
    console.error('Error calling Supabase:', error.response?.data || error.message);
    return callback(null, 'ERROR');
  }
};
