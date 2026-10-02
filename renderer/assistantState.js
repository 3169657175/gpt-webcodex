(function (root) {
  'use strict';

  const presentation = typeof module !== 'undefined' && module.exports
    ? require('./progressPresentation')
    : root.progressPresentation;
  if (!presentation?.describe) throw new Error('progressPresentation is required before assistantState');

  const STALL_SECONDS = Number(presentation.thresholds?.localHeartbeatStallSeconds || 90);

  function needsHumanAttention(state) {
    const lifecycle = String(state?.lifecycle_state || '');
    if (['needs_user', 'waiting_user', 'waiting_approval', 'paused'].includes(lifecycle)) return true;
    if (lifecycle === 'waiting_model') return false;
    if (!['waiting', 'paused'].includes(String(state?.status || ''))) return false;
    const text = [state?.current_step, state?.next_step, state?.failure].filter(Boolean).join(' ');
    return /(waiting\s+for\s+(user|approval|permission|confirmation|input|review)|needs?\s+(user|approval|permission|confirmation|input)|requires?\s+(approval|permission|confirmation|input)|用户|人工|确认|授权|批准|输入|选择|审阅|审核)/i.test(text);
  }

  function taskCanBeBlockedByRuntime(state) {
    const lifecycle = String(state?.lifecycle_state || '');
    if (lifecycle) return ['created', 'planning', 'ready', 'preparing', 'running', 'verifying', 'recovering'].includes(lifecycle);
    const status = String(state?.status || 'idle');
    return status === 'active' || (status === 'waiting' && !needsHumanAttention(state));
  }

  function describe(task, operation, streamState, now = Date.now(), available = true, activity = null, stale = false, runtimeLayers = null) {
    const view = presentation.describe(task, operation, streamState, now, available, activity, stale, runtimeLayers) || {};
    const userState = String(view.userState || view.key || 'idle');
    return { ...view, userState };
  }

  function labelFor(view) {
    return {
      testing: '测试中', building: '构建中', waiting_model: '等待模型', waiting_user: '等待处理', quiet: '仍在运行',
      suspected_stall: '疑似停滞', stalled: '疑似卡住', generating: '模型处理中', local_running: '执行中', planning: '正在分析',
      recovering: '正在恢复', completed: '已完成', failed: '失败', stopped: '已停止', idle: '空闲', waiting: '状态待确认'
    }[String(view?.userState || view?.key || '')] || '执行中';
  }

  function toneFor(view) {
    const value = String(view?.userState || view?.key || '');
    if (['failed', 'stalled'].includes(value)) return 'danger';
    if (value === 'completed') return 'positive';
    if (['idle', 'stopped'].includes(value)) return 'neutral';
    return 'warning';
  }

  function eventForState(state, nowMs = Date.now()) {
    const lifecycle = String(state?.lifecycle_state || '');
    const heartbeat = Date.parse(String(state?.last_heartbeat_at || state?.updated_at || ''));
    const heartbeatAge = Number.isFinite(heartbeat) ? Math.max(0, Math.floor((nowMs - heartbeat) / 1000)) : null;
    if (taskCanBeBlockedByRuntime(state) && heartbeatAge != null && heartbeatAge >= STALL_SECONDS) return 'stalled';
    if (lifecycle === 'completed' || state?.status === 'completed') return 'completed';
    if (lifecycle === 'failed' || state?.status === 'failed') return 'failed';
    if (lifecycle === 'cancelled' || state?.status === 'stopped') return 'stopped';
    if (needsHumanAttention(state)) return 'attention';
    return null;
  }

  function taskbarState(state) {
    const lifecycle = String(state?.lifecycle_state || '');
    if (['failed', 'cancelled'].includes(lifecycle) || ['failed', 'stopped'].includes(String(state?.status || ''))) return { progress: 1, mode: 'error' };
    if (lifecycle === 'waiting_model' || needsHumanAttention(state) || state?.status === 'paused') return { progress: 1, mode: 'paused' };
    if (taskCanBeBlockedByRuntime(state)) return { progress: 2, mode: 'indeterminate' };
    return { progress: -1, mode: 'none' };
  }

  const api = { describe, labelFor, toneFor, needsHumanAttention, taskCanBeBlockedByRuntime, eventForState, taskbarState, thresholds: presentation.thresholds };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.assistantState = api;
})(globalThis);
