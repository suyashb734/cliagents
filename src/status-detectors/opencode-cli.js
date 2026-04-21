/**
 * OpencodeCliDetector - Status detection for OpenCode CLI.
 *
 * Pattern detection is based on `opencode run --format json` event streams
 * and a shell-ready marker for orchestration terminals.
 */

'use strict';

const BaseStatusDetector = require('./base');
const { TerminalStatus } = require('../models/terminal-status');

const OPENCODE_PATTERNS = {
  IDLE: /opencode>|^OPENCODE_READY_FOR_ORCHESTRATION$|^[\w.-]+@[\w.-]+.*[#$%>]\s*$/m,
  PROCESSING: /thinking|working|processing|^{"type":"(?:step_start|text|progress)"}/mi,
  COMPLETED: /^{"type":"step_finish"/m,
  WAITING_PERMISSION: /^\s*\(y\/n\)|^Allow\s*\?|^Approve\s*\?|^Confirm\s*\?/mi,
  WAITING_USER_ANSWER: /^(?:Select|Choose).*:\s*$|Which.*\?\s*$|Press enter to continue/mi,
  ERROR: /^(?:Error|ERROR)(?:\s*:|\s+\d{4}-\d{2}-\d{2})|^{"type":"error"|SubscriptionUsageLimitError|quota exceeded|continue using free models|AI_(?:API|Retry)Error|statusCode":(?:401|403|429)/im
};

class OpencodeCliDetector extends BaseStatusDetector {
  constructor() {
    super({
      ...OPENCODE_PATTERNS,
      tailSize: 2000
    });
    this.name = 'opencode-cli';
  }

  detectStatus(output) {
    const tail = this.getTail(output);
    const lines = tail.trim().split('\n');

    if (lines.length > 0) {
      const lastLine = lines[lines.length - 1];

      if (/^[\w.-]+@[\w.-]+.*[#$%>]\s*$/.test(lastLine)) {
        return TerminalStatus.IDLE;
      }
      if (/^{"type":"step_finish"/.test(lastLine)) {
        return TerminalStatus.COMPLETED;
      }
      if (/^{"type":"error"/.test(lastLine)) {
        return TerminalStatus.ERROR;
      }
    }

    if (/SubscriptionUsageLimitError|quota exceeded|continue using free models|AI_(?:API|Retry)Error|statusCode":(?:401|403|429)/i.test(tail)) {
      return TerminalStatus.ERROR;
    }

    return super.detectStatus(output);
  }
}

module.exports = OpencodeCliDetector;
