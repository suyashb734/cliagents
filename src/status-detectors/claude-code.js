/**
 * ClaudeCodeDetector - Status detection for Claude Code CLI
 *
 * Pattern detection based on Claude Code's terminal output characteristics:
 * - Prompt: `>`
 * - Spinner: Unicode spinners (✶✢✽✻·✳) with "..." or task description
 * - Response: Starts with bullet markers (⏺) or content blocks
 * - Permission: "Allow", "Deny", "Skip" prompts
 * - Questions: Interactive choice menus with ❯
 */

const BaseStatusDetector = require('./base');
const { TerminalStatus } = require('../models/terminal-status');

/**
 * Claude Code specific patterns
 *
 * These patterns are derived from observing Claude Code's terminal output.
 * They may need adjustment based on version or configuration.
 */
const CLAUDE_PATTERNS = {
  /**
   * IDLE: Prompt waiting for input
   * Claude Code shows a `>` prompt when ready for input
   * Also matches when at the end of a response with empty prompt
   */
  IDLE: />\s*$/,

  /**
   * PROCESSING: Agent is working
   * Claude Code shows animated spinners while thinking/working
   * Spinners include: ✶ ✢ ✽ ✻ · ✳ and their rotations
   * Also matches "Thinking..." or tool execution indicators
   */
  PROCESSING: /[✶✢✽✻·✳⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏].*[.…]|Thinking\.\.\.|⏳|Running|Executing/,

  /**
   * COMPLETED: Response has been delivered
   * Look for response markers or final output patterns
   * The ⏺ marker indicates a response block
   */
  COMPLETED: /⏺\s+|Done\.|Completed\.|finished/i,

  /**
   * WAITING_PERMISSION: Needs user approval
   * Claude Code prompts with Allow/Deny/Skip for certain operations
   * Also handles tool approval prompts
   */
  WAITING_PERMISSION: /\b(Allow|Deny|Skip|Approve|Reject)\b.*\?|Do you want to|Permission required/i,

  /**
   * WAITING_USER_ANSWER: Presenting choices
   * Interactive menus with ❯ selector or numbered choices
   * Also handles yes/no questions
   */
  WAITING_USER_ANSWER: /❯.*\d+\.|Select.*:|Choose.*:|Which.*\?|^\s*\d+\.\s+/m,

  /**
   * ERROR: Something went wrong
   * Look for error indicators in the output
   */
  ERROR: /\bError\b:|error:|Error:|failed:|FAILED|Exception:|Traceback/i
};

class ClaudeCodeDetector extends BaseStatusDetector {
  constructor() {
    super({
      ...CLAUDE_PATTERNS,
      tailSize: 2000
    });
    this.name = 'claude-code';
  }

  /**
   * Enhanced detection with Claude-specific logic
   */
  detectStatus(output) {
    const tail = this.getTail(output);

    // Check for streaming JSON output format
    // Claude Code with --output-format stream-json outputs JSON objects
    if (this.isStreamingJson(tail)) {
      return this.detectFromStreamJson(tail);
    }

    // Fall back to pattern-based detection
    return super.detectStatus(output);
  }

  /**
   * Check if output appears to be streaming JSON
   */
  isStreamingJson(output) {
    return output.includes('"type":') && output.includes('"content"');
  }

  /**
   * Detect status from streaming JSON output
   */
  detectFromStreamJson(output) {
    // Look for the last JSON object
    const lines = output.split('\n').reverse();

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        // Try to find a JSON object in the line
        const jsonMatch = line.match(/\{[^{}]*"type"[^{}]*\}/);
        if (jsonMatch) {
          const obj = JSON.parse(jsonMatch[0]);

          // Determine status from event type
          switch (obj.type) {
            case 'result':
            case 'done':
              return TerminalStatus.COMPLETED;

            case 'thinking':
            case 'tool_use':
            case 'text':
              return TerminalStatus.PROCESSING;

            case 'error':
              return TerminalStatus.ERROR;

            case 'permission':
            case 'approval':
              return TerminalStatus.WAITING_PERMISSION;

            case 'input':
            case 'question':
              return TerminalStatus.WAITING_USER_ANSWER;
          }
        }
      } catch (e) {
        // Not valid JSON, continue to next line
      }
    }

    // If we found JSON but couldn't determine status, assume processing
    return TerminalStatus.PROCESSING;
  }

  /**
   * Extract the session ID from Claude's output
   */
  extractSessionId(output) {
    const match = output.match(/session[_-]?id['":\s]+['"]?([a-zA-Z0-9_-]+)/i);
    return match ? match[1] : null;
  }

  /**
   * Extract cost information from output
   */
  extractCost(output) {
    const match = output.match(/cost['":\s]+\$?([\d.]+)/i);
    return match ? parseFloat(match[1]) : null;
  }

  /**
   * Extract the last response text from output
   */
  extractLastResponse(output) {
    // Look for the last content block
    const match = output.match(/⏺\s+([^\n]+(?:\n(?!⏺)[^\n]+)*)/);
    return match ? match[1].trim() : null;
  }
}

module.exports = ClaudeCodeDetector;
