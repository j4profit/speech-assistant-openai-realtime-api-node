// Audio recording utility for capturing call audio from WebSocket streams
const fs = require('fs');
const path = require('path');

// Ensure recordings directory exists
const RECORDINGS_DIR = path.join(__dirname, '..', 'recordings');
if (!fs.existsSync(RECORDINGS_DIR)) {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
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
   * Save recordings to files
   * @returns {Object} Paths to saved files
   */
  async save() {
    if (!this.enabled) {
      return { success: false, reason: 'Recording disabled' };
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const baseFilename = `${this.callSid}_${timestamp}`;

    const results = {
      callSid: this.callSid,
      duration: Math.round((Date.now() - this.startTime) / 1000),
      files: {}
    };

    try {
      // Save caller audio
      if (this.callerAudio.length > 0) {
        const callerData = Buffer.concat(this.callerAudio);
        const callerPath = path.join(RECORDINGS_DIR, `${baseFilename}_caller.wav`);
        const callerHeader = createMuLawWavHeader(callerData.length);
        fs.writeFileSync(callerPath, Buffer.concat([callerHeader, callerData]));
        results.files.caller = callerPath;
        console.log(`📁 Saved caller audio: ${callerPath} (${callerData.length} bytes)`);
      }

      // Save AI audio
      if (this.aiAudio.length > 0) {
        const aiData = Buffer.concat(this.aiAudio);
        const aiPath = path.join(RECORDINGS_DIR, `${baseFilename}_ai.wav`);
        const aiHeader = createMuLawWavHeader(aiData.length);
        fs.writeFileSync(aiPath, Buffer.concat([aiHeader, aiData]));
        results.files.ai = aiPath;
        console.log(`📁 Saved AI audio: ${aiPath} (${aiData.length} bytes)`);
      }

      results.success = true;
      console.log(`✅ Recording saved for call ${this.callSid} (${results.duration}s)`);

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
