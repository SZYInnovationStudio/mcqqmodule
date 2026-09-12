import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Storage } from './storage.js';
import { AccountStore } from './account.js';
import { validateConfig, publicConfig } from './config.js';
import { Bridge } from './bridge.js';
import { McsmClient } from './mcsm.js';
import { queryMotd } from './motd.js';
import { rconCommand } from './rcon.js';

const HOST = '127.0.0.1';
const PORT = 2556;
const ORIGIN = `http://${HOST}:${PORT}`;
const store = new Storage();
const accounts = new AccountStore(store.dir);
const bridge = new Bridge(store);
bridge.start();
const sessions = new Map();
const attempts = new Map();
const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const assets = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/settings': ['settings.html', 'text/html; charset=utf-8'],
  '/users': ['users.html', 'text/html; charset=utf-8'],
  '/guide': ['guide.html', 'text/html; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/account.css': ['account.css', 'text/css; charset=utf-8'],
  '/pages.css': ['pages.css', 'text/css; charset=utf-8'],
  '/users.css': ['users.css', 'text/css; charset=utf-8'],
  '/common.js': ['common.js', 'text/javascript; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/settings.js': ['settings.js', 'text/javascript; charset=utf-8'],
  '/users.js': ['users.js', 'text/javascript; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml']
};

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function body(req) {
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new Error('只接受 JSON');
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 64 * 1024) throw new Error('请求内容过大');
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

function loginSession(res) {
  const token = randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + 8 * 60 * 60 * 1000);
  res.setHeader('Set-Cookie', `session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  try {
    if (req.headers.host !== `${HOST}:${PORT}`) return json(res, 400, { error: '主机名不允许' });
    const path = new URL(req.url, ORIGIN).pathname;
    if (req.method === 'GET' && assets[path]) {
      const [file, type] = assets[path];
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(await readFile(join(publicDir, file)));
      return;
    }
    if (!path.startsWith('/api/')) return json(res, 404, { error: '未找到' });
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
    if (path === '/api/status' && req.method === 'GET') return json(res, 200, { bot: bridge.status, registered: Object.keys(store.state.users).length, bindings: Object.keys(store.state.bindings).length, mcsmConfigured: Boolean(store.config.mcsmUrl && store.config.mcsmApiKey && store.config.daemonId && store.config.instanceId), rconConfigured: Boolean(store.config.rconHost && store.config.rconPort && store.config.rconPassword) });
    if (path === '/api/bindings' && req.method === 'GET') return json(res, 200, store.listUsers().filter(user => user.binding).map(user => ({ qq: user.qq, ...user.binding })));
    if (path === '/api/users' && req.method === 'GET') return json(res, 200, store.listUsers());
    if (path === '/api/users' && req.method === 'POST') {
      const input = await body(req);
      const openid = String(input.openid ?? '');
      if (!/^[A-Za-z0-9_-]{5,128}$/.test(openid)) return json(res, 400, { error: 'OpenID 格式无效' });
      store.updateUser(openid, String(input.qq ?? '').trim(), String(input.player ?? '').trim());
      store.audit('admin-update', `管理员修改了 OpenID ${openid} 的本地记录`);
      return json(res, 200, { ok: true });
    }
    if (path === '/api/users/delete' && req.method === 'POST') {
      const input = await body(req);
      const openid = String(input.openid ?? '');
      if (!/^[A-Za-z0-9_-]{5,128}$/.test(openid)) return json(res, 400, { error: 'OpenID 格式无效' });
      store.deleteUser(openid);
      store.audit('admin-delete', `管理员删除了 OpenID ${openid} 的本地记录；服务器 AQQBot 未自动解绑`);
      return json(res, 200, { ok: true });
    }
    if (path === '/api/audit' && req.method === 'GET') return json(res, 200, store.state.audit.slice(0, 50));
    if (path === '/api/test/mcsm' && req.method === 'POST') {
      const data = await new McsmClient(store.config).instance();
      return json(res, 200, { status: data.status, name: data.config?.nickname ?? '', players: data.info?.currentPlayers ?? null });
    }
    if (path === '/api/test/rcon' && req.method === 'POST') return json(res, 200, { output: await rconCommand(store.config, 'list') });
    if (path === '/api/test/motd' && req.method === 'POST') return json(res, 200, await queryMotd(store.config));
    return json(res, 404, { error: '未找到' });
  } catch (error) {
    const expected = /格式|无效|只接受|过大|配置|JSON|密码|用户名|账户|用户不存在|已被/.test(error.message);
    json(res, expected ? 400 : 502, { error: error.message });
  }
});

server.listen(PORT, HOST, () => console.log(`管理后台：http://${HOST}:${PORT}`));
process.on('SIGINT', () => { bridge.stop(); server.close(); });
process.on('SIGTERM', () => { bridge.stop(); server.close(); });
