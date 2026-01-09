// Audio recording utility for capturing call audio from WebSocket streams
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const config = require('../config');

// Initialize Supabase client for storage uploads
const supabase = createClient(config.supabase.url, config.supabase.anonKey);

// Ensure recordings directory exists (for temporary local storage)
const RECORDINGS_DIR = path.join(__dirname, '..', 'recordings');
if (!fs.existsSync(RECORDINGS_DIR)) {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
}

// Supabase storage bucket name
const STORAGE_BUCKET = 'call-recordings';

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

    // Debug: List available buckets to verify access
    try {
      const { data: buckets, error: listError } = await supabase.storage.listBuckets();
      if (listError) {
        console.error('❌ Cannot list buckets:', listError.message, listError);
      } else {
        console.log('📦 Available buckets:', buckets.map(b => b.name));
      }
    } catch (e) {
      console.error('❌ Bucket list error:', e.message);
    }

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

      // Save combined recording (caller audio)
      if (callerData.length > 0) {
        const callerFilename = `${baseFilename}_caller.wav`;
        const callerHeader = createMuLawWavHeader(callerData.length);
        const callerBuffer = Buffer.concat([callerHeader, callerData]);

        // Upload to Supabase Storage
        const { data: callerUpload, error: callerError } = await supabase.storage
          .from(STORAGE_BUCKET)
          .upload(callerFilename, callerBuffer, {
            contentType: 'audio/wav',
            upsert: true
          });

        if (callerError) {
          console.error(`❌ Failed to upload caller audio:`, callerError.message, callerError);
        } else {
          const { data: callerUrl } = supabase.storage
            .from(STORAGE_BUCKET)
            .getPublicUrl(callerFilename);
          results.urls.caller = callerUrl.publicUrl;
          console.log(`📤 Uploaded caller audio: ${callerUrl.publicUrl}`);
        }
      }

      // Save AI recording
      if (aiData.length > 0) {
        const aiFilename = `${baseFilename}_ai.wav`;
        const aiHeader = createMuLawWavHeader(aiData.length);
        const aiBuffer = Buffer.concat([aiHeader, aiData]);

        // Upload to Supabase Storage
        const { data: aiUpload, error: aiError } = await supabase.storage
          .from(STORAGE_BUCKET)
          .upload(aiFilename, aiBuffer, {
            contentType: 'audio/wav',
            upsert: true
          });

        if (aiError) {
          console.error(`❌ Failed to upload AI audio:`, aiError.message, aiError);
        } else {
          const { data: aiUrl } = supabase.storage
            .from(STORAGE_BUCKET)
            .getPublicUrl(aiFilename);
          results.urls.ai = aiUrl.publicUrl;
          console.log(`📤 Uploaded AI audio: ${aiUrl.publicUrl}`);
        }
      }

      // Update call_logs with recording URLs
      if (results.urls.caller || results.urls.ai) {
        const recordingUrls = {
          caller_recording_url: results.urls.caller || null,
          ai_recording_url: results.urls.ai || null,
          recording_duration: results.duration
        };

        const { error: updateError } = await supabase
          .from('call_logs')
          .update(recordingUrls)
          .eq('call_sid', this.callSid);

        if (updateError) {
          console.error(`❌ Failed to update call_logs with recording URLs:`, updateError.message);
        } else {
          console.log(`✅ Updated call_logs with recording URLs for ${this.callSid}`);
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
