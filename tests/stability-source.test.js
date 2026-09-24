const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('smart mode keeps a fixed compact tool surface with hidden compatibility', () => {
  const server = read('resources/coding-tools-mcp/coding_tools_mcp/server.py');
  const block = server.match(/"smart": frozenset\(\{([\s\S]*?)\}\),/)?.[1] || '';
  const tools = [...block.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(tools.sort(), [
    'agent_workflow', 'coding_tools_guide', 'command_control', 'document_workflow', 'exec_command',
    'request_permissions', 'task_control', 'view_image', 'workspace_context'
  ].sort());
  assert.match(server, /SMART_COMPAT_TOOL_NAMES/);
  assert.match(server, /compatibility_call/);
  assert.match(server, /_tools_list_payload/);
  const workflowStart = server.indexOf('"agent_workflow": object_schema({');
  const workflowEnd = server.indexOf('"workspace_context": object_schema({', workflowStart);
  assert.ok(workflowStart >= 0 && workflowEnd > workflowStart, "agent_workflow schema block must be discoverable");
  const workflowSchema = server.slice(workflowStart, workflowEnd);
  assert.doesNotMatch(workflowSchema, /"max_total_bytes"/);
  assert.doesNotMatch(workflowSchema, /"max_diff_bytes"/);
  assert.doesNotMatch(workflowSchema, /"force_refresh"/);
  assert.match(workflowSchema, /"command_steps"/);
  assert.match(workflowSchema, /"commands": \{"type": "array", "maxItems": 20, "items": string/);
  assert.match(workflowSchema, /"queries": \{"type": "array", "maxItems": 32/);
  assert.match(workflowSchema, /"paths": \{"type": "array", "maxItems": 80/);
  const commandSteps = workflowSchema.match(/"command_steps": \{([\s\S]*?)\}, "description": "Optional structured checks/)?.[1] || '';
  assert.match(commandSteps, /"required": \["cmd"\]/);
  assert.doesNotMatch(commandSteps, /oneOf/);
  assert.match(server, /def _build_execution_plan/);
  assert.match(server, /def _infer_workflow_command_role/);
  assert.match(server, /"execution_plan": execution_plan/);
  assert.match(workflowSchema, /"isolation": \{\*\*string, "enum": \["auto", "off"\]/);
  assert.match(server, /"worktree_create", "worktree_list", "worktree_get", "worktree_diff", "worktree_apply", "worktree_discard"/);
});

test('HTTP sessions share one runtime and expose protocol health', () => {
  const transport = read('resources/coding-tools-mcp/coding_tools_mcp/transport_http.py');
  const server = read('resources/coding-tools-mcp/coding_tools_mcp/server.py');
  assert.match(transport, /Route all authenticated HTTP sessions through one shared Runtime/);
  assert.match(transport, /MAX_TRACKED_SESSION_ALIASES = 512/);
  assert.match(server, /HTTPSessionManager\(control_runtime\)/);
  assert.match(server, /__control\/health/);
  assert.match(server, /__control\/workspace/);
});

test('runtime exposes a versioned schema contract and desktop health detects stale MCP processes', () => {
  const server = read('resources/coding-tools-mcp/coding_tools_mcp/server.py');
  const protocol = read('resources/coding-tools-mcp/coding_tools_mcp/protocol.py');
  const native = read('electron/services/nativeService.js');
  const health = read('electron/services/healthService.js');
  const contract = JSON.parse(read('resources/coding-tools-mcp/schema-contract.json'));
  assert.equal(contract.schema_version, 10);
  assert.equal(contract.tool_count, 9);
  assert.match(contract.schema_hash, /^[a-f0-9]{64}$/);
  assert.match(server, /TOOL_SCHEMA_VERSION = 10/);
  assert.match(server, /tool_schema_hash/);
  assert.match(protocol, /schemaHash/);
  assert.match(native, /runtimeSourceFingerprint/);
  assert.match(health, /本地工具定义版本（MCP）/);
  assert.match(health, /schemaMatches/);
  assert.match(health, /runtimeSchema\.processId/);
  assert.match(health, /runtimeSchema\.runtimeInstanceId/);
});

test('desktop runtime hot-switches workspaces while the chat chrome stays compact', () => {
  const orchestrator = read('electron/services/runtimeOrchestrator.js');
  const browser = read('renderer/browser.js');
  const workspaceWindow = read('renderer/workspace.js');
  assert.match(orchestrator, /switchMcpWorkspace/);
  assert.match(orchestrator, /async supervise\(\)/);
  assert.match(browser, /workspacePickerButton/);
  assert.match(browser, /function taskPresentation/);
  assert.match(browser, /setInterval\(refreshTask, 3000\)/);
  assert.doesNotMatch(browser, /backgroundOperationStatus|progressForTask|taskProgressBar/);
  assert.match(workspaceWindow, /inspectWorkspaces/);
  assert.match(workspaceWindow, /cleanupInvalidWorkspaces/);
});

test('startup failure cleans runtime state and blocks automatic recovery until manual retry', () => {
  const orchestrator = read('electron/services/runtimeOrchestrator.js');
  const main = read('electron/main.js');
  assert.match(orchestrator, /autoRecoveryBlocked/);
  assert.match(orchestrator, /lastStartFailure/);
  assert.match(orchestrator, /await this\.tunnel\.stop\(\)\.catch/);
  assert.match(orchestrator, /await this\.native\.stop\(\)\.catch/);
  assert.match(orchestrator, /if \(this\.autoRecoveryBlocked\)/);
  assert.match(orchestrator, /restart\(\{ automatic: true \}\)/);
  assert.match(orchestrator, /Coding Tools MCP 进程已提前退出/);
  assert.match(main, /start\(\{ automatic: true \}\)/);
});

test('browser task strip exposes only user-facing status and a real stop action', () => {
  const html = read('renderer/browser.html');
  const browser = read('renderer/browser.js');
  const preload = read('electron/browserPreload.js');
  assert.match(html, /id="taskStatusLabel"/);
  assert.match(html, /id="stopTask"/);
  assert.doesNotMatch(html, /taskProgressBar|taskProgressText|pauseTask|resumeTask/);
  assert.match(browser, /function taskPresentation/);
  assert.match(browser, /taskRuntime/);
  assert.match(browser, /runningOperation/);
  assert.match(browser, /api\.stopTask/);
  assert.match(browser, /setInterval\(refreshTask, 3000\)/);
  assert.doesNotMatch(browser, /progressForTask|backgroundOperationStatus|heartbeatAge/);
  assert.match(preload, /stopTask: \(\) => ipcRenderer\.invoke\('task-state:stop'\)/);
  assert.doesNotMatch(preload, /pauseTask|resumeTask|performanceTrace/);
});

test('desktop reuses one local MCP client instead of rediscovering tools for every status poll', () => {
  const main = read('electron/main.js');
  assert.match(main, /let sharedLocalMcpClient = null/);
  assert.match(main, /if \(!client\.tools\.length\) await client\.discoverTools\(\)/);
  assert.match(main, /invalidateLocalMcpDiscovery/);
  assert.doesNotMatch(main, /const client = new LocalMcpClient\(\{ port: current\.mcpPort, token, log \}\);\s*await client\.discoverTools\(\);/);
});

test('Manager exposes compact task details without restoring the internal task console', () => {
  const html = read('renderer/index.html');
  const manager = read('renderer/app.js');
  const preload = read('electron/preload.js');
  const browserPreload = read('electron/browserPreload.js');
  assert.doesNotMatch(html, /data-page-view="task"|taskOperations|taskHistory|历史与性能/);
  assert.match(html, /id="taskPanel"/);
  assert.match(html, /id="taskObjective"/);
  assert.match(html, /id="taskCurrentStep"/);
  assert.match(html, /技术详情/);
  assert.match(manager, /refreshTaskRuntime/);
  assert.match(preload, /taskRuntime/);
  assert.doesNotMatch(preload, /performanceTrace|taskHistory/);
  assert.match(browserPreload, /taskRuntime/);
  assert.match(browserPreload, /stopTask/);
});

test('desktop task notifications prefer authenticated MCP task events with slow polling only as fallback', () => {
  const server = read('resources/coding-tools-mcp/coding_tools_mcp/server.py');
  const taskState = read('resources/coding-tools-mcp/coding_tools_mcp/task_state.py');
  const client = read('electron/services/localMcpClient.js');
  const notifications = read('electron/services/taskNotificationService.js');
  const main = read('electron/main.js');
  assert.match(server, /\/__control\/events/);
  assert.match(server, /handle_events/);
  assert.match(server, /Last-Event-ID/);
  assert.match(server, /\/__control\/task-events/);
  assert.match(server, /is_authorized\(\)/);
  assert.match(server, /text\/event-stream/);
  assert.match(taskState, /events\.jsonl/);
  assert.match(taskState, /wait_for_events/);
  assert.match(taskState, /events_since/);
  assert.match(taskState, /notify_all/);
  assert.match(client, /subscribeTaskEvents/);
  assert.match(client, /Last-Event-ID/);
  assert.match(main, /subscribeTaskEvents/);
  assert.match(notifications, /pollIntervalMs \|\| 30000/);
  assert.match(notifications, /acceptState/);
});

test('runtime heartbeat alerts only after sustained unexpected outages and reports recovery', () => {
  const orchestrator = read('electron/services/runtimeOrchestrator.js');
  const notifications = read('electron/services/taskNotificationService.js');
  const main = read('electron/main.js');
  assert.match(orchestrator, /busy: this\.busy/);
  assert.match(orchestrator, /manuallyStopped: this\.isManuallyStopped\(\)/);
  assert.match(notifications, /acceptRuntimeStatus/);
  assert.match(notifications, /Number\(status\.failures \|\| 0\) < 2/);
  assert.match(notifications, /status\.busy \|\| status\.recovering/);
  assert.match(notifications, /status\.manuallyStopped/);
  assert.match(notifications, /连接已恢复/);
  assert.match(main, /acceptRuntimeStatus\?\.\(status\)/);
});

test('0.5.5 keeps last known task progress when a status refresh temporarily fails', () => {
  const manager = read('renderer/app.js');
  const server = read('resources/coding-tools-mcp/coding_tools_mcp/server.py');
  assert.match(manager, /taskRuntimeError: null/);
  assert.match(manager, /状态读取暂时失败，保留上次进度/);
  assert.doesNotMatch(manager, /catch \{\s*state\.taskRuntime = null;\s*renderTaskRuntime\(\)/);
  assert.match(server, /command_read_only = name == "command_control" and command_action in \{"poll", "read"\}/);
  assert.match(server, /str\(item\.get\("status"\) or ""\) in \{"running", "queued"\}/);
});

test('desktop shell observes real task boundaries and keeps only useful notification preferences', () => {
  const main = read('electron/main.js');
  const manager = read('renderer/index.html');
  const preload = read('electron/preload.js');
  assert.match(main, /TaskNotificationService/);
  assert.match(main, /setAppUserModelId/);
  assert.match(manager, /id="taskNotificationsToggle"/);
  assert.match(manager, /id="taskNotificationSoundToggle"/);
  assert.doesNotMatch(manager, /testTaskNotification|taskNotificationOnlyWhenUnfocused|taskNotificationMinSeconds/);
  assert.doesNotMatch(preload, /testTaskNotification/);
});

test('workspace context exposes project instructions and local context pressure', () => {
  const server = read('resources/coding-tools-mcp/coding_tools_mcp/server.py');
  const results = read('resources/coding-tools-mcp/coding_tools_mcp/tool_results.py');
  assert.match(server, /"project_instructions": instruction_summary/);
  assert.match(server, /"context_pressure": context_pressure/);
  assert.match(server, /"core_entries": core_entries/);
  assert.match(server, /"recommended_next_action": recommended_next_action/);
  assert.match(server, /classify_context_pressure\(tool_calls, response_bytes, files_read\)/);
  assert.match(server, /"large_payloads": large_payloads/);
  assert.match(server, /"command_heavy": command_heavy/);
  assert.match(server, /"diff_heavy": diff_heavy/);
  assert.match(server, /"history_heavy": history_heavy/);
  assert.match(server, /"recommend_compact": recommend_compact/);
  assert.match(server, /context_budget_snapshot\(context_pressure\)/);
  assert.match(server, /"runtime_layers": runtime_layers/);
  assert.match(server, /tool_registry_snapshot/);
  assert.doesNotMatch(server, /tool_calls >= 50 or response_bytes/);
  assert.match(results, /def _render_workspace_context/);
  assert.match(results, /"workspace_context": _render_workspace_context/);
});

test('prepare context uses internal adaptive budgets and search windows', () => {
  const server = read('resources/coding-tools-mcp/coding_tools_mcp/server.py');
  assert.match(server, /def _prepare_context_budget/);
  assert.match(server, /"read_strategy": "search_windows"/);
  assert.match(server, /read_args\["start_line"\]/);
  const workflowStart = server.indexOf('"agent_workflow": object_schema({');
  const workflowEnd = server.indexOf('"workspace_context": object_schema({', workflowStart);
  assert.ok(workflowStart >= 0 && workflowEnd > workflowStart, "agent_workflow schema block must be discoverable");
  const workflowSchema = server.slice(workflowStart, workflowEnd);
  assert.doesNotMatch(workflowSchema, /"max_total_bytes"/);
});

test('performance trace remains backend infrastructure and is removed from the Manager UI', () => {
  const trace = read('resources/coding-tools-mcp/coding_tools_mcp/performance_trace.py');
  const server = read('resources/coding-tools-mcp/coding_tools_mcp/server.py');
  const client = read('electron/services/localMcpClient.js');
  const manager = read('renderer/app.js');
  const browser = read('renderer/browser.js');
  const html = read('renderer/index.html');
  assert.match(trace, /TRACE_VERSION = 3/);
  assert.match(trace, /"context_visible": visible/);
  assert.match(trace, /state\["tool_calls"\] \+= 1/);
  assert.match(trace, /state\["files_read"\] \+= event\["files_read"\]/);
  assert.match(trace, /state\["large_payloads"\] \+= 1/);
  assert.match(server, /trace_origin=self\._trace_origin\(\)/);
  assert.match(client, /X-Coding-Tools-Origin': 'desktop'/);
  assert.doesNotMatch(html, /contextPressureStatus|performanceMetrics|performanceTimeline/);
  assert.doesNotMatch(manager, /renderPerformanceTrace|loadPerformanceTrace|contextPressureStatus/);
  assert.doesNotMatch(browser, /refreshContextPressure/);
});

test('Worktree safety is hidden normally but recoverable when isolated changes need attention', () => {
  const server = read('resources/coding-tools-mcp/coding_tools_mcp/server.py');
  const worktrees = read('resources/coding-tools-mcp/coding_tools_mcp/worktrees.py');
  const main = read('electron/main.js');
  const preload = read('electron/preload.js');
  const manager = read('renderer/app.js');
  const html = read('renderer/index.html');
  assert.match(server, /"active_worktree": active_worktree/);
  assert.match(server, /worktree_apply/);
  assert.match(main, /mcp:task-worktrees/);
  assert.match(main, /mcp:task-worktree-diff/);
  assert.match(main, /mcp:task-worktree-apply/);
  assert.match(main, /mcp:task-worktree-discard/);
  assert.match(worktrees, /def apply_back/);
  assert.match(worktrees, /WORKTREE_APPLY_CONFLICT/);
  assert.match(worktrees, /primary_index_untouched/);
  assert.match(preload, /taskWorktreeDiff/);
  assert.match(preload, /applyTaskWorktree/);
  assert.match(preload, /discardTaskWorktree/);
  assert.match(manager, /unresolvedWorktree/);
  assert.match(manager, /viewWorktreeDiff/);
  assert.match(html, /id="worktreePanel" hidden/);
  assert.doesNotMatch(html, /data-page-view="worktree"|Git 隔离与后台运行/);
});

test('tunnel supervision checks the real upstream route and refreshes proxy selection before recovery', () => {
  const tunnel = read('electron/services/tunnelService.js');
  const orchestrator = read('electron/services/runtimeOrchestrator.js');
  assert.match(tunnel, /tunnelProxyUrl/);
  assert.match(tunnel, /probeHttpProxy/);
  assert.match(tunnel, /probeDirect/);
  assert.match(tunnel, /requireUpstream/);
  assert.match(tunnel, /connectionStatus/);
  assert.match(orchestrator, /tunnel\.connectionStatus\(settings\)/);
  assert.match(orchestrator, /tunnelUpstreamReachable/);
  assert.match(orchestrator, /const failureThreshold = failureLayer === 'tunnel' \? 6 : 3/);
  assert.match(orchestrator, /if \(!failureLayer\) \{/);
  assert.match(orchestrator, /resolveProxy\(settings, \{ force: true \}\)/);
  assert.match(orchestrator, /暂不重启 Tunnel/);
  assert.match(orchestrator, /restartTunnel\(\{ automatic: true \}\)/);
});

test('chat transient recovery never force-reloads an active conversation', () => {
  const controller = read('electron/chatViewController.js');
  assert.match(controller, /function isChatConversationUrl/);
  assert.match(controller, /if \(isChatConversationUrl\(url\)\)/);
  assert.match(controller, /保留对话上下文并交由页面自身恢复，不自动重载/);
  assert.match(controller, /reloadIgnoringCache/);
});


test('tunnel diagnostics read only the local admin status and expose main channel identity', () => {
  const tunnel = read('electron/services/tunnelService.js');
  const orchestrator = read('electron/services/runtimeOrchestrator.js');
  const main = read('electron/main.js');
  const preload = read('electron/preload.js');
  assert.match(tunnel, /readLocalJson\(settings\.healthPort, '\/api\/status'\)/);
  assert.match(tunnel, /client_instance_id/);
  assert.match(tunnel, /mainChannelProbe/);
  assert.match(tunnel, /mainChannelReady/);
  assert.match(orchestrator, /tunnelDiagnostics: tunnelState/);
  assert.match(main, /chat:state/);
  assert.match(main, /chatController\?\.getState\(\)/);
  assert.match(preload, /onChatState/);
});
