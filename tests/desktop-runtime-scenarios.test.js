const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { LocalMcpClient } = require('../electron/services/localMcpClient');
const { TaskNotificationService } = require('../electron/services/taskNotificationService');

class FakeNotification {
  static instances = [];
  static isSupported() { return true; }
  constructor(options) {
    this.options = options;
    this.handlers = {};
    FakeNotification.instances.push(this);
  }
  on(name, handler) { this.handlers[name] = handler; }
  show() { this.shown = true; }
}

function makeWindow() {
  return {
    isDestroyed: () => false,
    isVisible: () => true,
    isFocused: () => true,
    setProgressBar: () => {}
  };
}

function eventLine(event) {
  return `id: ${event.event_id}\nevent: task-event\ndata: ${JSON.stringify(event)}\n\n`;
}

test('real SSE client into notification service ignores start/model-wait and notifies one fast completion', async (t) => {
  FakeNotification.instances.length = 0;
  const workspace = 'C:\\scenario';
  const baseState = {
    task_id: 'task-1', run_id: 'run-1', objective: '快速任务', created_at: '2026-08-12T13:00:00Z'
  };
  const events = [
    { event_id: 1, type: 'task.started', workspace, state: { ...baseState, status: 'active', lifecycle_state: 'running' } },
    { event_id: 2, type: 'task.waiting_model', workspace, state: { ...baseState, status: 'waiting', lifecycle_state: 'waiting_model', current_step: 'Waiting for model' } },
    { event_id: 3, type: 'task.completed', workspace, state: { ...baseState, status: 'completed', lifecycle_state: 'completed', current_step: 'Completed' } }
  ];
  const server = http.createServer((req, res) => {
    if (req.url !== '/__control/events' || req.headers.authorization !== 'Bearer test-token') {
      res.writeHead(401); res.end(); return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    events.forEach((event) => res.write(eventLine(event)));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const client = new LocalMcpClient({ port: server.address().port, token: 'test-token' });
  const service = new TaskNotificationService({
    getSettings: () => ({
      taskNotifications: true,
      taskNotificationOnlyWhenUnfocused: false,
      taskNotificationSound: false,
      taskNotificationMinSeconds: 0
    }),
    getWorkspace: () => workspace,
    readTaskState: () => null,
    getChatWindow: () => makeWindow(),
    getTray: () => null,
    NotificationClass: FakeNotification,
    now: () => Date.parse('2026-08-12T13:00:01Z')
  });

  let unsubscribe = () => {};
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('场景事件超时')), 1500);
    unsubscribe = client.subscribeTaskEvents((event) => {
      service.acceptTaskEvent(event);
      if (event.event_id === 3) {
        clearTimeout(timer);
        setTimeout(resolve, 20);
      }
    }, { onError: reject });
  });
  unsubscribe();
  assert.equal(FakeNotification.instances.length, 1);
  assert.match(FakeNotification.instances[0].options.title, /任务已完成/);
  assert.equal(service.getDiagnostics().filter((item) => item.shown).length, 1);
});

test('one hundred canonical terminal events produce one notification per distinct run', () => {
  FakeNotification.instances.length = 0;
  const service = new TaskNotificationService({
    getSettings: () => ({ taskNotifications: true, taskNotificationOnlyWhenUnfocused: false, taskNotificationSound: false, taskNotificationMinSeconds: 0 }),
    getWorkspace: () => 'C:\\stress',
    readTaskState: () => null,
    getChatWindow: () => makeWindow(),
    getTray: () => null,
    NotificationClass: FakeNotification,
    now: () => Date.parse('2026-08-12T13:00:01Z')
  });
  for (let index = 1; index <= 100; index += 1) {
    service.acceptTaskEvent({
      event_id: index,
      type: 'task.completed',
      workspace: 'C:\\stress',
      state: {
        task_id: `task-${index}`,
        run_id: `run-${index}`,
        status: 'completed',
        lifecycle_state: 'completed',
        objective: `任务 ${index}`,
        created_at: '2026-08-12T13:00:00Z'
      }
    });
  }
  assert.equal(FakeNotification.instances.length, 100);
  service.acceptTaskEvent({
    event_id: 100,
    type: 'task.completed',
    workspace: 'C:\\stress',
    state: { task_id: 'task-100', run_id: 'run-100', status: 'completed', lifecycle_state: 'completed' }
  });
  assert.equal(FakeNotification.instances.length, 100);
});
