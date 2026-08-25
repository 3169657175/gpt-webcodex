const api = window.mcpAssistant || createPreviewApi();

function createPreviewApi() {
  const previewSettings = {
    connectionMode: 'official', bridgeRemovedNotice: false, workspace: 'C:\\Users\\示例用户\\Desktop\\my-project', permissionMode: 'safe', toolMode: 'smart',
    mcpPort: 18765, healthPort: 18081, proxyMode: 'auto', proxyUrl: '', tunnelId: 'tunnel_demo',
    theme: 'light', startWithWindows: false, progressReportSeconds: 90, keepRunningOnClose: true, autoStartServices: false, taskNotifications: true, taskNotificationOnlyWhenUnfocused: false, taskNotificationSound: true, taskNotificationMinSeconds: 0, firstRunCompleted: true, guideProgress: {}, authorizedRoots: []
  };
  const snapshot = {
    settings: previewSettings,
    secrets: { runtimeApiKey: true, mcpAuthToken: true },
    environment: {
      python: { installed: true, version: 'Python 3.12.10' },
      proxy: { mode: 'auto', configured: false, reachable: true, source: 'auto-direct', url: '' }, tunnelClient: { installed: true },
      workspace: { configured: true, exists: true }, ports: { mcpListening: true, tunnelListening: true }
    },
    status: { busy: false, runtimeRunning: true, tunnelRunning: true, connectionRunning: true, connectionMode: 'official', fullyReady: true, localMcpUrl: 'http://127.0.0.1:18765/mcp', tunnelUiUrl: 'http://127.0.0.1:18081/ui' }
  };
  const ok = (data) => Promise.resolve({ ok: true, data });
  return {
    snapshot: () => ok(snapshot), chooseWorkspace: () => ok(snapshot.settings.workspace), switchWorkspace: (workspace) => { snapshot.settings.workspace=workspace; return ok(snapshot); }, updateAuthorizedRoots: (roots) => { snapshot.settings.authorizedRoots=roots; return ok(snapshot); }, closeManager: () => ok(true),
    saveSettings: (patch) => { Object.assign(snapshot.settings, patch); return ok(snapshot.settings); },
    saveRuntimeKey: () => ok(snapshot.secrets), removeRuntimeKey: () => ok(snapshot.secrets), regenerateMcpToken: () => ok(snapshot.secrets),
    start: () => ok(snapshot), stop: () => ok(snapshot), restart: () => ok(snapshot),
    logs: () => ok([{ time: new Date().toISOString(), level: 'info', message: '静态界面预览模式' }]), clearLogs: () => ok(true),
    taskState: () => ok({ exists: false, state: null }), taskRuntime: () => ok({ state: { status: 'completed', run_id: 'run_demo_1234', objective: '示例后台任务' }, active_worktree: { run_id: 'run_demo_1234', objective: '示例后台任务', branch: 'coding-tools/run-demo', path: 'C:\\demo\\.coding-tools\\worktrees\\demo', exists: true, clean: false, snapshot_dirty: true, snapshot_changed_count: 3, created_at: new Date().toISOString() }, operations: [] }), taskWorktrees: () => ok({ worktrees: [{ run_id: 'run_demo_1234', objective: '示例后台任务', branch: 'coding-tools/run-demo', path: 'C:\\demo\\.coding-tools\\worktrees\\demo', exists: true, clean: false, snapshot_dirty: true, snapshot_changed_count: 3, snapshot_untracked_count: 1, created_at: new Date().toISOString(), status: 'active' }] }), taskWorktreeDiff: () => ok({ worktree_diff: { run_id: 'run_demo_1234', changed_count: 2, diff: 'diff --git a/app.js b/app.js\n+示例隔离修改\n' } }), applyTaskWorktree: () => ok({ apply_result: { applied: true, changed_count: 2, primary_index_untouched: true }, worktree: { status: 'applied' } }), discardTaskWorktree: () => ok({ worktree: { discarded: true } }), testTaskNotification: () => ok(true), clearTaskState: () => ok(true), pauseTask: () => ok({}), resumeTask: () => ok({}), stopTask: () => ok({}), taskHistory: () => ok([]), performanceTrace: () => ok(null), clearPerformanceTrace: () => ok(true),
    workspaceContext: () => ok({ project: { type: 'electron', name: 'demo', version: '0.2.4', entrypoint: 'electron/main.js' }, project_instructions: { root_files: [{ path: 'AGENTS.md', truncated: false }], nested_files: [], nested_count: 0, warnings: [] }, core_entries: ['electron/main.js', 'package.json'], context_pressure: { level: 'normal', tool_calls: 8, files_read: 5, response_megabytes: 0.4, recommend_new_chat: false } }),
    codingToolsGuide: () => ok({ custom_instructions: '当请求涉及本地代码工作区时，请优先使用 Coding Tools MCP；快速了解项目使用 workspace_context，修改、测试和构建优先使用 agent_workflow。' }),
    inspectBuild: () => ok({ type: 'electron', name: 'demo', version: '0.1.0', testCommand: 'npm test', buildCommand: 'npm run dist', artifacts: ['dist'] }), runBuild: () => ok({ overallStatus: 'passed', project: { type: 'electron', name: 'demo', version: '0.1.0' }, testResult: { status: 'passed' }, buildResult: { status: 'passed' }, artifacts: [] }), inspectHealth: () => ok({ healthy: true, checks: [] }), repairHealth: () => ok({ healthy: true, checks: [], actions: [], unresolved: [] }),
    openExternal: () => ok(true), installPython: () => ok(true), detectProxy: () => ok(snapshot.environment.proxy), onProgress: () => () => {}, onLog: () => () => {}, onStatus: () => () => {}, onHeartbeat: () => () => {}, onBuildProgress: () => () => {}
  };
}

const pageMeta = {
  overview: ['主页', '运行总览', '集中查看本地工具、连接通道与当前工作区。'],
  deploy: ['连接配置', '运行与连接', '管理本地工具服务与 ChatGPT 连接通道。'],
  workspace: ['访问与权限', '工作区与权限', '管理主工作区、额外授权目录与命令权限。'],
  task: ['任务中心', '任务执行状态', '查看当前目标、执行步骤、测试、文件修改和后台任务。'],
  build: ['自动验证', '构建与验证', '自动识别项目并选择合适的测试与构建方式。'],
  health: ['系统诊断', '诊断与修复', '检查运行环境并修复助手能够安全处理的问题。'],
  guide: ['接入帮助', '接入指南', '查看 ChatGPT 官方 MCP 的接入步骤。'],
  logs: ['诊断记录', '运行日志', '查看本地工具与连接通道的运行记录。'],
  settings: ['偏好设置', '偏好设置', '只保留日常使用中真正需要调整的选项。']
};

const state = {
  snapshot: null,
  currentPage: 'overview',
  selectedWorkspace: '',
  logFilter: 'all',
  logs: [],
  busy: false,
  initializedForms: false
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function unwrap(result) {
  if (!result?.ok) throw new Error(result?.error || '操作失败');
  return result.data;
}

function toast(title, message = '', type = 'success') {
  const element = document.createElement('div');
  element.className = `toast ${type}`;
  const heading = document.createElement('b');
  heading.textContent = title;
  const detail = document.createElement('span');
  detail.textContent = message;
  element.append(heading, detail);
  $('#toastStack').appendChild(element);
  setTimeout(() => element.remove(), 4200);
}

function setBusy(value, overlay = false) {
  state.busy = value;
  $('#busyOverlay').classList.toggle('visible', value && overlay);
  ['#topStartButton', '#heroStartButton', '#deployNow', '#overviewRestart', '#overviewStop'].forEach((selector) => {
    const element = $(selector);
    if (element) element.disabled = value;
  });
}

function setDot(element, status) {
  if (!element) return;
  element.classList.remove('ready', 'warn', 'error');
  if (status) element.classList.add(status);
}

function navigate(page) {
  if (!pageMeta[page]) return;
  state.currentPage = page;
  if (location.hash !== `#${page}`) history.replaceState(null, '', `#${page}`);
  $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.page === page));
  $$('.page').forEach((item) => item.classList.toggle('active', item.dataset.pageView === page));
  const [eyebrow, title, subtitle] = pageMeta[page];
  $('#pageEyebrow').textContent = eyebrow;
  $('#pageTitle').textContent = title;
  $('#pageSubtitle').textContent = subtitle;
  $('.content-viewport').scrollTop = 0;
  if (page === 'logs') loadLogs();
  if (page === 'task') loadTaskState();
  if (page === 'build') inspectBuild();
  if (page === 'health') inspectHealth();
  if (page === 'workspace') loadWorkspaceContext();
  if (page === 'guide') loadCodingToolsGuide();
}

function textOr(value, fallback = '—') { return String(value ?? '').trim() || fallback; }

function statusLabel(value) {
  const key = String(value || '').trim().toLowerCase();
  return ({
    idle: '暂无任务', active: '执行中', running: '执行中', waiting: '等待中', waiting_model: '等待模型',
    needs_user: '等待你处理', paused: '已暂停', stopped: '已停止', cancelled: '已取消', interrupted: '已中断',
    completed: '已完成', passed: '通过', failed: '失败', unavailable: '不可用', skipped: '已跳过', blocked: '已阻止',
    pending: '等待中', in_progress: '进行中'
  })[key] || textOr(value, '未知');
}

function projectTypeLabel(value) {
  const key = String(value || '').toLowerCase();
  return ({
    electron: '桌面应用', node: 'Node.js 项目', python: 'Python 项目', rust: 'Rust 项目', go: 'Go 项目',
    maven: 'Java 项目', dotnet: '.NET 项目', unknown: '未知项目'
  })[key] || textOr(value, '未知项目');
}

function toolLabel(value) {
  const key = String(value || '');
  return ({
    coding_tools_guide: '工具指南', workspace_context: '工作区检查', agent_workflow: '自动工作流', task_control: '任务控制',
    document_workflow: '文档处理', exec_command: '命令执行', command_control: '命令管理', request_permissions: '权限请求', view_image: '查看图片'
  })[key] || key || '本地工具';
}

function humanizeTaskText(value) {
  const raw = String(value || '').trim();
  const key = raw.toLowerCase();
  return ({
    'waiting for model': '等待模型继续处理', 'waiting for user': '等待你处理', completed: '已完成',
    'verification failed': '验证失败', 'requested check failed': '检查失败', 'running requested checks': '正在执行检查',
    'run complete agent workflow': '正在执行完整任务', 'apply workspace changes': '正在修改项目',
    'run requested checks': '正在验证修改', 'finalize verified result': '正在整理结果'
  })[key] || raw;
}

function renderTaskList(container, items, render) {
  container.replaceChildren();
  if (!items?.length) {
    const empty = document.createElement('span'); empty.className = 'task-muted'; empty.textContent = '暂无记录'; container.appendChild(empty); return;
  }
  items.forEach((item) => container.appendChild(render(item)));
}

function renderTaskState(payload) {
  const task = payload?.state;
  const hasTask = Boolean(task && (
    textOr(task.objective, '') ||
    textOr(task.current_step, '') ||
    textOr(task.next_step, '') ||
    (Array.isArray(task.steps) && task.steps.length) ||
    (task.status && task.status !== 'idle')
  ));
  $('#taskStateEmpty').hidden = hasTask;
  $('#taskStateContent').hidden = !hasTask;
  if (!hasTask) return;
  $('#taskObjective').textContent = textOr(task.objective, '未填写当前目标');
  $('#taskId').textContent = textOr(task.task_id);
  $('#taskStatus').textContent = statusLabel(task.lifecycle_state || task.status);
  $('#taskCurrentStep').textContent = humanizeTaskText(task.current_step) || '—';
  $('#taskNextStep').textContent = humanizeTaskText(task.next_step) || '—';
  $('#taskFailureRow').hidden = !task.failure;
  $('#taskFailure').textContent = textOr(task.failure);
  const steps = Array.isArray(task.steps) ? task.steps : [];
  const done = steps.filter((item) => item.status === 'completed').length;
  $('#taskStepCount').textContent = `${done} / ${steps.length}`;
  renderTaskList($('#taskSteps'), steps, (item) => { const row=document.createElement('div'); row.className=`task-step ${item.status || 'pending'}`; const mark=document.createElement('i'); mark.textContent=item.status==='completed'?'✓':item.status==='in_progress'?'→':item.status==='failed'?'!':'•'; const label=document.createElement('span'); label.textContent=textOr(item.text); row.append(mark,label); return row; });
  const command = task.current_command;
  $('#taskCommand').textContent = command ? `${textOr(command.command)}\n${statusLabel(command.status)} · 工作目录 ${textOr(command.workdir, '.')}` : '当前没有运行中的命令';
  const tests = Array.isArray(task.test_results) ? task.test_results.slice(-5).reverse() : [];
  renderTaskList($('#taskTests'), tests, (item) => { const row=document.createElement('div'); row.className=`task-result ${item.status}`; row.textContent=`${item.status === 'passed' ? '通过' : '失败'} · ${textOr(item.command, '测试')} · ${item.duration_ms ?? 0} ms`; return row; });
  const files = Array.isArray(task.modified_files) ? task.modified_files.slice().reverse() : [];
  $('#taskFileCount').textContent = String(files.length);
  renderTaskList($('#taskFiles'), files, (item) => { const row=document.createElement('div'); row.className='task-file'; const op=document.createElement('b'); op.textContent=({add:'新增',create:'新增',update:'修改',delete:'删除',remove:'删除',move:'移动'})[String(item.operation || '').toLowerCase()] || '修改'; const file=document.createElement('span'); file.textContent=textOr(item.path); row.append(op,file); return row; });
  const report = task.last_build_report;
  const build = $('#taskBuild'); build.replaceChildren();
  if (!report) { build.textContent='尚未执行构建验证。'; }
  else {
    const summary=document.createElement('div'); summary.className=`build-summary ${report.overall_status}`; summary.textContent=`${report.overall_status === 'passed' ? '验证通过' : '验证失败'} · ${projectTypeLabel(report.project?.type)} · v${textOr(report.project?.version)}`; build.appendChild(summary);
    (report.artifacts || []).slice(0,8).forEach((item) => { const row=document.createElement('div'); row.className='task-artifact'; const path=document.createElement('span'); path.textContent=textOr(item.path); const hash=document.createElement('code'); hash.textContent=textOr(item.sha256 || item.sha384 || item.sha512).slice(0,16); row.append(path,hash); build.appendChild(row); });
    if (!(report.artifacts || []).length) { const empty=document.createElement('span'); empty.className='task-muted'; empty.textContent=textOr(report.failure, '没有找到构建产物'); build.appendChild(empty); }
  }
}

function renderTaskOperations(runtime) {
  const container = $('#taskOperations');
  if (!container) return;
  const operations = Array.isArray(runtime?.operations) ? runtime.operations.slice().reverse() : [];
  renderTaskList(container, operations, (operation) => {
    const row = document.createElement('div');
    row.className = `task-history-item task-operation ${operation.status || 'unknown'}`;
    const copy = document.createElement('div');
    const title = document.createElement('b');
    const labels = { running: '后台运行中', completed: '已完成', failed: '失败', interrupted: '已中断，可恢复' };
    title.textContent = `${toolLabel(operation.tool)} · ${labels[operation.status] || statusLabel(operation.status)}`;
    const meta = document.createElement('small');
    const cadence = Number(operation.progress_report_seconds || 0);
    const heartbeatAge = Number(operation.heartbeat_age_seconds ?? 0);
    const heartbeat = operation.status === 'running' ? (heartbeatAge >= 15 ? ` · 心跳异常 ${heartbeatAge}秒` : ' · 心跳正常') : '';
    meta.textContent = `已运行 ${formatDuration(Number(operation.elapsed_seconds || 0) * 1000)}${heartbeat}${cadence ? ` · 汇报间隔 ${cadence} 秒` : ''}`;
    copy.append(title, meta);
    row.append(copy);
    return row;
  });
}

function shortRunId(value) {
  const text = String(value || '');
  return text.length > 10 ? `${text.slice(0, 8)}…` : text || '—';
}

function renderTaskIsolation(runtime, worktreePayload = null) {
  const currentRunId = String(runtime?.state?.run_id || '');
  const current = runtime?.active_worktree && runtime.active_worktree.exists !== false ? runtime.active_worktree : null;
  const badge = $('#taskIsolationBadge');
  if (badge) {
    badge.hidden = !current;
    badge.title = current ? `隔离分支：${textOr(current.branch)}\n${textOr(current.path)}` : '';
  }
  const container = $('#taskWorktrees');
  if (!container) return;
  container.replaceChildren();
  const worktrees = Array.isArray(worktreePayload?.worktrees) ? worktreePayload.worktrees : (current ? [current] : []);
  if (!worktrees.length) {
    const empty = document.createElement('span');
    empty.className = 'task-muted';
    empty.textContent = '当前没有隔离任务；支持的代码任务会自动在安全隔离区中执行。';
    container.append(empty);
    return;
  }
  worktrees.slice().reverse().forEach((item) => {
    const row = document.createElement('article');
    row.className = `task-worktree-item${String(item.run_id || '') === currentRunId ? ' current' : ''}`;
    const head = document.createElement('div'); head.className = 'task-worktree-head';
    const copy = document.createElement('div');
    const title = document.createElement('b'); title.textContent = textOr(item.objective, '隔离代码任务');
    const meta = document.createElement('small');
    const snapshot = item.snapshot_dirty ? `基于未提交工作区快照 · ${Number(item.snapshot_changed_count || 0)} 项` : '基于已提交代码';
    meta.textContent = `${shortRunId(item.run_id)} · ${textOr(item.branch, '隔离分支')} · ${snapshot}`;
    copy.append(title, meta);
    const itemState = document.createElement('span');
    const alreadyApplied = String(item.status || '') === 'applied';
    itemState.className = `status-pill ${item.exists !== false && (item.clean || alreadyApplied) ? 'positive' : ''}`;
    itemState.textContent = item.exists === false ? '目录已丢失' : alreadyApplied ? '已应用到主工作区' : item.clean ? '暂无助手改动' : '有助手改动';
    head.append(copy, itemState);
    const details = document.createElement('div'); details.className = 'task-worktree-meta';
    const created = item.created_at ? new Date(item.created_at).toLocaleString('zh-CN') : '—';
    details.textContent = `创建：${created} · 快照新增文件 ${Number(item.snapshot_untracked_count || 0)} 个`;
    const actions = document.createElement('div'); actions.className = 'inline-actions task-worktree-actions';
    const diffButton = document.createElement('button'); diffButton.className = 'secondary-button'; diffButton.textContent = '查看差异';
    const applyButton = document.createElement('button'); applyButton.className = 'primary-button'; applyButton.textContent = alreadyApplied ? '已应用' : item.clean ? '暂无修改' : '应用到主工作区';
    applyButton.disabled = alreadyApplied || Boolean(item.clean) || item.exists === false;
    const discardButton = document.createElement('button'); discardButton.className = 'danger-button'; discardButton.textContent = '放弃隔离任务';
    const diffDetails = document.createElement('details'); diffDetails.className = 'task-worktree-diff';
    const diffSummary = document.createElement('summary'); diffSummary.textContent = '助手修改差异';
    const pre = document.createElement('pre'); pre.textContent = '点击“查看差异”后加载。';
    diffDetails.append(diffSummary, pre);
    diffButton.addEventListener('click', async () => {
      try {
        diffButton.disabled = true; diffButton.textContent = '读取中…';
        const result = unwrap(await api.taskWorktreeDiff(item.run_id));
        const diff = result?.worktree_diff || result || {};
        pre.textContent = diff.diff || '当前没有助手修改。';
        diffSummary.textContent = `助手修改差异 · ${Number(diff.changed_count || 0)} 项`;
        diffDetails.open = true;
      } catch (error) { toast('无法读取隔离差异', error.message, 'error'); }
      finally { diffButton.disabled = false; diffButton.textContent = '查看差异'; }
    });
    applyButton.addEventListener('click', async () => {
      const confirmed = window.confirm('只会把这个隔离任务产生的助手修改应用到主工作区；不会改变 Git 暂存区。若同一文件在任务快照之后被你修改，系统会在写入前拒绝，不会覆盖你的修改。是否继续？');
      if (!confirmed) return;
      try {
        applyButton.disabled = true; applyButton.textContent = '安全检查中…';
        const result = unwrap(await api.applyTaskWorktree(item.run_id));
        const applied = result?.apply_result || result || {};
        toast('已应用到主工作区', `${Number(applied.changed_count || 0)} 个文件已更新；Git 暂存区保持不变。隔离区仍保留，可继续查看或放弃。`);
        await loadTaskState();
      } catch (error) {
        const message = String(error?.message || '');
        if (/WORKTREE_APPLY_CONFLICT|Primary workspace changed/i.test(message)) {
          toast('检测到主工作区冲突', '主工作区存在同文件的新修改，系统已拒绝写入，没有覆盖你的内容。', 'error');
        } else if (/WORKTREE_NOT_READY|Only a completed isolated task/i.test(message)) {
          toast('任务尚未完成', '任务尚未完成，不能应用到主工作区。', 'error');
        } else if (/WORKTREE_BUSY|still running/i.test(message)) {
          toast('任务仍在运行', '任务仍在后台运行，请等待完成后再应用。', 'error');
        } else {
          toast('无法应用到主工作区', message || '安全应用失败。', 'error');
        }
      } finally {
        if (document.body.contains(applyButton) && !alreadyApplied) {
          applyButton.disabled = Boolean(item.clean);
          applyButton.textContent = item.clean ? '暂无修改' : '应用到主工作区';
        }
      }
    });
    discardButton.addEventListener('click', async () => {
      if (!window.confirm('确定放弃这个隔离任务吗？隔离区中的助手修改会被永久删除，但主工作区不会被改动。')) return;
      try {
        discardButton.disabled = true;
        unwrap(await api.discardTaskWorktree(item.run_id));
        toast('隔离任务已放弃', '主工作区没有被修改。');
        await loadTaskState();
      } catch (error) { toast('无法放弃隔离任务', error.message, 'error'); }
      finally { discardButton.disabled = false; }
    });
    actions.append(diffButton, applyButton, discardButton);
    row.append(head, details, actions, diffDetails);
    container.append(row);
  });
}

async function loadTaskState() {
  try {
    const [taskPayload] = await Promise.all([api.taskState(), loadTaskHistory(), loadPerformanceTrace()]);
    let runtime = null;
    if (api.taskRuntime) {
      try { runtime = unwrap(await api.taskRuntime({ detail: 'full' })); } catch { runtime = null; }
    }
    let worktreePayload = null;
    if (api.taskWorktrees) {
      try { worktreePayload = unwrap(await api.taskWorktrees()); } catch { worktreePayload = null; }
    }
    renderTaskState(runtime?.state ? { state: runtime.state } : unwrap(taskPayload));
    renderTaskOperations(runtime);
    renderTaskIsolation(runtime, worktreePayload);
  }
  catch (error) { toast('任务状态读取失败', error.message, 'error'); }
}

function formatDuration(ms) {
  const value = Number(ms || 0);
  if (value < 1000) return `${value} ms`;
  if (value < 60000) return `${(value / 1000).toFixed(1)} 秒`;
  return `${Math.floor(value / 60000)} 分 ${Math.round((value % 60000) / 1000)} 秒`;
}

function renderPerformanceTrace(trace) {
  const metrics = $('#performanceMetrics');
  const timeline = $('#performanceTimeline');
  metrics.replaceChildren(); timeline.replaceChildren();
  if (!trace || !trace.tool_calls) {
    const empty = document.createElement('span'); empty.className = 'task-muted'; empty.textContent = '暂无性能记录'; metrics.append(empty); return;
  }
  const items = [
    ['工具调用', trace.tool_calls], ['本机执行', formatDuration(trace.local_execution_ms)],
    ['估算等待', formatDuration(trace.estimated_wait_ms)], ['缓存命中', trace.cache_hits || 0],
    ['读取文件', trace.files_read || 0], ['MCP 输出', `${(Number(trace.response_bytes || 0) / (1024 * 1024)).toFixed(1)} MB`],
    ['重复拦截', trace.deduplicated_calls || 0], ['失败', trace.errors || 0]
  ];
  items.forEach(([label, value]) => { const card=document.createElement('div'); card.className='performance-metric'; const b=document.createElement('b'); b.textContent=String(value); const span=document.createElement('span'); span.textContent=label; card.append(b,span); metrics.append(card); });
  (trace.recent || []).slice(-30).reverse().forEach((event) => {
    const row=document.createElement('div'); row.className='performance-event';
    const tool=document.createElement('b'); tool.textContent=toolLabel(event.tool);
    const local=document.createElement('span'); local.textContent=`本机 ${formatDuration(event.duration_ms)}`;
    const wait=document.createElement('span'); wait.textContent=`等待 ${formatDuration(event.wait_before_ms)}`;
    const flag=document.createElement('span'); flag.textContent=event.deduplicated ? '已去重' : event.cache_hit ? '缓存' : event.ok ? '完成' : '失败'; if (event.cache_hit || event.deduplicated) flag.className='cache-hit';
    row.append(tool,local,wait,flag); timeline.append(row);
  });
}

async function loadPerformanceTrace() {
  try { renderPerformanceTrace(unwrap(await api.performanceTrace())); }
  catch (error) { renderPerformanceTrace(null); }
}

async function loadTaskHistory() {
  const container = $('#taskHistory');
  try {
    const items = unwrap(await api.taskHistory());
    renderTaskList(container, items, (task) => {
      const row = document.createElement('div'); row.className = 'task-history-item';
      const copy = document.createElement('div');
      const title = document.createElement('b'); title.textContent = textOr(task.objective, '未命名任务');
      const meta = document.createElement('small'); meta.textContent = `${textOr(task.status, 'unknown')} · ${textOr(task.task_id)} · ${new Date(task.archived_at || task.updated_at || Date.now()).toLocaleString('zh-CN')}`;
      copy.append(title, meta); row.append(copy); return row;
    });
  } catch (error) { container.textContent = `读取失败：${error.message}`; }
}

function applyTheme(theme) {
  document.body.dataset.theme = theme === 'light' ? 'light' : 'dark';
  $('#themeSelect').value = theme === 'light' ? 'light' : 'dark';
}

function renderMigrationNotice(settings) {
  const notice = $('#bridgeRemovedNotice');
  if (notice) notice.hidden = !settings?.bridgeRemovedNotice;
}

function applyFormValues(snapshot, force = false) {
  if (state.initializedForms && !force) return;
  const settings = snapshot.settings;
  state.selectedWorkspace = settings.workspace;
  $('#tunnelIdInput').value = settings.tunnelId || '';
  $('#proxyModeSelect').value = settings.proxyMode || 'auto';
  $('#proxyUrlInput').value = settings.proxyUrl || '';
  $('#mcpPortInput').value = settings.mcpPort;
  $('#healthPortInput').value = settings.healthPort;
  $('#startWithWindowsToggle').checked = Boolean(settings.startWithWindows);
  $('#keepRunningToggle').checked = settings.keepRunningOnClose;
  $('#autoStartToggle').checked = settings.autoStartServices;
  $('#progressReportSelect').value = String(settings.progressReportSeconds || 90);
  $('#taskNotificationsToggle').checked = settings.taskNotifications !== false;
  $('#taskNotificationSoundToggle').checked = settings.taskNotificationSound !== false;
  if ($('#toolModeSelect')) $('#toolModeSelect').value = 'smart';
  $$('input[name="permission"]').forEach((input) => {
    input.checked = input.value === settings.permissionMode;
    input.closest('.choice').classList.toggle('selected', input.checked);
  });
  applyTheme(settings.theme);
  restoreGuideProgress(settings.guideProgress || {});
  renderProxyControls();
  state.initializedForms = true;
}

function renderSnapshot(snapshot, options = {}) {
  state.snapshot = snapshot;
  applyFormValues(snapshot, options.forceForms);
  const { settings, secrets, environment, status } = snapshot;
  state.selectedWorkspace = settings.workspace;
  renderMigrationNotice(settings);
  const ready = status.fullyReady;
  const connectionRunning = status.tunnelRunning;
  const connectionLabel = '连接通道';

  $('#sideRuntimeText').textContent = ready ? '服务已就绪' : status.runtimeRunning ? `等待 ${connectionLabel}` : '服务未运行';
  setDot($('#sideRuntimeDot'), ready ? 'ready' : status.runtimeRunning ? 'warn' : 'error');
  $('#sideWorkspace').textContent = settings.workspace || '尚未选择工作目录';
  $('#sideMcp').textContent = status.runtimeRunning ? '正常' : '停止';
  $('#sideTunnel').textContent = connectionRunning ? '已连' : '断开';

  $('#runtimeStatus').textContent = environment.python.installed ? '环境正常' : '运行时缺失';
  $('#runtimeMeta').textContent = environment.python.version || '未找到内置 Python';
  setDot($('#runtimeDot'), environment.python.installed ? 'ready' : 'error');

  $('#mcpStatus').textContent = status.runtimeRunning ? '正常运行' : '未启动';
  $('#mcpMeta').textContent = status.localMcpUrl;
  setDot($('#mcpDot'), status.runtimeRunning ? 'ready' : 'error');
  $('#tunnelStatus').textContent = connectionRunning
    ? '已连接'
    : '未连接';
  $('#tunnelMeta').textContent = settings.tunnelId || '尚未填写连接通道 ID（Tunnel ID）';
  setDot($('#tunnelDot'), connectionRunning ? 'ready' : 'warn');
  $('#workspaceStatus').textContent = environment.workspace.exists ? '已授权' : '未选择';
  $('#workspaceMeta').textContent = settings.workspace || '仅所选目录可被 MCP 访问';
  setDot($('#workspaceDot'), environment.workspace.exists ? 'ready' : 'error');
  $('#selectedWorkspace').textContent = settings.workspace || '尚未选择目录';
  renderAuthorizedRoots(settings.authorizedRoots || []);

  $('#heroBadge').textContent = ready ? '全部服务运行正常' : '尚未完成部署';
  $('#heroTitle').textContent = ready ? '网页编程工作区已经准备好' : '让网页聊天安全访问你的代码目录';
  $('#heroText').textContent = ready
    ? '当前通过本地工具协议（MCP）与 OpenAI 连接通道（Tunnel）运行，网页只可访问所选工作目录。'
    : '选择一个工作目录并配置连接通道，然后由助手完成本地工具的启动、鉴权、健康检查和故障诊断。';
  $('#heroStartButton').textContent = ready ? '重新部署' : '开始部署';
  $('#topStartButton').textContent = ready ? '重新部署' : '一键启动';

  $('#runtimeKeyHint').textContent = secrets.runtimeApiKey ? '已使用 Windows 安全存储保存' : '尚未保存';
  $('#runtimeKeyHint').style.color = secrets.runtimeApiKey ? 'var(--green)' : '';
  $('#settingsKeyState').textContent = secrets.runtimeApiKey ? '已加密保存' : '尚未保存';
  $('#guideLocalUrl').textContent = status.localMcpUrl;
  $('#guideTunnelId').textContent = settings.tunnelId || '尚未填写';
  renderEnvironment(environment);
  renderDeploySummary();
}

function renderAuthorizedRoots(roots) {
  const container = $('#authorizedRootsList');
  if (!container) return;
  container.replaceChildren();
  if (!roots.length) {
    const empty = document.createElement('span');
    empty.className = 'task-muted';
    empty.textContent = '尚未添加额外授权目录';
    container.appendChild(empty);
    return;
  }
  roots.forEach((root) => {
    const row = document.createElement('div');
    row.className = 'authorized-root-row';
    const code = document.createElement('code');
    code.textContent = root;
    code.title = root;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'danger-button';
    remove.textContent = '移除';
    remove.addEventListener('click', () => removeAuthorizedRoot(root));
    row.append(code, remove);
    container.appendChild(row);
  });
}

function renderWorkspaceContext(context, guide = null) {
  const instructions = context?.project_instructions || {};
  const guideRoots = Array.isArray(guide?.project_instructions?.root_files) ? guide.project_instructions.root_files : [];
  const instructionContents = new Map(guideRoots.filter((item) => item?.path).map((item) => [String(item.path).toLowerCase(), String(item.content || '')]));
  const rootFiles = Array.isArray(instructions.root_files) ? instructions.root_files : [];
  const nestedFiles = Array.isArray(instructions.nested_files) ? instructions.nested_files : [];
  const instructionCount = rootFiles.length + nestedFiles.length;
  $('#projectInstructionsStatus').textContent = instructionCount
    ? `已检测 ${instructionCount} 个指令文件${nestedFiles.length ? `（含 ${nestedFiles.length} 个嵌套规则）` : ''}`
    : '未检测到 AGENTS.md / CLAUDE.md';
  setDot($('#projectInstructionsDot'), instructionCount ? 'ready' : 'warn');

  const project = context?.project || {};
  const coreEntries = Array.isArray(context?.core_entries) ? context.core_entries : [];
  const entryText = project.entrypoint || coreEntries.slice(0, 4).join('、') || `${project.type || 'unknown'} 项目`;
  $('#projectEntrypointStatus').textContent = entryText;
  setDot($('#projectEntrypointDot'), entryText ? 'ready' : 'warn');

  const pressure = context?.context_pressure || {};
  const pressureText = `${pressure.tool_calls || 0} 次工具调用 · ${pressure.files_read || 0} 个文件 · ${pressure.response_megabytes || 0} MB 输出`;
  $('#contextPressureStatus').textContent = pressure.recommend_new_chat ? `${pressureText} · 建议新建会话` : pressureText;
  setDot($('#contextPressureDot'), pressure.level === 'high' ? 'error' : pressure.level === 'elevated' ? 'warn' : 'ready');

  const list = $('#projectInstructionsList');
  list.replaceChildren();
  const items = [
    ...rootFiles.map((item) => ({ path: item?.path, kind: '根目录规则', truncated: item?.truncated })),
    ...nestedFiles.map((path) => ({ path, kind: '嵌套规则', truncated: false }))
  ].filter((item) => item.path);
  if (!items.length) {
    const empty = document.createElement('span');
    empty.className = 'task-muted';
    empty.textContent = '当前项目没有 AGENTS.md / CLAUDE.md；本地工具将使用内置工作流规则。';
    list.appendChild(empty);
    return;
  }
  items.forEach((item) => {
    const content = instructionContents.get(String(item.path).toLowerCase()) || '';
    if (content) {
      const details = document.createElement('details');
      details.className = 'instruction-details';
      const summary = document.createElement('summary');
      summary.textContent = `${item.path} · ${item.kind}${item.truncated ? ' · 内容已截断' : ''}`;
      const pre = document.createElement('pre');
      pre.textContent = content;
      details.append(summary, pre);
      list.appendChild(details);
      return;
    }
    const row = document.createElement('div');
    row.className = 'task-file';
    const code = document.createElement('code'); code.textContent = item.path;
    const meta = document.createElement('span'); meta.textContent = `${item.kind}${item.truncated ? ' · 内容已截断' : ''}`;
    row.append(code, meta);
    list.appendChild(row);
  });
}

async function loadWorkspaceContext() {
  if (!api.workspaceContext) return;
  try {
    const [contextResult, guideResult] = await Promise.all([
      api.workspaceContext(),
      api.codingToolsGuide ? api.codingToolsGuide({ include_project_instructions: true }) : Promise.resolve(null)
    ]);
    const context = unwrap(contextResult);
    const guide = guideResult?.ok ? guideResult.data : null;
    renderWorkspaceContext(context, guide);
  } catch (error) {
    $('#projectInstructionsStatus').textContent = '本地工具未运行或暂不可读';
    $('#projectEntrypointStatus').textContent = '启动 MCP 后检测';
    $('#contextPressureStatus').textContent = '暂无统计';
    setDot($('#projectInstructionsDot'), 'warn');
    setDot($('#projectEntrypointDot'), 'warn');
    setDot($('#contextPressureDot'), 'warn');
  }
}

async function loadCodingToolsGuide() {
  if (!api.codingToolsGuide) return;
  try {
    const guide = unwrap(await api.codingToolsGuide());
    if (guide?.custom_instructions) $('#customInstructionsText').textContent = guide.custom_instructions;
    $('#codingToolsGuideStatus').textContent = '已从本地工具读取最新使用规则。';
  } catch {
    $('#codingToolsGuideStatus').textContent = 'MCP 尚未运行，当前显示内置推荐版本；启动后可再次刷新。';
  }
}

async function addAuthorizedRoot() {
  try {
    const selected = unwrap(await api.chooseWorkspace());
    if (!selected) return;
    const current = state.snapshot?.settings?.authorizedRoots || [];
    if (current.some((item) => item.toLowerCase() === selected.toLowerCase())) {
      toast('目录已授权', selected);
      return;
    }
    const snapshot = unwrap(await api.updateAuthorizedRoots([...current, selected]));
    renderSnapshot(snapshot, { forceForms: true });
    toast('已添加授权目录', selected);
  } catch (error) { toast('授权目录失败', error.message, 'error'); }
}

async function removeAuthorizedRoot(root) {
  try {
    const current = state.snapshot?.settings?.authorizedRoots || [];
    const snapshot = unwrap(await api.updateAuthorizedRoots(current.filter((item) => item !== root)));
    renderSnapshot(snapshot, { forceForms: true });
    toast('已移除授权目录', root);
  } catch (error) { toast('移除授权失败', error.message, 'error'); }
}

function renderEnvironment(environment) {
  setDot($('#envPythonDot'), environment.python.installed ? 'ready' : 'error');
  $('#envPythonText').textContent = environment.python.installed ? environment.python.version : '未找到 Python 3.11+';
  const proxy = environment.proxy;
  const sourceLabels = {
    'auto-direct': '自动检测 · 直连', 'auto-system': '自动检测 · Windows 系统代理', 'auto-local': '自动检测 · 本地代理',
    'system': 'Windows 系统代理', 'system-direct': '系统未设代理 · 直连', manual: '手动代理', direct: '强制直连',
    'auto-unavailable': '未找到可用网络路径', error: '代理检测失败'
  };
  setDot($('#envProxyDot'), proxy.reachable ? 'ready' : 'error');
  $('#envProxyText').textContent = `${sourceLabels[proxy.source] || '网络检测'}${proxy.url ? ` · ${proxy.url}` : ''}`;
  $('#proxyHint').textContent = proxy.reachable ? '当前网络路径已通过实际连通性验证。' : '当前路径未通过验证，可重新检测或选择手动代理。';
}

function renderProxyControls() {
  const manual = $('#proxyModeSelect').value === 'manual';
  $('#manualProxyField').classList.toggle('disabled', !manual);
  $('#proxyUrlInput').disabled = !manual;
}

function renderDeploySummary() {
  const snapshot = state.snapshot;
  if (!snapshot) return;
  const missing = [];
  const workspace = state.selectedWorkspace || snapshot.settings.workspace;
  const tunnelId = $('#tunnelIdInput').value.trim();
  if (!workspace) missing.push('工作目录');
  if (!tunnelId) missing.push('Tunnel ID');
  if (!snapshot.secrets.runtimeApiKey && !$('#runtimeKeyInput').value.trim()) missing.push('Runtime API Key');
  $('#deploySummary').textContent = missing.length
    ? `还需要填写：${missing.join('、')}`
    : '官方 MCP 已完成必要配置。';
}

async function refreshSnapshot(options = {}) {
  try {
    const snapshot = unwrap(await api.snapshot());
    renderSnapshot(snapshot, options);
    return snapshot;
  } catch (error) {
    toast('状态检测失败', error.message, 'error');
    return null;
  }
}

function collectSettings() {
  return {
    workspace: state.selectedWorkspace,
    permissionMode: $('input[name="permission"]:checked')?.value || 'safe',
    toolMode: 'smart',
    mcpPort: Number($('#mcpPortInput').value),
    healthPort: Number($('#healthPortInput').value),
    proxyMode: $('#proxyModeSelect').value,
    proxyUrl: $('#proxyUrlInput').value.trim(),
    tunnelId: $('#tunnelIdInput').value.trim(),
    theme: $('#themeSelect').value,
    startWithWindows: $('#startWithWindowsToggle').checked,
    keepRunningOnClose: $('#keepRunningToggle').checked,
    autoStartServices: $('#autoStartToggle').checked,
    progressReportSeconds: Number($('#progressReportSelect').value || 90),
    taskNotifications: $('#taskNotificationsToggle').checked,
    taskNotificationOnlyWhenUnfocused: false,
    taskNotificationSound: $('#taskNotificationSoundToggle').checked,
    taskNotificationMinSeconds: 0,
    guideProgress: collectGuideProgress()
  };
}

async function saveSettings(showToast = true) {
  const saved = unwrap(await api.saveSettings(collectSettings()));
  if (showToast) toast('设置已保存', '新的配置会在下一次部署时生效。');
  if (state.snapshot) state.snapshot.settings = saved;
  return saved;
}

async function saveKeyIfPresent() {
  const key = $('#runtimeKeyInput').value.trim();
  if (!key) return false;
  unwrap(await api.saveRuntimeKey(key));
  $('#runtimeKeyInput').value = '';
  return true;
}

function updateProgress(payload) {
  const percent = Math.max(0, Math.min(100, Number(payload.percent || 0)));
  $('#progressPercent').textContent = `${percent}%`;
  $('#progressBar').style.width = `${percent}%`;
  $('#progressRing').style.setProperty('--value', `${percent * 3.6}deg`);
  $('#progressTitle').textContent = payload.step === 'failed' ? '部署失败' : payload.step === 'complete' ? '部署完成' : '正在执行部署任务';
  $('#progressMessage').textContent = payload.message;
  $('#progressBadge').textContent = payload.step === 'failed' ? '需要处理' : payload.step === 'complete' ? '已完成' : '运行中';
  if (payload.step === 'failed') toast('部署失败', payload.message, 'error');
}

async function runRuntime(action) {
  setBusy(true, false);
  navigate('overview');
  try {
    const result = unwrap(await api[action]());
    renderSnapshot(result, { forceForms: true });
    toast(action === 'stop' ? '服务已停止' : '操作完成', action === 'stop' ? '本地工具与连接通道已安全停止。' : '本地工具与连接通道已通过健康检查。');
  } catch (error) {
    toast('操作失败', error.message, 'error');
    if (/工作目录|Runtime API Key|Tunnel ID|Python/.test(error.message)) navigate('deploy');
  } finally {
    setBusy(false);
    await refreshSnapshot();
  }
}

async function deployNow() {
  setBusy(true, false);
  try {
    await saveKeyIfPresent();
    await saveSettings(false);
    navigate('overview');
    const result = unwrap(await api.start());
    renderSnapshot(result, { forceForms: true });
    toast('部署完成', '现在可以按照指导页面在 ChatGPT 中创建或测试 MCP。');
  } catch (error) {
    toast('部署失败', error.message, 'error');
  } finally {
    setBusy(false);
    await refreshSnapshot();
  }
}

async function chooseWorkspace() {
  try {
    const selected = unwrap(await api.chooseWorkspace());
    if (!selected) return;
    state.selectedWorkspace = selected;
    $('#selectedWorkspace').textContent = selected;
    renderDeploySummary();
    toast('正在切换工作目录', 'MCP 会在后台热切换目录，ChatGPT 与 Tunnel 不会关闭。');
    const switched = unwrap(await api.switchWorkspace(selected));
    renderSnapshot(switched, { forceForms: true });
    await loadWorkspaceContext();
    toast('工作目录已切换', selected);
  } catch (error) { toast('无法选择目录', error.message, 'error'); }
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('已复制', text.length > 70 ? '内容已复制到剪贴板。' : text); }
  catch { toast('复制失败', '请手动选择并复制。', 'error'); }
}

function collectGuideProgress() {
  return Object.fromEntries($$('[data-guide-check]').map((input) => [input.dataset.guideCheck, input.checked]));
}

function restoreGuideProgress(progress) {
  $$('[data-guide-check]').forEach((input) => { input.checked = Boolean(progress[input.dataset.guideCheck]); });
  renderGuideProgress();
}

function renderGuideProgress() {
  const checks = $$('[data-guide-check]');
  const done = checks.filter((input) => input.checked).length;
  const percent = Math.round((done / checks.length) * 100);
  $('#guideProgressPercent').textContent = `${percent}%`;
  $('#guideProgressBar').style.width = `${percent}%`;
  checks.forEach((input, index) => {
    input.closest('.guide-step').classList.toggle('done', input.checked);
    $$('#guideChecklist li')[index]?.classList.toggle('done', input.checked);
  });
}

function appendBuildOutput(text) {
  const consoleElement = $('#buildConsole');
  const next = `${consoleElement.textContent === '尚未执行构建验证。' ? '' : consoleElement.textContent}${text}`;
  consoleElement.textContent = next.slice(-60000);
  consoleElement.scrollTop = consoleElement.scrollHeight;
}

function applyBuildProject(project) {
  $('#buildProjectType').textContent = `${projectTypeLabel(project.type)} · ${textOr(project.name)}`;
  $('#buildTestCommand').value = project.testCommand || '';
  $('#buildCommand').value = project.buildCommand || '';
  $('#buildArtifacts').value = (project.artifacts || []).join(', ');
  $('#buildPlanProject').textContent = `${textOr(project.name)} · ${projectTypeLabel(project.type)}`;
  $('#buildPlanTest').textContent = project.testCommand ? `自动使用：${project.testCommand}` : '未检测到可用测试；不会盲目执行';
  $('#buildPlanBuild').textContent = project.buildCommand ? `自动使用：${project.buildCommand}` : '未检测到可用构建命令';
  $('#buildPlanArtifacts').textContent = (project.artifacts || []).length ? (project.artifacts || []).join('、') : '自动检查项目产物';
}

async function inspectBuild() {
  try { applyBuildProject(unwrap(await api.inspectBuild())); }
  catch (error) { toast('项目识别失败', error.message, 'error'); }
}

function renderBuildReport(report) {
  $('#buildReportStatus').textContent = report.overallStatus === 'passed' ? '验证通过' : '验证失败';
  const container = $('#buildReport'); container.replaceChildren();
  const summary = document.createElement('div'); summary.className = `build-report-summary ${report.overallStatus}`;
  summary.textContent = `${textOr(report.project?.name)} · ${projectTypeLabel(report.project?.type)} · v${textOr(report.project?.version)} · 测试${statusLabel(report.testResult?.status)} · 构建${statusLabel(report.buildResult?.status)}`;
  container.append(summary);
  (report.artifacts || []).forEach((artifact) => {
    const row = document.createElement('div'); row.className = 'build-report-artifact';
    const name = document.createElement('b'); name.textContent = textOr(artifact.path);
    const size = document.createElement('span'); size.textContent = `${Number(artifact.size || 0).toLocaleString()} bytes`;
    const hash = document.createElement('code'); hash.textContent = textOr(artifact.sha256);
    row.append(name, size, hash); container.append(row);
  });
  if (!(report.artifacts || []).length) {
    const empty = document.createElement('span'); empty.className = 'task-muted'; empty.textContent = '未找到构建产物。'; container.append(empty);
  }
}

async function runBuildVerification() {
  $('#buildConsole').textContent = '';
  $('#buildStatus').textContent = '正在执行';
  $('#runBuild').disabled = true;
  try {
    const options = {
      testCommand: $('#buildTestCommand').value.trim(),
      buildCommand: $('#buildCommand').value.trim(),
      artifacts: $('#buildArtifacts').value.split(',').map((item) => item.trim()).filter(Boolean),
      runTests: $('#buildRunTests').checked,
      runBuild: $('#buildRunBuild').checked
    };
    const report = unwrap(await api.runBuild(options));
    renderBuildReport(report);
    $('#buildStatus').textContent = report.overallStatus === 'passed' ? '已通过' : '未通过';
    toast(report.overallStatus === 'passed' ? '构建验证通过' : '构建验证未通过', `${report.artifacts?.length || 0} 个产物已校验`, report.overallStatus === 'passed' ? 'success' : 'error');
  } catch (error) {
    $('#buildStatus').textContent = '执行失败'; appendBuildOutput(`\n${error.message}\n`); toast('构建验证失败', error.message, 'error');
  } finally { $('#runBuild').disabled = false; }
}

function renderHealth(report) {
  $('#healthSummary').textContent = report.healthy ? '全部正常' : '需要处理';
  const container = $('#healthList'); container.replaceChildren();
  (report.checks || []).forEach((check) => {
    const row = document.createElement('div'); row.className = `health-item ${check.ok ? 'passed' : 'failed'}`;
    const mark = document.createElement('i'); mark.textContent = check.ok ? '✓' : '!';
    const copy = document.createElement('div'); const title = document.createElement('b'); title.textContent = check.label; const detail = document.createElement('small'); detail.textContent = check.detail; copy.append(title, detail);
    const status = document.createElement('span'); status.textContent = check.ok ? '正常' : '待处理'; row.append(mark, copy, status); container.append(row);
  });
  (report.actions || []).forEach((action) => {
    const row = document.createElement('div'); row.className = 'health-item passed';
    const mark = document.createElement('i'); mark.textContent = '↻';
    const copy = document.createElement('div'); const title = document.createElement('b'); title.textContent = '已执行修复'; const detail = document.createElement('small'); detail.textContent = action; copy.append(title, detail);
    const status = document.createElement('span'); status.textContent = '完成'; row.append(mark, copy, status); container.append(row);
  });
}

async function inspectHealth() {
  try { renderHealth(unwrap(await api.inspectHealth())); }
  catch (error) { toast('系统体检失败', error.message, 'error'); }
}

async function repairHealth() {
  $('#repairHealth').disabled = true;
  try {
    const report = unwrap(await api.repairHealth()); renderHealth(report);
    toast(report.healthy ? '一键修复完成' : '已完成可自动处理的项目', report.unresolved?.length ? `仍需手动处理：${report.unresolved.join('、')}` : '当前环境已通过体检。', report.healthy ? 'success' : 'error');
  } catch (error) { toast('一键修复失败', error.message, 'error'); }
  finally { $('#repairHealth').disabled = false; }
}

function applyHeartbeat(status) {
  if (!state.snapshot || !status) return;
  state.snapshot.status.runtimeRunning = Boolean(status.mcpRunning);
  state.snapshot.status.tunnelRunning = Boolean(status.tunnelRunning);
  state.snapshot.status.connectionRunning = Boolean(status.connectionRunning);
  state.snapshot.status.fullyReady = Boolean(status.fullyReady);
  const connectionRunning = Boolean(status.tunnelRunning);
  const connectionLabel = '连接通道';
  const ready = state.snapshot.status.fullyReady;
  $('#sideMcp').textContent = status.mcpRunning ? '正常' : '停止';
  $('#sideTunnel').textContent = connectionRunning ? '已连' : '断开';
  $('#mcpStatus').textContent = status.mcpRunning ? '正常运行' : '未启动';
  $('#tunnelStatus').textContent = connectionRunning
    ? '已连接'
    : '未连接';
  setDot($('#mcpDot'), status.mcpRunning ? 'ready' : 'error');
  setDot($('#tunnelDot'), connectionRunning ? 'ready' : 'error');
  $('#sideRuntimeText').textContent = ready ? '服务已就绪' : status.mcpRunning ? `等待 ${connectionLabel}` : '服务未运行';
  setDot($('#sideRuntimeDot'), ready ? 'ready' : status.mcpRunning ? 'warn' : 'error');
}

async function loadLogs() {
  try {
    state.logs = unwrap(await api.logs());
    renderLogs();
  } catch (error) { toast('日志读取失败', error.message, 'error'); }
}

function renderLogs() {
  const output = $('#logOutput');
  const list = state.logFilter === 'all' ? state.logs : state.logs.filter((item) => item.level === state.logFilter);
  output.replaceChildren();
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = '<b>暂无匹配日志</b><span>执行部署或切换筛选条件后再查看。</span>';
    output.appendChild(empty);
    return;
  }
  list.forEach((item) => {
    const row = document.createElement('div');
    row.className = `log-line ${item.level}`;
    const time = document.createElement('time');
    time.textContent = new Date(item.time).toLocaleString('zh-CN', { hour12: false });
    const level = document.createElement('em');
    level.textContent = item.level;
    const message = document.createElement('span');
    message.textContent = item.message;
    row.append(time, level, message);
    output.appendChild(row);
  });
  output.scrollTop = output.scrollHeight;
}

function bindEvents() {
  $('#closeManager')?.addEventListener('click', () => api.closeManager());
  $$('.nav-item').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.page)));
  $$('[data-nav]').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.nav)));
  $$('[data-open]').forEach((button) => button.addEventListener('click', async () => {
    try { unwrap(await api.openExternal(button.dataset.open)); }
    catch (error) { toast('无法打开页面', error.message, 'error'); }
  }));
  $$('input[name="permission"]').forEach((input) => input.addEventListener('change', () => {
    $$('.choice').forEach((choice) => choice.classList.toggle('selected', choice.contains(input) && input.checked));
  }));
  $('#ackBridgeRemoved')?.addEventListener('click', async () => {
    try {
      const saved = unwrap(await api.saveSettings({ bridgeRemovedNotice: false }));
      if (state.snapshot) state.snapshot.settings = saved;
      renderMigrationNotice(saved);
    } catch (error) { toast('无法关闭提示', error.message, 'error'); }
  });

  $('#refreshButton').addEventListener('click', () => refreshSnapshot());
  $('#topStartButton').addEventListener('click', () => runRuntime(state.snapshot?.status.fullyReady ? 'restart' : 'start'));
  $('#heroStartButton').addEventListener('click', () => state.snapshot?.status.fullyReady ? runRuntime('restart') : navigate('deploy'));
  $('#overviewRestart').addEventListener('click', () => runRuntime('restart'));
  $('#overviewStop').addEventListener('click', () => runRuntime('stop'));
  $('#deployNow').addEventListener('click', deployNow);
  $('#chooseWorkspace').addEventListener('click', chooseWorkspace);
  $('#addAuthorizedRoot').addEventListener('click', addAuthorizedRoot);
  $('#refreshWorkspaceContext')?.addEventListener('click', loadWorkspaceContext);
  $('#refreshCodingToolsGuide')?.addEventListener('click', loadCodingToolsGuide);
  $('#copyCustomInstructions')?.addEventListener('click', () => copyText($('#customInstructionsText').textContent));
  $('#testTaskNotification')?.addEventListener('click', async () => {
    try {
      await api.testTaskNotification();
      toast('测试通知已发送', '如果 Windows 通知未被系统勿扰模式拦截，你会在右下角看到提醒。');
    } catch (error) { toast('无法发送测试通知', error.message, 'error'); }
  });
  $('#saveDeploySettings').addEventListener('click', async () => {
    try { await saveKeyIfPresent(); await saveSettings(); await refreshSnapshot({ forceForms: true }); }
    catch (error) { toast('保存失败', error.message, 'error'); }
  });
  $('#saveWorkspace').addEventListener('click', async () => {
    try { await saveSettings(); await refreshSnapshot({ forceForms: true }); }
    catch (error) { toast('保存失败', error.message, 'error'); }
  });
  $('#saveWorkspaceRestart').addEventListener('click', async () => {
    try { await saveSettings(false); await runRuntime('restart'); }
    catch (error) { toast('重新部署失败', error.message, 'error'); }
  });
  $('#saveRuntimeKey').addEventListener('click', async () => {
    try {
      if (!(await saveKeyIfPresent())) throw new Error('请先粘贴 Runtime API Key。');
      toast('密钥已安全保存', '密钥已使用 Windows 安全存储加密。');
      await refreshSnapshot();
    } catch (error) { toast('保存失败', error.message, 'error'); }
  });
  $('#removeRuntimeKey').addEventListener('click', async () => {
    try { unwrap(await api.removeRuntimeKey()); toast('密钥已删除'); await refreshSnapshot(); }
    catch (error) { toast('删除失败', error.message, 'error'); }
  });
  $('#regenerateToken').addEventListener('click', async () => {
    try { unwrap(await api.regenerateMcpToken()); toast('认证 Token 已重新生成', '重新部署后生效。'); }
    catch (error) { toast('生成失败', error.message, 'error'); }
  });
  $('#clearChatSession').addEventListener('click', async () => {
    if (!confirm('这会退出内联 ChatGPT，并清除该助手保存的网页 Cookie 和缓存。是否继续？')) return;
    try {
      unwrap(await api.clearChatSession());
      toast('ChatGPT 登录数据已清除', '返回聊天主窗口后可以重新登录。');
    } catch (error) { toast('清除失败', error.message, 'error'); }
  });
  $('#pythonInstall').addEventListener('click', async () => {
    setBusy(true, true);
    try { unwrap(await api.installPython()); toast('Python 安装完成', '请重新检测环境。'); await refreshSnapshot(); }
    catch (error) { toast('安装失败', error.message, 'error'); }
    finally { setBusy(false); }
  });
  $('#proxyModeSelect').addEventListener('change', () => { renderProxyControls(); renderDeploySummary(); });
  $('#proxyDetect').addEventListener('click', async () => {
    try {
      await saveSettings(false);
      const result = unwrap(await api.detectProxy());
      toast(result.reachable ? '网络路径可用' : '未检测到可用路径', result.resolvedUrl || (result.reachable ? '当前使用直连。' : '请检查网络或手动代理设置。'), result.reachable ? 'success' : 'error');
      await refreshSnapshot({ forceForms: true });
    } catch (error) { toast('代理检测失败', error.message, 'error'); }
  });
  ['#tunnelIdInput', '#proxyUrlInput', '#runtimeKeyInput'].forEach((selector) => $(selector).addEventListener('input', renderDeploySummary));

  $('#themeToggle').addEventListener('click', async () => {
    const next = document.body.dataset.theme === 'light' ? 'dark' : 'light';
    applyTheme(next);
    try { await saveSettings(false); } catch { /* non-critical */ }
  });
  $('#themeSelect').addEventListener('change', async () => { applyTheme($('#themeSelect').value); await saveSettings(false); });
  $('#keepRunningToggle').addEventListener('change', () => saveSettings(false));
  $('#autoStartToggle').addEventListener('change', () => saveSettings(false));

  $$('[data-guide-check]').forEach((input) => input.addEventListener('change', async () => {
    renderGuideProgress();
    try { await saveSettings(false); } catch { /* non-critical */ }
  }));
  $$('[data-copy]').forEach((button) => button.addEventListener('click', () => copyText(button.dataset.copy)));
  $('#copyLocalUrl').addEventListener('click', () => copyText($('#guideLocalUrl').textContent));
  $('#copyTunnelId').addEventListener('click', () => copyText($('#guideTunnelId').textContent));

  $('#refreshLogs').addEventListener('click', loadLogs);
  $('#refreshTaskState').addEventListener('click', loadTaskState);
  $('#refreshTaskWorktrees')?.addEventListener('click', loadTaskState);
  $('#refreshTaskHistory').addEventListener('click', loadTaskHistory);
  $('#pauseTask').addEventListener('click', async () => { try { unwrap(await api.pauseTask()); await loadTaskState(); toast('任务已暂停', '当前进度已保存在工作区。'); } catch (error) { toast('暂停失败', error.message, 'error'); } });
  $('#resumeTask').addEventListener('click', async () => { try { unwrap(await api.resumeTask()); await loadTaskState(); toast('任务已继续', '网页模型可从记录的下一步恢复。'); } catch (error) { toast('继续失败', error.message, 'error'); } });
  $('#stopTask').addEventListener('click', async () => { if (!confirm('确定停止当前任务吗？运行中的命令会被终止。')) return; try { unwrap(await api.stopTask()); await loadTaskState(); toast('任务已停止', '状态与历史仍保留，可稍后继续。'); } catch (error) { toast('停止失败', error.message, 'error'); } });
  $('#clearTaskState').addEventListener('click', async () => { if (!confirm('确定清除当前工作区的任务状态吗？')) return; unwrap(await api.clearTaskState()); renderTaskState(null); toast('任务状态已清除'); });
  $('#refreshPerformance').addEventListener('click', loadPerformanceTrace);
  $('#clearPerformance').addEventListener('click', async () => { if (!confirm('确定清空当前工作区的性能记录吗？')) return; try { unwrap(await api.clearPerformanceTrace()); renderPerformanceTrace(null); toast('性能记录已清空'); } catch (error) { toast('清空失败', error.message, 'error'); } });
  $('#inspectBuild').addEventListener('click', inspectBuild);
  $('#runBuild').addEventListener('click', runBuildVerification);
  $('#inspectHealth').addEventListener('click', inspectHealth);
  $('#repairHealth').addEventListener('click', repairHealth);
  $('#toolModeSelect')?.addEventListener('change', async () => {
    try {
      const wasRunning = Boolean(state.snapshot?.status.runtimeRunning);
      await saveSettings(false);
      toast('工具模式已保存', wasRunning ? '正在静默重建 MCP 以应用新的工具范围。' : '下次启动 MCP 时生效。');
      if (wasRunning) await runRuntime('restart');
    } catch (error) { toast('工具模式切换失败', error.message, 'error'); }
  });
  $('#clearLogs').addEventListener('click', async () => { unwrap(await api.clearLogs()); state.logs = []; renderLogs(); toast('日志已清空'); });
  $$('.log-filter').forEach((button) => button.addEventListener('click', () => {
    state.logFilter = button.dataset.logFilter;
    $$('.log-filter').forEach((item) => item.classList.toggle('active', item === button));
    renderLogs();
  }));
}

async function initialize() {
  try {
    bindEvents();
    api.onProgress(updateProgress);
    api.onLog((entry) => {
      state.logs.push(entry);
      if (state.logs.length > 1000) state.logs.shift();
      if (state.currentPage === 'logs') renderLogs();
    });
    api.onStatus((payload) => {
      if (payload?.snapshot) renderSnapshot(payload.snapshot, { forceForms: false });
    });
    api.onHeartbeat(applyHeartbeat);
    api.onBuildProgress((payload) => {
      if (payload.status === 'output') appendBuildOutput(payload.text || '');
      else if (payload.status === 'running') { $('#buildStatus').textContent = payload.stage === 'test' ? '正在测试' : '正在构建'; appendBuildOutput(`\n> ${payload.command}\n`); }
      else if (payload.stage === 'complete') $('#buildStatus').textContent = payload.status === 'passed' ? '已通过' : '未通过';
    });
    const requestedPage = location.hash.slice(1);
    if (pageMeta[requestedPage]) navigate(requestedPage);

    // Show the settings shell immediately. Runtime/network inspection continues
    // in the background so opening Preferences never feels like a diagnostic run.
    document.body.classList.remove('booting');
    document.body.classList.add('booted');
    $('#bootScreen')?.setAttribute('aria-hidden', 'true');

    const firstSnapshot = await refreshSnapshot({ forceForms: true });
    if (firstSnapshot && !firstSnapshot.settings.firstRunCompleted) {
      try {
        navigate('health');
        await inspectHealth();
        unwrap(await api.saveSettings({ firstRunCompleted: true }));
        toast('首次运行体检', '已检查当前环境；可点击“一键修复”处理能够自动解决的问题。');
      } catch (error) { toast('首次运行体检未完成', error.message, 'error'); }
    }
  } finally {
    document.body.classList.remove('booting');
    document.body.classList.add('booted');
    $('#bootScreen')?.setAttribute('aria-hidden', 'true');
  }
}

initialize();






