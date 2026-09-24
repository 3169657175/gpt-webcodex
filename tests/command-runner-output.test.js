const test = require('node:test');
const assert = require('node:assert/strict');
const { createOutputDecoder, detectEncoding } = require('../electron/services/commandRunner');

test('command output decoder preserves split UTF-8 characters and normalizes CRLF', () => {
  const decoder = createOutputDecoder();
  const raw = Buffer.from('中文\r\n完成', 'utf8');
  const first = decoder.write(raw.subarray(0, 2));
  const second = decoder.write(raw.subarray(2, 5));
  const third = decoder.write(raw.subarray(5));
  const text = first + second + third + decoder.end();
  assert.equal(text, '中文\n完成');
  assert.equal(decoder.encoding, 'utf-8');
});

test('command output decoder handles UTF-16LE BOM output', () => {
  const decoder = createOutputDecoder();
  const raw = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('中文\r\n完成', 'utf16le')]);
  const text = decoder.write(raw.subarray(0, 5)) + decoder.write(raw.subarray(5)) + decoder.end();
  assert.equal(text, '中文\n完成');
  assert.equal(decoder.encoding, 'utf-16le');
});

test('command output decoder handles GBK bytes using Windows compatible decoder', () => {
  // “中文成功” in GBK/CP936.
  const raw = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xb3, 0xc9, 0xb9, 0xa6]);
  assert.equal(detectEncoding(raw, { final: true }), 'gbk');
  const decoder = createOutputDecoder();
  const text = decoder.write(raw.subarray(0, 3)) + decoder.write(raw.subarray(3)) + decoder.end();
  assert.equal(text, '中文成功');
  assert.equal(decoder.encoding, 'gbk');
});

test('command output decoder keeps CRLF normalization correct across chunks', () => {
  const decoder = createOutputDecoder();
  const text = decoder.write(Buffer.from('one\r'))
    + decoder.write(Buffer.from('\ntwo\rthree'))
    + decoder.end();
  assert.equal(text, 'one\ntwo\nthree');
});
