/**
 * Unified output extraction utility for CLI agent responses
 *
 * This module consolidates output extraction logic from:
 * - session-manager._extractResponse() - line-based extraction
 * - handoff.extractOutput() - segment-based extraction with ANSI stripping
 *
 * Features:
 * - ANSI code stripping (from handoff.js)
 * - Adapter-specific extraction strategies (merged from both sources)
 * - Fallback filtering for unknown adapters
 */

'use strict';

/**
 * Strip ANSI escape codes from text
 * Handles ESC sequences, CSI sequences, and other terminal control codes
 * @param {string} text - Raw terminal output
 * @returns {string} - Cleaned text without ANSI codes
 */
function stripAnsiCodes(text) {
  if (!text) return '';
  // Match ANSI escape sequences:
  // - \x1b (ESC) followed by [ and parameters ending in a letter
  // - \x1b followed by other sequences (OSC, etc.)
  // - \x9b (CSI) followed by parameters
  return text.replace(/[\x1b\x9b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
}

/**
 * Adapter-specific output extraction strategies
 *
 * Each strategy takes cleaned output and extracts the meaningful response
 * by identifying response markers and filtering status/prompt lines
 */
const ADAPTER_STRATEGIES = {
  'claude-code': {
    /**
     * Extract response from Claude Code output
     * Claude uses markers for responses and separates tool calls
     */
    extract: (output) => {
      // Claude uses ⏺ markers for responses and tool calls
      // If no markers found, return null to use defaultExtract fallback
      if (!output.includes('⏺')) {
        return null;
      }

      // Split by the marker and find the last meaningful response
      const segments = output.split(/⏺\s*/);

      // Find the last segment that's a text response (not a tool call)
      for (let i = segments.length - 1; i >= 0; i--) {
        const segment = segments[i].trim();
        if (!segment) continue;

        // Skip tool call outputs (they start with function names)
        if (/^(Read|Write|Edit|Bash|Glob|Grep|Task|TodoWrite)\s*\(/.test(segment)) {
          continue;
        }

        // Skip segments that are just status lines
        if (/^(✻ Worked for|❯|────)/.test(segment)) {
          continue;
        }

        // Clean up: remove trailing status lines and prompts
        let cleaned = segment
          .replace(/\n*✻ Worked for[^\n]*$/m, '')
          .replace(/\n*────+\n*❯[^]*$/m, '')
          .replace(/\n*❯\s*$/m, '')
          .replace(/\n*⏵⏵[^]*$/m, '')
          .trim();

        if (cleaned) {
          return cleaned;
        }
      }
      return null;
    },
    // Markers indicating stable/idle state
    stableMarkers: [/^╭─/, /^╰─/, /^claude>/, /waiting for input/i],
    // Markers indicating processing state
    runningMarkers: [/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/, /thinking/i, /working/i],
    // Markers indicating error state
    errorMarkers: [/^Error:/, /^✗/, /failed/i]
  },

  'gemini-cli': {
    /**
     * Extract response from Gemini CLI output
     * Gemini shows responses after ✦ marker
     */
    extract: (output) => {
      // If no Gemini markers found, return null to use defaultExtract fallback
      if (!output.includes('✦')) {
        return null;
      }

      const geminiParts = output.split(/✦\s*/);
      for (let i = geminiParts.length - 1; i >= 0; i--) {
        const part = geminiParts[i].trim();
        if (!part) continue;

        // Clean up: remove trailing prompts and status
        let cleaned = part
          .replace(/\n*\d+\s+GEMINI\.md[^]*$/m, '')  // Remove status bar
          .replace(/\n*▀+\n*>[^]*$/m, '')  // Remove prompt line
          .replace(/\n*Type your message[^]*$/m, '')
          .trim();

        if (cleaned) {
          return cleaned;
        }
      }
      return null;
    },
    stableMarkers: [/^gemini>/, /^>/, /Type your message/],
    runningMarkers: [/Thinking\.\.\./, /Generating/],
    errorMarkers: [/Error:/, /API error/]
  },

  'codex-cli': {
    /**
     * Extract response from Codex CLI output
     * Codex uses • for responses but also for status indicators
     */
    extract: (output) => {
      // If no Codex markers found, return null to use defaultExtract fallback
      if (!output.includes('•')) {
        return null;
      }

      const codexParts = output.split(/•\s*/);
      for (let i = codexParts.length - 1; i >= 0; i--) {
        const part = codexParts[i].trim();
        if (!part) continue;

        // Skip status/navigation lines and partial fragments
        if (/^(Working|Explored|Reading|Searching|Thinking|Analyzing)/.test(part)) {
          continue;
        }
        // Skip fragments from status bars
        if (/^(esc to|to interrupt|for shortcuts|\d+% context)/.test(part)) {
          continue;
        }
        // Skip very short fragments that are likely partial status
        if (part.length < 5 && !/^\d+$/.test(part)) {
          continue;
        }

        // Clean up trailing prompts and status bars
        let cleaned = part
          .replace(/\n*─+ Worked for[^]*$/m, '')
          .replace(/\n*›[^]*$/m, '')
          .replace(/\n*context left[^]*$/m, '')
          .replace(/\n*\? for shortcuts[^]*$/m, '')
          .replace(/\n*\(esc to interrupt\)[^]*$/m, '')
          .trim();

        // Accept short responses including single numbers (like "10")
        if (cleaned && cleaned.length > 0) {
          return cleaned;
        }
      }
      return null;
    },
    stableMarkers: [/^›/, /context left/],
    runningMarkers: [/^(Working|Explored|Reading|Searching|Thinking|Analyzing)/],
    errorMarkers: [/Error:/, /failed/i]
  }
};

/**
 * Default fallback extraction when no adapter-specific strategy matches
 * @param {string} output - Cleaned output text
 * @returns {string} - Extracted response
 */
function defaultExtract(output) {
  const lines = output.trim().split('\n');
  const filtered = lines.filter(line => {
    // Skip empty lines and common prompt/status patterns
    if (!line.trim()) return false;
    if (/^(❯|›|>)\s*$/.test(line)) return false;
    if (/^────+$/.test(line)) return false;
    if (/^(✻|⏵⏵)/.test(line)) return false;

    // Skip startup banners and initialization lines
    if (/^╭─/.test(line)) return false;  // Claude input box top
    if (/^╰─/.test(line)) return false;  // Claude input box bottom
    if (/^│/.test(line) && /Type your message/.test(line)) return false;
    if (/Claude Code v\d/.test(line)) return false;  // Version line
    if (/Opus|Sonnet|Haiku/.test(line) && /Claude/.test(line)) return false;  // Model line
    if (/~\//.test(line) && line.length < 60) return false;  // Working dir line
    if (/YOLO mode/i.test(line)) return false;  // Gemini mode
    if (/context left/i.test(line)) return false;  // Context indicator
    if (/esc to (cancel|interrupt)/i.test(line)) return false;

    return true;
  });
  return filtered.slice(-30).join('\n');
}

/**
 * Extract meaningful output from CLI agent response
 *
 * This is the main function to use for output extraction.
 * It handles ANSI stripping and adapter-specific extraction.
 *
 * @param {string} rawOutput - Raw output from terminal/log
 * @param {string} adapter - Adapter name ('claude-code', 'gemini-cli', 'codex-cli')
 * @param {Object} options - Optional extraction settings
 * @param {boolean} options.stripAnsi - Whether to strip ANSI codes (default: true)
 * @returns {string} - Extracted response content
 */
function extractOutput(rawOutput, adapter, options = {}) {
  if (!rawOutput) return '';

  const { stripAnsi = true } = options;

  // Strip ANSI codes first (terminal output contains raw control sequences)
  let output = stripAnsi ? stripAnsiCodes(rawOutput) : rawOutput;

  // Get adapter-specific strategy
  const strategy = ADAPTER_STRATEGIES[adapter];

  if (strategy && strategy.extract) {
    const result = strategy.extract(output);
    if (result) return result;
  }

  // Fallback to default extraction
  return defaultExtract(output);
}

/**
 * Get status markers for an adapter
 * Used by status detectors for hardened pattern matching
 *
 * @param {string} adapter - Adapter name
 * @returns {Object} - Object with stableMarkers, runningMarkers, errorMarkers arrays
 */
function getStatusMarkers(adapter) {
  const strategy = ADAPTER_STRATEGIES[adapter];
  if (!strategy) {
    return {
      stableMarkers: [],
      runningMarkers: [],
      errorMarkers: []
    };
  }
  return {
    stableMarkers: strategy.stableMarkers || [],
    runningMarkers: strategy.runningMarkers || [],
    errorMarkers: strategy.errorMarkers || []
  };
}

/**
 * Get list of supported adapters
 * @returns {string[]} - Array of adapter names
 */
function getSupportedAdapters() {
  return Object.keys(ADAPTER_STRATEGIES);
}

module.exports = {
  extractOutput,
  stripAnsiCodes,
  getStatusMarkers,
  getSupportedAdapters,
  ADAPTER_STRATEGIES
};
