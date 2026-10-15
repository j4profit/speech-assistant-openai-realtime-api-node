// Configuration module for environment variables

/**
 * Validates that required environment variables are present
 * @throws {Error} if required variables are missing
 */
function validateConfig() {
  const required = ['OPENAI_API_KEY', 'SUPABASE_URL', 'SUPABASE_ANON_KEY'];
  const missing = required.filter(key => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

/**
 * Application configuration object
 */
const config = {
  // OpenAI Configuration
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    model: 'gpt-realtime-2.1-mini', // Primary model (latest mini realtime model)
    fallbackModel: 'gpt-realtime-mini', // Backup if primary fails (legacy, shuts down 2027-01-20)
    reasoningEffort: 'low', // minimal | low | medium | high | xhigh
    websocketUrl: 'wss://api.openai.com/v1/realtime'
  },

  // Supabase Configuration
  supabase: {
    url: process.env.SUPABASE_URL,
    anonKey: process.env.SUPABASE_ANON_KEY
  },

  // Twilio Configuration
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    authToken: process.env.TWILIO_AUTH_TOKEN,
    enabled: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN),
    // Recording options: 'record-from-answer-dual' (dual channel), 'record-from-answer' (single channel), or 'do-not-record'
    recording: process.env.TWILIO_RECORDING || 'do-not-record'
  },

  // Server Configuration
  server: {
    port: process.env.PORT || 3000,
    baseUrl: process.env.BASE_URL || 'https://ring2tech.com',
    environment: process.env.NODE_ENV || 'development'
  },

  // Voice Configuration
  voice: {
    model: 'Google.en-US-Chirp3-HD-Aoede',
    vadEagerness: 'low', // semantic_vad eagerness: low | medium | high | auto (low = waits for caller to finish)
    noiseReduction: 'near_field', // near_field (phone handset) | far_field | null to disable
    greetingDelayMs: 2500 // AI greets first if caller is silent this long after connecting
  },

  // Order Configuration
  order: {
    maxAddressRetries: 1,
    defaultPreparationTime: 20,
    defaultDeliveryTime: 15
  }
};

// Validate configuration on load
validateConfig();

module.exports = config;
