import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Storage } from '../src/storage.js';

function packet(id, type, body) {
  const data = Buffer.from(body, 'utf8');
  const frame = Buffer.alloc(data.length + 14);
  frame.writeInt32LE(data.length + 10, 0);
  frame.writeInt32LE(id, 4);
  frame.writeInt32LE(type, 8);
  data.copy(frame, 12);
  return frame;
}

function mockRcon(owners, commands) {
  return net.createServer(socket => {
    let incoming = Buffer.alloc(0);
    socket.on('data', chunk => {
      incoming = Buffer.concat([incoming, chunk]);
      while (incoming.length >= 4) {
        const length = incoming.readInt32LE(0);
        if (incoming.length < length + 4) break;
        const frame = incoming.subarray(0, length + 4);
        incoming = incoming.subarray(length + 4);
        const id = frame.readInt32LE(4);
        if (id === 101) {
          socket.write(packet(101, 2, ''));
          continue;
        }
        if (id !== 102) continue;
        const command = frame.subarray(12, frame.length - 2).toString('utf8');
        commands.push(command);
        let output = '未知命令';
        if (command === 'tps') output = 'TPS from last 1m, 5m, 15m: 20.0, 20.0, 19.9';
        else if (command.startsWith('aqqbot whitelist query qq ')) {
          const qq = command.slice('aqqbot whitelist query qq '.length);
          output = 'QQ号: ' + qq + '\n游戏名: ' + [...owners].filter(([, owner]) => owner === qq).map(([player]) => player).join(', ');
        } else if (command.startsWith('aqqbot whitelist query player ')) {
          const player = command.slice('aqqbot whitelist query player '.length);
          output = 'QQ号: ' + (owners.get(player) ?? 'null') + '\n游戏名: ' + (owners.has(player) ? player : '');
        } else if (command.startsWith('aqqbot whitelist unbind player ')) {
          const player = command.slice('aqqbot whitelist unbind player '.length);
          output = owners.delete(player) ? '解绑成功' : '解绑失败';
        }
        socket.write(packet(102, 0, output));
      }
    });
  });
}

test('8.7.1 后台管理、插件版本、模板、服务器日志、RCON 终端及 AQQBot 管理真实 HTTP 流程', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcqq-admin-api-'));
  const owners = new Map([['011', '36000000'], ['Steve', '36000000'], ['other', '36000001']]);
  const commands = [];
  const rcon = mockRcon(owners, commands);
  await new Promise(done => rcon.listen(0, '127.0.0.1', done));
  const storage = new Storage(join(dir, 'data'));
  storage.register('USER_OPENID_123', '36000000', 'GROUP_OPENID_123');
  storage.saveConfig({ rconHost: '127.0.0.1', rconPort: String(rcon.address().port), rconPassword: 'secret', pluginKey: 'A'.repeat(32) });
  const reserve = net.createServer();
  await new Promise(done => reserve.listen(0, '127.0.0.1', done));
  const port = reserve.address().port;
  await new Promise(done => reserve.close(done));
  const origin = 'http://127.0.0.1:' + port;
  const child = spawn(process.execPath, [resolve('src/server.js')], {
    cwd: dir, env: { ...process.env, MCQQ_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    await new Promise((done, fail) => {
      const timer = setTimeout(() => fail(new Error('后台启动超时')), 6000);
      child.stdout.once('data', () => { clearTimeout(timer); done(); });
      child.once('error', fail);
      child.once('exit', code => fail(new Error('后台提前退出：' + code)));
    });
    const call = async (path, method = 'GET', payload, cookie) => {
      const response = await fetch(origin + '/api/' + path, {
        method,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json' } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...(method !== 'GET' ? { Origin: origin } : {})
        },
        ...(payload ? { body: JSON.stringify(payload) } : {})
      });
      return { status: response.status, data: await response.json() };
    };
    assert.equal((await call('aqqbot/clear-player', 'POST', { qq: '36000000', player: '011', confirmPlayer: '011' })).status, 401);
    const setup = await call('setup', 'POST', { username: 'admin123', password: 'pass1234' });
    assert.equal(setup.status, 200);
    const login = await fetch(origin + '/api/login', {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin123', password: 'pass1234' })
    });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(origin + '/modules')).status, 200);
    assert.equal((await call('modules')).status, 401);
    const modulePage = Buffer.from('<!doctype html><title>增量测试</title><h1>只新增</h1>');
    const moduleBundle = {
      format: 'szydmc-module-v1',
      manifest: { id: 'admin-test-addon', name: '后台测试模块', version: '1.0.0', page: 'index.html' },
      files: [{ path: 'public/index.html', content: modulePage.toString('base64'), sha256: createHash('sha256').update(modulePage).digest('hex') }]
    };
    const moduleInstall = await call('modules/install', 'POST', moduleBundle, cookie);
    assert.equal(moduleInstall.status, 201);
    assert.equal(moduleInstall.data.installed.id, 'admin-test-addon');
    assert.equal(moduleInstall.data.installed.enabled, true);
    assert.equal((await call('modules/toggle', 'POST', { id: 'admin-test-addon', enabled: false })).status, 401);
    const toggled = await call('modules/toggle', 'POST', { id: 'admin-test-addon', enabled: false }, cookie);
    assert.equal(toggled.data.enabled, false);
    assert.equal((await call('modules', 'GET', undefined, cookie)).data.modules[0].enabled, false);
    const installedPage = await fetch(origin + '/modules/admin-test-addon/');
    assert.equal(installedPage.status, 200);
    assert.match(await installedPage.text(), /只新增/);
    assert.equal((await call('modules/install', 'POST', moduleBundle, cookie)).status, 400);
    assert.equal((await fetch(origin + '/binding-admin')).status, 200);
    assert.equal((await fetch(origin + '/aqqbot-database')).status, 200);
    assert.equal((await call('aqqbot/database')).status, 401);
    const exchange = await fetch(origin + '/api/plugin/exchange', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + storage.config.pluginKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ack: 0, sent: [], pluginVersion: '1.1.3', aqqbotSnapshot: {
          available: true, capturedAt: Date.now(),
          rows: [{ qq: '36000000', players: ['011', 'Steve'] }]
        }
      })
    });
    assert.equal(exchange.status, 200);
    const database = await call('aqqbot/database', 'GET', undefined, cookie);
    assert.equal(database.status, 200);
    assert.equal(database.data.available, true);
    assert.equal(database.data.rows[0].openid, 'USER_OPENID_123');
    assert.deepEqual(database.data.rows[0].players, ['011', 'Steve']);
    const status = await call('status', 'GET', undefined, cookie);
    assert.equal(status.data.pluginVersion, '1.1.3');
    assert.equal((await fetch(origin + '/templates')).status, 200);
    assert.equal((await fetch(origin + '/server-logs')).status, 200);
    assert.equal((await call('templates')).status, 401);
    const templates = await call('templates', 'GET', undefined, cookie);
    assert.equal(templates.status, 200);
    assert.equal(templates.data.serverOfflineTemplate, '服务器已关闭');
    assert.equal((await call('templates', 'POST', {
      ...templates.data,
      presenceJoinTemplate: '[SZYDBOT] ${player} 加入了服务器',
      presenceQuitTemplate: '[SZYDBOT] ${player} 离开了服务器',
      presenceNotifyEnabled: false,
      serverStatusNotifyEnabled: false
    }, cookie)).status, 200);
    assert.equal((await call('server-logs/setting', 'POST', { enabled: true }, cookie)).status, 200);
    const logExchange = await fetch(origin + '/api/plugin/exchange', {
      method: 'POST', headers: { Authorization: 'Bearer ' + storage.config.pluginKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ack: 0, sent: [], serverLogs: { source: 'run-log-123', start: 0, end: 24, lines: ['[Server thread/INFO]: ready'] } })
    });
    assert.equal(logExchange.status, 200);
    const logs = await call('server-logs', 'GET', undefined, cookie);
    assert.equal(logs.data.lines.at(-1).line, '[Server thread/INFO]: ready');
    assert.equal((await call('rcon/command', 'POST', { command: 'tps', transport: 'plugin' }, cookie)).status, 400);
    const terminal = await call('rcon/command', 'POST', { command: 'tps' }, cookie);
    assert.equal(terminal.status, 200);
    assert.equal(terminal.data.transport, 'rcon');
    assert.match(terminal.data.output, /20\.0/);
    const created = await call('registrations/create', 'POST', {
      qq: '36000003', openid: 'NEW_OPENID_123', group: 'GROUP_OPENID_123'
    }, cookie);
    assert.equal(created.status, 200);
    assert.ok(created.data.some(item => item.openid === 'NEW_OPENID_123'));
    assert.equal((await call('registrations/create', 'POST', {
      qq: '36000003', openid: 'ANOTHER_OPENID_123'
    }, cookie)).status, 400);
    assert.equal((await call('registrations/delete', 'POST', { openid: 'NEW_OPENID_123' }, cookie)).status, 200);
    const lookup = await call('aqqbot/query', 'POST', { type: 'player', value: '011' }, cookie);
    assert.equal(lookup.data.qq, '36000000');
    assert.equal((await call('aqqbot/clear-player', 'POST', {
      qq: '36000000', player: '011', confirmPlayer: 'wrong'
    }, cookie)).status, 400);
    const one = await call('aqqbot/clear-player', 'POST', {
      qq: '36000000', player: '011', confirmPlayer: '011'
    }, cookie);
    assert.equal(one.status, 200);
    assert.deepEqual(one.data.removed, ['011']);
    assert.equal(owners.has('011'), false);
    assert.equal((await call('registrations/delete-setting', 'POST', { enabled: true }, cookie)).status, 200);
    assert.equal((await call('registrations/delete', 'POST', { openid: 'USER_OPENID_123' }, cookie)).status, 400);
    const linked = await call('registrations/delete', 'POST', {
      openid: 'USER_OPENID_123', confirmQq: '36000000'
    }, cookie);
    assert.equal(linked.status, 200);
    assert.deepEqual(linked.data, []);
    assert.equal(owners.has('Steve'), false);
    assert.equal(owners.get('other'), '36000001');
    assert.equal(new Storage(join(dir, 'data')).state.users.USER_OPENID_123, undefined);
    const all = await call('aqqbot/clear-all', 'POST', { qq: '36000001', confirmQq: '36000001' }, cookie);
    assert.equal(all.status, 200);
    assert.deepEqual(all.data.removed, ['other']);
    assert.equal(owners.size, 0);
    assert.ok(commands.includes('aqqbot whitelist unbind player 011'));
    assert.ok(commands.includes('aqqbot whitelist unbind player Steve'));
    assert.ok(commands.includes('aqqbot whitelist unbind player other'));
  } finally {
    child.kill();
    await new Promise(done => {
      if (child.exitCode !== null || child.signalCode !== null) return done();
      child.once('exit', done);
    });
    await new Promise(done => rcon.close(done));
    rmSync(dir, { recursive: true, force: true });
  }
});




