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

test('管理员 RCON 执行日志加密持久化并记录成功与失败', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcqq-'));
  try {
    const store = new Storage(dir);
    store.recordRconCommand('say private-test', '服务器已执行 private-test', true, 'admin');
    store.recordRconCommand('list', 'RCON 连接失败', false, 'admin');
    const raw = readFileSync(join(dir, 'rcon-log.enc'), 'utf8');
    assert.ok(!raw.includes('private-test'));
    assert.ok(!raw.includes('RCON 连接失败'));
    const entries = new Storage(dir).listRconLog();
    assert.equal(entries.length, 2);
    assert.deepEqual(entries.map(item => item.success), [false, true]);
    assert.equal(entries[0].command, 'list');
    assert.equal(entries[1].output, '服务器已执行 private-test');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('QQ 玩家命令日志单独加密保存，最多保留 200 条', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcqq-'));
  try {
    const store = new Storage(dir);
    for (let index = 0; index < 205; index++) {
      store.recordPlayerCommand({ openid: 'USER_OPENID_123', group: 'GROUP_OPENID_123', qq: '36000000', command: `/motd ${index}`, category: '服务器查询', status: '已回复', result: '在线：1 / 20' });
    }
    const raw = readFileSync(join(dir, 'player-log.enc'), 'utf8');
    assert.ok(!raw.includes('USER_OPENID_123'));
    assert.ok(!raw.includes('/motd 204'));
    const entries = new Storage(dir).listPlayerLog();
    assert.equal(entries.length, 200);
    assert.equal(entries[0].command, '/motd 204');
    assert.equal(entries.at(-1).command, '/motd 5');
    assert.equal(entries[0].category, '服务器查询');
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

test('旧版单玩家记录加载后保留并转换为多玩家结构', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcqq-'));
  try {
    const store = new Storage(dir);
    store.register('USER_OPENID_123', '36000000', 'GROUP_OPENID_123');
    store.state.bindings.USER_OPENID_123 = { player: 'oldplayer', status: '已发送', updatedAt: '2026-01-01T00:00:00.000Z' };
    store.saveState();
    const restored = new Storage(dir);
    assert.deepEqual(restored.getBindings('USER_OPENID_123').map(item => item.player), ['oldplayer']);
    restored.recordBinding('USER_OPENID_123', 'newplayer', '已发送');
    assert.equal(new Storage(dir).getBindings('USER_OPENID_123').length, 2);
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

test('服务器明确拒绝绑定时不占用玩家名', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcqq-'));
  try {
    const store = new Storage(dir);
    store.register('USER_OPENID_123', '36000000', 'GROUP_OPENID_123');
    const bridge = new Bridge(store, { rcon: async () => '绑定失败：已达到上限', send: async () => {} });
    assert.match(await bridge.bindPlayer('USER_OPENID_123', 'GROUP_OPENID_123', '/mcbind implayer'), /未添加本地记录/);
    assert.deepEqual(store.getBindings('USER_OPENID_123'), []);
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
    assert.equal(store.listPlayerLog().length, 5);
    assert.equal(store.listPlayerLog()[0].status, '未登记拦截');
    assert.equal(store.listPlayerLog()[0].category, '服务器查询');
    bridge.lastCommand.clear();
    await bridge.handleEvent({ ...event, messageId: 'legacy', content: '/register 36000000' });
    assert.equal(replies.length, 5);
    await bridge.handleEvent({ ...event, messageId: 'qqbind', content: '/qqbind 36000000' });
    assert.match(replies.at(-1), /BIND-[A-F0-9]{6}/);
    assert.equal(store.listPlayerLog()[0].category, 'QQ 登记');
    assert.ok(!store.listPlayerLog()[0].result.includes(replies.at(-1).match(/BIND-[A-F0-9]{6}/)[0]));
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
