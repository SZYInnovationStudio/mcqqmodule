import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const DATA_DIR = join(process.cwd(), 'data');
const KEY_FILE = join(DATA_DIR, 'master.key');
const STATE_FILE = join(DATA_DIR, 'state.json');
const CONFIG_FILE = join(DATA_DIR, 'config.enc');

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function atomicWrite(path, content) {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, content, { mode: 0o600 });
  renameSync(temp, path);
}

export class Storage {
  constructor(dir = DATA_DIR) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.keyFile = join(dir, 'master.key');
    this.stateFile = join(dir, 'state.json');
    this.configFile = join(dir, 'config.enc');
    if (!existsSync(this.keyFile)) writeFileSync(this.keyFile, randomBytes(32), { flag: 'wx', mode: 0o600 });
    this.key = readFileSync(this.keyFile);
    if (this.key.length !== 32) throw new Error('加密密钥文件格式无效');
    this.state = readJson(this.stateFile, { users: {}, bindings: {}, audit: [] });
    this.config = this.loadConfig();
  }

  loadConfig() {
    if (!existsSync(this.configFile)) return {};
    const payload = JSON.parse(readFileSync(this.configFile, 'utf8'));
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(payload.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64')), decipher.final()]).toString('utf8'));
  }

  saveConfig(next) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(next), 'utf8'), cipher.final()]);
    atomicWrite(this.configFile, JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }));
    this.config = next;
  }

  saveState() {
    atomicWrite(this.stateFile, JSON.stringify(this.state, null, 2));
  }

  register(qq) {
    if (!/^\d{5,20}$/.test(qq)) throw new Error('QQ 号格式无效');
    if (!this.state.users[qq]) {
      this.state.users[qq] = { registeredAt: new Date().toISOString() };
      this.saveState();
      return true;
    }
    return false;
  }

  recordBinding(qq, player, status) {
    this.state.bindings[qq] = { player, status, updatedAt: new Date().toISOString() };
    this.saveState();
  }

  audit(kind, detail) {
    this.state.audit.unshift({ at: new Date().toISOString(), kind, detail });
    this.state.audit = this.state.audit.slice(0, 200);
    this.saveState();
  }
}
