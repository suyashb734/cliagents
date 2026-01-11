/**
 * GeminiCliDetector - Status detection for Gemini CLI
 *
 * Pattern detection based on Gemini CLI's terminal output characteristics:
 * - Prompt: `gemini>` or `>`
 * - Processing: Animated indicators while thinking
 * - Response: Text output after processing
 * - Sandbox mode: Runs without confirmations
 */

const BaseStatusDetector = require('./base');
const { TerminalStatus } = require('../models/terminal-status');

/**
 * Gemini CLI specific patterns
 *
 * These patterns are derived from observing Gemini CLI's terminal output.
 * Gemini CLI has different output styles depending on mode.
 */
const GEMINI_PATTERNS = {
  /**
   * IDLE: Prompt waiting for input
   * Gemini CLI shows `gemini>` or similar prompt when ready
   */
  IDLE: /(gemini|>)\s*$/i,

  /**
   * PROCESSING: Agent is working
   * Gemini CLI shows thinking indicators while processing
   * May include spinner characters or "Generating..." text
   */
  PROCESSING: /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]|Generating|Thinking|Loading|\.{3}$/,

  /**
   * COMPLETED: Response has been delivered
   * Look for end of response patterns
   */
  COMPLETED: /^---\s*$|Response complete|Done\s*$/m,

  /**
   * WAITING_PERMISSION: Needs user approval (sandbox mode bypasses this)
   * In non-sandbox mode, may ask for file access
   */
  WAITING_PERMISSION: /Confirm|Approve|Allow|y\/n\s*[\?\:]|proceed\?/i,

  /**
   * WAITING_USER_ANSWER: Presenting choices
   * Interactive prompts for user selection
   */
  WAITING_USER_ANSWER: /Select.*:|Choose.*:|Which.*\?|\[\d+\]|Enter.*:/i,

  /**
   * ERROR: Something went wrong
   * Error messages in Gemini CLI output
   */
  ERROR: /\bError\b:|error:|Error:|failed:|FAILED|Exception:|APIError|RateLimitError/i
};

class GeminiCliDetector extends BaseStatusDetector {
  constructor() {
    super({
      ...GEMINI_PATTERNS,
      tailSize: 2000
    });
    this.name = 'gemini-cli';
  }

  /**
   * Enhanced detection for Gemini CLI
   */
  detectStatus(output) {
    const tail = this.getTail(output);

    // Check for API-specific errors
    if (this.isApiError(tail)) {
      return TerminalStatus.ERROR;
    }

    // Check for rate limiting
    if (this.isRateLimited(tail)) {
      return TerminalStatus.ERROR;
    }

    // Fall back to pattern-based detection
    return super.detectStatus(output);
  }

  /**
   * Check if output indicates API error
   */
  isApiError(output) {
    return /APIError|API error|quota exceeded|authentication/i.test(output);
  }

  /**
   * Check if rate limited
   */
  isRateLimited(output) {
    return /rate.?limit|too many requests|retry after/i.test(output);
  }

  /**
   * Extract model name from output
   */
  extractModel(output) {
    const match = output.match(/model['":\s]+['"]?([a-zA-Z0-9\-._]+)/i);
    return match ? match[1] : null;
  }

  /**
   * Extract the last response from output
   */
  extractLastResponse(output) {
    // Look for content between prompts
    const match = output.match(/gemini>\s*[^\n]+\n([\s\S]+?)(?=gemini>|$)/i);
    return match ? match[1].trim() : null;
  }
}

module.exports = GeminiCliDetector;
