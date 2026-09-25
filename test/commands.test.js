import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Storage } from '../src/storage.js';
import { Bridge, formatTpsOutput } from '../src/bridge.js';
import { normalizeCommand } from '../src/commands.js';

test('中文别名逐一对应英文命令并保留参数原样', () => {
  const pairs = [
    ['/登记 36000000', '/qqbind 36000000'],
    ['/解除登记', '/qqunbind'],
    ['/绑定 011', '/mcbind 011'],
    ['/解绑 011', '/mcunbind 011'],
    ['/全部解绑', '/mcunallbind'],
    ['/我的绑定', '/mymc'],
    ['/状态', '/motd'],
    ['/桥接状态', '/status'],
    ['/在线', '/list'],
    ['/性能', '/tps']
  ];
  for (const [alias, canonical] of pairs) assert.equal(normalizeCommand(alias), canonical);
  assert.equal(normalizeCommand('/绑定x 011'), '/绑定x 011');
});

test('中文绑定和解绑复用原处理与回复格式，纯数字名保持前导零', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcqq-alias-'));
  try {
    const store = new Storage(dir);
    store.config = { allowedGroups: 'GROUP_OPENID_123' };
    store.register('USER_OPENID_123', '36000000', 'GROUP_OPENID_123');
    let owner = null;
    const calls = [];
    const replies = [];
    const bridge = new Bridge(store, {
      send: async (_event, reply) => replies.push(reply),
      rcon: async (_config, command) => {
        calls.push(command);
        if (command.startsWith('aqqbot whitelist query player ')) return 'QQ号: ' + (owner ?? 'null') + '\n游戏名: 011';
        if (command.startsWith('aqqbot whitelist query qq ')) return 'QQ号: 36000000\n游戏名: ' + (owner ? '011' : '');
        if (command === 'aqqbot whitelist bind 36000000 011') { owner = '36000000'; return '绑定成功'; }
        if (command === 'aqqbot whitelist unbind player 011') { owner = null; return '解绑成功'; }
        throw new Error('意外命令：' + command);
      }
    });
    const event = { kind: 'group', groupOpenid: 'GROUP_OPENID_123', senderId: 'USER_OPENID_123', replyTarget: { scope: 'group', targetId: 'GROUP_OPENID_123' } };
    await bridge.handleEvent({ ...event, content: '/绑定 011', messageId: 'alias-bind' });
    assert.match(replies.at(-1), /已为玩家 011 发送 AQQBot 绑定命令/);
    bridge.lastCommand.clear();
    await bridge.handleEvent({ ...event, content: '/我的绑定', messageId: 'alias-query' });
    assert.match(replies.at(-1), /011/);
    bridge.lastCommand.clear();
    await bridge.handleEvent({ ...event, content: '/解绑 011', messageId: 'alias-unbind' });
    assert.match(replies.at(-1), /已从当前 QQ 号解绑；其他玩家和 QQ 登记保持不变/);
    assert.ok(calls.includes('aqqbot whitelist bind 36000000 011'));
    assert.ok(calls.includes('aqqbot whitelist unbind player 011'));
    assert.equal(store.listPlayerLog()[0].command, '/解绑 011');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('/tps 与 /性能仅通过固定 RCON 命令读取 TPS 并返回控制台输出', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcqq-tps-'));
  try {
    const store = new Storage(dir);
    store.config = { allowedGroups: 'GROUP_OPENID_123' };
    store.register('USER_OPENID_123', '36000000', 'GROUP_OPENID_123');
    const replies = [];
    const commands = [];
    const bridge = new Bridge(store, {
      send: async (_event, reply) => replies.push(reply),
      rcon: async (_config, command) => { commands.push(command); return '§6TPS from last 1m, 5m, 15m: §a20.0§r, §a19.9§r, §e19.8'; }
    });
    const event = { kind: 'group', groupOpenid: 'GROUP_OPENID_123', senderId: 'USER_OPENID_123', replyTarget: { scope: 'group', targetId: 'GROUP_OPENID_123' } };
    await bridge.handleEvent({ ...event, content: '/性能', messageId: 'tps-query' });
    assert.deepEqual(commands, ['tps']);
    assert.equal(replies.at(-1), '⚡ 服务器 TPS\n最近 1 分钟：20.0\n最近 5 分钟：19.9\n最近 15 分钟：19.8');
    assert.equal(store.listPlayerLog()[0].category, '性能查询');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('无法识别的 TPS 文本也会清除 Minecraft 和 ANSI 颜色码', () => {
  assert.equal(formatTpsOutput('§6Current TPS: §a20.0§r \u001b[31mok'), 'Current TPS: 20.0 ok');
});

