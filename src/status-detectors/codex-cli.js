/**
 * CodexCliDetector - Status detection for Codex CLI (OpenAI Codex)
 *
 * Pattern detection based on Codex CLI's terminal output characteristics.
 * Codex CLI is the OpenAI CLI for code generation tasks.
 */

const BaseStatusDetector = require('./base');
const { TerminalStatus } = require('../models/terminal-status');

/**
 * Codex CLI specific patterns
 *
 * These patterns are derived from observing Codex CLI's terminal output.
 */
const CODEX_PATTERNS = {
  /**
   * IDLE: Prompt waiting for input
   * Codex CLI shows prompt when ready for input
   */
  IDLE: /(codex|>)\s*$/i,

  /**
   * PROCESSING: Agent is working
   * Codex CLI shows indicators while processing
   */
  PROCESSING: /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏●○]|Processing|Generating|Thinking|Working/i,

  /**
   * COMPLETED: Response has been delivered
   * Patterns indicating task completion
   */
  COMPLETED: /Complete|Done|Finished|Result:/i,

  /**
   * WAITING_PERMISSION: Needs user approval
   * In full-auto mode, this is bypassed
   * In other modes, asks for confirmation
   */
  WAITING_PERMISSION: /Confirm|Approve|Allow|Continue\?|y\/n|proceed/i,

  /**
   * WAITING_USER_ANSWER: Presenting choices
   * Interactive selection prompts
   */
  WAITING_USER_ANSWER: /Select.*:|Choose.*:|Which.*\?|\[.*\]:/i,

  /**
   * ERROR: Something went wrong
   * Error patterns in Codex CLI output
   */
  ERROR: /\bError\b:|error:|Error:|failed:|FAILED|Exception:|OpenAIError|APIError/i
};

class CodexCliDetector extends BaseStatusDetector {
  constructor() {
    super({
      ...CODEX_PATTERNS,
      tailSize: 2000
    });
    this.name = 'codex-cli';
  }

  /**
   * Enhanced detection for Codex CLI
   */
  detectStatus(output) {
    const tail = this.getTail(output);

    // Check for OpenAI API-specific errors
    if (this.isApiError(tail)) {
      return TerminalStatus.ERROR;
    }

    // Check for token limit issues
    if (this.isTokenLimitError(tail)) {
      return TerminalStatus.ERROR;
    }

    // Fall back to pattern-based detection
    return super.detectStatus(output);
  }

  /**
   * Check if output indicates API error
   */
  isApiError(output) {
    return /OpenAIError|API error|authentication failed|invalid.*key/i.test(output);
  }

  /**
   * Check for token limit errors
   */
  isTokenLimitError(output) {
    return /token.*limit|context.*length|maximum.*tokens/i.test(output);
  }

  /**
   * Extract model being used
   */
  extractModel(output) {
    const match = output.match(/model['":\s]+['"]?([a-zA-Z0-9\-._]+)/i);
    return match ? match[1] : null;
  }

  /**
   * Extract the last response from output
   */
  extractLastResponse(output) {
    // Look for the last output block after a user prompt
    const match = output.match(/>\s*[^\n]+\n([\s\S]+?)(?=>|$)/);
    return match ? match[1].trim() : null;
  }
}

module.exports = CodexCliDetector;
