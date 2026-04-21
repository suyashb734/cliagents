/**
 * QwenCliDetector - Status detection for Qwen Code CLI
 *
 * Pattern detection based on Qwen CLI stream-json and interactive output.
 */

const BaseStatusDetector = require('./base');
const { TerminalStatus } = require('../models/terminal-status');

const QWEN_PATTERNS = {
  IDLE: /qwen>|^QWEN_READY_FOR_ORCHESTRATION$|^[\w.-]+@[\w.-]+.*[#$%>]\s*$/m,
  PROCESSING: /thinking|tool_use|working|analyzing|generating|processing|^\{"type":"(?:assistant|tool_use|progress)"/mi,
  COMPLETED: /^\{"type":"result"/m,
  WAITING_PERMISSION: /^\s*\(y\/n\)|^Allow\s*\?|^Approve\s*\?|^Confirm\s*\?/mi,
  WAITING_USER_ANSWER: /^(?:Select|Choose).*:\s*$|Which.*\?\s*$|Press enter to continue/mi,
  ERROR: /^(?:Error|ERROR)\s*:|^APIError|^RateLimitError|^\{"type":"error"/m
};

class QwenCliDetector extends BaseStatusDetector {
  constructor() {
    super({
      ...QWEN_PATTERNS,
      tailSize: 2000
    });
    this.name = 'qwen-cli';
  }

  detectStatus(output) {
    const tail = this.getTail(output);
    const lines = tail.trim().split('\n');
    if (lines.length > 0) {
      const lastLine = lines[lines.length - 1];

      if (/^[\w.-]+@[\w.-]+.*[#$%>]\s*$/.test(lastLine)) {
        return TerminalStatus.IDLE;
      }

      if (/^\{"type":"(?:result|error)"/.test(lastLine)) {
        return TerminalStatus.COMPLETED;
      }
    }

    return super.detectStatus(output);
  }
}

module.exports = QwenCliDetector;
