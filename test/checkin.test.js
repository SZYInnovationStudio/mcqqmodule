import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ModuleManager } from '../src/module-manager.js';
import { Storage } from '../src/storage.js';
import { Bridge } from '../src/bridge.js';

const root = new URL('../modules/daily-checkin-money/', import.meta.url);
function bundle() {
  const files = ['server.mjs', 'public/index.html', 'public/app.js', 'public/style.css'].map(path => {
    const data = readFileSync(new URL(path, root));
    return { path, content: data.toString('base64'), sha256: createHash('sha256').update(data).digest('hex') };
  });
  return { format: 'szydmc-module-v1', manifest: { id: 'daily-checkin-money', name: '每日签到', version: '1.1.0', description: '经济奖励签到', page: 'index.html', entry: 'server.mjs', commands: ['qd', '签到'] }, files };
}

test('签到模块单玩家、重复领取、设置、独立开关与持久化', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcqq-checkin-'));
  try {
    const owners = new Map([['011', '36000000']]);
    const calls = [];
    const helpCalls = [];
    const manager = new ModuleManager(dir, { services: {
      getRegistration: () => '36000000', queryPlayers: qq => [...owners].filter(([, owner]) => owner === qq).map(([player]) => player),
      playerOwner: player => owners.get(player), reward: async (player, amount, template) => { calls.push({ player, amount, template }); return '成功'; },
      testRewardTemplate: async template => { helpCalls.push(template); return 'money help'; }
    } });
    await manager.loadInstalled();
    await manager.install(bundle());
    const module = manager.commandFor('/签到');
    assert.equal(module.id, 'daily-checkin-money');
    const request = { message: '/qd', openid: 'USER_OPENID_123', group: 'GROUP_OPENID_123', qq: '36000000' };
    const results = await Promise.all([manager.handleCommand(module, request), manager.handleCommand(module, request)]);
    assert.equal(calls.length, 1);
    assert.ok(results.some(item => /签到成功/.test(item)));
    assert.ok(results.some(item => /正在处理|今天已签到/.test(item)));
    assert.equal(calls[0].player, '011');
    assert.ok(calls[0].amount >= 1000 && calls[0].amount <= 10000);
    assert.match(await manager.handleCommand(module, request), /今天已签到/);
    const settings = await manager.dispatch('/api/modules/daily-checkin-money/settings', 'GET', {}, {}, 'admin');
    assert.equal(settings.body.todayCount, 1);
    assert.equal(settings.body.version, '1.1.0');
    const updated = await manager.dispatch('/api/modules/daily-checkin-money/settings', 'POST', { min: 2000, max: 3000, commandTemplate: 'money give ${player} ${amount}' }, {}, 'admin');
    assert.equal(updated.body.settings.min, 2000);
    const tested = await manager.dispatch('/api/modules/daily-checkin-money/test', 'POST', updated.body.settings, {}, 'admin');
    assert.equal(tested.body.output, 'money help');
    assert.equal(helpCalls.length, 1);
    assert.equal(calls.length, 1);
    await manager.setEnabled('daily-checkin-money', false);
    assert.match(await manager.handleCommand(module, request), /已关闭/);
    const restarted = new ModuleManager(dir);
    await restarted.loadInstalled();
    assert.equal(restarted.list().modules[0].enabled, false);
    assert.equal((await restarted.dispatch('/api/modules/daily-checkin-money/settings', 'GET', {}, {})).body.settings.min, 2000);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('直接选择本人绑定玩家，失败不消耗次数，冒领拒绝', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcqq-checkin-'));
  try {
    const owners = new Map([['011', '36000000'], ['_YuriGamma15', '36000000'], ['Other', '36000001']]);
    let fail = true;
    const calls = [];
    const manager = new ModuleManager(dir, { services: {
      getRegistration: openid => openid === 'USER_OPENID_123' ? '36000000' : '36000001',
      queryPlayers: qq => [...owners].filter(([, owner]) => owner === qq).map(([player]) => player),
      playerOwner: player => owners.get(player),
      reward: async (player, amount) => { calls.push(player); if (fail) throw new Error('RCON 不可用'); return '成功'; }
    } });
    await manager.loadInstalled(); await manager.install(bundle());
    const mod = manager.commandFor('/qd');
    const user = { message: '/签到', openid: 'USER_OPENID_123', group: 'GROUP_OPENID_123', qq: '36000000' };
    assert.match(await manager.handleCommand(mod, { ...user, message: '/qd add Other' }), /玩家归属/);
    assert.match(await manager.handleCommand(mod, { ...user, openid: 'OTHER_OPENID_123', message: '/qd add 011' }), /登记已变更/);
    await assert.rejects(manager.handleCommand(mod, { ...user, message: '/qd add _YuriGamma15' }), /RCON 不可用/);
    assert.equal((await manager.dispatch('/api/modules/daily-checkin-money/settings', 'GET', {}, {})).body.todayCount, 0);
    fail = false;
    assert.match(await manager.handleCommand(mod, { ...user, message: '/签到 add _YuriGamma15' }), /签到成功/);
    assert.deepEqual(calls, ['_YuriGamma15', '_YuriGamma15']);
    assert.match(await manager.handleCommand(mod, user), /今天已签到/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('QQ 群白名单和现有命令处理仍在签到模块之前', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcqq-checkin-'));
  try {
    const store = new Storage(dir);
    store.config = { allowedGroups: 'GROUP_OPENID_123' };
    store.register('USER_OPENID_123', '36000000', 'GROUP_OPENID_123');
    const manager = new ModuleManager(dir, { services: { getRegistration: () => '36000000', queryPlayers: () => [], playerOwner: () => null } });
    await manager.loadInstalled(); await manager.install(bundle());
    const replies = [];
    const bridge = new Bridge(store, { modules: manager, send: async (_event, message) => replies.push(message) });
    const event = { kind: 'group', senderId: 'USER_OPENID_123', groupOpenid: 'GROUP_OPENID_123', replyTarget: { scope: 'group', targetId: 'GROUP_OPENID_123' }, content: '/qd', messageId: 'one' };
    await bridge.handleEvent({ ...event, groupOpenid: 'OTHER_GROUP_123', replyTarget: { scope: 'group', targetId: 'OTHER_GROUP_123' } });
    assert.equal(replies.length, 0);
    await bridge.handleEvent(event);
    assert.match(replies[0], /没有绑定 MC 玩家/);
    await bridge.handleEvent({ ...event, messageId: 'quick-choice', content: '/qd add 011' });
    assert.match(replies[1], /玩家归属/);
    await bridge.handleEvent({ ...event, messageId: 'two', content: '/tp Steve' });
    assert.equal(replies.length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
