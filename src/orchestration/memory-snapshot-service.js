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
    return this.db.getMemorySnapshot('run', runId);
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
