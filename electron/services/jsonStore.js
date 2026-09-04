const fs = require('node:fs');
const path = require('node:path');

const RETRYABLE_CODES = new Set(['EBUSY', 'EACCES', 'EPERM']);

function ensureParent(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function backupFile(file) {
  return `${file}.bak`;
}

function parseJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readJson(file, fallback = {}) {
  try {
    return parseJsonFile(file);
  } catch (primaryError) {
    try {
      return parseJsonFile(backupFile(file));
    } catch {
      return typeof fallback === 'function' ? fallback(primaryError) : fallback;
    }
  }
}

function sleepSync(milliseconds) {
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, milliseconds);
}

function retrySync(action, attempts = 5) {
  let lastError;
  for (let index = 0; index < attempts; index += 1) {
    try {
      return action();
    } catch (error) {
      lastError = error;
      if (!RETRYABLE_CODES.has(error?.code) || index === attempts - 1) throw error;
      sleepSync(25 * (index + 1));
    }
  }
  throw lastError;
}

function writeBufferAtomic(file, buffer, isValidBackup = null) {
  ensureParent(file);
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  const backup = backupFile(file);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'w', 0o600);
    fs.writeFileSync(descriptor, buffer);
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }

  try {
    if (fs.existsSync(file)) {
      try {
        if (typeof isValidBackup === 'function') {
          if (isValidBackup(file)) retrySync(() => fs.copyFileSync(file, backup));
        } else {
          retrySync(() => fs.copyFileSync(file, backup));
        }
      } catch {
        // Keep the last known-good backup when the primary file is unreadable.
      }
    }
    retrySync(() => fs.renameSync(temporary, file));
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch { /* ignore cleanup failure */ }
    throw error;
  }
}

function writeJsonAtomic(file, value) {
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  writeBufferAtomic(file, payload, (existing) => {
    parseJsonFile(existing);
    return true;
  });
}

function updateJsonAtomic(file, updater, fallback = {}) {
  const current = readJson(file, fallback);
  const next = updater(current);
  writeJsonAtomic(file, next);
  return next;
}

module.exports = { readJson, writeJsonAtomic, updateJsonAtomic, writeBufferAtomic, ensureParent, backupFile };
