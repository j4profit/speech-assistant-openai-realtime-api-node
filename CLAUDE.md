# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is an AI-powered restaurant ordering system that uses OpenAI's Realtime API for voice interactions via Twilio. The system enables customers to place orders, check existing orders, request callbacks, and interact with restaurant staff through a conversational AI interface.

**Key Technologies:**
- Node.js with Express
- OpenAI Realtime API (WebSocket-based voice)
- Twilio (telephony and WebSocket media streams)
- Supabase (database and Edge Functions)

## Essential Commands

### Development
```bash
npm install              # Install dependencies
npm run dev             # Run with nodemon (auto-reload)
npm start               # Run in production mode
```

### Environment Setup
1. Copy `.env.example` to `.env`
2. Required environment variables:
   - `OPENAI_API_KEY` - OpenAI API key for Realtime API
   - `SUPABASE_URL` - Supabase project URL
   - `SUPABASE_ANON_KEY` - Supabase anonymous key
   - `TWILIO_ACCOUNT_SID` - Twilio account SID
   - `TWILIO_AUTH_TOKEN` - Twilio auth token
   - `BASE_URL` - Public base URL for webhooks (e.g., `https://ring2tech.com`)
   - `PORT` - Server port (default: 3000)

## Architecture Overview

### Refactored Modular Structure (v2.0+)

The codebase was refactored from a 2,742-line monolithic file into a clean modular architecture:

```
/
├── index.js                        # Main application entry point (~600 lines)
├── config/
│   └── index.js                    # Centralized configuration with validation
├── services/
│   ├── database.js                 # All Supabase Edge Function calls
│   ├── twilio.js                   # Twilio call management & TwiML generation
│   ├── aiInstructions.js           # AI prompt generation for OpenAI Realtime API
│   └── stateManager.js             # Call state management (replaces globals)
├── routes/
│   └── index.js                    # HTTP endpoints (Express routes)
└── utils/
    ├── encodeMuLaw.js             # Audio encoding utilities
    └── orderHelpers.js            # Order formatting and calculations
```

### Core Flow: Twilio → WebSocket → OpenAI Realtime API

1. **Incoming Call**: Twilio webhook hits `/voice` endpoint
2. **TwiML Response**: Server responds with `<Connect><Stream>` TwiML pointing to WebSocket endpoint
3. **WebSocket Established**: Twilio opens WebSocket to `/media-stream`
4. **Dual WebSocket Architecture**:
   - **Twilio WebSocket**: Receives µ-law audio chunks from caller
   - **OpenAI WebSocket**: Connects to OpenAI Realtime API for voice AI
5. **Audio Pipeline**: Twilio audio → OpenAI Realtime API → AI response audio → Twilio → Caller
6. **Function Calling**: AI uses tools to interact with Supabase Edge Functions
7. **Order Processing**: When AI confirms order, system creates database entry and ends call

### State Management

The `stateManager` service (services/stateManager.js) manages call state using a Map:
- **Purpose**: Track active calls, store restaurant data, link orders to calls
- **Auto-cleanup**: Removes stale call data after 60 minutes
- **Critical Data**: Restaurant info cached to avoid duplicate lookups

### Database Operations

All database operations go through **Supabase Edge Functions** (services/database.js):
- `getRestaurantByPhone()` - Lookup restaurant by phone number
- `searchRecentOrders()` - Find customer's recent orders by phone
- `cancelOrder()` - Cancel pending orders
- `updateOrder()` - Modify pending orders
- `validateDeliveryAddress()` - Check if address is within delivery radius (with caching support)
- `createOrder()` - Create new order entry
- `createCustomerMessage()` - Save customer messages/complaints
- `getCustomerAddress()` - Retrieve cached delivery address ⭐ NEW (v2.3)
- `saveCustomerAddress()` - Save validated delivery address for future orders ⭐ NEW (v2.3)

**Note**: Call logging is handled by Twilio's backend, not by the voice AI system.

**Important**: The system makes HTTP POST requests to Supabase Edge Functions at `${SUPABASE_URL}/functions/v1/{function-name}`.

**Edge Function Source Code**: All edge functions are saved in `supabase/functions/` directory for reference and deployment. See `supabase/functions/README.md` for deployment instructions.

### AI Instructions System

The `aiInstructions.js` service generates dynamic prompts for OpenAI Realtime API:

**Critical Rules Enforced**:
1. **Never ask for phone numbers** - Caller ID is automatically captured
2. **Address validation flow** - Max 2 retry attempts for delivery addresses
3. **Message intent detection** - Natural language understanding for customer messages
4. **Concise responses** - 1-2 sentences maximum (except ORDER_CONFIRMED format)
5. **Restaurant-specific customizations** - Uses `restaurant.additional_ai_instructions` field

**AI Function Tools**:
- `search_recent_orders` - Automatically uses caller ID (no params needed)
- `validate_delivery_address` - Validates delivery feasibility
- `cancel_order` - Cancels pending orders
- `update_order` - Modifies pending orders
- `create_customer_message` - Saves messages for staff

### Order Confirmation Format

When AI confirms an order, it generates a structured transcript with `ORDER_CONFIRMED:` prefix:
```
ORDER_CONFIRMED:
Customer Name: John Doe
Order Type: delivery
Delivery Address: 123 Main St, Baltimore, MD 21201
Items: 2x Cheeseburger, 1x Fries
Total: $25.50
```

This triggers `processOrderFromTranscript()` which:
1. Parses order details
2. Calculates tax and delivery fees (using `restaurant.tax_rate` and `restaurant.delivery_fee`)
3. Creates order in database via `createOrder()` Edge Function
4. Prints formatted order ticket to console
5. Gracefully ends call after 3 seconds

### Restaurant-Specific Features (V2.1)

Recent commits added:
- **Per-restaurant AI voices** - `restaurant.ai_voice` field (e.g., "coral", "alloy")
- **Restaurant hours** - `restaurant.hours` field for answering "when are you open?"
- **Custom tax rates** - `restaurant.tax_rate` (decimal, e.g., 0.06 for 6%)
- **Delivery fees** - `restaurant.delivery_fee` (dollar amount)
- **Custom AI instructions** - `restaurant.additional_ai_instructions` (appended to prompt)

### Delivery Address Caching (V2.3)

**Purpose**: Speed up repeat delivery orders by caching validated addresses

**New Table**: `customer_delivery_addresses`
- Stores validated delivery addresses per customer per restaurant
- Includes delivery instructions ("Front door", "Ring bell", etc.)
- Tracks usage statistics (`times_used`, `last_used_at`)
- Multi-tenant secure: UNIQUE constraint on `(restaurant_id, customer_phone)`
- **Foreign Key Link**: `orders.delivery_address_id` references this table

**Flow for First-Time Delivery Customer:**
1. Customer says "I want delivery"
2. AI calls `check_customer_address` → No address found
3. AI asks "What's your delivery address?"
4. Customer provides address
5. AI calls `validate_delivery_address` with customer_phone
6. Edge function validates AND saves result to cache, returns `address_id`
7. System stores `address_id` in call state
8. AI asks "Any delivery instructions? Like front door, side entrance, etc?"
9. Customer provides instructions
10. System updates cached address with delivery instructions
11. AI takes order
12. Order created with `delivery_address_id` linking to cached record

**Flow for Returning Delivery Customer:**
1. Customer says "I want delivery"
2. AI calls `check_customer_address` → Address found with `address_id`!
3. System stores `address_id` in call state
4. AI says "I have your address on file: 123 Main St. Is that correct?"
5. Customer confirms: "Yes"
6. AI asks "Same instructions - leave at front door?"
7. Customer confirms
8. **10-30 seconds saved!** - No address validation needed
9. AI takes order
10. Order created with `delivery_address_id` linking to cached record

**Key Features:**
- ✅ **No re-validation**: Cached addresses skip geocoding entirely
- ✅ **Delivery instructions persistence**: Instructions saved to cached address
- ✅ **Order tracking**: `orders.delivery_address_id` links to validation record
- ✅ **Usage analytics**: `times_used` and `last_used_at` updated automatically

**Key Files:**
- `supabase/functions/get-customer-address/` - Check for saved address
- `supabase/functions/save-customer-address/` - Save validated address
- `supabase/functions/validate-delivery-address/` - Updated to check cache first
- `supabase/functions/create-order/` - Updated to accept `delivery_address_id`
- `services/database.js` - Added `getCustomerAddress()`, `saveCustomerAddress()`, `updateDeliveryInstructions()`
- `services/aiInstructions.js` - Updated delivery flow to check cache first
- `index.js` - Added `check_customer_address` AI function tool, tracks `deliveryAddressId` in call state

**ORDER_CONFIRMED Format Updated:**
```
ORDER_CONFIRMED:
Customer Name: John Doe
Order Type: delivery
Delivery Address: 123 Main St, Baltimore, MD 21201
Delivery Instructions: Leave at front door
Items: 2x Cheeseburger, 1x Fries
Total: $25.50
```

**Order Ticket Now Includes:**
```
ORDER TYPE: DELIVERY
• Delivery Address: 123 Main St, Baltimore, MD 21201
• Delivery Instructions: Leave at front door
```

## Key Implementation Details

### Twilio Call Hangup

Two methods available (services/twilio.js):

1. **Graceful Hangup** (default):
   - Redirects call to `/hangup-twiml` endpoint
   - Plays Ring Two Tech branding message with Google Chirp3 HD voice
   - Allows AI to say goodbye before disconnecting

2. **Immediate Hangup**:
   - Terminates call instantly via Twilio API
   - Used for errors (restaurant not found, WebSocket failures)

### Restaurant Lookup Optimization (Recent Fix)

**Problem**: The `/voice` webhook was performing restaurant lookup before responding to Twilio, causing 15-second timeout issues.

**Solution** (implemented in routes/index.js:40-78):
1. Respond to Twilio immediately with TwiML (< 1 second)
2. Perform restaurant lookup asynchronously after response using `setImmediate()`
3. Store restaurant data in `stateManager` with call SID as key
4. WebSocket handler retrieves cached restaurant from `stateManager` (index.js:59-69)

**Critical**: Always check `stateManager.getCallData(callId)` for cached restaurant before making API call.

### Audio Encoding

The system uses µ-law (G.711) audio format:
- Twilio sends/receives µ-law encoded audio
- OpenAI Realtime API configured with `input_audio_format: 'g711_ulaw'` and `output_audio_format: 'g711_ulaw'`
- `utils/encodeMuLaw.js` provides encoding utilities (currently unused as both systems use µ-law natively)

### Voice Activity Detection (VAD)

OpenAI Realtime API uses server-side VAD:
- `vadThreshold: 0.8` - Sensitivity for detecting speech (default)
- `silenceDurationMs: 500` - Silence duration before considering turn complete (default)
- Configured in `config/index.js` and applied in session setup

#### Dynamic VAD Adjustment (v2.2)

The system now automatically adjusts VAD settings based on the audio environment:

**How it works:**
1. During the first ~2 seconds of a call, `services/audioAnalyzer.js` analyzes incoming audio
2. Calculates: RMS level, signal-to-noise ratio (SNR), noise floor, signal peaks
3. Classifies environment: `very_noisy`, `moderately_noisy`, `normal`, `quiet`, or `very_quiet`
4. Sends `session.update` to OpenAI with optimal VAD settings for that environment
5. VAD settings adjust mid-call (happens once per call)

**Environment-specific adjustments:**
- **Very noisy** (restaurant, street): `threshold: 0.5`, `silence: 400ms` (more sensitive)
- **Moderately noisy** (office, TV): `threshold: 0.6`, `silence: 450ms`
- **Normal**: `threshold: 0.7`, `silence: 500ms`
- **Quiet** (home): `threshold: 0.8`, `silence: 500ms`
- **Very quiet** (silent room): `threshold: 0.9`, `silence: 600ms` (less sensitive)

**Benefits:**
- Noisy environments: Lower threshold catches speech better
- Quiet environments: Higher threshold prevents false triggers
- No manual tuning required - adapts automatically per call

**Implementation:**
- Audio analysis: `services/audioAnalyzer.js`
- VAD update logic: `index.js` lines 59-60, 630-640, 227-255
- Console logs show environment detection and adjustments

## Common Development Tasks

### Adding a New AI Function Tool

1. Define function schema in `index.js` in `getAITools()` (line 162-241)
2. Add handler case in `handleFunctionCall()` (line 302-397)
3. If needed, create corresponding database service in `services/database.js`
4. Update AI instructions in `services/aiInstructions.js` to explain when to use the tool

### Modifying AI Behavior

Edit `services/aiInstructions.js`:
- Update `generateAIInstructions()` for prompt changes
- Modify `shouldCreateCustomerMessage()` for message intent logic

### Adding HTTP Endpoints

Add routes to `routes/index.js` and use existing services for database operations.

### Testing Webhooks Locally

Use a tunnel service (ngrok, Cloudflare Tunnel) to expose localhost:
```bash
# Example with ngrok
ngrok http 3000

# Update .env
BASE_URL=https://your-ngrok-url.ngrok.io
```

Configure Twilio phone number webhook to point to `{BASE_URL}/voice`.

## Important Behavioral Rules

### Caller ID Usage
- **NEVER ask customers for phone numbers**
- Caller ID is automatically captured from Twilio webhook (`req.body.From`)
- `search_recent_orders` function uses caller ID automatically

### Address Validation
- **ALWAYS validate delivery addresses** before taking orders
- Maximum 2 validation retry attempts per call
- After 2 failed attempts, suggest pickup only

### Response Length
- AI responses must be 1-2 sentences maximum
- Exception: `ORDER_CONFIRMED:` format (required for parsing)

### Menu Handling
- Don't recite menu automatically
- Only provide menu when customer asks ("What do you have?", "What's on the menu?")

## Audio Processing

The system includes optional audio processing to improve call quality and transcription accuracy.

### Features

**Noise Suppression** (Spectral Gating)
- Simple DSP-based noise reduction
- Attenuates samples below threshold (likely noise)
- Reduces background noise: TV, traffic, conversations
- Improves AI transcription accuracy

**Echo Cancellation**
- Prevents feedback loops on speakerphone
- Uses adaptive filtering with reference signal
- Reduces audio cutoff issues

**Automatic Gain Control (AGC)**
- Normalizes volume levels
- Prevents too-quiet or too-loud audio
- Target RMS level: 0.25

### Configuration

Set in `.env` file (all default to true):
```bash
AUDIO_PROCESSING_ENABLED=true
AUDIO_NOISE_SUPPRESSION=true
AUDIO_ECHO_CANCELLATION=true
AUDIO_AUTO_GAIN_CONTROL=true
```

### Performance Impact

- Added latency: ~50-100ms per call
- CPU usage: +10-20% per concurrent call
- Memory: +10-20MB per call

### Disabling Audio Processing

To quickly disable without code changes:
```bash
# In .env
AUDIO_PROCESSING_ENABLED=false
```

Or disable individual features:
```bash
AUDIO_NOISE_SUPPRESSION=false
AUDIO_ECHO_CANCELLATION=false
AUDIO_AUTO_GAIN_CONTROL=false
```

### Architecture

```
Twilio µ-law Audio
    ↓
Decode to PCM16
    ↓
Noise Suppression (Spectral Gate)
    ↓
Echo Cancellation (Adaptive Filter)
    ↓
Auto Gain Control (AGC)
    ↓
Encode to µ-law
    ↓
OpenAI Realtime API
```

Implementation: `services/audioProcessor.js`

## Technical Constraints

### Twilio Webhook Timeout
- Twilio webhooks have a **15-second timeout**
- Always respond with TwiML immediately
- Perform expensive operations (DB lookups, API calls) asynchronously after responding

### OpenAI Realtime API
- Model: `gpt-4o-mini-realtime-preview-2024-12-17`
- WebSocket URL: `wss://api.openai.com/v1/realtime`
- Maximum response tokens: 400 (configured in session)
- Temperature: 0.6

### Call State Cleanup
- `stateManager` automatically cleans up calls older than 60 minutes
- Cleanup runs every 15 minutes (index.js:770-772)

## Troubleshooting

### "Restaurant not found" errors
- Check that `SUPABASE_URL` and `SUPABASE_ANON_KEY` are correct
- Verify restaurant exists in `restaurants` table with matching `phone_number`
- Check Supabase Edge Function `get-restaurant` is deployed

### WebSocket connection failures
- Verify `OPENAI_API_KEY` is valid
- Check console for WebSocket error messages
- Ensure firewall allows WSS connections

### Orders not being created
- Verify AI is generating `ORDER_CONFIRMED:` format in transcript
- Check `processOrderFromTranscript()` parsing logic (index.js:540-615)
- Ensure `create-order` Edge Function is deployed and working

### Twilio call drops immediately
- Check BASE_URL is publicly accessible
- Verify Twilio webhook is configured correctly (POST to `/voice`)
- Look for errors in `/voice` endpoint handler

### Audio quality issues / garbled audio
- Check if audio processing is causing issues: set `AUDIO_PROCESSING_ENABLED=false`
- Try disabling individual features (noise suppression, echo cancellation, AGC)
- Check CPU usage - high CPU can cause audio processing delays
- Adjust noise gate threshold in audioProcessor.js if too aggressive

### High CPU usage after audio processing added
- Reduce concurrent call limits
- Disable audio processing: `AUDIO_PROCESSING_ENABLED=false`
- Disable only heavy features: `AUDIO_NOISE_SUPPRESSION=false`
- Consider upgrading server resources

## Version History

- **v1.0.0**: Original monolithic implementation (2,742 lines in single file)
- **v2.0.0**: Refactored modular architecture
- **v2.1**: Added restaurant-specific AI voices, hours, taxes, delivery fees, and hangup unification
- **v2.2**: Added dynamic VAD adjustment based on real-time audio environment analysis
- **v2.3**: Added delivery address caching system with delivery instructions tracking
