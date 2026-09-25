import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Storage } from '../src/storage.js';
import { Bridge } from '../src/bridge.js';

const event = (content, overrides = {}) => ({
  kind: 'group',
  groupOpenid: 'GROUP_OPENID_123',
  senderId: 'USER_OPENID_123',
  replyTarget: { scope: 'group', targetId: 'GROUP_OPENID_123' },
  content,
  ...overrides
});

test('群内 /tp 等非白名单命令和伪装斜杠不进入 RCON 或 MC 插件队列', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcqq-security-'));
  try {
    const store = new Storage(dir);
    store.config = { allowedGroups: 'GROUP_OPENID_123', qqToMcEnabled: true };
    store.register('USER_OPENID_123', '36000000', 'GROUP_OPENID_123');
    const calls = [];
    const replies = [];
    const bridge = new Bridge(store, {
      rcon: async (_config, command) => { calls.push(command); return ''; },
      send: async (_event, reply) => replies.push(reply)
    });
    for (const content of ['/tp Steve 1 2 3', '/op Steve', '\u200b/tp Steve', '／tp Steve']) {
      await bridge.handleEvent(event(content));
    }
    assert.deepEqual(calls, []);
    assert.deepEqual(replies, []);
    assert.deepEqual(bridge.exchangePluginChat({ ack: 0, sent: [] }).receive, []);
    await bridge.handleEvent(event('有人说 /tp Steve'));
    assert.deepEqual(calls, []);
    const queued = bridge.exchangePluginChat({ ack: 0, sent: [] }).receive;
    assert.equal(queued.length, 1);
    assert.match(queued[0].components.map(part => part.text).join(''), /有人说 \/tp Steve/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('错误群、错误回复目标、未登记和注入式参数不能触发 MC 命令', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcqq-security-'));
  try {
    const store = new Storage(dir);
    store.config = { allowedGroups: 'GROUP_OPENID_123' };
    const calls = [];
    const replies = [];
    const bridge = new Bridge(store, {
      rcon: async (_config, command) => { calls.push(command); return ''; },
      send: async (_event, reply) => replies.push(reply)
    });
    await bridge.handleEvent(event('/mcbind Steve', { groupOpenid: 'OTHER_GROUP_123' }));
    await bridge.handleEvent(event('/mcbind Steve', { replyTarget: { scope: 'group', targetId: 'OTHER_GROUP_123' } }));
    await bridge.handleEvent(event('/mcbind Steve', { replyTarget: { scope: 'c2c', targetId: 'USER_OPENID_123' } }));
    assert.deepEqual(calls, []);
    assert.deepEqual(replies, []);
    await bridge.handleEvent(event('/mcbind Steve'));
    assert.match(replies.at(-1), /先登记 QQ 号/);
    store.register('USER_OPENID_123', '36000000', 'GROUP_OPENID_123');
    bridge.lastCommand.clear();
    await bridge.handleEvent(event('/mcbind Steve;op'));
    assert.match(replies.at(-1), /玩家名格式无效/);
    assert.deepEqual(calls, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('管理员改登期间的待处理绑定不能继续发送 RCON 写命令', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcqq-security-'));
  try {
    const store = new Storage(dir);
    store.config = { allowedGroups: 'GROUP_OPENID_123' };
    store.register('USER_OPENID_123', '36000000', 'GROUP_OPENID_123');
    const calls = [];
    let releaseQuery;
    let queryStarted;
    const started = new Promise(resolve => { queryStarted = resolve; });
    const query = new Promise(resolve => { releaseQuery = resolve; });
    const replies = [];
    const bridge = new Bridge(store, {
      rcon: async (_config, command) => {
        calls.push(command);
        if (command === 'aqqbot whitelist query player Steve') {
          queryStarted();
          return query;
        }
        throw new Error('不应发送写入命令');
      },
      send: async (_event, reply) => replies.push(reply)
    });
    const pending = bridge.handleEvent(event('/mcbind Steve'));
    await started;
    store.updateRegistration('USER_OPENID_123', 'USER_OPENID_123', '36000002');
    releaseQuery('QQ号: null\n游戏名: Steve');
    await pending;
    assert.deepEqual(calls, ['aqqbot whitelist query player Steve']);
    assert.match(replies.at(-1), /QQ 登记已变更/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
