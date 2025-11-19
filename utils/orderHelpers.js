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
    deliveryInstructions,
    paymentMethod,
    items,
    specialInstructions,
    subtotal,
    deliveryFee,
    taxRate,
    taxAmount,
    totalAmount,
    readyTime,
    restaurantName
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

    if (deliveryInstructions && deliveryInstructions.trim()) {
      ticket += `
• Delivery Instructions: ${deliveryInstructions}`;
    }

    if (paymentMethod) {
      ticket += `
• Payment Method: ${paymentMethod.toUpperCase()}`;
    }
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
• TOTAL: $${(totalAmount || 0).toFixed(2)}

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
 * @param {string} items - Raw items string (e.g., "1x Hamburger - $55.00, 2x Fries - $3.00")
 * @param {number} totalAmount - Total order amount (unused, kept for compatibility)
 * @returns {string} Formatted items list
 */
function formatOrderItems(items, totalAmount) {
  if (!items || typeof items !== 'string') {
    return '• Order details not available';
  }

  // Handle legacy ORDER_CONFIRMED format
  if (items.includes('ORDER_CONFIRMED')) {
    const lines = items.split('\n');
    let formattedItems = '';
    let currentItem = '';

    for (const line of lines) {
      if (line.includes('• ') || line.includes('- ')) {
        if (currentItem) formattedItems += currentItem + '\n';
        currentItem = line.trim();
      } else if (line.trim() && !line.includes('ORDER_') && !line.includes('Customer') && !line.includes('Phone')) {
        currentItem += ' ' + line.trim();
      }
    }
    if (currentItem) formattedItems += currentItem;

    return formattedItems || '• ' + items.replace(/ORDER_CONFIRMED.*?\n/g, '').trim();
  }

  // New format: "1x Hamburger - $55.00, 2x Fries - $3.00"
  // Split by commas or newlines and display each item
  const itemLines = items.split(/[,\n]/).filter(item => item.trim());
  let formattedItems = '';

  itemLines.forEach((item) => {
    const cleanItem = item.trim();
    if (cleanItem) {
      // Don't remove quantity numbers - keep the full format
      formattedItems += `• ${cleanItem}\n`;
    }
  });

  return formattedItems || '• ' + items;
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

  const categories = {};
  menuItems.forEach(item => {
    // Note: available field is already filtered at DB level in edge function
    const categoryName = item.category || 'Other';
    if (!categories[categoryName]) {
      categories[categoryName] = [];
    }

    // Handle new grouped menu structure with sizes array
    if (item.sizes && item.sizes.length > 0) {
      categories[categoryName].push({
        name: item.name,
        description: item.description,
        sizes: item.sizes
      });
    }
  });

  let menuText = `🚨 OFFICIAL RESTAURANT MENU - ALL PRICES ARE CORRECT AS LISTED 🚨
These prices come directly from the restaurant's database and are 100% accurate.
NEVER question or doubt ANY price listed below - they are all correct.

MENU:\n`;
  const sortedCategories = Object.keys(categories).sort();

  sortedCategories.forEach(category => {
    menuText += '\n' + category.toUpperCase() + ':\n';
    categories[category]
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach(item => {
        // Format with sizes and prices
        if (item.sizes.length === 1) {
          // Single size - simple format
          menuText += `- ${item.name}: ${item.description || 'No description'} - $${item.sizes[0].price.toFixed(2)}\n`;
        } else {
          // Multiple sizes - show all options
          menuText += `- ${item.name}: ${item.description || 'No description'}\n`;
          item.sizes.forEach(sizeOption => {
            menuText += `  • ${sizeOption.size}: $${sizeOption.price.toFixed(2)}\n`;
          });
        }
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

  return menuText;
}

module.exports = {
  createOrderTicket,
  formatOrderItems,
  calculateOrderReadyTime,
  formatMenuForAI
};
