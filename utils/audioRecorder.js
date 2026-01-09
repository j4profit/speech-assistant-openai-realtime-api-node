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
 * µ-law decoding table (µ-law byte -> 16-bit linear PCM)
 */
const MULAW_DECODE_TABLE = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  let mulaw = ~i;
  let sign = (mulaw & 0x80) ? -1 : 1;
  let exponent = (mulaw >> 4) & 0x07;
  let mantissa = mulaw & 0x0F;
  let sample = (mantissa << 3) + 0x84;
  sample <<= exponent;
  sample -= 0x84;
  MULAW_DECODE_TABLE[i] = sign * sample;
}

/**
 * µ-law encoding (16-bit linear PCM -> µ-law byte)
 */
function encodeMuLaw(sample) {
  const MULAW_MAX = 0x1FFF;
  const MULAW_BIAS = 33;

  let sign = (sample < 0) ? 0x80 : 0;
  if (sign) sample = -sample;

  sample = Math.min(sample + MULAW_BIAS, MULAW_MAX);

  let exponent = 7;
  for (let expMask = 0x1000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}

  let mantissa = (sample >> (exponent + 3)) & 0x0F;
  let mulawByte = ~(sign | (exponent << 4) | mantissa);

  return mulawByte & 0xFF;
}

/**
 * Mix two µ-law audio buffers into a single mono buffer
 * @param {Buffer} buffer1 - First µ-law audio buffer
 * @param {Buffer} buffer2 - Second µ-law audio buffer
 * @returns {Buffer} Mixed mono µ-law audio
 */
function mixMuLawBuffers(buffer1, buffer2) {
  const maxLength = Math.max(buffer1.length, buffer2.length);
  const mixed = Buffer.alloc(maxLength);

  for (let i = 0; i < maxLength; i++) {
    // Decode both samples to linear PCM
    const sample1 = i < buffer1.length ? MULAW_DECODE_TABLE[buffer1[i]] : 0;
    const sample2 = i < buffer2.length ? MULAW_DECODE_TABLE[buffer2[i]] : 0;

    // Mix (average to prevent clipping)
    let mixedSample = Math.round((sample1 + sample2) / 2);

    // Clamp to 16-bit range
    mixedSample = Math.max(-32768, Math.min(32767, mixedSample));

    // Encode back to µ-law
    mixed[i] = encodeMuLaw(mixedSample);
  }

  return mixed;
}

/**
 * Audio recorder class for capturing call audio with timestamp synchronization
 */
class AudioRecorder {
  constructor(callSid) {
    this.callSid = callSid;
    this.audioChunks = []; // Combined timeline: { time, source, data }
    this.startTime = Date.now();
    this.enabled = true;
  }

  /**
   * Add caller (customer) audio chunk with timestamp
   * @param {string} base64Audio - Base64-encoded µ-law audio
   */
  addCallerAudio(base64Audio) {
    if (this.enabled && base64Audio) {
      this.audioChunks.push({
        time: Date.now() - this.startTime,
        source: 'caller',
        data: Buffer.from(base64Audio, 'base64')
      });
    }
  }

  /**
   * Add AI audio chunk with timestamp
   * @param {string} base64Audio - Base64-encoded µ-law audio
   */
  addAIAudio(base64Audio) {
    if (this.enabled && base64Audio) {
      this.audioChunks.push({
        time: Date.now() - this.startTime,
        source: 'ai',
        data: Buffer.from(base64Audio, 'base64')
      });
    }
  }

  /**
   * Build timeline-synchronized audio buffer
   * Places audio chunks at correct positions based on timestamps
   */
  buildTimelineBuffer() {
    if (this.audioChunks.length === 0) {
      return Buffer.alloc(0);
    }

    // Sort chunks by timestamp
    this.audioChunks.sort((a, b) => a.time - b.time);

    // Calculate total duration in samples (8000 samples/sec for µ-law)
    const lastChunk = this.audioChunks[this.audioChunks.length - 1];
    const totalDurationMs = lastChunk.time + (lastChunk.data.length / 8); // 8 samples per ms
    const totalSamples = Math.ceil(totalDurationMs * 8); // 8000 Hz = 8 samples/ms

    // Create silence-filled buffer (µ-law silence = 0xFF)
    const buffer = Buffer.alloc(totalSamples, 0xFF);

    // Place each chunk at its timestamp position
    for (const chunk of this.audioChunks) {
      const startSample = Math.floor(chunk.time * 8); // Convert ms to samples

      for (let i = 0; i < chunk.data.length && (startSample + i) < buffer.length; i++) {
        const pos = startSample + i;

        // If there's already audio at this position, mix them
        if (buffer[pos] !== 0xFF) {
          // Decode both samples
          const existing = MULAW_DECODE_TABLE[buffer[pos]];
          const newSample = MULAW_DECODE_TABLE[chunk.data[i]];
          // Mix and re-encode
          const mixed = Math.round((existing + newSample) / 2);
          buffer[pos] = encodeMuLaw(Math.max(-32768, Math.min(32767, mixed)));
        } else {
          buffer[pos] = chunk.data[i];
        }
      }
    }

    return buffer;
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
      // Build timeline-synchronized audio
      const timelineData = this.buildTimelineBuffer();

      if (timelineData.length > 0) {
        const mixedFilename = `${baseFilename}_recording.wav`;

        // Create WAV file with timeline audio
        const mixedHeader = createMuLawWavHeader(timelineData.length);
        const mixedBuffer = Buffer.concat([mixedHeader, timelineData]);

        // Count chunks by source for logging
        const callerChunks = this.audioChunks.filter(c => c.source === 'caller').length;
        const aiChunks = this.audioChunks.filter(c => c.source === 'ai').length;
        console.log(`🎙️ Timeline recording: ${timelineData.length} bytes (${callerChunks} caller chunks, ${aiChunks} ai chunks)`);

        const { url: mixedUrl, error: mixedError } = await uploadToSupabaseStorage(
          mixedFilename,
          mixedBuffer,
          'audio/wav'
        );

        if (mixedError) {
          console.error(`❌ Recording upload failed:`, mixedError);
        } else {
          results.urls.recording = mixedUrl;
          console.log(`✅ Uploaded recording: ${mixedUrl}`);
        }
      }

      // Update call_logs with recording URL using direct fetch
      if (results.urls.recording) {
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
                recording_url: results.urls.recording,
                recording_duration: results.duration
              })
            }
          );

          if (!updateResponse.ok) {
            const errorText = await updateResponse.text();
            console.error(`❌ Failed to update call_logs:`, errorText);
          } else {
            console.log(`✅ Updated call_logs with recording URL for ${this.callSid}`);
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
    this.audioChunks = [];

    return results;
  }

  /**
   * Disable recording (e.g., if config says do-not-record)
   */
  disable() {
    this.enabled = false;
    this.audioChunks = [];
  }
}

module.exports = {
  AudioRecorder,
  RECORDINGS_DIR
};
