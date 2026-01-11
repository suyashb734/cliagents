/**
 * send_message() - Inter-agent communication
 *
 * Queues a message for delivery to another terminal.
 * The message is delivered when the receiver is IDLE or COMPLETED.
 */

/**
 * Send a message to another terminal
 *
 * @param {string} senderId - Sender terminal ID
 * @param {string} receiverId - Receiver terminal ID
 * @param {string} message - Message content
 * @param {Object} options - Additional options
 * @param {number} options.priority - Message priority (higher = more urgent)
 * @param {Object} options.context - Shared context (inboxService, db, etc.)
 * @returns {Object} - Message info
 */
async function sendMessage(senderId, receiverId, message, options = {}) {
  const {
    priority = 0,
    context = {}
  } = options;

  const { inboxService, sessionManager, db } = context;

  if (!inboxService) {
    throw new Error('inboxService is required in context');
  }

  // Validate sender exists (optional - might be external)
  if (sessionManager && senderId) {
    const sender = sessionManager.getTerminal(senderId);
    if (!sender) {
      console.warn(`[send_message] Sender ${senderId} not found (may be external)`);
    }
  }

  // Validate receiver exists
  if (sessionManager) {
    const receiver = sessionManager.getTerminal(receiverId);
    if (!receiver) {
      throw new Error(`Receiver terminal not found: ${receiverId}`);
    }
  }

  // Queue the message
  const messageId = inboxService.queueMessage(senderId, receiverId, message, priority);

  // Log to trace if available
  if (db && senderId) {
    // Find active trace for sender
    const senderTerminal = sessionManager?.getTerminal(senderId);
    if (senderTerminal) {
      // This is a simplified approach - real implementation might track differently
      console.log(`[send_message] Message ${messageId} queued: ${senderId} -> ${receiverId}`);
    }
  }

  return {
    success: true,
    messageId,
    senderId,
    receiverId,
    priority,
    status: 'queued'
  };
}

/**
 * Broadcast a message to multiple terminals
 *
 * @param {string} senderId - Sender terminal ID
 * @param {Array<string>} receiverIds - List of receiver terminal IDs
 * @param {string} message - Message content
 * @param {Object} options - Additional options
 * @returns {Object} - Broadcast result
 */
async function broadcastMessage(senderId, receiverIds, message, options = {}) {
  const results = [];
  const errors = [];

  for (const receiverId of receiverIds) {
    try {
      const result = await sendMessage(senderId, receiverId, message, options);
      results.push(result);
    } catch (error) {
      errors.push({
        receiverId,
        error: error.message
      });
    }
  }

  return {
    success: errors.length === 0,
    sent: results.length,
    failed: errors.length,
    results,
    errors
  };
}

/**
 * Send a high-priority message (cuts to front of queue)
 */
async function sendUrgentMessage(senderId, receiverId, message, options = {}) {
  return sendMessage(senderId, receiverId, message, {
    ...options,
    priority: 100 // High priority
  });
}

module.exports = {
  sendMessage,
  broadcastMessage,
  sendUrgentMessage
};
