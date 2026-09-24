const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readJson, updateJsonAtomic, ensureParent } = require('./jsonStore');

const DECISIONS = new Set(['allow_once', 'allow_session', 'allow_project', 'deny']);
const MAX_REQUESTS = 100;
const MAX_GRANTS = 64;
const PENDING_TTL_MS = 6 * 60 * 60 * 1000;

function nowIso() { return new Date().toISOString(); }

function redact(value) {
  return String(value || '')
    .slice(0, 500)
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, '$1<redacted>')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '<redacted-key>')
    .replace(/\b(api[_-]?key|token|password|passwd|cookie|secret)\b\s*[:=]\s*([^\s,;]+)/gi, '$1=<redacted>');
}

class ApprovalService {
  constructor(settingsStore) {
    this.settingsStore = settingsStore;
  }

  paths() {
    const workspace = String(this.settingsStore.load().workspace || '').trim();
    if (!workspace) throw new Error('Choose a workspace first.');
    const root = path.resolve(workspace);
    return {
      root,
      state: path.join(root, '.coding-tools', 'approval-state.json'),
      audit: path.join(root, '.coding-tools', 'audit.jsonl')
    };
  }

  _state() {
    const { state } = this.paths();
    const raw = readJson(state, { version: 1, requests: [], grants: [] });
    return {
      version: 1,
      requests: Array.isArray(raw.requests) ? raw.requests.slice(-MAX_REQUESTS) : [],
      grants: Array.isArray(raw.grants) ? raw.grants.slice(-MAX_GRANTS) : []
    };
  }

  _safeRequest(item) {
    if (!item || typeof item !== 'object') return null;
    return {
      request_id: String(item.request_id || ''),
      status: String(item.status || 'pending'),
      tool: String(item.tool || ''),
      action: String(item.action || ''),
      categories: Array.isArray(item.categories) ? item.categories.map(String).slice(0, 8) : [],
      risk_level: String(item.risk_level || ''),
      summary: redact(item.summary),
      workspace: String(item.workspace || ''),
      runtime_instance_id: String(item.runtime_instance_id || ''),
      created_at: String(item.created_at || '')
    };
  }

  _prunePending() {
    const { state: statePath } = this.paths();
    const policies = this.settingsStore.load().toolPermissions || {};
    let result = { version: 1, requests: [], grants: [] };
    updateJsonAtomic(statePath, (raw) => {
      const now = Date.now();
      const requests = (Array.isArray(raw?.requests) ? raw.requests : []).filter((item) => {
        if (!item || typeof item !== 'object') return false;
        if (String(item.status || '') !== 'pending') return true;
        const createdAt = Date.parse(String(item.created_at || ''));
        if (Number.isFinite(createdAt) && now - createdAt > PENDING_TTL_MS) return false;
        const categories = Array.isArray(item.categories) ? item.categories.map(String) : [];
        return categories.some((category) => String(policies[category] || 'ask') === 'ask');
      }).slice(-MAX_REQUESTS);
      const grants = (Array.isArray(raw?.grants) ? raw.grants : []).slice(-MAX_GRANTS);
      result = { version: 1, requests, grants };
      return result;
    }, { version: 1, requests: [], grants: [] });
    return result;
  }

  list() {
    const state = this._prunePending();
    const pending = state.requests
      .filter((item) => item && item.status === 'pending')
      .map((item) => this._safeRequest(item))
      .filter(Boolean)
      .reverse();
    return { pending, pending_count: pending.length };
  }

  _audit(event) {
    const { audit } = this.paths();
    ensureParent(audit);
    const record = {
      time: nowIso(),
      event: redact(event.event),
      request_id: redact(event.request_id),
      decision: redact(event.decision),
      tool: redact(event.tool),
      risk_level: redact(event.risk_level),
      categories: Array.isArray(event.categories) ? event.categories.map(redact).slice(0, 8) : [],
      summary: redact(event.summary)
    };
    fs.appendFileSync(audit, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
  }

  decide(requestId, decision) {
    const id = String(requestId || '').trim();
    const selected = String(decision || '').trim().toLowerCase();
    if (!id) throw new Error('Approval request ID is required.');
    if (!DECISIONS.has(selected)) throw new Error('Unsupported approval decision.');
    const { state: statePath } = this.paths();
    let decided;
    updateJsonAtomic(statePath, (raw) => {
      const state = {
        version: 1,
        requests: Array.isArray(raw?.requests) ? raw.requests.slice(-MAX_REQUESTS) : [],
        grants: Array.isArray(raw?.grants) ? raw.grants.slice(-MAX_GRANTS) : []
      };
      const request = [...state.requests].reverse().find((item) => item && String(item.request_id || '') === id);
      if (!request) throw new Error('Approval request is missing or expired.');
      if (String(request.status || '') !== 'pending') throw new Error('Approval request has already been handled.');
      request.decision_at = nowIso();
      if (selected === 'deny') {
        request.status = 'denied';
      } else if (selected === 'allow_once') {
        request.status = 'approved_once';
      } else {
        const scope = selected === 'allow_session' ? 'session' : 'project';
        request.status = scope === 'session' ? 'approved_session' : 'approved_project';
        state.grants.push({
          grant_id: crypto.randomBytes(12).toString('hex'),
          status: 'active',
          scope,
          categories: Array.isArray(request.categories) ? request.categories.map(String).slice(0, 8) : [],
          runtime_instance_id: scope === 'session' ? String(request.runtime_instance_id || '') : '',
          source_request_id: id,
          created_at: nowIso()
        });
        state.grants = state.grants.slice(-MAX_GRANTS);
      }
      decided = this._safeRequest(request);
      return state;
    }, { version: 1, requests: [], grants: [] });
    this._audit({ event: 'local_approval_decision', request_id: id, decision: selected, ...decided });
    return { decision: selected, request: decided, ...this.list() };
  }
}

module.exports = { ApprovalService, redact, PENDING_TTL_MS };
