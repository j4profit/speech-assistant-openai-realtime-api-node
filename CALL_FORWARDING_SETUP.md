# Call Forwarding Configuration Guide

## Overview

The call forwarding system allows restaurants to transfer specific types of customer calls to staff members. The AI assistant's **primary mission is to take orders** - call forwarding is a **secondary feature** for handling issues, complaints, or special requests.

## Database Configuration

To enable call forwarding for a restaurant, configure these fields in the `restaurants` table:

### Required Fields

```sql
-- Enable/disable call forwarding
call_forwarding_enabled: BOOLEAN (default: false)

-- Phone number to transfer calls to (E.164 format)
call_forwarding_number: VARCHAR (example: '+14105551234')

-- Array of reason codes that trigger call transfer
call_forwarding_reasons: TEXT[] (example: ARRAY['complaint', 'manager_request'])
```

## Valid Reason Codes

⚠️ **CRITICAL:** The `call_forwarding_reasons` array must contain **EXACT reason codes** from the list below. Do NOT use descriptive strings.

### ✅ CORRECT Database Values

```sql
UPDATE restaurants
SET
  call_forwarding_enabled = true,
  call_forwarding_number = '+14105551234',
  call_forwarding_reasons = ARRAY[
    'complaint',
    'manager_request',
    'credit_card_payment'
  ]
WHERE id = 'your-restaurant-id';
```

### ❌ INCORRECT Database Values

```sql
-- DO NOT USE DESCRIPTIVE STRINGS - THESE WILL NOT WORK!
call_forwarding_reasons = ARRAY[
  'Forward calls for complaints',           -- ❌ WRONG
  'Forward calls when customer asks for manager',  -- ❌ WRONG
  'Transfer credit card payments'           -- ❌ WRONG
]
```

## Complete List of Valid Reason Codes

| Reason Code | When AI Detects | Example Customer Statement |
|------------|-----------------|---------------------------|
| `complaint` | Customer unhappy with food, service, or experience | "This food was terrible", "I'm very disappointed" |
| `manager_request` | Customer asks for manager, owner, or "someone in charge" | "I want to speak to the manager", "Let me talk to the owner" |
| `complex_order` | Catering, large parties, special events, bulk orders | "I need to order for 50 people", "We're having a party", "I need catering for an event", "Large corporate order" |
| `technical_issue` | Problems with previous orders or system | "My last order was wrong", "I can't find my order" |
| `billing_question` | Questions about charges, refunds, payments | "Why was I charged twice?", "I need a refund" |
| `custom_request` | Special dietary needs requiring approval | "I have severe allergies", "Can you make this gluten-free?" |
| `refund_request` | Customer wants money back | "I want my money back", "Can I get a refund?" |
| `delivery_issue` | Late delivery, wrong address, missing items | "My order never arrived", "The delivery was wrong" |
| `credit_card_payment` | Customer chooses credit card payment (delivery only) | Handled automatically when customer chooses "credit card" |

## Configuration Examples

### Example 1: Forward Only Critical Issues

```sql
UPDATE restaurants
SET
  call_forwarding_enabled = true,
  call_forwarding_number = '+14105551234',
  call_forwarding_reasons = ARRAY['complaint', 'manager_request', 'refund_request']
WHERE id = 'your-restaurant-id';
```

**Result:** AI will transfer calls for complaints, manager requests, and refund requests. All other issues create customer messages instead.

### Example 2: Forward Credit Card Payments Only

```sql
UPDATE restaurants
SET
  call_forwarding_enabled = true,
  call_forwarding_number = '+14105551234',
  call_forwarding_reasons = ARRAY['credit_card_payment']
WHERE id = 'your-restaurant-id';
```

**Result:** AI will only transfer calls when customer chooses credit card payment for delivery orders. All other issues create customer messages.

### Example 3: Forward Everything Except Technical Issues

```sql
UPDATE restaurants
SET
  call_forwarding_enabled = true,
  call_forwarding_number = '+14105551234',
  call_forwarding_reasons = ARRAY[
    'complaint',
    'manager_request',
    'complex_order',
    'billing_question',
    'custom_request',
    'refund_request',
    'delivery_issue',
    'credit_card_payment'
  ]
WHERE id = 'your-restaurant-id';
```

**Result:** AI will transfer most issues to staff. Only technical issues create customer messages.

### Example 4: Disable Call Forwarding (Messages Only)

```sql
UPDATE restaurants
SET
  call_forwarding_enabled = false,
  call_forwarding_number = NULL,
  call_forwarding_reasons = NULL
WHERE id = 'your-restaurant-id';
```

**Result:** AI will NEVER transfer calls. All issues create customer messages for staff to review later.

## How the System Works

### 1. AI Detects Issue

Customer says: "I want to speak to the manager"

AI detects reason code: `manager_request`

### 2. AI Calls transfer_call Function

```javascript
transfer_call(
  reason: "manager_request",
  customer_message: "Customer requests to speak with manager"
)
```

### 3. System Checks Configuration

```javascript
// Check if call forwarding is enabled
if (restaurant.call_forwarding_enabled === false) {
  return { should_create_message: true }
}

// Check if reason is in the forwarding reasons array
if (!restaurant.call_forwarding_reasons.includes("manager_request")) {
  return { should_create_message: true }
}

// Check if forwarding number is configured
if (!restaurant.call_forwarding_number) {
  return { should_create_message: true }
}

// All checks passed - transfer the call
transferCall(callSid, restaurant.call_forwarding_number)
```

### 4. AI Responds Based on Result

**If call transfers successfully:**
```
AI: "Let me transfer you to our staff."
[Call transfers to restaurant.call_forwarding_number]
```

**If transfer fails or not configured:**
```javascript
// AI receives: { should_create_message: true }
// AI then calls: create_customer_message(...)
AI: "I've saved your message for our staff. They'll call you back at [phone]."
```

## Important Notes

### Primary Mission: Order Taking

The AI's **primary job is taking orders**. Call forwarding should only be used for:
- Actual complaints or problems
- Explicit requests to speak with staff
- Issues that prevent the customer from ordering

Do NOT transfer calls for:
- Normal menu questions
- Asking about hours or location
- General ordering questions
- Payment method clarification

### Credit Card Payment Auto-Transfer

When a customer chooses "credit card" for a delivery order:
1. AI calls `process_payment_method(payment_method="credit card")`
2. System checks if `credit_card_payment` is in `call_forwarding_reasons`
3. If enabled, call is transferred **AFTER** order is created
4. This allows staff to process payment via PCI-compliant terminal

### PCI Compliance

- AI **NEVER** asks for credit card numbers, CVV, or expiration dates
- Only payment method choice ("cash" or "credit card") is recorded
- Actual card processing happens via staff on secure terminal
- This ensures PCI compliance

### Graceful Degradation

The system always has a fallback:
1. If call forwarding fails → Create customer message
2. If forwarding number not configured → Create customer message
3. If reason not in array → Create customer message

This ensures **no customer requests are lost**, even if call forwarding is misconfigured.

## Testing

### Test Call Forwarding

1. Configure a test restaurant with call forwarding enabled
2. Call the restaurant's phone number
3. Say "I want to speak to the manager"
4. Verify call transfers to `call_forwarding_number`

### Test Message Fallback

1. Configure a test restaurant with call forwarding **disabled**
2. Call the restaurant's phone number
3. Say "I have a complaint about my order"
4. Verify AI creates a customer message instead of transferring

### Test Reason Code Filtering

1. Configure: `call_forwarding_reasons = ARRAY['complaint']`
2. Test complaint → Should transfer
3. Test manager request → Should create message (not in array)

## Troubleshooting

### Call Not Transferring

**Check:**
- `call_forwarding_enabled = true`
- `call_forwarding_number` is set (E.164 format: `+14105551234`)
- Reason code is in `call_forwarding_reasons` array
- Reason code is spelled correctly (exact match required)

### Call Transferring Too Much

**Solution:** Remove reason codes from `call_forwarding_reasons` array to reduce transfers

### Messages Not Being Created

**Check:** AI may be trying to transfer instead. Disable call forwarding or remove reason codes from array.

## Special Case: Catering Orders

Many restaurants want to handle catering orders personally due to:
- Large order values requiring verification
- Special timing and delivery coordination
- Custom menu modifications
- Deposit or prepayment requirements
- Detailed planning discussions

### Recommended Catering Configuration

```sql
UPDATE restaurants
SET
  call_forwarding_enabled = true,
  call_forwarding_number = '+14105551234',
  call_forwarding_reasons = ARRAY['complex_order', 'manager_request']
WHERE id = 'your-restaurant-id';
```

### How AI Detects Catering Orders

The AI identifies catering/complex orders when customer mentions:
- "Catering" or "catering order"
- Large quantities: "50 people", "100 guests", "party of 75"
- Corporate events: "office party", "company event", "corporate lunch"
- Special events: "wedding", "birthday party", "graduation"
- Bulk orders: "I need a lot of food", "big order"

### Catering Flow Example

**With call forwarding enabled for `complex_order`:**

```
Customer: "Hi, I need catering for 50 people for a corporate event"

AI: "Let me transfer you to our staff to help with your catering order."
[Call transfers to restaurant.call_forwarding_number]
```

**Without call forwarding for `complex_order`:**

```
Customer: "Hi, I need catering for 50 people for a corporate event"

AI: "I'll save your catering request for our staff. They'll call you back at [phone number] to discuss details."
[AI calls create_customer_message with message about catering request]
```

### Best Practice for Catering

Most restaurants should include `complex_order` in their `call_forwarding_reasons` array to ensure catering orders receive personal attention from staff.

## Summary

✅ **DO:**
- Use exact reason codes from the list above
- Set E.164 format phone numbers (+14105551234)
- Test call forwarding before going live
- Keep `call_forwarding_reasons` focused on critical issues
- Include `complex_order` for restaurants that do catering

❌ **DON'T:**
- Use descriptive strings instead of reason codes
- Forward all call types (defeats purpose of AI order taking)
- Forget to configure `call_forwarding_number` if enabled
- Use invalid phone number formats
- Try to handle catering through AI if you need deposits or custom quotes
