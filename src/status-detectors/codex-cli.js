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
   * Modern Codex CLI shows:
   * - `›` prompt character (not regular `>`) at start of line followed by space
   * - "context left" status bar
   * - "? for shortcuts" indicator
   * IMPORTANT: `› 1.` is a selection prompt, NOT idle. Only match `› ` followed by space or empty.
   */
  IDLE: /context left|^›\s*$|\? for shortcuts/m,

  /**
   * PROCESSING: Agent is working
   * Codex CLI shows spinners while actively processing
   * Also matches status lines that indicate active work
   * IMPORTANT: Only match spinner characters or active status indicators
   * NOTE: Don't match • (bullet) alone - it's used for both status AND response output
   * The bullet is only matched when followed by action words (not response content)
   */
  PROCESSING: /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]|• (?:Working|Explored|Reading|Searching|Thinking|Analyzing|Identifying|I'm preparing|preparing|implementing|processing|Whirring)/i,

  /**
   * COMPLETED: Response has been delivered
   * Patterns indicating task completion
   * Includes "Worked for Xs" timing line that appears after response
   */
  COMPLETED: /─ Worked for \d+/i,

  /**
   * WAITING_PERMISSION: Needs user approval
   * In full-auto mode, this is bypassed
   * In other modes, asks for confirmation
   * IMPORTANT: Must require start-of-line to avoid matching "Allow?" in response text
   * Real CLI permission prompts appear at the start of lines
   */
  WAITING_PERMISSION: /^(?:Confirm|Approve|Allow|Continue)\s*\?|^\s*\(y\/n\)|^proceed\s*\?/mi,

  /**
   * WAITING_USER_ANSWER: Presenting choices
   * Interactive selection prompts
   * IMPORTANT: Must be specific to avoid matching code content or markdown
   * Only match actual CLI selection prompts
   * Includes rate limit model switch prompts and update prompts
   */
  WAITING_USER_ANSWER: /^(?:Select|Choose).*:\s*$|Which.*\?\s*$|Press enter to (?:confirm|continue)|Switch to.*model|Skip until next version|Update available/mi,

  /**
   * ERROR: Something went wrong
   * Error patterns in Codex CLI output
   * IMPORTANT: Only match errors at START of line to avoid false positives from code content
   * When agents read source files containing "error:" or "failed:", we don't want to detect ERROR
   * Real CLI errors appear at the start of output lines, not embedded in code
   * NOTE: OpenAIError and APIError MUST also be start-of-line to avoid matching code content
   * Also matches usage limit blocks (■ You've hit your usage limit)
   */
  ERROR: /^(?:Error|ERROR)\s*:|^\s*\[?(?:error|ERROR)\]?\s*:|^OpenAIError|^APIError|^■ You've hit your usage limit/m
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
   * IMPORTANT: These patterns must be specific to actual CLI error messages,
   * not generic words that might appear in code being read by agents.
   * Must be at start of line or in clear error context.
   */
  isApiError(output) {
    // Only match actual API error patterns at start of line
    return /^(?:OpenAIError|API error|authentication failed|ERROR:.*invalid.*key)/mi.test(output);
  }

  /**
   * Check for token limit errors
   * Must match actual CLI error messages, not variable names or comments
   */
  isTokenLimitError(output) {
    // Only match actual error messages about token limits at start of line
    return /^(?:Error:.*token|Error:.*context.*length|maximum.*tokens.*exceeded)/mi.test(output);
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
