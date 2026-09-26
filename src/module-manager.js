import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const FORMAT = 'bridge-module-v2';
const LEGACY_FORMAT = 'szydmc-module-v1';
const SUPPORTED_FORMATS = new Set([FORMAT, LEGACY_FORMAT]);
const SERVER_VERSION = '8.8.2';
const MAX_FILES = 500;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const SAFE_ID = /^[a-z][a-z0-9-]{2,47}$/;
const SAFE_VERSION = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/;
const LEGACY_FILE = /^(?:public\/[A-Za-z0-9][A-Za-z0-9._/-]*|server\.mjs)$/;
const V2_FILE = /^(?:public|server)\/[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'], ['.mjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'], ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp']
]);

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validatePath(path, format) {
  const pattern = format === LEGACY_FORMAT ? LEGACY_FILE : V2_FILE;
  if (typeof path !== 'string' || path.length > 200 || !pattern.test(path) || path.includes('//')) throw new Error('模块文件路径无效');
  const parts = path.split('/');
  if (parts.some(part => part === '.' || part === '..')) throw new Error('模块文件路径无效');
  if (path.startsWith('public/') && !MIME.has(extname(path).toLowerCase())) throw new Error('模块包含不允许的公开文件类型');
  if (path.startsWith('server/') && !['.js', '.mjs', '.json'].includes(extname(path).toLowerCase())) throw new Error('服务端源码只允许 JS、MJS 和 JSON');
  return path;
}

function validateManifest(value, format = FORMAT) {
  if (!plainObject(value)) throw new Error('模块清单格式无效');
  const manifest = {
    id: String(value.id ?? ''),
    name: String(value.name ?? ''),
    version: String(value.version ?? ''),
    description: String(value.description ?? ''),
    page: String(value.page ?? 'index.html'),
    entry: value.entry === undefined ? '' : String(value.entry),
    format
  };
  manifest.commands = value.commands === undefined ? [] : value.commands;
  manifest.permissions = value.permissions === undefined ? ['*'] : value.permissions;
  if (!SAFE_ID.test(manifest.id)) throw new Error('模块 ID 格式无效');
  if (!manifest.name || manifest.name.length > 64) throw new Error('模块名称格式无效');
  if (!SAFE_VERSION.test(manifest.version)) throw new Error('模块版本格式无效');
  if (manifest.description.length > 240) throw new Error('模块简介过长');
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*\.html$/.test(manifest.page) || manifest.page.includes('..') || manifest.page.includes('//')) throw new Error('模块页面路径无效');
  if (format === LEGACY_FORMAT && manifest.entry && manifest.entry !== 'server.mjs') throw new Error('旧版模块服务端入口只能是 server.mjs');
  if (format === FORMAT && manifest.entry && (!/^server\/[A-Za-z0-9][A-Za-z0-9._/-]*\.mjs$/.test(manifest.entry) || manifest.entry.includes('..') || manifest.entry.includes('//'))) throw new Error('模块服务端入口必须是 server/ 下的 MJS 文件');
  if (!Array.isArray(manifest.commands) || manifest.commands.length > 8 || manifest.commands.some(command => typeof command !== 'string' || !/^[a-z\p{Script=Han}]{1,16}$/u.test(command)) || new Set(manifest.commands).size !== manifest.commands.length) throw new Error('模块命令格式无效');
  if (!Array.isArray(manifest.permissions) || !manifest.permissions.length || manifest.permissions.length > 32 || manifest.permissions.some(item => typeof item !== 'string' || !/^(?:\*|legacy|[a-z][a-z0-9.-]{1,47})$/.test(item))) throw new Error('模块权限声明格式无效');
  if (manifest.commands.length && !manifest.entry) throw new Error('模块命令需要 server.mjs');
  return manifest;
}

function higherVersion(next, current) {
  const a = next.split(/[.-]/).slice(0, 3).map(Number);
  const b = current.split(/[.-]/).slice(0, 3).map(Number);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

export function validateModuleBundle(bundle) {
  if (!plainObject(bundle) || !SUPPORTED_FORMATS.has(bundle.format)) throw new Error('模块包格式无效');
  const manifest = validateManifest(bundle.manifest, bundle.format);
  if (!Array.isArray(bundle.files) || bundle.files.length < 1 || bundle.files.length > MAX_FILES) throw new Error('模块文件数量无效');
  const seen = new Set();
  const files = [];
  let total = 0;
  for (const item of bundle.files) {
    if (!plainObject(item)) throw new Error('模块文件记录无效');
    const path = validatePath(item.path, bundle.format);
    if (seen.has(path)) throw new Error('模块文件路径重复');
    seen.add(path);
    if (typeof item.content !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(item.content)) throw new Error('模块文件内容无效');
    const data = Buffer.from(item.content, 'base64');
    if (data.length > MAX_FILE_BYTES) throw new Error('单个模块文件超过 1 MiB');
    total += data.length;
    if (total > MAX_TOTAL_BYTES) throw new Error('模块解压内容超过 32 MiB');
    const actual = createHash('sha256').update(data).digest('hex');
    if (typeof item.sha256 !== 'string' || actual !== item.sha256.toLowerCase()) throw new Error('模块文件 SHA-256 校验失败');
    files.push({ path, data });
  }
  if (!seen.has(`public/${manifest.page}`)) throw new Error('模块清单指定的页面不存在');
  if (manifest.entry && !seen.has(manifest.entry)) throw new Error('模块清单指定的服务端入口不存在');
  return { manifest, files, total };
}

export class ModuleManager {
  constructor(dataDir, options = {}) {
    this.root = join(dataDir, 'modules');
    this.audit = options.audit ?? (() => {});
    this.modules = new Map();
    this.errors = [];
    this.services = options.services ?? {};
    this.installing = new Set();
    this.inFlight = new Map();
  }

  async loadInstalled() {
    await mkdir(this.root, { recursive: true });
    const entries = await readdir(this.root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !SAFE_ID.test(entry.name)) continue;
      try { await this.loadOne(entry.name); }
      catch (error) { this.errors.push({ id: entry.name, error: error.message }); }
    }
  }

  async loadOne(id) {
    const dir = join(this.root, id);
    const saved = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
    const format = SUPPORTED_FORMATS.has(saved.format) ? saved.format : LEGACY_FORMAT;
    const manifest = validateManifest(saved, format);
    if (manifest.id !== id) throw new Error('模块目录与清单 ID 不一致');
    let handler = null;
    if (manifest.entry) {
      const loaded = await import(`${pathToFileURL(join(dir, manifest.entry)).href}?loaded=${Date.now()}-${randomBytes(4).toString('hex')}`);
      if (typeof loaded.handle !== 'function') throw new Error('server.mjs 必须导出 handle 函数');
      handler = loaded.handle;
    }
    const record = { ...manifest, installedAt: String(saved.installedAt ?? ''), enabled: saved.enabled !== false, dir, handler, pageUrl: `/modules/${id}/` };
    this.modules.set(id, record);
    return record;
  }

  list() {
    return {
      format: FORMAT,
      legacyFormat: LEGACY_FORMAT,
      supportedFormats: [...SUPPORTED_FORMATS],
      fullPermissions: true,
      addOnly: false,
      serverVersion: SERVER_VERSION,
      modules: [...this.modules.values()].map(({ handler, dir, ...item }) => ({ ...item, hasServer: Boolean(handler) })),
      errors: this.errors.slice()
    };
  }

  async install(bundle, username = 'admin') {
    const parsed = validateModuleBundle(bundle);
    const { id } = parsed.manifest;
    const target = join(this.root, id);
    const previous = this.modules.get(id);
    if (this.installing.has(id)) throw new Error('模块正在安装或升级');
    if ((this.inFlight.get(id) ?? 0) > 0) throw new Error('模块正在处理请求，请稍后升级');
    if (existsSync(target) && !previous) throw new Error('模块目录已存在但无法加载，请先检查目录');
    if (previous && !higherVersion(parsed.manifest.version, previous.version)) throw new Error('模块升级版本必须高于已安装版本');
    this.installing.add(id);
    const staging = join(this.root, `.incoming-${id}-${randomBytes(6).toString('hex')}`);
    const backup = join(this.root, `.backup-${id}-${Date.now()}-${randomBytes(3).toString('hex')}`);
    try {
      await mkdir(staging, { recursive: true });
      for (const file of parsed.files) {
        const destination = join(staging, ...file.path.split('/'));
        await mkdir(join(destination, '..'), { recursive: true });
        await writeFile(destination, file.data, { flag: 'wx', mode: 0o600 });
      }
      const installedAt = new Date().toISOString();
      const reserved = new Set(['qqbind', 'qqunbind', 'mcbind', 'mcunbind', 'mcunallbind', 'mymc', 'motd', 'list', 'tps', 'status', '登记', '解除登记', '绑定', '解绑', '全部解绑', '我的mc', '状态', '在线', '性能', '桥接状态']);
      for (const command of parsed.manifest.commands) {
        if (reserved.has(command.toLowerCase()) || [...this.modules.values()].some(item => item.id !== id && item.commands.includes(command))) throw new Error('模块命令已被占用');
      }
      if (previous && existsSync(join(target, 'state.json'))) await copyFile(join(target, 'state.json'), join(staging, 'state.json'));
      await writeFile(join(staging, 'manifest.json'), JSON.stringify({ ...parsed.manifest, installedAt: previous?.installedAt ?? installedAt, enabled: previous?.enabled ?? true }, null, 2), { flag: 'wx', mode: 0o600 });
      if (previous) await rename(target, backup);
      try {
        await rename(staging, target);
        const record = await this.loadOne(id);
        this.audit(previous ? 'module-upgrade' : 'module-install', `管理员 ${username} ${previous ? '升级' : '安装'}模块 ${id}@${record.version}`);
        return this.list().modules.find(item => item.id === id);
      } catch (error) {
        await rm(target, { recursive: true, force: true });
        if (previous) {
          await rename(backup, target);
          this.modules.set(id, previous);
        }
        throw error;
      }
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    } finally {
      this.installing.delete(id);
    }
  }

  async setEnabled(id, enabled, username = 'admin') {
    const module = this.modules.get(id);
    if (!module || typeof enabled !== 'boolean') throw new Error('模块开关格式无效');
    if (this.installing.has(id)) throw new Error('模块正在升级');
    const path = join(module.dir, 'manifest.json');
    const saved = JSON.parse(await readFile(path, 'utf8'));
    const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(temp, JSON.stringify({ ...saved, enabled }), { mode: 0o600 });
    await rename(temp, path);
    module.enabled = enabled;
    this.audit('module-toggle', `管理员 ${username} ${enabled ? '启用' : '关闭'}模块 ${id}`);
    return this.list().modules.find(item => item.id === id);
  }

  commandFor(message) {
    const name = /^\/([^\s/]+)(?:\s|$)/u.exec(message)?.[1]?.toLowerCase();
    if (!name) return null;
    return [...this.modules.values()].find(item => item.commands.some(command => command.toLowerCase() === name)) ?? null;
  }

  async handleCommand(module, request) {
    if (this.installing.has(module.id)) return `${module.name}正在升级，请稍后重试。`;
    module = this.modules.get(module.id) ?? module;
    if (!module.enabled) return `${module.name}当前已关闭。`;
    if (!module.handler) throw new Error('模块命令缺少处理程序');
    this.inFlight.set(module.id, (this.inFlight.get(module.id) ?? 0) + 1);
    let result;
    try { result = await module.handler({ method: 'COMMAND', path: 'command', ...request }, this.makeApi(module)); }
    finally { this.inFlight.set(module.id, this.inFlight.get(module.id) - 1); }
    if (!plainObject(result) || typeof result.reply !== 'string' || result.reply.length > 1800) throw new Error('模块命令回复格式无效');
    return result.reply;
  }

  asset(pathname) {
    const match = /^\/modules\/([a-z][a-z0-9-]{2,47})(?:\/(.*))?$/.exec(pathname);
    if (!match) return null;
    const module = this.modules.get(match[1]);
    if (!module) return { status: 404 };
    if (match[2] === undefined || match[2] === '') {
      if (!pathname.endsWith('/')) return { status: 308, location: module.pageUrl };
      return this.publicAsset(module, module.page);
    }
    return this.publicAsset(module, match[2]);
  }

  publicAsset(module, relative) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(relative) || relative.includes('..') || relative.includes('//')) return { status: 404 };
    const type = MIME.get(extname(relative).toLowerCase());
    if (!type) return { status: 404 };
    return { status: 200, path: join(module.dir, 'public', ...relative.split('/')), type };
  }

  matchesApi(pathname) {
    return /^\/api\/modules\/[a-z][a-z0-9-]{2,47}(?:\/|$)/.test(pathname);
  }

  async dispatch(pathname, method, input, query, username = 'admin') {
    const match = /^\/api\/modules\/([a-z][a-z0-9-]{2,47})(?:\/(.*))?$/.exec(pathname);
    const module = match && this.modules.get(match[1]);
    if (!module || !module.handler) return { status: 404, body: { error: '模块接口不存在' } };
    if (this.installing.has(module.id)) return { status: 503, body: { error: '模块正在升级，请稍后重试' } };
    const api = this.makeApi(module);
    this.inFlight.set(module.id, (this.inFlight.get(module.id) ?? 0) + 1);
    let result;
    try { result = await module.handler({ method, path: match[2] ?? '', input, query, username, enabled: module.enabled, moduleVersion: module.version }, api); }
    finally { this.inFlight.set(module.id, this.inFlight.get(module.id) - 1); }
    if (!plainObject(result)) throw new Error('模块接口返回格式无效');
    const status = Number(result.status ?? 200);
    if (!Number.isInteger(status) || status < 200 || status > 599) throw new Error('模块接口状态码无效');
    const responseText = JSON.stringify(result.body ?? {});
    if (responseText === undefined || Buffer.byteLength(responseText) > MAX_FILE_BYTES) throw new Error('模块接口返回超过 1 MiB');
    return { status, body: result.body ?? {} };
  }

  makeApi(module) {
    const statePath = join(module.dir, 'state.json');
    const host = Object.freeze({ ...this.services });
    return {
      serverVersion: SERVER_VERSION,
      moduleVersion: module.version,
      moduleFormat: module.format,
      permissions: module.permissions.slice(),
      host,
      enabled: () => module.enabled,
      getRegistration: openid => this.services.getRegistration?.(openid) ?? null,
      queryPlayers: qq => this.services.queryPlayers?.(qq),
      playerOwner: player => this.services.playerOwner?.(player),
      reward: (player, amount, template) => this.services.reward?.(player, amount, template),
      testRewardTemplate: template => this.services.testRewardTemplate?.(template),
      async readState() {
        try { return JSON.parse(await readFile(statePath, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
      },
      async writeState(value) {
        const text = JSON.stringify(value);
        if (text === undefined || Buffer.byteLength(text) > MAX_FILE_BYTES) throw new Error('模块状态超过 1 MiB');
        const temp = `${statePath}.${randomBytes(6).toString('hex')}.tmp`;
        await writeFile(temp, text, { mode: 0o600 });
        await rename(temp, statePath);
      },
      audit: detail => this.audit('module-action', `${module.id}: ${String(detail).slice(0, 200)}`)
    };
  }
}

export const moduleFormat = FORMAT;
