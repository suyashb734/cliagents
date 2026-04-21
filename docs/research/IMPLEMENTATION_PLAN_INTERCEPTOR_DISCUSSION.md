# Implementation Plan: Interceptor Pattern & Agent-to-Agent Discussion

## Executive Summary

This document outlines the implementation plan for two features:
1. **Interceptor Pattern**: Fine-grained permission control for Gemini/Codex CLIs
2. **Agent-to-Agent Discussion**: Enable real-time collaborative conversations between agents

---

## Feature 1: Interceptor Pattern

### 1.1 Overview

**Problem**: Currently, CLIs run in either:
- **Yolo/bypass mode**: Auto-approve everything (risky for sensitive operations)
- **Default mode**: Prompts appear but no one responds → hangs indefinitely

**Solution**: Introduce `permissionMode='interceptor'` that:
1. Runs CLI in default mode (prompts enabled)
2. Continuously monitors terminal output for permission prompts
3. Auto-responds (y/n) based on PermissionManager rules

### 1.2 Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Orchestration Layer                          │
│                                                                     │
│  ┌─────────────────┐    ┌──────────────────┐    ┌───────────────┐  │
│  │  handoff()      │───▶│  InterceptorLoop │───▶│ PermissionMgr │  │
│  │  createTerminal │    │  (per terminal)  │    │ (policies)    │  │
│  └─────────────────┘    └──────────────────┘    └───────────────┘  │
│                                │                                    │
│                                ▼                                    │
│                     ┌──────────────────┐                           │
│                     │  StatusDetector  │                           │
│                     │  (patterns)      │                           │
│                     └──────────────────┘                           │
│                                │                                    │
└────────────────────────────────│────────────────────────────────────┘
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        tmux Terminal                                │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │ gemini> allow bash execution? (y/n)                          │   │
│  └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

### 1.3 Files to Create

| File | Purpose |
|------|---------|
| `src/interceptor/permission-interceptor.js` | Main interceptor loop that polls status and responds |
| `src/interceptor/prompt-parsers.js` | CLI-specific parsers to extract tool/args from permission prompts |
| `src/interceptor/index.js` | Exports for the interceptor module |

### 1.4 Files to Modify

| File | Changes |
|------|---------|
| `src/tmux/session-manager.js` | Add `permissionMode='interceptor'` support to CLI_COMMANDS |
| `src/orchestration/handoff.js` | Start interceptor loop when terminal uses interceptor mode |
| `src/status-detectors/gemini-cli.js` | Enhance WAITING_PERMISSION patterns with tool extraction |
| `src/status-detectors/codex-cli.js` | Enhance WAITING_PERMISSION patterns with tool extraction |
| `src/permissions/permission-manager.js` | Add interceptor-specific policy helpers |
| `config/agent-profiles.json` | Add `permissionMode: 'interceptor'` option |

### 1.5 Interfaces

#### 1.5.1 PermissionInterceptor Class

```javascript
/**
 * PermissionInterceptor - Auto-responds to CLI permission prompts
 */
class PermissionInterceptor extends EventEmitter {
  /**
   * @param {Object} options
   * @param {PersistentSessionManager} options.sessionManager
   * @param {PermissionManager} options.permissionManager
   * @param {number} options.pollIntervalMs - Status poll interval (default: 500)
   * @param {number} options.maxRetries - Max retries for failed responses (default: 3)
   */
  constructor(options);

  /**
   * Start intercepting for a terminal
   * Returns cleanup function
   */
  start(terminalId: string): () => void;

  /**
   * Stop intercepting for a terminal
   */
  stop(terminalId: string): void;

  /**
   * Handle detected permission prompt
   * @returns {Promise<{allowed: boolean, reason?: string}>}
   */
  async handlePrompt(terminalId: string, promptInfo: PromptInfo): Promise<PermissionResult>;
}

/**
 * Extracted information from a permission prompt
 */
interface PromptInfo {
  toolName: string;       // e.g., 'Bash', 'Write', 'Edit'
  args: object;           // Extracted arguments (file paths, commands)
  rawPrompt: string;      // Original prompt text
  adapter: string;        // CLI adapter name
}
```

#### 1.5.2 Prompt Parsers Interface

```javascript
/**
 * Parse permission prompt and extract tool/args
 */
interface PromptParser {
  /**
   * @param {string} output - Terminal output containing prompt
   * @returns {PromptInfo | null}
   */
  parse(output: string): PromptInfo | null;
}

// Gemini-specific parser
class GeminiPromptParser implements PromptParser;

// Codex-specific parser
class CodexPromptParser implements PromptParser;
```

### 1.6 Implementation Steps

#### Phase 1: Enhanced Status Detection (Days 1-2)

1. **Update Gemini status detector** (`src/status-detectors/gemini-cli.js`)
   - Add patterns to extract tool name from permission prompts
   - Add patterns to extract file paths/commands from prompts
   - Test patterns against real Gemini CLI output samples

2. **Update Codex status detector** (`src/status-detectors/codex-cli.js`)
   - Add patterns for Codex-specific permission prompts
   - Handle "sandbox execution" prompts
   - Handle file modification prompts

3. **Create prompt parsers** (`src/interceptor/prompt-parsers.js`)
   ```javascript
   // Gemini example patterns:
   // "Allow bash execution: rm -rf /tmp/cache ? (y/n)"
   // "Allow write to /path/to/file.js ? (y/n)"
   // "Allow read from /etc/passwd ? (y/n)"

   // Codex example patterns:
   // "Approve file edit: src/index.js ? (y/n)"
   // "Run command: npm install lodash ? (y/n)"
   ```

#### Phase 2: Interceptor Core (Days 3-4)

4. **Create PermissionInterceptor** (`src/interceptor/permission-interceptor.js`)
   ```javascript
   class PermissionInterceptor {
     constructor({ sessionManager, permissionManager, pollIntervalMs = 500 }) {
       this.sessionManager = sessionManager;
       this.permissionManager = permissionManager;
       this.pollIntervalMs = pollIntervalMs;
       this.activeInterceptors = new Map(); // terminalId -> intervalId
     }

     start(terminalId) {
       const terminal = this.sessionManager.getTerminal(terminalId);
       const parser = this.getParser(terminal.adapter);

       const intervalId = setInterval(async () => {
         const status = this.sessionManager.getStatus(terminalId);

         if (status === TerminalStatus.WAITING_PERMISSION) {
           const output = this.sessionManager.getOutput(terminalId);
           const promptInfo = parser.parse(output);

           if (promptInfo) {
             const result = await this.handlePrompt(terminalId, promptInfo);
             this.respond(terminalId, result.allowed);
           }
         }
       }, this.pollIntervalMs);

       this.activeInterceptors.set(terminalId, intervalId);
       return () => this.stop(terminalId);
     }

     async handlePrompt(terminalId, promptInfo) {
       // Delegate to PermissionManager
       return this.permissionManager.checkPermission(
         promptInfo.toolName,
         promptInfo.args
       );
     }

     respond(terminalId, allowed) {
       const response = allowed ? 'y' : 'n';
       this.sessionManager.sendSpecialKey(terminalId, response);
       this.sessionManager.sendSpecialKey(terminalId, 'Enter');
     }
   }
   ```

5. **Add interceptor-aware PermissionManager helpers**
   ```javascript
   // Add to permission-manager.js

   /**
    * Create permission manager from agent profile
    */
   static fromProfile(profile, workDir) {
     const options = {
       allowedPaths: [workDir],
       logDenials: true
     };

     if (profile.allowedTools) {
       options.allowedTools = profile.allowedTools;
     }

     if (profile.deniedTools) {
       options.deniedTools = profile.deniedTools;
     }

     return new PermissionManager(options);
   }
   ```

#### Phase 3: Integration (Days 5-6)

6. **Update CLI_COMMANDS** (`src/tmux/session-manager.js`)
   ```javascript
   // Add to CLI_COMMANDS['gemini-cli']
   const permissionMode = options.permissionMode || 'auto';
   if (permissionMode === 'interceptor' || permissionMode === 'default') {
     // Don't add yolo mode - interceptor will handle prompts
   } else if (options.yoloMode !== false) {
     args.push('--approval-mode', 'yolo');
   }

   // Similarly for codex-cli
   ```

7. **Update createTerminal** (`src/tmux/session-manager.js`)
   ```javascript
   async createTerminal(options) {
     // ... existing code ...

     // Store permission mode on terminal object
     const terminal = {
       // ... existing fields ...
       permissionMode: options.permissionMode || 'auto',
       permissionManager: options.permissionManager || null
     };

     return terminal;
   }
   ```

8. **Update handoff()** (`src/orchestration/handoff.js`)
   ```javascript
   async function executeHandoffAttempt(agentProfile, message, profile, options) {
     // ... existing code ...

     // Start interceptor if using interceptor mode
     let stopInterceptor = null;
     if (profile.permissionMode === 'interceptor') {
       const interceptor = new PermissionInterceptor({
         sessionManager,
         permissionManager: options.permissionManager ||
           PermissionManager.fromProfile(profile, options.workDir || process.cwd())
       });
       stopInterceptor = interceptor.start(worker.terminalId);
     }

     try {
       // ... existing task execution ...
     } finally {
       // Clean up interceptor
       if (stopInterceptor) stopInterceptor();
     }
   }
   ```

#### Phase 4: Configuration & Testing (Day 7)

9. **Update agent-profiles.json**
   ```json
   {
     "roles": {
       "implement-safe": {
         "description": "Implements with fine-grained permission control",
         "systemPrompt": "...",
         "defaultAdapter": "gemini-cli",
         "timeout": 600,
         "permissionMode": "interceptor",
         "allowedTools": ["Read", "Write", "Edit", "Glob", "Grep"],
         "deniedTools": ["Bash"],
         "allowedPaths": ["/project/src"]
       }
     }
   }
   ```

10. **Create tests** (`tests/test-interceptor.js`)
    - Test prompt parsing for each CLI
    - Test permission evaluation
    - Test auto-response mechanism
    - Test timeout handling
    - Integration test with real CLIs

### 1.7 Edge Cases

| Case | Handling |
|------|----------|
| Prompt appears between polls | Poll faster (250ms) or use file watcher on log |
| Permission denied → CLI exits | Detect error status, propagate to caller |
| Multiple prompts in sequence | Queue responses, process in order |
| Malformed prompt | Log warning, default to deny |
| Interceptor timeout | Stop interceptor, let terminal continue |
| Terminal dies during intercept | Clean up interceptor on terminal destroy |

---

## Feature 2: Agent-to-Agent Discussion

### 2.1 Overview

**Problem**: Current handoff() is one-way: Agent A delegates to Agent B, waits for completion, gets result. No back-and-forth.

**Solution**: Enable bidirectional communication:
- Agent A pauses work, sends question to Agent B
- Agent B receives question, generates response
- Agent A receives response, continues work

### 2.2 Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                        Discussion Manager                                 │
│                                                                          │
│   ┌─────────────┐         ┌─────────────┐         ┌─────────────┐       │
│   │  Agent A    │◀───────▶│   Inbox     │◀───────▶│  Agent B    │       │
│   │ (terminal)  │         │  (sqlite)   │         │ (terminal)  │       │
│   └─────────────┘         └─────────────┘         └─────────────┘       │
│         │                       │                       │               │
│         │    ┌──────────────────┼───────────────────┐   │               │
│         │    │                  ▼                   │   │               │
│         │    │   ┌────────────────────────────┐    │   │               │
│         │    │   │   Discussion Protocol      │    │   │               │
│         │    │   │   - ask_agent tool         │    │   │               │
│         │    │   │   - reply_to_agent tool    │    │   │               │
│         │    │   │   - status: WAITING_ANSWER │    │   │               │
│         │    │   └────────────────────────────┘    │   │               │
│         │    │                                     │   │               │
│         └────┼─────────────────────────────────────┼───┘               │
│              │                                     │                    │
└──────────────┼─────────────────────────────────────┼────────────────────┘
               │                                     │
               ▼                                     ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                          HTTP API / MCP                                  │
│   POST /orchestration/discussions - Start discussion                     │
│   POST /orchestration/discussions/:id/ask - Ask another agent           │
│   GET  /orchestration/discussions/:id/messages - Get messages           │
│   POST /orchestration/discussions/:id/reply - Send reply                 │
└──────────────────────────────────────────────────────────────────────────┘
```

### 2.3 Files to Create

| File | Purpose |
|------|---------|
| `src/orchestration/discussion-manager.js` | Core discussion logic |
| `src/orchestration/discussion-protocol.js` | Message format and validation |
| `src/routes/discussions.js` | HTTP API routes |

### 2.4 Files to Modify

| File | Changes |
|------|---------|
| `src/database/schema.sql` | Add `discussions` table |
| `src/database/db.js` | Add discussion CRUD methods |
| `src/mcp/cliagents-mcp-server.js` | Add `ask_agent` and `reply_to_agent` tools |
| `src/server/orchestration-router.js` | Mount discussion routes |
| `src/models/terminal-status.js` | Add `WAITING_DISCUSSION` status |
| `src/status-detectors/base.js` | Add discussion status detection |

### 2.5 Database Schema

```sql
-- Add to schema.sql

-- Discussions table: Tracks active agent-to-agent conversations
CREATE TABLE IF NOT EXISTS discussions (
    id TEXT PRIMARY KEY,                    -- Discussion ID (UUID)
    task_id TEXT,                           -- Parent task ID (optional)
    initiator_id TEXT NOT NULL,             -- Terminal that started discussion
    status TEXT DEFAULT 'active',           -- 'active', 'completed', 'timeout'
    topic TEXT,                             -- What the discussion is about
    created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
    completed_at INTEGER,
    metadata TEXT                           -- JSON blob
);

-- Discussion messages table
CREATE TABLE IF NOT EXISTS discussion_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    discussion_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,                -- Sender terminal ID
    receiver_id TEXT,                       -- Receiver terminal ID (null for broadcast)
    message_type TEXT NOT NULL,             -- 'question', 'answer', 'info'
    content TEXT NOT NULL,
    status TEXT DEFAULT 'pending',          -- 'pending', 'delivered', 'read'
    created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
    delivered_at INTEGER,
    FOREIGN KEY (discussion_id) REFERENCES discussions(id)
);

CREATE INDEX IF NOT EXISTS idx_discussion_messages_discussion
    ON discussion_messages(discussion_id);
CREATE INDEX IF NOT EXISTS idx_discussion_messages_receiver
    ON discussion_messages(receiver_id, status);
```

### 2.6 Interfaces

#### 2.6.1 DiscussionManager Class

```javascript
/**
 * DiscussionManager - Manages agent-to-agent conversations
 */
class DiscussionManager extends EventEmitter {
  constructor(options: {
    db: Database,
    sessionManager: PersistentSessionManager,
    defaultTimeout: number  // ms, default 60000
  });

  /**
   * Start a new discussion
   * @returns Discussion object with ID
   */
  async startDiscussion(options: {
    initiatorId: string,      // Terminal starting discussion
    taskId?: string,          // Optional parent task
    topic?: string            // What this discussion is about
  }): Promise<Discussion>;

  /**
   * Send a question to another agent
   * Blocks until response received or timeout
   * @returns The answer from the other agent
   */
  async askAgent(options: {
    discussionId: string,
    fromTerminalId: string,   // Asking terminal
    toTerminalId: string,     // Terminal to ask
    question: string,
    timeout?: number          // Override default timeout
  }): Promise<{answer: string, responderId: string}>;

  /**
   * Reply to a question
   */
  async replyToAgent(options: {
    discussionId: string,
    messageId: number,        // ID of question being answered
    fromTerminalId: string,
    answer: string
  }): Promise<void>;

  /**
   * Get pending questions for a terminal
   */
  async getPendingQuestions(terminalId: string): Promise<DiscussionMessage[]>;

  /**
   * Get discussion history
   */
  async getMessages(discussionId: string): Promise<DiscussionMessage[]>;

  /**
   * End a discussion
   */
  async endDiscussion(discussionId: string): Promise<void>;
}

interface Discussion {
  id: string;
  taskId?: string;
  initiatorId: string;
  status: 'active' | 'completed' | 'timeout';
  topic?: string;
  createdAt: number;
}

interface DiscussionMessage {
  id: number;
  discussionId: string;
  senderId: string;
  receiverId?: string;
  messageType: 'question' | 'answer' | 'info';
  content: string;
  status: 'pending' | 'delivered' | 'read';
  createdAt: number;
}
```

#### 2.6.2 MCP Tools Interface

```javascript
// New tools for MCP server

{
  name: 'ask_agent',
  description: `Ask another agent a question and wait for their response.
Use this when you need clarification or input from another agent working on the same task.
The other agent will receive your question and their response will be returned to you.`,
  inputSchema: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'Task ID that both agents are working on'
      },
      targetAgent: {
        type: 'string',
        description: 'Terminal ID or role of the agent to ask (e.g., "planner", "implementer")'
      },
      question: {
        type: 'string',
        description: 'The question to ask'
      },
      timeout: {
        type: 'number',
        description: 'How long to wait for response (seconds, default: 60)'
      }
    },
    required: ['taskId', 'targetAgent', 'question']
  }
}

{
  name: 'reply_to_agent',
  description: 'Reply to a question from another agent.',
  inputSchema: {
    type: 'object',
    properties: {
      messageId: {
        type: 'number',
        description: 'ID of the question message to reply to'
      },
      answer: {
        type: 'string',
        description: 'Your response to the question'
      }
    },
    required: ['messageId', 'answer']
  }
}

{
  name: 'check_pending_questions',
  description: 'Check if any other agents have questions for you.',
  inputSchema: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'Task ID to check for questions'
      }
    }
  }
}
```

### 2.7 Implementation Steps

#### Phase 1: Database & Core (Days 1-2)

1. **Update database schema** (`src/database/schema.sql`)
   - Add `discussions` table
   - Add `discussion_messages` table
   - Add indexes for efficient querying

2. **Add database methods** (`src/database/db.js`)
   ```javascript
   // Discussion methods
   createDiscussion(id, initiatorId, taskId, topic);
   getDiscussion(id);
   updateDiscussionStatus(id, status);

   // Message methods
   addDiscussionMessage(discussionId, senderId, receiverId, type, content);
   getMessageById(messageId);
   getPendingMessagesForTerminal(terminalId);
   markMessageDelivered(messageId);
   markMessageRead(messageId);
   getDiscussionMessages(discussionId);
   ```

3. **Create DiscussionManager** (`src/orchestration/discussion-manager.js`)
   - Core logic for managing discussions
   - Polling mechanism for waiting on responses
   - Timeout handling

#### Phase 2: Discussion Protocol (Days 3-4)

4. **Create discussion protocol** (`src/orchestration/discussion-protocol.js`)
   ```javascript
   /**
    * Inject pending questions into agent's context
    */
   function formatQuestionsForAgent(questions) {
     if (questions.length === 0) return null;

     return `## Pending Questions from Other Agents\n\n` +
       questions.map(q =>
         `**From ${q.senderProfile}** (message #${q.id}):\n${q.content}\n` +
         `Use reply_to_agent with messageId=${q.id} to respond.`
       ).join('\n\n');
   }

   /**
    * Format an answer for delivery
    */
   function formatAnswerForAgent(answer, responderProfile) {
     return `## Answer from ${responderProfile}\n\n${answer}`;
   }
   ```

5. **Add discussion status detection**
   - Add `WAITING_DISCUSSION` to TerminalStatus
   - Update status detectors to detect when agent is waiting for discussion response

#### Phase 3: API Integration (Days 5-6)

6. **Create HTTP routes** (`src/routes/discussions.js`)
   ```javascript
   // POST /orchestration/discussions
   // Start a new discussion
   router.post('/', async (req, res) => {
     const { initiatorId, taskId, topic } = req.body;
     const discussion = await discussionManager.startDiscussion({
       initiatorId, taskId, topic
     });
     res.json(discussion);
   });

   // POST /orchestration/discussions/:id/ask
   // Ask another agent a question
   router.post('/:id/ask', async (req, res) => {
     const { fromTerminalId, toTerminalId, question, timeout } = req.body;
     const answer = await discussionManager.askAgent({
       discussionId: req.params.id,
       fromTerminalId,
       toTerminalId,
       question,
       timeout
     });
     res.json(answer);
   });

   // GET /orchestration/discussions/:id/messages
   router.get('/:id/messages', async (req, res) => {
     const messages = await discussionManager.getMessages(req.params.id);
     res.json({ messages });
   });

   // POST /orchestration/discussions/:id/reply
   router.post('/:id/reply', async (req, res) => {
     const { messageId, fromTerminalId, answer } = req.body;
     await discussionManager.replyToAgent({
       discussionId: req.params.id,
       messageId,
       fromTerminalId,
       answer
     });
     res.json({ success: true });
   });
   ```

7. **Update MCP server** (`src/mcp/cliagents-mcp-server.js`)
   - Add `ask_agent` tool handler
   - Add `reply_to_agent` tool handler
   - Add `check_pending_questions` tool handler

#### Phase 4: Handoff Integration (Day 7)

8. **Update handoff for discussions**
   ```javascript
   // In handoff.js

   /**
    * Build message that includes pending questions
    */
   function buildEnhancedMessageWithQuestions(message, findings, context, pendingQuestions) {
     let enhanced = buildEnhancedMessage(message, findings, context);

     const questionSection = formatQuestionsForAgent(pendingQuestions);
     if (questionSection) {
       enhanced = questionSection + '\n\n---\n\n' + enhanced;
     }

     return enhanced;
   }
   ```

9. **Create workflow support**
   ```javascript
   // Example: Collaborative review workflow
   async function collaborativeReview(taskId, files) {
     const discussion = await discussionManager.startDiscussion({
       taskId,
       topic: 'Code Review Collaboration'
     });

     // Start parallel reviewers
     const [bugReviewer, securityReviewer] = await Promise.all([
       handoff('reviewer-bugs', files, { taskId }),
       handoff('reviewer-security', files, { taskId })
     ]);

     // Security reviewer asks bug reviewer about a finding
     const answer = await discussionManager.askAgent({
       discussionId: discussion.id,
       fromTerminalId: securityReviewer.terminalId,
       toTerminalId: bugReviewer.terminalId,
       question: 'Is the SQL injection in auth.js also a logic bug?'
     });

     // Continue with informed analysis...
   }
   ```

#### Phase 5: Testing & Polish (Days 8-9)

10. **Create tests** (`tests/test-discussions.js`)
    - Unit tests for DiscussionManager
    - Integration tests with real agents
    - Timeout handling tests
    - Concurrent discussion tests

11. **Add observability**
    - Trace discussion events
    - Log question/answer exchanges
    - Emit events for monitoring

### 2.8 Discussion Flow Example

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Collaborative Bug Fix Workflow                                          │
│                                                                         │
│ 1. Planner analyzes bug report                                          │
│    └─▶ Discovers unclear requirement                                    │
│                                                                         │
│ 2. Planner asks Researcher:                                             │
│    "What's the expected behavior for empty input in validateEmail()?"   │
│                                                                         │
│ 3. Researcher:                                                          │
│    └─▶ Searches docs and codebase                                       │
│    └─▶ Responds: "Per RFC 5321, empty strings should return false"      │
│                                                                         │
│ 4. Planner continues with clarified requirements                        │
│    └─▶ Creates implementation plan                                      │
│                                                                         │
│ 5. Implementer receives plan                                            │
│    └─▶ During implementation, asks Planner:                             │
│        "Should I add logging for invalid inputs?"                       │
│                                                                         │
│ 6. Planner responds: "Yes, log at WARN level"                           │
│                                                                         │
│ 7. Implementer completes with consistent approach                       │
└─────────────────────────────────────────────────────────────────────────┘
```

### 2.9 Edge Cases

| Case | Handling |
|------|----------|
| Target agent doesn't respond | Timeout, return error with partial context |
| Target agent has crashed | Detect terminal death, return error immediately |
| Multiple questions pending | Process in FIFO order |
| Circular questions (A asks B, B asks A) | Detect cycle, return error |
| Discussion timeout | Mark discussion as 'timeout', allow recovery |
| Agent disconnects mid-discussion | Mark pending messages as undeliverable |

---

## Implementation Timeline

| Week | Days | Feature | Tasks |
|------|------|---------|-------|
| 1 | 1-2 | Interceptor | Enhanced status detection, prompt parsers |
| 1 | 3-4 | Interceptor | PermissionInterceptor core |
| 1 | 5-7 | Interceptor | Integration, config, testing |
| 2 | 1-2 | Discussion | Database, DiscussionManager core |
| 2 | 3-4 | Discussion | Protocol, status detection |
| 2 | 5-6 | Discussion | API routes, MCP tools |
| 2 | 7 | Discussion | Handoff integration |
| 3 | 1-2 | Both | Integration testing, edge cases |
| 3 | 3 | Both | Documentation, examples |

---

## Testing Strategy

### Interceptor Testing

1. **Unit tests**: Prompt parsing for each CLI
2. **Mock tests**: PermissionManager integration
3. **Integration tests**: Real CLI with permission prompts
4. **E2E tests**: Full handoff with interceptor mode

### Discussion Testing

1. **Unit tests**: DiscussionManager methods
2. **Mock tests**: Database operations
3. **Integration tests**: Two-agent conversation
4. **E2E tests**: Multi-agent workflow with discussions
5. **Stress tests**: Concurrent discussions, timeouts

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| CLI prompt format changes | Interceptor breaks | Abstract parsers, add format versioning |
| Discussion deadlock | Agents stuck waiting | Timeout + cycle detection |
| Performance overhead | Slow operations | Efficient polling, event-driven where possible |
| Database contention | Lost messages | SQLite WAL mode, retry logic |

---

## Success Criteria

### Interceptor
- [ ] Can run Gemini/Codex in non-yolo mode without hanging
- [ ] Permission decisions match PermissionManager rules
- [ ] Less than 1s latency for permission responses
- [ ] Graceful handling of denied permissions

### Discussion
- [ ] Two agents can exchange questions/answers
- [ ] Questions visible in agent context
- [ ] Timeout handling works correctly
- [ ] No message loss under normal operation
- [ ] Works with existing handoff() flow
