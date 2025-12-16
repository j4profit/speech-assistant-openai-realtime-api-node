// Order-related utility functions

/**
 * Create a formatted order ticket for display
 * @param {Object} orderInfo - Order information
 * @returns {string} Formatted order ticket
 */
function createOrderTicket(orderInfo) {
  const {
    customerName,
    customerPhone,
    orderType,
    deliveryAddress,
    items,
    specialInstructions,
    subtotal,
    deliveryFee,
    taxRate,
    taxAmount,
    totalAmount,
    readyTime,
    restaurantName,
    paymentMethod
  } = orderInfo;

  const timestamp = new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });

  let ticket = `
═══════════════════════════════════════
              ORDER TICKET
═══════════════════════════════════════
Restaurant: ${restaurantName}
Order Time: ${timestamp}

CUSTOMER INFORMATION:
• Name: ${customerName}
• Phone: ${customerPhone}

ORDER TYPE: ${orderType.toUpperCase()}`;

  if (orderType === 'delivery' && deliveryAddress) {
    ticket += `
• Delivery Address: ${deliveryAddress}`;
  }

  ticket += `

ORDER ITEMS:
${formatOrderItems(items, null)}

PRICING BREAKDOWN:
• Subtotal: $${(subtotal || 0).toFixed(2)}`;

  if (deliveryFee && deliveryFee > 0) {
    ticket += `
• Delivery Fee: $${deliveryFee.toFixed(2)}`;
  }

  if (taxAmount && taxAmount > 0) {
    ticket += `
• Tax (${((taxRate || 0) * 100).toFixed(2)}%): $${taxAmount.toFixed(2)}`;
  }

  ticket += `
• TOTAL: $${(totalAmount || 0).toFixed(2)}`;

  if (paymentMethod) {
    ticket += `

PAYMENT METHOD:
• ${paymentMethod.toUpperCase()}`;
  }

  ticket += `

TIMING:
• Order should be ready: ${readyTime}`;

  if (specialInstructions && specialInstructions.trim()) {
    ticket += `

SPECIAL INSTRUCTIONS:
${specialInstructions}`;
  }

  ticket += `

═══════════════════════════════════════
            END ORDER TICKET
═══════════════════════════════════════`;

  return ticket;
}

/**
 * Format order items for display
 * @param {string} items - Raw items string
 * @param {number} totalAmount - Total order amount (unused, kept for compatibility)
 * @returns {string} Formatted items list
 */
function formatOrderItems(items, totalAmount) {
  if (!items || typeof items !== 'string') {
    return '• Order details not available';
  }

  // Split by newlines to handle multi-line format
  const itemLines = items.split('\n').filter(line => line.trim());
  let formattedItems = '';

  itemLines.forEach((item) => {
    const cleanItem = item.trim()
      .replace(/^[-•*]\s*/, '')  // Remove leading bullets/dashes
      .replace(/^\d+\.?\s*/, ''); // Remove leading numbers

    if (cleanItem) {
      formattedItems += `• ${cleanItem}\n`;
    }
  });

  return formattedItems.trim() || '• ' + items;
}

/**
 * Calculate when order will be ready
 * @param {Object} restaurant - Restaurant object with timing info
 * @param {boolean} isDelivery - Whether this is a delivery order
 * @returns {Object} Ready time information
 */
function calculateOrderReadyTime(restaurant, isDelivery = false) {
  try {
    const now = new Date();

    let preparationMinutes = restaurant?.preparation_time || 20;
    if (preparationMinutes > 120) {
      console.log('Unreasonable preparation_time detected:', preparationMinutes, 'minutes - using default 20');
      preparationMinutes = 20;
    }

    let deliveryAddedMinutes = 0;
    if (isDelivery && restaurant?.delivery_enabled) {
      deliveryAddedMinutes = restaurant?.delivery_time || 15;
      if (deliveryAddedMinutes > 60) {
        console.log('Unreasonable delivery_time detected:', deliveryAddedMinutes, 'minutes - using default 15');
        deliveryAddedMinutes = 15;
      }
    }

    const totalMinutes = preparationMinutes + deliveryAddedMinutes;
    const readyTime = new Date(now.getTime() + totalMinutes * 60000);

    console.log('Ready time calculation debug:', {
      currentTime: now.toLocaleString('en-US', { timeZone: 'America/New_York' }),
      preparationMinutes,
      deliveryMinutes: deliveryAddedMinutes,
      totalMinutes,
      isDelivery,
      restaurantPrepTime: restaurant?.preparation_time,
      restaurantDeliveryTime: restaurant?.delivery_time,
      calculatedReadyTime: readyTime.toLocaleString('en-US', { timeZone: 'America/New_York' })
    });

    const timeInEastern = readyTime.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });

    return {
      readyTime: readyTime,
      readyTimeString: timeInEastern,
      preparationMinutes,
      deliveryMinutes: deliveryAddedMinutes,
      totalMinutes
    };

  } catch (error) {
    console.error('Error calculating ready time:', error);
    return {
      readyTimeString: '30 minutes',
      totalMinutes: 30
    };
  }
}

/**
 * Format menu items for AI consumption
 * @param {Array} menuItems - Array of menu items
 * @param {Object} restaurant - Restaurant object
 * @returns {string} Formatted menu text
 */
function formatMenuForAI(menuItems, restaurant) {
  if (!menuItems || menuItems.length === 0) {
    return "No menu items available.";
  }

  // Debug: Log raw menu items to see their structure
  console.log('=== formatMenuForAI DEBUG START ===');
  console.log('Raw menu items count:', menuItems.length);

  // Check specifically for Margherita Pizza
  const margherita = menuItems.find(item => item.name && item.name.toLowerCase().includes('margherita'));
  if (margherita) {
    console.log('*** MARGHERITA FOUND:', JSON.stringify(margherita, null, 2));
  } else {
    console.log('*** MARGHERITA NOT FOUND in menu items');
  }

  const categories = {};

  // First, group items by category and name to handle size variants
  const groupedItems = {};
  menuItems.forEach(item => {
    if (item.available === false) return; // Skip explicitly unavailable items

    const categoryName = item.category || 'Other';
    const itemKey = `${categoryName}::${item.name}`;

    if (!groupedItems[itemKey]) {
      groupedItems[itemKey] = {
        category: categoryName,
        name: item.name,
        description: item.description,
        variants: []
      };
    }

    // Handle nested sizes array (from database) OR flat size/price (legacy format)
    if (item.sizes && Array.isArray(item.sizes)) {
      // Database format: item has sizes array with multiple variants
      console.log(`🔍 Processing sizes array for ${item.name}: ${item.sizes.length} sizes found`);
      item.sizes.forEach((sizeVariant, idx) => {
        console.log(`  ➡️ Adding size ${idx + 1}: ${sizeVariant.size} @ $${sizeVariant.price}`);
        groupedItems[itemKey].variants.push({
          size: sizeVariant.size || null,
          price: sizeVariant.price,
          id: sizeVariant.id || item.id
        });
      });
    } else {
      // Legacy flat format: item has single size/price
      console.log(`🔍 Processing legacy format for ${item.name}: size=${item.size}, price=${item.price}`);
      groupedItems[itemKey].variants.push({
        size: item.size || null,
        price: item.price,
        id: item.id
      });
    }
  });

  // Debug: Log grouped items to see variant counts
  console.log('📋 formatMenuForAI - Grouped items with variants:');
  Object.entries(groupedItems).forEach(([key, item]) => {
    console.log(`  📌 ${item.name}: ${item.variants.length} variant(s) ->`,
      item.variants.map(v => `${v.size || 'no-size'}: $${v.price}`).join(', '));
  });

  // Now format grouped items into categories
  Object.values(groupedItems).forEach(groupedItem => {
    const categoryName = groupedItem.category;
    if (!categories[categoryName]) {
      categories[categoryName] = [];
    }

    // Determine price display based on variants
    let priceDisplay;
    if (groupedItem.variants.length === 1) {
      // Single variant - show simple price WITHOUT size (to avoid AI asking for size)
      const variant = groupedItem.variants[0];
      priceDisplay = `$${variant.price}`;
    } else {
      // Multiple variants - show all sizes and prices
      priceDisplay = groupedItem.variants
        .map(v => v.size ? `${v.size}: $${v.price}` : `$${v.price}`)
        .join(', ');
    }

    // Debug: Log items with multiple sizes to verify price display
    if (groupedItem.variants.length > 1) {
      console.log(`📋 MULTI-SIZE ITEM: ${groupedItem.name} -> priceDisplay: "${priceDisplay}"`);
    }

    categories[categoryName].push({
      name: groupedItem.name,
      description: groupedItem.description,
      priceDisplay: priceDisplay,
      variants: groupedItem.variants
    });
  });

  let menuText = "MENU:\n";
  const sortedCategories = Object.keys(categories).sort();

  sortedCategories.forEach(category => {
    menuText += '\n' + category.toUpperCase() + ':\n';
    categories[category]
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach(item => {
        menuText += `- ${item.name}: ${item.description || 'No description'} - ${item.priceDisplay}\n`;
      });
  });

  if (restaurant) {
    // Add specials if available
    if (restaurant.specials && restaurant.specials.trim()) {
      menuText += '\n\n🌟 CURRENT SPECIALS:\n';
      menuText += `${restaurant.specials}\n`;
      menuText += '\nIMPORTANT: Mention these specials to customers when they ask what\'s available or if they\'re interested in deals!\n';
    }

    // Add operating hours if available
    if (restaurant.hours) {
      menuText += '\n\nRESTAURANT HOURS:\n';
      menuText += `${restaurant.hours}\n`;
    }

    menuText += '\n\nPRICING INFORMATION:\n';
    if (restaurant.tax_rate && restaurant.tax_rate > 0) {
      menuText += `- Tax Rate: ${(restaurant.tax_rate * 100).toFixed(2)}% (applied to all orders)\n`;
    } else {
      menuText += `- No tax applied\n`;
    }

    menuText += '\n\nDELIVERY INFORMATION:\n';
    menuText += `- Delivery Available: ${restaurant.delivery_enabled ? 'Yes' : 'No'}\n`;
    if (restaurant.delivery_enabled) {
      menuText += `- Delivery Hours: ${restaurant.delivery_hours || 'Same as restaurant hours'}\n`;
      menuText += `- Delivery Radius: ${restaurant.delivery_radius || 'Contact restaurant'} miles\n`;
      menuText += `- Estimated Delivery Time: ${(restaurant.preparation_time || 20) + (restaurant.delivery_time || 15)} minutes\n`;
      if (restaurant.delivery_fee && restaurant.delivery_fee > 0) {
        menuText += `- Delivery Fee: $${restaurant.delivery_fee.toFixed(2)} (added to delivery orders)\n`;
      } else {
        menuText += `- No delivery fee\n`;
      }
    } else {
      menuText += '- Pickup Only\n';
    }
  }

  // Debug: Log final menu text (first 500 chars)
  console.log('📋 formatMenuForAI - Final menu text preview (first 500 chars):\n', menuText.substring(0, 500));

  return menuText;
}

module.exports = {
  createOrderTicket,
  formatOrderItems,
  calculateOrderReadyTime,
  formatMenuForAI
};
