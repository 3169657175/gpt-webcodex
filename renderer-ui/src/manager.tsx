import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';

type Tone = 'neutral' | 'positive' | 'warning' | 'danger';
type AssistantUserState = 'idle' | 'planning' | 'local_running' | 'testing' | 'building' | 'waiting_model' | 'waiting_user' | 'recovering' | 'quiet' | 'suspected_stall' | 'stalled' | 'generating' | 'completed' | 'failed' | 'stopped' | 'waiting' | string;
type CanonicalAssistantState = { userState: AssistantUserState; label: string; tone: Tone; message: string; detail: string; canStop: boolean; heartbeatAgeSeconds: number; taskId: string; runId: string; };
type RuntimeStatus = { runtimeRunning?: boolean; tunnelRunning?: boolean; connectionRunning?: boolean; };
type AppSettings = { workspace?: string; theme?: 'light' | 'dark' | string; autoStartServices?: boolean; keepRunningOnClose?: boolean; };
type Snapshot = { appVersion?: string; status?: RuntimeStatus; settings?: AppSettings; };
type WorkspaceHub = { activeWorkspace?: string; authorizedRoots?: string[]; workspaces?: unknown[]; };
type MemoryCapture = { processed?: number; discovered?: number; };
type MemoryStatus = { candidate_count?: number; source_counts?: Record<string, number>; auto_capture?: MemoryCapture; };
type TaskRuntime = { state?: { task_id?: string; run_id?: string }; };
type ManagerState = {
  page: string;
  snapshot: Snapshot | null;
  workspaceHub: WorkspaceHub | null;
  taskRuntime: TaskRuntime | null;
  memoryStatus: MemoryStatus | null;
  assistantState: CanonicalAssistantState;
};

declare global { interface Window { __MCP_MANAGER_STATE__?: ManagerState; } }

const emptyAssistantState: CanonicalAssistantState = { userState: 'idle', label: '空闲', tone: 'neutral', message: '', detail: '', canStop: false, heartbeatAgeSeconds: -1, taskId: '', runId: '' };
const emptyState: ManagerState = { page: 'status', snapshot: null, workspaceHub: null, taskRuntime: null, memoryStatus: null, assistantState: emptyAssistantState };

function useManagerState() {
  const [state, setState] = useState<ManagerState>(() => window.__MCP_MANAGER_STATE__ || emptyState);
  useEffect(() => {
    const listener = (event: Event) => setState((event as CustomEvent<ManagerState>).detail || emptyState);
    window.addEventListener('mcp-manager-state', listener);
    return () => window.removeEventListener('mcp-manager-state', listener);
  }, []);
  return state;
}

function Chip({ label, value, tone = 'neutral' }: { label: string; value: React.ReactNode; tone?: Tone }) {
  return <span className={`react-chip ${tone}`}><small>{label}</small><b>{value}</b></span>;
}

function StatusStrip({ state }: { state: ManagerState }) {
  const status = state.snapshot?.status || {};
  const task = state.assistantState || emptyAssistantState;
  const running = Boolean(status.runtimeRunning);
  const tunnel = Boolean(status.tunnelRunning);
  const upstream = Boolean(status.connectionRunning);
  return <div className="react-insight-strip">
    <div><b>统一运行状态</b><span>{task.message || '事件驱动更新 · 轮询仅作兜底'}</span></div>
    <div className="react-chip-row">
      <Chip label="本地工具" value={running ? '运行中' : '已停止'} tone={running ? 'positive' : 'neutral'} />
      <Chip label="连接通道" value={tunnel ? '已连接' : '未连接'} tone={tunnel ? 'positive' : 'neutral'} />
      <Chip label="上游" value={upstream ? '正常' : '等待'} tone={upstream ? 'positive' : 'warning'} />
      <Chip label="任务" value={task.label} tone={task.tone} />
    </div>
  </div>;
}

function WorkspaceStrip({ state }: { state: ManagerState }) {
  const hub = state.workspaceHub || {};
  const current = String(hub.activeWorkspace || state.snapshot?.settings?.workspace || '');
  const roots = Array.isArray(hub.authorizedRoots) ? hub.authorizedRoots.length : 0;
  const recent = Array.isArray(hub.workspaces) ? hub.workspaces.length : 0;
  return <div className="react-insight-strip"><div><b>工作区摘要</b><span>{current || '尚未选择主工作区'}</span></div><div className="react-chip-row"><Chip label="最近" value={recent} /><Chip label="额外授权" value={roots} /><Chip label="边界" value="本地受控" tone="positive" /></div></div>;
}

function MemoryStrip({ state }: { state: ManagerState }) {
  const memory = state.memoryStatus || {}; const sources = memory.source_counts || {}; const capture = memory.auto_capture || {};
  return <div className="react-insight-strip"><div><b>长期上下文 V3</b><span>模型负责总结写入 · 页面观察只发现候选</span></div><div className="react-chip-row"><Chip label="模型写入" value={Number(sources.model_summary || 0)} tone="positive" /><Chip label="待处理候选" value={Number(memory.candidate_count || 0)} tone={Number(memory.candidate_count || 0) ? 'warning' : 'neutral'} /><Chip label="本次扫描" value={Number(capture.processed || 0)} /><Chip label="发现" value={Number(capture.discovered || 0)} /></div></div>;
}

function SettingsStrip({ state }: { state: ManagerState }) {
  const settings = state.snapshot?.settings || {};
  return <div className="react-insight-strip"><div><b>管理中心</b><span>React + TypeScript + Vite 渐进迁移层</span></div><div className="react-chip-row"><Chip label="主题" value={settings.theme === 'light' ? '浅色' : '深色'} /><Chip label="自动启动" value={settings.autoStartServices ? '开启' : '关闭'} /><Chip label="后台运行" value={settings.keepRunningOnClose === false ? '关闭' : '开启'} /></div></div>;
}

function Portal({ selector, children }: { selector: string; children: React.ReactNode }) { const target = document.querySelector(selector); return target ? createPortal(children, target) : null; }
function App() { const state = useManagerState(); return <><Portal selector='[data-react-slot="status"]'><StatusStrip state={state} /></Portal><Portal selector='[data-react-slot="workspace"]'><WorkspaceStrip state={state} /></Portal><Portal selector='[data-react-slot="memory"]'><MemoryStrip state={state} /></Portal><Portal selector='[data-react-slot="settings"]'><SettingsStrip state={state} /></Portal></>; }
const host = document.getElementById('reactManagerRoot'); if (host) createRoot(host).render(<App />);
