import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
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
    if (!existsSync(this.keyFile)) writeFileSync(this.keyFile, randomBytes(32), { flag: 'wx', mode: 0o600 });
    this.key = readFileSync(this.keyFile);
    if (this.key.length !== 32) throw new Error('加密密钥文件格式无效');
    this.state = readJson(this.stateFile, { users: {}, bindings: {}, audit: [] });
    this.state.users ??= {};
    this.state.bindings ??= {};
    this.state.audit ??= [];
    for (const [openid, binding] of Object.entries(this.state.bindings)) {
      this.state.bindings[openid] = Array.isArray(binding) ? binding : binding?.player ? [binding] : [];
    }
    this.config = this.loadConfig();
    this.rconLog = this.loadRconLog();
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

  recordRconCommand(command, output, success, username) {
    const result = String(output ?? '');
    const entry = {
      at: new Date().toISOString(),
      username,
      command,
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

  qqOwner(qq, exceptOpenid = '') {
    return Object.entries(this.state.users).find(([openid, user]) => openid !== exceptOpenid && (user.qq ?? (/^\d{5,20}$/.test(openid) ? openid : '')) === qq)?.[0] ?? null;
  }

  register(openid, qq, group) {
    if (!openid || !/^[A-Za-z0-9_-]{5,128}$/.test(openid)) throw new Error('OpenID 格式无效');
    if (!/^\d{5,20}$/.test(qq)) throw new Error('QQ 号格式无效');
    if (this.qqOwner(qq, openid)) throw new Error('QQ 号已被其他用户登记');
    if (this.state.users[openid]) throw new Error('此 OpenID 已登记');
    this.state.users[openid] = { qq, group, registeredAt: new Date().toISOString(), source: 'self-confirmed' };
    this.saveState();
  }

  recordBinding(openid, player, status) {
    if (!this.state.users[openid]) throw new Error('用户尚未登记');
    if (!/^[A-Za-z0-9_]{3,16}$/.test(player)) throw new Error('玩家名格式无效');
    this.assertPlayerAvailable(openid, player);
    const bindings = this.state.bindings[openid] ??= [];
    bindings.push({ player, status, updatedAt: new Date().toISOString() });
    this.saveState();
  }

  assertPlayerAvailable(openid, player) {
    const owner = Object.entries(this.state.bindings).find(([id, bindings]) =>
      id !== openid && bindings.some(item => item.player.toLowerCase() === player.toLowerCase()));
    if (owner) throw new Error('这个玩家已绑定其他 QQ');
    const bindings = this.getBindings(openid);
    if (bindings.some(item => item.player.toLowerCase() === player.toLowerCase())) throw new Error('这个玩家已经绑定');
  }

  getBindings(openid) { return this.state.bindings[openid] ?? []; }

  removeBinding(openid, player) {
    const bindings = this.getBindings(openid);
    const index = bindings.findIndex(item => item.player.toLowerCase() === player.toLowerCase());
    if (index < 0) throw new Error('该玩家不属于当前 QQ');
    bindings.splice(index, 1);
    if (!bindings.length) delete this.state.bindings[openid];
    this.saveState();
  }

  unregister(openid) {
    if (!this.state.users[openid]) throw new Error('用户尚未登记');
    if (this.getBindings(openid).length) throw new Error('请先用 /mcunbind <玩家名> 解绑所有玩家');
    delete this.state.users[openid];
    delete this.state.bindings[openid];
    this.saveState();
  }

  listUsers() {
    return Object.entries(this.state.users).map(([openid, user]) => ({
      openid,
      qq: user.qq ?? (/^\d{5,20}$/.test(openid) ? openid : ''),
      group: user.group ?? '',
      registeredAt: user.registeredAt,
      source: user.source ?? '旧版记录',
      bindings: this.getBindings(openid)
    }));
  }

  updateUser(openid, qq, players) {
    const user = this.state.users[openid];
    if (!user) throw new Error('用户不存在');
    if (!/^\d{5,20}$/.test(qq)) throw new Error('QQ 号格式无效');
    if (this.qqOwner(qq, openid)) throw new Error('QQ 号已被其他用户登记');
    const names = typeof players === 'string' ? players.split(/[\s,，]+/).filter(Boolean) : players;
    if (!Array.isArray(names) || names.some(name => !/^[A-Za-z0-9_]{3,16}$/.test(name))) throw new Error('玩家名格式无效');
    if (new Set(names.map(name => name.toLowerCase())).size !== names.length) throw new Error('玩家名重复');
    for (const name of names) {
      if (Object.entries(this.state.bindings).some(([id, bindings]) => id !== openid && bindings.some(item => item.player.toLowerCase() === name.toLowerCase()))) throw new Error(`玩家 ${name} 已绑定其他 QQ`);
    }
    const oldQq = user.qq ?? (/^\d{5,20}$/.test(openid) ? openid : '');
    const before = this.getBindings(openid);
    user.qq = qq;
    user.updatedAt = new Date().toISOString();
    const next = names.map(name => {
      const previous = before.find(item => item.player.toLowerCase() === name.toLowerCase());
      return previous && oldQq === qq ? previous : { player: name, status: '管理员修改资料，需核对服务器', updatedAt: user.updatedAt };
    });
    if (oldQq !== qq) for (const item of next) item.status = '管理员修改 QQ，需核对服务器';
    if (next.length) this.state.bindings[openid] = next;
    else delete this.state.bindings[openid];
    this.saveState();
  }

  deleteUser(openid) {
    if (!this.state.users[openid]) throw new Error('用户不存在');
    delete this.state.users[openid];
    delete this.state.bindings[openid];
    this.saveState();
  }

  audit(kind, detail) {
    this.state.audit.unshift({ at: new Date().toISOString(), kind, detail });
    this.state.audit = this.state.audit.slice(0, 200);
    this.saveState();
  }
}
