'use strict';

const { ACTIVE_BROKER_ADAPTERS } = require('../adapters/active-surface');
const { getAgentProfiles } = require('../services/agent-profiles');
const { isAdapterAuthenticated } = require('../utils/adapter-auth');
const { getChildSessionSupport } = require('./child-session-support');

const DEFAULT_READINESS_TTL_MS = 24 * 60 * 60 * 1000;

const READINESS_OVERALL_VALUES = new Set(['ready', 'partial', 'not-ready', 'skipped']);
const READINESS_REASON_CODES = new Set([
  'binary_not_found',
  'auth_failed',
  'quota_exceeded',
  'rate_limited',
  'timeout',
  'capability_missing',
  'live_test_failed',
  'live_test_partial',
  'readiness_store_unavailable',
  'unknown'
]);

function normalizeBoolean(value, fallback = null) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
}

function normalizeTimestamp(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : fallback;
}

function normalizeString(value, fallback = null) {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

function normalizeOverall(value) {
  const normalized = normalizeString(value, 'unknown').toLowerCase();
  return READINESS_OVERALL_VALUES.has(normalized) ? normalized : 'not-ready';
}

function normalizeReasonCode(value, fallback = 'unknown') {
  const normalized = normalizeString(value, fallback).toLowerCase();
  return READINESS_REASON_CODES.has(normalized) ? normalized : fallback;
}

function deriveReasonCode({ available, authenticated, overall, reasonCode, reason } = {}) {
  if (reasonCode) {
    return normalizeReasonCode(reasonCode);
  }
  if (available === false) {
    return 'binary_not_found';
  }
  if (authenticated === false) {
    return 'auth_failed';
  }
  if (overall === 'partial') {
    return 'live_test_partial';
  }
  if (overall === 'not-ready') {
    return 'live_test_failed';
  }
  const text = String(reason || '').toLowerCase();
  if (text.includes('quota')) return 'quota_exceeded';
  if (text.includes('rate limit')) return 'rate_limited';
  if (text.includes('timeout') || text.includes('timed out')) return 'timeout';
  return 'unknown';
}

function normalizeReadinessReportInput(input = {}, options = {}) {
  const checks = input.checks && typeof input.checks === 'object' && !Array.isArray(input.checks)
    ? input.checks
    : {};
  const details = Array.isArray(input.details)
    ? input.details.map((entry) => String(entry))
    : input.details ? [String(input.details)] : [];
  const overall = normalizeOverall(input.overall);
  const available = normalizeBoolean(input.available, null);
  const authenticated = normalizeBoolean(input.authenticated, null);
  const collaboratorFromChecks = checks.session_continuity === true;
  const partialChecksPass = checks.route_launch === true
    && checks.first_output === true
    && checks.followup_input === true;
  const ephemeralReady = normalizeBoolean(
    input.ephemeralReady ?? input.ephemeral_ready,
    overall === 'ready' || (overall === 'partial' && partialChecksPass)
  );
  const collaboratorReady = normalizeBoolean(
    input.collaboratorReady ?? input.collaborator_ready,
    overall === 'ready' && collaboratorFromChecks
  );
  const reason = normalizeString(input.reason, details.join(' | ') || null);
  const reasonCode = deriveReasonCode({
    available,
    authenticated,
    overall,
    reasonCode: input.reasonCode || input.reason_code,
    reason
  });

  return {
    adapter: normalizeString(input.adapter),
    available,
    authenticated,
    authReason: normalizeString(input.authReason || input.auth_reason),
    ephemeralReady,
    collaboratorReady,
    continuityMode: normalizeString(input.continuityMode || input.continuity_mode, collaboratorReady ? 'provider_resume' : 'stateless'),
    overall,
    reasonCode,
    reason,
    checks,
    details,
    source: normalizeString(input.source, 'live'),
    staleAfterMs: normalizeTimestamp(input.staleAfterMs ?? input.stale_after_ms, options.defaultTtlMs || DEFAULT_READINESS_TTL_MS),
    verifiedAt: normalizeTimestamp(input.verifiedAt ?? input.verified_at, Date.now()),
    createdAt: normalizeTimestamp(input.createdAt ?? input.created_at),
    updatedAt: normalizeTimestamp(input.updatedAt ?? input.updated_at)
  };
}

function buildChildSessionSupportAlias(effective = {}) {
  return {
    ephemeralReady: effective.ephemeralReady === true,
    collaboratorReady: effective.collaboratorReady === true,
    continuityMode: effective.continuityMode || 'stateless',
    reason: effective.reason || null
  };
}

class AdapterReadinessService {
  constructor(options = {}) {
    this.db = options.db || null;
    this.apiSessionManager = options.apiSessionManager || null;
    this.profileService = options.profileService || getAgentProfiles();
    this.adapterAuthInspector = typeof options.adapterAuthInspector === 'function'
      ? options.adapterAuthInspector
      : isAdapterAuthenticated;
    this.defaultTtlMs = normalizeTimestamp(options.defaultTtlMs, DEFAULT_READINESS_TTL_MS);
  }

  listKnownAdapters() {
    const configured = typeof this.profileService?.listAdapters === 'function'
      ? this.profileService.listAdapters()
      : [];
    const runtime = typeof this.apiSessionManager?.getAdapterNames === 'function'
      ? this.apiSessionManager.getAdapterNames()
      : [];
    return Array.from(new Set([
      ...ACTIVE_BROKER_ADAPTERS,
      ...configured,
      ...runtime
    ].filter(Boolean))).sort();
  }

  isKnownAdapter(adapter) {
    return this.listKnownAdapters().includes(adapter);
  }

  async buildRuntimeSnapshot(adapterName) {
    const adapter = typeof this.apiSessionManager?.getAdapter === 'function'
      ? this.apiSessionManager.getAdapter(adapterName)
      : null;
    let available = null;
    if (adapter?.isAvailable) {
      try {
        available = await adapter.isAvailable();
      } catch {
        available = false;
      }
    }
    const auth = this.adapterAuthInspector(adapterName) || {
      authenticated: false,
      reason: 'Adapter authentication could not be determined'
    };
    const capabilities = typeof adapter?.getCapabilities === 'function'
      ? adapter.getCapabilities()
      : null;
    const advertised = getChildSessionSupport(adapterName, capabilities);
    const unavailableReason = available === false ? 'adapter CLI is not available' : null;
    const unauthenticatedReason = auth.authenticated === false ? auth.reason : null;
    const readyReason = unavailableReason || unauthenticatedReason || advertised.reason || null;

    return {
      source: 'runtime',
      available,
      authenticated: auth.authenticated,
      authReason: auth.reason,
      capabilities,
      advertised,
      ephemeralReady: advertised.ephemeralReady === true && available !== false && auth.authenticated !== false,
      collaboratorReady: advertised.collaboratorReady === true && available !== false && auth.authenticated !== false,
      continuityMode: advertised.continuityMode || 'stateless',
      overall: advertised.ephemeralReady ? 'partial' : 'not-ready',
      reasonCode: deriveReasonCode({
        available,
        authenticated: auth.authenticated,
        overall: advertised.ephemeralReady ? 'partial' : 'not-ready',
        reason: readyReason
      }),
      reason: readyReason,
      verified: false,
      verifiedAt: null
    };
  }

  getLiveReport(adapterName) {
    if (!this.db || typeof this.db.getAdapterReadinessReport !== 'function') {
      return { report: null, warning: null };
    }
    try {
      return { report: this.db.getAdapterReadinessReport(adapterName), warning: null };
    } catch (error) {
      return {
        report: null,
        warning: {
          code: 'readiness_store_unavailable',
          message: error.message
        }
      };
    }
  }

  isLiveReportFresh(report, now = Date.now()) {
    if (!report || !report.verifiedAt) {
      return false;
    }
    const ttl = Number.isFinite(report.staleAfterMs) ? report.staleAfterMs : this.defaultTtlMs;
    return now - report.verifiedAt <= ttl;
  }

  buildEffectiveReadiness(runtime, liveReport, options = {}) {
    const now = options.now || Date.now();
    const liveFresh = this.isLiveReportFresh(liveReport, now);
    const live = liveReport
      ? {
          ...liveReport,
          stale: !liveFresh,
          ageMs: liveReport.verifiedAt ? Math.max(0, now - liveReport.verifiedAt) : null
        }
      : null;

    if (live && liveFresh && live.overall !== 'skipped') {
      return {
        ...runtime,
        available: live.available ?? runtime.available,
        authenticated: live.authenticated ?? runtime.authenticated,
        authReason: live.authReason ?? runtime.authReason,
        ephemeralReady: live.overall === 'not-ready' ? false : live.ephemeralReady === true,
        collaboratorReady: live.overall === 'ready' && live.collaboratorReady === true,
        continuityMode: live.continuityMode || runtime.continuityMode,
        overall: live.overall,
        reasonCode: live.reasonCode || runtime.reasonCode,
        reason: live.reason || runtime.reason,
        verified: true,
        source: 'live',
        verifiedAt: live.verifiedAt,
        live
      };
    }

    return {
      ...runtime,
      source: 'runtime',
      live,
      verified: false
    };
  }

  async getAdapterReadiness(adapterName, options = {}) {
    const runtime = await this.buildRuntimeSnapshot(adapterName);
    const { report, warning } = this.getLiveReport(adapterName);
    const effective = this.buildEffectiveReadiness(runtime, report, options);
    const warnings = warning ? [warning] : [];

    return {
      adapter: adapterName,
      advertised: {
        ...runtime.advertised,
        capabilities: runtime.capabilities || null
      },
      runtime,
      live: effective.live || null,
      effective: {
        available: effective.available,
        authenticated: effective.authenticated,
        authReason: effective.authReason || null,
        ephemeralReady: effective.ephemeralReady === true,
        collaboratorReady: effective.collaboratorReady === true,
        continuityMode: effective.continuityMode || 'stateless',
        overall: effective.overall || 'not-ready',
        reasonCode: effective.reasonCode || null,
        reason: effective.reason || null,
        verified: effective.verified === true,
        source: effective.source,
        verifiedAt: effective.verifiedAt || null
      },
      childSessionSupport: buildChildSessionSupportAlias(effective),
      warnings
    };
  }

  async listAdapterReadiness() {
    const adapters = this.listKnownAdapters();
    const entries = {};
    for (const adapterName of adapters) {
      entries[adapterName] = await this.getAdapterReadiness(adapterName);
    }
    return entries;
  }

  recordLiveReport(input = {}) {
    if (!this.db || typeof this.db.upsertAdapterReadinessReport !== 'function') {
      throw new Error('adapter readiness storage is not configured');
    }
    const normalized = normalizeReadinessReportInput(input, { defaultTtlMs: this.defaultTtlMs });
    if (!normalized.adapter) {
      throw new Error('adapter is required');
    }
    if (!this.isKnownAdapter(normalized.adapter)) {
      throw new Error(`unknown adapter: ${normalized.adapter}`);
    }
    return this.db.upsertAdapterReadinessReport(normalized);
  }

  recordLiveReports(results = []) {
    const accepted = [];
    const rejected = [];
    for (const result of results) {
      try {
        accepted.push(this.recordLiveReport(result));
      } catch (error) {
        rejected.push({
          adapter: result?.adapter || null,
          error: error.message
        });
      }
    }
    return { accepted, rejected };
  }
}

module.exports = {
  DEFAULT_READINESS_TTL_MS,
  READINESS_OVERALL_VALUES,
  READINESS_REASON_CODES,
  AdapterReadinessService,
  buildChildSessionSupportAlias,
  normalizeReadinessReportInput
};
