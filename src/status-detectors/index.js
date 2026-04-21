/**
 * Status Detectors Module
 *
 * Exports all status detection components for CLI agents.
 */

const BaseStatusDetector = require('./base');
const GeminiCliDetector = require('./gemini-cli');
const CodexCliDetector = require('./codex-cli');
const QwenCliDetector = require('./qwen-cli');
const OpencodeCliDetector = require('./opencode-cli');
const ClaudeCodeDetector = require('./claude-code');
const {
  createDetector,
  getSupportedAdapters,
  hasDetector,
  registerDetector,
  createAllDetectors,
  DETECTOR_REGISTRY
} = require('./factory');

module.exports = {
  // Base class
  BaseStatusDetector,

  // Specific detectors for the active broker surface
  GeminiCliDetector,
  CodexCliDetector,
  QwenCliDetector,
  OpencodeCliDetector,
  ClaudeCodeDetector,

  // Factory functions
  createDetector,
  getSupportedAdapters,
  hasDetector,
  registerDetector,
  createAllDetectors,
  DETECTOR_REGISTRY
};
