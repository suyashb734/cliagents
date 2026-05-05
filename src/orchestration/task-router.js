/**
 * TaskRouter - Intelligent routing of coding tasks to appropriate agents
 *
 * Routes tasks based on:
 * - Task type (plan, implement, review, test, fix)
 * - Complexity analysis
 * - Agent capabilities and availability
 */

const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { getAgentProfiles, resolveProfile } = require('../services/agent-profiles');
const { getModelRoutingService } = require('../services/model-routing');
const { isAdapterAuthenticated } = require('../utils/adapter-auth');
const { getChildSessionSupport } = require('./child-session-support');
const { AdapterReadinessService } = require('./adapter-readiness');

// Task types and their default agent mappings
const TASK_TYPES = {
  PLAN: 'plan',
  IMPLEMENT: 'implement',
  REVIEW_BUGS: 'review-bugs',
  REVIEW_SECURITY: 'review-security',
  REVIEW_PERFORMANCE: 'review-performance',
  TEST: 'test',
  FIX: 'fix',
  RESEARCH: 'research',
  DOCUMENT: 'document',
  ARCHITECT: 'architect'
};

// Keywords for task type detection
const TASK_KEYWORDS = {
  [TASK_TYPES.PLAN]: ['plan', 'design', 'outline', 'strategy', 'approach', 'how to', 'steps to'],
  [TASK_TYPES.IMPLEMENT]: ['implement', 'build', 'create', 'add', 'write code', 'develop', 'make'],
  [TASK_TYPES.REVIEW_BUGS]: ['bug', 'error', 'issue', 'problem', 'fix', 'debug', 'broken'],
  [TASK_TYPES.REVIEW_SECURITY]: ['security', 'vulnerability', 'injection', 'auth', 'owasp', 'xss', 'csrf'],
  [TASK_TYPES.REVIEW_PERFORMANCE]: ['performance', 'slow', 'optimize', 'speed', 'memory', 'bottleneck'],
  [TASK_TYPES.TEST]: ['test', 'coverage', 'unit test', 'integration test', 'e2e'],
  [TASK_TYPES.FIX]: ['fix', 'patch', 'resolve', 'repair', 'correct'],
  [TASK_TYPES.RESEARCH]: ['research', 'find', 'look up', 'documentation', 'how does', 'what is'],
  [TASK_TYPES.DOCUMENT]: ['document', 'readme', 'comment', 'explain', 'describe'],
  [TASK_TYPES.ARCHITECT]: ['architecture', 'structure', 'refactor', 'reorganize', 'pattern']
};

// Default agent profile for each task type
const TASK_TO_PROFILE = {
  [TASK_TYPES.PLAN]: 'planner',
  [TASK_TYPES.IMPLEMENT]: 'implementer',
  [TASK_TYPES.REVIEW_BUGS]: 'reviewer-bugs',
  [TASK_TYPES.REVIEW_SECURITY]: 'reviewer-security',
  [TASK_TYPES.REVIEW_PERFORMANCE]: 'reviewer-performance',
  [TASK_TYPES.TEST]: 'tester',
  [TASK_TYPES.FIX]: 'fixer',
  [TASK_TYPES.RESEARCH]: 'researcher',
  [TASK_TYPES.DOCUMENT]: 'documenter',
  [TASK_TYPES.ARCHITECT]: 'architect'
};

const TASK_TO_ROLE = {
  [TASK_TYPES.PLAN]: 'plan',
  [TASK_TYPES.IMPLEMENT]: 'implement',
  [TASK_TYPES.REVIEW_BUGS]: 'review',
  [TASK_TYPES.REVIEW_SECURITY]: 'review-security',
  [TASK_TYPES.REVIEW_PERFORMANCE]: 'review-performance',
  [TASK_TYPES.TEST]: 'test',
  [TASK_TYPES.FIX]: 'fix',
  [TASK_TYPES.RESEARCH]: 'research',
  [TASK_TYPES.DOCUMENT]: 'document',
  [TASK_TYPES.ARCHITECT]: 'architect'
};

// Workflow templates for complex tasks
const WORKFLOWS = {
  // Full development cycle: plan → implement → review → test → fix
  'full-cycle': {
    name: 'Full Development Cycle',
    description: 'Complete workflow from planning to tested implementation',
    steps: [
      { profile: 'planner', type: 'plan', passOutput: true },
      { profile: 'implementer', type: 'implement', passOutput: true },
      { profile: 'reviewer-bugs', type: 'review-bugs', parallel: true },
      { profile: 'reviewer-security', type: 'review-security', parallel: true },
      { profile: 'tester', type: 'test', passOutput: true },
      { profile: 'fixer', type: 'fix', condition: 'hasIssues' }
    ]
  },

  // Code review: multiple reviewers in parallel
  'code-review': {
    name: 'Comprehensive Code Review',
    description: 'Parallel review for bugs, security, and performance',
    steps: [
      { profile: 'reviewer-bugs', type: 'review-bugs', parallel: true },
      { profile: 'reviewer-security', type: 'review-security', parallel: true },
      { profile: 'reviewer-performance', type: 'review-performance', parallel: true }
    ],
    aggregateResults: true
  },

  // Feature development: plan → implement → test
  'feature': {
    name: 'Feature Development',
    description: 'Plan, implement, and test a new feature',
    steps: [
      { profile: 'planner', type: 'plan', passOutput: true },
      { profile: 'implementer', type: 'implement', passOutput: true },
      { profile: 'tester', type: 'test' }
    ]
  },

  // Bug fix: analyze → fix → test
  'bugfix': {
    name: 'Bug Fix',
    description: 'Analyze bug, fix it, verify with tests',
    steps: [
      { profile: 'reviewer-bugs', type: 'review-bugs', passOutput: true },
      { profile: 'fixer', type: 'fix', passOutput: true },
      { profile: 'tester', type: 'test' }
    ]
  },

  // Research and document
  'research': {
    name: 'Research & Document',
    description: 'Research a topic and create documentation',
    steps: [
      { profile: 'researcher', type: 'research', passOutput: true },
      { profile: 'documenter', type: 'document' }
    ]
  }
};

class TaskRouter extends EventEmitter {
  constructor(sessionManager, options = {}) {
    super();
    this.sessionManager = sessionManager;
    this.apiSessionManager = options.apiSessionManager || null;
    this.adapterAuthInspector = typeof options.adapterAuthInspector === 'function'
      ? options.adapterAuthInspector
      : isAdapterAuthenticated;
    this.profilesPath = options.profilesPath || path.join(process.cwd(), 'config', 'agent-profiles.json');
    this.modelRoutingPath = options.modelRoutingPath || path.join(process.cwd(), 'config', 'model-routing.json');
    this.profileService = getAgentProfiles({ configPath: this.profilesPath });
    this.modelRoutingService = getModelRoutingService({ configPath: this.modelRoutingPath });
    this.adapterReadinessService = options.adapterReadinessService || new AdapterReadinessService({
      db: options.db || null,
      apiSessionManager: this.apiSessionManager,
      adapterAuthInspector: this.adapterAuthInspector,
      profileService: this.profileService
    });
    this.activeWorkflows = new Map();
  }

  async _getRuntimeAdapterInfo(adapterName) {
    if (!this.apiSessionManager || typeof this.apiSessionManager.getAdapter !== 'function') {
      return {
        registered: false,
        available: null,
        authenticated: null,
        authenticationReason: null,
        capabilities: null,
        childSessionSupport: getChildSessionSupport(adapterName, null),
        contract: null
      };
    }

    const adapter = this.apiSessionManager.getAdapter(adapterName);
    if (!adapter) {
      return {
        registered: false,
        available: null,
        authenticated: null,
        authenticationReason: null,
        capabilities: null,
        childSessionSupport: getChildSessionSupport(adapterName, null),
        contract: null
      };
    }

    let available = null;
    try {
      available = await adapter.isAvailable();
    } catch {
      available = false;
    }

    const auth = this.adapterAuthInspector(adapterName) || {
      authenticated: false,
      reason: 'Adapter authentication could not be determined'
    };
    const capabilities = typeof adapter.getCapabilities === 'function' ? adapter.getCapabilities() : null;
    const staticChildSessionSupport = getChildSessionSupport(adapterName, capabilities);
    let adapterReadiness = null;
    let childSessionSupport = staticChildSessionSupport;
    try {
      if (this.adapterReadinessService?.getAdapterReadiness) {
        adapterReadiness = await this.adapterReadinessService.getAdapterReadiness(adapterName);
        childSessionSupport = adapterReadiness.childSessionSupport || staticChildSessionSupport;
      }
    } catch (error) {
      adapterReadiness = {
        warnings: [{
          code: 'readiness_store_unavailable',
          message: error.message
        }]
      };
    }
    const effectiveReadiness = adapterReadiness?.effective || null;

    return {
      registered: true,
      available: effectiveReadiness?.available ?? available,
      authenticated: effectiveReadiness?.authenticated ?? auth.authenticated,
      authenticationReason: effectiveReadiness?.authReason ?? auth.reason,
      models: typeof adapter.getAvailableModels === 'function' ? adapter.getAvailableModels() : [],
      runtimeProviders: typeof adapter.getProviderSummary === 'function' ? adapter.getProviderSummary() : [],
      capabilities,
      childSessionSupport,
      adapterReadiness,
      contract: typeof adapter.getContract === 'function' ? adapter.getContract() : null
    };
  }

  async recommendModel(options = {}) {
    const adapter = options.adapter || null;
    if (!adapter) {
      throw new Error('adapter is required');
    }

    const runtimeAdapter = await this._getRuntimeAdapterInfo(adapter);
    return this.modelRoutingService.recommendModel({
      adapter,
      role: options.role || null,
      taskType: options.taskType || null,
      availableModels: runtimeAdapter.models || [],
      runtimeProviders: runtimeAdapter.runtimeProviders || []
    });
  }

  _buildRoleAdapterCandidates(roleName, preferredAdapter) {
    const role = this.profileService.getRole(roleName);
    const adapters = this.profileService.listAdapters();
    const ordered = [];

    const pushAdapter = (adapterName) => {
      if (adapterName && !ordered.includes(adapterName)) {
        ordered.push(adapterName);
      }
    };

    pushAdapter(preferredAdapter);
    pushAdapter(role?.defaultAdapter);

    for (const adapterName of adapters) {
      pushAdapter(adapterName);
    }

    return ordered;
  }

  _scoreRoleAdapterCandidate({ roleName, adapterName, preferredAdapter, runtimeAdapter, configuredAdapter, requireCollaboratorReady = false }) {
    let score = 0;
    const reasons = [];
    const capabilities = runtimeAdapter.capabilities || null;
    const capabilityObject = capabilities || {};
    const childSessionSupport = runtimeAdapter.childSessionSupport || getChildSessionSupport(adapterName, capabilities);
    const declaredCapabilities = new Set([
      ...(configuredAdapter?.capabilities || []),
      ...Object.entries(capabilityObject)
        .filter(([, value]) => value === true)
        .map(([key]) => key)
    ]);

    const role = this.profileService.getRole(roleName);
    if (preferredAdapter && adapterName === preferredAdapter) {
      score += 1000;
      reasons.push('explicit-adapter');
    } else if (role?.defaultAdapter === adapterName) {
      score += 300;
      reasons.push('role-default');
    }

    if (runtimeAdapter.registered) {
      score += 50;
      reasons.push('runtime-registered');
    }

    if (runtimeAdapter.available === true) {
      score += 200;
      reasons.push('runtime-available');
    } else if (runtimeAdapter.available === false) {
      score -= 5000;
      reasons.push('runtime-unavailable');
    }

    if (runtimeAdapter.authenticated === true) {
      score += 150;
      reasons.push('authenticated');
    } else if (runtimeAdapter.authenticated === false) {
      score -= 2000;
      reasons.push('not-authenticated');
    }

    if (capabilityObject.executionMode === 'direct-session') {
      score += 25;
      reasons.push('direct-session');
    }
    if (capabilityObject.supportsSystemPrompt) {
      score += 25;
      reasons.push('supports-system-prompt');
    }
    if (capabilityObject.supportsMultiTurn) {
      score += 20;
      reasons.push('supports-multi-turn');
    }
    if (capabilityObject.supportsFilesystemWrite) {
      score += 20;
      reasons.push('supports-filesystem-write');
    }
    if (childSessionSupport.ephemeralReady === true) {
      score += 30;
      reasons.push('ephemeral-ready');
    } else {
      score -= 8000;
      reasons.push(`not-ephemeral-ready:${childSessionSupport.reason || 'unsupported'}`);
    }
    if (childSessionSupport.collaboratorReady === true) {
      score += 15;
      reasons.push('collaborator-ready');
    } else if (requireCollaboratorReady) {
      score -= 8000;
      reasons.push(`not-collaborator-ready:${childSessionSupport.reason || 'unsupported'}`);
    }

    if ((roleName === TASK_TYPES.PLAN || roleName === TASK_TYPES.ARCHITECT) && declaredCapabilities.has('reasoning')) {
      score += 30;
      reasons.push('role-capability:reasoning');
    }
    if (roleName === TASK_TYPES.RESEARCH && declaredCapabilities.has('web-search')) {
      score += 30;
      reasons.push('role-capability:web-search');
    }
    if (
      (roleName === TASK_TYPES.REVIEW_BUGS ||
       roleName === TASK_TYPES.REVIEW_SECURITY ||
       roleName === TASK_TYPES.REVIEW_PERFORMANCE) &&
      declaredCapabilities.has('code-review')
    ) {
      score += 30;
      reasons.push('role-capability:code-review');
    }
    if ((roleName === TASK_TYPES.IMPLEMENT || roleName === TASK_TYPES.FIX || roleName === TASK_TYPES.TEST) && declaredCapabilities.has('file-edit')) {
      score += 30;
      reasons.push('role-capability:file-edit');
    }

    return { score, reasons };
  }

  async _resolveProfileForRole(roleName, preferredAdapter, options = {}) {
    const configuredAdapters = this.profileService.listAdapters();
    if (preferredAdapter && !configuredAdapters.includes(preferredAdapter)) {
      throw new Error(
        `Adapter '${preferredAdapter}' is not configured for role '${roleName}'. ` +
        `Configured adapters: ${configuredAdapters.join(', ')}`
      );
    }

    const candidateAdapters = this._buildRoleAdapterCandidates(roleName, preferredAdapter);
    const candidates = [];

    for (const adapterName of candidateAdapters) {
      const profile = this.profileService.getProfileByRoleAndAdapter(roleName, adapterName);
      if (!profile) {
        continue;
      }

      const configuredAdapter = this.profileService.getAdapter(adapterName);
      const runtimeAdapter = await this._getRuntimeAdapterInfo(adapterName);
      const { score, reasons } = this._scoreRoleAdapterCandidate({
        roleName,
        adapterName,
        preferredAdapter,
        runtimeAdapter,
        configuredAdapter,
        requireCollaboratorReady: options.requireCollaboratorReady === true
      });

      candidates.push({
        adapter: adapterName,
        profile,
        runtimeAdapter,
        configuredAdapter,
        score,
        reasons,
        order: candidates.length
      });
    }

    if (candidates.length === 0) {
      throw new Error(`Could not resolve any adapter for role '${roleName}'`);
    }

    candidates.sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.order - right.order;
    });

    const preferredCandidate = preferredAdapter
      ? candidates.find((candidate) => candidate.adapter === preferredAdapter)
      : null;

    if (preferredAdapter && !preferredCandidate) {
      throw new Error(`Adapter '${preferredAdapter}' is not available for role '${roleName}'`);
    }

    if (preferredAdapter && preferredCandidate && (preferredCandidate.runtimeAdapter.available === false || preferredCandidate.runtimeAdapter.authenticated === false)) {
      throw new Error(
        `Adapter '${preferredAdapter}' is not healthy for role '${roleName}': ${preferredCandidate.runtimeAdapter.authenticationReason || 'adapter unavailable'}`
      );
    }
    if (preferredAdapter && preferredCandidate && preferredCandidate.runtimeAdapter.childSessionSupport?.ephemeralReady !== true) {
      throw new Error(
        `Adapter '${preferredAdapter}' is not child-session ready: ${preferredCandidate.runtimeAdapter.childSessionSupport?.reason || 'ephemeral child execution is not verified'}`
      );
    }
    if (preferredAdapter && preferredCandidate && options.requireCollaboratorReady === true) {
      const support = preferredCandidate.runtimeAdapter.childSessionSupport
        || getChildSessionSupport(preferredCandidate.adapter, preferredCandidate.runtimeAdapter.capabilities || {});
      if (support.collaboratorReady !== true) {
        throw new Error(
          `Adapter '${preferredAdapter}' is not collaborator-ready: ${support.reason || 'continuity is not guaranteed'}`
        );
      }
    }

    const selected = preferredCandidate || candidates.find((candidate) => (
      candidate.runtimeAdapter.available !== false &&
      candidate.runtimeAdapter.authenticated !== false &&
      candidate.runtimeAdapter.childSessionSupport?.ephemeralReady === true &&
      (options.requireCollaboratorReady !== true || candidate.runtimeAdapter.childSessionSupport?.collaboratorReady === true)
    )) || candidates[0];

    const role = this.profileService.getRole(roleName);
    const defaultAdapter = role?.defaultAdapter || null;
    const profileName = `${roleName}_${selected.adapter}`;
    const strategy = preferredAdapter
      ? 'explicit'
      : selected.adapter === defaultAdapter
        ? 'default'
        : 'fallback';

    return {
      profile: options.systemPrompt
        ? { ...selected.profile, systemPrompt: options.systemPrompt }
        : selected.profile,
      profileName,
      runtimeAdapter: selected.runtimeAdapter,
      routingDecision: {
        strategy,
        requestedRole: roleName,
        requestedAdapter: preferredAdapter || defaultAdapter,
        selectedAdapter: selected.adapter,
        selectedProfile: profileName,
        candidates: candidates.map((candidate) => ({
          adapter: candidate.adapter,
          score: candidate.score,
          reasons: candidate.reasons,
          available: candidate.runtimeAdapter.available,
          authenticated: candidate.runtimeAdapter.authenticated,
          authenticationReason: candidate.runtimeAdapter.authenticationReason,
          capabilities: candidate.runtimeAdapter.capabilities || null,
          childSessionSupport: candidate.runtimeAdapter.childSessionSupport || null
        }))
      }
    };
  }

  /**
   * Get all profiles (for backward compatibility)
   * @returns {Object} profiles map
   */
  get profiles() {
    return this.profileService.getAllProfiles();
  }

  /**
   * Load agent profiles from config (deprecated - use profileService)
   */
  _loadProfiles() {
    return this.profileService.getAllProfiles();
  }

  /**
   * Detect task type from message content
   */
  detectTaskType(message) {
    const lowerMessage = message.toLowerCase();
    const scores = {};

    for (const [type, keywords] of Object.entries(TASK_KEYWORDS)) {
      scores[type] = 0;
      for (const keyword of keywords) {
        if (lowerMessage.includes(keyword)) {
          scores[type]++;
        }
      }
    }

    // Find highest scoring type
    let maxScore = 0;
    let detectedType = TASK_TYPES.IMPLEMENT; // Default

    for (const [type, score] of Object.entries(scores)) {
      if (score > maxScore) {
        maxScore = score;
        detectedType = type;
      }
    }

    return {
      type: detectedType,
      confidence: maxScore > 0 ? Math.min(maxScore / 3, 1) : 0.5,
      profile: TASK_TO_PROFILE[detectedType]
    };
  }

  _deriveSessionKind(options = {}, taskType = TASK_TYPES.IMPLEMENT) {
    if (options.sessionKind) {
      return options.sessionKind;
    }

    const roleName = options.forceRole || TASK_TO_ROLE[taskType] || null;
    if (roleName === 'review' || roleName === 'review-security' || roleName === 'review-performance') {
      return 'reviewer';
    }
    if (roleName === 'judge') {
      return 'judge';
    }
    if (roleName === 'monitor') {
      return 'monitor';
    }
    if (roleName === 'plan' || roleName === 'architect') {
      return 'workflow';
    }
    return 'subagent';
  }

  async _resolveModelSelection({ adapter, explicitModel, profileModel, role, taskType }) {
    if (explicitModel || profileModel) {
      return {
        model: explicitModel || profileModel,
        recommendation: null
      };
    }

    const recommendation = await this.recommendModel({
      adapter,
      role,
      taskType
    });

    return {
      model: recommendation.selectedModel || null,
      recommendation
    };
  }

  /**
   * Route a single task to the appropriate agent
   *
   * Supports two APIs:
   * - Legacy: { forceProfile: 'planner' }
   * - New:    { forceRole: 'plan', forceAdapter: 'gemini-cli' }
   */
  async routeTask(message, options = {}) {
    const {
      forceProfile,
      forceType,
      forceRole,
      forceAdapter,
      systemPrompt,
      workDir,
      model,
      sessionLabel,
      rootSessionId,
      parentSessionId,
      sessionKind,
      originClient,
      externalSessionRef,
      lineageDepth,
      sessionMetadata,
      preferReuse,
      forceFreshSession
    } = options;

    // Detect or use forced task type
    const detection = forceType ?
      { type: forceType, profile: TASK_TO_PROFILE[forceType], confidence: 1 } :
      this.detectTaskType(message);

    // Resolve profile using either new API (role+adapter) or legacy (profile name)
    let profile;
    let profileName;
    let runtimeAdapter;
    let routingDecision = null;

    const detectedRole = TASK_TO_ROLE[detection.type];
    const resolvedSessionKind = this._deriveSessionKind({ sessionKind, forceRole }, detection.type);
    const requireCollaboratorReady = resolvedSessionKind === 'collaborator';

    if (forceRole || (!forceProfile && detectedRole)) {
      const effectiveRole = forceRole || detectedRole;
      const resolved = await this._resolveProfileForRole(effectiveRole, forceAdapter, {
        systemPrompt,
        requireCollaboratorReady
      });
      profile = resolved.profile;
      profileName = resolved.profileName;
      runtimeAdapter = resolved.runtimeAdapter;
      routingDecision = resolved.routingDecision;
    } else {
      // Legacy API: use profile name
      profileName = forceProfile || detection.profile;
      profile = this.profileService.getProfile(profileName);
    }

    if (!profile) {
      throw new Error(`Unknown agent profile: ${profileName}`);
    }

    runtimeAdapter = runtimeAdapter || await this._getRuntimeAdapterInfo(profile.adapter);
    if (runtimeAdapter.registered && runtimeAdapter.available === false) {
      throw new Error(`Adapter '${profile.adapter}' CLI not available`);
    }
    if (runtimeAdapter.childSessionSupport?.ephemeralReady === false) {
      throw new Error(
        `Adapter '${profile.adapter}' is not child-session ready: ${runtimeAdapter.childSessionSupport?.reason || 'ephemeral child execution is not verified'}`
      );
    }
    if (requireCollaboratorReady && runtimeAdapter.childSessionSupport?.collaboratorReady !== true) {
      throw new Error(
        `Adapter '${profile.adapter}' is not collaborator-ready: ${runtimeAdapter.childSessionSupport?.reason || 'continuity is not guaranteed'}`
      );
    }

    this.emit('task-routed', {
      message: message.slice(0, 100),
      taskType: detection.type,
      profile: profileName,
      confidence: detection.confidence
    });

    const modelSelection = await this._resolveModelSelection({
      adapter: profile.adapter,
      explicitModel: model,
      profileModel: profile.model,
      role: forceRole || detectedRole || null,
      taskType: detection.type
    });
    if (routingDecision && modelSelection.recommendation) {
      routingDecision.modelRecommendation = {
        selectedModel: modelSelection.recommendation.selectedModel,
        selectedProvider: modelSelection.recommendation.selectedProvider,
        selectedFamily: modelSelection.recommendation.selectedFamily,
        strategy: modelSelection.recommendation.strategy
      };
    }

    // Create terminal and send task
    const terminal = await this.sessionManager.createTerminal({
      adapter: profile.adapter,
      agentProfile: profileName,
      systemPrompt: systemPrompt || profile.systemPrompt,
      model: modelSelection.model,
      sessionLabel: sessionLabel || null,
      allowedTools: profile.allowedTools,
      permissionMode: profile.permissionMode,
      workDir: workDir || undefined,
      rootSessionId,
      parentSessionId,
      sessionKind: resolvedSessionKind,
      originClient,
      externalSessionRef,
      lineageDepth,
      sessionMetadata,
      preferReuse,
      forceFreshSession
    });

    // Send the message
    await this.sessionManager.sendInput(terminal.terminalId, message);

    return {
      terminalId: terminal.terminalId,
      reused: terminal.reused === true,
      reuseReason: terminal.reuseReason || null,
      profile: profileName,
      adapter: profile.adapter,
      model: modelSelection.model,
      modelRecommendation: modelSelection.recommendation,
      taskType: detection.type,
      confidence: detection.confidence,
      runtimeAvailable: runtimeAdapter.available,
      runtimeAuthenticated: runtimeAdapter.authenticated,
      authenticationReason: runtimeAdapter.authenticationReason,
      runtimeCapabilities: runtimeAdapter.capabilities,
      runtimeChildSessionSupport: runtimeAdapter.childSessionSupport || null,
      adapterReadiness: runtimeAdapter.adapterReadiness || null,
      runtimeContract: runtimeAdapter.contract,
      routingDecision
    };
  }

  /**
   * Execute a predefined workflow
   */
  async executeWorkflow(workflowName, initialMessage, options = {}) {
    const workflow = WORKFLOWS[workflowName];
    if (!workflow) {
      throw new Error(`Unknown workflow: ${workflowName}. Available: ${Object.keys(WORKFLOWS).join(', ')}`);
    }

    const workflowId = `wf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const results = [];
    let currentMessage = initialMessage;

    this.activeWorkflows.set(workflowId, {
      name: workflowName,
      status: 'running',
      startedAt: new Date(),
      steps: []
    });

    this.emit('workflow-started', { workflowId, workflowName, steps: workflow.steps.length });

    try {
      // Group parallel steps
      const stepGroups = this._groupParallelSteps(workflow.steps);

      for (const group of stepGroups) {
        if (group.parallel) {
          // Execute parallel steps
          const parallelResults = await Promise.all(
            group.steps.map(step => this._executeStep(step, currentMessage, workflowId, options))
          );
          results.push(...parallelResults);

          // Aggregate results if needed
          if (workflow.aggregateResults) {
            currentMessage = this._aggregateResults(parallelResults, currentMessage);
          }
        } else {
          // Execute sequential step
          const step = group.steps[0];

          // Check condition
          if (step.condition && !this._evaluateCondition(step.condition, results)) {
            continue;
          }

          const result = await this._executeStep(step, currentMessage, workflowId, options);
          results.push(result);

          // Pass output to next step if configured
          if (step.passOutput && result.output) {
            currentMessage = `Previous step output:\n${result.output}\n\nOriginal task:\n${initialMessage}`;
          }
        }
      }

      this.activeWorkflows.get(workflowId).status = 'completed';
      this.emit('workflow-completed', { workflowId, results });

      return {
        workflowId,
        workflowName,
        status: 'completed',
        results
      };

    } catch (error) {
      this.activeWorkflows.get(workflowId).status = 'failed';
      this.activeWorkflows.get(workflowId).error = error.message;
      this.emit('workflow-failed', { workflowId, error: error.message });
      throw error;
    }
  }

  /**
   * Group workflow steps by parallel execution
   */
  _groupParallelSteps(steps) {
    const groups = [];
    let currentParallelGroup = null;

    for (const step of steps) {
      if (step.parallel) {
        if (!currentParallelGroup) {
          currentParallelGroup = { parallel: true, steps: [] };
        }
        currentParallelGroup.steps.push(step);
      } else {
        if (currentParallelGroup) {
          groups.push(currentParallelGroup);
          currentParallelGroup = null;
        }
        groups.push({ parallel: false, steps: [step] });
      }
    }

    if (currentParallelGroup) {
      groups.push(currentParallelGroup);
    }

    return groups;
  }

  /**
   * Execute a single workflow step
   */
  async _executeStep(step, message, workflowId, options = {}) {
    const profile = this.profiles[step.profile];
    if (!profile) {
      throw new Error(`Unknown profile in workflow: ${step.profile}`);
    }

    this.emit('step-started', { workflowId, profile: step.profile, type: step.type });
    const stepRole = TASK_TO_ROLE[step.type] || null;
    const stepModelSelection = await this._resolveModelSelection({
      adapter: profile.adapter,
      explicitModel: options.modelsByAdapter?.[profile.adapter] || options.model || null,
      profileModel: profile.model,
      role: stepRole,
      taskType: step.type
    });

    const terminal = await this.sessionManager.createTerminal({
      adapter: profile.adapter,
      agentProfile: step.profile,
      systemPrompt: profile.systemPrompt,
      model: stepModelSelection.model,
      allowedTools: profile.allowedTools,
      permissionMode: profile.permissionMode,
      workDir: options.workDir || undefined,
      rootSessionId: options.rootSessionId || null,
      parentSessionId: options.parentSessionId || options.rootSessionId || null,
      sessionKind: options.sessionKind || 'workflow',
      originClient: options.originClient || null,
      externalSessionRef: options.externalSessionRef || null,
      lineageDepth: Number.isInteger(options.lineageDepth)
        ? options.lineageDepth + 1
        : (options.parentSessionId || options.rootSessionId ? 1 : 0),
      sessionMetadata: options.sessionMetadata || null,
      preferReuse: options.preferReuse,
      forceFreshSession: options.forceFreshSession
    });

    // Wait for CLI to fully initialize
    const cliStartupDelays = {
      'gemini-cli': 4000,
      'codex-cli': 8000,
      'qwen-cli': 5000
    };
    const cliStartupDelay = cliStartupDelays[profile.adapter] || 5000;
    await new Promise(resolve => setTimeout(resolve, cliStartupDelay));

    await this.sessionManager.sendInput(terminal.terminalId, message);

    // Wait for completion (default timeout: 5 minutes if not specified)
    const timeoutMs = (profile.timeout || 300) * 1000;
    const output = await this.sessionManager.waitForCompletion(terminal.terminalId, timeoutMs);

    this.emit('step-completed', { workflowId, profile: step.profile, terminalId: terminal.terminalId });

    return {
      profile: step.profile,
      type: step.type,
      terminalId: terminal.terminalId,
      model: stepModelSelection.model,
      modelRecommendation: stepModelSelection.recommendation,
      reused: terminal.reused === true,
      reuseReason: terminal.reuseReason || null,
      output
    };
  }

  /**
   * Aggregate results from parallel steps
   */
  _aggregateResults(results, originalMessage) {
    const aggregated = results.map(r =>
      `### ${r.profile} (${r.type})\n${r.output || 'No output'}`
    ).join('\n\n');

    return `## Aggregated Review Results\n\n${aggregated}\n\n## Original Task\n${originalMessage}`;
  }

  /**
   * Evaluate workflow step condition
   */
  _evaluateCondition(condition, previousResults) {
    switch (condition) {
      case 'hasIssues':
        return previousResults.some(r =>
          r.output && (
            r.output.toLowerCase().includes('issue') ||
            r.output.toLowerCase().includes('bug') ||
            r.output.toLowerCase().includes('error') ||
            r.output.toLowerCase().includes('vulnerability')
          )
        );
      default:
        return true;
    }
  }

  /**
   * Get available workflows
   */
  getWorkflows() {
    return Object.entries(WORKFLOWS).map(([name, workflow]) => ({
      name,
      displayName: workflow.name,
      description: workflow.description,
      steps: workflow.steps.length
    }));
  }

  /**
   * Get available task types
   */
  getTaskTypes() {
    return Object.entries(TASK_TO_PROFILE).map(([type, profile]) => ({
      type,
      profile,
      adapter: this.profiles[profile]?.adapter
    }));
  }

  /**
   * Get workflow status
   */
  getWorkflowStatus(workflowId) {
    return this.activeWorkflows.get(workflowId) || null;
  }
}

module.exports = {
  TaskRouter,
  TASK_TYPES,
  WORKFLOWS
};
