// Audio Analysis Service - Analyzes incoming audio to determine optimal VAD settings
// This helps adapt to different noise environments automatically

/**
 * Audio analysis state for a call
 */
class AudioAnalysis {
  constructor() {
    this.samplesAnalyzed = 0;
    this.totalSamples = 0;
    this.sumSquares = 0;
    this.maxAmplitude = 0;
    this.noiseFloor = Infinity;
    this.signalPeaks = [];
    this.analysisComplete = false;
    this.recommendedThreshold = null;
    this.recommendedSilenceDuration = null;
    this.environmentType = 'unknown';
  }

  /**
   * Analyze an audio chunk (µ-law encoded)
   * @param {Buffer} mulawBuffer - µ-law audio buffer
   */
  analyzeChunk(mulawBuffer) {
    if (this.analysisComplete) return;

    // Decode µ-law to PCM16 for analysis
    const pcm16 = this.decodeMuLaw(mulawBuffer);

    for (let i = 0; i < pcm16.length; i++) {
      const sample = Math.abs(pcm16[i]);

      // Track statistics
      this.sumSquares += sample * sample;
      this.maxAmplitude = Math.max(this.maxAmplitude, sample);

      // Track noise floor (minimum non-zero amplitudes)
      if (sample > 100) { // Ignore near-silence
        this.noiseFloor = Math.min(this.noiseFloor, sample);
      }

      // Track signal peaks (above threshold)
      if (sample > 3000) {
        this.signalPeaks.push(sample);
      }

      this.totalSamples++;
    }

    this.samplesAnalyzed++;

    // Complete analysis after ~2 seconds of audio (250 chunks @ 20ms each)
    if (this.samplesAnalyzed >= 100) {
      this.completeAnalysis();
    }
  }

  /**
   * Complete the analysis and determine recommendations
   */
  completeAnalysis() {
    if (this.analysisComplete || this.totalSamples === 0) return;

    this.analysisComplete = true;

    // Calculate RMS (Root Mean Square) - overall audio level
    const rms = Math.sqrt(this.sumSquares / this.totalSamples);

    // Calculate Signal-to-Noise Ratio (SNR)
    const avgPeak = this.signalPeaks.length > 0
      ? this.signalPeaks.reduce((a, b) => a + b, 0) / this.signalPeaks.length
      : this.maxAmplitude;

    const snr = this.noiseFloor > 0 && this.noiseFloor !== Infinity
      ? avgPeak / this.noiseFloor
      : 10; // Default moderate SNR

    // Determine environment type and recommendations
    this.environmentType = this.classifyEnvironment(rms, snr, this.noiseFloor);
    this.recommendedThreshold = this.calculateOptimalThreshold(rms, snr, this.noiseFloor);
    this.recommendedSilenceDuration = this.calculateOptimalSilenceDuration(this.environmentType);

    console.log('🔍 Audio Analysis Complete:', {
      environment: this.environmentType,
      rms: Math.round(rms),
      snr: snr.toFixed(2),
      noiseFloor: Math.round(this.noiseFloor),
      maxAmplitude: Math.round(this.maxAmplitude),
      signalPeaks: this.signalPeaks.length,
      recommendedThreshold: this.recommendedThreshold,
      recommendedSilenceDuration: this.recommendedSilenceDuration
    });
  }

  /**
   * Classify the audio environment
   * @param {number} rms - RMS level
   * @param {number} snr - Signal-to-noise ratio
   * @param {number} noiseFloor - Minimum amplitude
   * @returns {string} Environment classification
   */
  classifyEnvironment(rms, snr, noiseFloor) {
    // Very noisy environment (restaurant, street, etc.)
    if (noiseFloor > 2000 || (rms > 4000 && snr < 3)) {
      return 'very_noisy';
    }

    // Moderately noisy (office, home with TV/kids)
    if (noiseFloor > 1000 || (rms > 2000 && snr < 5)) {
      return 'moderately_noisy';
    }

    // Quiet environment (home, quiet office)
    if (noiseFloor < 500 && snr > 8) {
      return 'quiet';
    }

    // Very quiet (professional recording, silent room)
    if (noiseFloor < 300 && snr > 15) {
      return 'very_quiet';
    }

    // Default: normal
    return 'normal';
  }

  /**
   * Calculate optimal VAD threshold based on environment
   * @param {number} rms - RMS level
   * @param {number} snr - Signal-to-noise ratio
   * @param {number} noiseFloor - Minimum amplitude
   * @returns {number} Recommended threshold (0.0 - 1.0)
   */
  calculateOptimalThreshold(rms, snr, noiseFloor) {
    const env = this.classifyEnvironment(rms, snr, noiseFloor);

    switch (env) {
      case 'very_noisy':
        // Lower threshold = more sensitive (catch speech in noise)
        return 0.5;

      case 'moderately_noisy':
        // Slightly lower than default
        return 0.6;

      case 'quiet':
        // Default threshold works well
        return 0.8;

      case 'very_quiet':
        // Higher threshold = less sensitive (ignore tiny sounds)
        return 0.9;

      case 'normal':
      default:
        // Balanced default
        return 0.7;
    }
  }

  /**
   * Calculate optimal silence duration based on environment
   * @param {string} environmentType - Environment classification
   * @returns {number} Recommended silence duration in milliseconds
   */
  calculateOptimalSilenceDuration(environmentType) {
    switch (environmentType) {
      case 'very_noisy':
        // Shorter silence duration in noisy environments (don't wait too long)
        return 400;

      case 'moderately_noisy':
        return 450;

      case 'quiet':
        // Default works well
        return 500;

      case 'very_quiet':
        // Can afford to wait longer (no background noise to confuse with silence)
        return 600;

      case 'normal':
      default:
        return 500;
    }
  }

  /**
   * Decode µ-law to PCM16 (same as audioProcessor.js)
   * @param {Buffer} mulawBuffer - µ-law encoded buffer
   * @returns {Int16Array} PCM16 samples
   */
  decodeMuLaw(mulawBuffer) {
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
   * Get the analysis results
   * @returns {Object|null} Analysis results or null if not complete
   */
  getResults() {
    if (!this.analysisComplete) return null;

    return {
      environmentType: this.environmentType,
      recommendedThreshold: this.recommendedThreshold,
      recommendedSilenceDuration: this.recommendedSilenceDuration,
      statistics: {
        totalSamples: this.totalSamples,
        maxAmplitude: this.maxAmplitude,
        noiseFloor: this.noiseFloor,
        signalPeaks: this.signalPeaks.length
      }
    };
  }
}

/**
 * Create a new audio analysis instance for a call
 * @returns {AudioAnalysis} New analysis instance
 */
function createAnalyzer() {
  return new AudioAnalysis();
}

module.exports = {
  createAnalyzer
};
