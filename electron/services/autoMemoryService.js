'use strict';

function memoryResult(response) {
  if (response && response.ok === false) throw new Error(String(response.error || '本地记忆处理失败'));
  return response?.result ?? response ?? {};
}

class AutoMemoryService {
  constructor({ memoryControl, log, now = () => new Date().toISOString() } = {}) {
    if (typeof memoryControl !== 'function') throw new TypeError('memoryControl is required');
    this.memoryControl = memoryControl;
    this.log = log || { info() {}, warn() {}, error() {} };
    this.now = now;
    this.state = { observing: true, processed: 0, remembered: 0, candidates: 0, skipped: 0, errors: 0, last_status: 'idle', last_at: '', last_mode: '', last_scope: '', last_type: '' };
  }
  getStatus() { return { ...this.state }; }
  async ingestTurn(turn = {}) {
    const userText = String(turn.userText ?? turn.user_text ?? '').slice(0, 6000);
    const assistantText = String(turn.assistantText ?? turn.assistant_text ?? '').slice(0, 8000);
    if (!userText.trim()) return { status: 'skipped_empty' };
    this.state.processed += 1;
    try {
      const response = await this.memoryControl({ action: 'ingest', user_text: userText, assistant_text: assistantText, conversation_id: String(turn.conversationId ?? turn.conversation_id ?? '').slice(0, 160), turn_id: String(turn.turnId ?? turn.turn_id ?? '').slice(0, 160), source: 'auto_chat' });
      const result = memoryResult(response);
      const status = String(result.status || 'unknown');
      this.state.last_status = status; this.state.last_at = this.now(); this.state.last_mode = String(result.mode || ''); this.state.last_scope = String(result.scope || result.memory?.scope || ''); this.state.last_type = String(result.memory_type || result.memory?.memory_type || '');
      if (status === 'remembered') this.state.remembered += 1;
      else if (status === 'candidate' || status === 'conflict') this.state.candidates += 1;
      else if (status.startsWith('skipped_') || status === 'duplicate' || status === 'rejected_secret') this.state.skipped += 1;
      this.log.info('自动记忆处理完成', { status, mode: this.state.last_mode, scope: this.state.last_scope, memoryType: this.state.last_type });
      return result;
    } catch (error) {
      this.state.errors += 1; this.state.last_status = 'error'; this.state.last_at = this.now();
      this.log.warn('自动记忆暂时不可用；不会影响 ChatGPT 或本地工具', { code: String(error?.code || ''), name: String(error?.name || 'Error') });
      return { status: 'error', error: String(error?.message || 'auto memory unavailable') };
    }
  }
}
module.exports = { AutoMemoryService, memoryResult };
