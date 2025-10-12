// State management for call data and pending operations
// Replaces global variables with proper encapsulation

class StateManager {
  constructor() {
    // Store pending call data keyed by CallSid
    this.pendingCallData = new Map();
  }

  /**
   * Store call data for a call
   * @param {string} callSid - Twilio call SID
   * @param {Object} callData - Call information
   */
  storeCallData(callSid, callData) {
    this.pendingCallData.set(callSid, {
      ...callData,
      stored_at: new Date().toISOString()
    });
    console.log('Stored call data for:', callSid, {
      from: callData.from_number,
      to: callData.to_number,
      restaurant_id: callData.restaurant_id
    });
  }

  /**
   * Retrieve call data for a call
   * @param {string} callSid - Twilio call SID
   * @returns {Object|null} Call data or null if not found
   */
  getCallData(callSid) {
    return this.pendingCallData.get(callSid) || null;
  }

  /**
   * Update call data for a call
   * @param {string} callSid - Twilio call SID
   * @param {Object} updates - Fields to update
   * @returns {Object|null} Updated call data or null if not found
   */
  updateCallData(callSid, updates) {
    const existingData = this.pendingCallData.get(callSid);
    if (!existingData) {
      console.warn('Cannot update call data - call not found:', callSid);
      return null;
    }

    const updatedData = {
      ...existingData,
      ...updates,
      updated_at: new Date().toISOString()
    };

    this.pendingCallData.set(callSid, updatedData);
    return updatedData;
  }

  /**
   * Remove call data (call completed)
   * @param {string} callSid - Twilio call SID
   * @returns {Object|null} Removed call data or null if not found
   */
  removeCallData(callSid) {
    const callData = this.pendingCallData.get(callSid);
    if (callData) {
      this.pendingCallData.delete(callSid);
      console.log('Removed call data for:', callSid);
    }
    return callData || null;
  }

  /**
   * Check if call data exists
   * @param {string} callSid - Twilio call SID
   * @returns {boolean} True if call data exists
   */
  hasCallData(callSid) {
    return this.pendingCallData.has(callSid);
  }

  /**
   * Get all pending calls
   * @returns {Array} Array of [callSid, callData] pairs
   */
  getAllPendingCalls() {
    return Array.from(this.pendingCallData.entries());
  }

  /**
   * Clean up old call data (older than specified minutes)
   * @param {number} maxAgeMinutes - Maximum age in minutes (default: 60)
   * @returns {number} Number of records cleaned up
   */
  cleanupOldCalls(maxAgeMinutes = 60) {
    const now = new Date();
    const maxAge = maxAgeMinutes * 60 * 1000; // Convert to milliseconds
    let cleanedCount = 0;

    for (const [callSid, callData] of this.pendingCallData.entries()) {
      const storedAt = new Date(callData.stored_at);
      const age = now - storedAt;

      if (age > maxAge) {
        this.pendingCallData.delete(callSid);
        cleanedCount++;
        console.log('Cleaned up old call data:', callSid, 'Age:', Math.round(age / 60000), 'minutes');
      }
    }

    if (cleanedCount > 0) {
      console.log(`Cleaned up ${cleanedCount} old call records`);
    }

    return cleanedCount;
  }

  /**
   * Get statistics about pending calls
   * @returns {Object} Statistics
   */
  getStats() {
    return {
      total_pending_calls: this.pendingCallData.size,
      oldest_call_age_minutes: this._getOldestCallAge(),
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Get age of oldest pending call in minutes
   * @private
   * @returns {number|null} Age in minutes or null if no pending calls
   */
  _getOldestCallAge() {
    if (this.pendingCallData.size === 0) return null;

    const now = new Date();
    let oldestAge = 0;

    for (const callData of this.pendingCallData.values()) {
      const storedAt = new Date(callData.stored_at);
      const age = now - storedAt;
      if (age > oldestAge) {
        oldestAge = age;
      }
    }

    return Math.round(oldestAge / 60000); // Convert to minutes
  }
}

// Export singleton instance
module.exports = new StateManager();
