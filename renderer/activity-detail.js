const api = window.activityDetail;
const $ = (selector) => document.querySelector(selector);
let current = { pinned: false };
const fields = [['当前状态','state'],['当前阶段','stage'],['已运行','elapsed'],['最近活动','lastSeen'],['本地进程','process'],['等待原因','waitReason'],['下一步','nextStep'],['反馈通道','channel'],['Task ID','taskId','mono'],['Run ID','runId','mono'],['Operation ID','operationId','mono'],['最近结果','lastResult']];

function render(payload = {}) {
  $('#status').textContent = payload.status || '等待状态';
  $('#capturedAt').textContent = payload.capturedAt || '状态读取';
  $('#diagnosis').textContent = payload.diagnosis || '当前没有发现异常。';
  const facts = $('#facts'); facts.replaceChildren();
  for (const [label, key, kind] of fields) {
    const raw = payload[key];
    if (raw == null || String(raw).trim() === '' || String(raw).trim() === '—') continue;
    const node = document.createElement('div'); node.className = `fact${kind ? ` ${kind}` : ''}`;
    const span = document.createElement('span'); span.textContent = label;
    const value = document.createElement('b'); value.textContent = String(raw);
    node.append(span, value); facts.append(node);
  }
  $('#commandBlock').hidden = !payload.command; $('#command').textContent = payload.command || '';
  const output = String(payload.output || '').trim(); $('#outputSection').hidden = !output; $('#output').textContent = output; $('#outputMeta').textContent = payload.outputMeta || '';
  const timeline = $('#timeline'); timeline.replaceChildren();
  for (const event of Array.isArray(payload.timeline) ? payload.timeline : []) {
    const item = document.createElement('li'); const title = document.createElement('b'); title.textContent = event.label || '状态更新'; item.append(title);
    if (event.detail) { const detail = document.createElement('div'); detail.textContent = event.detail; item.append(detail); }
    if (event.time) { const time = document.createElement('time'); time.textContent = event.time; item.append(time); }
    timeline.append(item);
  }
  $('#timelineSection').hidden = !timeline.children.length;
}
function renderState(state = {}) { current.pinned = Boolean(state.pinned); $('#pinButton').classList.toggle('active', current.pinned); $('#pinButton').textContent = current.pinned ? '已固定' : '固定'; }
api.onPayload((payload) => render(payload || {})); api.onState((state) => renderState(state || {})); document.body.addEventListener('mouseenter', () => api.setHover(true)); document.body.addEventListener('mouseleave', () => api.setHover(false)); $('#closeButton').onclick = () => api.close(); $('#pinButton').onclick = () => current.pinned ? api.unpin() : api.pin(); document.addEventListener('keydown', (event) => { if (event.key === 'Escape') api.close(); });
