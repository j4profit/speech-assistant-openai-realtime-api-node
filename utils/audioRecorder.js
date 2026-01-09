// Audio recording utility for capturing call audio from WebSocket streams
const fs = require('fs');
const path = require('path');
const config = require('../config');

// Ensure recordings directory exists (for temporary local storage)
const RECORDINGS_DIR = path.join(__dirname, '..', 'recordings');
if (!fs.existsSync(RECORDINGS_DIR)) {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
}

// Supabase storage bucket name
const STORAGE_BUCKET = 'call-recordings';

/**
 * Upload file to Supabase Storage using REST API directly
 * @param {string} filename - Name of file to upload
 * @param {Buffer} buffer - File data
 * @param {string} contentType - MIME type
 * @returns {Promise<{url: string|null, error: string|null}>}
 */
async function uploadToSupabaseStorage(filename, buffer, contentType) {
  const storageUrl = `${config.supabase.url}/storage/v1/object/${STORAGE_BUCKET}/${filename}`;

  console.log(`📤 Uploading to: ${storageUrl}`);

  try {
    const response = await fetch(storageUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.supabase.anonKey}`,
        'Content-Type': contentType,
        'x-upsert': 'true'
      },
      body: buffer
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ Storage upload failed (${response.status}):`, errorText);
      return { url: null, error: `${response.status}: ${errorText}` };
    }

    // Construct public URL
    const publicUrl = `${config.supabase.url}/storage/v1/object/public/${STORAGE_BUCKET}/${filename}`;
    return { url: publicUrl, error: null };

  } catch (error) {
    console.error(`❌ Storage upload error:`, error.message);
    return { url: null, error: error.message };
  }
}

/**
 * Create a WAV header for µ-law audio
 * @param {number} dataLength - Length of audio data in bytes
 * @returns {Buffer} WAV header
 */
function createMuLawWavHeader(dataLength) {
  const header = Buffer.alloc(58); // Extended header for µ-law

  // RIFF header
  header.write('RIFF', 0);
  header.writeUInt32LE(dataLength + 50, 4); // File size - 8
  header.write('WAVE', 8);

  // fmt chunk
  header.write('fmt ', 12);
  header.writeUInt32LE(18, 16); // Chunk size (18 for non-PCM)
  header.writeUInt16LE(7, 20); // Audio format: 7 = µ-law
  header.writeUInt16LE(1, 22); // Channels: 1 (mono)
  header.writeUInt32LE(8000, 24); // Sample rate: 8000 Hz
  header.writeUInt32LE(8000, 28); // Byte rate: 8000 bytes/sec
  header.writeUInt16LE(1, 32); // Block align: 1
  header.writeUInt16LE(8, 34); // Bits per sample: 8
  header.writeUInt16LE(0, 36); // Extra format bytes

  // fact chunk (required for non-PCM)
  header.write('fact', 38);
  header.writeUInt32LE(4, 42); // Chunk size
  header.writeUInt32LE(dataLength, 46); // Number of samples

  // data chunk
  header.write('data', 50);
  header.writeUInt32LE(dataLength, 54);

  return header;
}

/**
 * Audio recorder class for capturing call audio
 */
class AudioRecorder {
  constructor(callSid) {
    this.callSid = callSid;
    this.callerAudio = []; // Audio from the customer
    this.aiAudio = []; // Audio from the AI
    this.startTime = Date.now();
    this.enabled = true;
  }

  /**
   * Add caller (customer) audio chunk
   * @param {string} base64Audio - Base64-encoded µ-law audio
   */
  addCallerAudio(base64Audio) {
    if (this.enabled && base64Audio) {
      this.callerAudio.push(Buffer.from(base64Audio, 'base64'));
    }
  }

  /**
   * Add AI audio chunk
   * @param {string} base64Audio - Base64-encoded µ-law audio
   */
  addAIAudio(base64Audio) {
    if (this.enabled && base64Audio) {
      this.aiAudio.push(Buffer.from(base64Audio, 'base64'));
    }
  }

  /**
   * Save recordings to Supabase Storage and update call_logs
   * @returns {Object} Upload results with URLs
   */
  async save() {
    if (!this.enabled) {
      return { success: false, reason: 'Recording disabled' };
    }

    console.log(`📹 Saving recording to Supabase Storage:`, {
      bucket: STORAGE_BUCKET,
      supabaseUrl: config.supabase.url,
      callSid: this.callSid
    });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const baseFilename = `${this.callSid}_${timestamp}`;

    const results = {
      callSid: this.callSid,
      duration: Math.round((Date.now() - this.startTime) / 1000),
      files: {},
      urls: {}
    };

    try {
      // Combine caller and AI audio into a single file for easier playback
      const callerData = this.callerAudio.length > 0 ? Buffer.concat(this.callerAudio) : Buffer.alloc(0);
      const aiData = this.aiAudio.length > 0 ? Buffer.concat(this.aiAudio) : Buffer.alloc(0);

      // Upload caller audio
      if (callerData.length > 0) {
        const callerFilename = `${baseFilename}_caller.wav`;
        const callerHeader = createMuLawWavHeader(callerData.length);
        const callerBuffer = Buffer.concat([callerHeader, callerData]);

        const { url: callerUrl, error: callerError } = await uploadToSupabaseStorage(
          callerFilename,
          callerBuffer,
          'audio/wav'
        );

        if (callerError) {
          console.error(`❌ Caller audio upload failed:`, callerError);
        } else {
          results.urls.caller = callerUrl;
          console.log(`✅ Uploaded caller audio: ${callerUrl}`);
        }
      }

      // Upload AI audio
      if (aiData.length > 0) {
        const aiFilename = `${baseFilename}_ai.wav`;
        const aiHeader = createMuLawWavHeader(aiData.length);
        const aiBuffer = Buffer.concat([aiHeader, aiData]);

        const { url: aiUrl, error: aiError } = await uploadToSupabaseStorage(
          aiFilename,
          aiBuffer,
          'audio/wav'
        );

        if (aiError) {
          console.error(`❌ AI audio upload failed:`, aiError);
        } else {
          results.urls.ai = aiUrl;
          console.log(`✅ Uploaded AI audio: ${aiUrl}`);
        }
      }

      // Update call_logs with recording URLs using direct fetch
      if (results.urls.caller || results.urls.ai) {
        try {
          const updateResponse = await fetch(
            `${config.supabase.url}/rest/v1/call_logs?call_sid=eq.${this.callSid}`,
            {
              method: 'PATCH',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.supabase.anonKey}`,
                'apikey': config.supabase.anonKey,
                'Prefer': 'return=minimal'
              },
              body: JSON.stringify({
                caller_recording_url: results.urls.caller || null,
                ai_recording_url: results.urls.ai || null,
                recording_duration: results.duration
              })
            }
          );

          if (!updateResponse.ok) {
            const errorText = await updateResponse.text();
            console.error(`❌ Failed to update call_logs:`, errorText);
          } else {
            console.log(`✅ Updated call_logs with recording URLs for ${this.callSid}`);
          }
        } catch (updateErr) {
          console.error(`❌ call_logs update error:`, updateErr.message);
        }
      }

      results.success = true;
      console.log(`✅ Recording uploaded for call ${this.callSid} (${results.duration}s)`);

    } catch (error) {
      console.error(`❌ Failed to save recording for ${this.callSid}:`, error.message);
      results.success = false;
      results.error = error.message;
    }

    // Clear buffers
    this.callerAudio = [];
    this.aiAudio = [];

    return results;
  }

  /**
   * Disable recording (e.g., if config says do-not-record)
   */
  disable() {
    this.enabled = false;
    this.callerAudio = [];
    this.aiAudio = [];
  }
}

module.exports = {
  AudioRecorder,
  RECORDINGS_DIR
};
