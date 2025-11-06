# Database Schema Documentation

## Overview

This document describes the Supabase database schema for the restaurant ordering system.

**WARNING: This schema is for context only and is not meant to be run.**
**Table order and constraints may not be valid for execution.**

## Tables

### 🏠 customer_delivery_addresses
Cached validated delivery addresses for faster repeat orders (v2.3+).

**Schema:**
```sql
CREATE TABLE public.customer_delivery_addresses (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  restaurant_id uuid NOT NULL,
  customer_phone character varying NOT NULL,
  customer_name character varying NOT NULL,
  delivery_address text NOT NULL,
  formatted_address text,
  is_valid boolean NOT NULL DEFAULT false,
  latitude numeric,
  longitude numeric,
  distance_from_restaurant numeric,
  validation_reason text,
  delivery_instructions text,
  last_used_at timestamp with time zone DEFAULT now(),
  times_used integer DEFAULT 1,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT customer_delivery_addresses_pkey PRIMARY KEY (id),
  CONSTRAINT customer_delivery_addresses_restaurant_fkey FOREIGN KEY (restaurant_id) REFERENCES public.restaurants(id)
);
```

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

**Schema:**
```sql
CREATE TABLE public.restaurants (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  name character varying NOT NULL,
  phone_number character varying NOT NULL UNIQUE,
  description text,
  address text,
  hours text,
  timezone character varying DEFAULT 'America/New_York'::character varying,
  active boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  delivery_enabled boolean DEFAULT false,
  delivery_radius numeric DEFAULT 5.0,
  delivery_hours character varying,
  preparation_time integer DEFAULT 20,
  delivery_time integer DEFAULT 15,
  latitude numeric,
  longitude numeric,
  owner_user_id uuid,
  additional_ai_instructions text,
  tax_rate numeric DEFAULT 0,
  delivery_fee numeric DEFAULT 0,
  ai_voice character varying DEFAULT 'coral'::character varying CHECK (ai_voice::text = ANY (ARRAY['alloy'::character varying::text, 'ash'::character varying::text, 'ballad'::character varying::text, 'coral'::character varying::text, 'echo'::character varying::text, 'sage'::character varying::text, 'shimmer'::character varying::text, 'verse'::character varying::text])),
  specials text,
  printer_enabled boolean DEFAULT false,
  printer_auto_print boolean DEFAULT false,
  printer_name text,
  call_forwarding_enabled boolean DEFAULT false,
  call_forwarding_number character varying,
  call_forwarding_reasons text[],
  CONSTRAINT restaurants_pkey PRIMARY KEY (id),
  CONSTRAINT restaurants_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES auth.users(id)
);
```

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
- `call_forwarding_enabled` - Enable/disable call forwarding (boolean)
- `call_forwarding_number` - Phone number to transfer calls to (E.164 format: +14105551234)
- `call_forwarding_reasons` - Array of reasons that trigger call transfer: ['credit_card_payment', 'complaint', 'manager_request', 'complex_order', 'technical_issue', 'billing_question', 'custom_request', 'refund_request', 'delivery_issue']

**Relationships:**
- Has many: menu_items, orders, call_logs, customer_messages

---

### 🍔 menu_items
Restaurant menu items with pricing and availability.

**Schema:**
```sql
CREATE TABLE public.menu_items (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  restaurant_id uuid,
  category character varying NOT NULL,
  name character varying NOT NULL,
  description text,
  price numeric NOT NULL,
  available boolean DEFAULT true,
  size character varying DEFAULT 0,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT menu_items_pkey PRIMARY KEY (id),
  CONSTRAINT menu_items_restaurant_id_fkey FOREIGN KEY (restaurant_id) REFERENCES public.restaurants(id)
);
```

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

**Schema:**
```sql
CREATE TABLE public.menu_categories (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  restaurant_id uuid,
  name character varying NOT NULL,
  display_order integer DEFAULT 0,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT menu_categories_pkey PRIMARY KEY (id),
  CONSTRAINT menu_categories_restaurant_id_fkey FOREIGN KEY (restaurant_id) REFERENCES public.restaurants(id)
);
```

**Key Fields:**
- `name` - Category name
- `display_order` - Order for displaying categories

**Status:** Currently defined but not actively used by edge functions

---

### 📦 orders
Customer orders placed through the AI system.

**Schema:**
```sql
CREATE TABLE public.orders (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  restaurant_id uuid,
  customer_phone character varying,
  customer_name character varying,
  total_amount numeric DEFAULT 0,
  status character varying DEFAULT 'pending'::character varying,
  order_details text,
  special_instructions text,
  pickup_time timestamp with time zone,
  call_sid character varying,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  order_type character varying DEFAULT 'pickup'::character varying,
  delivery_address text,
  ready_time character varying,
  estimated_ready_at timestamp without time zone,
  printed boolean DEFAULT false,
  printed_at timestamp with time zone,
  delivery_instructions text,
  delivery_address_id uuid,
  payment_method character varying,
  CONSTRAINT orders_pkey PRIMARY KEY (id),
  CONSTRAINT orders_restaurant_id_fkey FOREIGN KEY (restaurant_id) REFERENCES public.restaurants(id),
  CONSTRAINT orders_delivery_address_id_fkey FOREIGN KEY (delivery_address_id) REFERENCES public.customer_delivery_addresses(id)
);
```

**Key Fields:**
- `customer_phone` - Customer's phone number (from Caller ID)
- `customer_name` - Customer's name
- `total_amount` - Total order amount including tax and fees
- `status` - Order status: pending, modified, cancelled, completed, credit_card
- `order_type` - pickup or delivery
- `delivery_address` - Full delivery address (if delivery order)
- `delivery_instructions` - Where to leave delivery: "Front door", "Ring bell", "Side entrance", etc.
- `delivery_address_id` - Foreign key to `customer_delivery_addresses` table (links to cached address record)
- `payment_method` - How customer wants to pay: 'cash', 'credit card', or null for pickup orders
- `order_details` - Detailed order description (text)
- `special_instructions` - Customer notes/modifications
- `call_sid` - Twilio call SID that created this order
- `printed` - Whether order has been printed
- `printed_at` - When order was printed

**Relationships:**
- Belongs to: restaurant, customer_delivery_addresses (optional)
- Referenced by: call_logs

---

### 📞 call_logs
Logs of all incoming calls with transcripts and billing.

**Schema:**
```sql
CREATE TABLE public.call_logs (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  call_sid character varying NOT NULL UNIQUE,
  restaurant_id uuid,
  from_number character varying NOT NULL,
  to_number character varying NOT NULL,
  call_status character varying,
  call_direction character varying,
  caller_country character varying,
  caller_state character varying,
  caller_city character varying,
  caller_zip character varying,
  to_country character varying,
  to_state character varying,
  to_city character varying,
  to_zip character varying,
  call_duration integer,
  call_started_at timestamp with time zone,
  call_ended_at timestamp with time zone,
  twilio_data jsonb,
  conversation_transcript text,
  order_id uuid,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  billing_status text DEFAULT 'pending'::text CHECK (billing_status = ANY (ARRAY['pending'::text, 'billed'::text, 'failed'::text, 'skipped'::text])),
  billing_processed_at timestamp with time zone,
  minutes_billed numeric,
  CONSTRAINT call_logs_pkey PRIMARY KEY (id),
  CONSTRAINT call_logs_restaurant_id_fkey FOREIGN KEY (restaurant_id) REFERENCES public.restaurants(id),
  CONSTRAINT call_logs_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id)
);
```

**Key Fields:**
- `call_sid` (unique) - Twilio call identifier
- `from_number`, `to_number` - Phone numbers
- `call_duration` - Call length in seconds
- `conversation_transcript` - Full AI conversation transcript
- `order_id` - Linked order (if order was created)
- `billing_status` - pending, billed, failed, skipped
- `minutes_billed` - Rounded-up minutes for billing

**Location Data:**
- `caller_city`, `caller_state`, `caller_zip`, `caller_country`
- `to_city`, `to_state`, `to_zip`, `to_country`

**Relationships:**
- Belongs to: restaurant, order (optional)

---

### 💳 restaurant_balances
Prepaid call time balances for each restaurant.

**Schema:**
```sql
CREATE TABLE public.restaurant_balances (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  restaurant_id uuid NOT NULL UNIQUE,
  total_purchased_minutes numeric DEFAULT 0,
  last_updated timestamp with time zone DEFAULT now(),
  low_balance_alert_sent boolean DEFAULT false,
  auto_recharge_enabled boolean DEFAULT false,
  auto_recharge_threshold_seconds integer DEFAULT 3000,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  total_used_minutes numeric DEFAULT 0,
  current_balance_minutes numeric DEFAULT (total_purchased_minutes - total_used_minutes),
  CONSTRAINT restaurant_balances_pkey PRIMARY KEY (id),
  CONSTRAINT restaurant_balances_restaurant_id_fkey FOREIGN KEY (restaurant_id) REFERENCES public.restaurants(id)
);
```

**Key Fields:**
- `restaurant_id` (unique) - One balance per restaurant
- `current_balance_minutes` - Available call time in minutes (computed)
- `total_purchased_minutes` - Lifetime purchased minutes
- `total_used_minutes` - Lifetime used minutes
- `low_balance_alert_sent` - Whether low balance alert has been sent
- `auto_recharge_enabled` - Auto-recharge feature flag
- `auto_recharge_threshold_seconds` - Trigger threshold for auto-recharge (default: 3000s = 50 min)

**Billing Flow:**
1. Call completes
2. `create-call-log` edge function rounds call duration up to next minute
3. Minutes deducted from balance
4. `usage_transaction` record created

---

### 💰 usage_transactions
Ledger of all balance changes (purchases, usage, refunds).

**Schema:**
```sql
CREATE TABLE public.usage_transactions (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  restaurant_id uuid NOT NULL,
  call_log_id uuid,
  transaction_type text NOT NULL CHECK (transaction_type = ANY (ARRAY['purchase'::text, 'usage'::text, 'refund'::text, 'adjustment'::text])),
  seconds_change integer NOT NULL,
  minutes_billed numeric,
  balance_before_seconds integer NOT NULL,
  balance_after_seconds integer NOT NULL,
  call_duration_seconds integer,
  call_sid text,
  stripe_payment_intent_id text,
  stripe_product_id text,
  package_name text,
  amount_paid_cents integer,
  description text,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT usage_transactions_pkey PRIMARY KEY (id),
  CONSTRAINT usage_transactions_restaurant_id_fkey FOREIGN KEY (restaurant_id) REFERENCES public.restaurants(id),
  CONSTRAINT usage_transactions_call_log_id_fkey FOREIGN KEY (call_log_id) REFERENCES public.call_logs(id)
);
```

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

---

### 💬 customer_messages
Customer messages, complaints, and callback requests.

**Schema:**
```sql
CREATE TABLE public.customer_messages (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  restaurant_id uuid,
  customer_phone character varying NOT NULL,
  customer_name character varying,
  message_type character varying DEFAULT 'general'::character varying,
  subject character varying,
  message_content text NOT NULL,
  call_sid character varying,
  order_reference character varying,
  priority character varying DEFAULT 'normal'::character varying,
  status character varying DEFAULT 'new'::character varying,
  staff_response text,
  responded_by character varying,
  responded_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT customer_messages_pkey PRIMARY KEY (id),
  CONSTRAINT customer_messages_restaurant_id_fkey FOREIGN KEY (restaurant_id) REFERENCES public.restaurants(id)
);
```

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

**Schema:**
```sql
CREATE TABLE public.support_tickets (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  restaurant_id uuid NOT NULL,
  subject character varying NOT NULL DEFAULT 'No Subject'::character varying,
  message text NOT NULL DEFAULT ''::text,
  category character varying DEFAULT 'general'::character varying CHECK (category::text = ANY (ARRAY['general'::character varying, 'technical'::character varying, 'billing'::character varying, 'feature_request'::character varying]::text[])),
  priority character varying DEFAULT 'normal'::character varying CHECK (priority::text = ANY (ARRAY['low'::character varying, 'normal'::character varying, 'high'::character varying, 'urgent'::character varying]::text[])),
  status character varying DEFAULT 'open'::character varying CHECK (status::text = ANY (ARRAY['open'::character varying, 'in_progress'::character varying, 'resolved'::character varying, 'closed'::character varying]::text[])),
  restaurant_name character varying,
  restaurant_phone character varying,
  admin_response text,
  admin_name character varying,
  admin_responded_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT support_tickets_pkey PRIMARY KEY (id),
  CONSTRAINT support_tickets_restaurant_id_fkey FOREIGN KEY (restaurant_id) REFERENCES public.restaurants(id)
);
```

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
  ├─ call_logs (1:many) - via order_id
  └─ customer_delivery_addresses (many:1) - via delivery_address_id

call_logs
  └─ usage_transactions (1:many)

customer_delivery_addresses
  ├─ restaurants (many:1) - via restaurant_id
  └─ orders (1:many) - via delivery_address_id
      (one address per customer per restaurant)
```

## Important Constraints

1. **Multi-tenant Isolation**: All queries must filter by `restaurant_id` to prevent data leakage
2. **Phone Number Uniqueness**: `restaurants.phone_number` must be unique (used for routing)
3. **Call SID Uniqueness**: `call_logs.call_sid` must be unique (Twilio identifier)
4. **Balance Relationship**: Each restaurant has exactly one `restaurant_balances` row
5. **Address Uniqueness**: `customer_delivery_addresses` has UNIQUE constraint on `(restaurant_id, customer_phone)` - one address per customer per restaurant
6. **Order-Address Link**: `orders.delivery_address_id` links to cached address record (optional, can be NULL)

## Billing Flow Diagram

```
Call Ends
    ↓
create-call-log Edge Function
    ↓
Calculate: billed_minutes = CEIL(call_duration / 60)
    ↓
Deduct from restaurant_balances.current_balance_minutes
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
