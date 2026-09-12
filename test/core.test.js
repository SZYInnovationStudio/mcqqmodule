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
import { makeQqTellraw, parseNameMap } from '../src/qq-chat.js';
import { fetchMcsmOutput, parseMcPlayerChat, McsmOutputRelay } from '../src/mcsm.js';
import { PluginChatExchange, PluginConnectionState, matchesPluginKey } from '../src/plugin-chat.js';

test('/list 仅返回完整的在线玩家名单，零人不显示历史玩家', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcqq-'));
  try {
    const store = new Storage(dir);
    store.register('USER_OPENID_123', '36000000', 'GROUP_OPENID_123');
    store.config = { allowedGroups: 'GROUP_OPENID_123' };
    const replies = [];
    const commands = [];
    const bridge = new Bridge(store, {
      rcon: async (_config, command) => { commands.push(command); return 'There are 2 of a max of 100 players online: Alice, Bob'; },
      send: async (_event, message) => replies.push(message)
    });
    const event = { kind: 'group', groupOpenid: 'GROUP_OPENID_123', senderId: 'USER_OPENID_123', replyTarget: { scope: 'group', targetId: 'GROUP_OPENID_123' }, content: '/list' };
    await bridge.handleEvent(event);
    assert.deepEqual(commands, ['list']);
    assert.equal(replies[0], '当前在线玩家：Alice，Bob');
    assert.deepEqual(parseOnlineList('There are 0 of a max of 100 players online:'), []);
    assert.deepEqual(parseOnlineList('当前有 2 名玩家在线：Alice，Bob'), ['Alice', 'Bob']);
    assert.equal(parseOnlineList('There are 3 of a max of 100 players online: Alice, Bob'), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('QQ 群聊按开关经 RCON 显示；去重、忽略机器人及未知命令', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcqq-'));
  try {
    const store = new Storage(dir);
    store.config = { allowedGroups: 'GROUP_OPENID_123', qqToMcEnabled: true };
    const commands = [];
    const bridge = new Bridge(store, { rcon: async (_config, command) => { commands.push(command); return ''; }, send: async () => {} });
    const event = { kind: 'group', groupOpenid: 'GROUP_OPENID_123', senderId: 'USER_OPENID_123', senderName: '群昵称', replyTarget: { scope: 'group', targetId: 'GROUP_OPENID_123' }, messageId: 'chat-1', content: '你好' };
    await bridge.handleEvent(event);
    await bridge.handleEvent(event);
    await bridge.handleEvent({ ...event, senderIsBot: true, messageId: 'chat-2' });
    await bridge.handleEvent({ ...event, messageId: 'chat-3', content: '/unknown' });
    assert.equal(commands.length, 1);
    assert.match(commands[0], /^tellraw @a /);
    const payload = JSON.parse(commands[0].slice('tellraw @a '.length));
    assert.deepEqual(payload.extra, [{ text: '[QQ群]', color: 'green' }, { text: ' 群昵称：你好' }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('QQ 文本不会注入 RCON 命令或颜色；只允许模板控制样式', () => {
  const command = makeQqTellraw('&a[QQ群]&r ${userName}: ${message}', { userName: 'A&c', message: 'hello "}\nstop\n&a', groupId: 'G' });
  assert.ok(!command.includes('\n'));
  assert.match(command, /^tellraw @a /);
  const payload = JSON.parse(command.slice('tellraw @a '.length));
  assert.deepEqual(payload.extra, [{ text: '[QQ群]', color: 'green' }, { text: ' A&c: hello "} stop &a' }]);
  assert.throws(() => makeQqTellraw('${bad} ${userName} ${message}', { userName: 'x', message: 'y' }), /占位符/);
});

test('QQ 昵称附带的不可见状态字符不进入 MC 聊天', () => {
  const command = makeQqTellraw('&a[${groupName}]&r ${userName}：${message}', {
    userName: 'Beibing\u2067', groupName: '生存群', message: '我试试'
  });
  const payload = JSON.parse(command.slice('tellraw @a '.length));
  assert.deepEqual(payload.extra, [{ text: '[生存群]', color: 'green' }, { text: ' Beibing：我试试' }]);
  assert.ok(!command.includes('\u2067'));
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
    const commands = [];
    const bridge = new Bridge(store, { rcon: async (_config, command) => commands.push(command) });
    await bridge.handleEvent({ kind: 'group', groupOpenid: 'GROUP_OPENID_123', senderId: 'USER_OPENID_123', senderName: 'Beibing', replyTarget: { scope: 'group', targetId: 'GROUP_OPENID_123' }, content: '进服测试' });
    const payload = JSON.parse(commands[0].slice('tellraw @a '.length));
    assert.deepEqual(payload.extra, [{ text: '[生存群]', color: 'green' }, { text: ' AAA钻石批发：进服测试' }]);
    assert.equal(parseNameMap('GROUP_OPENID_123=生存群').get('GROUP_OPENID_123'), '生存群');
    assert.throws(() => parseNameMap('GROUP_OPENID_123=一\nGROUP_OPENID_123=二'), /重复/);
    assert.throws(() => validateConfig({ groupNames: 'bad line' }), /群名称映射格式/);
    assert.equal(publicConfig({ qqToMcTemplate: '&a[QQ群]&r ${userName}: ${message}' }).qqToMcTemplate, '&a[${groupName}]&r ${userName}：${message}');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('MCSManager 输出接口仅后台使用密钥，并识别玩家聊天', async () => {
  const config = { mcsmBaseUrl: 'https://panel.example.com/', mcsmApiKey: 'secret-key', mcsmDaemonId: 'daemon_123', mcsmInstanceUuid: 'instance_123' };
  const calls = [];
  const output = await fetchMcsmOutput(config, async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ status: 200, data: '[12:00:00] [Server thread/INFO]: <Alice> hello\n' }) };
  });
  assert.match(calls[0].url.href, /protected_instance\/outputlog/);
  assert.equal(calls[0].url.searchParams.get('apikey'), 'secret-key');
  assert.equal(calls[0].url.searchParams.get('uuid'), 'instance_123');
  assert.equal(calls[0].options.headers['X-Requested-With'], 'XMLHttpRequest');
  assert.deepEqual(parseMcPlayerChat(output.trim()), { player: 'Alice', content: 'hello' });
  assert.equal(parseMcPlayerChat('[12:00:00] [Server thread/INFO]: [QQ群] x: hello'), null);
  await assert.rejects(fetchMcsmOutput(config, async () => ({ ok: false, status: 403 })), /HTTP 403/);
  await assert.rejects(fetchMcsmOutput(config, async () => ({ ok: false, status: 403, json: async () => ({ status: 403, data: 'The administrator has disabled the use of the API key. Set "enableApiKey" to "true".' }) })), /启用 enableApiKey/);
});

test('MC 输出轮询先建立基线，只转发后来完整的新聊天', async () => {
  const delivered = [];
  const snapshots = [
    '[12:00:00] [Server thread/INFO]: <Alice> old\n',
    '[12:00:00] [Server thread/INFO]: <Alice> old\n[12:00:01] [Server thread/INFO]: <Bob> new\n',
    '[12:00:00] [Server thread/INFO]: <Alice> old\n[12:00:01] [Server thread/INFO]: <Bob> new\n'
  ];
  const relay = new McsmOutputRelay({}, chat => delivered.push(chat), error => { throw error; }, async () => snapshots.shift());
  relay.running = true;
  await relay.poll(); await relay.poll(); await relay.poll();
  relay.stop();
  assert.deepEqual(delivered, [{ player: 'Bob', content: 'new' }]);
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
  assert.equal(next.chatTransport, 'plugin');
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

test('插件玩家进出服播报包含当时的在线人数和名单，重复事件不重发', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcqq-'));
  try {
    const store = new Storage(dir);
    store.config = { allowedGroups: 'GROUP_OPENID_123', chatTransport: 'plugin', mcToQqEnabled: true };
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
      '[服务器] Alice 进入了服务器\n在线玩家（1）：Alice',
      '[服务器] Alice 离开了服务器\n在线玩家（0）：无'
    ]);
    bridge.exchangePluginChat({ ack: 0, sent: events });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sent.length, 2);
    store.config.mcToQqEnabled = false;
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

test('开关服状态只在插件模式且 MC → QQ 开启时发群，Bot 未就绪先等候', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcqq-'));
  try {
    const store = new Storage(dir);
    store.config = { allowedGroups: 'GROUP_OPENID_123', chatTransport: 'plugin', mcToQqEnabled: true };
    const bridge = new Bridge(store);
    const sent = [];
    bridge.exchangePluginChat({ ack: 0, sent: [] });
    assert.equal(bridge.pendingServerStatus, 'online');
    bridge.bot = { sendText: async (_target, content) => sent.push(content) };
    bridge.status = '已连接';
    await bridge.flushPendingServerStatus();
    assert.deepEqual(sent, ['[服务器] MC 服务器已上线']);
    bridge.exchangePluginChat({ ack: 0, sent: [] });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sent.length, 1);
    assert.equal(bridge.pluginConnection.check(bridge.pluginConnection.lastSeen + 30_000), 'offline');
    await bridge.sendMcServerStatusToQq('offline');
    assert.deepEqual(sent, [
      '[服务器] MC 服务器已上线',
      '[服务器] MC 服务器已离线（可能是关服或插件连接中断）'
    ]);
    store.config.mcToQqEnabled = false;
    bridge.exchangePluginChat({ ack: 0, sent: [] });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sent.length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('配置密钥加密保存且读取时不回传', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcqq-'));
  try {
    const store = new Storage(dir);
    const config = validateConfig({ rconPassword: 'secret-pass', qqAppId: '12345678', qqAppSecret: 'secret-bot', allowedGroups: 'GROUP_OPENID_123', mcsmBaseUrl: 'https://mcsm.example.com/', mcsmApiKey: 'secret-mcsm', mcsmDaemonId: 'daemon_123', mcsmInstanceUuid: 'instance_123' });
    store.saveConfig(config);
    const raw = readFileSync(join(dir, 'config.enc'), 'utf8');
    assert.ok(!raw.includes('secret-pass'));
    assert.ok(!raw.includes('secret-mcsm'));
    assert.equal(publicConfig(config).qqAppSecret, undefined);
    assert.equal(publicConfig(config).qqAppSecretSet, true);
    assert.equal(publicConfig(config).mcsmApiKey, undefined);
    assert.equal(publicConfig(config).mcsmApiKeySet, true);
    assert.equal(publicConfig(config).mcsmBaseUrl, 'https://mcsm.example.com');
    assert.equal(publicConfig(config).mcsmDaemonId, 'daemon_123');
    assert.equal(validateConfig({ mcsmApiKey: '' }, config).mcsmApiKey, 'secret-mcsm');
    assert.throws(() => validateConfig({ mcsmBaseUrl: 'https://user:pass@mcsm.example.com/' }, config), /格式不合法/);
    assert.equal(validateConfig({ qqAppSecret: '' }, config).qqAppSecret, 'secret-bot');
    assert.equal(publicConfig(config).mcToQqEnabled, false);
    assert.equal(publicConfig(config).qqToMcEnabled, false);
    const toggled = validateConfig({ mcToQqEnabled: true, qqToMcEnabled: false }, config);
    assert.equal(publicConfig(toggled).mcToQqEnabled, true);
    assert.equal(publicConfig(toggled).qqToMcEnabled, false);
    assert.equal(publicConfig(toggled).qqToMcTemplate, '&a[${groupName}]&r ${userName}：${message}');
    assert.throws(() => validateConfig({ mcToQqEnabled: true }, { qqAppId: '12345678', qqAppSecret: 'x', allowedGroups: 'GROUP_OPENID_123' }), /MCSManager/);
    assert.throws(() => validateConfig({ qqToMcEnabled: 'anything' }, config), /开关格式无效/);
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
    const bridge = new Bridge(store, { motd: async () => ({ motd: '测试服务器', online: 5, max: 100, players: ['谢谢', 'xx', 'xx2', 'xx3'] }), send: async (_event, message) => replies.push(message) });
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
    assert.match(replies.at(-1), /当前在线：5 人（上限 100 人）/);
    assert.match(replies.at(-1), /在线玩家：（谢谢，xx，xx2，xx3；仅显示服务器提供的 4 人）/);
    assert.ok(replies.at(-1).indexOf('当前在线') < replies.at(-1).indexOf('服务器介绍'));
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
