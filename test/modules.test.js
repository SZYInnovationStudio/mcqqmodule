import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModuleManager, validateModuleBundle } from '../src/module-manager.js';

function file(path, text, hash = null) {
  const data = Buffer.from(text);
  return { path, content: data.toString('base64'), sha256: hash ?? createHash('sha256').update(data).digest('hex') };
}

function bundle(id = 'sample-addon') {
  return {
    format: 'szydmc-module-v1',
    manifest: { id, name: '示例增量功能', version: '1.0.0', description: '不修改核心的测试模块', page: 'index.html', entry: 'server.mjs' },
    files: [
      file('public/index.html', '<!doctype html><title>新增页面</title>'),
      file('server.mjs', `export async function handle(request, api) {
        if (request.method !== 'POST' || request.path !== 'count') return { status: 404, body: { error: '未找到' } };
        const state = await api.readState(); state.count = (state.count || 0) + 1; await api.writeState(state);
        api.audit('计数加一'); return { status: 200, body: { count: state.count, value: request.input.value } };
      }`)
    ]
  };
}

test('模块安装、同 ID 升级保留状态，并在重启后加载', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcqq-modules-'));
  const audit = [];
  try {
    const manager = new ModuleManager(dir, { audit: (...args) => audit.push(args) });
    await manager.loadInstalled();
    const installed = await manager.install(bundle(), 'admin123');
    assert.equal(installed.id, 'sample-addon');
    assert.deepEqual(installed.permissions, ['*']);
    assert.equal(installed.pageUrl, '/modules/sample-addon/');
    assert.equal(manager.asset('/modules/sample-addon').status, 308);
    const asset = manager.asset('/modules/sample-addon/');
    assert.equal(asset.type, 'text/html; charset=utf-8');
    assert.match(await readFile(asset.path, 'utf8'), /新增页面/);
    const first = await manager.dispatch('/api/modules/sample-addon/count', 'POST', { value: 'ok' }, {}, 'admin123');
    assert.deepEqual(first, { status: 200, body: { count: 1, value: 'ok' } });
    await assert.rejects(manager.install(bundle(), 'admin123'), /版本必须高于/);
    assert.equal(audit.some(([, detail]) => detail.includes('sample-addon@1.0.0')), true);

    const upgrade = bundle();
    upgrade.manifest.version = '1.1.0';
    upgrade.files[0] = file('public/index.html', '<!doctype html><title>升级页面</title>');
    const upgraded = await manager.install(upgrade, 'admin123');
    assert.equal(upgraded.version, '1.1.0');
    assert.match(await readFile(manager.asset('/modules/sample-addon/').path, 'utf8'), /升级页面/);
    const afterUpgrade = await manager.dispatch('/api/modules/sample-addon/count', 'POST', { value: 'upgrade' }, {}, 'admin123');
    assert.equal(afterUpgrade.body.count, 2);

    const broken = bundle();
    broken.manifest.version = '1.2.0';
    broken.files[1] = file('server.mjs', 'export function handle( {');
    await assert.rejects(manager.install(broken, 'admin123'));
    assert.equal(manager.list().modules[0].version, '1.1.0');

    const restarted = new ModuleManager(dir);
    await restarted.loadInstalled();
    const second = await restarted.dispatch('/api/modules/sample-addon/count', 'POST', { value: 'again' }, {}, 'admin123');
    assert.equal(second.body.count, 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('模块包拒绝路径穿越、核心文件和错误 SHA-256', () => {
  const wrongHash = bundle('wrong-hash');
  wrongHash.files[0].sha256 = '0'.repeat(64);
  assert.throws(() => validateModuleBundle(wrongHash), /SHA-256/);

  const traversal = bundle('bad-path');
  traversal.files[0] = file('public/../server.js', 'bad');
  assert.throws(() => validateModuleBundle(traversal), /路径无效/);

  const core = bundle('core-write');
  core.files[0] = file('src/bridge.js', 'bad');
  assert.throws(() => validateModuleBundle(core), /路径无效/);
});

test('通用 v2 模块支持多服务端文件和完整宿主接口，旧格式仍兼容', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcqq-modules-v2-'));
  try {
    const manager = new ModuleManager(dir, { services: {
      runRcon: async command => 'RCON:' + command,
      listRegistrations: () => [{ openid: 'OPENID_123', qq: '36000000' }]
    } });
    await manager.loadInstalled();
    const next = {
      format: 'bridge-module-v2',
      manifest: { id: 'generic-addon', name: '通用模块', version: '1.0.0', page: 'index.html', entry: 'server/main.mjs', permissions: ['*'] },
      files: [
        file('public/index.html', '<!doctype html><title>通用模块</title>'),
        file('server/helper.mjs', "export const command = 'list';"),
        file('server/main.mjs', "import { command } from './helper.mjs'; export async function handle(request, api) { return { body: { output: await api.host.runRcon(command), registrations: api.host.listRegistrations(), format: api.moduleFormat, permissions: api.permissions } }; }")
      ]
    };
    const installed = await manager.install(next);
    assert.equal(installed.format, 'bridge-module-v2');
    assert.deepEqual(installed.permissions, ['*']);
    const result = await manager.dispatch('/api/modules/generic-addon/check', 'GET', {}, {});
    assert.equal(result.body.output, 'RCON:list');
    assert.equal(result.body.format, 'bridge-module-v2');
    assert.deepEqual(result.body.registrations, [{ openid: 'OPENID_123', qq: '36000000' }]);
    assert.equal(manager.list().supportedFormats.includes('szydmc-module-v1'), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
