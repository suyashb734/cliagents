/**
 * MemoryMaintenanceService
 *
 * Repairs missing run snapshots and refreshes stale root snapshots.
 */

const { getMemorySnapshotService } = require('./memory-snapshot-service');

const DEFAULT_SWEEP_INTERVAL_MS = 300000;

function resolveSweepIntervalMs(options = {}) {
  if (options.sweepIntervalMs !== undefined) {
    const parsed = Number(options.sweepIntervalMs);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_SWEEP_INTERVAL_MS;
  }

  if (process.env.CLIAGENTS_MEMORY_REPAIR_SWEEP_MS !== undefined) {
    const parsed = Number(process.env.CLIAGENTS_MEMORY_REPAIR_SWEEP_MS);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_SWEEP_INTERVAL_MS;
  }

  return DEFAULT_SWEEP_INTERVAL_MS;
}

class MemoryMaintenanceService {
  constructor(options = {}) {
    this._snapshotService = options.snapshotService || getMemorySnapshotService();
    this._logger = options.logger || console;
    this._sweepIntervalMs = resolveSweepIntervalMs(options);
    this._intervalHandle = null;
  }

  start() {
    if (this._intervalHandle || this._sweepIntervalMs === 0) {
      return;
    }

    this._intervalHandle = setInterval(() => {
      this.runOnce().catch((error) => {
        this._logger.warn(`[MemoryMaintenanceService] Sweep error: ${error.message}`);
      });
    }, this._sweepIntervalMs);

    if (typeof this._intervalHandle.unref === 'function') {
      this._intervalHandle.unref();
    }
  }

  stop() {
    if (this._intervalHandle) {
      clearInterval(this._intervalHandle);
      this._intervalHandle = null;
    }
  }

  async runOnce() {
    if (!this._snapshotService?.db) {
      return {
        attachedRootsLinked: 0,
        runsLinked: 0,
        messagesLinked: 0,
        terminalsRefreshed: 0,
        repairedRuns: 0,
        repairedRoots: 0,
        repairedTasks: 0,
        repairedProjects: 0,
        skippedRunsWithoutRootSessionId: 0,
        error: 'snapshot_service_unavailable'
      };
    }

    const db = this._snapshotService.db;
    // Ordering matters: attached roots must exist before message/run linkage can
    // safely resolve back to root_session_id, and recency must be recomputed
    // after linkage repairs have materialized the relevant terminal rows.
    const attachedRootsLinked = typeof db.repairAttachedRootTerminals === 'function'
      ? db.repairAttachedRootTerminals()
      : 0;
    const runsLinked = typeof db.repairRunRootSessionIds === 'function'
      ? db.repairRunRootSessionIds()
      : 0;
    const messagesLinked = typeof db.repairMessageRootSessionIds === 'function'
      ? db.repairMessageRootSessionIds()
      : 0;
    const terminalsRefreshed = typeof db.repairTerminalLastMessageAt === 'function'
      ? db.repairTerminalLastMessageAt()
      : 0;
    const finishedRuns = typeof db.listFinishedRunsForRepair === 'function'
      ? db.listFinishedRunsForRepair(200)
      : [];

    let repairedRuns = 0;
    let repairedRoots = 0;
    let repairedTasks = 0;
    let repairedProjects = 0;
    let skippedRunsWithoutRootSessionId = 0;

    for (const row of finishedRuns) {
      const existing = db.getMemorySnapshot('run', row.id);
      if (!existing) {
        const snapshot = this._snapshotService.writeRunSnapshot(row.id, {
          rootSessionId: row.rootSessionId || null,
          taskId: row.taskId || null,
          generationTrigger: 'repair',
          refreshTask: false
        });
        if (snapshot) {
          repairedRuns += 1;
        }
      } else {
        this._snapshotService.linkRunSnapshotSources(row.id);
      }

      if (!row.rootSessionId) {
        skippedRunsWithoutRootSessionId += 1;
      }
    }

    const rootSessionIds = [...new Set(finishedRuns.map((row) => row.rootSessionId).filter(Boolean))];
    for (const rootSessionId of rootSessionIds) {
      if (!this._snapshotService.isRootSnapshotStale(rootSessionId)) {
        this._snapshotService.linkRootSnapshotSources(rootSessionId);
        continue;
      }
      const result = await this._snapshotService.refreshRootSnapshot(rootSessionId);
      if (result.success) {
        repairedRoots += 1;
      }
    }

    const taskIds = new Set(finishedRuns.map((row) => row.taskId).filter(Boolean));
    if (typeof db.listTasks === 'function') {
      for (const task of db.listTasks({ limit: 200 })) {
        taskIds.add(task.id);
      }
    }
    for (const taskId of taskIds) {
      if (!this._snapshotService.isTaskSnapshotStale(taskId)) {
        this._snapshotService.linkTaskSnapshotSources(taskId);
        continue;
      }
      const result = this._snapshotService.refreshTaskSnapshot(taskId, {
        generationTrigger: 'repair',
        refreshProject: false
      });
      if (result.success) {
        repairedTasks += 1;
      }
    }

    const projectIds = new Set();
    if (typeof db.listTasks === 'function') {
      for (const task of db.listTasks({ limit: 200 })) {
        if (task.projectId) {
          projectIds.add(task.projectId);
        }
      }
    }
    if (typeof db.listProjects === 'function') {
      for (const project of db.listProjects({ limit: 200 })) {
        projectIds.add(project.id);
      }
    }
    for (const projectId of projectIds) {
      if (!this._snapshotService.isProjectSnapshotStale(projectId)) {
        this._snapshotService.linkProjectSnapshotSources(projectId);
        continue;
      }
      const result = this._snapshotService.refreshProjectSnapshot(projectId, {
        generationTrigger: 'repair'
      });
      if (result.success) {
        repairedProjects += 1;
      }
    }

    return {
      attachedRootsLinked,
      runsLinked,
      messagesLinked,
      terminalsRefreshed,
      repairedRuns,
      repairedRoots,
      repairedTasks,
      repairedProjects,
      skippedRunsWithoutRootSessionId
    };
  }

  get intervalMs() {
    return this._sweepIntervalMs;
  }

  get isRunning() {
    return Boolean(this._intervalHandle);
  }
}

let instance = null;

function getMemoryMaintenanceService(options = {}) {
  if (!instance) {
    instance = new MemoryMaintenanceService(options);
  }
  return instance;
}

function peekMemoryMaintenanceService() {
  return instance;
}

function resetMemoryMaintenanceService() {
  if (instance) {
    instance.stop();
  }
  instance = null;
}

module.exports = {
  MemoryMaintenanceService,
  getMemoryMaintenanceService,
  peekMemoryMaintenanceService,
  resetMemoryMaintenanceService
};
