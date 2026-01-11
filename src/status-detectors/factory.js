/**
 * StatusDetectorFactory - Factory for creating adapter-specific status detectors
 */

const ClaudeCodeDetector = require('./claude-code');
const GeminiCliDetector = require('./gemini-cli');
const CodexCliDetector = require('./codex-cli');
const BaseStatusDetector = require('./base');

/**
 * Registry of detector classes by adapter name
 */
const DETECTOR_REGISTRY = {
  'claude-code': ClaudeCodeDetector,
  'gemini-cli': GeminiCliDetector,
  'codex-cli': CodexCliDetector
};

/**
 * Create a status detector for the given adapter
 * @param {string} adapter - Adapter name
 * @returns {BaseStatusDetector} - Status detector instance
 */
function createDetector(adapter) {
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
  return Object.keys(DETECTOR_REGISTRY);
}

/**
 * Check if an adapter has a dedicated detector
 * @param {string} adapter - Adapter name
 * @returns {boolean}
 */
function hasDetector(adapter) {
  return adapter in DETECTOR_REGISTRY;
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

  for (const adapter of Object.keys(DETECTOR_REGISTRY)) {
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
