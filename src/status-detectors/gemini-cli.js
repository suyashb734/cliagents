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
   * Modern Gemini CLI shows input box with "Type your message" text
   * Also matches legacy `gemini>` prompt and status bar indicators
   * Orchestration mode: matches shell prompts and explicit ready marker
   */
  IDLE: /Type your message|gemini>|\*\s+Type your|^\s*>\s*$|\/model\s*$|^GEMINI_READY_FOR_ORCHESTRATION$|^[\w.-]+@[\w.-]+.*[#$%>]\s*$/m,

  /**
   * PROCESSING: Agent is working
   * Gemini CLI shows spinner characters while processing with whimsical messages.
   * Examples: "⠋ I'm Feeling Lucky", "⠧ Finishing the Kessel Run", "⠹ Formulating a Concise Summary"
   * The key indicator is: spinner + text + "(esc to cancel, Ns)" at line end
   * Also match common action verbs as backup
   * Orchestration mode: matches JSON stream events
   */
  PROCESSING: /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏].*\(esc to cancel|[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s+\S+.*\d+s\)|(?:Considering|Generating|Thinking|Loading|Formulating|Finishing)|^\{"type":"(?:message|progress|tool_use|tool_result|init)"/m,

  /**
   * COMPLETED: Response has been delivered
   * Look for end of response patterns
   * Orchestration mode: matches JSON result/error events
   */
  COMPLETED: /^---\s*$|Response complete|Done\s*$|^\{"type":"(?:result|error)"/m,

  /**
   * WAITING_PERMISSION: Needs user approval (sandbox mode bypasses this)
   * In non-sandbox mode, may ask for file access
   * IMPORTANT: Must require start-of-line to avoid matching "Allow?" in response text
   * Real CLI permission prompts appear at the start of lines
   */
  WAITING_PERMISSION: /^\s*\(y\/n\)|^Allow\s*\?|^Approve\s*\?|^Confirm\s*\?|^proceed\s*\?/mi,

  /**
   * WAITING_USER_ANSWER: Presenting choices
   * Interactive prompts for user selection including:
   * - Trust folder prompts: "Do you trust this folder?"
   * - Choice selections: "Select...", "Choose...", "Which...?"
   * - Numbered choice indicators: "● 1. Trust folder" (bullet + number)
   * IMPORTANT: Must be specific to avoid matching code content
   */
  WAITING_USER_ANSWER: /Do you trust this folder|^(?:Select|Choose).*:\s*$|Which.*\?\s*$|● \d+\.\s+Trust/mi,

  /**
   * ERROR: Something went wrong
   * Error messages in Gemini CLI output
   * IMPORTANT: Only match errors at START of line to avoid false positives from code content
   * When agents read source files containing "error:" or "failed:", we don't want to detect ERROR
   * Real CLI errors appear at the start of output lines, not embedded in code
   * NOTE: APIError and RateLimitError MUST also be start-of-line to avoid matching code content
   */
  ERROR: /^(?:Error|ERROR)\s*:|^(?:error)\s*:|^\s*\[?(?:error|ERROR)\]?\s*:|^APIError|^RateLimitError/m
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

    // ORCHESTRATION FIX:
    // JSON processing messages persist in history, causing false PROCESSING detection.
    // Check for explicit Shell Prompt or JSON Result at the very end of output.
    // This takes precedence over persistent history patterns.
    const lines = tail.trim().split('\n');
    if (lines.length > 0) {
      const lastLine = lines[lines.length - 1];

      // Check for shell prompt at end (Orchestration Idle)
      // Matches: user@host path %
      if (/^[\w.-]+@[\w.-]+.*[#$%>]\s*$/.test(lastLine)) {
        return TerminalStatus.IDLE;
      }

      // Check for JSON result/error at end (Orchestration Completed)
      if (/^\{"type":"(?:result|error)"/.test(lastLine)) {
        return TerminalStatus.COMPLETED;
      }
    }

    // Fall back to pattern-based detection
    return super.detectStatus(output);
  }

  /**
   * Check if output indicates API error
   * IMPORTANT: These patterns must be specific to actual CLI error messages,
   * not generic words that might appear in code being read by agents.
   * For example, "authentication" appears in many codebases but doesn't indicate an error.
   */
  isApiError(output) {
    // Only match actual API error patterns, not generic words
    // These must be at start of line or preceded by error indicators
    return /^(?:APIError|API error|ERROR:.*quota|authentication\s*(?:failed|error|required))/mi.test(output);
  }

  /**
   * Check if rate limited
   * Must match actual rate limit error messages, not variable names like "rate_limit"
   */
  isRateLimited(output) {
    // Only match actual rate limit error messages with context
    return /^(?:rate\s*limit|too many requests|retry after \d)/mi.test(output);
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
