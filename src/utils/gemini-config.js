/**
 * Gemini CLI Configuration Manager
 *
 * Manages the ~/.gemini/config.yaml file for generation parameters.
 * Gemini CLI reads these settings for temperature, top_p, top_k, max_output_tokens.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const GEMINI_CONFIG_DIR = path.join(os.homedir(), '.gemini');
const GEMINI_CONFIG_FILE = path.join(GEMINI_CONFIG_DIR, 'config.yaml');

/**
 * Simple YAML parser for Gemini config (no external dependency)
 * Only handles the simple structure we need
 */
function parseSimpleYaml(content) {
  const result = {};
  let currentSection = null;

  const lines = content.split('\n');
  for (const line of lines) {
    // Skip comments and empty lines
    if (line.trim().startsWith('#') || !line.trim()) continue;

    // Check for section header (no leading spaces, ends with colon)
    if (!line.startsWith(' ') && !line.startsWith('\t') && line.includes(':')) {
      const [key, value] = line.split(':').map(s => s.trim());
      if (!value) {
        currentSection = key;
        result[currentSection] = {};
      } else {
        result[key] = parseValue(value);
      }
    }
    // Check for nested key (has leading spaces)
    else if (currentSection && (line.startsWith(' ') || line.startsWith('\t'))) {
      const trimmed = line.trim();
      if (trimmed.includes(':')) {
        const [key, value] = trimmed.split(':').map(s => s.trim());
        result[currentSection][key] = parseValue(value);
      }
    }
  }

  return result;
}

function parseValue(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '') return null;
  const num = Number(value);
  if (!isNaN(num)) return num;
  return value;
}

/**
 * Generate simple YAML from object
 */
function generateSimpleYaml(obj) {
  let yaml = '';

  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'object' && value !== null) {
      yaml += `${key}:\n`;
      for (const [subKey, subValue] of Object.entries(value)) {
        yaml += `  ${subKey}: ${subValue}\n`;
      }
    } else {
      yaml += `${key}: ${value}\n`;
    }
  }

  return yaml;
}

/**
 * Read current Gemini config
 */
function readGeminiConfig() {
  try {
    if (fs.existsSync(GEMINI_CONFIG_FILE)) {
      const content = fs.readFileSync(GEMINI_CONFIG_FILE, 'utf-8');
      return parseSimpleYaml(content);
    }
  } catch (e) {
    console.warn('[GeminiConfig] Error reading config:', e.message);
  }
  return {};
}

/**
 * Write Gemini config
 */
function writeGeminiConfig(config) {
  try {
    // Ensure directory exists
    if (!fs.existsSync(GEMINI_CONFIG_DIR)) {
      fs.mkdirSync(GEMINI_CONFIG_DIR, { recursive: true });
    }

    const yaml = generateSimpleYaml(config);
    fs.writeFileSync(GEMINI_CONFIG_FILE, yaml, 'utf-8');
    return true;
  } catch (e) {
    console.error('[GeminiConfig] Error writing config:', e.message);
    return false;
  }
}

/**
 * Update generation parameters in Gemini config
 * @param {Object} params - { temperature, top_p, top_k, max_output_tokens }
 */
function updateGenerationParams(params) {
  const config = readGeminiConfig();

  if (!config.generation) {
    config.generation = {};
  }

  // Only update provided params
  if (params.temperature !== undefined) {
    config.generation.temperature = params.temperature;
  }
  if (params.top_p !== undefined) {
    config.generation.top_p = params.top_p;
  }
  if (params.top_k !== undefined) {
    config.generation.top_k = params.top_k;
  }
  if (params.max_output_tokens !== undefined) {
    config.generation.max_output_tokens = params.max_output_tokens;
  }

  return writeGeminiConfig(config);
}

/**
 * Get current generation parameters
 */
function getGenerationParams() {
  const config = readGeminiConfig();
  return config.generation || {};
}

/**
 * Reset generation parameters to defaults
 */
function resetGenerationParams() {
  const config = readGeminiConfig();
  delete config.generation;
  return writeGeminiConfig(config);
}

module.exports = {
  readGeminiConfig,
  writeGeminiConfig,
  updateGenerationParams,
  getGenerationParams,
  resetGenerationParams,
  GEMINI_CONFIG_FILE
};
