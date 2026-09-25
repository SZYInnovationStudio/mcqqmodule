import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

const DATA_DIR = join(process.cwd(), 'data');

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
    this.rconLogFile = join(dir, 'rcon-log.enc');
    this.playerLogFile = join(dir, 'player-log.enc');
    if (!existsSync(this.keyFile)) writeFileSync(this.keyFile, randomBytes(32), { flag: 'wx', mode: 0o600 });
    this.key = readFileSync(this.keyFile);
    if (this.key.length !== 32) throw new Error('加密密钥文件格式无效');
    this.state = readJson(this.stateFile, { version: 8, users: {}, audit: [] });
    this.state.users ??= {};
    this.state.audit ??= [];
    if (this.state.version !== 8 || 'bindings' in this.state || Object.values(this.state.users).some(user => user.source === 'aqqbot-import')) {
      if (existsSync(this.stateFile)) copyFileSync(this.stateFile, this.stateFile + '.before-v8-' + new Date().toISOString().replace(/[:.]/g, '-'));
      delete this.state.bindings;
      for (const [openid, user] of Object.entries(this.state.users)) if (user.source === 'aqqbot-import') delete this.state.users[openid];
      this.state.version = 8;
      this.saveState();
    }
    this.config = this.loadConfig();
    const legacyChatKeys = ['chatTransport', 'mcsmBaseUrl', 'mcsmApiKey', 'mcsmDaemonId', 'mcsmInstanceUuid'];
    if (legacyChatKeys.some(key => key in this.config)) {
      if (existsSync(this.configFile)) copyFileSync(this.configFile, this.configFile + '.before-plugin-only-' + new Date().toISOString().replace(/[:.]/g, '-'));
      for (const key of legacyChatKeys) delete this.config[key];
      this.saveConfig(this.config);
    }
    this.rconLog = this.loadRconLog();
    this.playerLog = this.loadPlayerLog();
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

  loadRconLog() {
    if (!existsSync(this.rconLogFile)) return [];
    const payload = JSON.parse(readFileSync(this.rconLogFile, 'utf8'));
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(payload.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
    const entries = JSON.parse(Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64')), decipher.final()]).toString('utf8'));
    if (!Array.isArray(entries)) throw new Error('RCON 日志格式无效');
    return entries;
  }

  recordRconCommand(command, output, success, username, transport = 'rcon') {
    const result = String(output ?? '');
    const entry = {
      at: new Date().toISOString(),
      username,
      command,
      transport,
      success,
      output: result.length > 8192 ? `${result.slice(0, 8192)}\n（后续内容已截断）` : result
    };
    const next = [entry, ...this.rconLog].slice(0, 100);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(next), 'utf8'), cipher.final()]);
    atomicWrite(this.rconLogFile, JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }));
    this.rconLog = next;
    return entry;
  }

  listRconLog() { return this.rconLog.slice(0, 100); }

  loadPlayerLog() {
    if (!existsSync(this.playerLogFile)) return [];
    const payload = JSON.parse(readFileSync(this.playerLogFile, 'utf8'));
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(payload.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
    const entries = JSON.parse(Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64')), decipher.final()]).toString('utf8'));
    if (!Array.isArray(entries)) throw new Error('玩家命令日志格式无效');
    return entries;
  }

  recordPlayerCommand({ openid, group, qq, command, category, status, result }) {
    const entry = {
      at: new Date().toISOString(),
      openid,
      group,
      qq: qq ?? '',
      command: String(command).slice(0, 512),
      category,
      status,
      result: String(result ?? '').slice(0, 2000)
    };
    const next = [entry, ...this.playerLog].slice(0, 200);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(next), 'utf8'), cipher.final()]);
    atomicWrite(this.playerLogFile, JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }));
    this.playerLog = next;
    return entry;
  }

  listPlayerLog() { return this.playerLog.slice(0, 200); }

  listRegistrations() {
    return Object.entries(this.state.users)
      .filter(([, user]) => user && typeof user.qq === 'string')
      .map(([openid, user]) => ({
        openid,
        qq: user.qq,
        group: user.group ?? '',
        registeredAt: user.registeredAt ?? ''
      }))
      .sort((a, b) => b.registeredAt.localeCompare(a.registeredAt) || a.qq.localeCompare(b.qq));
  }

  qqOwner(qq, exceptOpenid = '') {
    return Object.entries(this.state.users).find(([openid, user]) => openid !== exceptOpenid && user.qq === qq)?.[0] ?? null;
  }

  register(openid, qq, group, source = 'self-confirmed') {
    if (!openid || !/^[A-Za-z0-9_-]{5,128}$/.test(openid) || openid === '__proto__' || openid === 'constructor') throw new Error('OpenID 格式无效');
    if (!/^\d{5,20}$/.test(qq)) throw new Error('QQ 号格式无效');
    if (this.qqOwner(qq, openid)) throw new Error('QQ 号已被其他用户登记');
    if (Object.hasOwn(this.state.users, openid)) throw new Error('此 OpenID 已登记');
    if (typeof group !== 'string' || (group && !/^[A-Za-z0-9_-]{5,128}$/.test(group))) throw new Error('登记群 OpenID 格式无效');
    if (source !== 'self-confirmed' && source !== 'admin-created') throw new Error('登记来源无效');
    this.state.users[openid] = { qq, group, registeredAt: new Date().toISOString(), source };
    this.saveState();
  }

  updateRegistration(currentOpenid, nextOpenid, qq) {
    if (typeof currentOpenid !== 'string' || !Object.hasOwn(this.state.users, currentOpenid)) throw new Error('登记记录不存在');
    if (typeof nextOpenid !== 'string' || !/^[A-Za-z0-9_-]{5,128}$/.test(nextOpenid) || nextOpenid === '__proto__' || nextOpenid === 'constructor') throw new Error('OpenID 格式无效');
    if (typeof qq !== 'string' || !/^\d{5,20}$/.test(qq)) throw new Error('QQ 号格式无效');
    if (nextOpenid !== currentOpenid && Object.hasOwn(this.state.users, nextOpenid)) throw new Error('此 OpenID 已登记');
    if (this.qqOwner(qq, currentOpenid)) throw new Error('QQ 号已被其他用户登记');
    const current = this.state.users[currentOpenid];
    if (nextOpenid === currentOpenid && current.qq === qq) return;
    delete this.state.users[currentOpenid];
    this.state.users[nextOpenid] = { ...current, qq, source: 'admin-edited' };
    this.saveState();
  }

  unregister(openid) {
    if (typeof openid !== 'string' || !Object.hasOwn(this.state.users, openid)) throw new Error('用户尚未登记');
    delete this.state.users[openid];
    this.saveState();
  }

  audit(kind, detail) {
    this.state.audit.unshift({ at: new Date().toISOString(), kind, detail });
    this.state.audit = this.state.audit.slice(0, 200);
    this.saveState();
  }
}
