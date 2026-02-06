/**
 * AgentProfiles - Service for loading and managing agent profiles
 *
 * Agent profiles define the configuration for different types of worker agents,
 * including which adapter to use, system prompts, and timeout settings.
 *
 * Config v3 separates roles from adapters:
 * - roles: Define WHAT to do (systemPrompt, timeout, defaultAdapter)
 * - adapters: Define WHO does it (capabilities, tools)
 * - legacyProfiles: Backward compatibility mapping
 *
 * A profile is a resolved combination of role + adapter.
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
    this.rawConfig = null;  // Store raw config for role+adapter lookups
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
      const config = JSON.parse(content);

      // Check if this is v3 format (has roles and adapters sections)
      if (config.roles && config.adapters) {
        this.rawConfig = config;
        this.profiles = this._buildProfilesFromConfig(config);
        console.log(`[AgentProfiles] Loaded v3 config: ${Object.keys(config.roles).length} roles, ${Object.keys(config.adapters).length} adapters`);
      } else {
        // Legacy format - profiles directly at top level
        this.rawConfig = null;
        this.profiles = config;
        console.log(`[AgentProfiles] Loaded ${Object.keys(this.profiles).length} legacy profiles`);
      }

      this.lastModified = stats.mtimeMs;
    } catch (error) {
      if (error.code === 'ENOENT') {
        console.warn('[AgentProfiles] Config file not found, using empty profiles');
        this.profiles = {};
        this.rawConfig = null;
      } else {
        console.error('[AgentProfiles] Error loading profiles:', error.message);
      }
    }
  }

  /**
   * Build profiles from v3 config structure
   * @private
   */
  _buildProfilesFromConfig(config) {
    const profiles = {};
    const { roles, adapters, legacyProfiles } = config;

    // Build profiles from legacy mappings (backward compatibility)
    for (const [legacyName, mapping] of Object.entries(legacyProfiles || {})) {
      if (mapping._comment) continue;  // Skip comment entries

      const role = roles[mapping.role];
      const adapter = adapters[mapping.adapter];
      if (role && adapter) {
        profiles[legacyName] = this._mergeRoleAndAdapter(role, adapter, mapping.adapter);
      }
    }

    // Also allow direct access by role name (using defaultAdapter)
    for (const [roleName, role] of Object.entries(roles)) {
      const adapterName = role.defaultAdapter;
      const adapter = adapters[adapterName];
      if (adapter && !profiles[roleName]) {
        profiles[roleName] = this._mergeRoleAndAdapter(role, adapter, adapterName);
      }
    }

    return profiles;
  }

  /**
   * Merge a role with an adapter to create a profile
   * @private
   */
  _mergeRoleAndAdapter(role, adapter, adapterName) {
    return {
      description: role.description,
      systemPrompt: role.systemPrompt,
      adapter: adapterName,
      timeout: role.timeout || 300,
      allowedTools: role.claudeOptions?.allowedTools || adapter.defaultAllowedTools || null,
      permissionMode: role.claudeOptions?.permissionMode || null,
      capabilities: adapter.capabilities || []
    };
  }

  /**
   * Get a profile by name (legacy profile name or role name)
   * @param {string} name - Profile name
   * @returns {Object|null} - Profile or null if not found
   */
  getProfile(name) {
    // Auto-reload on access
    this.reload();

    return this.profiles[name] || null;
  }

  /**
   * Get a profile by combining a role with a specific adapter
   * This is the new API for the role+adapter model
   * @param {string} roleName - Role name (e.g., 'implement', 'review')
   * @param {string} adapterName - Adapter name (e.g., 'gemini-cli', 'claude-code')
   * @returns {Object|null} - Profile or null if role/adapter not found
   */
  getProfileByRoleAndAdapter(roleName, adapterName) {
    this.reload();

    if (!this.rawConfig) {
      // Legacy config - no role+adapter support
      return null;
    }

    const role = this.rawConfig.roles?.[roleName];
    if (!role) return null;

    // Use specified adapter or fall back to role's default
    const actualAdapterName = adapterName || role.defaultAdapter;
    const adapter = this.rawConfig.adapters?.[actualAdapterName];
    if (!adapter) return null;

    return this._mergeRoleAndAdapter(role, adapter, actualAdapterName);
  }

  /**
   * List all available roles
   * @returns {Array<string>}
   */
  listRoles() {
    this.reload();
    if (!this.rawConfig) return [];
    return Object.keys(this.rawConfig.roles || {});
  }

  /**
   * List all available adapters
   * @returns {Array<string>}
   */
  listAdapters() {
    this.reload();
    if (!this.rawConfig) return [];
    return Object.keys(this.rawConfig.adapters || {});
  }

  /**
   * Get role configuration
   * @param {string} name - Role name
   * @returns {Object|null}
   */
  getRole(name) {
    this.reload();
    return this.rawConfig?.roles?.[name] || null;
  }

  /**
   * Get adapter configuration
   * @param {string} name - Adapter name
   * @returns {Object|null}
   */
  getAdapter(name) {
    this.reload();
    return this.rawConfig?.adapters?.[name] || null;
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

/**
 * Load a profile by combining role and adapter
 * @param {string} role - Role name
 * @param {string} adapter - Adapter name (optional, uses role's default if not provided)
 * @returns {Object|null}
 */
function loadProfileByRoleAndAdapter(role, adapter) {
  return getAgentProfiles().getProfileByRoleAndAdapter(role, adapter);
}

/**
 * Resolve profile from various input combinations:
 * - If role is provided, use getProfileByRoleAndAdapter
 * - If profile is provided (legacy), use getProfile
 * - Supports custom systemPrompt override
 * @param {Object} params
 * @param {string} params.role - Role name (new API)
 * @param {string} params.adapter - Adapter name (new API)
 * @param {string} params.profile - Legacy profile name
 * @param {string} params.systemPrompt - Custom system prompt override
 * @returns {Object|null}
 */
function resolveProfile({ role, adapter, profile, systemPrompt }) {
  const service = getAgentProfiles();
  let resolved = null;

  if (role) {
    // New API: role + optional adapter
    resolved = service.getProfileByRoleAndAdapter(role, adapter);
  } else if (profile) {
    // Legacy API: profile name
    resolved = service.getProfile(profile);
  }

  // Apply custom system prompt override
  if (resolved && systemPrompt) {
    resolved = { ...resolved, systemPrompt };
  }

  return resolved;
}

module.exports = {
  AgentProfilesService,
  getAgentProfiles,
  loadProfile,
  loadProfileByRoleAndAdapter,
  resolveProfile
};
