import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { Storage } from '../src/storage.js';

test('QQ/OpenID 后台列表从当前登记状态读取并随登记、解除更新', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcqq-registrations-'));
  try {
    const store = new Storage(dir);
    assert.deepEqual(store.listRegistrations(), []);
    store.register('USER_OPENID_123', '36000000', 'GROUP_OPENID_123');
    store.register('OTHER_OPENID_123', '36000001', 'GROUP_OPENID_456');
    const rows = store.listRegistrations();
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.find(row => row.qq === '36000000'), {
      openid: 'USER_OPENID_123',
      qq: '36000000',
      group: 'GROUP_OPENID_123',
      registeredAt: store.state.users.USER_OPENID_123.registeredAt
    });
    assert.equal(rows[0].bindings, undefined);
    store.unregister('USER_OPENID_123');
    assert.deepEqual(store.listRegistrations().map(row => row.qq), ['36000001']);
    assert.deepEqual(new Storage(dir).listRegistrations().map(row => row.openid), ['OTHER_OPENID_123']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('管理员修改 QQ 与 OpenID 后立即生效并持久化，重复和无效值被拒绝', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcqq-registrations-'));
  try {
    const store = new Storage(dir);
    store.register('USER_OPENID_123', '36000000', 'GROUP_OPENID_123');
    store.register('OTHER_OPENID_123', '36000001', 'GROUP_OPENID_456');
    const registeredAt = store.state.users.USER_OPENID_123.registeredAt;
    const before = store.state.users.USER_OPENID_123;
    assert.throws(() => store.updateRegistration('USER_OPENID_123', 'OTHER_OPENID_123', '36000002'), /已登记/);
    assert.throws(() => store.updateRegistration('USER_OPENID_123', 'NEW_OPENID_123', '36000001'), /已被/);
    assert.throws(() => store.updateRegistration('USER_OPENID_123', 'NEW_OPENID_123', 'bad'), /QQ 号格式/);
    assert.equal(store.state.users.USER_OPENID_123, before);
    store.updateRegistration('USER_OPENID_123', 'NEW_OPENID_123', '36000002');
    assert.equal(store.state.users.USER_OPENID_123, undefined);
    assert.equal(store.state.users.NEW_OPENID_123.qq, '36000002');
    assert.equal(store.state.users.NEW_OPENID_123.registeredAt, registeredAt);
    assert.equal(store.state.users.NEW_OPENID_123.group, 'GROUP_OPENID_123');
    assert.deepEqual(new Storage(dir).listRegistrations().find(row => row.qq === '36000002').openid, 'NEW_OPENID_123');
    store.unregister('NEW_OPENID_123');
    assert.equal(new Storage(dir).listRegistrations().some(row => row.openid === 'NEW_OPENID_123'), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('后台登记修改删除接口要求登录并立即反映到列表', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcqq-api-'));
  const dataDir = join(dir, 'data');
  const store = new Storage(dataDir);
  store.register('USER_OPENID_123', '36000000', 'GROUP_OPENID_123');
  store.register('OTHER_OPENID_123', '36000001', 'GROUP_OPENID_123');
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const origin = 'http://127.0.0.1:' + port;
  const child = spawn(process.execPath, [resolve('src/server.js')], {
    cwd: dir, env: { ...process.env, MCQQ_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    await Promise.race([
      new Promise((resolveReady, reject) => {
        child.stdout.once('data', resolveReady);
        child.once('error', reject);
        child.once('exit', code => reject(new Error('后台提前退出：' + code)));
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('后台启动超时')), 6000))
    ]);
    const call = async (path, method = 'GET', payload, cookie, requestOrigin = origin) => {
      const response = await fetch(origin + '/api/' + path, {
        method,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json' } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...(method !== 'GET' ? { Origin: requestOrigin } : {})
        },
        ...(payload ? { body: JSON.stringify(payload) } : {})
      });
      return { response, data: await response.json() };
    };
    assert.equal((await call('registrations')).response.status, 401);
    const setup = await call('setup', 'POST', { username: 'admin123', password: 'pass1234' });
    assert.equal(setup.response.status, 200);
    const cookie = setup.response.headers.get('set-cookie').split(';')[0];
    assert.equal((await call('registrations/update', 'POST', {
      currentOpenid: 'USER_OPENID_123', openid: 'NEW_OPENID_123', qq: '36000002'
    }, cookie, 'http://evil.invalid')).response.status, 403);
    const edited = await call('registrations/update', 'POST', {
      currentOpenid: 'USER_OPENID_123', openid: 'NEW_OPENID_123', qq: '36000002'
    }, cookie);
    assert.equal(edited.response.status, 200);
    assert.ok(edited.data.some(row => row.openid === 'NEW_OPENID_123' && row.qq === '36000002'));
    assert.ok(!edited.data.some(row => row.openid === 'USER_OPENID_123'));
    assert.equal((await call('registrations/update', 'POST', {
      currentOpenid: 'NEW_OPENID_123', openid: 'NEW_OPENID_123', qq: '36000001'
    }, cookie)).response.status, 400);
    assert.deepEqual((await call('registrations/delete-setting', 'GET', undefined, cookie)).data, { enabled: false });
    assert.equal((await call('registrations/delete-setting', 'POST', { enabled: 'yes' }, cookie)).response.status, 400);
    const enabled = await call('registrations/delete-setting', 'POST', { enabled: true }, cookie);
    assert.deepEqual(enabled.data, { enabled: true });
    assert.equal(new Storage(dataDir).config.registrationDeleteUnbindEnabled, true);
    assert.equal((await call('registrations/delete', 'POST', { openid: 'NEW_OPENID_123' }, cookie)).response.status, 400);
    const failed = await call('registrations/delete', 'POST', { openid: 'NEW_OPENID_123', confirmQq: '36000002' }, cookie);
    assert.equal(failed.response.status, 409);
    assert.ok((await call('registrations', 'GET', undefined, cookie)).data.some(row => row.openid === 'NEW_OPENID_123'));
    assert.equal((await call('aqqbot/clear-all', 'POST', { qq: '36000002' }, cookie)).response.status, 400);
    assert.equal((await call('aqqbot/clear-player', 'POST', { qq: '36000002', player: '011' }, cookie)).response.status, 400);
    await call('registrations/delete-setting', 'POST', { enabled: false }, cookie);
    const deleted = await call('registrations/delete', 'POST', { openid: 'NEW_OPENID_123' }, cookie);
    assert.equal(deleted.response.status, 200);
    assert.deepEqual(deleted.data.map(row => row.openid), ['OTHER_OPENID_123']);
    assert.deepEqual(new Storage(dataDir).listRegistrations().map(row => row.openid), ['OTHER_OPENID_123']);
  } finally {
    child.kill();
    await new Promise(resolveExit => {
      if (child.exitCode !== null || child.signalCode !== null) return resolveExit();
      child.once('exit', resolveExit);
    });
    rmSync(dir, { recursive: true, force: true });
  }
});
