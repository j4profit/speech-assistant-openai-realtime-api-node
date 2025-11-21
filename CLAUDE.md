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
- `createCallLog()` / `upsertCallLog()` - Log completed calls with transcripts (UPSERT based on call_sid)
- `searchRecentOrders()` - Find customer's recent orders by phone
- `cancelOrder()` - Cancel pending orders
- `updateOrder()` - Modify pending orders
- `validateDeliveryAddress()` - Check if address is within delivery radius
- `createOrder()` - Create new order entry
- `createCustomerMessage()` - Save customer messages/complaints

**Important**: The system makes HTTP POST requests to Supabase Edge Functions at `${SUPABASE_URL}/functions/v1/{function-name}`.

**Hybrid Call Logging (v2.9.18+)**:
The system uses a hybrid approach to ensure call logs are never lost:
1. **WebSocket logs first** (index.js:794) - Creates call log with full conversation transcript when call ends
2. **Twilio webhook updates** (routes/index.js:/call-status) - Updates call log with official Twilio call duration/status
3. **UPSERT prevents duplicates** - Uses `call_sid` as unique key; second write updates instead of creating duplicate
4. **Configure Twilio**: Set Status Callback URL to `${BASE_URL}/call-status` in Twilio phone number settings
5. **Benefits**: Transcript preserved even if webhook fails; accurate Twilio duration even if WebSocket drops early

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
Payment Method: cash
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
- `vadThreshold: 0.8` - Sensitivity for detecting speech
- `silenceDurationMs: 500` - Silence duration before considering turn complete
- Configured in `config/index.js` and applied in session setup

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
- Cleanup runs every 15 minutes (index.js:630-632)

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
- Check `processOrderFromTranscript()` parsing logic (index.js:399-477)
- Ensure `create-order` Edge Function is deployed and working

### Twilio call drops immediately
- Check BASE_URL is publicly accessible
- Verify Twilio webhook is configured correctly (POST to `/voice`)
- Look for errors in `/voice` endpoint handler

## Version History

- **v1.0.0**: Original monolithic implementation (2,742 lines in single file)
- **v2.0.0**: Refactored modular architecture
- **v2.1**: Added restaurant-specific AI voices, hours, taxes, and delivery fees
- DO NOT EVER USE SERVER_VAD only use semantic_vad
- everytime you edit something when i ask you must push and commit