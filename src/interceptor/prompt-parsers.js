/**
 * Prompt Parsers - Extract tool/args from CLI permission prompts
 *
 * SECURITY: These parsers must be strict to avoid prompt spoofing.
 * See docs/IMPLEMENTATION_PLAN_INTERCEPTOR_DISCUSSION.md for security considerations.
 *
 * Key security measures:
 * 1. Use start-of-line anchors (^) to avoid matching spoofed output
 * 2. Require contextual validation (CLI must be in WAITING_PERMISSION state)
 * 3. Only parse last N bytes to avoid historical false matches
 */

const { TerminalStatus } = require('../models/terminal-status');

/**
 * Base prompt parser class
 */
class BasePromptParser {
  constructor(adapter) {
    this.adapter = adapter;
    // Only scan last 2KB of output (security: avoid historical matches)
    this.scanLimit = 2048;
  }

  /**
   * Get tail of output for scanning
   */
  getTail(output) {
    if (!output || output.length <= this.scanLimit) {
      return output || '';
    }
    return output.slice(-this.scanLimit);
  }

  /**
   * Parse permission prompt and extract tool info
   * @param {string} output - Terminal output
   * @param {string} status - Current terminal status (for contextual validation)
   * @returns {PromptInfo|null}
   */
  parse(output, status) {
    // Security: Only parse if CLI is actually waiting for permission
    if (status !== TerminalStatus.WAITING_PERMISSION) {
      return null;
    }
    return this._parsePrompt(this.getTail(output));
  }

  /**
   * Subclass implementation
   * @protected
   */
  _parsePrompt(output) {
    throw new Error('Subclass must implement _parsePrompt');
  }

  /**
   * Validate extracted path for basic sanity
   * @protected
   */
  _validatePath(path) {
    if (!path || typeof path !== 'string') return false;
    // Reject obviously malicious paths
    if (path.includes('\x00')) return false;
    if (path.length > 4096) return false;
    return true;
  }

  /**
   * Validate extracted command for basic sanity
   * @protected
   */
  _validateCommand(cmd) {
    if (!cmd || typeof cmd !== 'string') return false;
    if (cmd.includes('\x00')) return false;
    if (cmd.length > 8192) return false;
    return true;
  }
}

/**
 * Claude Code prompt parser
 *
 * Claude Code prompts format (examples):
 * - "Run bash command? ls -la"
 * - "Write to /path/to/file.js?"
 * - "Edit /path/to/file.js?"
 * - "Read /path/to/file.js?"
 */
class ClaudeCodePromptParser extends BasePromptParser {
  constructor() {
    super('claude-code');

    // Claude Code permission patterns (anchored to start of line)
    // These must match the actual CLI output format
    this.patterns = {
      // Bash command: "Run bash command? <command>"
      bash: /^(?:│\s*)?(?:Run|Execute)\s+(?:bash\s+)?command\??\s*[:\-]?\s*(.+?)(?:\?|$)/mi,

      // File operations: "Write to <path>?" or "Edit <path>?"
      write: /^(?:│\s*)?Write\s+(?:to\s+)?([^\s?]+)\s*\??/mi,
      edit: /^(?:│\s*)?Edit\s+([^\s?]+)\s*\??/mi,
      read: /^(?:│\s*)?Read\s+([^\s?]+)\s*\??/mi,

      // Generic tool permission
      tool: /^(?:│\s*)?(?:Allow|Approve)\s+(\w+)\s*\??/mi
    };
  }

  _parsePrompt(output) {
    // Try each pattern
    let match;

    // Bash command
    match = output.match(this.patterns.bash);
    if (match && this._validateCommand(match[1])) {
      return {
        toolName: 'Bash',
        args: { command: match[1].trim() },
        rawPrompt: match[0],
        adapter: this.adapter
      };
    }

    // Write operation
    match = output.match(this.patterns.write);
    if (match && this._validatePath(match[1])) {
      return {
        toolName: 'Write',
        args: { file_path: match[1].trim() },
        rawPrompt: match[0],
        adapter: this.adapter
      };
    }

    // Edit operation
    match = output.match(this.patterns.edit);
    if (match && this._validatePath(match[1])) {
      return {
        toolName: 'Edit',
        args: { file_path: match[1].trim() },
        rawPrompt: match[0],
        adapter: this.adapter
      };
    }

    // Read operation
    match = output.match(this.patterns.read);
    if (match && this._validatePath(match[1])) {
      return {
        toolName: 'Read',
        args: { file_path: match[1].trim() },
        rawPrompt: match[0],
        adapter: this.adapter
      };
    }

    // Generic tool
    match = output.match(this.patterns.tool);
    if (match) {
      return {
        toolName: match[1],
        args: {},
        rawPrompt: match[0],
        adapter: this.adapter
      };
    }

    return null;
  }
}

/**
 * Gemini CLI prompt parser
 *
 * Gemini CLI prompts format (examples):
 * - "Allow bash execution: rm -rf /tmp ? (y/n)"
 * - "Allow write to /path/to/file.js ? (y/n)"
 * - "Allow read from /etc/passwd ? (y/n)"
 * - "(y/n)" at end of line
 */
class GeminiPromptParser extends BasePromptParser {
  constructor() {
    super('gemini-cli');

    // Gemini CLI permission patterns (strict anchoring)
    this.patterns = {
      // Bash execution: "Allow bash execution: <command> ? (y/n)"
      bash: /^Allow\s+(?:bash\s+)?execution\s*:\s*(.+?)\s*\?\s*\(y\/n\)/mi,

      // File write: "Allow write to <path> ? (y/n)"
      write: /^Allow\s+write\s+to\s+([^\s?]+)\s*\?\s*\(y\/n\)/mi,

      // File read: "Allow read from <path> ? (y/n)"
      read: /^Allow\s+read\s+(?:from\s+)?([^\s?]+)\s*\?\s*\(y\/n\)/mi,

      // File edit: "Allow edit <path> ? (y/n)"
      edit: /^Allow\s+edit\s+([^\s?]+)\s*\?\s*\(y\/n\)/mi,

      // Generic: "Allow <action> ? (y/n)"
      generic: /^Allow\s+(\w+(?:\s+\w+)?)\s*\?\s*\(y\/n\)/mi
    };
  }

  _parsePrompt(output) {
    let match;

    // Bash execution
    match = output.match(this.patterns.bash);
    if (match && this._validateCommand(match[1])) {
      return {
        toolName: 'Bash',
        args: { command: match[1].trim() },
        rawPrompt: match[0],
        adapter: this.adapter
      };
    }

    // Write operation
    match = output.match(this.patterns.write);
    if (match && this._validatePath(match[1])) {
      return {
        toolName: 'Write',
        args: { file_path: match[1].trim() },
        rawPrompt: match[0],
        adapter: this.adapter
      };
    }

    // Read operation
    match = output.match(this.patterns.read);
    if (match && this._validatePath(match[1])) {
      return {
        toolName: 'Read',
        args: { file_path: match[1].trim() },
        rawPrompt: match[0],
        adapter: this.adapter
      };
    }

    // Edit operation
    match = output.match(this.patterns.edit);
    if (match && this._validatePath(match[1])) {
      return {
        toolName: 'Edit',
        args: { file_path: match[1].trim() },
        rawPrompt: match[0],
        adapter: this.adapter
      };
    }

    // Generic action
    match = output.match(this.patterns.generic);
    if (match) {
      const action = match[1].trim();
      return {
        toolName: this._actionToToolName(action),
        args: {},
        rawPrompt: match[0],
        adapter: this.adapter
      };
    }

    return null;
  }

  /**
   * Map action descriptions to tool names
   */
  _actionToToolName(action) {
    const actionLower = action.toLowerCase();
    if (actionLower.includes('bash') || actionLower.includes('exec') || actionLower.includes('command')) {
      return 'Bash';
    }
    if (actionLower.includes('write') || actionLower.includes('create')) {
      return 'Write';
    }
    if (actionLower.includes('read') || actionLower.includes('file')) {
      return 'Read';
    }
    if (actionLower.includes('edit') || actionLower.includes('modify')) {
      return 'Edit';
    }
    // Return capitalized action as tool name
    return action.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');
  }
}

/**
 * Codex CLI prompt parser
 *
 * Codex CLI prompts format (examples):
 * - "Approve file edit: src/index.js ? (y/n)"
 * - "Run command: npm install lodash ? (y/n)"
 * - "Confirm sandbox execution ? (y/n)"
 */
class CodexPromptParser extends BasePromptParser {
  constructor() {
    super('codex-cli');

    // Codex CLI permission patterns (strict anchoring)
    this.patterns = {
      // File edit: "Approve file edit: <path> ? (y/n)"
      edit: /^(?:Approve|Allow)\s+(?:file\s+)?edit\s*:\s*([^\s?]+)\s*\?\s*\(y\/n\)/mi,

      // Run command: "Run command: <command> ? (y/n)"
      command: /^Run\s+command\s*:\s*(.+?)\s*\?\s*\(y\/n\)/mi,

      // Sandbox execution
      sandbox: /^(?:Confirm|Approve)\s+sandbox\s+execution\s*\?\s*\(y\/n\)/mi,

      // File write
      write: /^(?:Approve|Allow)\s+(?:file\s+)?write\s*:\s*([^\s?]+)\s*\?\s*\(y\/n\)/mi,

      // Generic confirm
      generic: /^(?:Confirm|Approve|Allow|Continue)\s*\?\s*\(y\/n\)/mi
    };
  }

  _parsePrompt(output) {
    let match;

    // File edit
    match = output.match(this.patterns.edit);
    if (match && this._validatePath(match[1])) {
      return {
        toolName: 'Edit',
        args: { file_path: match[1].trim() },
        rawPrompt: match[0],
        adapter: this.adapter
      };
    }

    // Run command
    match = output.match(this.patterns.command);
    if (match && this._validateCommand(match[1])) {
      return {
        toolName: 'Bash',
        args: { command: match[1].trim() },
        rawPrompt: match[0],
        adapter: this.adapter
      };
    }

    // Sandbox execution
    match = output.match(this.patterns.sandbox);
    if (match) {
      return {
        toolName: 'Sandbox',
        args: {},
        rawPrompt: match[0],
        adapter: this.adapter
      };
    }

    // File write
    match = output.match(this.patterns.write);
    if (match && this._validatePath(match[1])) {
      return {
        toolName: 'Write',
        args: { file_path: match[1].trim() },
        rawPrompt: match[0],
        adapter: this.adapter
      };
    }

    // Generic confirm
    match = output.match(this.patterns.generic);
    if (match) {
      return {
        toolName: 'Generic',
        args: {},
        rawPrompt: match[0],
        adapter: this.adapter
      };
    }

    return null;
  }
}

/**
 * Factory to get parser for an adapter
 */
function getParser(adapter) {
  switch (adapter) {
    case 'claude-code':
      return new ClaudeCodePromptParser();
    case 'gemini-cli':
      return new GeminiPromptParser();
    case 'codex-cli':
      return new CodexPromptParser();
    default:
      throw new Error(`No prompt parser available for adapter: ${adapter}`);
  }
}

/**
 * @typedef {Object} PromptInfo
 * @property {string} toolName - Tool name (e.g., 'Bash', 'Write', 'Edit')
 * @property {Object} args - Extracted arguments
 * @property {string} rawPrompt - Original prompt text
 * @property {string} adapter - CLI adapter name
 */

module.exports = {
  BasePromptParser,
  ClaudeCodePromptParser,
  GeminiPromptParser,
  CodexPromptParser,
  getParser
};
