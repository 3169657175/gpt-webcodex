const fs = require('node:fs');
const { safeStorage } = require('electron');
const { secretsFile } = require('../paths');
const { ensureParent, backupFile, writeBufferAtomic } = require('./jsonStore');

class SecretStore {
  _readAll() {
    if (!safeStorage.isEncryptionAvailable()) return {};
    const tryDecrypt = (filePath) => {
      try {
        const encrypted = fs.readFileSync(filePath);
        return JSON.parse(safeStorage.decryptString(encrypted));
      } catch {
        return null;
      }
    };
    const primary = tryDecrypt(secretsFile());
    if (primary && typeof primary === 'object') return primary;
    const backup = tryDecrypt(backupFile(secretsFile()));
    if (backup && typeof backup === 'object') return backup;
    return {};
  }

  _writeAll(value) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Windows 安全存储当前不可用，无法保存密钥。');
    }
    const encrypted = safeStorage.encryptString(JSON.stringify(value));
    writeBufferAtomic(secretsFile(), encrypted, (existing) => {
      try {
        const raw = fs.readFileSync(existing);
        return JSON.parse(safeStorage.decryptString(raw)) !== null;
      } catch {
        return false;
      }
    });
  }

  set(name, value) {
    const text = String(value || '').trim();
    if (!text) throw new Error('密钥不能为空。');
    const all = this._readAll();
    all[name] = text;
    this._writeAll(all);
  }

  get(name) {
    return this._readAll()[name] || '';
  }

  remove(name) {
    const all = this._readAll();
    delete all[name];
    this._writeAll(all);
  }

  status() {
    const all = this._readAll();
    return {
      runtimeApiKey: Boolean(all.runtimeApiKey),
      mcpAuthToken: Boolean(all.mcpAuthToken)
    };
  }
}

module.exports = { SecretStore };
