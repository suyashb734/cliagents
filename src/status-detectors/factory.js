/**
 * StatusDetectorFactory - Factory for creating adapter-specific status detectors
 */

const GeminiCliDetector = require('./gemini-cli');
const CodexCliDetector = require('./codex-cli');
const QwenCliDetector = require('./qwen-cli');
const OpencodeCliDetector = require('./opencode-cli');
const ClaudeCodeDetector = require('./claude-code');
const BaseStatusDetector = require('./base');
const { MANAGED_ROOT_ADAPTERS } = require('../adapters/active-surface');

/**
 * Registry of detector classes by adapter name
 */
const DETECTOR_REGISTRY = {
  'gemini-cli': GeminiCliDetector,
  'codex-cli': CodexCliDetector,
  'qwen-cli': QwenCliDetector,
  'opencode-cli': OpencodeCliDetector,
  'claude-code': ClaudeCodeDetector
};

const ACTIVE_DETECTOR_ADAPTERS = [...MANAGED_ROOT_ADAPTERS];

/**
 * Create a status detector for the given adapter
 * @param {string} adapter - Adapter name
 * @returns {BaseStatusDetector} - Status detector instance
 */
function createDetector(adapter) {
  if (!ACTIVE_DETECTOR_ADAPTERS.includes(adapter)) {
    console.warn(`No active status detector for adapter: ${adapter}. Using base detector.`);
    return new BaseStatusDetector();
  }

  const DetectorClass = DETECTOR_REGISTRY[adapter];

  if (!DetectorClass) {
    console.warn(`No status detector for adapter: ${adapter}. Using base detector.`);
    return new BaseStatusDetector();
  }

  return new DetectorClass();
}

/**
 * Get list of supported adapters
 * @returns {Array<string>}
 */
function getSupportedAdapters() {
  return [...ACTIVE_DETECTOR_ADAPTERS];
}

/**
 * Check if an adapter has a dedicated detector
 * @param {string} adapter - Adapter name
 * @returns {boolean}
 */
function hasDetector(adapter) {
  return ACTIVE_DETECTOR_ADAPTERS.includes(adapter);
}

/**
 * Register a custom detector for an adapter
 * @param {string} adapter - Adapter name
 * @param {Class} DetectorClass - Detector class (must extend BaseStatusDetector)
 */
function registerDetector(adapter, DetectorClass) {
  DETECTOR_REGISTRY[adapter] = DetectorClass;
}

/**
 * Create detectors for all supported adapters
 * @returns {Map<string, BaseStatusDetector>}
 */
function createAllDetectors() {
  const detectors = new Map();

  for (const adapter of ACTIVE_DETECTOR_ADAPTERS) {
    detectors.set(adapter, createDetector(adapter));
  }

  return detectors;
}

module.exports = {
  createDetector,
  getSupportedAdapters,
  hasDetector,
  registerDetector,
  createAllDetectors,
  DETECTOR_REGISTRY
};
