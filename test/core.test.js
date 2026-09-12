import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Storage } from '../src/storage.js';
import { validateConfig, publicConfig } from '../src/config.js';
import { Bridge } from '../src/bridge.js';
import { rconCommand } from '../src/rcon.js';
import { queryMotd } from '../src/motd.js';

test('配置密钥加密保存且读取时不回传', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcqq-'));
  try {
    const store = new Storage(dir);
    const config = validateConfig({ rconPassword: 'secret-pass', qqAppId: '12345678', qqAppSecret: 'secret-bot', allowedGroups: 'GROUP_OPENID_123' });
    store.saveConfig(config);
    const raw = readFileSync(join(dir, 'config.enc'), 'utf8');
    assert.ok(!raw.includes('secret-pass'));
    assert.equal(publicConfig(config).qqAppSecret, undefined);
    assert.equal(publicConfig(config).qqAppSecretSet, true);
    assert.equal(publicConfig({ ...config, mcsmApiKey: 'legacy-secret' }).mcsmApiKey, undefined);
    assert.equal(validateConfig({ qqAppSecret: '' }, config).qqAppSecret, 'secret-bot');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('官方 Bot 自填 QQ 并二次核对后登记；玩家绑定另行执行', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcqq-'));
  try {
    const store = new Storage(dir);
    store.config = { allowedGroups: 'GROUP_OPENID_123' };
    const calls = [];
    const bridge = new Bridge(store, { rcon: async (_config, command) => { calls.push(command); return '已执行'; }, send: async () => {} });
    const reply = bridge.beginRegistration('USER_OPENID_123', 'GROUP_OPENID_123', '/qqbind 36000000');
    const code = reply.match(/BIND-[A-F0-9]{6}/)[0];
    assert.match(bridge.confirmRegistration('OTHER_OPENID_123', 'GROUP_OPENID_123', code), /无效/);
    assert.match(bridge.confirmRegistration('USER_OPENID_123', 'OTHER_GROUP_123', code), /无效/);
    assert.match(bridge.confirmRegistration('USER_OPENID_123', 'GROUP_OPENID_123', code), /已登记/);
    assert.equal(store.state.users.USER_OPENID_123.qq, '36000000');
    assert.equal(store.state.bindings.USER_OPENID_123, undefined);
    assert.deepEqual(calls, []);
    assert.match(await bridge.bindPlayer('USER_OPENID_123', 'GROUP_OPENID_123', '/mcbind implayer'), /绑定命令/);
    assert.deepEqual(calls, ['aqqbot whitelist bind 36000000 implayer']);
    assert.equal(store.getBindings('USER_OPENID_123')[0].status, '已发送，待服务器确认');
    assert.match(bridge.confirmRegistration('USER_OPENID_123', 'GROUP_OPENID_123', code), /无效/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('未登记时任何功能命令先要求登记，登记后才能查询', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcqq-'));
  try {
    const store = new Storage(dir);
    store.config = { allowedGroups: 'GROUP_OPENID_123' };
    const replies = [];
    const bridge = new Bridge(store, { motd: async () => ({ motd: '测试服务器', online: 1, max: 20 }), send: async (_event, message) => replies.push(message) });
    const event = { kind: 'group', groupOpenid: 'GROUP_OPENID_123', senderId: 'USER_OPENID_123', replyTarget: { scope: 'group', targetId: 'GROUP_OPENID_123' } };
    await bridge.handleEvent({ ...event, messageId: '1', content: '/motd' });
    assert.equal(store.state.users.USER_OPENID_123, undefined);
    assert.match(replies[0], /\/qqbind/);
    bridge.lastCommand.delete('USER_OPENID_123');
    await bridge.handleEvent({ ...event, messageId: '2', content: '/qqbind 36000000' });
    const code = replies.at(-1).match(/BIND-[A-F0-9]{6}/)[0];
    await bridge.handleEvent({ ...event, messageId: '3', content: code });
    assert.ok(store.state.users.USER_OPENID_123);
    assert.equal(store.state.bindings.USER_OPENID_123, undefined);
    bridge.lastCommand.delete('USER_OPENID_123');
    await bridge.handleEvent({ ...event, messageId: '4', content: '/motd' });
    assert.match(replies.at(-1), /测试服务器/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('首次 /mcbind 先要求登记，确认之后才调用 RCON', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcqq-'));
  try {
    const store = new Storage(dir);
    store.config = { allowedGroups: 'GROUP_OPENID_123' };
    const replies = [];
    const commands = [];
    const bridge = new Bridge(store, { rcon: async (_config, command) => { commands.push(command); return 'ok'; }, send: async (_event, text) => replies.push(text) });
    const event = { kind: 'group', groupOpenid: 'GROUP_OPENID_123', senderId: 'USER_OPENID_123', replyTarget: { scope: 'group', targetId: 'GROUP_OPENID_123' } };
    await bridge.handleEvent({ ...event, messageId: '11', content: '/mcbind implayer' });
    assert.deepEqual(commands, []);
    assert.equal(store.state.bindings.USER_OPENID_123, undefined);
    bridge.lastCommand.delete('USER_OPENID_123');
    await bridge.handleEvent({ ...event, messageId: '12', content: '/qqbind 36000000' });
    const code = replies.at(-1).match(/BIND-[A-F0-9]{6}/)[0];
    await bridge.handleEvent({ ...event, messageId: '13', content: code });
    assert.deepEqual(commands, []);
    bridge.lastCommand.delete('USER_OPENID_123');
    await bridge.handleEvent({ ...event, messageId: '14', content: '/mcbind implayer' });
    assert.deepEqual(commands, ['aqqbot whitelist bind 36000000 implayer']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('同一 QQ 不可被其他 OpenID 冒用，管理员可修改和删除本地记录', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcqq-'));
  try {
    const store = new Storage(dir);
    store.register('USER_OPENID_123', '36000000', 'GROUP_OPENID_123');
    assert.throws(() => store.register('OTHER_OPENID_123', '36000000', 'GROUP_OPENID_123'), /已被/);
    store.recordBinding('USER_OPENID_123', 'implayer', '已发送');
    store.updateUser('USER_OPENID_123', '36000001', 'newplayer');
    assert.equal(store.listUsers()[0].qq, '36000001');
    assert.match(store.listUsers()[0].bindings[0].status, /需核对服务器/);
    store.deleteUser('USER_OPENID_123');
    assert.deepEqual(store.listUsers(), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('一个 QQ 可绑定多个玩家，解绑仅移除指定玩家，最后才能解除 QQ 登记', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcqq-'));
  try {
    const store = new Storage(dir);
    store.register('USER_OPENID_123', '36000000', 'GROUP_OPENID_123');
    const calls = [];
    const bridge = new Bridge(store, { rcon: async (_config, command) => { calls.push(command); return command.includes('unbind') ? '成功解绑' : '成功绑定'; }, send: async () => {} });
    await bridge.bindPlayer('USER_OPENID_123', 'GROUP_OPENID_123', '/mcbind player_one');
    await bridge.bindPlayer('USER_OPENID_123', 'GROUP_OPENID_123', '/mcbind player_two');
    assert.deepEqual(store.getBindings('USER_OPENID_123').map(item => item.player), ['player_one', 'player_two']);
    assert.throws(() => store.unregister('USER_OPENID_123'), /先用 \/mcunbind/);
    assert.match(await bridge.unbindPlayer('USER_OPENID_123', 'GROUP_OPENID_123', '/mcunbind player_one'), /已从当前 QQ 号解绑/);
    assert.deepEqual(store.getBindings('USER_OPENID_123').map(item => item.player), ['player_two']);
    assert.deepEqual(calls, ['aqqbot whitelist bind 36000000 player_one', 'aqqbot whitelist bind 36000000 player_two', 'aqqbot whitelist unbind name player_one']);
    assert.equal(store.state.users.USER_OPENID_123.qq, '36000000');
    await bridge.unbindPlayer('USER_OPENID_123', 'GROUP_OPENID_123', '/mcunbind player_two');
    assert.match(bridge.unbindQq('USER_OPENID_123', '/qqunbind'), /已解除登记/);
    assert.equal(store.state.users.USER_OPENID_123, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('RCON 未确认解绑时保留本地记录；其他 QQ 不能占用相同玩家', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcqq-'));
  try {
    const store = new Storage(dir);
    store.register('USER_OPENID_123', '36000000', 'GROUP_OPENID_123');
    store.register('OTHER_OPENID_123', '36000001', 'GROUP_OPENID_123');
    store.recordBinding('USER_OPENID_123', 'implayer', '已发送');
    assert.throws(() => store.recordBinding('OTHER_OPENID_123', 'ImPlayer', '已发送'), /已绑定其他 QQ/);
    const bridge = new Bridge(store, { rcon: async () => '', send: async () => {} });
    assert.match(await bridge.unbindPlayer('USER_OPENID_123', 'GROUP_OPENID_123', '/mcunbind implayer'), /未明确确认/);
    assert.equal(store.getBindings('USER_OPENID_123').length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('/mcunallbind 仅逐条发送按玩家解绑命令，失败时停止且不删除剩余记录', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcqq-'));
  try {
    const store = new Storage(dir);
    store.register('USER_OPENID_123', '36000000', 'GROUP_OPENID_123');
    for (const player of ['player_one', 'player_two', 'player_three']) store.recordBinding('USER_OPENID_123', player, '已发送');
    const calls = [];
    const bridge = new Bridge(store, { rcon: async (_config, command) => { calls.push(command); return command.includes('player_two') ? '解绑失败' : '成功解绑'; }, send: async () => {} });
    assert.match(await bridge.unbindAllPlayers('USER_OPENID_123', 'GROUP_OPENID_123', '/mcunallbind'), /已停止/);
    assert.deepEqual(calls, ['aqqbot whitelist unbind name player_one', 'aqqbot whitelist unbind name player_two']);
    assert.deepEqual(store.getBindings('USER_OPENID_123').map(item => item.player), ['player_two', 'player_three']);
    assert.equal(store.state.users.USER_OPENID_123.qq, '36000000');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('除 /qqbind 和绑定码外，所有业务命令都要求先登记', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcqq-'));
  try {
    const store = new Storage(dir);
    store.config = { allowedGroups: 'GROUP_OPENID_123' };
    const replies = [];
    const calls = [];
    const bridge = new Bridge(store, { rcon: async (_config, command) => { calls.push(command); return '成功'; }, motd: async () => { calls.push('motd'); return {}; }, send: async (_event, reply) => replies.push(reply) });
    const event = { kind: 'group', groupOpenid: 'GROUP_OPENID_123', senderId: 'USER_OPENID_123', replyTarget: { scope: 'group', targetId: 'GROUP_OPENID_123' } };
    for (const command of ['/qqunbind', '/mcbind implayer', '/mcunbind implayer', '/mcunallbind', '/motd']) {
      bridge.lastCommand.clear();
      await bridge.handleEvent({ ...event, messageId: command, content: command });
      assert.match(replies.at(-1), /\/qqbind/);
    }
    assert.deepEqual(calls, []);
    bridge.lastCommand.clear();
    await bridge.handleEvent({ ...event, messageId: 'legacy', content: '/register 36000000' });
    assert.equal(replies.length, 5);
    await bridge.handleEvent({ ...event, messageId: 'qqbind', content: '/qqbind 36000000' });
    assert.match(replies.at(-1), /BIND-[A-F0-9]{6}/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
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
