import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Storage } from '../src/storage.js';
import { Bridge } from '../src/bridge.js';

test('/status 和 /桥接状态报告实时连接状态、插件版本与 8.8.2 版本', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcqq-status-'));
  try {
    const store = new Storage(dir);
    store.config = {
      allowedGroups: 'GROUP_OPENID_123',
      rconHost: 'localhost',
      rconPort: '25575',
      rconPassword: 'secret'
    };
    store.register('USER_OPENID_123', '36000000', 'GROUP_OPENID_123');
    const replies = [];
    const commands = [];
    const bridge = new Bridge(store, {
      rcon: async (_config, command) => { commands.push(command); return 'There are 0 of a max of 20 players online:'; },
      send: async (_event, reply) => replies.push(reply)
    });
    bridge.status = '已连接';
    bridge.pluginConnection.observe(Date.now() - 2000);
    bridge.pluginVersion = '1.1.3';
    const event = {
      kind: 'group',
      groupOpenid: 'GROUP_OPENID_123',
      senderId: 'USER_OPENID_123',
      replyTarget: { scope: 'group', targetId: 'GROUP_OPENID_123' }
    };
    await bridge.handleEvent({ ...event, content: '/status', messageId: 'status-1' });
    assert.deepEqual(commands, ['list']);
    assert.match(replies[0], /^📊 桥接服务状态\n🕒 当前时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}（UTC\+8）/);
    assert.match(replies[0], /\n🔌 插件连接：正常（最近心跳 \d+ 秒前）/);
    assert.match(replies[0], /\n🧱 插件版本：1\.1\.3\n🎮 RCON 连接：正常\n🤖 QQ Bot 连接：正常\n🧩 BOT 服务端版本：8\.8\.2$/);
    bridge.pluginConnection.lastSeen = Date.now() - 31_000;
    bridge.lastCommand.clear();
    await bridge.handleEvent({ ...event, content: '/桥接状态', messageId: 'status-2' });
    assert.match(replies[1], /插件连接：异常（心跳超时）/);
    assert.deepEqual(commands, ['list', 'list']);
    assert.equal(store.listPlayerLog()[0].command, '/桥接状态');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('/status 在 RCON 未配置或不可用时仍能回复', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcqq-status-'));
  try {
    const store = new Storage(dir);
    store.config = { allowedGroups: 'GROUP_OPENID_123' };
    const bridge = new Bridge(store, { rcon: async () => { throw new Error('secret failure'); } });
    const unconfigured = await bridge.bridgeStatus();
    assert.match(unconfigured, /插件连接：未连接（尚未收到心跳）/);
    assert.match(unconfigured, /插件版本：未上报/);
    assert.match(unconfigured, /RCON 连接：未配置/);
    assert.doesNotMatch(unconfigured, /secret failure/);
    store.config = { ...store.config, rconHost: 'localhost', rconPort: '25575', rconPassword: 'secret' };
    const unavailable = await bridge.bridgeStatus();
    assert.match(unavailable, /RCON 连接：异常（连接或认证失败）/);
    assert.doesNotMatch(unavailable, /secret failure/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('/status 每次请求重新读取版本和最新心跳', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcqq-status-'));
  try {
    const store = new Storage(dir);
    store.config = { allowedGroups: 'GROUP_OPENID_123' };
    let version = '8.5';
    const bridge = new Bridge(store, { readVersion: () => version });
    const first = await bridge.bridgeStatus();
    assert.match(first, /BOT 服务端版本：8\.5$/);
    assert.match(first, /插件连接：未连接/);
    version = '8.5-hotfix';
    bridge.pluginConnection.observe();
    const second = await bridge.bridgeStatus();
    assert.match(second, /BOT 服务端版本：8\.5-hotfix$/);
    assert.match(second, /插件连接：正常/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
