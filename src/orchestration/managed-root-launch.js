'use strict';

const crypto = require('crypto');
const { MANAGED_ROOT_ADAPTERS } = require('../adapters/active-surface');

const MANAGED_ROOT_ADAPTER_ALIASES = Object.freeze({
  codex: 'codex-cli',
  'codex-cli': 'codex-cli',
  qwen: 'qwen-cli',
  'qwen-cli': 'qwen-cli',
  gemini: 'gemini-cli',
  'gemini-cli': 'gemini-cli',
  opencode: 'opencode-cli',
  'opencode-cli': 'opencode-cli',
  claude: 'claude-code',
  'claude-code': 'claude-code'
});

const ORIGIN_CLIENT_BY_ADAPTER = Object.freeze({
  'codex-cli': 'codex',
  'qwen-cli': 'qwen',
  'gemini-cli': 'gemini',
  'opencode-cli': 'opencode',
  'claude-code': 'claude'
});

const MANAGED_ROOT_LAUNCH_PROFILES = Object.freeze({
  'guarded-root': Object.freeze({
    id: 'guarded-root',
    description: 'Interactive root with normal approval prompts.',
    permissionMode: 'default'
  }),
  'supervised-root': Object.freeze({
    id: 'supervised-root',
    description: 'Personally supervised root with auto-approvals enabled.',
    permissionMode: 'bypassPermissions'
  }),
  'planning-root': Object.freeze({
    id: 'planning-root',
    description: 'Read-oriented planning/root analysis mode.',
    permissionMode: 'plan'
  })
});

const MANAGED_ROOT_BOOTSTRAP_SKILLS = Object.freeze([
  'broker-collaboration',
  'token-efficient-context',
  'multi-agent-workflow',
  'parallel-agents',
  'agent-handoff'
]);

function normalizeManagedRootAdapter(adapter) {
  const normalized = String(adapter || 'codex-cli').trim().toLowerCase();
  const resolved = MANAGED_ROOT_ADAPTER_ALIASES[normalized] || normalized;
  if (!MANAGED_ROOT_ADAPTERS.includes(resolved)) {
    throw new Error(
      `Unsupported managed root adapter: ${adapter}. Supported: ${MANAGED_ROOT_ADAPTERS.join(', ')}`
    );
  }
  return resolved;
}

function inferManagedRootOriginClient(adapter) {
  const normalizedAdapter = normalizeManagedRootAdapter(adapter);
  return ORIGIN_CLIENT_BY_ADAPTER[normalizedAdapter] || 'system';
}

function buildManagedRootExternalSessionRef(originClient, providedExternalSessionRef = null) {
  if (providedExternalSessionRef) {
    return String(providedExternalSessionRef).trim();
  }
  const normalizedOriginClient = String(originClient || 'system').trim().toLowerCase() || 'system';
  return `${normalizedOriginClient}:managed:${crypto.randomBytes(6).toString('hex')}`;
}

function normalizeManagedRootLaunchProfile(profile) {
  const normalized = String(profile || '').trim().toLowerCase();
  if (!normalized) {
    return MANAGED_ROOT_LAUNCH_PROFILES['guarded-root'];
  }
  const resolved = MANAGED_ROOT_LAUNCH_PROFILES[normalized];
  if (!resolved) {
    throw new Error(
      `Unknown launch profile: ${profile}. Supported: ${Object.keys(MANAGED_ROOT_LAUNCH_PROFILES).join(', ')}`
    );
  }
  return resolved;
}

function getManagedRootLaunchProfiles() {
  return Object.values(MANAGED_ROOT_LAUNCH_PROFILES);
}

function buildManagedRootBootstrapPrompt(options = {}) {
  const profile = normalizeManagedRootLaunchProfile(options.profile);
  const planningMode = profile.id === 'planning-root';
  const roleLine = planningMode
    ? 'You are in planning mode. Stay read-oriented: inspect, plan, and delegate analysis before editing or running risky commands.'
    : 'Act as a single supervised root and use child sessions only when they materially improve the result.';

  return [
    'You are a broker-managed root agent inside cliagents.',
    roleLine,
    'Keep context lean and avoid pasting long transcripts back into prompts.',
    'Discover capabilities instead of guessing: use list_agents for roles and adapters, list_models for exact model catalogs, recommend_model for broker-side model policy on supported adapters, and list_skills/get_skill/invoke_skill for reusable workflows.',
    `Relevant bundled skills often include ${MANAGED_ROOT_BOOTSTRAP_SKILLS.join(', ')}.`,
    'Use delegate_task or run_workflow for new bounded child work. Use reply_to_terminal(terminalId, message) to continue an existing child session directly.',
    'Enumerate your children with list_child_sessions for a lightweight terminal view or get_root_session_status for full root context. list_child_sessions returns terminalId, sessionLabel, sessionKind, adapter, status, and lastActive.',
    'Treat sessionLabel as a broker-side reuse hint, not a guarantee of provider conversation continuity. Choose reply_to_terminal for an exact known child, delegate_task for new bounded work.',
    'Share findings and artifacts with share_finding/store_artifact for concise handoffs.',
    'Do not launch another root unless the human explicitly asks.'
  ].join(' ');
}

function composeManagedRootSystemPrompt(systemPrompt, options = {}) {
  const bootstrap = buildManagedRootBootstrapPrompt(options);
  const trimmed = String(systemPrompt || '').trim();
  if (!trimmed) {
    return bootstrap;
  }
  return `${bootstrap}\n\nAdditional root instructions:\n${trimmed}`;
}

module.exports = {
  MANAGED_ROOT_ADAPTER_ALIASES,
  MANAGED_ROOT_LAUNCH_PROFILES,
  MANAGED_ROOT_BOOTSTRAP_SKILLS,
  normalizeManagedRootAdapter,
  inferManagedRootOriginClient,
  buildManagedRootExternalSessionRef,
  normalizeManagedRootLaunchProfile,
  getManagedRootLaunchProfiles,
  buildManagedRootBootstrapPrompt,
  composeManagedRootSystemPrompt
};
