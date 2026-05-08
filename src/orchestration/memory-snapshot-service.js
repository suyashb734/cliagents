/**
 * MemorySnapshotService
 *
 * Provides durable run/root summaries built from persisted run data.
 */

const crypto = require('crypto');
const { getDB } = require('../database/db');
const { summarizeOutput, extractKeyDecisions, extractPendingItems } = require('../utils/context-summarizer');

const RUN_BRIEF_MAX_LENGTH = 1500;
const ROOT_BRIEF_MAX_LENGTH = 1500;
const TASK_BRIEF_MAX_LENGTH = 1500;
const PROJECT_BRIEF_MAX_LENGTH = 1500;

function generateSnapshotId() {
  return `snapshot_${crypto.randomBytes(8).toString('hex')}`;
}

function truncateText(value, maxLength = RUN_BRIEF_MAX_LENGTH) {
  const text = String(value || '').trim();
  if (!text) {
    return null;
  }
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 16)).trimEnd()}... [truncated]`;
}

function dedupeStrings(values = [], maxItems = Infinity) {
  const seen = new Set();
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = String(value || '').trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= maxItems) {
      break;
    }
  }
  return result;
}

function extractBriefFromText(text, maxLength = RUN_BRIEF_MAX_LENGTH) {
  const normalized = String(text || '').trim();
  if (!normalized) {
    return null;
  }
  const summary = summarizeOutput(normalized, {
    maxLength,
    taskType: null
  });
  return truncateText(summary.summary || normalized, maxLength);
}

class MemorySnapshotService {
  constructor(db = null, logger = console) {
    this._db = db;
    this._logger = logger;
  }

  get db() {
    if (!this._db) {
      this._db = getDB();
    }
    return this._db;
  }

  _collectRunSourceText(run, outputs) {
    const joinedOutputs = (outputs || [])
      .map((entry) => entry.fullText || entry.previewText || '')
      .filter(Boolean)
      .join('\n\n');

    if (run?.decisionSummary) {
      return [run.decisionSummary, joinedOutputs].filter(Boolean).join('\n\n');
    }

    return joinedOutputs;
  }

  _appendSummaryEdge(edge) {
    if (typeof this.db.appendMemorySummaryEdge !== 'function') {
      return null;
    }

    try {
      return this.db.appendMemorySummaryEdge(edge);
    } catch (error) {
      this._logger.warn(`[MemorySnapshotService] Summary lineage edge failed: ${error.message}`);
      return null;
    }
  }

  _linkSnapshotToSources(snapshot, sources = []) {
    if (!snapshot?.id) {
      return 0;
    }

    let linked = 0;
    for (const source of Array.isArray(sources) ? sources : []) {
      const scopeType = String(source?.scopeType || '').trim();
      const scopeId = String(source?.scopeId || '').trim();
      if (!scopeType || !scopeId) {
        continue;
      }

      const edge = this._appendSummaryEdge({
        edgeNamespace: 'derivation',
        parentScopeType: 'memory_snapshot',
        parentScopeId: snapshot.id,
        childScopeType: scopeType,
        childScopeId: scopeId,
        edgeKind: source.edgeKind || 'summarizes',
        metadata: {
          source: 'memory-snapshot-service',
          snapshotScope: snapshot.scope,
          snapshotScopeId: snapshot.scopeId,
          ...source.metadata
        }
      });
      if (edge) {
        linked += 1;
      }
    }

    return linked;
  }

  linkRunSnapshotSources(runId) {
    const snapshot = this.db.getMemorySnapshot('run', runId);
    if (!snapshot) {
      return 0;
    }

    return this._linkSnapshotToSources(snapshot, [{
      scopeType: 'run',
      scopeId: runId,
      metadata: {
        runId
      }
    }]);
  }

  linkRootSnapshotSources(rootSessionId, runIds = null) {
    const snapshot = this.db.getMemorySnapshot('root', rootSessionId);
    if (!snapshot) {
      return 0;
    }

    const candidateRunIds = Array.isArray(runIds) && runIds.length > 0
      ? runIds
      : (Array.isArray(snapshot.metadata?.recentRunIds)
        ? snapshot.metadata.recentRunIds
        : this.db.getLatestCompletedRuns(rootSessionId, 20).map((run) => run.id));
    const sources = dedupeStrings(candidateRunIds, 20).map((runId) => ({
      scopeType: 'run',
      scopeId: runId,
      metadata: {
        rootSessionId,
        runId
      }
    }));

    return this._linkSnapshotToSources(snapshot, sources);
  }

  linkTaskSnapshotSources(taskId, sources = null) {
    const snapshot = this.db.getMemorySnapshot('task', taskId);
    if (!snapshot) {
      return 0;
    }

    const sourceRecords = Array.isArray(sources) && sources.length > 0
      ? sources
      : this._collectTaskSnapshotSources(taskId);
    return this._linkSnapshotToSources(snapshot, sourceRecords);
  }

  linkProjectSnapshotSources(projectId, sources = null) {
    const snapshot = this.db.getMemorySnapshot('project', projectId);
    if (!snapshot) {
      return 0;
    }

    const sourceRecords = Array.isArray(sources) && sources.length > 0
      ? sources
      : this._collectProjectSnapshotSources(projectId);
    return this._linkSnapshotToSources(snapshot, sourceRecords);
  }

  _collectTaskSnapshotSources(taskId) {
    const task = this.db.getTask(taskId);
    if (!task) {
      return [];
    }

    const sources = [{
      scopeType: 'task',
      scopeId: taskId,
      metadata: { taskId }
    }];

    for (const run of this.db.getLatestRunsForTask(taskId, 20)) {
      sources.push({
        scopeType: 'run',
        scopeId: run.id,
        metadata: { taskId, runId: run.id }
      });
    }
    for (const assignment of this.db.listTaskAssignments(taskId, { limit: 50 })) {
      sources.push({
        scopeType: 'task_assignment',
        scopeId: assignment.id,
        metadata: { taskId, assignmentId: assignment.id }
      });
    }
    for (const room of this.db.listRooms({ taskId, limit: 20 })) {
      sources.push({
        scopeType: 'room',
        scopeId: room.id,
        metadata: { taskId, roomId: room.id }
      });
    }
    for (const finding of this.db.getFindings(taskId).slice(0, 20)) {
      sources.push({
        scopeType: 'finding',
        scopeId: finding.id,
        metadata: { taskId, severity: finding.severity, type: finding.type }
      });
    }
    for (const artifact of this.db.getArtifacts(taskId).slice(0, 20)) {
      sources.push({
        scopeType: 'artifact',
        scopeId: artifact.id,
        metadata: { taskId, key: artifact.key, type: artifact.type }
      });
    }
    for (const context of this.db.getContext(taskId).slice(0, 20)) {
      sources.push({
        scopeType: 'context',
        scopeId: context.id,
        metadata: { taskId }
      });
    }
    for (const usage of this.db.listUsageRecords({ taskId, limit: 50 })) {
      sources.push({
        scopeType: 'usage_record',
        scopeId: String(usage.id),
        metadata: { taskId, terminalId: usage.terminal_id || usage.terminalId || null }
      });
    }

    return sources;
  }

  _collectProjectSnapshotSources(projectId) {
    const project = this.db.getProject(projectId);
    if (!project) {
      return [];
    }

    const sources = [{
      scopeType: 'project',
      scopeId: projectId,
      metadata: { projectId, workspaceRoot: project.workspaceRoot }
    }];

    for (const task of this.db.listTasks({ projectId, limit: 50 })) {
      sources.push({
        scopeType: 'task',
        scopeId: task.id,
        metadata: { projectId, taskId: task.id }
      });
    }
    for (const taskSnapshot of this.db.listTaskSnapshotsByProject(projectId, 20)) {
      sources.push({
        scopeType: 'memory_snapshot',
        scopeId: taskSnapshot.id,
        metadata: { projectId, snapshotScope: 'task', taskId: taskSnapshot.taskId }
      });
    }
    for (const run of this.db.getLatestRunsForProject(projectId, 50)) {
      sources.push({
        scopeType: 'run',
        scopeId: run.id,
        metadata: { projectId, runId: run.id, taskId: run.taskId || null }
      });
    }
    for (const room of this.db.listRooms({ projectId, limit: 20 })) {
      sources.push({
        scopeType: 'room',
        scopeId: room.id,
        metadata: { projectId, roomId: room.id, taskId: room.taskId || null }
      });
    }
    for (const usage of this.db.listUsageRecords({ projectId, limit: 50 })) {
      sources.push({
        scopeType: 'usage_record',
        scopeId: String(usage.id),
        metadata: { projectId, terminalId: usage.terminal_id || usage.terminalId || null }
      });
    }

    return sources;
  }

  buildRunSnapshotPayload(runId, options = {}) {
    const run = this.db.getRunById(runId);
    if (!run) {
      return null;
    }

    const outputs = this.db.getRunOutputs(runId);
    const sourceText = this._collectRunSourceText(run, outputs);
    const brief = run.decisionSummary
      ? truncateText(run.decisionSummary, RUN_BRIEF_MAX_LENGTH)
      : extractBriefFromText(sourceText, RUN_BRIEF_MAX_LENGTH)
        || truncateText(`${run.kind} run ${run.status}`, RUN_BRIEF_MAX_LENGTH);
    const keyDecisions = dedupeStrings(extractKeyDecisions(sourceText || brief || ''), 20);
    const pendingItems = dedupeStrings(extractPendingItems(sourceText || brief || ''), 20);

    return {
      id: generateSnapshotId(),
      scope: 'run',
      scopeId: runId,
      runId,
      rootSessionId: options.rootSessionId || run.rootSessionId || null,
      taskId: options.taskId || run.taskId || null,
      brief,
      keyDecisions,
      pendingItems,
      generationTrigger: options.generationTrigger || 'run_completed',
      generationStrategy: 'rule_based',
      metadata: {
        kind: run.kind,
        status: run.status,
        decisionSource: run.decisionSource || null,
        discussionId: run.discussionId || null,
        traceId: run.traceId || null,
        completedAt: run.completedAt || null,
        durationMs: run.durationMs || null
      }
    };
  }

  writeRunSnapshot(runId, options = {}) {
    const payload = this.buildRunSnapshotPayload(runId, options);
    if (!payload) {
      return null;
    }
    this.db.upsertMemorySnapshot(payload);
    const snapshot = this.db.getMemorySnapshot('run', runId);
    this.linkRunSnapshotSources(runId);
    if (payload.taskId && options.refreshTask !== false) {
      this.refreshTaskSnapshot(payload.taskId, {
        generationTrigger: payload.generationTrigger || 'run_completed'
      });
    }
    return snapshot;
  }

  scheduleRootRefresh(rootSessionId) {
    if (!rootSessionId) {
      return;
    }

    setImmediate(async () => {
      try {
        await this.refreshRootSnapshot(rootSessionId);
      } catch (error) {
        this._logger.warn(`[MemorySnapshotService] Root refresh failed for ${rootSessionId}: ${error.message}`);
      }
    });
  }

  _buildRootBrief(entries, runCount) {
    const lines = [`Recent work across ${runCount} finished run(s).`];
    for (const [index, entry] of entries.slice(0, 3).entries()) {
      lines.push(`${index + 1}. ${entry.brief || `${entry.kind || 'run'} ${entry.runId}`}`);
    }
    return truncateText(lines.join('\n'), ROOT_BRIEF_MAX_LENGTH);
  }

  async refreshRootSnapshot(rootSessionId) {
    try {
      const completedRuns = this.db.getLatestCompletedRuns(rootSessionId, 20);
      if (completedRuns.length === 0) {
        return { success: false, reason: 'no_completed_runs', repairedRoots: 0 };
      }

      const existing = this.db.getMemorySnapshot('root', rootSessionId);
      const recentRunEntries = completedRuns.map((run) => {
        const snapshot = this.db.getMemorySnapshot('run', run.id);
        const fallbackText = run.decisionSummary || `${run.kind} run ${run.status}`;
        const brief = snapshot?.brief || truncateText(fallbackText, RUN_BRIEF_MAX_LENGTH);
        const keyDecisions = snapshot?.keyDecisions?.length
          ? snapshot.keyDecisions
          : dedupeStrings(extractKeyDecisions(fallbackText), 10);
        const pendingItems = snapshot?.pendingItems?.length
          ? snapshot.pendingItems
          : dedupeStrings(extractPendingItems(fallbackText), 10);
        return {
          runId: run.id,
          kind: run.kind,
          status: run.status,
          completedAt: run.completedAt || null,
          brief,
          keyDecisions,
          pendingItems
        };
      });

      const usage = this.db.getRootUsageSummary(rootSessionId);
      const latestCompletedAt = this.db.getLatestCompletedAtForRoot(rootSessionId);
      const participantAdapters = this.db.getRootParticipantAdapters(rootSessionId);
      const keyDecisions = dedupeStrings(recentRunEntries.flatMap((entry) => entry.keyDecisions), 20);
      const pendingItems = dedupeStrings(recentRunEntries.flatMap((entry) => entry.pendingItems), 20);

      this.db.upsertMemorySnapshot({
        id: existing?.id || generateSnapshotId(),
        scope: 'root',
        scopeId: rootSessionId,
        runId: null,
        rootSessionId,
        taskId: null,
        brief: this._buildRootBrief(recentRunEntries, completedRuns.length),
        keyDecisions,
        pendingItems,
        generationTrigger: 'root_refresh',
        generationStrategy: 'rule_based',
        metadata: {
          recentRunIds: recentRunEntries.map((entry) => entry.runId),
          runCount: completedRuns.length,
          participantAdapters,
          totalTokens: usage.totalTokens,
          totalCostUsd: usage.costUsd,
          latestCompletedAt
        }
      });
      this.linkRootSnapshotSources(rootSessionId, recentRunEntries.map((entry) => entry.runId));

      return {
        success: true,
        repairedRoots: 1,
        runCount: completedRuns.length,
        skippedRunsWithoutRootSessionId: 0,
        recentRunIds: recentRunEntries.map((entry) => entry.runId)
      };
    } catch (error) {
      this._logger.warn(`[MemorySnapshotService] Root refresh failed for ${rootSessionId}: ${error.message}`);
      return { success: false, reason: 'refresh_error', error: error.message, repairedRoots: 0 };
    }
  }

  refreshTaskSnapshot(taskId, options = {}) {
    try {
      const task = this.db.getTask(taskId);
      if (!task) {
        return { success: false, reason: 'task_not_found', repairedTasks: 0 };
      }

      const existing = this.db.getMemorySnapshot('task', taskId);
      const usage = this.db.summarizeUsage({ taskId });
      const assignments = this.db.listTaskAssignments(taskId, { limit: 100 });
      const rooms = this.db.listRooms({ taskId, limit: 50 });
      const latestRuns = this.db.getLatestRunsForTask(taskId, 20);
      const runSnapshots = this.db.listRunSnapshotsByTask(taskId, 10);
      const latestContext = this.db.getLatestContext(taskId);
      const sources = this._collectTaskSnapshotSources(taskId);
      const keyDecisions = runSnapshots.length
        ? dedupeStrings(runSnapshots.flatMap((entry) => entry.keyDecisions), 20)
        : dedupeStrings(latestContext?.keyDecisions || [], 20);
      const pendingItems = runSnapshots.length
        ? dedupeStrings(runSnapshots.flatMap((entry) => entry.pendingItems), 20)
        : dedupeStrings(latestContext?.pendingItems || [], 20);
      const runBrief = runSnapshots
        .map((entry) => entry.brief)
        .filter(Boolean)
        .slice(0, 3)
        .join('\n\n');
      const fallbackBrief = truncateText(
        [
          task.title ? `Task: ${task.title}` : `Task: ${taskId}`,
          task.brief || null,
          runBrief || latestContext?.summary || null,
          assignments.length ? `Assignments: ${assignments.length}` : null,
          rooms.length ? `Rooms: ${rooms.length}` : null,
          usage.totalTokens ? `Usage: ${usage.totalTokens} tokens` : null
        ].filter(Boolean).join('\n'),
        TASK_BRIEF_MAX_LENGTH
      );

      this.db.upsertMemorySnapshot({
        id: existing?.id || generateSnapshotId(),
        scope: 'task',
        scopeId: taskId,
        runId: latestRuns[0]?.id || null,
        rootSessionId: task.rootSessionId || latestRuns.find((run) => run.rootSessionId)?.rootSessionId || null,
        taskId,
        projectId: task.projectId || null,
        brief: fallbackBrief || task.title,
        keyDecisions,
        pendingItems,
        generationTrigger: options.generationTrigger || 'repair',
        generationStrategy: 'rule_based',
        metadata: {
          taskTitle: task.title,
          taskKind: task.kind,
          workspaceRoot: task.workspaceRoot || null,
          assignmentCount: assignments.length,
          roomCount: rooms.length,
          runCount: latestRuns.length,
          usageRecordCount: usage.recordCount,
          totalTokens: usage.totalTokens,
          sourceCount: sources.length
        }
      });

      const snapshot = this.db.getMemorySnapshot('task', taskId);
      this.linkTaskSnapshotSources(taskId, sources);

      if (task.projectId && options.refreshProject !== false) {
        this.refreshProjectSnapshot(task.projectId, {
          generationTrigger: options.generationTrigger || 'repair'
        });
      }

      return {
        success: true,
        repairedTasks: 1,
        taskId,
        projectId: task.projectId || null,
        sourceCount: sources.length,
        snapshotId: snapshot?.id || null
      };
    } catch (error) {
      this._logger.warn(`[MemorySnapshotService] Task refresh failed for ${taskId}: ${error.message}`);
      return { success: false, reason: 'refresh_error', error: error.message, repairedTasks: 0 };
    }
  }

  refreshProjectSnapshot(projectId, options = {}) {
    try {
      const project = this.db.getProject(projectId);
      if (!project) {
        return { success: false, reason: 'project_not_found', repairedProjects: 0 };
      }

      const existing = this.db.getMemorySnapshot('project', projectId);
      const tasks = this.db.listTasks({ projectId, limit: 100 });
      const rooms = this.db.listRooms({ projectId, limit: 50 });
      const runs = this.db.getLatestRunsForProject(projectId, 50);
      const usage = this.db.summarizeUsage({ projectId });
      const taskSnapshots = this.db.listTaskSnapshotsByProject(projectId, 20);
      const runSnapshots = this.db.listRunSnapshotsByProject(projectId, 20);
      const sources = this._collectProjectSnapshotSources(projectId);
      const keyDecisions = dedupeStrings(
        [
          ...taskSnapshots.flatMap((entry) => entry.keyDecisions),
          ...runSnapshots.flatMap((entry) => entry.keyDecisions)
        ],
        20
      );
      const pendingItems = dedupeStrings(
        [
          ...taskSnapshots.flatMap((entry) => entry.pendingItems),
          ...runSnapshots.flatMap((entry) => entry.pendingItems)
        ],
        20
      );
      const taskBrief = taskSnapshots
        .map((entry) => entry.brief)
        .filter(Boolean)
        .slice(0, 3)
        .join('\n\n');
      const fallbackBrief = truncateText(
        [
          project.workspaceRoot ? `Project: ${project.workspaceRoot}` : `Project: ${projectId}`,
          taskBrief || null,
          tasks.length ? `Tasks: ${tasks.slice(0, 5).map((task) => task.title || task.id).join(', ')}` : null,
          runs.length ? `Recent runs: ${runs.slice(0, 3).map((run) => `${run.kind || 'run'} ${run.status || ''}`.trim()).join(', ')}` : null,
          usage.totalTokens ? `Usage: ${usage.totalTokens} tokens` : null
        ].filter(Boolean).join('\n'),
        PROJECT_BRIEF_MAX_LENGTH
      );

      this.db.upsertMemorySnapshot({
        id: existing?.id || generateSnapshotId(),
        scope: 'project',
        scopeId: projectId,
        runId: runs[0]?.id || null,
        rootSessionId: null,
        taskId: null,
        projectId,
        brief: fallbackBrief || `Project ${projectId}`,
        keyDecisions,
        pendingItems,
        generationTrigger: options.generationTrigger || 'repair',
        generationStrategy: 'rule_based',
        metadata: {
          workspaceRoot: project.workspaceRoot,
          taskCount: tasks.length,
          roomCount: rooms.length,
          runCount: runs.length,
          usageRecordCount: usage.recordCount,
          totalTokens: usage.totalTokens,
          sourceCount: sources.length
        }
      });

      const snapshot = this.db.getMemorySnapshot('project', projectId);
      this.linkProjectSnapshotSources(projectId, sources);

      return {
        success: true,
        repairedProjects: 1,
        projectId,
        sourceCount: sources.length,
        snapshotId: snapshot?.id || null
      };
    } catch (error) {
      this._logger.warn(`[MemorySnapshotService] Project refresh failed for ${projectId}: ${error.message}`);
      return { success: false, reason: 'refresh_error', error: error.message, repairedProjects: 0 };
    }
  }

  isRootSnapshotStale(rootSessionId) {
    const snapshot = this.db.getMemorySnapshot('root', rootSessionId);
    if (!snapshot) {
      return true;
    }

    const latestCompletedAt = this.db.getLatestCompletedAtForRoot(rootSessionId);
    if (!latestCompletedAt) {
      return false;
    }

    return latestCompletedAt > snapshot.updatedAt;
  }

  isTaskSnapshotStale(taskId) {
    const snapshot = this.db.getMemorySnapshot('task', taskId);
    const latestActivityAt = this.db.getLatestActivityAtForTask(taskId);
    if (!snapshot) {
      return Boolean(latestActivityAt);
    }
    return Boolean(latestActivityAt && latestActivityAt > snapshot.updatedAt);
  }

  isProjectSnapshotStale(projectId) {
    const snapshot = this.db.getMemorySnapshot('project', projectId);
    const latestActivityAt = this.db.getLatestActivityAtForProject(projectId);
    if (!snapshot) {
      return Boolean(latestActivityAt);
    }
    return Boolean(latestActivityAt && latestActivityAt > snapshot.updatedAt);
  }

  getRootSnapshotStaleness(rootSessionId) {
    const snapshot = this.db.getMemorySnapshot('root', rootSessionId);
    const latestCompletedAt = this.db.getLatestCompletedAtForRoot(rootSessionId);

    if (!snapshot) {
      return {
        isStale: Boolean(latestCompletedAt),
        snapshotExists: false,
        latestCompletedAt: latestCompletedAt || null,
        snapshotUpdatedAt: null
      };
    }

    return {
      isStale: Boolean(latestCompletedAt && latestCompletedAt > snapshot.updatedAt),
      snapshotExists: true,
      latestCompletedAt: latestCompletedAt || null,
      snapshotUpdatedAt: snapshot.updatedAt
    };
  }

  getRunSnapshot(runId) {
    return this.db.getMemorySnapshot('run', runId);
  }

  getRootSnapshot(rootSessionId) {
    return this.db.getMemorySnapshot('root', rootSessionId);
  }

  getTaskSnapshot(taskId) {
    return this.db.getMemorySnapshot('task', taskId);
  }

  getProjectSnapshot(projectId) {
    return this.db.getMemorySnapshot('project', projectId);
  }
}

let instance = null;

function getMemorySnapshotService(db = null, logger = console) {
  if (!instance) {
    instance = new MemorySnapshotService(db, logger);
  }
  return instance;
}

function resetMemorySnapshotService() {
  instance = null;
}

module.exports = {
  MemorySnapshotService,
  getMemorySnapshotService,
  resetMemorySnapshotService
};
