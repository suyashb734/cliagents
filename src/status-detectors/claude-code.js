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
   * Claude Code shows various prompt styles:
   * - `❯` followed by suggestions like `❯ Try "refactor..."` or just `❯`
   * - `>` at end of line (prompt character)
   * - `↵ send` indicator for input mode
   * - Status bar showing "bypass permissions on" (only when truly idle at startup)
   *
   * NOTE: The status bar text "bypass permissions" appears at startup when Claude
   * is truly idle and waiting. During active processing, the spinner replaces the
   * prompt, so this pattern is safe for detecting IDLE state.
   * However, "to cycle)" can appear during processing (in status bar like
   * "(+4 lines) ⌘⏎ to cycle)"), so we don't include that pattern.
   */
  IDLE: /❯\s+(?:Try|$)|[>❯]\s*$|↵ send|bypass permissions on|^CLAUDE_READY_FOR_ORCHESTRATION$/m,

  /**
   * PROCESSING: Agent is working
   * Claude Code shows animated spinners while thinking/working
   * Spinners include: ✶ ✢ ✽ ✻ ✳ and their rotations
   *
   * IMPORTANT: Removed `·` (middle dot) from spinner chars because it appears
   * in the welcome message "Opus 4.5 · Claude Max · tech@..." causing false positives.
   *
   * The pattern requires:
   * - Spinner character followed by whitespace and then text ending in ... or …
   * - Or hourglass ⏳
   * - Or explicit "Thinking..." text
   * - Or "Worked for" time indicator (active processing)
   */
  PROCESSING: /[✶✢✽✻✳⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s+\S.*[.…]|⏳|Thinking\.\.\.|Worked for \d/,

  /**
   * COMPLETED: Response has been delivered
   * Look for response markers or final output patterns
   * The ⏺ marker indicates a response block
   */
  COMPLETED: /⏺\s+|Done\.|Completed\./i,

  /**
   * WAITING_PERMISSION: Needs user approval
   * Claude Code prompts with Allow/Deny/Skip for certain operations
   * IMPORTANT: Must require start-of-line to avoid matching in response content
   * Real permission prompts appear at the start of lines with specific formats
   */
  WAITING_PERMISSION: /^(?:Allow|Deny|Skip|Approve|Reject)\b.*\?|^Permission required\b/mi,

  /**
   * WAITING_USER_ANSWER: Presenting choices
   * Interactive menus with ❯ selector or numbered choices
   * IMPORTANT: Must be specific to avoid matching numbered lists in responses
   * Only match actual interactive choice prompts, not content with numbers
   * Require start-of-line anchor to avoid matching review prose with numbered items
   */
  WAITING_USER_ANSWER: /^\s*❯\s*\d+\.\s+\S|^\s*Select one:|^\s*Choose an option:/mi,

  /**
   * ERROR: Something went wrong
   * Look for error indicators in the output
   * IMPORTANT: Only match errors at START of line to avoid false positives from code content
   * When agents read source files containing "error:" or "failed:", we don't want to detect ERROR
   * Real CLI errors appear at the start of output lines, not embedded in code
   */
  ERROR: /^(?:Error|ERROR)\s*:|^\s*\[?(?:error|ERROR)\]?\s*:|^Traceback/m
};

class ClaudeCodeDetector extends BaseStatusDetector {
  constructor() {
    super({
      ...CLAUDE_PATTERNS,
      tailSize: 2000
    });
    this.name = 'claude-code';
  }

  hasTrailingIdlePrompt(output) {
    const tailLines = String(output || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-6);

    return tailLines.some((line) => (
      /^[>❯]\s*$/u.test(line)
      || line.includes('↵ send')
      || /bypass permissions on/i.test(line)
    ));
  }

  /**
   * Enhanced detection with Claude-specific logic
   */
  detectStatus(output) {
    const tail = this.getTail(output);

    // Claude orchestration workers emit stream-json. Prefer event-driven parsing
    // over generic terminal heuristics so review prose or source snippets do not
    // get misclassified as questions, permissions, or plain processing.
    if (this.isStreamingJson(tail)) {
      const streamJsonStatus = this.detectFromStreamJson(tail);
      if (streamJsonStatus) {
        return streamJsonStatus;
      }
    }

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

    // Managed interactive roots stay at a prompt after a response. Prefer the
    // visible prompt over older completion markers still present in the scrollback.
    if (this.hasTrailingIdlePrompt(tail)) {
      return TerminalStatus.IDLE;
    }

    if (this.patterns.COMPLETED && this.patterns.COMPLETED.test(tail)) {
      return TerminalStatus.COMPLETED;
    }

    if (this.patterns.IDLE && this.patterns.IDLE.test(tail)) {
      return TerminalStatus.IDLE;
    }

    return TerminalStatus.IDLE;
  }

  /**
   * Check if output appears to be streaming JSON
   */
  isStreamingJson(output) {
    const hasTrackedRunMarker = String(output || '').includes('__CLIAGENTS_RUN_START__');
    const lines = String(output || '').split('\n');
    return lines.some((line) => {
      const obj = this._parseStreamJsonLine(line);
      return Boolean(
        obj
        && typeof obj.type === 'string'
        && (hasTrackedRunMarker || typeof obj.session_id === 'string')
      );
    });
  }

  /**
   * Parse a line that may contain a streaming JSON object.
   * Handles both bare JSON objects and multi-line format with embedded JSON.
   * @param {string} line
   * @returns {Object|null}
   */
  _parseStreamJsonLine(line) {
    const trimmed = line.trim();
    if (!trimmed) {
      return null;
    }
    try {
      return JSON.parse(trimmed);
    } catch {
      const match = trimmed.match(/\{.*\}/s);
      if (match) {
        try {
          return JSON.parse(match[0]);
        } catch {
          return null;
        }
      }
      return null;
    }
  }

  /**
   * Detect status from streaming JSON output
   */
  detectFromStreamJson(output) {
    const lines = output.split('\n').reverse();

    for (const line of lines) {
      const obj = this._parseStreamJsonLine(line);
      if (!obj || typeof obj.type !== 'string') {
        continue;
      }

      switch (obj.type) {
        case 'result':
        case 'done':
          return TerminalStatus.COMPLETED;

        case 'thinking':
        case 'tool_use':
        case 'assistant':
        case 'text':
          return TerminalStatus.PROCESSING;

        case 'system':
          // Session metadata alone does not imply the worker is still active.
          continue;

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

    return null;
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
