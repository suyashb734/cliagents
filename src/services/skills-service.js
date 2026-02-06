/**
 * Skills Service
 *
 * Provides Superpowers-style skills system for cliagents.
 * Skills are reusable, domain-specific workflows loaded from SKILL.md files.
 *
 * Discovery priority: Project (.cliagents/skills/) > Personal (~/.cliagents/skills/) > Core (cliagents/skills/)
 */

// Skills service for cliagents

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const os = require('os');

/**
 * Parse YAML-like frontmatter from a string
 * Supports: name, description, adapters, tags
 *
 * @param {string} content - File content with optional frontmatter
 * @returns {{ frontmatter: Object, body: string }}
 */
function parseFrontmatter(content) {
  const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;
  const match = content.match(frontmatterRegex);

  if (!match) {
    return { frontmatter: {}, body: content };
  }

  const [, yamlBlock, body] = match;
  const frontmatter = {};

  // Parse simple YAML-like key: value pairs
  const lines = yamlBlock.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Handle array values: key: [val1, val2]
    // Allow hyphens and underscores in keys: ([a-zA-Z0-9_-]+)
    const arrayMatch = trimmed.match(/^([a-zA-Z0-9_-]+):\s*\[(.*)\]\s*$/);
    if (arrayMatch) {
      const [, key, valuesStr] = arrayMatch;
      const values = valuesStr
        .split(',')
        .map(v => v.trim().replace(/^['"]|['"]$/g, ''))
        .filter(v => v.length > 0);
      frontmatter[key] = values;
      continue;
    }

    // Handle simple key: value
    // Allow hyphens and underscores in keys: ([a-zA-Z0-9_-]+)
    const simpleMatch = trimmed.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (simpleMatch) {
      const [, key, value] = simpleMatch;
      frontmatter[key] = value.trim().replace(/^['"]|['"]$/g, '');
    }
  }

  return { frontmatter, body: body.trim() };
}

class SkillsService {
  /**
   * @param {Object} options
   * @param {string} options.coreDir - Path to core skills directory
   * @param {string} options.personalDir - Path to personal skills directory
   * @param {string} options.projectDir - Path to project skills directory (relative to projectRoot)
   * @param {string} options.projectRoot - Root directory of the project (defaults to process.cwd())
   * @param {number} options.maxDepth - Max directory depth to search for skills
   */
  constructor(options = {}) {
    this.projectRoot = options.projectRoot || process.cwd();
    this.coreDir = options.coreDir || path.join(__dirname, '../../skills');
    this.personalDir = options.personalDir || path.join(os.homedir(), '.cliagents/skills');
    
    // Default project skills dir
    const rawProjectDir = options.projectDir || '.cliagents/skills';
    
    // Security: Ensure projectDir is resolved within projectRoot if relative
    if (path.isAbsolute(rawProjectDir)) {
      this.projectDir = rawProjectDir;
    } else {
      this.projectDir = path.resolve(this.projectRoot, rawProjectDir);
      
      // Prevent path traversal outside project root if it was a relative path
      if (!this.projectDir.startsWith(this.projectRoot) && rawProjectDir.includes('..')) {
        console.warn(`[SkillsService] Security warning: projectDir '${rawProjectDir}' resolves outside projectRoot. Resetting to default.`);
        this.projectDir = path.resolve(this.projectRoot, '.cliagents/skills');
      }
    }
    
    this.maxDepth = options.maxDepth || 3;

    // Cache
    this.skillsCache = null;
    this.lastScanTime = 0;
    this.cacheTTL = 5000; // 5 seconds
  }

  /**
   * Extract frontmatter metadata from a SKILL.md file
   *
   * @param {string} filePath - Absolute path to SKILL.md file
   * @param {string} content - Optional pre-read content to avoid re-reading
   * @returns {Object|null} - Parsed metadata or null if file not found
   */
  extractFrontmatter(filePath, content = null) {
    try {
      if (!content) {
        if (!fs.existsSync(filePath)) {
          return null;
        }
        content = fs.readFileSync(filePath, 'utf8');
      }

      const { frontmatter } = parseFrontmatter(content);

      return {
        name: frontmatter.name || path.basename(path.dirname(filePath)),
        description: frontmatter.description || '',
        adapters: frontmatter.adapters || [],
        tags: frontmatter.tags || []
      };
    } catch (error) {
      console.error(`[SkillsService] Error reading ${filePath}:`, error.message);
      return null;
    }
  }

  /**
   * Recursively find all SKILL.md files in a directory
   *
   * @param {string} dir - Directory to search
   * @param {string} sourceType - Source type: 'core', 'personal', or 'project'
   * @param {number} currentDepth - Current recursion depth
   * @returns {Array<Object>} - Array of skill metadata objects
   */
  findSkillsInDir(dir, sourceType, currentDepth = 0) {
    const skills = [];

    if (currentDepth > this.maxDepth || !fs.existsSync(dir)) {
      return skills;
    }

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          // Check if this directory contains a SKILL.md
          const skillPath = path.join(fullPath, 'SKILL.md');

          if (fs.existsSync(skillPath)) {
            const metadata = this.extractFrontmatter(skillPath);
            if (metadata) {
              skills.push({
                ...metadata,
                path: skillPath,
                directory: fullPath,
                source: sourceType
              });
            }
          }

          // Recurse into subdirectory
          skills.push(...this.findSkillsInDir(fullPath, sourceType, currentDepth + 1));
        }
      }
    } catch (error) {
      console.error(`[SkillsService] Error scanning ${dir}:`, error.message);
    }

    return skills;
  }

  /**
   * Recursively find all SKILL.md files in a directory (Async)
   *
   * @param {string} dir - Directory to search
   * @param {string} sourceType - Source type: 'core', 'personal', or 'project'
   * @param {number} currentDepth - Current recursion depth
   * @returns {Promise<Array<Object>>} - Array of skill metadata objects
   */
  async findSkillsInDirAsync(dir, sourceType, currentDepth = 0) {
    const skills = [];

    if (currentDepth > this.maxDepth) {
      return skills;
    }

    try {
      // Check if directory exists
      try {
        await fsp.access(dir);
      } catch (e) {
        return skills;
      }

      const entries = await fsp.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          // Check if this directory contains a SKILL.md
          const skillPath = path.join(fullPath, 'SKILL.md');

          try {
            await fsp.access(skillPath);
            const content = await fsp.readFile(skillPath, 'utf8');
            const metadata = this.extractFrontmatter(skillPath, content);
            if (metadata) {
              skills.push({
                ...metadata,
                path: skillPath,
                directory: fullPath,
                source: sourceType
              });
            }
          } catch (e) {
            // SKILL.md doesn't exist, ignore
          }

          // Recurse into subdirectory
          const subSkills = await this.findSkillsInDirAsync(fullPath, sourceType, currentDepth + 1);
          skills.push(...subSkills);
        }
      }
    } catch (error) {
      console.error(`[SkillsService] Error scanning ${dir}:`, error.message);
    }

    return skills;
  }

  /**
   * Get all skills from all sources
   *
   * @param {boolean} forceRefresh - Force cache refresh
   * @returns {Array<Object>} - Array of all available skills
   */
  getAllSkills(forceRefresh = false) {
    const now = Date.now();

    if (!forceRefresh && this.skillsCache && (now - this.lastScanTime) < this.cacheTTL) {
      return this.skillsCache;
    }

    const allSkills = [];

    // Scan all sources (order matters for shadowing)
    
    // Project skills (highest priority)
    allSkills.push(...this.findSkillsInDir(this.projectDir, 'project'));

    // Personal skills
    allSkills.push(...this.findSkillsInDir(this.personalDir, 'personal'));

    // Core skills (lowest priority)
    allSkills.push(...this.findSkillsInDir(this.coreDir, 'core'));

    this.skillsCache = allSkills;
    this.lastScanTime = now;

    return allSkills;
  }

  /**
   * Get all skills from all sources (Async)
   *
   * @param {boolean} forceRefresh - Force cache refresh
   * @returns {Promise<Array<Object>>} - Array of all available skills
   */
  async getAllSkillsAsync(forceRefresh = false) {
    const now = Date.now();

    if (!forceRefresh && this.skillsCache && (now - this.lastScanTime) < this.cacheTTL) {
      return this.skillsCache;
    }

    const allSkills = [];

    // Scan all sources in parallel
    const [projectSkills, personalSkills, coreSkills] = await Promise.all([
      this.findSkillsInDirAsync(this.projectDir, 'project'),
      this.findSkillsInDirAsync(this.personalDir, 'personal'),
      this.findSkillsInDirAsync(this.coreDir, 'core')
    ]);

    allSkills.push(...projectSkills, ...personalSkills, ...coreSkills);

    this.skillsCache = allSkills;
    this.lastScanTime = now;

    return allSkills;
  }

  /**
   * Get all skills from a specific source
   *
   * @param {string} source - Source type: 'core', 'personal', or 'project'
   * @returns {Array<Object>} - Array of skills from the source
   */
  getSkillsBySource(source) {
    const allSkills = this.getAllSkills();
    return allSkills.filter(skill => skill.source === source);
  }

  /**
   * Resolve a skill by name, respecting shadowing priority
   *
   * @param {string} skillName - Skill name to resolve
   * @returns {string|null} - Path to SKILL.md or null if not found
   */
  resolveSkillPath(skillName) {
    const allSkills = this.getAllSkills();

    // Find first matching skill (already ordered by priority)
    const skill = allSkills.find(s => s.name === skillName);

    return skill ? skill.path : null;
  }

  /**
   * Resolve a skill by name, respecting shadowing priority (Async)
   *
   * @param {string} skillName - Skill name to resolve
   * @returns {Promise<string|null>} - Path to SKILL.md or null if not found
   */
  async resolveSkillPathAsync(skillName) {
    const allSkills = await this.getAllSkillsAsync();

    // Find first matching skill (already ordered by priority)
    const skill = allSkills.find(s => s.name === skillName);

    return skill ? skill.path : null;
  }

  /**
   * Load a skill by name
   *
   * @param {string} skillName - Skill name to load
   * @returns {Object|null} - Skill object with content and metadata, or null
   */
  loadSkill(skillName) {
    const allSkills = this.getAllSkills();
    const skill = allSkills.find(s => s.name === skillName);

    if (!skill) {
      return null;
    }

    try {
      const content = fs.readFileSync(skill.path, 'utf8');
      const { frontmatter, body } = parseFrontmatter(content);

      return {
        name: skill.name,
        description: skill.description,
        adapters: skill.adapters,
        tags: skill.tags,
        source: skill.source,
        path: skill.path,
        directory: skill.directory,
        content: body,
        rawContent: content,
        frontmatter
      };
    } catch (error) {
      console.error(`[SkillsService] Error loading skill ${skillName}:`, error.message);
      return null;
    }
  }

  /**
   * Load a skill by name (Async)
   *
   * @param {string} skillName - Skill name to load
   * @returns {Promise<Object|null>} - Skill object with content and metadata, or null
   */
  async loadSkillAsync(skillName) {
    const allSkills = await this.getAllSkillsAsync();
    const skill = allSkills.find(s => s.name === skillName);

    if (!skill) {
      return null;
    }

    try {
      const content = await fsp.readFile(skill.path, 'utf8');
      const { frontmatter, body } = parseFrontmatter(content);

      return {
        name: skill.name,
        description: skill.description,
        adapters: skill.adapters,
        tags: skill.tags,
        source: skill.source,
        path: skill.path,
        directory: skill.directory,
        content: body,
        rawContent: content,
        frontmatter
      };
    } catch (error) {
      console.error(`[SkillsService] Error loading skill ${skillName}:`, error.message);
      return null;
    }
  }

  /**
   * Get skill content without frontmatter
   *
   * @param {string} skillName - Skill name
   * @returns {string|null} - Skill content or null if not found
   */
  getSkillContent(skillName) {
    const skill = this.loadSkill(skillName);
    return skill ? skill.content : null;
  }

  /**
   * Get skill content without frontmatter (Async)
   *
   * @param {string} skillName - Skill name
   * @returns {Promise<string|null>} - Skill content or null if not found
   */
  async getSkillContentAsync(skillName) {
    const skill = await this.loadSkillAsync(skillName);
    return skill ? skill.content : null;
  }

  /**
   * List all available skills with optional filtering
   *
   * @param {Object} filters - Filter options
   * @param {string} filters.tag - Filter by tag
   * @param {string} filters.adapter - Filter by compatible adapter
   * @param {string} filters.source - Filter by source (core, personal, project)
   * @returns {Array<Object>} - Filtered list of skills
   */
  listSkills(filters = {}) {
    let skills = this.getAllSkills();

    // Apply shadowing: keep only first occurrence of each skill name
    const seenNames = new Set();
    skills = skills.filter(skill => {
      if (seenNames.has(skill.name)) {
        return false;
      }
      seenNames.add(skill.name);
      return true;
    });

    // Apply filters
    if (filters.tag) {
      skills = skills.filter(s => s.tags.includes(filters.tag));
    }

    if (filters.adapter) {
      skills = skills.filter(s =>
        s.adapters.length === 0 || s.adapters.includes(filters.adapter)
      );
    }

    if (filters.source) {
      skills = skills.filter(s => s.source === filters.source);
    }

    return skills.map(s => ({
      name: s.name,
      description: s.description,
      adapters: s.adapters,
      tags: s.tags,
      source: s.source
    }));
  }

  /**
   * List all available skills with optional filtering (Async)
   *
   * @param {Object} filters - Filter options
   * @returns {Promise<Array<Object>>} - Filtered list of skills
   */
  async listSkillsAsync(filters = {}) {
    let skills = await this.getAllSkillsAsync();

    // Apply shadowing
    const seenNames = new Set();
    skills = skills.filter(skill => {
      if (seenNames.has(skill.name)) {
        return false;
      }
      seenNames.add(skill.name);
      return true;
    });

    // Apply filters
    if (filters.tag) {
      skills = skills.filter(s => s.tags.includes(filters.tag));
    }

    if (filters.adapter) {
      skills = skills.filter(s =>
        s.adapters.length === 0 || s.adapters.includes(filters.adapter)
      );
    }

    if (filters.source) {
      skills = skills.filter(s => s.source === filters.source);
    }

    return skills.map(s => ({
      name: s.name,
      description: s.description,
      adapters: s.adapters,
      tags: s.tags,
      source: s.source
    }));
  }

  /**
   * Search skills by query string
   *
   * Searches skill names and descriptions for matches (case-insensitive).
   * Results are sorted by relevance: name matches rank higher than description matches.
   *
   * @param {string} query - Search query string
   * @returns {Array<Object>} - Array of matching skills sorted by relevance, each with:
   *   - name: Skill name
   *   - description: Skill description
   *   - adapters: Compatible adapters
   *   - tags: Skill tags
   *   - source: Skill source (core, personal, project)
   *   - relevance: Relevance score (higher = more relevant)
   */
  searchSkills(query) {
    if (!query || typeof query !== 'string') {
      return [];
    }

    const searchTerm = query.toLowerCase().trim();
    if (searchTerm.length === 0) {
      return [];
    }

    let skills = this.getAllSkills();

    // Apply shadowing: keep only first occurrence of each skill name
    const seenNames = new Set();
    skills = skills.filter(skill => {
      if (seenNames.has(skill.name)) {
        return false;
      }
      seenNames.add(skill.name);
      return true;
    });

    // Score and filter skills based on query match
    const scoredSkills = [];

    for (const skill of skills) {
      const nameLower = (skill.name || '').toLowerCase();
      const descLower = (skill.description || '').toLowerCase();

      let relevance = 0;

      // Exact name match (highest priority)
      if (nameLower === searchTerm) {
        relevance = 100;
      }
      // Name starts with query
      else if (nameLower.startsWith(searchTerm)) {
        relevance = 80;
      }
      // Name contains query
      else if (nameLower.includes(searchTerm)) {
        relevance = 60;
      }
      // Description contains query (lower priority)
      else if (descLower.includes(searchTerm)) {
        relevance = 40;
      }

      // Only include skills with a match
      if (relevance > 0) {
        scoredSkills.push({
          name: skill.name,
          description: skill.description,
          adapters: skill.adapters,
          tags: skill.tags,
          source: skill.source,
          relevance
        });
      }
    }

    // Sort by relevance (descending), then by name (ascending) for ties
    scoredSkills.sort((a, b) => {
      if (b.relevance !== a.relevance) {
        return b.relevance - a.relevance;
      }
      return a.name.localeCompare(b.name);
    });

    return scoredSkills;
  }

  /**
   * Search skills by query string (Async)
   *
   * @param {string} query - Search query string
   * @returns {Promise<Array<Object>>} - Array of matching skills sorted by relevance
   */
  async searchSkillsAsync(query) {
    if (!query || typeof query !== 'string') {
      return [];
    }

    const searchTerm = query.toLowerCase().trim();
    if (searchTerm.length === 0) {
      return [];
    }

    let skills = await this.getAllSkillsAsync();

    // Apply shadowing
    const seenNames = new Set();
    skills = skills.filter(skill => {
      if (seenNames.has(skill.name)) {
        return false;
      }
      seenNames.add(skill.name);
      return true;
    });

    // Score and filter
    const scoredSkills = [];

    for (const skill of skills) {
      const nameLower = (skill.name || '').toLowerCase();
      const descLower = (skill.description || '').toLowerCase();

      let relevance = 0;

      if (nameLower === searchTerm) relevance = 100;
      else if (nameLower.startsWith(searchTerm)) relevance = 80;
      else if (nameLower.includes(searchTerm)) relevance = 60;
      else if (descLower.includes(searchTerm)) relevance = 40;

      if (relevance > 0) {
        scoredSkills.push({
          name: skill.name,
          description: skill.description,
          adapters: skill.adapters,
          tags: skill.tags,
          source: skill.source,
          relevance
        });
      }
    }

    scoredSkills.sort((a, b) => {
      if (b.relevance !== a.relevance) return b.relevance - a.relevance;
      return a.name.localeCompare(b.name);
    });

    return scoredSkills;
  }

  /**
   * Invoke a skill, returning structured content for an agent to follow
   *
   * @param {string} skillName - Skill name to invoke
   * @param {Object} context - Invocation context
   * @param {string} context.message - Task context/description
   * @param {string} context.adapter - Current adapter (for validation)
   * @returns {Promise<Object>} - Result with skill content and metadata
   */
  async invokeSkill(skillName, context = {}) {
    const skill = await this.loadSkillAsync(skillName);

    if (!skill) {
      return {
        success: false,
        error: `Skill '${skillName}' not found`
      };
    }

    // Check adapter compatibility
    if (context.adapter && skill.adapters.length > 0) {
      if (!skill.adapters.includes(context.adapter)) {
        return {
          success: false,
          error: `Skill '${skillName}' is not compatible with adapter '${context.adapter}'. ` +
                 `Compatible adapters: ${skill.adapters.join(', ')}`
        };
      }
    }

    // Build response with skill content and context
    const response = {
      success: true,
      skill: {
        name: skill.name,
        description: skill.description,
        adapters: skill.adapters,
        tags: skill.tags,
        source: skill.source
      },
      content: skill.content,
      context: context.message || null
    };

    // If there's a task message, prepend it to the content
    if (context.message) {
      response.prompt = `# Task\n${context.message}\n\n# Skill: ${skill.name}\n${skill.content}`;
    } else {
      response.prompt = skill.content;
    }

    return response;
  }

  /**
   * Check if a skill exists
   *
   * @param {string} skillName - Skill name
   * @returns {boolean}
   */
  hasSkill(skillName) {
    return this.resolveSkillPath(skillName) !== null;
  }

  /**
   * Check if a skill exists (Async)
   *
   * @param {string} skillName - Skill name
   * @returns {Promise<boolean>}
   */
  async hasSkillAsync(skillName) {
    const path = await this.resolveSkillPathAsync(skillName);
    return path !== null;
  }

  /**
   * Get list of all tags across all skills
   *
   * @returns {Array<string>} - Unique tags
   */
  getAllTags() {
    const skills = this.getAllSkills();
    const tags = new Set();

    for (const skill of skills) {
      for (const tag of skill.tags) {
        tags.add(tag);
      }
    }

    return Array.from(tags).sort();
  }

  /**
   * Get list of all tags across all skills (Async)
   *
   * @returns {Promise<Array<string>>} - Unique tags
   */
  async getAllTagsAsync() {
    const skills = await this.getAllSkillsAsync();
    const tags = new Set();

    for (const skill of skills) {
      for (const tag of skill.tags) {
        tags.add(tag);
      }
    }

    return Array.from(tags).sort();
  }

  /**
   * Clear the cache to force re-scan on next access
   */
  clearCache() {
    this.skillsCache = null;
    this.lastScanTime = 0;
  }
}

// Singleton instance
let instance = null;

/**
 * Get or create the SkillsService singleton
 *
 * @param {Object} options - Constructor options
 * @returns {SkillsService}
 */
function getSkillsService(options = {}) {
  if (!instance) {
    instance = new SkillsService(options);
  }
  return instance;
}

module.exports = {
  SkillsService,
  getSkillsService,
  parseFrontmatter
};
