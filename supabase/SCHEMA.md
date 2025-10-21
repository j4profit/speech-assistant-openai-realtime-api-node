# Database Schema Documentation

## Overview

This document describes the Supabase database schema for the restaurant ordering system.

## Tables

### 🏠 customer_delivery_addresses
Cached validated delivery addresses for faster repeat orders (v2.3+).

**Key Fields:**
- `restaurant_id` + `customer_phone` (unique) - One address per customer per restaurant
- `customer_name` - Customer name from first order
- `delivery_address` - Full address as provided by customer
- `formatted_address` - Geocoded normalized address
- `is_valid` - Whether address is within delivery zone
- `latitude`, `longitude` - Geocoded coordinates
- `distance_from_restaurant` - Miles from restaurant
- `validation_reason` - Why invalid (if applicable)
- `delivery_instructions` - "Front door", "Ring bell", "Side entrance", etc.
- `last_used_at` - Most recent use timestamp
- `times_used` - Usage counter for analytics

**Purpose:**
- Speeds up repeat delivery orders (saves 10-30 seconds)
- Avoids re-validation of known addresses
- Tracks delivery instructions for consistency
- Provides customer usage analytics

**Flow:**
1. Customer requests delivery
2. System checks `customer_delivery_addresses` by phone
3. If found and valid: "I have your address on file: [address]. Is that correct?"
4. If customer confirms: Skip validation, proceed to order
5. If not found: Validate address → Save result for future use

---

### 🏢 restaurants
Core restaurant information and configuration.

**Key Fields:**
- `phone_number` (unique) - Used to identify which restaurant a call belongs to
- `delivery_enabled` - Whether restaurant offers delivery
- `delivery_radius` - Maximum delivery distance in miles
- `latitude`, `longitude` - Restaurant location for distance calculations
- `tax_rate` - Tax rate (decimal, e.g., 0.06 for 6%)
- `delivery_fee` - Delivery fee in dollars
- `ai_voice` - OpenAI Realtime API voice (alloy, ash, ballad, coral, echo, sage, shimmer, verse)
- `additional_ai_instructions` - Custom AI behavior instructions
- `printer_enabled`, `printer_auto_print`, `printer_name` - Printer integration settings
- `specials` - Daily/weekly specials text

**Relationships:**
- Has many: menu_items, orders, call_logs, customer_messages

---

### 🍔 menu_items
Restaurant menu items with pricing and availability.

**Key Fields:**
- `category` - Menu category (appetizers, entrees, desserts, etc.)
- `name` - Item name
- `description` - Item description
- `price` - Item price (numeric)
- `available` - Whether item is currently available
- `size` - Size variant (Small, Medium, Large, Regular)

**Notes:**
- Items with same `name` but different `size` are grouped together in API responses
- Only items with `available = true` are returned to AI

---

### 🍕 menu_categories
Logical grouping of menu items for display ordering.

**Key Fields:**
- `name` - Category name
- `display_order` - Order for displaying categories

**Status:** Currently defined but not actively used by edge functions

---

### 📦 orders
Customer orders placed through the AI system.

**Key Fields:**
- `customer_phone` - Customer's phone number (from Caller ID)
- `customer_name` - Customer's name
- `total_amount` - Total order amount including tax and fees
- `status` - Order status: pending, modified, cancelled, completed
- `order_type` - pickup or delivery
- `delivery_address` - Full delivery address (if delivery order)
- `delivery_instructions` - Where to leave delivery: "Front door", "Ring bell", "Side entrance", etc.
- `order_details` - Detailed order description (text)
- `special_instructions` - Customer notes/modifications
- `call_sid` - Twilio call SID that created this order
- `printed` - Whether order has been printed
- `printed_at` - When order was printed

**Relationships:**
- Belongs to: restaurant
- Referenced by: call_logs

---

### 📞 call_logs
Logs of all incoming calls with transcripts and billing.

**Key Fields:**
- `call_sid` (unique) - Twilio call identifier
- `from_number`, `to_number` - Phone numbers
- `call_duration` - Call length in seconds
- `conversation_transcript` - Full AI conversation transcript
- `order_id` - Linked order (if order was created)
- `billing_status` - pending, billed, failed, skipped
- `minutes_billed` - Rounded-up minutes for billing
- `usage_transaction_id` - Link to billing transaction

**Location Data:**
- `caller_city`, `caller_state`, `caller_zip`, `caller_country`
- `to_city`, `to_state`, `to_zip`, `to_country`

**Relationships:**
- Belongs to: restaurant, order (optional), usage_transaction (optional)

---

### 💳 restaurant_balances
Prepaid call time balances for each restaurant.

**Key Fields:**
- `restaurant_id` (unique) - One balance per restaurant
- `current_balance_seconds` - Available call time in seconds
- `current_balance_minutes` - Available call time in minutes (computed)
- `total_purchased_seconds` - Lifetime purchased seconds
- `low_balance_alert_sent` - Whether low balance alert has been sent
- `auto_recharge_enabled` - Auto-recharge feature flag
- `auto_recharge_threshold_seconds` - Trigger threshold for auto-recharge (default: 3000s = 50 min)

**Billing Flow:**
1. Call completes
2. `create-call-log` edge function rounds call duration up to next minute
3. Seconds deducted from `current_balance_seconds`
4. `usage_transaction` record created

---

### 💰 usage_transactions
Ledger of all balance changes (purchases, usage, refunds).

**Key Fields:**
- `transaction_type` - purchase, usage, refund, adjustment
- `seconds_change` - Change in balance (negative for usage, positive for purchases)
- `balance_before_seconds`, `balance_after_seconds` - Balance snapshot
- `call_log_id` - Link to call (for usage transactions)
- `minutes_billed` - Rounded minutes (for usage)
- `stripe_payment_intent_id` - Stripe payment reference (for purchases)
- `amount_paid_cents` - Amount paid in cents (for purchases)
- `description` - Human-readable description

**Relationships:**
- Belongs to: restaurant, call_log (optional)
- Referenced by: call_logs

---

### 💬 customer_messages
Customer messages, complaints, and callback requests.

**Key Fields:**
- `customer_phone` - Customer's phone number
- `customer_name` - Customer's name
- `message_type` - complaint, feedback, callback_request, general
- `subject` - Message subject
- `message_content` - Full message text
- `priority` - low, normal, high, urgent
- `status` - new, in_progress, resolved, closed
- `staff_response` - Restaurant staff response
- `responded_by`, `responded_at` - Response tracking

**Relationships:**
- Belongs to: restaurant

---

### 🎫 support_tickets
Restaurant support tickets for technical/billing issues.

**Key Fields:**
- `subject` - Ticket subject
- `message` - Issue description
- `category` - general, technical, billing, feature_request
- `priority` - low, normal, high, urgent
- `status` - open, in_progress, resolved, closed
- `admin_response` - Support team response
- `admin_name`, `admin_responded_at` - Response tracking

**Relationships:**
- Belongs to: restaurant

---

## Key Relationships

```
restaurants
  ├─ menu_items (1:many)
  ├─ menu_categories (1:many)
  ├─ orders (1:many)
  ├─ call_logs (1:many)
  ├─ customer_messages (1:many)
  ├─ customer_delivery_addresses (1:many)
  ├─ support_tickets (1:many)
  ├─ restaurant_balances (1:1)
  └─ usage_transactions (1:many)

orders
  └─ call_logs (1:many) - via order_id

call_logs
  └─ usage_transactions (1:1) - via usage_transaction_id

usage_transactions
  └─ call_logs (1:1) - via call_log_id

customer_delivery_addresses
  └─ restaurants (many:1) - via restaurant_id
      (one address per customer per restaurant)
```

## Important Constraints

1. **Multi-tenant Isolation**: All queries must filter by `restaurant_id` to prevent data leakage
2. **Phone Number Uniqueness**: `restaurants.phone_number` must be unique (used for routing)
3. **Call SID Uniqueness**: `call_logs.call_sid` must be unique (Twilio identifier)
4. **Balance Relationship**: Each restaurant has exactly one `restaurant_balances` row
5. **Address Uniqueness**: `customer_delivery_addresses` has UNIQUE constraint on `(restaurant_id, customer_phone)` - one address per customer per restaurant

## Billing Flow Diagram

```
Call Ends
    ↓
create-call-log Edge Function
    ↓
Calculate: billed_minutes = CEIL(call_duration / 60)
    ↓
Deduct from restaurant_balances.current_balance_seconds
    ↓
Create usage_transaction record (type = 'usage')
    ↓
Link call_log to usage_transaction
    ↓
Update call_log.billing_status = 'billed'
```

## Printer Integration

The schema includes printer fields on the `restaurants` and `orders` tables:
- `restaurants.printer_enabled` - Whether printer is configured
- `restaurants.printer_auto_print` - Auto-print orders on creation
- `restaurants.printer_name` - Printer identifier
- `orders.printed` - Whether order has been printed
- `orders.printed_at` - Print timestamp

**Note:** Printer integration is defined in schema but not yet implemented in the Node.js application.
