import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Storage } from './storage.js';
import { AccountStore } from './account.js';
import { validateConfig, publicConfig } from './config.js';
import { Bridge } from './bridge.js';
import { queryMotd } from './motd.js';
import { rconCommand } from './rcon.js';
import { matchesPluginKey } from './plugin-chat.js';
import { queryAqqbot, safePlayer, safeQq } from './aqqbot.js';
import { bindAqqbotPlayer, clearAqqbotPlayer, clearAllAqqbot, clearSelectedAqqbot, moveAqqbotPlayer, moveSelectedAqqbot, searchAqqbotAdmin } from './aqqbot-admin.js';
import { ModuleManager } from './module-manager.js';

const HOST = '127.0.0.1';
const PORT = Number(process.env.MCQQ_PORT || 2556);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('MCQQ_PORT 必须是 1–65535');
const ORIGIN = `http://${HOST}:${PORT}`;
const store = new Storage();
const accounts = new AccountStore(store.dir);
const modules = new ModuleManager(store.dir, {
  audit: (kind, detail) => store.audit(kind, detail),
  services: {
    getRegistration: openid => store.state.users[openid]?.qq ?? null,
    queryPlayers: async qq => {
      const result = await queryAqqbot(store.config, rconCommand, 'qq', safeQq(qq));
      return result.qq === qq ? result.players.map(safePlayer) : [];
    },
    playerOwner: async player => (await queryAqqbot(store.config, rconCommand, 'player', safePlayer(player))).qq,
    reward: async (player, amount, template) => {
      safePlayer(player);
      if (!Number.isSafeInteger(amount) || amount < 1 || amount > 1000000) throw new Error('奖励金额无效');
      if (typeof template !== 'string' || template.length > 150 || /[\r\n\0]/.test(template) || !template.includes('${player}') || !template.includes('${amount}') || /\$\{(?!player\}|amount\})[^}]*\}/.test(template)) throw new Error('经济命令模板无效');
      const command = template.replaceAll('${player}', player).replaceAll('${amount}', String(amount));
      const output = String(await rconCommand(store.config, command)).trim();
      if (!output || /(?:失败|错误|无效|未知命令|不存在|没有权限|余额不足|failed|error|unknown command|no permission|usage)/i.test(output)) throw new Error('经济插件未确认发放：' + (output || '空响应'));
      return output.slice(0, 500);
    },
    testRewardTemplate: async template => {
      if (typeof template !== 'string' || !template.includes('${player}') || !template.includes('${amount}') || /[\r\n\0]/.test(template)) throw new Error('经济命令模板无效');
      const command = template.trim().split(/\s+/)[0];
      if (!/^[A-Za-z][A-Za-z0-9:_-]{0,63}$/.test(command)) throw new Error('经济命令名称格式无效');
      return String(await rconCommand(store.config, 'help ' + command)).slice(0, 1000);
    },
    runRcon: async command => {
      if (typeof command !== 'string' || !command.trim() || command.length > 1000 || /[\r\n\0]/.test(command)) throw new Error('RCON 命令格式无效');
      return String(await rconCommand(store.config, command.trim())).slice(0, 65536);
    },
    readConfig: () => structuredClone(store.config),
    writeConfig: input => {
      const next = validateConfig(input, store.config);
      store.saveConfig(next);
      bridge.restart();
      return structuredClone(next);
    },
    listRegistrations: () => store.listRegistrations(),
    createRegistration: (openid, qq, group = '') => { store.register(openid, qq, group, 'admin-created'); return store.listRegistrations().find(item => item.openid === openid); },
    updateRegistration: (currentOpenid, nextOpenid, qq) => { store.updateRegistration(currentOpenid, nextOpenid, qq); return store.listRegistrations().find(item => item.openid === nextOpenid); },
    deleteRegistration: openid => { store.unregister(openid); return true; },
    queryAqqbot: async (type, value) => queryAqqbot(store.config, rconCommand, type, value),
    bindPlayer: (qq, player) => withQqLocks([safeQq(qq)], () => bindAqqbotPlayer(store.config, rconCommand, qq, player)),
    unbindPlayer: (qq, player) => withQqLocks([safeQq(qq)], () => clearAqqbotPlayer(store.config, rconCommand, qq, player)),
    clearPlayers: qq => withQqLocks([safeQq(qq)], () => clearAllAqqbot(store.config, rconCommand, qq)),
    movePlayer: (oldQq, player, newQq, newPlayer = player) => withQqLocks([safeQq(oldQq), safeQq(newQq)], () => moveAqqbotPlayer(store.config, rconCommand, oldQq, player, newQq, newPlayer)),
    readStatus: () => ({ bot: bridge.status, pluginVersion: bridge.pluginVersion, pluginConnected: bridge.pluginExchange.lastSeen > Date.now() - 10000 }),
    readAqqbotDatabase: () => structuredClone(bridge.getAqqbotDatabase()),
    readServerLogs: () => structuredClone(bridge.getServerLogs()),
    notifyGroups: content => {
      if (typeof content !== 'string' || !content.trim() || content.length > 1800 || /\0/.test(content)) throw new Error('群通知内容格式无效');
      return bridge.sendToAllowedGroups(content, 'module-notify-error');
    }
  }
});
await modules.loadInstalled();
const clearingQq = new Set();
const bridge = new Bridge(store, { isQqClearing: qq => clearingQq.has(qq), modules });
bridge.start();
const sessions = new Map();
const attempts = new Map();
const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const assets = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/settings': ['settings.html', 'text/html; charset=utf-8'],
  '/templates': ['templates.html', 'text/html; charset=utf-8'],
  '/terminal': ['terminal.html', 'text/html; charset=utf-8'],
  '/player-logs': ['player-logs.html', 'text/html; charset=utf-8'],
  '/server-logs': ['server-logs.html', 'text/html; charset=utf-8'],
  '/users': ['users.html', 'text/html; charset=utf-8'],
  '/binding-admin': ['binding-admin.html', 'text/html; charset=utf-8'],
  '/aqqbot-database': ['aqqbot-database.html', 'text/html; charset=utf-8'],
  '/registrations': ['registrations.html', 'text/html; charset=utf-8'],
  '/guide': ['guide.html', 'text/html; charset=utf-8'],
  '/modules': ['modules.html', 'text/html; charset=utf-8'],
  '/MODULE-SPEC.md': ['../MODULE-SPEC.md', 'text/markdown; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/account.css': ['account.css', 'text/css; charset=utf-8'],
  '/pages.css': ['pages.css', 'text/css; charset=utf-8'],
  '/templates.css': ['templates.css', 'text/css; charset=utf-8'],
  '/server-logs.css': ['server-logs.css', 'text/css; charset=utf-8'],
  '/users.css': ['users.css', 'text/css; charset=utf-8'],
  '/binding-admin.css': ['binding-admin.css', 'text/css; charset=utf-8'],
  '/aqqbot-database.css': ['aqqbot-database.css', 'text/css; charset=utf-8'],
  '/registrations.css': ['registrations.css', 'text/css; charset=utf-8'],
  '/terminal.css': ['terminal.css', 'text/css; charset=utf-8'],
  '/player-logs.css': ['player-logs.css', 'text/css; charset=utf-8'],
  '/modules.css': ['modules.css', 'text/css; charset=utf-8'],
  '/common.js': ['common.js', 'text/javascript; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/settings.js': ['settings.js', 'text/javascript; charset=utf-8'],
  '/templates.js': ['templates.js', 'text/javascript; charset=utf-8'],
  '/server-logs.js': ['server-logs.js', 'text/javascript; charset=utf-8'],
  '/users.js': ['users.js', 'text/javascript; charset=utf-8'],
  '/binding-admin.js': ['binding-admin.js', 'text/javascript; charset=utf-8'],
  '/aqqbot-database.js': ['aqqbot-database.js', 'text/javascript; charset=utf-8'],
  '/registrations.js': ['registrations.js', 'text/javascript; charset=utf-8'],
  '/terminal.js': ['terminal.js', 'text/javascript; charset=utf-8'],
  '/player-logs.js': ['player-logs.js', 'text/javascript; charset=utf-8'],
  '/modules.js': ['modules.js', 'text/javascript; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml']
};

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function body(req, maxBytes = 64 * 1024) {
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new Error('只接受 JSON');
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > maxBytes) throw new Error('请求内容过大');
  }
  return JSON.parse(text || '{}');
}

function authorized(req) {
  const token = /(?:^|;\s*)session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie ?? '')?.[1];
  const expires = token && sessions.get(token);
  if (!expires || expires < Date.now()) { if (token) sessions.delete(token); return false; }
  sessions.set(token, Date.now() + 8 * 60 * 60 * 1000);
  return true;
}

function pluginAuthorized(req) {
  return matchesPluginKey(req.headers.authorization, store.config.pluginKey);
}

function loginSession(res) {
  const token = randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + 8 * 60 * 60 * 1000);
  res.setHeader('Set-Cookie', `session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);
}

async function withQqLocks(qqs, run) {
  const targets = [...new Set(qqs)];
  if (targets.some(qq => clearingQq.has(qq))) throw new Error('相关 QQ 的 AQQBot 管理操作正在进行，请稍后重试');
  for (const qq of targets) clearingQq.add(qq);
  try { return await run(); }
  finally { for (const qq of targets) clearingQq.delete(qq); }
}
const withQqClearLock = (qq, run) => withQqLocks([qq], run);

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  try {
    if (req.headers.host !== `${HOST}:${PORT}`) return json(res, 400, { error: '主机名不允许' });
    const requestUrl = new URL(req.url, ORIGIN);
    const path = requestUrl.pathname;
    if (req.method === 'GET' && assets[path]) {
      const [file, type] = assets[path];
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(await readFile(join(publicDir, file)));
      return;
    }
    if (req.method === 'GET' && path.startsWith('/modules/')) {
      const asset = modules.asset(path);
      if (!asset || asset.status === 404) return json(res, 404, { error: '模块页面不存在' });
      if (asset.status === 308) {
        res.writeHead(308, { Location: asset.location, 'Cache-Control': 'no-store' });
        return res.end();
      }
      try {
        res.writeHead(200, { 'Content-Type': asset.type, 'Cache-Control': 'no-store' });
        return res.end(await readFile(asset.path));
      } catch (error) {
        if (error.code === 'ENOENT') return json(res, 404, { error: '模块文件不存在' });
        throw error;
      }
    }
    if (!path.startsWith('/api/')) return json(res, 404, { error: '未找到' });
    if (path === '/api/plugin/exchange' && req.method === 'POST') {
      if (!pluginAuthorized(req)) return json(res, 401, { error: '插件 Key 无效' });
      return json(res, 200, bridge.exchangePluginChat(await body(req, 1024 * 1024)));
    }
    if (req.method !== 'GET' && req.headers.origin !== ORIGIN) return json(res, 403, { error: '请求来源不允许' });
    if (path === '/api/auth-state' && req.method === 'GET') {
      const authenticated = accounts.configured && authorized(req);
      return json(res, 200, { setupRequired: !accounts.configured, authenticated, username: authenticated ? accounts.username : null });
    }
    if (path === '/api/setup' && req.method === 'POST') {
      if (accounts.configured) return json(res, 409, { error: '管理员账户已经设置' });
      const input = await body(req);
      accounts.setup(input.username, input.password);
      loginSession(res);
      store.audit('account', '首次设置管理员账户');
      return json(res, 200, { ok: true, username: accounts.username });
    }
    if (path === '/api/login' && req.method === 'POST') {
      if (!accounts.configured) return json(res, 409, { error: '请先设置管理员账户' });
      const key = req.socket.remoteAddress;
      const recent = (attempts.get(key) ?? []).filter(t => t > Date.now() - 15 * 60 * 1000);
      if (recent.length >= 5) return json(res, 429, { error: '尝试过多，请 15 分钟后重试' });
      const input = await body(req);
      if (!accounts.verify(input.username, input.password)) {
        recent.push(Date.now()); attempts.set(key, recent);
        return json(res, 401, { error: '用户名或密码错误' });
      }
      attempts.delete(key);
      loginSession(res);
      return json(res, 200, { ok: true, username: accounts.username });
    }
    if (!authorized(req)) return json(res, 401, { error: '请先登录' });
    if (path === '/api/logout' && req.method === 'POST') {
      const token = /session=([a-f0-9]{64})/.exec(req.headers.cookie ?? '')?.[1];
      if (token) sessions.delete(token);
      res.setHeader('Set-Cookie', 'session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
      return json(res, 200, { ok: true });
    }
    if (path === '/api/account' && req.method === 'POST') {
      const input = await body(req);
      accounts.change(input.currentPassword, input.username, input.newPassword);
      sessions.clear();
      res.setHeader('Set-Cookie', 'session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
      store.audit('account', '管理员修改了用户名或密码');
      return json(res, 200, { ok: true, username: accounts.username });
    }
    if (path === '/api/config' && req.method === 'GET') return json(res, 200, publicConfig(store.config));
    if (path === '/api/config' && req.method === 'POST') {
      const next = validateConfig(await body(req), store.config);
      store.saveConfig(next);
      store.audit('config', '管理员更新了连接配置');
      bridge.restart();
      return json(res, 200, publicConfig(next));
    }
    if (path === '/api/templates' && req.method === 'GET') {
      const config = publicConfig(store.config);
      return json(res, 200, {
        qqToMcTemplate: config.qqToMcTemplate,
        mcToQqTemplate: config.mcToQqTemplate,
        presenceJoinTemplate: config.presenceJoinTemplate,
        presenceQuitTemplate: config.presenceQuitTemplate,
        serverOnlineTemplate: config.serverOnlineTemplate,
        serverOfflineTemplate: config.serverOfflineTemplate,
        presenceNotifyEnabled: config.presenceNotifyEnabled,
        serverStatusNotifyEnabled: config.serverStatusNotifyEnabled
      });
    }
    if (path === '/api/templates' && req.method === 'POST') {
      const input = await body(req);
      const fields = ['qqToMcTemplate', 'mcToQqTemplate', 'presenceJoinTemplate', 'presenceQuitTemplate', 'serverOnlineTemplate', 'serverOfflineTemplate'];
      const patch = {};
      for (const field of fields) {
        if (typeof input[field] !== 'string') return json(res, 400, { error: field + ' 格式无效' });
        patch[field] = input[field];
      }
      if (typeof input.presenceNotifyEnabled !== 'boolean' || typeof input.serverStatusNotifyEnabled !== 'boolean') return json(res, 400, { error: '通知开关格式无效' });
      patch.presenceNotifyEnabled = input.presenceNotifyEnabled;
      patch.serverStatusNotifyEnabled = input.serverStatusNotifyEnabled;
      const next = validateConfig({ ...store.config, ...patch }, store.config);
      store.saveConfig(next);
      store.audit('templates', '管理员更新了消息模板和服务器事件通知开关');
      return json(res, 200, { ok: true });
    }
    if (path === '/api/server-logs' && req.method === 'GET') return json(res, 200, bridge.getServerLogs());
    if (path === '/api/server-logs/setting' && req.method === 'POST') {
      const input = await body(req);
      if (!input || typeof input.enabled !== 'boolean') return json(res, 400, { error: '日志同步开关格式无效' });
      const next = validateConfig({ ...store.config, serverLogEnabled: input.enabled }, store.config);
      store.saveConfig(next);
      store.audit('server-log-setting', '管理员' + (input.enabled ? '开启' : '关闭') + '服务器日志同步');
      return json(res, 200, { enabled: next.serverLogEnabled });
    }
    if (path === '/api/test/plugin' && req.method === 'POST') return json(res, 200, {
      mode: '插件',
      keySet: Boolean(store.config.pluginKey),
      connected: bridge.pluginExchange.lastSeen > Date.now() - 10000,
      lastSeen: bridge.pluginExchange.lastSeen ? new Date(bridge.pluginExchange.lastSeen).toISOString() : null
    });
    if (path === '/api/status' && req.method === 'GET') return json(res, 200, { bot: bridge.status, registered: Object.keys(store.state.users).length, rconConfigured: Boolean(store.config.rconHost && store.config.rconPort && store.config.rconPassword), pluginConnected: bridge.pluginExchange.lastSeen > Date.now() - 10000, pluginVersion: bridge.pluginVersion });
    if (path === '/api/modules' && req.method === 'GET') return json(res, 200, modules.list());
    if (path === '/api/modules/install' && req.method === 'POST') {
      const installed = await modules.install(await body(req, 34 * 1024 * 1024), accounts.username);
      return json(res, 201, { ok: true, installed });
    }
    if (path === '/api/modules/toggle' && req.method === 'POST') {
      const input = await body(req);
      return json(res, 200, await modules.setEnabled(input.id, input.enabled, accounts.username));
    }
    if (modules.matchesApi(path)) {
      const input = req.method === 'GET' || req.method === 'HEAD' ? {} : await body(req, 1024 * 1024);
      const query = Object.fromEntries(requestUrl.searchParams);
      const result = await modules.dispatch(path, req.method, input, query, accounts.username);
      return json(res, result.status, result.body);
    }
    if (path === '/api/aqqbot/database' && req.method === 'GET') return json(res, 200, bridge.getAqqbotDatabase());
    if (path === '/api/bindings/search' && req.method === 'POST') {
      const input = await body(req);
      if (!input || typeof input !== 'object') return json(res, 400, { error: '请求格式无效' });
      return json(res, 200, await searchAqqbotAdmin(store, store.config, rconCommand, input.type, input.value));
    }
    if (path === '/api/bindings/create' && req.method === 'POST') {
      const input = await body(req);
      if (!input || typeof input !== 'object') return json(res, 400, { error: '请求格式无效' });
      const qq = safeQq(input.qq);
      const player = safePlayer(input.player);
      if (input.confirmPlayer !== player) return json(res, 400, { error: '请二次确认玩家名' });
      try {
        const result = await withQqLocks([qq], () => bindAqqbotPlayer(store.config, rconCommand, qq, player));
        store.audit('aqqbot-admin-bind', '管理员绑定 QQ ' + qq + ' 的玩家 ' + player);
        return json(res, 200, result);
      } catch (error) {
        return json(res, 409, { error: error.message });
      }
    }
    if (path === '/api/bindings/edit' && req.method === 'POST') {
      const input = await body(req);
      if (!input || typeof input !== 'object') return json(res, 400, { error: '请求格式无效' });
      const oldQq = safeQq(input.oldQq);
      const oldPlayer = safePlayer(input.oldPlayer);
      const newQq = safeQq(input.newQq);
      const newPlayer = safePlayer(input.newPlayer);
      if (input.confirmPlayer !== oldPlayer) return json(res, 400, { error: '请二次确认原玩家名' });
      try {
        const result = await withQqLocks([oldQq, newQq], () => moveAqqbotPlayer(store.config, rconCommand, oldQq, oldPlayer, newQq, newPlayer));
        store.audit('aqqbot-admin-edit', '管理员将 QQ ' + oldQq + ' 的玩家 ' + oldPlayer + ' 改为 QQ ' + newQq + ' 的玩家 ' + newPlayer);
        return json(res, 200, result);
      } catch (error) {
        return json(res, 409, { error: error.message });
      }
    }
    if (path === '/api/bindings/clear-selected' && req.method === 'POST') {
      const input = await body(req);
      if (!input || typeof input !== 'object') return json(res, 400, { error: '请求格式无效' });
      const qq = safeQq(input.qq);
      if (input.confirmQq !== qq) return json(res, 400, { error: '请二次确认 QQ 号' });
      try {
        const result = await withQqLocks([qq], () => clearSelectedAqqbot(store.config, rconCommand, qq, input.players));
        store.audit('aqqbot-admin-batch-delete', '管理员批量解绑 QQ ' + qq + ' 的 ' + result.completed.length + ' 个玩家');
        return json(res, 200, result);
      } catch (error) {
        const completed = error.completed ?? [];
        store.audit('aqqbot-admin-batch-partial', '管理员批量解绑 QQ ' + qq + ' 时停止；完成 ' + completed.length + ' 个');
        return json(res, 409, { error: error.message + '；已完成 ' + completed.length + ' 个，请刷新核对', completed });
      }
    }
    if (path === '/api/bindings/move-selected' && req.method === 'POST') {
      const input = await body(req);
      if (!input || typeof input !== 'object') return json(res, 400, { error: '请求格式无效' });
      const oldQq = safeQq(input.oldQq);
      const newQq = safeQq(input.newQq);
      if (input.confirmQq !== newQq) return json(res, 400, { error: '请二次确认目标 QQ 号' });
      try {
        const result = await withQqLocks([oldQq, newQq], () => moveSelectedAqqbot(store.config, rconCommand, oldQq, input.players, newQq));
        store.audit('aqqbot-admin-batch-move', '管理员将 ' + result.completed.length + ' 个玩家从 QQ ' + oldQq + ' 改绑到 QQ ' + newQq);
        return json(res, 200, result);
      } catch (error) {
        const completed = error.completed ?? [];
        store.audit('aqqbot-admin-batch-partial', '管理员批量改绑 QQ ' + oldQq + ' 时停止；完成 ' + completed.length + ' 个');
        return json(res, 409, { error: error.message + '；已完成 ' + completed.length + ' 个，请刷新核对', completed });
      }
    }
    if (path === '/api/aqqbot/query' && req.method === 'POST') {
      const input = await body(req);
      return json(res, 200, await queryAqqbot(store.config, rconCommand, input.type, input.value));
    }
    if (path === '/api/aqqbot/clear-player' && req.method === 'POST') {
      const input = await body(req);
      if (!input || typeof input !== 'object') return json(res, 400, { error: '请求格式无效' });
      const qq = safeQq(input.qq);
      const player = safePlayer(input.player);
      if (input.confirmPlayer !== player) return json(res, 400, { error: '请二次确认要解绑的玩家名' });
      try {
        const result = await withQqClearLock(qq, () => clearAqqbotPlayer(store.config, rconCommand, qq, player));
        store.audit('aqqbot-admin-unbind', '管理员解绑 QQ ' + qq + ' 的玩家 ' + player);
        return json(res, 200, result);
      } catch (error) {
        store.audit('aqqbot-admin-unbind-failed', '管理员解绑 QQ ' + qq + ' 的玩家 ' + player + ' 未得到完整确认');
        return json(res, 409, { error: error.message });
      }
    }
    if (path === '/api/aqqbot/clear-all' && req.method === 'POST') {
      const input = await body(req);
      if (!input || typeof input !== 'object') return json(res, 400, { error: '请求格式无效' });
      const qq = safeQq(input.qq);
      if (input.confirmQq !== qq) return json(res, 400, { error: '请二次确认要清空的 QQ 号' });
      try {
        const result = await withQqClearLock(qq, () => clearAllAqqbot(store.config, rconCommand, qq));
        store.audit('aqqbot-admin-clear', '管理员清空 QQ ' + qq + ' 的 ' + result.removed.length + ' 个 AQQBot 玩家绑定');
        return json(res, 200, result);
      } catch (error) {
        const removed = error.removed ?? [];
        store.audit('aqqbot-admin-clear-partial', '管理员清空 QQ ' + qq + ' 时停止，已确认解绑 ' + removed.length + ' 个玩家');
        return json(res, 409, { error: error.message + '；已确认解绑 ' + removed.length + ' 个，请刷新后核对', removed });
      }
    }
    if (path === '/api/registrations/delete-setting' && req.method === 'GET') {
      return json(res, 200, { enabled: store.config.registrationDeleteUnbindEnabled === true });
    }
    if (path === '/api/registrations/delete-setting' && req.method === 'POST') {
      const input = await body(req);
      if (!input || typeof input.enabled !== 'boolean') return json(res, 400, { error: '开关值无效' });
      store.saveConfig({ ...store.config, registrationDeleteUnbindEnabled: input.enabled });
      store.audit('registration-delete-setting', '管理员' + (input.enabled ? '开启' : '关闭') + '删除登记时解绑 AQQBot');
      return json(res, 200, { enabled: input.enabled });
    }
    if (path === '/api/registrations' && req.method === 'GET') return json(res, 200, store.listRegistrations());
    if (path === '/api/registrations/create' && req.method === 'POST') {
      const input = await body(req);
      if (!input || typeof input !== 'object') return json(res, 400, { error: '请求格式无效' });
      store.register(input.openid, input.qq, input.group ?? '', 'admin-created');
      bridge.pending.delete(input.openid);
      store.audit('registration-create', '管理员新建 QQ ' + input.qq + ' 与 OpenID ' + input.openid + ' 的登记');
      return json(res, 200, store.listRegistrations());
    }
    if (path === '/api/registrations/update' && req.method === 'POST') {
      const input = await body(req);
      store.updateRegistration(input.currentOpenid, input.openid, input.qq);
      bridge.pending.delete(input.currentOpenid);
      bridge.pending.delete(input.openid);
      store.audit('registration-edit', '管理员修改了 QQ 登记：OpenID ' + input.currentOpenid + ' → ' + input.openid);
      return json(res, 200, store.listRegistrations());
    }
    if (path === '/api/registrations/delete' && req.method === 'POST') {
      const input = await body(req);
      if (!input || typeof input.openid !== 'string' || !Object.hasOwn(store.state.users, input.openid)) return json(res, 400, { error: '登记记录不存在' });
      const user = store.state.users[input.openid];
      const qq = user.qq;
      const linked = store.config.registrationDeleteUnbindEnabled === true;
      let removed = [];
      if (linked) {
        if (input.confirmQq !== qq) return json(res, 400, { error: '请二次确认登记 QQ 号，才能联动解绑' });
        try {
          const result = await withQqClearLock(qq, async () => {
            const cleared = await clearAllAqqbot(store.config, rconCommand, qq);
            if (store.state.users[input.openid] !== user) throw new Error('QQ 登记在解绑期间已变更，请刷新');
            store.unregister(input.openid);
            return cleared;
          });
          removed = result.removed;
        } catch (error) {
          const done = error.removed ?? [];
          store.audit('registration-delete-partial', '删除登记 QQ ' + qq + ' 时 AQQBot 解绑未完成，登记已保留；确认解绑 ' + done.length + ' 个玩家');
          return json(res, 409, { error: error.message + '；QQ 登记未删除，已确认解绑 ' + done.length + ' 个玩家，请刷新核对', removed: done });
        }
      } else {
        store.unregister(input.openid);
      }
      bridge.pending.delete(input.openid);
      store.audit('registration-delete', '管理员删除 QQ ' + qq + ' 的登记：OpenID ' + input.openid + (linked ? '；同时确认解绑 AQQBot 玩家 ' + removed.length + ' 个' : '；未联动解绑 AQQBot'));
      return json(res, 200, store.listRegistrations());
    }

    if (path === '/api/audit' && req.method === 'GET') return json(res, 200, store.state.audit.slice(0, 50));
    if (path === '/api/player-logs' && req.method === 'GET') return json(res, 200, store.listPlayerLog());
    if (path === '/api/rcon/logs' && req.method === 'GET') return json(res, 200, store.listRconLog());
    if (path === '/api/rcon/command' && req.method === 'POST') {
      const input = await body(req);
      if (typeof input.command !== 'string') return json(res, 400, { error: '命令格式无效' });
      if (input.transport !== undefined && input.transport !== 'rcon') return json(res, 400, { error: '远程终端仅支持 RCON' });
      const command = input.command.trim();
      if (!command || command.length > 512 || /[\r\n\0]/.test(command)) return json(res, 400, { error: '命令格式无效：只能发送一行，最多 512 个字符' });
      let output;
      try {
        output = await rconCommand(store.config, command);
      } catch (error) {
        try { store.recordRconCommand(command, error.message, false, accounts.username, 'rcon'); } catch { store.audit('rcon-log-error', '终端失败记录保存异常'); }
        throw error;
      }
      try {
        store.recordRconCommand(command, output, true, accounts.username, 'rcon');
      } catch {
        store.audit('rcon-log-error', '终端命令已发送，但执行日志保存失败');
        return json(res, 200, { output, logSaved: false, transport: 'rcon' });
      }
      store.audit('rcon-terminal', '管理员从 RCON 终端发送了一条命令；详情见加密执行日志');
      return json(res, 200, { output, logSaved: true, transport: 'rcon' });
    }
    if (path === '/api/test/rcon' && req.method === 'POST') return json(res, 200, { output: await rconCommand(store.config, 'list') });
    if (path === '/api/test/motd' && req.method === 'POST') return json(res, 200, await queryMotd(store.config));
    return json(res, 404, { error: '未找到' });
  } catch (error) {
    const expected = /格式|无效|只接受|过大|配置|JSON|密码|用户名|账户|用户不存在|已被|已登记|尚未登记|登记记录不存在|模块|SHA-256|已存在|覆盖/.test(error.message);
    json(res, expected ? 400 : 502, { error: error.message });
  }
});

server.listen(PORT, HOST, () => console.log(`管理后台：http://${HOST}:${PORT}`));
process.on('SIGINT', () => { bridge.stop(); server.close(); });
process.on('SIGTERM', () => { bridge.stop(); server.close(); });
