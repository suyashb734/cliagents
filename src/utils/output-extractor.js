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

const { getActiveBrokerAdapters } = require('../adapters/active-surface');

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

function findTrackedRunStartMatches(text) {
  const matches = [];
  const pattern = /(?:^|\n)(__CLIAGENTS_RUN_START__([a-f0-9]+))(?=\n|$)/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const fullMarker = match[1];
    const runId = match[2];
    const markerIndex = match.index + match[0].lastIndexOf(fullMarker);
    matches.push({
      runId,
      marker: fullMarker,
      markerIndex
    });
  }
  return matches;
}

/**
 * Isolate the latest tracked tmux one-shot run segment, if present.
 * @param {string} text
 * @returns {string}
 */
function isolateLatestTrackedRun(text) {
  if (!text) return '';

  const startMatches = findTrackedRunStartMatches(text);
  if (startMatches.length === 0) {
    return text;
  }

  const latest = startMatches[startMatches.length - 1];
  const runId = latest.runId;
  const startIndex = latest.markerIndex + latest.marker.length;
  const afterStart = text.slice(startIndex);
  const exitRegex = new RegExp(`(?:^|\\n)(__CLIAGENTS_RUN_EXIT__${runId}__\\d+)(?=\\n|$)`);
  const exitMatch = afterStart.match(exitRegex);

  if (!exitMatch || exitMatch.index == null) {
    return afterStart;
  }

  return afterStart.slice(0, exitMatch.index);
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
      if (output.includes('"type"')) {
        const lines = output.split('\n').map((line) => line.trim()).filter(Boolean);
        const assistantParts = [];
        let finalResult = '';
        let buffer = '';

        for (const line of lines) {
          if (line.startsWith('{') && line.includes('"type"')) {
            buffer = line;
          } else if (buffer) {
            buffer += line;
          } else {
            continue;
          }

          try {
            const event = JSON.parse(buffer);

            if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
              const textParts = event.message.content
                .filter((part) => part?.type === 'text' && part.text)
                .map((part) => String(part.text));
              if (textParts.length > 0) {
                assistantParts.push(textParts.join('\n'));
              }
            }

            if ((event.type === 'result' || event.result) && event.result) {
              finalResult = typeof event.result === 'string'
                ? event.result.trim()
                : JSON.stringify(event.result);
            }

            if (event.type === 'error' && event.error?.message) {
              finalResult = String(event.error.message).trim();
            }

            buffer = '';
          } catch {
            // Keep buffering until the JSON object is complete.
          }
        }

        if (finalResult) {
          return finalResult;
        }

        if (assistantParts.length > 0) {
          const deduped = [];
          for (const part of assistantParts) {
            const normalized = part.trim();
            if (!normalized) continue;
            if (deduped.length > 0 && normalized === deduped[deduped.length - 1]) {
              continue;
            }
            deduped.push(normalized);
          }
          const combined = deduped.join('\n').trim();
          if (combined) {
            return combined;
          }
        }
      }

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
     * Orchestration mode: outputs JSON stream
     */
    extract: (output) => {
      // Check for JSON stream output first (orchestration mode)
      if (output.includes('{"type":')) {
        const lines = output.split('\n');
        let jsonContent = '';
        let foundJson = false;
        let buffer = '';

        for (const line of lines) {
          const trimmed = line.trim();

          // Start of a new JSON object
          if (trimmed.startsWith('{') && trimmed.includes('"type"')) {
            // If we had a previous buffer that didn't parse, discard it (incomplete/broken)
            buffer = trimmed;
          } else if (buffer) {
            // Append to existing buffer if we have one
            // We strip leading whitespace from continuation lines usually caused by wrapping?
            // Actually tmux soft wrap usually doesn't add whitespace, but let's just append.
            buffer += trimmed;
          } else {
            continue;
          }

          // Try to parse the current buffer
          try {
            const msg = JSON.parse(buffer);
            // If we get here, it's valid JSON
            if (msg.type === 'message' && msg.role === 'assistant' && msg.content) {
              jsonContent += msg.content;
              foundJson = true;
            } else if (msg.type === 'result' && msg.response) {
              return msg.response;
            }
            // Reset buffer after successful parse
            buffer = '';
          } catch (e) {
            // Not valid JSON yet, continue buffering
          }
        }

        if (foundJson) {
          return jsonContent;
        }

        const assistantMatches = [
          ...output.matchAll(/"type":"message"[\s\S]*?"role":"assistant"[\s\S]*?"content":"((?:\\.|[^"\\])*)"/g)
        ];
        if (assistantMatches.length > 0) {
          const decoded = assistantMatches
            .map((match) => {
              try {
                return JSON.parse(`"${match[1]}"`);
              } catch {
                return match[1];
              }
            })
            .join('')
            .trim();

          if (decoded) {
            return decoded;
          }
        }
      }

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
      if (output.includes('"thread_id"') || output.includes('"item.completed"')) {
        const lines = output.split('\n').map((line) => line.trim()).filter(Boolean);
        const agentMessages = [];
        let buffer = '';

        for (const line of lines) {
          if (line.startsWith('{') && line.includes('"type"')) {
            buffer = line;
          } else if (buffer) {
            buffer += line;
          } else {
            continue;
          }

          try {
            const event = JSON.parse(buffer);
            if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item?.text) {
              agentMessages.push(event.item.text);
            }
            buffer = '';
          } catch {
            // Keep buffering until the JSON object is complete.
          }
        }

        if (agentMessages.length > 0) {
          return agentMessages.join('\n').trim();
        }
      }

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
  },

  'qwen-cli': {
    /**
     * Extract response from Qwen stream-json output.
     */
    extract: (output) => {
      const lines = output.split('\n').map((line) => line.trim()).filter(Boolean);
      let assistantText = '';
      let finalResult = '';
      let buffer = '';

      for (const line of lines) {
        if (line.startsWith('{') && line.includes('"type"')) {
          buffer = line;
        } else if (buffer) {
          // tmux wrapping can split JSON objects across lines
          buffer += line;
        } else {
          continue;
        }

        try {
          const event = JSON.parse(buffer);

          if (event.type === 'assistant') {
            const parts = event.message?.content || [];
            const textParts = parts
              .filter((part) => part?.type === 'text')
              .map((part) => part.text)
              .filter(Boolean);
            if (textParts.length > 0) {
              assistantText = textParts.join('\n');
            }
          }

          if (event.type === 'result' && event.result) {
            finalResult = String(event.result).trim();
          }

          // reset after successful parse
          buffer = '';
        } catch {
          // keep buffering
        }
      }

      if (finalResult) {
        return finalResult;
      }
      if (assistantText) {
        return assistantText;
      }

      return null;
    },
    stableMarkers: [/qwen>/i, /QWEN_READY_FOR_ORCHESTRATION/],
    runningMarkers: [/thinking/i, /tool_use/i],
    errorMarkers: [/Error:/, /failed/i]
  },

  'opencode-cli': {
    extract: (output) => {
      const lines = output.split('\n').map((line) => line.trim()).filter(Boolean);
      let assistantText = '';
      let buffer = '';

      for (const line of lines) {
        if (line.startsWith('{') && line.includes('"type"')) {
          buffer = line;
        } else if (buffer) {
          buffer += line;
        } else {
          continue;
        }

        try {
          const event = JSON.parse(buffer);
          if (event.type === 'text') {
            const text = event.part?.text || event.text || '';
            if (text) {
              assistantText += text;
            }
          }
          buffer = '';
        } catch {
          // Keep buffering until the JSON object is complete.
        }
      }

      return assistantText || null;
    },
    stableMarkers: [/opencode>/i, /OPENCODE_READY_FOR_ORCHESTRATION/],
    runningMarkers: [/thinking/i, /"type":"(?:step_start|text|progress)"/i],
    errorMarkers: [/Error:/, /"type":"error"/i]
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
 * @param {string} adapter - Adapter name from the active broker surface
 * @param {Object} options - Optional extraction settings
 * @param {boolean} options.stripAnsi - Whether to strip ANSI codes (default: true)
 * @returns {string} - Extracted response content
 */
function extractOutput(rawOutput, adapter, options = {}) {
  if (!rawOutput) return '';

  const { stripAnsi = true } = options;

  // Strip ANSI codes first (terminal output contains raw control sequences)
  let output = stripAnsi ? stripAnsiCodes(rawOutput) : rawOutput;
  output = isolateLatestTrackedRun(output)
    .replace(/__CLIAGENTS_RUN_START__[a-f0-9]+\n?/g, '')
    .replace(/__CLIAGENTS_RUN_EXIT__[a-f0-9]+__\d+\n?/g, '')
    .replace(/__CLIAGENTS_PROVIDER_SESSION__[^\n]+\n?/g, '');

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
  return getActiveBrokerAdapters();
}

module.exports = {
  extractOutput,
  stripAnsiCodes,
  getStatusMarkers,
  getSupportedAdapters,
  ADAPTER_STRATEGIES
};
