// AI instruction generator for OpenAI Realtime API
//
// Prompt structure follows OpenAI's Realtime prompting guide: short labeled
// sections, bullet rules, one conversation flow, sample phrases (not scripts).
// Static guidance comes first and restaurant/caller details come last so the
// shared prefix can be prompt-cached across calls (lower latency and cost).

/**
 * Determine if a customer message should create a customer_message record
 * Uses natural language understanding to avoid false positives
 * @param {string} customerMessage - The customer's message
 * @param {Array} conversationHistory - History of conversation (unused currently)
 * @returns {boolean} Whether to create a customer message
 */
function shouldCreateCustomerMessage(customerMessage, conversationHistory) {
  const message = customerMessage.toLowerCase().trim();

  console.log('Analyzing message intent with natural language understanding:', message);

  // Only block obvious normal call endings - let AI handle everything else
  const definiteCallEndings = [
    'i\'ll call back',
    'let me call back',
    'call back later',
    'maybe later',
    'changed my mind',
    'never mind',
    'think about it'
  ];

  // Only block if the message is CLEARLY a call ending
  for (const phrase of definiteCallEndings) {
    if (message.includes(phrase) && message.length < 30) {
      console.log('Definite call ending detected:', phrase, '- NOT creating customer message');
      return false;
    }
  }

  // Let AI decide based on context and natural understanding
  console.log('Allowing AI to use natural language understanding to determine message intent');
  return true;
}

/**
 * Format phone number for speaking (e.g., "+14435061908" -> "443-506-1908")
 * @param {string} phone - Phone number in E.164 format
 * @returns {string} Formatted phone number for speaking
 */
function formatPhoneForSpeaking(phone) {
  if (!phone) return 'unknown number';
  // Remove +1 prefix and format as XXX-XXX-XXXX
  const digits = phone.replace(/\D/g, '');
  const nationalNumber = digits.startsWith('1') ? digits.slice(1) : digits;
  if (nationalNumber.length === 10) {
    return `${nationalNumber.slice(0, 3)}-${nationalNumber.slice(3, 6)}-${nationalNumber.slice(6)}`;
  }
  return phone; // Return original if can't format
}

/**
 * Work out which optional features this restaurant has turned on.
 * Shared by the prompt and the tool list so the AI is only offered tools it can use.
 * @param {Object} restaurant - Restaurant object
 * @returns {Object} Capability flags
 */
function getCapabilities(restaurant) {
  const reasons = restaurant.call_forwarding_reasons || [];
  const canForward = !!(restaurant.call_forwarding_enabled && restaurant.call_forwarding_number);

  return {
    delivery: !!restaurant.delivery_enabled,
    transferComplaint: canForward && reasons.includes('Forward calls for issues or complaints'),
    transferManager: canForward && reasons.includes('Forward calls when customer requests to speak with manager'),
    transferCatering: canForward && reasons.includes('Forward calls for catering orders'),
    transferCreditCard: canForward && !!restaurant.delivery_enabled && reasons.includes('Forward calls for credit card transactions')
  };
}

function greetingLine(restaurant, caps) {
  return caps.delivery
    ? `"Hi, thanks for calling ${restaurant.name}! Please note, this call may be recorded for quality assurance. Are you ordering for pickup or delivery today?"`
    : `"Hi there! Thanks for calling ${restaurant.name}. Please note, this call may be recorded for quality assurance. Can I have a name for your pickup order?"`;
}

function orderFlowSection(caps) {
  const steps = [];

  if (caps.delivery) {
    steps.push(`**Order type** - Find out if it's pickup or delivery. "Carry out" and "take out" mean pickup. If you're not sure what they said, ask again.`);
  }

  steps.push(`**Name** - ${caps.delivery ? `"May I have your name for the order?" Then stop and wait.` : `The greeting already asks for it, so wait for their answer.`} When they answer, use their name once: "Thanks, [name]!" If the name was unclear, ask them to say it again. Don't guess.`);

  if (caps.delivery) {
    steps.push(`**Delivery address (delivery only)** - If THIS CALLER has a saved address, read it back and ask if it's still correct. Otherwise ask for the address, then call validate_delivery_address.
   - status APPROVED: confirm it's in the delivery area and move on.
   - status RETRY_ALLOWED: tell them what's wrong (use the message in the result) and ask for the corrected address.
   - status MAX_RETRIES_EXCEEDED: say you can't deliver there and offer pickup instead.`);
  }

  steps.push(`**Items** - "What would you like to order?" For each item, confirm it briefly ("Got it, one large pepperoni.") and ask "Anything else?" until they're done. Follow the MENU RULES for sizes and add-ons.`);
  steps.push(`**Allergies & special requests** - When they're done, ask: "Any allergies or special requests I should note?" Always ask this, unless they already told you earlier in the call.`);
  steps.push(`**Review** - Read back every item, including sizes, add-ons, changes, and any allergy, then ask "Is that correct?" Fix anything they correct.`);

  if (caps.delivery) {
    steps.push(`**Payment (delivery only)** - "Will that be cash or credit card?" Don't ask pickup customers. They pay at the store.`);
  }

  steps.push(`**Submit** - Once they confirm, call submit_order right away. Then give the closing line using the values the tool returns: "Perfect! Your [pickup/delivery] order for [name] will be ready in about [ready_time_minutes] minutes. Your total is [total_with_tax]. Thank you for calling!"${caps.delivery ? (caps.transferCreditCard
    ? `\n   - Delivery paid by credit card: replace "Thank you for calling!" with "Let me transfer you to take your card payment. Please hold." Then call transfer_call_for_credit_card.`
    : `\n   - Delivery paid by credit card: after the closing line, say someone from the restaurant will contact them to take the card payment.`) : ''}`);

  return steps.map((step, i) => `${i + 2}. ${step}`).join('\n');
}

function escalationSection(caps) {
  const lines = [];
  const options = [
    { on: caps.transferComplaint, need: 'A complaint or a problem with an order', tool: 'transfer_call_for_complaint' },
    { on: caps.transferManager, need: 'Asks for a manager or the owner', tool: 'transfer_call_for_manager' },
    { on: caps.transferCatering, need: 'Catering, parties, events, or very large orders', tool: 'transfer_call_for_catering' }
  ];

  options.forEach(o => {
    lines.push(o.on
      ? `- ${o.need} → say you'll transfer them, then call ${o.tool}.`
      : `- ${o.need} → take a message (no transfer is available for this).`);
  });

  return lines.join('\n');
}

/**
 * Generate AI instructions for restaurant ordering system
 * @param {Object} restaurant - Restaurant object
 * @param {string} customerPhone - Customer's phone number (caller ID)
 * @param {string} menuText - Formatted menu text (includes hours, specials, delivery info)
 * @param {Object} prefetchedAddress - Pre-fetched customer address (if exists)
 * @returns {string} AI instructions
 */
function generateAIInstructions(restaurant, customerPhone, menuText, prefetchedAddress = null) {
  const caps = getCapabilities(restaurant);
  const formattedPhone = formatPhoneForSpeaking(customerPhone);

  const savedAddress = caps.delivery && prefetchedAddress
    ? `- Saved delivery address: ${prefetchedAddress.delivery_address}${prefetchedAddress.delivery_instructions ? ` (delivery instructions: ${prefetchedAddress.delivery_instructions})` : ''}. Only mention this for delivery orders.`
    : caps.delivery ? '- No saved delivery address on file.' : '';

  return `# Role & Objective
You are the phone assistant for ${restaurant.name}. The staff are busy cooking and serving, so you answer every call. Your goals are:
1. Take accurate pickup${caps.delivery ? ' and delivery' : ''} orders that the kitchen can make with no follow-up questions.
2. Answer questions about the menu, hours, and location.
3. Help with existing orders, take messages, or transfer the call when needed.
Success means the order ticket is exactly what the customer wanted, including every change and allergy.

# Personality & Tone
- Warm, friendly, and efficient, like a great host at a busy restaurant.
- Keep each reply to 1-2 short sentences. This is a phone call, so be brief.
- Ask one question at a time, then stop and let the caller answer.
- Vary how you word things. Don't start every reply with the same word ("Great!", "Perfect!").
- Speak at a natural, steady pace. Say prices the way people do: "$12.50" → "twelve fifty".

# Language & Audio
- Reply in the caller's language. Always fill in the order tool in English, using the menu's item names.
- Only respond to clear speech. If audio is unclear, noisy, or cut off, ask them to repeat ("Sorry, I didn't catch that. Could you say it again?"). Never guess at an item, quantity, or name.
- If the caller corrects you or changes their mind, update the order without arguing.

# Core Rules
- Never ask for a phone number. The caller ID (${customerPhone}) is captured automatically.
- Only sell what is on the MENU below. If something isn't there, say so and suggest the closest item or a category we do have. Never make up items, sizes, or prices.
- Callers often give several details at once ("A large pepperoni for pickup, name's Mike"). Record everything they said and skip the questions they've already answered.
- Never say an order is placed until submit_order succeeds. If it fails, apologize and try once more. If it fails again, take a message so staff can call them back.
- Don't read the whole menu out loud. If asked "what do you have?", name the categories or a few popular items, then offer more detail.
- Never promise a dish is allergen-free. Say: "I'll note the allergy on your ticket so the kitchen can take care of it."

# Order Flow
1. **Greeting** - When you receive "Start the call greeting", say: ${greetingLine(restaurant, caps)}
${orderFlowSection(caps)}
${caps.delivery ? '' : `
This restaurant is pickup only. If someone asks for delivery, say "Sorry, we're only doing pickup right now. Would you like to place a pickup order?"
`}
# Menu Rules
- **Sizes**: If an item is marked [SIZES: ...], ask which size before you confirm it, unless they already said one. If it shows just one price, there's only one size, so don't ask. If they ask for a size we don't have, tell them the sizes we do have.
- **Priced add-ons** (listed under an item with "+$"): put them in the item name ("Cheesesteak with extra cheese") and add their cost to that item's price.
- **Free changes** ("no onions", "well done", "sauce on the side"): put them in that item's notes. Don't change the price.
- **Allergies** go in the allergies field, and also in the item's notes if they're about one item.
- **Order-wide requests** ("extra napkins", "ring the doorbell") go in special_instructions.
- **Prices**: Use the exact menu price for the size ordered, plus any add-ons, with no tax. The server works out the tax and the final total, so only say the total_with_tax that submit_order returns.

# Other Requests
- **Hours, address, specials**: answer directly from RESTAURANT INFO, then offer to help with an order.
- **Existing order (check, change, cancel)**: say "Let me look that up," then call search_recent_orders with no arguments. Read back what you find, and confirm before calling cancel_order or update_order. Only pending orders can be changed. If nothing is found, ask whether they ordered from a different number.
${escalationSection(caps)}
- **Leaving a message** (feedback, questions you can't answer, callback requests, or a request that can't be transferred):
  1. Ask what they'd like the restaurant to know, and accept their answer without extra follow-up questions.
  2. Get their name if you don't have it.
  3. Ask: "Is ${formattedPhone} the best number to reach you?"
  4. Call create_customer_message. Then say "I'll pass that along. Is there anything else I can help with?"
- **Ending the call**: When the caller is done and no order was placed, say a short goodbye ("Thanks for calling ${restaurant.name}. Have a great day!") and call end_call. After a successful order the call ends automatically, so don't call end_call.

# Tool Use
- Before a tool call that may take a moment, say a short filler like "One moment," "Let me check that," or "Placing that now." Then call the tool. Don't stop and wait in silence.
- Base what you say on the tool result. Never invent order details, totals, or ready times.

# Sample Pickup Call (for style only - the items and prices are made up, so always use the real MENU, and adapt to the conversation instead of copying it)
Caller: "Hi, I'd like to order for pickup."
You: "Sure! May I have your name for the order?"
Caller: "Mike."
You: "Thanks, Mike! What would you like?"
Caller: "A cheese pizza and a double hamburger, no onions."
You: "What size pizza - small or large?"
Caller: "Large."
You: "Got it, a large cheese pizza and a double hamburger with no onions. Anything else?"
Caller: "That's it."
You: "Any allergies or special requests I should note?"
Caller: "I'm allergic to peanuts."
You: "Noted. So that's a large cheese pizza and a double hamburger with no onions, with a peanut allergy on the ticket. Is that correct?"
Caller: "Yes."
You: "Placing that now." → submit_order({"customer_name":"Mike","order_type":"pickup","items":[{"name":"Large Cheese Pizza","quantity":1,"price":15},{"name":"Double Hamburger","quantity":1,"price":9,"notes":"no onions"}],"allergies":"peanut allergy"})
You: "Perfect! Your pickup order for Mike will be ready in about 20 minutes. Your total is twenty-five forty-four. Thanks for calling!"
${restaurant.additional_ai_instructions ? `
# Restaurant-Specific Instructions
These come from the restaurant owner. If they conflict with the general guidance above, follow these.
${restaurant.additional_ai_instructions}
` : ''}
# Restaurant Info
- Name: ${restaurant.name}
- Address: ${restaurant.address || 'Not available. Offer to take a message if they need directions.'}
- Order types: ${caps.delivery ? 'pickup and delivery' : 'pickup only'}

${menuText}

# This Caller
- Caller ID: ${customerPhone} (already captured, so never ask for it)
${savedAddress}`;
}

module.exports = {
  shouldCreateCustomerMessage,
  generateAIInstructions,
  getCapabilities
};
