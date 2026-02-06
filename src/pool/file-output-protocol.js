/**
 * File-Based Output Protocol
 *
 * Instead of parsing terminal output (unreliable due to ANSI codes, formatting,
 * and CLI-specific quirks), this protocol instructs agents to write their
 * output to designated files.
 *
 * Benefits:
 * - 100% reliable output extraction
 * - No ANSI stripping needed
 * - Works regardless of CLI output format changes
 * - Supports structured output (JSON, etc.)
 *
 * Protocol:
 * 1. Each task gets a designated output directory
 * 2. Agent writes final output to output.txt (or output.json for structured)
 * 3. Agent can write intermediate files (thoughts.txt, code/, etc.)
 * 4. Orchestrator reads from output file after completion
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Base directory for output files
const BASE_DIR = process.env.CLIAGENTS_OUTPUT_DIR || path.join(os.tmpdir(), 'cliagents-output');

/**
 * File Output Manager
 */
class FileOutputManager {
  constructor(options = {}) {
    this.baseDir = options.baseDir || BASE_DIR;
    this.cleanupOnRead = options.cleanupOnRead ?? true;
    this.maxOutputSize = options.maxOutputSize || 10 * 1024 * 1024; // 10MB

    // Ensure base directory exists
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  /**
   * Get the output directory for a terminal
   * @param {string} terminalId
   * @returns {string}
   */
  getOutputDir(terminalId) {
    const dir = path.join(this.baseDir, terminalId);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  /**
   * Get the path for the main output file
   * @param {string} terminalId
   * @param {string} format - 'text' or 'json'
   * @returns {string}
   */
  getOutputPath(terminalId, format = 'text') {
    const dir = this.getOutputDir(terminalId);
    return path.join(dir, format === 'json' ? 'output.json' : 'output.txt');
  }

  /**
   * Generate system prompt instructions for file-based output
   *
   * @param {string} terminalId
   * @param {Object} options
   * @param {string} options.format - 'text' or 'json'
   * @param {Object} options.jsonSchema - JSON schema for structured output
   * @returns {string}
   */
  getSystemPromptAddition(terminalId, options = {}) {
    const { format = 'text', jsonSchema } = options;
    const outputPath = this.getOutputPath(terminalId, format);
    const dir = this.getOutputDir(terminalId);

    let prompt = `
## Output Protocol

IMPORTANT: Write your final response to a file for reliable extraction.

**Output File:** \`${outputPath}\`

Instructions:
1. After completing your task, write your final response/output to the file above
2. Use the Write tool or echo/cat to write to the file
3. For intermediate work, you can use \`${dir}/\` directory
4. The orchestrator will read your output from the file

`;

    if (format === 'json' && jsonSchema) {
      prompt += `
**Output Format:** JSON
Your output must be valid JSON matching this schema:
\`\`\`json
${JSON.stringify(jsonSchema, null, 2)}
\`\`\`

Write the JSON to: \`${outputPath}\`
`;
    } else if (format === 'text') {
      prompt += `
**Output Format:** Plain text
Write your response as plain text (markdown is fine).
`;
    }

    prompt += `
Example (using cat):
\`\`\`bash
cat > "${outputPath}" << 'EOF'
Your response here...
EOF
\`\`\`

Or using the Write tool:
- file_path: "${outputPath}"
- content: "Your response here..."
`;

    return prompt;
  }

  /**
   * Read output from a terminal's output file
   *
   * @param {string} terminalId
   * @param {Object} options
   * @param {string} options.format - 'text' or 'json'
   * @param {number} options.timeout - Max time to wait for file (ms)
   * @param {number} options.pollInterval - Poll interval (ms)
   * @returns {Promise<{output: string|Object, source: string}>}
   */
  async readOutput(terminalId, options = {}) {
    const {
      format = 'text',
      timeout = 5000,
      pollInterval = 500
    } = options;

    const outputPath = this.getOutputPath(terminalId, format);
    const startTime = Date.now();

    // Poll for file existence
    while (Date.now() - startTime < timeout) {
      if (fs.existsSync(outputPath)) {
        const stats = fs.statSync(outputPath);

        // Check size
        if (stats.size > this.maxOutputSize) {
          throw new Error(`Output file too large: ${stats.size} bytes (max: ${this.maxOutputSize})`);
        }

        // Read file
        const content = fs.readFileSync(outputPath, 'utf-8');

        // Cleanup if configured
        if (this.cleanupOnRead) {
          this.cleanup(terminalId);
        }

        // Parse if JSON
        if (format === 'json') {
          try {
            return {
              output: JSON.parse(content),
              source: 'file',
              path: outputPath
            };
          } catch (e) {
            throw new Error(`Invalid JSON in output file: ${e.message}`);
          }
        }

        return {
          output: content,
          source: 'file',
          path: outputPath
        };
      }

      // Wait before next poll
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    // File not found - return null (caller should fall back to terminal output)
    return null;
  }

  /**
   * Check if output file exists
   * @param {string} terminalId
   * @param {string} format
   * @returns {boolean}
   */
  hasOutput(terminalId, format = 'text') {
    const outputPath = this.getOutputPath(terminalId, format);
    return fs.existsSync(outputPath);
  }

  /**
   * Cleanup output files for a terminal
   * @param {string} terminalId
   */
  cleanup(terminalId) {
    const dir = path.join(this.baseDir, terminalId);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  /**
   * Cleanup all old output directories
   * @param {number} maxAge - Max age in milliseconds
   */
  cleanupOld(maxAge = 24 * 60 * 60 * 1000) {
    if (!fs.existsSync(this.baseDir)) return;

    const now = Date.now();
    const entries = fs.readdirSync(this.baseDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const dir = path.join(this.baseDir, entry.name);
        const stats = fs.statSync(dir);
        if (now - stats.mtimeMs > maxAge) {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  }
}

/**
 * Enhance a system prompt with file output instructions
 *
 * @param {string} systemPrompt - Original system prompt
 * @param {string} terminalId - Terminal ID for output directory
 * @param {Object} options - Options for file output
 * @returns {string} - Enhanced system prompt
 */
function enhanceSystemPromptWithFileOutput(systemPrompt, terminalId, options = {}) {
  const manager = new FileOutputManager();
  const addition = manager.getSystemPromptAddition(terminalId, options);
  return systemPrompt + '\n' + addition;
}

/**
 * Singleton instance for convenience
 */
let defaultManager = null;

function getFileOutputManager(options = {}) {
  if (!defaultManager) {
    defaultManager = new FileOutputManager(options);
  }
  return defaultManager;
}

module.exports = {
  FileOutputManager,
  enhanceSystemPromptWithFileOutput,
  getFileOutputManager,
  BASE_DIR
};
