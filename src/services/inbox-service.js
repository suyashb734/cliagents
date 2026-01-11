/**
 * InboxService - Message queue for inter-agent communication
 *
 * Manages asynchronous message delivery between terminals.
 * Messages are queued and delivered when the receiver is in IDLE or COMPLETED state.
 */

const { EventEmitter } = require('events');
const { TerminalStatus } = require('../models/terminal-status');

class InboxService extends EventEmitter {
  /**
   * @param {Object} options
   * @param {Object} options.db - Database instance
   * @param {Object} options.sessionManager - PersistentSessionManager instance
   * @param {number} options.pollInterval - Delivery poll interval in ms
   * @param {number} options.maxRetries - Max delivery attempts
   */
  constructor(options = {}) {
    super();

    this.db = options.db;
    this.sessionManager = options.sessionManager;
    this.pollInterval = options.pollInterval || 500;
    this.maxRetries = options.maxRetries || 3;

    this.running = false;
    this.deliveryTimer = null;
  }

  /**
   * Start the delivery loop
   */
  start() {
    if (this.running) return;

    this.running = true;
    this.deliveryTimer = setInterval(() => {
      this.deliverPendingMessages();
    }, this.pollInterval);

    console.log('[InboxService] Started delivery loop');
  }

  /**
   * Stop the delivery loop
   */
  stop() {
    this.running = false;
    if (this.deliveryTimer) {
      clearInterval(this.deliveryTimer);
      this.deliveryTimer = null;
    }
    console.log('[InboxService] Stopped delivery loop');
  }

  /**
   * Queue a message for delivery
   * @param {string} senderId - Sender terminal ID
   * @param {string} receiverId - Receiver terminal ID
   * @param {string} message - Message content
   * @param {number} priority - Message priority (higher = more urgent)
   * @returns {number} - Message ID
   */
  queueMessage(senderId, receiverId, message, priority = 0) {
    // Validate receiver exists
    const receiver = this.sessionManager.getTerminal(receiverId);
    if (!receiver) {
      throw new Error(`Receiver terminal not found: ${receiverId}`);
    }

    // Queue in database
    const messageId = this.db.queueMessage(senderId, receiverId, message, priority);

    // Emit event
    this.emit('message-queued', {
      messageId,
      senderId,
      receiverId,
      priority
    });

    console.log(`[InboxService] Message ${messageId} queued: ${senderId} -> ${receiverId}`);

    return messageId;
  }

  /**
   * Attempt to deliver pending messages
   */
  async deliverPendingMessages() {
    if (!this.db || !this.sessionManager) return;

    try {
      const pending = this.db.getPendingMessages(null, 10);

      for (const msg of pending) {
        await this.attemptDelivery(msg);
      }
    } catch (error) {
      console.error('[InboxService] Delivery loop error:', error.message);
    }
  }

  /**
   * Attempt to deliver a single message
   */
  async attemptDelivery(msg) {
    try {
      // Check receiver status
      const status = this.sessionManager.getStatus(msg.receiver_id);

      // Can only deliver when receiver is IDLE or COMPLETED
      if (status !== TerminalStatus.IDLE && status !== TerminalStatus.COMPLETED) {
        // Not ready, will retry later
        return false;
      }

      // Attempt delivery
      await this.sessionManager.sendInput(msg.receiver_id, msg.message);

      // Mark as delivered
      this.db.markDelivered(msg.id);

      // Emit event
      this.emit('message-delivered', {
        messageId: msg.id,
        senderId: msg.sender_id,
        receiverId: msg.receiver_id
      });

      console.log(`[InboxService] Message ${msg.id} delivered: ${msg.sender_id} -> ${msg.receiver_id}`);
      return true;

    } catch (error) {
      // Increment attempt count
      this.db.incrementAttempt(msg.id);

      // Check if max retries exceeded
      if (msg.attempts + 1 >= this.maxRetries) {
        this.db.markFailed(msg.id, error.message);

        this.emit('message-failed', {
          messageId: msg.id,
          senderId: msg.sender_id,
          receiverId: msg.receiver_id,
          error: error.message
        });

        console.error(`[InboxService] Message ${msg.id} failed after ${msg.attempts + 1} attempts:`, error.message);
      }

      return false;
    }
  }

  /**
   * Get inbox stats for a terminal
   * @param {string} terminalId - Terminal ID
   * @returns {Object} - Stats object
   */
  getStats(terminalId) {
    return this.db.getInboxStats(terminalId);
  }

  /**
   * Get pending messages for a terminal
   * @param {string} terminalId - Terminal ID
   * @param {number} limit - Max messages to return
   * @returns {Array} - Pending messages
   */
  getPendingMessages(terminalId, limit = 10) {
    return this.db.getPendingMessages(terminalId, limit);
  }

  /**
   * Cancel a pending message
   * @param {number} messageId - Message ID
   * @returns {boolean} - Success
   */
  cancelMessage(messageId) {
    try {
      this.db.markFailed(messageId, 'Cancelled');
      this.emit('message-cancelled', { messageId });
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Retry a failed message
   * @param {number} messageId - Message ID
   * @returns {boolean} - Success
   */
  retryMessage(messageId) {
    try {
      const stmt = this.db.db.prepare(`
        UPDATE inbox
        SET status = 'pending', attempts = 0, error = NULL
        WHERE id = ?
      `);
      stmt.run(messageId);

      this.emit('message-retried', { messageId });
      return true;
    } catch (error) {
      return false;
    }
  }
}

module.exports = InboxService;
