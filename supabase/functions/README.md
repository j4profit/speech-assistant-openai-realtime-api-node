# Supabase Edge Functions

This directory contains all Supabase Edge Functions used by the restaurant ordering system.

## Deployed Functions

All functions are deployed to: `https://ujgpqnarhcegrpyzbxej.supabase.co/functions/v1/`

### 1. get-restaurant
**Endpoint:** `/get-restaurant`
**Purpose:** Lookup restaurant details by phone number
**Request:**
```json
{
  "phone_number": "+14105551234"
}
```
**Features:**
- Fetches restaurant data with all fields
- Optimizes menu items by grouping by name and sizes
- Only returns available menu items
- Returns delivery settings (radius, hours, fees, etc.)

---

### 2. create-call-log
**Endpoint:** `/create-call-log`
**Purpose:** Log completed calls with transcripts and handle billing
**Request:**
```json
{
  "call_sid": "CA...",
  "restaurant_id": "uuid",
  "from_number": "+14105551234",
  "to_number": "+14105556789",
  "call_duration": 120,
  "conversation_transcript": "...",
  "order_id": "uuid"
}
```
**Features:**
- Creates call log record
- Rounds call duration up to next minute for billing
- Deducts time from restaurant balance
- Creates usage transaction record
- Links call to order if applicable

---

### 3. search-orders
**Endpoint:** `/search-orders`
**Purpose:** Find customer's recent orders by phone number
**Request:**
```json
{
  "phone_number": "+14105551234",
  "restaurant_id": "uuid",
  "days_back": 7
}
```
**Security:** Multi-tenant isolation - requires both phone AND restaurant_id
**Returns:** Only pending orders (modifiable)

---

### 4. cancel-order
**Endpoint:** `/cancel-order`
**Purpose:** Cancel a pending order
**Request:**
```json
{
  "order_id": "uuid",
  "reason": "Customer cancellation"
}
```
**Note:** Only cancels orders with status = 'pending'

---

### 5. update-order
**Endpoint:** `/update-order`
**Purpose:** Modify an existing order
**Request:**
```json
{
  "order_id": "uuid",
  "modifications": "Add extra cheese",
  "new_total": 25.50,
  "order_details": "Updated order details",
  "special_instructions": "Extra napkins"
}
```
**Note:** Only updates orders with status = 'pending' or 'modified'

---

### 6. validate-delivery-address
**Endpoint:** `/validate-delivery-address`
**Purpose:** Validate delivery address and check if within delivery radius
**Request:**
```json
{
  "address": "123 Main St, Baltimore, MD 21201",
  "restaurant_id": "uuid"
}
```
**Features:**
- Uses OpenStreetMap Nominatim for geocoding
- Calculates distance using Haversine formula
- Validates address format
- Checks if within restaurant's delivery radius
- Returns estimated delivery time

---

### 7. create-order
**Endpoint:** `/create-order`
**Purpose:** Create a new order in the database
**Request:**
```json
{
  "restaurant_id": "uuid",
  "customer_phone": "+14105551234",
  "customer_name": "John Doe",
  "total_amount": 25.50,
  "order_type": "delivery",
  "delivery_address": "123 Main St, Baltimore, MD 21201",
  "order_details": "2x Cheeseburger, 1x Fries",
  "special_instructions": "Extra ketchup",
  "ready_time": "30 minutes",
  "estimated_ready_at": "2024-01-01T12:30:00Z",
  "call_sid": "CA..."
}
```
**Features:**
- Validates required fields
- Handles invalid customer names (fallback to "Walk-in Customer")
- Creates order with status = 'pending'

---

### 8. create-message
**Endpoint:** `/create-message`
**Purpose:** Save customer messages/complaints for restaurant staff
**Request:**
```json
{
  "restaurant_id": "uuid",
  "customer_phone": "+14105551234",
  "customer_name": "John Doe",
  "message_type": "complaint",
  "subject": "Order Issue",
  "message_content": "My order was cold",
  "call_sid": "CA...",
  "order_reference": "uuid",
  "priority": "high"
}
```
**Message Types:** complaint, feedback, callback_request, general
**Priorities:** low, normal, high, urgent

---

## Deployment

To deploy these functions to Supabase:

```bash
# Install Supabase CLI
npm install -g supabase

# Login to Supabase
supabase login

# Link to your project
supabase link --project-ref ujgpqnarhcegrpyzbxej

# Deploy all functions
supabase functions deploy get-restaurant
supabase functions deploy create-call-log
supabase functions deploy search-orders
supabase functions deploy cancel-order
supabase functions deploy update-order
supabase functions deploy validate-delivery-address
supabase functions deploy create-order
supabase functions deploy create-message
```

## Environment Variables

All functions require these environment variables (automatically set in Supabase):
- `SUPABASE_URL` - Your Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY` - Service role key (has full database access)

These are automatically available in the Deno runtime when deployed to Supabase.

## CORS

All functions include CORS headers to allow requests from any origin:
```typescript
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
```

## Testing Locally

You can test functions locally using the Supabase CLI:

```bash
# Start Supabase locally
supabase start

# Serve a specific function
supabase functions serve get-restaurant

# Test with curl
curl -X POST http://localhost:54321/functions/v1/get-restaurant \
  -H "Content-Type: application/json" \
  -d '{"phone_number": "+14105551234"}'
```
