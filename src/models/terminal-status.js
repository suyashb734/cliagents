/**
 * Terminal Status Model
 *
 * Defines the 6-state status model for CLI agent terminals.
 * Used for orchestration to determine when agents are ready for input,
 * when they need human intervention, or when they've completed tasks.
 */

const TerminalStatus = {
  /**
   * Terminal is ready for new input.
   * The CLI prompt is waiting for user input.
   */
  IDLE: 'idle',

  /**
   * Terminal is actively processing a request.
   * The agent is thinking, calling tools, or generating output.
   */
  PROCESSING: 'processing',

  /**
   * Terminal has completed processing.
   * The response has been fully generated and displayed.
   * Typically transitions to IDLE shortly after.
   */
  COMPLETED: 'completed',

  /**
   * Terminal is waiting for permission/approval.
   * The agent wants to perform an action that requires user consent.
   * Examples: file modifications, command execution, etc.
   */
  WAITING_PERMISSION: 'waiting_permission',

  /**
   * Terminal is waiting for user to answer a question.
   * The agent has presented choices or asked for clarification.
   */
  WAITING_USER_ANSWER: 'waiting_user_answer',

  /**
   * Terminal encountered an error.
   * Something went wrong during processing.
   */
  ERROR: 'error'
};

/**
 * Status descriptions for logging/display
 */
const StatusDescriptions = {
  [TerminalStatus.IDLE]: 'Ready for input',
  [TerminalStatus.PROCESSING]: 'Processing request',
  [TerminalStatus.COMPLETED]: 'Task completed',
  [TerminalStatus.WAITING_PERMISSION]: 'Awaiting permission',
  [TerminalStatus.WAITING_USER_ANSWER]: 'Awaiting user answer',
  [TerminalStatus.ERROR]: 'Error occurred'
};

/**
 * Check if status indicates terminal is busy
 * @param {string} status - Terminal status
 * @returns {boolean}
 */
function isBusy(status) {
  return status === TerminalStatus.PROCESSING;
}

/**
 * Check if status indicates terminal needs user intervention
 * @param {string} status - Terminal status
 * @returns {boolean}
 */
function needsIntervention(status) {
  return status === TerminalStatus.WAITING_PERMISSION ||
         status === TerminalStatus.WAITING_USER_ANSWER;
}

/**
 * Check if terminal can accept new input
 * @param {string} status - Terminal status
 * @returns {boolean}
 */
function canAcceptInput(status) {
  return status === TerminalStatus.IDLE ||
         status === TerminalStatus.COMPLETED;
}

/**
 * Get valid status values
 * @returns {Array<string>}
 */
function getValidStatuses() {
  return Object.values(TerminalStatus);
}

/**
 * Validate status value
 * @param {string} status - Status to validate
 * @returns {boolean}
 */
function isValidStatus(status) {
  return getValidStatuses().includes(status);
}

module.exports = {
  TerminalStatus,
  StatusDescriptions,
  isBusy,
  needsIntervention,
  canAcceptInput,
  getValidStatuses,
  isValidStatus
};
