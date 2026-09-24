(function (root) {
  function plain(value, limit = 160) {
    if (typeof value !== 'string') return '';
    const text = value.replace(/\s+/g, ' ').trim();
    return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
  }

  function secondsSince(value, now) {
    const start = typeof value === 'number' ? value : Date.parse(String(value || ''));
    return Number.isFinite(start) ? Math.max(0, Math.floor((now - start) / 1000)) : null;
  }

  function duration(seconds) {
    if (seconds == null) return '';
    if (seconds < 60) return `${seconds} 秒`;
    const minutes = Math.floor(seconds / 60);
    return minutes < 60 ? `${minutes} 分 ${seconds % 60} 秒` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
  }

  function describe(task, operation, streamState, now = Date.now(), available = true) {
    const stream = String(streamState?.status || '');
    const lifecycle = String(task?.lifecycle_state || '');
    const status = String(task?.status || '');
    const current = plain(task?.current_step);
    const next = plain(task?.next_step);
    const objective = plain(task?.objective);
    const steps = Array.isArray(task?.steps) ? task.steps.filter((item) => item && typeof item === 'object') : [];
    const completedSteps = steps.filter((item) => item.status === 'completed' || item.state === 'completed').length;
    const stage = steps.length ? `阶段 ${completedSteps}/${steps.length}` : '';
    const failure = plain(task?.failure);
    const command = task?.current_command && typeof task.current_command === 'object' ? task.current_command : null;
    const runningCommand = command?.status === 'running';
    const operationRunning = ['running', 'queued'].includes(String(operation?.status || ''));
    const active = operationRunning || runningCommand || ['active', 'running', 'planning', 'preparing', 'verifying', 'recovering'].includes(status)
      || ['created', 'planning', 'ready', 'preparing', 'running', 'recovering', 'verifying'].includes(lifecycle);
    const elapsed = secondsSince(operationRunning ? operation?.started_at || operation?.queued_at : task?.created_at, now);
    const lastUpdate = secondsSince(task?.updated_at, now);
    const heartbeatAge = operationRunning && Number.isFinite(Number(operation?.heartbeat_age_seconds))
      ? Math.max(0, Number(operation.heartbeat_age_seconds)) : null;
    const age = heartbeatAge != null
      ? heartbeatAge >= 30 ? `后台任务心跳已 ${duration(Math.floor(heartbeatAge))}未更新` : '后台任务心跳正常'
      : lastUpdate != null && lastUpdate >= 30 ? `最近本地状态更新于 ${duration(lastUpdate)}前` : '';
    if (status === 'failed' || lifecycle === 'failed') {
      return { key: 'failed', message: `本地任务失败：${failure || current || '请查看任务详情'}`, detail: objective, elapsed: '' };
    }
    if (['waiting_user', 'waiting_approval', 'needs_user', 'paused'].includes(lifecycle) || status === 'paused') {
      return { key: 'waiting', message: `本地任务等待处理：${current || next || objective || '请查看任务详情'}`, detail: next && next !== current ? `下一步：${next}` : objective, elapsed: '' };
    }
    if (active) {
      const kind = { test: '正在运行测试', build: '正在构建', command: '正在执行命令' }[command?.kind] || '正在执行本地任务';
      const message = current || (runningCommand ? kind : operationRunning ? '后台任务正在执行' : objective || kind);
      const details = [stage, runningCommand && current ? kind : '', next && next !== current ? `下一步：${next}` : '', age].filter(Boolean);
      return { key: 'active', message, detail: details.join(' · ') || objective || '本地任务正在运行', elapsed: duration(elapsed) };
    }
    if (lifecycle === 'waiting_model' || (status === 'waiting' && lifecycle !== 'waiting_user')) {
      return { key: 'waiting', message: '本地步骤已交回 ChatGPT，等待下一步调用', detail: current || next || objective || '本地任务状态已保存', elapsed: '' };
    }
    if (stream === 'interrupted' || stream === 'render_error') {
      if (String(streamState?.event || '') === 'page-stream-recovery-timeout') {
        return {
          key: 'waiting',
          message: 'ChatGPT 网页回复恢复超时，本地任务状态仍已保存',
          detail: '本地任务状态未丢失；可以点击网页“重试”，或继续发送消息；不要重复执行已经完成的本地步骤',
          elapsed: ''
        };
      }
      return { key: 'failed', message: stream === 'interrupted' ? 'ChatGPT 回答连接已中断' : 'ChatGPT 消息显示异常', detail: '本地任务状态可独立查看；请检查网页连接', elapsed: '' };
    }
    if (stream === 'generating') {
      return { key: 'generating', message: 'ChatGPT 正在生成回复', detail: '尚无正在执行的本地任务；模型内部规划无法由本地工具读取', elapsed: duration(secondsSince(streamState?.updatedAt, now)) };
    }
    if (status === 'completed' || lifecycle === 'completed') {
      return { key: 'completed', message: `本地任务已完成：${current || objective || '执行结束'}`, detail: next || objective, elapsed: '' };
    }
    if (status === 'stopped' || lifecycle === 'cancelled') {
      return { key: 'stopped', message: '本地任务已停止', detail: current || objective, elapsed: '' };
    }
    if (!available) return { key: 'waiting', message: '暂时无法读取本地任务进度', detail: '正在等待本地工具连接恢复', elapsed: '' };
    return { key: 'idle', message: '当前没有运行中的本地任务', detail: 'ChatGPT 的模型规划不会显示在本地任务记录中', elapsed: '' };
  }

  const api = { describe };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.progressPresentation = api;
})(globalThis);
