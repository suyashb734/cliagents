/**
 * AgentProfiles - Service for loading and managing agent profiles
 *
 * Agent profiles define the configuration for different types of worker agents,
 * including which adapter to use, system prompts, and timeout settings.
 */

const fs = require('fs');
const path = require('path');

class AgentProfilesService {
  /**
   * @param {Object} options
   * @param {string} options.configPath - Path to agent-profiles.json
   */
  constructor(options = {}) {
    this.configPath = options.configPath ||
      path.join(process.cwd(), 'config', 'agent-profiles.json');

    this.profiles = {};
    this.lastModified = 0;

    // Load profiles
    this.reload();
  }

  /**
   * Reload profiles from disk
   */
  reload() {
    try {
      const stats = fs.statSync(this.configPath);

      // Only reload if file has changed
      if (stats.mtimeMs <= this.lastModified) {
        return;
      }

      const content = fs.readFileSync(this.configPath, 'utf8');
      this.profiles = JSON.parse(content);
      this.lastModified = stats.mtimeMs;

      console.log(`[AgentProfiles] Loaded ${Object.keys(this.profiles).length} profiles`);
    } catch (error) {
      if (error.code === 'ENOENT') {
        console.warn('[AgentProfiles] Config file not found, using empty profiles');
        this.profiles = {};
      } else {
        console.error('[AgentProfiles] Error loading profiles:', error.message);
      }
    }
  }

  /**
   * Get a profile by name
   * @param {string} name - Profile name
   * @returns {Object|null} - Profile or null if not found
   */
  getProfile(name) {
    // Auto-reload on access
    this.reload();

    return this.profiles[name] || null;
  }

  /**
   * List all profile names
   * @returns {Array<string>}
   */
  listProfiles() {
    this.reload();
    return Object.keys(this.profiles);
  }

  /**
   * Get all profiles
   * @returns {Object}
   */
  getAllProfiles() {
    this.reload();
    return { ...this.profiles };
  }

  /**
   * Check if a profile exists
   * @param {string} name - Profile name
   * @returns {boolean}
   */
  hasProfile(name) {
    return this.profiles.hasOwnProperty(name);
  }

  /**
   * Get profiles by adapter
   * @param {string} adapter - Adapter name
   * @returns {Object} - Profiles using that adapter
   */
  getProfilesByAdapter(adapter) {
    this.reload();

    const result = {};
    for (const [name, profile] of Object.entries(this.profiles)) {
      if (profile.adapter === adapter) {
        result[name] = profile;
      }
    }
    return result;
  }

  /**
   * Validate a profile has required fields
   * @param {Object} profile - Profile to validate
   * @returns {Object} - { valid: boolean, errors: string[] }
   */
  validateProfile(profile) {
    const errors = [];

    if (!profile.adapter) {
      errors.push('adapter is required');
    }

    if (profile.timeout && typeof profile.timeout !== 'number') {
      errors.push('timeout must be a number');
    }

    if (profile.allowedTools && !Array.isArray(profile.allowedTools)) {
      errors.push('allowedTools must be an array');
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Get profile with defaults applied
   * @param {string} name - Profile name
   * @returns {Object} - Profile with defaults
   */
  getProfileWithDefaults(name) {
    const profile = this.getProfile(name);
    if (!profile) return null;

    return {
      adapter: 'claude-code',
      timeout: 300,
      allowedTools: null,
      systemPrompt: null,
      ...profile
    };
  }
}

// Singleton instance
let instance = null;

/**
 * Get or create the agent profiles service
 */
function getAgentProfiles(options = {}) {
  if (!instance) {
    instance = new AgentProfilesService(options);
  }
  return instance;
}

/**
 * Load a specific profile by name
 */
function loadProfile(name) {
  return getAgentProfiles().getProfile(name);
}

module.exports = {
  AgentProfilesService,
  getAgentProfiles,
  loadProfile
};
