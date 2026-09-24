const { spawn } = require('node:child_process');
const { TextDecoder } = require('node:util');

const ENCODING_PROBE_BYTES = 64;

function hasUtf16Pattern(buffer, littleEndian) {
  const pairs = Math.floor(Math.min(buffer.length, 256) / 2);
  if (pairs < 2) return false;
  let expectedNuls = 0;
  let unexpectedNuls = 0;
  for (let index = 0; index < pairs * 2; index += 2) {
    const even = buffer[index];
    const odd = buffer[index + 1];
    if (littleEndian) {
      if (odd === 0) expectedNuls += 1;
      if (even === 0) unexpectedNuls += 1;
    } else {
      if (even === 0) expectedNuls += 1;
      if (odd === 0) unexpectedNuls += 1;
    }
  }
  return expectedNuls >= Math.max(2, Math.floor(pairs / 3))
    && unexpectedNuls <= Math.max(1, Math.floor(pairs / 8));
}

function isStrictUtf8(buffer) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

function detectEncoding(buffer, { final = false } = {}) {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return 'utf-8';
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return 'utf-16le';
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) return 'utf-16be';
  if (hasUtf16Pattern(buffer, true)) return 'utf-16le';
  if (hasUtf16Pattern(buffer, false)) return 'utf-16be';

  // A short non-ASCII prefix can be either an incomplete UTF-8 sequence or a
  // complete GBK code unit. Keep a small probe until more bytes/newline/final.
  if (!final && buffer.length < ENCODING_PROBE_BYTES && !buffer.includes(0x0a) && !buffer.includes(0x0d)) {
    const allAscii = buffer.every((value) => value < 0x80);
    if (!allAscii) return '';
  }
  return isStrictUtf8(buffer) ? 'utf-8' : 'gbk';
}

function createOutputDecoder() {
  let decoder = null;
  let encoding = '';
  let probe = Buffer.alloc(0);
  let pendingCR = false;
  let ended = false;

  function normalize(text, final = false) {
    let value = `${pendingCR ? '\r' : ''}${text || ''}`;
    pendingCR = false;
    if (!final && value.endsWith('\r')) {
      value = value.slice(0, -1);
      pendingCR = true;
    }
    return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  }

  function initialize(final = false) {
    if (decoder) return true;
    encoding = detectEncoding(probe, { final });
    if (!encoding) return false;
    decoder = new TextDecoder(encoding, { fatal: false, ignoreBOM: false });
    return true;
  }

  return {
    write(chunk) {
      if (ended || !chunk || chunk.length === 0) return '';
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (!decoder) {
        probe = Buffer.concat([probe, data]);
        if (!initialize(false)) return '';
        const buffered = probe;
        probe = Buffer.alloc(0);
        return normalize(decoder.decode(buffered, { stream: true }), false);
      }
      return normalize(decoder.decode(data, { stream: true }), false);
    },
    end() {
      if (ended) return '';
      ended = true;
      if (!initialize(true)) return normalize('', true);
      let text = '';
      if (probe.length) {
        text += decoder.decode(probe, { stream: true });
        probe = Buffer.alloc(0);
      }
      text += decoder.decode();
      return normalize(text, true);
    },
    get encoding() { return encoding; }
  };
}

function run(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const { timeoutMs = 0, onOutput, allowFailure, ...spawnOptions } = options;
    const child = spawn(command, args, {
      windowsHide: true,
      shell: false,
      ...spawnOptions
    });
    let stdout = '';
    let stderr = '';
    const stdoutDecoder = createOutputDecoder();
    const stderrDecoder = createOutputDecoder();
    const appendOutput = (stream, text) => {
      if (!text) return;
      if (stream === 'stdout') stdout += text;
      else stderr += text;
      onOutput?.(stream, text);
    };
    child.stdout?.on('data', (chunk) => {
      appendOutput('stdout', stdoutDecoder.write(chunk));
    });
    child.stderr?.on('data', (chunk) => {
      appendOutput('stderr', stderrDecoder.write(chunk));
    });
    let timeout;
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        child.kill();
        reject(Object.assign(new Error(`命令执行超时（${timeoutMs} ms）`), { code: -1, stdout, stderr, timedOut: true }));
      }, timeoutMs);
      timeout.unref?.();
    }
    child.on('error', reject);
    child.on('close', (code) => {
      if (timeout) clearTimeout(timeout);
      appendOutput('stdout', stdoutDecoder.end());
      appendOutput('stderr', stderrDecoder.end());
      const result = { code: code ?? -1, stdout, stderr };
      if (code === 0 || allowFailure) resolve(result);
      else reject(Object.assign(new Error(stderr.trim() || stdout.trim() || `${command} 执行失败（${code}）`), result));
    });
  });
}

module.exports = { run, createOutputDecoder, detectEncoding };
