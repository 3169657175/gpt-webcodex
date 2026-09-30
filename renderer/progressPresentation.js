(function (root) {
  const LOCAL_OUTPUT_QUIET_SECONDS = 20;
  const LOCAL_HEARTBEAT_WARN_SECONDS = 45;
  const LOCAL_HEARTBEAT_STALL_SECONDS = 90;
  const CHAT_QUIET_STALL_SECONDS = 45;
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

  function latestOutput(value) {
    if (typeof value !== 'string') return '';
    const lines = value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
    return plain(lines.at(-1) || '', 120);
  }

  function describe(task, operation, streamState, now = Date.now(), available = true, activity = null, stale = false) {
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
    const activityCommand = activity?.command && typeof activity.command === 'object' ? activity.command : null;
    const command = activityCommand || (task?.current_command && typeof task.current_command === 'object' ? task.current_command : null);
    const runningCommand = command?.status === 'running';
    const operationRunning = ['running', 'queued'].includes(String(operation?.status || ''));
    const operationCountsAsLocalWork = operationRunning && lifecycle !== 'waiting_model';
    const active = operationCountsAsLocalWork || runningCommand || ['active', 'running', 'planning', 'preparing', 'verifying', 'recovering'].includes(status)
      || ['created', 'planning', 'ready', 'preparing', 'running', 'recovering', 'verifying'].includes(lifecycle);
    const elapsed = secondsSince(operationRunning ? operation?.started_at || operation?.queued_at : runningCommand ? command?.started_at || task?.created_at : task?.created_at, now);
    const lastUpdate = secondsSince(command?.last_output_at || activity?.captured_at || task?.updated_at, now);
    const heartbeatAge = operationRunning && Number.isFinite(Number(operation?.heartbeat_age_seconds))
      ? Math.max(0, Number(operation.heartbeat_age_seconds)) : null;
    const age = heartbeatAge != null
      ? heartbeatAge >= LOCAL_HEARTBEAT_WARN_SECONDS ? `后台任务心跳已 ${duration(Math.floor(heartbeatAge))}未更新` : `后台任务心跳正常（${Math.floor(heartbeatAge)} 秒前）`
      : lastUpdate != null && lastUpdate >= LOCAL_OUTPUT_QUIET_SECONDS ? `最近本地状态更新于 ${duration(lastUpdate)}前` : '';
    if (status === 'failed' || lifecycle === 'failed') {
      return { key: 'failed', message: `本地任务失败：${failure || current || '请查看任务详情'}`, detail: objective, elapsed: '' };
    }
    if (['waiting_user', 'waiting_approval', 'needs_user', 'paused'].includes(lifecycle) || status === 'paused') {
      return { key: 'waiting', message: `本地任务等待处理：${current || next || objective || '请查看任务详情'}`, detail: next && next !== current ? `下一步：${next}` : objective, elapsed: '' };
    }
    if (lifecycle === 'waiting_model' || (status === 'waiting' && lifecycle !== 'waiting_user')) {
      if (stream === 'interrupted' || stream === 'render_error') {
        if (String(streamState?.event || '') === 'page-stream-recovery-timeout') {
          return { key: 'waiting', userState: 'waiting_model', message: 'ChatGPT 网页回复恢复超时，本地步骤已经完成并保存', detail: '可以刷新页面或继续发送消息；不要重复执行已经完成的本地步骤', elapsed: '', action: 'reload-page', actionLabel: '刷新页面', canStop: false };
        }
        return { key: 'failed', userState: 'failed', message: stream === 'interrupted' ? 'ChatGPT 回答连接已中断' : 'ChatGPT 消息显示异常', detail: '本地步骤已经保存；请检查网页连接', elapsed: '', action: 'reload-page', actionLabel: '刷新页面', canStop: false };
      }
      return { key: 'waiting', userState: 'waiting_model', message: '本地步骤已完成，正在等待 ChatGPT 继续', detail: current || next || objective || '当前没有正在运行的本地命令', elapsed: '', canStop: false };
    }
    if (active) {
      const kind = { test: '正在运行测试', build: '正在构建', command: '正在执行命令' }[command?.kind] || '正在执行本地任务';
      const message = current || (runningCommand ? kind : operationRunning ? '后台任务正在执行' : objective || kind);
      const output = latestOutput(command?.latest_output);
      const pageWarning = ['interrupted', 'render_error', 'asset_error'].includes(stream) ? 'ChatGPT 页面连接异常，本地执行仍在继续' : '';
      const outputAge = secondsSince(command?.last_output_at, now);
      const quiet = runningCommand && outputAge != null && outputAge >= LOCAL_OUTPUT_QUIET_SECONDS && (heartbeatAge == null || heartbeatAge < LOCAL_HEARTBEAT_WARN_SECONDS);
      const details = [stage, runningCommand && current ? kind : '', output ? `最新输出：${output}` : '', next && next !== current ? `下一步：${next}` : '', pageWarning, age, quiet ? `最近输出 ${duration(outputAge)}前 · 进程与心跳正常` : ''].filter(Boolean);
      if (!available) {
        return { key: 'waiting', userState: 'waiting', message: `本地任务状态暂不可确认：${message}`, detail: [stale ? '显示最后一次成功读取的状态' : '', ...details].filter(Boolean).join(' · '), elapsed: duration(elapsed), canStop: false };
      }
      if (heartbeatAge != null && heartbeatAge >= LOCAL_HEARTBEAT_STALL_SECONDS) {
        return { key: 'stalled', userState: 'stalled', message: `${message}，后台心跳长时间未更新`, detail: details.join(' · '), elapsed: duration(elapsed), canStop: true, diagnostic: '后台心跳超过 90 秒未更新，任务疑似卡住。' };
      }
      if (heartbeatAge != null && heartbeatAge >= LOCAL_HEARTBEAT_WARN_SECONDS) {
        return { key: 'warning', userState: 'suspected_stall', message: `${message}，较长时间没有活动`, detail: details.join(' · '), elapsed: duration(elapsed), canStop: true, diagnostic: '后台心跳超过 45 秒未更新，正在观察；尚未达到确认卡死阈值。' };
      }
      if (quiet) {
        return { key: 'active', userState: 'quiet', message: `${message}，暂时没有新输出`, detail: details.join(' · '), elapsed: duration(elapsed), canStop: true, diagnostic: '没有新 stdout 不代表卡死；进程和心跳仍然正常。' };
      }
      return { key: 'active', userState: command?.kind === 'test' ? 'testing' : command?.kind === 'build' ? 'building' : lifecycle === 'planning' ? 'planning' : lifecycle === 'recovering' ? 'recovering' : 'local_running', message, detail: details.join(' · ') || objective || '本地任务正在运行', elapsed: duration(elapsed), canStop: true, diagnostic: '本地任务状态健康。' };
    }
    if (stream === 'asset_error') {
      return { key: 'failed', message: 'ChatGPT 页面资源加载失败', detail: streamState?.detail || '请点击“刷新页面”重新加载；本地任务状态不会因此丢失', elapsed: '', action: 'reload-page', actionLabel: '刷新页面' };
    }
    if (stream === 'interrupted' || stream === 'render_error') {
      if (String(streamState?.event || '') === 'page-stream-recovery-timeout') {
        return {
          key: 'waiting',
          message: 'ChatGPT 网页回复恢复超时，本地任务状态仍已保存',
          detail: '本地任务状态未丢失；可以点击网页“重试”，或继续发送消息；不要重复执行已经完成的本地步骤',
          elapsed: '', action: 'reload-page', actionLabel: '刷新页面'
        };
      }
      return { key: 'failed', message: stream === 'interrupted' ? 'ChatGPT 回答连接已中断' : 'ChatGPT 消息显示异常', detail: '本地任务状态可独立查看；请检查网页连接', elapsed: '', action: 'reload-page', actionLabel: '刷新页面' };
    }
    if (!available) {
      const lastKnown = current || objective;
      return { key: 'waiting', message: '暂时无法确认本地任务状态', detail: lastKnown ? `已保留最后状态：${lastKnown}` : '正在等待本地工具连接恢复，不会显示为“空闲”', elapsed: '' };
    }
    if (stream === 'generating') {
      const quietSeconds = Number(streamState?.quietSeconds || streamState?.quiet_seconds || 0);
      if (streamState?.stalled || quietSeconds >= CHAT_QUIET_STALL_SECONDS) {
        return { key: 'stalled', message: `ChatGPT 仍在生成，但页面已 ${duration(Math.floor(quietSeconds))} 没有新内容`, detail: '这不等于本地 MCP 失败；可以停止本轮生成，或刷新页面重试', elapsed: duration(secondsSince(streamState?.updatedAt, now)), action: 'stop-generation', actionLabel: '停止生成' };
      }
      return { key: 'generating', message: 'ChatGPT 正在生成回复', detail: '本地尚未收到工具调用；网页端只公开回复生成状态，收到调用后会显示命令与输出', elapsed: duration(secondsSince(streamState?.updatedAt, now)) };
    }
    if (status === 'completed' || lifecycle === 'completed') {
      return { key: 'completed', message: `本地任务已完成：${current || objective || '执行结束'}`, detail: next || objective, elapsed: '' };
    }
    if (status === 'stopped' || lifecycle === 'cancelled') {
      return { key: 'stopped', message: '本地任务已停止', detail: current || objective, elapsed: '' };
    }
    return { key: 'idle', message: '当前没有运行中的本地任务', detail: 'ChatGPT 的模型规划不会显示在本地任务记录中', elapsed: '' };
  }

  const api = {
    describe,
    thresholds: { localOutputQuietSeconds: LOCAL_OUTPUT_QUIET_SECONDS, localHeartbeatWarnSeconds: LOCAL_HEARTBEAT_WARN_SECONDS, localHeartbeatStallSeconds: LOCAL_HEARTBEAT_STALL_SECONDS, chatQuietStallSeconds: CHAT_QUIET_STALL_SECONDS }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.progressPresentation = api;
})(globalThis);
