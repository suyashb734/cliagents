/**
 * Status Detectors Module
 *
 * Exports all status detection components for CLI agents.
 */

const BaseStatusDetector = require('./base');
const ClaudeCodeDetector = require('./claude-code');
const GeminiCliDetector = require('./gemini-cli');
const CodexCliDetector = require('./codex-cli');
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

  // Specific detectors
  ClaudeCodeDetector,
  GeminiCliDetector,
  CodexCliDetector,

  // Factory functions
  createDetector,
  getSupportedAdapters,
  hasDetector,
  registerDetector,
  createAllDetectors,
  DETECTOR_REGISTRY
};
