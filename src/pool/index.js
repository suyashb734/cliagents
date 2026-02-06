/**
 * Pool Module
 *
 * Provides warm agent pooling and file-based output protocol for
 * reliable, fast multi-agent orchestration.
 */

const { WarmPool, DEFAULT_CONFIG } = require('./warm-pool');
const {
  FileOutputManager,
  enhanceSystemPromptWithFileOutput,
  getFileOutputManager,
  BASE_DIR
} = require('./file-output-protocol');

module.exports = {
  // Warm Pool
  WarmPool,
  DEFAULT_CONFIG,

  // File Output Protocol
  FileOutputManager,
  enhanceSystemPromptWithFileOutput,
  getFileOutputManager,
  FILE_OUTPUT_BASE_DIR: BASE_DIR
};
