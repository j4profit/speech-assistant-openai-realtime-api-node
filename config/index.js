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
    model: 'gpt-4o-mini-realtime-preview-2024-12-17',
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
    enabled: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN)
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
    vadThreshold: 0.8,
    silenceDurationMs: 500
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
