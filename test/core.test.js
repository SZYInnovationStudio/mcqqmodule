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
import { parseOnlineList } from '../src/chat-relay.js';
import { makeQqComponents, parseNameMap } from '../src/qq-chat.js';
import { PluginChatExchange, PluginConnectionState, matchesPluginKey } from '../src/plugin-chat.js';

test('/list 显示当前在线人数和完整名单，零人显示无且不显示历史玩家', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcqq-'));
  try {
    const store = new Storage(dir);
    store.register('USER_OPENID_123', '36000000', 'GROUP_OPENID_123');
    store.config = { allowedGroups: 'GROUP_OPENID_123' };
    const replies = [];
    const commands = [];
    let rconOutput = 'There are 2 of a max of 100 players online: Alice, Bob';
    const bridge = new Bridge(store, {
      rcon: async (_config, command) => { commands.push(command); return rconOutput; },
      send: async (_event, message) => replies.push(message)
    });
    const event = { kind: 'group', groupOpenid: 'GROUP_OPENID_123', senderId: 'USER_OPENID_123', replyTarget: { scope: 'group', targetId: 'GROUP_OPENID_123' }, content: '/list' };
    await bridge.handleEvent(event);
    assert.deepEqual(commands, ['list']);
    assert.equal(replies[0], '在线玩家（2）：Alice，Bob');
    rconOutput = 'There are 0 of a max of 100 players online:';
    bridge.lastCommand.delete('USER_OPENID_123');
    await bridge.handleEvent({ ...event, messageId: 'empty-list' });
    assert.equal(replies[1], '在线玩家（0）：无');
    assert.deepEqual(parseOnlineList('There are 0 of a max of 100 players online:'), []);
    assert.deepEqual(parseOnlineList('当前有 2 名玩家在线：Alice，Bob'), ['Alice', 'Bob']);
    assert.equal(parseOnlineList('There are 3 of a max of 100 players online: Alice, Bob'), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('QQ 群聊只进入独立插件队列；去重并忽略未知命令', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcqq-'));
  try {
    const store = new Storage(dir);
    store.config = { allowedGroups: 'GROUP_OPENID_123', qqToMcEnabled: true, chatTransport: 'direct' };
    const calls = [];
    const bridge = new Bridge(store, { rcon: async (_config, command) => { calls.push(command); return ''; } });
    const event = { kind: 'group', groupOpenid: 'GROUP_OPENID_123', senderId: 'USER_OPENID_123', senderName: '群昵称', replyTarget: { scope: 'group', targetId: 'GROUP_OPENID_123' }, messageId: 'chat-1', content: '你好' };
    await bridge.handleEvent(event);
    await bridge.handleEvent(event);
    await bridge.handleEvent({ ...event, senderIsBot: true, messageId: 'chat-2' });
    await bridge.handleEvent({ ...event, messageId: 'chat-3', content: '/unknown' });
    assert.deepEqual(calls, []);
    const queued = bridge.exchangePluginChat({ ack: 0, sent: [] }).receive;
    assert.equal(queued.length, 1);
    assert.deepEqual(queued[0].components, [{ text: '[QQ群]', color: 'green' }, { text: ' 群昵称：你好' }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('QQ 文本不会注入 RCON 命令或颜色；只允许模板控制样式', () => {
  const command = makeQqComponents('&a[QQ群]&r ${userName}: ${message}', { userName: 'A&c', message: 'hello "}\nstop\n&a', groupId: 'G' });
  assert.deepEqual(command, [{ text: '[QQ群]', color: 'green' }, { text: ' A&c: hello "} stop &a' }]);
  assert.throws(() => makeQqComponents('${bad} ${userName} ${message}', { userName: 'x', message: 'y' }), /占位符/);
});

test('QQ 昵称附带的不可见状态字符不进入 MC 聊天', () => {
  const command = makeQqComponents('&a[${groupName}]&r ${userName}：${message}', {
    userName: 'Beibing\u2067', groupName: '生存群', message: '我试试'
  });
  assert.deepEqual(command, [{ text: '[生存群]', color: 'green' }, { text: ' Beibing：我试试' }]);
  assert.ok(!JSON.stringify(command).includes('\u2067'));
});

test('群名称与成员名按 OpenID 映射，旧模板自动升级', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcqq-'));
  try {
    const store = new Storage(dir);
    store.config = {
      allowedGroups: 'GROUP_OPENID_123', qqToMcEnabled: true,
      qqToMcTemplate: '&a[QQ群]&r ${userName}: ${message}',
      groupNames: 'GROUP_OPENID_123=生存群', memberNames: 'USER_OPENID_123=AAA钻石批发'
    };
    const bridge = new Bridge(store, { rcon: async () => { throw new Error('聊天不能调用 RCON'); } });
    await bridge.handleEvent({ kind: 'group', groupOpenid: 'GROUP_OPENID_123', senderId: 'USER_OPENID_123', senderName: 'Beibing', replyTarget: { scope: 'group', targetId: 'GROUP_OPENID_123' }, content: '进服测试' });
    const queued = bridge.exchangePluginChat({ ack: 0, sent: [] }).receive;
    assert.deepEqual(queued[0].components, [{ text: '[生存群]', color: 'green' }, { text: ' AAA钻石批发：进服测试' }]);
    assert.equal(parseNameMap('GROUP_OPENID_123=生存群').get('GROUP_OPENID_123'), '生存群');
    assert.throws(() => parseNameMap('GROUP_OPENID_123=一\nGROUP_OPENID_123=二'), /重复/);
    assert.throws(() => validateConfig({ groupNames: 'bad line' }), /群名称映射格式/);
    assert.equal(publicConfig({ qqToMcTemplate: '&a[QQ群]&r ${userName}: ${message}' }).qqToMcTemplate, '&a[${groupName}]&r ${userName}：${message}');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('MC → QQ 只在开关开启且机器人就绪时推送到允许群', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcqq-'));
  try {
    const store = new Storage(dir);
    store.config = { allowedGroups: 'GROUP_OPENID_123,GROUP_OPENID_456', mcToQqEnabled: true };
    const sent = [];
    const bridge = new Bridge(store);
    bridge.bot = { sendText: async (target, content) => sent.push({ target, content }) };
    bridge.status = '已连接';
    await bridge.sendMcChatToQq({ player: 'Alice', content: '你好' });
    assert.deepEqual(sent.map(item => item.target.targetId), ['GROUP_OPENID_123', 'GROUP_OPENID_456']);
    assert.equal(sent[0].content, '[服务器] Alice: 你好');
    bridge.stopped = true;
    await bridge.sendMcChatToQq({ player: 'Alice', content: '不发送' });
    assert.equal(sent.length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('插件双向交换去重并等待确认，不依赖 MCSManager 或 RCON 聊天配置', async () => {
  const received = [];
  const exchange = new PluginChatExchange(chat => received.push(chat));
  exchange.enqueue([{ text: '[QQ群]', color: 'green' }, { text: ' Alice：你好' }]);
  const incoming = { ack: 0, sent: [{ id: 'run12345-1', player: 'Steve', message: 'hello' }] };
  const first = exchange.exchange(incoming);
  assert.equal(first.receive.length, 1);
  assert.ok(first.epoch);
  assert.equal(exchange.exchange(incoming).receive.length, 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(received, [{ player: 'Steve', content: 'hello' }]);
  assert.deepEqual(exchange.exchange({ ack: 1, epoch: first.epoch, sent: [] }).receive, []);
  assert.throws(() => exchange.exchange({ ack: 1, sent: [{ id: 'bad', player: 'Steve', message: 'x' }] }), /格式/);
  const next = validateConfig({ chatTransport: 'plugin', pluginKey: 'A'.repeat(40), qqToMcEnabled: true, mcToQqEnabled: true, qqAppId: '12345678', qqAppSecret: 'secret', allowedGroups: 'GROUP_OPENID_123' });
  assert.equal(publicConfig(next).chatTransport, 'plugin');
  assert.equal(publicConfig(next).pluginKey, undefined);
  assert.equal(publicConfig(next).pluginKeySet, true);
  assert.equal(matchesPluginKey(`Bearer ${next.pluginKey}`, next.pluginKey), true);
  assert.equal(matchesPluginKey('Bearer wrong-key', next.pluginKey), false);
});

test('插件模式 QQ → MC 排队给插件，不调用 RCON', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcqq-'));
  try {
    const store = new Storage(dir);
    store.config = { allowedGroups: 'GROUP_OPENID_123', qqToMcEnabled: true, chatTransport: 'plugin' };
    const commands = [];
    const bridge = new Bridge(store, { rcon: async (_config, command) => commands.push(command) });
    await bridge.handleEvent({ kind: 'group', groupOpenid: 'GROUP_OPENID_123', senderId: 'USER_OPENID_123', senderName: 'Alice', replyTarget: { scope: 'group', targetId: 'GROUP_OPENID_123' }, content: '你好' });
    assert.deepEqual(commands, []);
    const received = bridge.exchangePluginChat({ ack: 0, sent: [] }).receive;
    assert.equal(received.length, 1);
    assert.deepEqual(received[0].components, [{ text: '[QQ群]', color: 'green' }, { text: ' Alice：你好' }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('插件玩家进出服只播报玩家动作，重复事件不重发', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcqq-'));
  try {
    const store = new Storage(dir);
    store.config = { allowedGroups: 'GROUP_OPENID_123', chatTransport: 'plugin', mcToQqEnabled: true, presenceNotifyEnabled: true };
    const sent = [];
    const bridge = new Bridge(store);
    bridge.bot = { sendText: async (_target, content) => sent.push(content) };
    bridge.status = '已连接';
    bridge.pluginConnection.observe();
    const events = [
      { id: 'run12345-join', kind: 'join', player: 'Alice', players: ['Alice'] },
      { id: 'run12345-quit', kind: 'quit', player: 'Alice', players: [] }
    ];
    bridge.exchangePluginChat({ ack: 0, sent: events });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(sent, [
      'Alice 进入了服务器',
      'Alice 离开了服务器'
    ]);
    bridge.exchangePluginChat({ ack: 0, sent: events });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sent.length, 2);
    store.config.presenceNotifyEnabled = false;
    bridge.exchangePluginChat({ ack: 0, sent: [{ id: 'run12345-next', kind: 'join', player: 'Bob', players: ['Bob'] }] });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sent.length, 2);
    assert.throws(() => bridge.exchangePluginChat({ ack: 0, sent: [{ id: 'run12345-bad', kind: 'join', player: 'Bob', players: 'Bob' }] }), /格式/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('插件心跳只在上线和连续断开 30 秒后触发状态变化', () => {
  const monitor = new PluginConnectionState();
  assert.equal(monitor.check(30_000), null);
  assert.equal(monitor.observe(1_000), 'online');
  assert.equal(monitor.observe(10_000), null);
  assert.equal(monitor.check(39_999), null);
  assert.equal(monitor.check(40_000), 'offline');
  assert.equal(monitor.check(50_000), null);
  assert.equal(monitor.observe(50_001), 'online');
});

test('开关服状态使用无项目前缀模板，Bot 未就绪先等候', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcqq-'));
  try {
    const store = new Storage(dir);
    store.config = { allowedGroups: 'GROUP_OPENID_123', chatTransport: 'plugin', mcToQqEnabled: true, serverStatusNotifyEnabled: true };
    const bridge = new Bridge(store);
    const sent = [];
    bridge.exchangePluginChat({ ack: 0, sent: [] });
    assert.equal(bridge.pendingServerStatus, 'online');
    bridge.bot = { sendText: async (_target, content) => sent.push(content) };
    bridge.status = '已连接';
    await bridge.flushPendingServerStatus();
    assert.deepEqual(sent, ['服务器已开启']);
    bridge.exchangePluginChat({ ack: 0, sent: [] });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sent.length, 1);
    assert.equal(bridge.pluginConnection.check(bridge.pluginConnection.lastSeen + 30_000), 'offline');
    await bridge.sendMcServerStatusToQq('offline');
    assert.deepEqual(sent, [
      '服务器已开启',
      '服务器已关闭'
    ]);
    store.config.serverStatusNotifyEnabled = false;
    bridge.exchangePluginChat({ ack: 0, sent: [] });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sent.length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('插件是唯一聊天连接；旧配置字段不再回传或保存', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcqq-'));
  try {
    const store = new Storage(dir);
    const config = validateConfig({ rconPassword: 'secret-pass', qqAppId: '12345678', qqAppSecret: 'secret-bot', allowedGroups: 'GROUP_OPENID_123', pluginKey: 'A'.repeat(40), qqToMcEnabled: true, mcToQqEnabled: true });
    store.saveConfig({ ...config, chatTransport: 'direct', mcsmBaseUrl: 'https://old.example.com', mcsmApiKey: 'old-secret' });
    const loaded = new Storage(dir);
    assert.equal(loaded.config.chatTransport, undefined);
    assert.equal(loaded.config.mcsmApiKey, undefined);
    assert.equal(publicConfig(loaded.config).chatTransport, 'plugin');
    assert.equal(publicConfig(loaded.config).mcsmApiKeySet, undefined);
    assert.equal(publicConfig(loaded.config).pluginKeySet, true);
    assert.equal(publicConfig(loaded.config).qqAppSecretSet, true);
    assert.equal(publicConfig(loaded.config).qqToMcEnabled, true);
    assert.equal(publicConfig(loaded.config).mcToQqEnabled, true);
    assert.ok(!readFileSync(join(dir, 'config.enc'), 'utf8').includes('old-secret'));
    assert.throws(() => validateConfig({ chatTransport: 'direct' }, config), /只支持独立插件/);
    assert.throws(() => validateConfig({ mcToQqEnabled: true }, { qqAppId: '12345678', qqAppSecret: 'x', allowedGroups: 'GROUP_OPENID_123' }), /插件 Key/);
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

test('官方 Bot 自填 QQ 并二次核对后登记，MC 绑定以 AQQBot 为准', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcqq-'));
  try {
    const store = new Storage(dir);
    const calls = [];
    let owner = null;
    const bridge = new Bridge(store, { rcon: async (_config, command) => {
      calls.push(command);
      if (command.startsWith('aqqbot whitelist query player')) return 'QQ号: ' + (owner ?? 'null') + '\\n游戏名: implayer';
      if (command.startsWith('aqqbot whitelist bind')) { owner = '36000000'; return '成功绑定'; }
      throw new Error('意外命令');
    } });
    const reply = bridge.beginRegistration('USER_OPENID_123', 'GROUP_OPENID_123', '/qqbind 36000000');
    const code = reply.match(/BIND-[A-F0-9]{6}/)[0];
    assert.match(bridge.confirmRegistration('OTHER_OPENID_123', 'GROUP_OPENID_123', code), /无效/);
    assert.match(bridge.confirmRegistration('USER_OPENID_123', 'GROUP_OPENID_123', code), /已登记/);
    assert.equal(store.state.users.USER_OPENID_123.qq, '36000000');
    assert.equal(store.state.bindings, undefined);
    assert.deepEqual(calls, []);
    assert.match(await bridge.bindPlayer('USER_OPENID_123', 'GROUP_OPENID_123', '/mcbind implayer'), /已为玩家 implayer 发送 AQQBot 绑定命令/);
    assert.deepEqual(calls, ['aqqbot whitelist query player implayer', 'aqqbot whitelist bind 36000000 implayer', 'aqqbot whitelist query player implayer']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('未登记时任何功能命令先要求登记，登记后才能查询', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcqq-'));
  try {
    const store = new Storage(dir);
    store.config = { allowedGroups: 'GROUP_OPENID_123' };
    const replies = [];
    const bridge = new Bridge(store, { motd: async () => ({ motd: '测试服务器', online: 5, max: 100, players: ['谢谢', 'xx', 'xx2', 'xx3'] }), send: async (_event, message) => replies.push(message) });
    const event = { kind: 'group', groupOpenid: 'GROUP_OPENID_123', senderId: 'USER_OPENID_123', replyTarget: { scope: 'group', targetId: 'GROUP_OPENID_123' } };
    await bridge.handleEvent({ ...event, messageId: '1', content: '/motd' });
    assert.match(replies[0], /\/qqbind/);
    bridge.lastCommand.clear();
    await bridge.handleEvent({ ...event, messageId: '2', content: '/qqbind 36000000' });
    const code = replies.at(-1).match(/BIND-[A-F0-9]{6}/)[0];
    await bridge.handleEvent({ ...event, messageId: '3', content: code });
    assert.ok(store.state.users.USER_OPENID_123);
    bridge.lastCommand.clear();
    await bridge.handleEvent({ ...event, messageId: '4', content: '/motd' });
    assert.match(replies.at(-1), /测试服务器/);
    assert.match(replies.at(-1), /当前在线：5 人（上限 100 人）/);
    assert.match(replies.at(-1), /在线玩家：（谢谢，xx，xx2，xx3；仅显示服务器提供的 4 人）/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('同一 QQ 只能登记到一个 OpenID', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcqq-'));
  try {
    const store = new Storage(dir);
    store.register('USER_OPENID_123', '36000000', 'GROUP_OPENID_123');
    assert.throws(() => store.register('OTHER_OPENID_123', '36000000', 'GROUP_OPENID_123'), /已被/);
    store.unregister('USER_OPENID_123');
    assert.equal(store.qqOwner('36000000'), null);
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
    for (const command of ['/qqunbind', '/mcbind implayer', '/mcunbind implayer', '/mcunallbind', '/mymc', '/motd']) {
      bridge.lastCommand.clear();
      await bridge.handleEvent({ ...event, messageId: command, content: command });
      assert.match(replies.at(-1), /\/qqbind/);
    }
    assert.deepEqual(calls, []);
    assert.equal(store.listPlayerLog().length, 6);
    assert.equal(store.listPlayerLog()[0].status, '未登记拦截');
    assert.equal(store.listPlayerLog()[0].category, '服务器查询');
    bridge.lastCommand.clear();
    await bridge.handleEvent({ ...event, messageId: 'legacy', content: '/register 36000000' });
    assert.equal(replies.length, 6);
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

test('MOTD 状态协议读取描述、在线人数和服务器公开的玩家名单', async () => {
  const encodeVarint = value => {
    const bytes = [];
    do { bytes.push((value & 0x7f) | (value > 127 ? 0x80 : 0)); value >>>= 7; } while (value);
    return Buffer.from(bytes);
  };
  const payload = Buffer.from(JSON.stringify({ description: { text: 'Hello ', extra: [{ text: 'World' }] }, players: { online: 2, max: 10, sample: [{ name: '谢谢', id: '1' }, { name: 'xx', id: '2' }] }, version: { name: '1.21' } }));
  const size = encodeVarint(payload.length);
  const response = Buffer.concat([encodeVarint(1 + size.length + payload.length), Buffer.from([0]), size, payload]);
  const server = net.createServer(socket => socket.once('data', () => socket.write(response)));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await queryMotd({ mcHost: '127.0.0.1', mcPort: server.address().port });
    assert.equal(result.motd, 'Hello World');
    assert.equal(result.online, 2);
    assert.deepEqual(result.players, ['谢谢', 'xx']);
  } finally { await new Promise(resolve => server.close(resolve)); }
});


test('插件整库快照只接受受限 QQ 和玩家数据，并关联登记 OpenID', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcqq-snapshot-'));
  const store = new Storage(dir);
  store.register('OPENID_12345', '12345678', 'GROUP_OPENID_123');
  const bridge = new Bridge(store);
  bridge.exchangePluginChat({
    ack: 0,
    sent: [],
    aqqbotSnapshot: {
      available: true,
      capturedAt: Date.now(),
      rows: [
        { qq: '12345678', players: ['00123', 'Steve', 'bad name', 'Steve'] },
        { qq: 'not-qq', players: ['Alex'] }
      ]
    }
  });
  const snapshot = bridge.getAqqbotDatabase();
  assert.equal(snapshot.available, true);
  assert.deepEqual(snapshot.rows, [{ qq: '12345678', players: ['00123', 'Steve'], openid: 'OPENID_12345' }]);
  rmSync(dir, { recursive: true, force: true });
});


test('8.7.0 服务器日志批次受开关、大小限制和批次去重保护，并记录插件版本', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcqq-server-log-'));
  try {
    const store = new Storage(dir);
    store.config = { serverLogEnabled: true };
    const bridge = new Bridge(store);
    const request = {
      ack: 0, sent: [], pluginVersion: '1.1.3',
      serverLogs: { source: 'run12345', start: 10, end: 30, lines: ['[INFO] started', '[WARN] sample'] }
    };
    assert.equal(bridge.exchangePluginChat(request).logEnabled, true);
    assert.equal(bridge.pluginVersion, '1.1.3');
    assert.deepEqual(bridge.getServerLogs().lines.map(item => item.line), ['[INFO] started', '[WARN] sample']);
    bridge.exchangePluginChat(request);
    assert.equal(bridge.getServerLogs().lines.length, 2);
    bridge.exchangePluginChat({ ack: 0, sent: [], serverLogs: { source: 'run12345', start: 30, end: 40, lines: ['x'.repeat(1001)] } });
    assert.equal(bridge.getServerLogs().lines.length, 2);
    store.config.serverLogEnabled = false;
    assert.equal(bridge.exchangePluginChat({ ack: 0, sent: [] }).logEnabled, false);
    assert.throws(() => bridge.exchangePluginChat({ ack: 0, sent: [], pluginVersion: 'bad version' }), /插件版本格式无效/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
