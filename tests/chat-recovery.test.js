const test = require('node:test');
const assert = require('node:assert/strict');

const { isTransientChatLoadError, isChatConversationUrl } = require('../electron/chatViewController');

test('chat recovery classifies transient stream and network load errors', () => {
  assert.equal(isTransientChatLoadError('ERR_HTTP2_PROTOCOL_ERROR'), true);
  assert.equal(isTransientChatLoadError('ERR_INCOMPLETE_CHUNKED_ENCODING'), true);
  assert.equal(isTransientChatLoadError('ERR_CONNECTION_RESET'), true);
  assert.equal(isTransientChatLoadError('ERR_CONNECTION_CLOSED'), true);
  assert.equal(isTransientChatLoadError('ERR_TIMED_OUT'), true);
  assert.equal(isTransientChatLoadError('ERR_NETWORK_CHANGED'), true);
});

test('chat recovery does not retry permanent or application-level errors', () => {
  assert.equal(isTransientChatLoadError('ERR_NAME_NOT_RESOLVED'), false);
  assert.equal(isTransientChatLoadError('ERR_CERT_DATE_INVALID'), false);
  assert.equal(isTransientChatLoadError('连接已中断。正在等待完整回复'), false);
});

test('chat recovery recognizes concrete ChatGPT conversation URLs', () => {
  assert.equal(isChatConversationUrl('https://chatgpt.com/c/12345678-abcd'), true);
  assert.equal(isChatConversationUrl('https://chatgpt.com/g/gpt-name/c/12345678-abcd'), true);
  assert.equal(isChatConversationUrl('https://chatgpt.com/'), false);
  assert.equal(isChatConversationUrl('https://chatgpt.com/#settings/Connectors'), false);
  assert.equal(isChatConversationUrl('https://openai.com/c/12345678-abcd'), false);
});
