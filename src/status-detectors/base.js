/**
 * BaseStatusDetector - Base class for CLI status detection
 *
 * Subclasses implement adapter-specific pattern matching to determine
 * the current status of a CLI agent from its terminal output.
 */

const { TerminalStatus } = require('../models/terminal-status');

class BaseStatusDetector {
  /**
   * @param {Object} patterns - Regex patterns for each status
   * @param {RegExp} patterns.IDLE - Pattern for idle/ready state
   * @param {RegExp} patterns.PROCESSING - Pattern for processing state
   * @param {RegExp} patterns.COMPLETED - Pattern for completed state
   * @param {RegExp} patterns.WAITING_PERMISSION - Pattern for permission prompts
   * @param {RegExp} patterns.WAITING_USER_ANSWER - Pattern for user questions
   * @param {RegExp} patterns.ERROR - Pattern for error state
   */
  constructor(patterns = {}) {
    this.patterns = {
      IDLE: patterns.IDLE || null,
      PROCESSING: patterns.PROCESSING || null,
      COMPLETED: patterns.COMPLETED || null,
      WAITING_PERMISSION: patterns.WAITING_PERMISSION || null,
      WAITING_USER_ANSWER: patterns.WAITING_USER_ANSWER || null,
      ERROR: patterns.ERROR || null
    };

    // Number of characters from end of output to analyze
    this.tailSize = patterns.tailSize || 2000;
  }

  /**
   * Get the relevant portion of output for analysis
   * @param {string} output - Full terminal output
   * @returns {string} - Tail portion for analysis
   */
  getTail(output) {
    if (!output) return '';
    return output.slice(-this.tailSize);
  }

  /**
   * Detect current status from terminal output
   *
   * Priority order (highest to lowest):
   * 1. ERROR - Something went wrong
   * 2. WAITING_PERMISSION - Needs approval
   * 3. WAITING_USER_ANSWER - Needs user choice
   * 4. PROCESSING - Working on task
   * 5. COMPLETED - Task finished
   * 6. IDLE - Ready for input
   *
   * @param {string} output - Terminal output to analyze
   * @returns {string} - Detected status
   */
  detectStatus(output) {
    const tail = this.getTail(output);

    // Check in priority order
    if (this.patterns.ERROR && this.patterns.ERROR.test(tail)) {
      return TerminalStatus.ERROR;
    }

    if (this.patterns.WAITING_PERMISSION && this.patterns.WAITING_PERMISSION.test(tail)) {
      return TerminalStatus.WAITING_PERMISSION;
    }

    if (this.patterns.WAITING_USER_ANSWER && this.patterns.WAITING_USER_ANSWER.test(tail)) {
      return TerminalStatus.WAITING_USER_ANSWER;
    }

    if (this.patterns.PROCESSING && this.patterns.PROCESSING.test(tail)) {
      return TerminalStatus.PROCESSING;
    }

    if (this.patterns.COMPLETED && this.patterns.COMPLETED.test(tail)) {
      return TerminalStatus.COMPLETED;
    }

    if (this.patterns.IDLE && this.patterns.IDLE.test(tail)) {
      return TerminalStatus.IDLE;
    }

    // Default to processing if we can't determine status
    // This is safer than assuming idle
    return TerminalStatus.PROCESSING;
  }

  /**
   * Check if output matches a specific pattern
   * @param {string} output - Output to check
   * @param {string} patternName - Pattern name (IDLE, PROCESSING, etc.)
   * @returns {boolean}
   */
  matchesPattern(output, patternName) {
    const pattern = this.patterns[patternName];
    if (!pattern) return false;
    return pattern.test(this.getTail(output));
  }

  /**
   * Get all matching patterns for debugging
   * @param {string} output - Output to check
   * @returns {Array<string>} - List of matching pattern names
   */
  getMatchingPatterns(output) {
    const tail = this.getTail(output);
    const matches = [];

    for (const [name, pattern] of Object.entries(this.patterns)) {
      if (pattern && pattern.test(tail)) {
        matches.push(name);
      }
    }

    return matches;
  }

  /**
   * Extract specific content from output using a pattern
   * @param {string} output - Output to search
   * @param {RegExp} pattern - Pattern with capture groups
   * @returns {Array|null} - Capture groups or null
   */
  extractMatch(output, pattern) {
    const tail = this.getTail(output);
    const match = tail.match(pattern);
    return match ? match.slice(1) : null;
  }
}

module.exports = BaseStatusDetector;
