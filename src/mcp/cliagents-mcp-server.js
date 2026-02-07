#!/usr/bin/env node
/**
 * cliagents MCP Server
 *
 * Exposes cliagents orchestration as MCP tools that Claude Code can invoke.
 * This allows Claude to delegate tasks to other AI agents (Gemini, Codex, etc.)
 *
 * Usage:
 *   Add to Claude Code's MCP settings:
 *   {
 *     "mcpServers": {
 *       "cliagents": {
 *         "command": "node",
 *         "args": ["/path/to/cliagents-mcp-server.js"],
 *         "env": {
 *           "CLIAGENTS_URL": "http://localhost:4001"
 *         }
 *       }
 *     }
 *   }
 */

const http = require('http');
const readline = require('readline');
const { getSkillsService } = require('../services/skills-service');

const CLIAGENTS_URL = process.env.CLIAGENTS_URL || 'http://localhost:4001';

// Default timeouts for different task types (in seconds)
const TIMEOUTS = {
  simple: 180,      // 3 min - simple questions, quick lookups
  standard: 600,    // 10 min - code analysis, reviews
  complex: 1800,    // 30 min - multi-file analysis, large codebases
  unlimited: 0      // No timeout (use async mode instead)
};

// MCP Protocol helpers
function sendResponse(id, result) {
  const response = {
    jsonrpc: '2.0',
    id,
    result
  };
  process.stdout.write(JSON.stringify(response) + '\n');
}

function sendError(id, code, message) {
  const response = {
    jsonrpc: '2.0',
    id,
    error: { code, message }
  };
  process.stdout.write(JSON.stringify(response) + '\n');
}

// HTTP client for cliagents API
async function callCliagents(method, path, body = null, requestTimeout = 600000) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, CLIAGENTS_URL);
    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      headers: { 'Content-Type': 'application/json' },
      timeout: requestTimeout // Configurable timeout for long-running tasks
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => reject(new Error('Request timeout')));

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

// Retry wrapper for quick operations (shared memory, etc.)
async function callWithRetry(method, path, body = null, maxRetries = 3, timeout = 30000) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await callCliagents(method, path, body, timeout);
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries) {
        // Wait before retry (exponential backoff)
        await new Promise(resolve => setTimeout(resolve, attempt * 500));
      }
    }
  }
  throw lastError;
}

// Tool definitions
const TOOLS = [
  {
    name: 'delegate_task',
    description: `Delegate a task to another AI agent via cliagents orchestration. Use this when:
- You need a specialized perspective (security review, performance analysis)
- The task would benefit from a different AI's strengths (Claude for coding, Gemini for research, Codex for review)
- You want parallel execution of independent tasks

**WHY USE THIS:** Subagents use FREE CLI-authenticated tokens (Gemini, Codex) instead of Opus tokens. A code review that costs ~50K Opus tokens costs ~5K when delegated. Use for any task over ~3 tool calls.

**Role + Adapter Model** — choose WHAT to do and WHO does it:

Roles: plan, implement, review, review-security, review-performance, test, fix, research, architect, document

Adapters:
- gemini-cli: Fast (~30s), free, good for research/reviews. NO image support. Watch for boolean logic errors.
- codex-cli: GPT-5 via ChatGPT (free). NO image support. Only 'default' model works. May refuse non-coding tasks without persona override.
- claude-code: Full coding agent with MCP, file editing, image support. Uses Claude tokens (expensive).

**PARALLEL PATTERN (most useful):**
1. Launch multiple tasks with wait=false
2. Poll each with check_task_status until COMPLETED
3. Collect and synthesize results

Example:
  delegate_task(role="review", adapter="gemini-cli", wait=false, message="Review src/...")  → terminalId A
  delegate_task(role="review", adapter="codex-cli", wait=false, message="Review src/...")  → terminalId B
  check_task_status(terminalId=A)  → PROCESSING | COMPLETED with output

Timeout presets: "simple" (3 min), "standard" (10 min, default), "complex" (30 min)

**WHEN NOT TO USE:** Small tasks (<3 tool calls), tasks needing user interaction, anything already in your context.`,
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'The task description to delegate'
        },
        role: {
          type: 'string',
          description: 'Role defining WHAT to do (plan, implement, review, etc.)',
          enum: ['plan', 'implement', 'review', 'review-security', 'review-performance',
                 'test', 'fix', 'research', 'architect', 'document']
        },
        adapter: {
          type: 'string',
          description: 'Adapter defining WHO does it. Optional - uses role default if not specified.',
          enum: ['claude-code', 'gemini-cli', 'codex-cli', 'amazon-q', 'github-copilot']
        },
        profile: {
          type: 'string',
          description: 'LEGACY: Old profile name for backward compatibility. Use role+adapter instead.',
          enum: ['planner', 'implementer', 'reviewer-bugs', 'reviewer-security',
                 'reviewer-performance', 'tester', 'fixer', 'researcher',
                 'architect', 'documenter']
        },
        systemPrompt: {
          type: 'string',
          description: 'Custom system prompt. Optional - uses role default if not specified.'
        },
        timeout: {
          type: 'string',
          description: 'Timeout preset ("simple", "standard", "complex") or seconds. Default: "standard" (10 min)',
          default: 'standard'
        },
        workingDirectory: {
          type: 'string',
          description: 'Working directory for the agent (for code access). Defaults to current project.'
        },
        wait: {
          type: 'boolean',
          description: 'Wait for completion (true) or return immediately with terminal ID (false). Use false for very long tasks.',
          default: true
        }
      },
      required: ['message']
    }
  },
  {
    name: 'run_workflow',
    description: `Execute a predefined multi-agent workflow. Launches multiple subagents (Gemini + Codex + Claude) in parallel or sequence. All subagent tokens are FREE (CLI auth).

Available workflows:
- code-review: 3 PARALLEL agents — bugs (claude-code) + security (gemini-cli) + performance (codex-cli)
- feature: SEQUENTIAL — plan (gemini) → implement (claude) → test (codex)
- bugfix: SEQUENTIAL — research (gemini) → fix (claude) → test (codex)
- full-cycle: Plan → implement → review → test → fix
- research: research (gemini) → document (claude)

**ALWAYS use wait=false** (default). Workflows take 2-10 min. Returns terminal IDs to poll with check_task_status.`,
    inputSchema: {
      type: 'object',
      properties: {
        workflow: {
          type: 'string',
          description: 'Workflow name',
          enum: ['code-review', 'feature', 'bugfix', 'full-cycle', 'research']
        },
        message: {
          type: 'string',
          description: 'Task description for the workflow'
        },
        wait: {
          type: 'boolean',
          description: 'Wait for completion (true) or return immediately with workflow ID (false). Default: false for workflows to avoid timeout.',
          default: false
        },
        timeout: {
          type: 'string',
          description: 'Timeout preset: "standard" (10 min) or "complex" (30 min). Default: "complex"',
          default: 'complex'
        }
      },
      required: ['workflow', 'message']
    }
  },
  {
    name: 'list_agents',
    description: 'List available roles and adapters for task delegation. Shows what roles (plan, implement, review, etc.) are available and which adapters (claude-code, gemini-cli, codex-cli) can execute them.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'get_terminal_output',
    description: 'Get the output from a delegated task terminal',
    inputSchema: {
      type: 'object',
      properties: {
        terminalId: {
          type: 'string',
          description: 'Terminal ID from delegate_task'
        }
      },
      required: ['terminalId']
    }
  },
  {
    name: 'check_task_status',
    description: 'Check the status of an async delegated task. Returns status (processing/completed/failed) and output if available.',
    inputSchema: {
      type: 'object',
      properties: {
        terminalId: {
          type: 'string',
          description: 'Terminal ID from delegate_task with wait=false'
        }
      },
      required: ['terminalId']
    }
  },
  // Shared Memory Tools
  {
    name: 'share_finding',
    description: `Share a finding (bug, security issue, suggestion) with other agents working on the same task.
Use this to communicate discoveries that other agents should know about.
Findings persist across agent sessions and are automatically injected into future handoffs.`,
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'Task identifier (shared across agents working on the same task)'
        },
        agentId: {
          type: 'string',
          description: 'Optional identifier for the agent making this finding (e.g., terminal ID or agent name)'
        },
        type: {
          type: 'string',
          enum: ['bug', 'security', 'performance', 'suggestion', 'info'],
          description: 'Type of finding'
        },
        severity: {
          type: 'string',
          enum: ['critical', 'high', 'medium', 'low', 'info'],
          description: 'Severity level of the finding'
        },
        content: {
          type: 'string',
          description: 'The finding description - be specific and actionable'
        },
        file: {
          type: 'string',
          description: 'File path where the finding is located (optional)'
        },
        line: {
          type: 'number',
          description: 'Line number where the finding is located (optional)'
        }
      },
      required: ['taskId', 'type', 'content']
    }
  },
  {
    name: 'get_shared_findings',
    description: 'Get findings shared by other agents for a task. Use this to see what other agents have discovered.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'Task identifier'
        },
        type: {
          type: 'string',
          enum: ['bug', 'security', 'performance', 'suggestion', 'info'],
          description: 'Filter by finding type (optional)'
        },
        severity: {
          type: 'string',
          enum: ['critical', 'high', 'medium', 'low', 'info'],
          description: 'Filter by severity (optional)'
        }
      },
      required: ['taskId']
    }
  },
  {
    name: 'store_artifact',
    description: `Store a code artifact (code, file, output, plan) for other agents to reference.
Use this to share work products that other agents might need.`,
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'Task identifier'
        },
        agentId: {
          type: 'string',
          description: 'Optional identifier for the agent storing this artifact'
        },
        key: {
          type: 'string',
          description: 'Unique key for this artifact (e.g., "implementation-plan", "test-results")'
        },
        content: {
          type: 'string',
          description: 'The artifact content'
        },
        type: {
          type: 'string',
          enum: ['code', 'file', 'output', 'plan'],
          description: 'Type of artifact'
        }
      },
      required: ['taskId', 'key', 'content', 'type']
    }
  },
  // Skills System Tools
  {
    name: 'list_skills',
    description: `List available skills. Skills are reusable workflows for domain-specific tasks.

Skills are discovered from three locations (in priority order):
1. Project skills: .cliagents/skills/
2. Personal skills: ~/.cliagents/skills/
3. Core skills: bundled with cliagents

Each skill includes metadata about compatible adapters and tags for discovery.`,
    inputSchema: {
      type: 'object',
      properties: {
        tag: {
          type: 'string',
          description: 'Filter by tag (e.g., "debugging", "workflow", "orchestration")'
        },
        adapter: {
          type: 'string',
          description: 'Filter by compatible adapter (e.g., "claude-code", "gemini-cli")'
        }
      }
    }
  },
  {
    name: 'invoke_skill',
    description: `Invoke a skill to get structured guidance for a task. Returns skill content that you should follow.

Skills provide domain-specific workflows and best practices. When you invoke a skill, follow the returned instructions to complete your task.

Example skills:
- test-driven-development: RED-GREEN-REFACTOR cycle
- debugging: Systematic root-cause analysis
- code-review: Multi-perspective review workflow
- multi-agent-workflow: Orchestrate across multiple agents`,
    inputSchema: {
      type: 'object',
      properties: {
        skill: {
          type: 'string',
          description: 'Skill name to invoke'
        },
        message: {
          type: 'string',
          description: 'Task context or description to pass to the skill'
        }
      },
      required: ['skill']
    }
  },
  {
    name: 'get_skill',
    description: 'Get full skill content and metadata without invoking. Use this to preview a skill before using it.',
    inputSchema: {
      type: 'object',
      properties: {
        skill: {
          type: 'string',
          description: 'Skill name to retrieve'
        }
      },
      required: ['skill']
    }
  }
];

// Tool handlers
async function handleDelegateTask(args) {
  const {
    message,
    // New API: role + adapter
    role,
    adapter,
    systemPrompt,
    // Legacy API: profile
    profile,
    // Common options
    wait = true,
    timeout = 'standard',
    workingDirectory
  } = args;

  // Require either role (new API) or profile (legacy API)
  if (!role && !profile) {
    throw new Error('Either role or profile is required');
  }

  // Resolve timeout value
  let timeoutSeconds;
  if (typeof timeout === 'number') {
    timeoutSeconds = timeout;
  } else if (TIMEOUTS[timeout]) {
    timeoutSeconds = TIMEOUTS[timeout];
  } else {
    timeoutSeconds = parseInt(timeout, 10) || TIMEOUTS.standard;
  }

  // Build the handoff request with new or legacy API
  const handoffRequest = {
    message,
    timeout: timeoutSeconds
  };

  // Determine the profile identifier for display
  let profileDisplay;

  if (role) {
    // New API: pass role, adapter, and optional systemPrompt
    handoffRequest.role = role;
    if (adapter) handoffRequest.adapter = adapter;
    if (systemPrompt) handoffRequest.systemPrompt = systemPrompt;
    profileDisplay = adapter ? `${role}_${adapter}` : role;
  } else {
    // Legacy API: pass profile name
    handoffRequest.agentProfile = profile;
    profileDisplay = profile;
  }

  // Add working directory if specified
  if (workingDirectory) {
    handoffRequest.workingDirectory = workingDirectory;
  }

  if (wait) {
    // Use handoff endpoint - it sends message, waits for completion, returns output
    // HTTP timeout should be slightly longer than task timeout
    const httpTimeout = (timeoutSeconds + 60) * 1000;
    const handoffRes = await callCliagents('POST', '/orchestration/handoff', handoffRequest, httpTimeout);

    if (handoffRes.status !== 200) {
      throw new Error(`Handoff failed: ${JSON.stringify(handoffRes.data)}`);
    }

    const { output, adapter: usedAdapter, terminalId } = handoffRes.data;

    return {
      content: [{
        type: 'text',
        text: `## ${profileDisplay} (${usedAdapter}) Response\n\n${output || 'No output captured'}`
      }]
    };
  }

  // Async mode: just route the task, return terminal ID for later polling
  const routeRequest = { message };
  if (role) {
    routeRequest.forceRole = role;
    if (adapter) routeRequest.forceAdapter = adapter;
  } else {
    routeRequest.forceProfile = profile;
  }
  if (workingDirectory) {
    routeRequest.workingDirectory = workingDirectory;
  }

  const routeRes = await callCliagents('POST', '/orchestration/route', routeRequest);

  if (routeRes.status !== 200) {
    throw new Error(`Routing failed: ${JSON.stringify(routeRes.data)}`);
  }

  const { terminalId, adapter: usedAdapter, taskType } = routeRes.data;

  return {
    content: [{
      type: 'text',
      text: `Task delegated to ${profileDisplay} (${usedAdapter}).\nTerminal ID: ${terminalId}\nTask type: ${taskType}\n\nUse get_terminal_output to check results later.`
    }]
  };
}

async function handleRunWorkflow(args) {
  const { workflow, message, wait = false, timeout = 'complex' } = args;

  // Resolve timeout
  let timeoutSeconds = TIMEOUTS[timeout] || TIMEOUTS.complex;
  const httpTimeout = (timeoutSeconds + 60) * 1000;

  if (wait) {
    // Synchronous mode - wait for full completion (may timeout for long workflows)
    const res = await callCliagents('POST', `/orchestration/workflows/${workflow}`, {
      message
    }, httpTimeout);

    if (res.status !== 200) {
      throw new Error(`Workflow failed: ${JSON.stringify(res.data)}`);
    }

    const results = res.data.results || [];
    const formattedResults = results.map(r =>
      `### ${r.profile} (${r.type})\n${r.output || 'No output'}`
    ).join('\n\n---\n\n');

    return {
      content: [{
        type: 'text',
        text: `## Workflow: ${workflow}\n\nStatus: ${res.data.status}\n\n${formattedResults}`
      }]
    };
  }

  // Async mode (default) - start workflow and return immediately
  // First, start each workflow step as separate delegated tasks
  const workflowSteps = {
    'code-review': [
      { role: 'review', adapter: 'claude-code' },
      { role: 'review-security', adapter: 'gemini-cli' },
      { role: 'review-performance', adapter: 'codex-cli' }
    ],
    'feature': [
      { role: 'plan', adapter: 'gemini-cli' },
      { role: 'implement', adapter: 'claude-code' },
      { role: 'test', adapter: 'codex-cli' }
    ],
    'bugfix': [
      { role: 'research', adapter: 'gemini-cli' },
      { role: 'fix', adapter: 'claude-code' },
      { role: 'test', adapter: 'codex-cli' }
    ],
    'research': [
      { role: 'research', adapter: 'gemini-cli' },
      { role: 'document', adapter: 'claude-code' }
    ]
  };

  const steps = workflowSteps[workflow];
  if (!steps) {
    throw new Error(`Unknown workflow: ${workflow}. Use wait=true for full-cycle workflow.`);
  }

  // Start all steps in parallel (async)
  const terminalIds = [];
  for (const step of steps) {
    const routeRes = await callCliagents('POST', '/orchestration/route', {
      message,
      forceRole: step.role,
      forceAdapter: step.adapter
    });

    if (routeRes.status === 200) {
      terminalIds.push({
        role: step.role,
        adapter: step.adapter,
        terminalId: routeRes.data.terminalId
      });
    }
  }

  return {
    content: [{
      type: 'text',
      text: `## Workflow Started: ${workflow}\n\n**Mode:** Async (use check_task_status to poll)\n\n**Steps launched:**\n${terminalIds.map(t => `- ${t.role} (${t.adapter}): \`${t.terminalId}\``).join('\n')}\n\nUse \`check_task_status({ terminalId: "..." })\` to check each step's progress.`
    }]
  };
}

async function handleListAgents() {
  // Fetch roles and adapters (new v3 API)
  const [rolesRes, adaptersRes] = await Promise.all([
    callCliagents('GET', '/orchestration/roles'),
    callCliagents('GET', '/orchestration/adapters')
  ]);

  let output = '# Available Agent Configurations\n\n';

  // Format roles
  if (rolesRes.status === 200 && rolesRes.data.roles) {
    const roles = rolesRes.data.roles;
    output += '## Roles (WHAT to do)\n\n';
    output += Object.entries(roles)
      .map(([name, config]) =>
        `- **${name}** → default: ${config.defaultAdapter}\n  ${config.description || ''}`
      ).join('\n');
    output += '\n\n';
  }

  // Format adapters
  if (adaptersRes.status === 200 && adaptersRes.data.adapters) {
    const adapters = adaptersRes.data.adapters;
    output += '## Adapters (WHO does it)\n\n';
    output += Object.entries(adapters)
      .map(([name, config]) =>
        `- **${name}**: ${config.description || ''}\n  Capabilities: ${(config.capabilities || []).join(', ')}`
      ).join('\n');
    output += '\n\n';
  }

  output += '## Usage\n\n';
  output += 'Use role with default adapter:\n';
  output += '```json\n{ "role": "implement", "message": "..." }\n```\n\n';
  output += 'Override adapter:\n';
  output += '```json\n{ "role": "implement", "adapter": "gemini-cli", "message": "..." }\n```';

  return {
    content: [{
      type: 'text',
      text: output
    }]
  };
}

async function handleGetTerminalOutput(args) {
  const { terminalId } = args;

  const res = await callCliagents('GET', `/orchestration/terminals/${terminalId}/output`);

  if (res.status !== 200) {
    throw new Error(`Failed to get output: ${JSON.stringify(res.data)}`);
  }

  return {
    content: [{
      type: 'text',
      text: res.data?.output || 'No output available'
    }]
  };
}

async function handleCheckTaskStatus(args) {
  const { terminalId } = args;

  // Get terminal status
  const statusRes = await callCliagents('GET', `/orchestration/terminals/${terminalId}`);

  if (statusRes.status === 404) {
    return {
      content: [{
        type: 'text',
        text: `Terminal ${terminalId} not found. It may have been cleaned up after completion.`
      }]
    };
  }

  if (statusRes.status !== 200) {
    throw new Error(`Failed to get status: ${JSON.stringify(statusRes.data)}`);
  }

  const { status, adapter, agentProfile } = statusRes.data;

  // If completed, also get output
  if (status === 'completed' || status === 'idle') {
    const outputRes = await callCliagents('GET', `/orchestration/terminals/${terminalId}/output`);
    const output = outputRes.data?.output || 'No output captured';

    return {
      content: [{
        type: 'text',
        text: `## Task Status: COMPLETED\n\n**Profile:** ${agentProfile}\n**Adapter:** ${adapter}\n\n### Output:\n${output}`
      }]
    };
  }

  return {
    content: [{
      type: 'text',
      text: `## Task Status: ${status.toUpperCase()}\n\n**Profile:** ${agentProfile}\n**Adapter:** ${adapter}\n\nTask is still running. Check again later with check_task_status.`
    }]
  };
}

// Shared Memory Handlers
async function handleShareFinding(args) {
  const { taskId, agentId, type, severity, content, file, line } = args;

  // Use retry wrapper for reliability
  const res = await callWithRetry('POST', '/orchestration/memory/findings', {
    taskId,
    agentId: agentId || 'mcp-client',
    content,
    type,
    severity,
    metadata: { file, line }
  });

  if (res.status !== 200) {
    throw new Error(`Failed to store finding: ${JSON.stringify(res.data)}`);
  }

  return {
    content: [{
      type: 'text',
      text: `Finding stored successfully.\n**ID:** ${res.data.id}\n**Task:** ${taskId}\n**Type:** ${type}\n**Severity:** ${severity || 'info'}`
    }]
  };
}

async function handleGetSharedFindings(args) {
  const { taskId, type, severity } = args;

  let path = `/orchestration/memory/findings/${taskId}`;
  const params = [];
  if (type) params.push(`type=${type}`);
  if (severity) params.push(`severity=${severity}`);
  if (params.length > 0) path += `?${params.join('&')}`;

  // Use retry wrapper for reliability
  const res = await callWithRetry('GET', path);

  if (res.status !== 200) {
    throw new Error(`Failed to get findings: ${JSON.stringify(res.data)}`);
  }

  const findings = res.data.findings || [];

  if (findings.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `No findings found for task: ${taskId}`
      }]
    };
  }

  const formatted = findings.map(f => {
    const meta = f.metadata || {};
    const location = meta.file ? `\n  Location: ${meta.file}${meta.line ? `:${meta.line}` : ''}` : '';
    return `- **[${f.severity || 'info'}/${f.type}]** ${f.content}${location}\n  From: ${f.agent_profile || f.agent_id}`;
  }).join('\n\n');

  return {
    content: [{
      type: 'text',
      text: `## Findings for Task: ${taskId}\n\n${formatted}`
    }]
  };
}

async function handleStoreArtifact(args) {
  const { taskId, agentId, key, content, type } = args;

  // Use retry wrapper for reliability
  const res = await callWithRetry('POST', '/orchestration/memory/artifacts', {
    taskId,
    key,
    content,
    type,
    agentId: agentId || 'mcp-client'
  });

  if (res.status !== 200) {
    throw new Error(`Failed to store artifact: ${JSON.stringify(res.data)}`);
  }

  return {
    content: [{
      type: 'text',
      text: `Artifact stored successfully.\n**Key:** ${key}\n**Type:** ${type}\n**Task:** ${taskId}`
    }]
  };
}

// Skills System Handlers
async function handleListSkills(args) {
  const { tag, adapter } = args || {};
  const skillsService = getSkillsService();

  const skills = skillsService.listSkills({ tag, adapter });

  if (skills.length === 0) {
    let message = 'No skills found.';
    if (tag) message += ` No skills match tag "${tag}".`;
    if (adapter) message += ` No skills compatible with adapter "${adapter}".`;
    return {
      content: [{
        type: 'text',
        text: message
      }]
    };
  }

  // Group by source for display
  const bySource = { project: [], personal: [], core: [] };
  for (const skill of skills) {
    bySource[skill.source].push(skill);
  }

  let output = '# Available Skills\n\n';

  for (const [source, sourceSkills] of Object.entries(bySource)) {
    if (sourceSkills.length === 0) continue;

    output += `## ${source.charAt(0).toUpperCase() + source.slice(1)} Skills\n\n`;
    for (const skill of sourceSkills) {
      output += `### ${skill.name}\n`;
      output += `${skill.description || 'No description'}\n`;
      if (skill.tags.length > 0) {
        output += `Tags: ${skill.tags.join(', ')}\n`;
      }
      if (skill.adapters.length > 0) {
        output += `Adapters: ${skill.adapters.join(', ')}\n`;
      }
      output += '\n';
    }
  }

  output += `\n---\nTotal: ${skills.length} skills`;
  if (tag) output += ` (filtered by tag: ${tag})`;
  if (adapter) output += ` (filtered by adapter: ${adapter})`;

  return {
    content: [{
      type: 'text',
      text: output
    }]
  };
}

async function handleInvokeSkill(args) {
  const { skill, message } = args;
  const skillsService = getSkillsService();

  const result = await skillsService.invokeSkill(skill, { message });

  if (!result.success) {
    return {
      content: [{
        type: 'text',
        text: `Error invoking skill: ${result.error}`
      }]
    };
  }

  return {
    content: [{
      type: 'text',
      text: result.prompt
    }]
  };
}

async function handleGetSkill(args) {
  const { skill } = args;
  const skillsService = getSkillsService();

  const skillData = skillsService.loadSkill(skill);

  if (!skillData) {
    return {
      content: [{
        type: 'text',
        text: `Skill not found: ${skill}`
      }]
    };
  }

  let output = `# Skill: ${skillData.name}\n\n`;
  output += `**Description:** ${skillData.description || 'No description'}\n`;
  output += `**Source:** ${skillData.source}\n`;
  if (skillData.tags.length > 0) {
    output += `**Tags:** ${skillData.tags.join(', ')}\n`;
  }
  if (skillData.adapters.length > 0) {
    output += `**Compatible Adapters:** ${skillData.adapters.join(', ')}\n`;
  }
  output += `\n---\n\n`;
  output += skillData.content;

  return {
    content: [{
      type: 'text',
      text: output
    }]
  };
}

// MCP request handler
async function handleRequest(request) {
  const { id, method, params } = request;

  try {
    switch (method) {
      case 'initialize':
        return sendResponse(id, {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: {
            name: 'cliagents',
            version: '1.0.0'
          }
        });

      case 'tools/list':
        return sendResponse(id, { tools: TOOLS });

      case 'tools/call':
        const { name, arguments: args } = params;
        let result;

        switch (name) {
          case 'delegate_task':
            result = await handleDelegateTask(args);
            break;
          case 'run_workflow':
            result = await handleRunWorkflow(args);
            break;
          case 'list_agents':
            result = await handleListAgents();
            break;
          case 'get_terminal_output':
            result = await handleGetTerminalOutput(args);
            break;
          case 'check_task_status':
            result = await handleCheckTaskStatus(args);
            break;
          // Shared Memory Tools
          case 'share_finding':
            result = await handleShareFinding(args);
            break;
          case 'get_shared_findings':
            result = await handleGetSharedFindings(args);
            break;
          case 'store_artifact':
            result = await handleStoreArtifact(args);
            break;
          // Skills System Tools
          case 'list_skills':
            result = await handleListSkills(args);
            break;
          case 'invoke_skill':
            result = await handleInvokeSkill(args);
            break;
          case 'get_skill':
            result = await handleGetSkill(args);
            break;
          default:
            return sendError(id, -32601, `Unknown tool: ${name}`);
        }

        return sendResponse(id, result);

      default:
        return sendError(id, -32601, `Unknown method: ${method}`);
    }
  } catch (error) {
    return sendError(id, -32000, error.message);
  }
}

// Main: Read JSON-RPC from stdin
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

rl.on('line', async (line) => {
  try {
    const request = JSON.parse(line);
    await handleRequest(request);
  } catch (error) {
    // Ignore parse errors for non-JSON lines
  }
});

// Handle shutdown gracefully
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
