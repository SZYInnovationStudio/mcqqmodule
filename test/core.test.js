import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Storage } from '../src/storage.js';
import { validateConfig, publicConfig } from '../src/config.js';
import { recentPlayerMessages } from '../src/logs.js';
import { Bridge } from '../src/bridge.js';
import { rconCommand } from '../src/rcon.js';
import { queryMotd } from '../src/motd.js';
import { McsmClient } from '../src/mcsm.js';

test('配置密钥加密保存且读取时不回传', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcqq-'));
  try {
    const store = new Storage(dir);
    const config = validateConfig({ mcsmUrl: 'http://127.0.0.1:23333', mcsmApiKey: 'secret-key', rconPassword: 'secret-pass', onebotToken: 'secret-bot', allowedGroups: '12345678' });
    store.saveConfig(config);
    const raw = readFileSync(join(dir, 'config.enc'), 'utf8');
    assert.ok(!raw.includes('secret-key'));
    assert.ok(!raw.includes('secret-pass'));
    assert.equal(new Storage(dir).config.mcsmApiKey, 'secret-key');
    assert.equal(publicConfig(config).mcsmApiKey, undefined);
    assert.equal(publicConfig(config).mcsmApiKeySet, true);
    assert.equal(validateConfig({ mcsmApiKey: '' }, config).mcsmApiKey, 'secret-key');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('近两分钟只返回带时间戳的玩家聊天', () => {
  const now = new Date('2026-09-12T05:10:50Z');
  const log = '[13:08:40 INFO]: <Old> 过期\n[13:10:14 INFO]: <vill> 你好\n[13:10:20 INFO]: Done\n[13:10:40] [Server thread/INFO]: <Alex> hi';
  assert.deepEqual(recentPlayerMessages(log, now).map(item => item.player), ['vill', 'Alex']);
});

test('绑定码限定 QQ 号和群，RCON 只用事件 QQ 号', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcqq-'));
  try {
    const store = new Storage(dir);
    store.config = { allowedGroups: '12345678' };
    const calls = [];
    const bridge = new Bridge(store, { rcon: async (_config, command) => { calls.push(command); return '已执行'; }, send: async () => {} });
    const reply = bridge.beginBind('36000000', '12345678', '/bind implayer');
    const code = reply.match(/BIND-[A-F0-9]{6}/)[0];
    assert.match(await bridge.confirmBind('36000001', '12345678', code), /无效/);
    assert.match(await bridge.confirmBind('36000000', '87654321', code), /无效/);
    assert.match(await bridge.confirmBind('36000000', '12345678', code), /RCON/);
    assert.deepEqual(calls, ['aqqbot whitelist bind 36000000 implayer']);
    assert.equal(store.state.bindings['36000000'].status, '已发送，待服务器确认');
    assert.match(await bridge.confirmBind('36000000', '12345678', code), /无效/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('消息命令先自动登记 QQ 号', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcqq-'));
  try {
    const store = new Storage(dir);
    store.config = { allowedGroups: '12345678' };
    const replies = [];
    const bridge = new Bridge(store, { motd: async () => ({ motd: '测试服务器', online: 1, max: 20 }), send: async (_event, message) => replies.push(message) });
    await bridge.handleEvent({ post_type: 'message', message_type: 'group', group_id: 12345678, user_id: 36000000, message_id: 1, raw_message: '/motd' });
    assert.ok(store.state.users['36000000']);
    assert.match(replies[0], /测试服务器/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('MCSManager 请求包含实例标识与官方要求的请求头', async () => {
  let captured;
  const client = new McsmClient({ mcsmUrl: 'http://panel.test', mcsmApiKey: 'key', daemonId: 'daemon', instanceId: 'instance' }, async (url, options) => {
    captured = { url: String(url), options };
    return { ok: true, json: async () => ({ status: 200, data: 'log' }) };
  });
  assert.equal(await client.outputLog(), 'log');
  assert.match(captured.url, /\/api\/protected_instance\/outputlog/);
  assert.match(captured.url, /apikey=key/);
  assert.match(captured.url, /uuid=instance/);
  assert.equal(captured.options.headers['X-Requested-With'], 'XMLHttpRequest');
});

function rconPacket(id, type, value) {
  const text = Buffer.from(value);
  const data = Buffer.alloc(text.length + 14);
  data.writeInt32LE(text.length + 10, 0);
  data.writeInt32LE(id, 4);
  data.writeInt32LE(type, 8);
  text.copy(data, 12);
  return data;
}

test('RCON 鉴权后执行命令并取得输出', async () => {
  const server = net.createServer(socket => {
    socket.on('data', data => {
      const id = data.readInt32LE(4);
      if (id === 101) socket.write(rconPacket(101, 2, ''));
      if (id === 102) socket.write(rconPacket(102, 0, 'There are 0 players online'));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const output = await rconCommand({ rconHost: '127.0.0.1', rconPort: server.address().port, rconPassword: 'pass' }, 'list');
    assert.match(output, /0 players/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('MOTD 状态协议读取描述和在线人数', async () => {
  const payload = Buffer.from(JSON.stringify({ description: { text: 'Hello ', extra: [{ text: 'World' }] }, players: { online: 2, max: 10 }, version: { name: '1.21' } }));
  const response = Buffer.concat([Buffer.from([payload.length + 2, 0, payload.length]), payload]);
  const server = net.createServer(socket => socket.once('data', () => socket.write(response)));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await queryMotd({ mcHost: '127.0.0.1', mcPort: server.address().port });
    assert.equal(result.motd, 'Hello World');
    assert.equal(result.online, 2);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
