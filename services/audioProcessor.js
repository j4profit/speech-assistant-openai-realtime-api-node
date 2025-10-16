// Audio processing service - Echo cancellation, noise suppression, AGC
const encodeMuLaw = require('../utils/encodeMuLaw');

// Module state
let isInitialized = false;

/**
 * Initialize audio processor
 * @returns {Promise<void>}
 */
async function initialize() {
  if (isInitialized) return;

  try {
    // Audio processor initialized without external noise suppression library
    // Using built-in DSP algorithms for now
    isInitialized = true;
    console.log('✅ Audio processor initialized (Echo cancellation + AGC enabled)');
  } catch (error) {
    console.error('❌ Failed to initialize audio processor:', error);
    console.warn('⚠️  Continuing without audio processing');
    isInitialized = false;
  }
}

/**
 * Decode µ-law to PCM16
 * @param {Buffer} mulawBuffer - µ-law encoded buffer
 * @returns {Int16Array} PCM16 samples
 */
function decodeMuLaw(mulawBuffer) {
  const pcm16 = new Int16Array(mulawBuffer.length);

  for (let i = 0; i < mulawBuffer.length; i++) {
    const mulaw = mulawBuffer[i];
    const sign = mulaw & 0x80;
    const exponent = (mulaw >> 4) & 0x07;
    const mantissa = mulaw & 0x0F;

    let sample = ((mantissa << 3) + 132) << exponent;
    sample = sign ? -sample : sample;

    pcm16[i] = sample;
  }

  return pcm16;
}

/**
 * Apply automatic gain control (AGC)
 * Normalizes audio volume to prevent too quiet or too loud audio
 * @param {Int16Array} pcm16 - PCM16 samples
 * @param {number} targetLevel - Target RMS level (0.0 - 1.0)
 * @returns {Int16Array} Normalized PCM16 samples
 */
function applyAGC(pcm16, targetLevel = 0.25) {
  // Calculate RMS (Root Mean Square) level
  let sum = 0;
  for (let i = 0; i < pcm16.length; i++) {
    sum += pcm16[i] * pcm16[i];
  }
  const rms = Math.sqrt(sum / pcm16.length);
  const currentLevel = rms / 32768.0;

  // Calculate gain factor
  if (currentLevel < 0.01) return pcm16; // Too quiet, skip normalization

  const gainFactor = Math.min(2.0, targetLevel / currentLevel);

  // Apply gain with soft clipping
  const normalized = new Int16Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) {
    let sample = pcm16[i] * gainFactor;

    // Soft clipping to prevent harsh distortion
    if (sample > 32767) sample = 32767;
    if (sample < -32768) sample = -32768;

    normalized[i] = Math.round(sample);
  }

  return normalized;
}

/**
 * Apply basic echo cancellation using spectral subtraction
 * @param {Int16Array} pcm16 - PCM16 samples
 * @param {Int16Array} referenceSignal - Reference signal (previous output)
 * @returns {Int16Array} Echo-cancelled PCM16 samples
 */
function applyEchoCancellation(pcm16, referenceSignal) {
  if (!referenceSignal || referenceSignal.length === 0) {
    return pcm16; // No reference signal, return original
  }

  // Simple adaptive filter approach
  const output = new Int16Array(pcm16.length);
  const alpha = 0.3; // Echo suppression factor

  for (let i = 0; i < pcm16.length; i++) {
    const refIndex = i % referenceSignal.length;
    const echoEstimate = referenceSignal[refIndex] * alpha;
    output[i] = Math.round(pcm16[i] - echoEstimate);
  }

  return output;
}

/**
 * Apply noise suppression using simple spectral gating
 * @param {Int16Array} pcm16 - PCM16 samples
 * @returns {Int16Array} Noise-suppressed PCM16 samples
 */
function applyNoiseSuppression(pcm16) {
  if (!isInitialized) {
    return pcm16;
  }

  // Simple noise gate - suppress samples below threshold
  const threshold = 1000; // Adjust based on testing
  const output = new Int16Array(pcm16.length);

  for (let i = 0; i < pcm16.length; i++) {
    const sample = Math.abs(pcm16[i]);
    if (sample < threshold) {
      // Attenuate quiet samples (likely noise)
      output[i] = Math.round(pcm16[i] * 0.3);
    } else {
      output[i] = pcm16[i];
    }
  }

  return output;
}

/**
 * Process audio buffer with all enhancements
 * @param {Buffer} mulawBuffer - µ-law audio buffer from Twilio
 * @param {Object} options - Processing options
 * @param {boolean} options.noiseSuppression - Enable noise suppression
 * @param {boolean} options.echoCancellation - Enable echo cancellation
 * @param {boolean} options.autoGainControl - Enable AGC
 * @param {Int16Array} options.referenceSignal - Reference signal for echo cancellation
 * @returns {Buffer} Processed µ-law audio buffer
 */
function processAudio(mulawBuffer, options = {}) {
  const {
    noiseSuppression = true,
    echoCancellation = true,
    autoGainControl = true,
    referenceSignal = null
  } = options;

  // Decode µ-law to PCM16
  let pcm16 = decodeMuLaw(mulawBuffer);

  // Apply noise suppression (first, to clean signal)
  if (noiseSuppression && isInitialized) {
    pcm16 = applyNoiseSuppression(pcm16);
  }

  // Apply echo cancellation
  if (echoCancellation && referenceSignal) {
    pcm16 = applyEchoCancellation(pcm16, referenceSignal);
  }

  // Apply AGC (last, to normalize final output)
  if (autoGainControl) {
    pcm16 = applyAGC(pcm16, 0.25);
  }

  // Convert back to µ-law
  const pcm16Buffer = Buffer.from(pcm16.buffer);
  return encodeMuLaw(pcm16Buffer);
}

/**
 * Cleanup audio processor resources
 */
function cleanup() {
  try {
    isInitialized = false;
    console.log('Audio processor cleaned up');
  } catch (error) {
    console.error('Error cleaning up audio processor:', error);
  }
}

module.exports = {
  initialize,
  processAudio,
  cleanup,
  isInitialized: () => isInitialized
};
