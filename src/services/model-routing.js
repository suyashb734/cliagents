'use strict';

const fs = require('fs');
const path = require('path');

const { CircuitBreakerRegistry, CircuitState } = require('../utils/circuit-breaker');

const TASK_KEY_ALIASES = Object.freeze({
  'review-bugs': 'review',
  reviewer: 'review'
});

const DEFAULT_MODEL_HEALTH_OPTIONS = Object.freeze({
  failureThreshold: 1,
  successThreshold: 1,
  resetTimeout: 15 * 60 * 1000,
  timeout: 1000
});

class ModelRoutingService {
  constructor(options = {}) {
    this.configPath = options.configPath ||
      path.join(process.cwd(), 'config', 'model-routing.json');
    this.rawConfig = { adapters: {} };
    this.lastModified = 0;
    this.modelHealthRegistry = options.modelHealthRegistry || new CircuitBreakerRegistry();
    this.modelHealthMetadata = new Map();
    this.reload();
  }

  reload() {
    try {
      const stats = fs.statSync(this.configPath);
      if (stats.mtimeMs <= this.lastModified) {
        return;
      }

      const content = fs.readFileSync(this.configPath, 'utf8');
      const config = JSON.parse(content);
      this.rawConfig = config && typeof config === 'object' ? config : { adapters: {} };
      this.lastModified = stats.mtimeMs;
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.rawConfig = { adapters: {} };
        return;
      }
      throw error;
    }
  }

  listAdapters() {
    this.reload();
    return Object.keys(this.rawConfig.adapters || {});
  }

  getAdapterPolicy(adapter) {
    this.reload();
    return this.rawConfig.adapters?.[adapter] || null;
  }

  _normalizeTaskKey({ role, taskType }) {
    const raw = String(taskType || role || 'default').trim().toLowerCase();
    return TASK_KEY_ALIASES[raw] || raw || 'default';
  }

  _normalizeModelId(model) {
    return String(model || '').trim() || null;
  }

  _normalizeAvailableModels(availableModels) {
    if (!Array.isArray(availableModels)) {
      return [];
    }
    return availableModels
      .map((model) => {
        if (typeof model === 'string') {
          const id = this._normalizeModelId(model);
          return id ? { id, name: id } : null;
        }
        if (!model || typeof model !== 'object') {
          return null;
        }
        const id = this._normalizeModelId(model.id);
        if (!id) {
          return null;
        }
        return {
          id,
          name: model.name || id,
          description: model.description || null,
          degradedModels: Array.isArray(model.degradedModels)
            ? model.degradedModels
              .map((entry) => String(entry || '').trim())
              .filter(Boolean)
            : []
        };
      })
      .filter(Boolean);
  }

  _normalizeDegradedModelSet(adapter, degradedModels) {
    if (!Array.isArray(degradedModels)) {
      return new Set();
    }

    const normalized = new Set();
    for (const entry of degradedModels) {
      if (typeof entry === 'string') {
        const modelId = this._normalizeModelId(entry);
        if (modelId) {
          normalized.add(modelId);
        }
        continue;
      }

      if (!entry || typeof entry !== 'object') {
        continue;
      }

      if (entry.adapter && String(entry.adapter) !== String(adapter)) {
        continue;
      }

      const modelId = this._normalizeModelId(entry.model || entry.id);
      if (modelId) {
        normalized.add(modelId);
      }
    }

    return normalized;
  }

  _normalizeModelHealthOptions(rawOptions = {}) {
    const options = {
      ...DEFAULT_MODEL_HEALTH_OPTIONS
    };

    const failureThreshold = Number.parseInt(rawOptions.failureThreshold, 10);
    if (Number.isInteger(failureThreshold) && failureThreshold > 0) {
      options.failureThreshold = failureThreshold;
    }

    const successThreshold = Number.parseInt(rawOptions.successThreshold, 10);
    if (Number.isInteger(successThreshold) && successThreshold > 0) {
      options.successThreshold = successThreshold;
    }

    const resetTimeout = Number.parseInt(
      rawOptions.resetTimeoutMs ?? rawOptions.resetTimeout,
      10
    );
    if (Number.isInteger(resetTimeout) && resetTimeout > 0) {
      options.resetTimeout = resetTimeout;
    }

    const timeout = Number.parseInt(rawOptions.timeoutMs ?? rawOptions.timeout, 10);
    if (Number.isInteger(timeout) && timeout > 0) {
      options.timeout = timeout;
    }

    return options;
  }

  _getModelHealthOptions(adapter) {
    this.reload();
    const globalOptions = this.rawConfig?._meta?.modelHealth || {};
    const adapterOptions = this.rawConfig?.adapters?.[adapter]?.modelHealth || {};
    return this._normalizeModelHealthOptions({
      ...globalOptions,
      ...adapterOptions
    });
  }

  _buildModelHealthKey(adapter, model) {
    const normalizedAdapter = String(adapter || '').trim();
    const normalizedModel = this._normalizeModelId(model);
    if (!normalizedAdapter || !normalizedModel) {
      return null;
    }
    return `${normalizedAdapter}:${normalizedModel}`;
  }

  _getOrCreateHealthCircuit(adapter, model) {
    const key = this._buildModelHealthKey(adapter, model);
    if (!key) {
      return null;
    }

    return this.modelHealthRegistry.getCircuit(
      key,
      this._getModelHealthOptions(adapter)
    );
  }

  getModelHealth({ adapter, model } = {}) {
    const modelId = this._normalizeModelId(model);
    if (!adapter || !modelId) {
      return null;
    }

    const key = this._buildModelHealthKey(adapter, modelId);
    const circuit = this._getOrCreateHealthCircuit(adapter, modelId);
    const state = circuit.getState();
    const metadata = this.modelHealthMetadata.get(key) || {};
    const resetTimeout = circuit.resetTimeout || this._getModelHealthOptions(adapter).resetTimeout;
    const recoverInMs = state.state === CircuitState.OPEN && state.lastFailure
      ? Math.max(resetTimeout - (Date.now() - state.lastFailure), 0)
      : 0;

    return {
      adapter,
      model: modelId,
      state: state.state,
      degraded: state.state === CircuitState.OPEN,
      failures: state.failures,
      successes: state.successes,
      recoverInMs,
      lastFailureAt: state.lastFailure ? new Date(state.lastFailure).toISOString() : null,
      lastSuccessAt: metadata.lastSuccessAt || null,
      failureClass: metadata.failureClass || null,
      reason: metadata.reason || null,
      lastOutcome: metadata.lastOutcome || null
    };
  }

  recordModelFailure({ adapter, model, failureClass = null, reason = null } = {}) {
    const modelId = this._normalizeModelId(model);
    if (!adapter || !modelId) {
      return null;
    }

    const key = this._buildModelHealthKey(adapter, modelId);
    const state = this.modelHealthRegistry.recordFailure(
      key,
      {
        failureClass,
        code: failureClass,
        message: reason
      },
      this._getModelHealthOptions(adapter)
    );

    const previous = this.modelHealthMetadata.get(key) || {};
    this.modelHealthMetadata.set(key, {
      ...previous,
      lastFailureAt: new Date().toISOString(),
      failureClass: failureClass || previous.failureClass || null,
      reason: reason || previous.reason || null,
      lastOutcome: 'failure'
    });

    return {
      ...this.getModelHealth({ adapter, model: modelId }),
      circuitState: state.state
    };
  }

  recordModelSuccess({ adapter, model } = {}) {
    const modelId = this._normalizeModelId(model);
    if (!adapter || !modelId) {
      return null;
    }

    const key = this._buildModelHealthKey(adapter, modelId);
    const circuit = this._getOrCreateHealthCircuit(adapter, modelId);
    if (circuit.state !== CircuitState.CLOSED) {
      circuit.reset();
    } else {
      circuit.recordSuccess();
    }
    const state = circuit.getState();

    const previous = this.modelHealthMetadata.get(key) || {};
    this.modelHealthMetadata.set(key, {
      ...previous,
      lastSuccessAt: new Date().toISOString(),
      failureClass: state.state === CircuitState.CLOSED ? null : previous.failureClass || null,
      reason: state.state === CircuitState.CLOSED ? null : previous.reason || null,
      lastOutcome: 'success'
    });

    return {
      ...this.getModelHealth({ adapter, model: modelId }),
      circuitState: state.state
    };
  }

  resetModelHealth({ adapter = null, model = null } = {}) {
    const normalizedAdapter = adapter ? String(adapter).trim() : null;
    const normalizedModel = this._normalizeModelId(model);

    if (!normalizedAdapter && !normalizedModel) {
      this.modelHealthRegistry.resetAll();
      this.modelHealthMetadata.clear();
      return;
    }

    for (const [key, circuit] of this.modelHealthRegistry.circuits.entries()) {
      const separatorIndex = key.indexOf(':');
      const entryAdapter = separatorIndex >= 0 ? key.slice(0, separatorIndex) : '';
      const entryModel = separatorIndex >= 0 ? key.slice(separatorIndex + 1) : '';
      if (normalizedAdapter && entryAdapter !== normalizedAdapter) {
        continue;
      }
      if (normalizedModel && entryModel !== normalizedModel) {
        continue;
      }
      circuit.reset();
      this.modelHealthMetadata.delete(key);
    }
  }

  recommendModel({ adapter, role, taskType, availableModels, runtimeProviders, degradedModels } = {}) {
    const policy = this.getAdapterPolicy(adapter);
    const normalizedTaskType = this._normalizeTaskKey({ role, taskType });
    const normalizedModels = this._normalizeAvailableModels(availableModels);
    const availableById = new Map(normalizedModels.map((model) => [model.id, model]));
    const explicitlyDegradedModels = this._normalizeDegradedModelSet(adapter, degradedModels);

    if (!policy) {
      return {
        adapter,
        role: role || null,
        taskType: normalizedTaskType,
        selectedModel: null,
        selectedProvider: null,
        selectedFamily: null,
        strategy: 'no-policy',
        source: path.relative(process.cwd(), this.configPath),
        summary: `No broker routing policy is configured for adapter '${adapter}'.`,
        candidates: [],
        runtimeProviders: Array.isArray(runtimeProviders) ? runtimeProviders : []
      };
    }

    const taskFamilies = policy.taskFamilies || {};
    const familyOrder = taskFamilies[normalizedTaskType] || taskFamilies.default || [];
    const families = policy.families || {};
    const candidates = [];

    for (const familyName of familyOrder) {
      const family = families[familyName];
      if (!family || typeof family !== 'object') {
        continue;
      }
      for (const [provider, modelIds] of Object.entries(family.providers || {})) {
        for (const modelId of modelIds || []) {
          const normalizedModelId = this._normalizeModelId(modelId);
          if (!normalizedModelId) {
            continue;
          }
          const availableModel = availableById.get(normalizedModelId) || null;
          const health = this.getModelHealth({ adapter, model: normalizedModelId });
          const degradedByHealth = Boolean(health?.degraded);
          const degradedByOverride = explicitlyDegradedModels.has(normalizedModelId);
          const degradedByAvailableModelMetadata = Boolean(
            availableModel && Array.isArray(availableModel.degradedModels) && availableModel.degradedModels.some((entry) => (
              entry === provider || entry === normalizedModelId
            ))
          );
          candidates.push({
            family: familyName,
            familyDescription: family.description || null,
            provider,
            model: normalizedModelId,
            available: Boolean(availableModel),
            matchedBy: availableModel ? 'exact-id' : null,
            degraded: degradedByHealth || degradedByOverride || degradedByAvailableModelMetadata,
            degradedSource: degradedByOverride
              ? 'explicit'
              : degradedByAvailableModelMetadata
                ? 'available-model-metadata'
              : degradedByHealth
                ? 'health'
                : null,
            degradedReason: degradedByOverride
              ? 'Model explicitly marked degraded for this recommendation.'
              : degradedByAvailableModelMetadata
                ? 'Available model metadata marked this provider/model degraded.'
              : health?.reason || null,
            health
          });
        }
      }
    }

    const selectedHealthy = candidates.find((candidate) => candidate.available && !candidate.degraded) || null;
    const selected = selectedHealthy || candidates.find((candidate) => candidate.available) || null;
    const selectedIndex = selected ? candidates.indexOf(selected) : -1;
    const skippedDegradedCandidate = selectedIndex > 0 && candidates
      .slice(0, selectedIndex)
      .some((candidate) => candidate.available && candidate.degraded);

    let strategy = 'config-ranked-no-match';
    let summary = `No configured model candidate is currently available for ${adapter} (${normalizedTaskType}).`;

    if (selected) {
      if (selected.degraded) {
        strategy = 'config-ranked-all-degraded';
        summary = `Selected degraded candidate ${selected.model} for ${normalizedTaskType} because no healthy configured candidate is currently available.`;
      } else if (skippedDegradedCandidate) {
        strategy = 'config-ranked-health-fallback';
        summary = `Selected ${selected.model} for ${normalizedTaskType} after skipping degraded candidates earlier in policy order.`;
      } else {
        strategy = 'config-ranked-exact';
        summary = `Selected ${selected.model} for ${normalizedTaskType} using ${selected.family} policy.`;
      }
    } else if (candidates.some((candidate) => candidate.degraded)) {
      strategy = 'config-ranked-no-healthy-match';
      summary = `No healthy configured model candidate is currently available for ${adapter} (${normalizedTaskType}).`;
    }

    return {
      adapter,
      role: role || null,
      taskType: normalizedTaskType,
      selectedModel: selected?.model || null,
      selectedProvider: selected?.provider || null,
      selectedFamily: selected?.family || null,
      strategy,
      source: path.relative(process.cwd(), this.configPath),
      familyOrder,
      summary,
      candidates,
      runtimeProviders: Array.isArray(runtimeProviders) ? runtimeProviders : []
    };
  }
}

let instance = null;

function getModelRoutingService(options = {}) {
  if (!instance) {
    instance = new ModelRoutingService(options);
  }
  return instance;
}

module.exports = {
  ModelRoutingService,
  getModelRoutingService
};
