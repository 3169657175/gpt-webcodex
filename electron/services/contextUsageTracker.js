const { EventEmitter } = require('node:events');

const DEFAULT_CONTEXT_BUDGET = 128_000;

function estimateTokens(content) {
  if (typeof content !== 'string') {
    if (content === null || content === undefined) return 0;
    try {
      content = typeof content === 'object' ? JSON.stringify(content) : String(content);
    } catch {
      return 0;
    }
  }
  if (!content) return 0;

  let chineseChars = 0;
  let otherChars = 0;

  for (let i = 0; i < content.length; i += 1) {
    const code = content.charCodeAt(i);
    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf) || (code >= 0x3000 && code <= 0x303f)) {
      chineseChars += 1;
    } else {
      otherChars += 1;
    }
  }

  const estimated = Math.round(chineseChars * 1.3 + otherChars * 0.27);
  return Math.max(1, estimated);
}

class ContextUsageTracker extends EventEmitter {
  constructor(options = {}) {
    super();
    this.contextBudget = Number(options.contextBudget || DEFAULT_CONTEXT_BUDGET);
    this.reset();
  }

  reset() {
    this.totalBytes = 0;
    this.totalTokens = 0;
    this.callCount = 0;
    this.lastCall = null;
    this.maxCall = null;
    this.tools = {};
    this.localCalls = [];
    this.syncedSessionId = null;
    this.sessionStartedAt = new Date().toISOString();
    this.updatedAt = this.sessionStartedAt;
    const currentSnapshot = this.snapshot();
    this.emit('change', currentSnapshot);
    return currentSnapshot;
  }

  recordToolCall(toolName, args = {}, result = null) {
    const safeName = String(toolName || 'unknown').trim();
    let reqText = '';
    let resText = '';

    try { reqText = typeof args === 'string' ? args : JSON.stringify(args || {}); } catch { reqText = ''; }
    try { resText = typeof result === 'string' ? result : JSON.stringify(result || {}); } catch { resText = ''; }

    const reqBytes = Buffer.byteLength(reqText, 'utf8');
    const resBytes = Buffer.byteLength(resText, 'utf8');
    const callBytes = reqBytes + resBytes;

    const reqTokens = estimateTokens(reqText);
    const resTokens = estimateTokens(resText);
    const callTokens = reqTokens + resTokens;

    this.totalBytes += callBytes;
    this.totalTokens += callTokens;
    this.callCount += 1;
    this.updatedAt = new Date().toISOString();

    const callRecord = {
      tool: safeName,
      bytes: callBytes,
      tokens: callTokens,
      timestamp: this.updatedAt
    };

    this.localCalls.push(callRecord);
    this.lastCall = callRecord;
    if (!this.maxCall || callTokens > this.maxCall.tokens) {
      this.maxCall = callRecord;
    }

    if (!this.tools[safeName]) {
      this.tools[safeName] = { calls: 0, bytes: 0, tokens: 0 };
    }
    this.tools[safeName].calls += 1;
    this.tools[safeName].bytes += callBytes;
    this.tools[safeName].tokens += callTokens;

    const currentSnapshot = this.snapshot();
    this.emit('change', currentSnapshot);
    return currentSnapshot;
  }

  syncWithRuntime(performanceTrace = null) {
    if (!performanceTrace || typeof performanceTrace !== 'object') {
      return this.snapshot();
    }

    const sessionId = performanceTrace.current_session_id || null;
    if (sessionId && this.syncedSessionId && sessionId !== this.syncedSessionId) {
      this.reset();
    }
    if (sessionId) {
      this.syncedSessionId = sessionId;
    }

    const extCalls = Math.max(0, Number(performanceTrace.tool_calls || 0));
    const reqBytes = Math.max(0, Number(performanceTrace.request_bytes || 0));
    const resBytes = Math.max(0, Number(performanceTrace.response_bytes || 0));
    const extBytes = reqBytes + resBytes;
    const recent = Array.isArray(performanceTrace.recent) ? performanceTrace.recent : [];

    let calculatedTokens = 0;
    let maxExtCall = null;
    let lastExtCall = null;
    const toolsMap = {};

    for (const item of recent) {
      const toolName = String(item.tool || 'unknown');
      const itemBytes = Math.max(0, Number(item.request_bytes || 0)) + Math.max(0, Number(item.response_bytes || 0));
      const itemTokens = Math.max(1, Math.round(itemBytes / 3.2));
      calculatedTokens += itemTokens;

      const record = {
        tool: toolName,
        bytes: itemBytes,
        tokens: itemTokens,
        timestamp: item.finished_at || item.started_at || this.updatedAt
      };

      if (!maxExtCall || itemTokens > maxExtCall.tokens) {
        maxExtCall = record;
      }
      lastExtCall = record;

      if (!toolsMap[toolName]) {
        toolsMap[toolName] = { calls: 0, bytes: 0, tokens: 0 };
      }
      toolsMap[toolName].calls += 1;
      toolsMap[toolName].bytes += itemBytes;
      toolsMap[toolName].tokens += itemTokens;
    }

    if (extBytes > 0) {
      const estimatedTotalTokens = Math.max(calculatedTokens, Math.round(extBytes / 3.2));
      if (estimatedTotalTokens > calculatedTokens) {
        calculatedTokens = estimatedTotalTokens;
      }
    }

    let localBytes = 0;
    let localTokens = 0;
    for (const call of this.localCalls) {
      localBytes += call.bytes;
      localTokens += call.tokens;
      if (!maxExtCall || call.tokens > maxExtCall.tokens) {
        maxExtCall = call;
      }
      lastExtCall = call;
      if (!toolsMap[call.tool]) {
        toolsMap[call.tool] = { calls: 0, bytes: 0, tokens: 0 };
      }
      toolsMap[call.tool].calls += 1;
      toolsMap[call.tool].bytes += call.bytes;
      toolsMap[call.tool].tokens += call.tokens;
    }

    const previousTokens = this.totalTokens;
    this.totalBytes = extBytes + localBytes;
    this.totalTokens = calculatedTokens + localTokens;
    this.callCount = extCalls + this.localCalls.length;
    this.tools = toolsMap;
    if (maxExtCall) this.maxCall = maxExtCall;
    if (lastExtCall) this.lastCall = lastExtCall;
    this.updatedAt = performanceTrace.last_finished_at || new Date().toISOString();

    const snapshot = this.snapshot();
    if (this.totalTokens !== previousTokens) {
      this.emit('change', snapshot);
    }
    return snapshot;
  }

  pressureLevel() {
    const ratio = this.totalTokens / this.contextBudget;
    if (ratio >= 0.6) return 'heavy';
    if (ratio >= 0.25) return 'moderate';
    return 'safe';
  }

  snapshot() {
    const level = this.pressureLevel();
    const percent = Math.min(100, Math.round((this.totalTokens / this.contextBudget) * 100));
    return {
      totalBytes: this.totalBytes,
      totalTokens: this.totalTokens,
      callCount: this.callCount,
      lastCall: this.lastCall,
      maxCall: this.maxCall,
      tools: { ...this.tools },
      contextBudget: this.contextBudget,
      pressureLevel: level,
      percent,
      sessionStartedAt: this.sessionStartedAt,
      updatedAt: this.updatedAt
    };
  }
}

module.exports = {
  ContextUsageTracker,
  estimateTokens,
  DEFAULT_CONTEXT_BUDGET
};
