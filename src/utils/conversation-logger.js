/**
 * Conversation Logger
 *
 * Logs full LLM conversations (prompts + responses) to files for monitoring.
 * Creates timestamped log files per session in the logs directory.
 */

const fs = require('fs');
const path = require('path');

// Logs directory - relative to project root
const LOGS_DIR = path.join(__dirname, '../../logs');

// Ensure logs directory exists
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

/**
 * Get log file path for a session
 */
function getLogFilePath(sessionId, adapter) {
  const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  return path.join(LOGS_DIR, `${date}-${adapter}-${sessionId}.log`);
}

/**
 * Get latest log file path (for monitoring most recent session)
 */
function getLatestLogPath(adapter) {
  return path.join(LOGS_DIR, `latest-${adapter}.log`);
}

/**
 * Log a conversation turn (prompt + response)
 */
function logConversation(sessionId, adapter, data) {
  const timestamp = new Date().toISOString();
  const logPath = getLogFilePath(sessionId, adapter);
  const latestPath = getLatestLogPath(adapter);

  const entry = {
    timestamp,
    sessionId,
    adapter,
    ...data
  };

  const separator = '\n' + '='.repeat(80) + '\n';
  let logText = separator;
  logText += `[${timestamp}] ${adapter.toUpperCase()} - Session: ${sessionId}\n`;
  logText += '-'.repeat(80) + '\n';

  if (data.prompt) {
    logText += `PROMPT (${data.prompt.length} chars):\n`;
    logText += data.prompt + '\n';
    logText += '-'.repeat(80) + '\n';
  }

  if (data.response) {
    logText += `RESPONSE (${data.response.length} chars):\n`;
    logText += data.response + '\n';
  }

  if (data.error) {
    logText += `ERROR: ${data.error}\n`;
  }

  if (data.stats) {
    logText += '-'.repeat(80) + '\n';
    logText += `STATS: ${JSON.stringify(data.stats)}\n`;
  }

  // Append to session-specific log
  try {
    fs.appendFileSync(logPath, logText);
  } catch (err) {
    console.error('[ConversationLogger] Error writing to log:', err.message);
  }

  // Also update "latest" log (overwrite) for easy monitoring
  try {
    // Keep last 5 turns in latest log
    const maxTurns = 5;
    let latestContent = '';

    if (fs.existsSync(latestPath)) {
      latestContent = fs.readFileSync(latestPath, 'utf-8');
      const turns = latestContent.split('================================================================================');
      if (turns.length > maxTurns) {
        latestContent = turns.slice(-maxTurns).join('================================================================================');
      }
    }

    fs.writeFileSync(latestPath, latestContent + logText);
  } catch (err) {
    // Silently ignore latest log errors
  }

  console.log(`[ConversationLogger] Logged to ${path.basename(logPath)}`);
}

/**
 * Log session start
 */
function logSessionStart(sessionId, adapter, options = {}) {
  const timestamp = new Date().toISOString();
  const logPath = getLogFilePath(sessionId, adapter);

  const header = `
################################################################################
# SESSION START
# Adapter: ${adapter}
# Session ID: ${sessionId}
# Started: ${timestamp}
# Model: ${options.model || 'default'}
# Work Dir: ${options.workDir || 'N/A'}
################################################################################

`;

  try {
    fs.writeFileSync(logPath, header);
    console.log(`[ConversationLogger] New session log: ${path.basename(logPath)}`);
  } catch (err) {
    console.error('[ConversationLogger] Error creating session log:', err.message);
  }
}

/**
 * List recent log files
 */
function listRecentLogs(limit = 10) {
  try {
    const files = fs.readdirSync(LOGS_DIR)
      .filter(f => f.endsWith('.log') && !f.startsWith('latest-'))
      .sort()
      .reverse()
      .slice(0, limit);

    return files.map(f => ({
      name: f,
      path: path.join(LOGS_DIR, f),
      size: fs.statSync(path.join(LOGS_DIR, f)).size
    }));
  } catch (err) {
    return [];
  }
}

module.exports = {
  logConversation,
  logSessionStart,
  listRecentLogs,
  getLogFilePath,
  getLatestLogPath,
  LOGS_DIR
};
