import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { OneBotLink, parseGroupMessage, extractText, safeEqual, parseMetaEvent } from '../src/onebot.js';

const onebotSource = readFileSync(new URL('../src/onebot.js', import.meta.url), 'utf8');

test('【硬约束】OneBot 只收不发，源码中不存在任何发送消息的调用', () => {
  // OneBot v11 的所有 outgoing 动作名都不允许出现
  const forbidden = [
    'send_group_msg',
    'send_private_msg',
    'send_msg',
    'send_group_forward_msg',
    'send_private_forward_msg',
    'delete_msg',
    'set_group_ban',
    'set_group_kick'
  ];
  for (const action of forbidden) {
    assert.doesNotMatch(
      onebotSource,
      new RegExp(`['"\`]${action}['"\`]`),
      `onebot.js 不允许调用 ${action}：监听 Bot 只能收消息，发言必须走官方 Bot`
    );
  }
  // 也不允许自己拼 action 帧，或直接往连接里写数据
  assert.doesNotMatch(onebotSource, /action\s*:/, 'onebot.js 不允许构造 OneBot action 帧');
  assert.doesNotMatch(onebotSource, /\.send\s*\(/, 'onebot.js 不允许向连接写入任何数据');
});

test('【硬约束】OneBotLink 的发送入口会直接抛错而不是静默发送', () => {
  const link = new OneBotLink({ enabled: true });
  assert.throws(
    () => link.send('987654321', '这条消息不应该发出去'),
    /OneBot 监听 Bot 只接收消息，不发送任何群消息/
  );
  link.stop();
});

test('【硬约束】bridge 里的群发言只经过官方 Bot', () => {
  const bridgeSource = readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
  // 所有发送都必须落在 this.bot 上
  const sends = [...bridgeSource.matchAll(/await\s+(this\.[A-Za-z0-9_.]+)\.(sendText|send)\s*\(/g)].map(m => m[1]);
  for (const target of sends) {
    assert.ok(
      target === 'this.bot' || target === 'this',
      `群发言必须走官方 Bot，发现可疑发送目标：${target}`
    );
  }
  // 绝不能出现 onebot 相关的发送
  assert.doesNotMatch(bridgeSource, /this\.onebot\.send/, 'bridge 不允许通过 OneBot 发送消息');
});

test('解析 OneBot v11 群消息，取出真实 QQ 号与群号', () => {
  const message = parseGroupMessage({
    post_type: 'message',
    message_type: 'group',
    self_id: 10001,
    group_id: 987654321,
    user_id: 123456789,
    message_id: 555,
    time: 1700000000,
    sender: { card: '群名片甲', nickname: '昵称乙' },
    message: [{ type: 'text', data: { text: '你好世界' } }]
  });
  assert.equal(message.groupId, '987654321');
  assert.equal(message.userId, '123456789');
  assert.equal(message.text, '你好世界');
  // 群名片优先于昵称
  assert.equal(message.displayName, '群名片甲');
  assert.equal(message.nickname, '昵称乙');
});

test('没有群名片时回退到昵称，再回退到 QQ 号', () => {
  const base = { post_type: 'message', message_type: 'group', group_id: 1, user_id: 2, message: [] };
  const withNick = parseGroupMessage({ ...base, group_id: 123456, user_id: 654321, sender: { nickname: '只有昵称' } });
  assert.equal(withNick.displayName, '只有昵称');
  const bare = parseGroupMessage({ ...base, group_id: 123456, user_id: 654321, sender: {} });
  assert.equal(bare.displayName, '654321');
});

test('忽略私聊消息和非消息事件', () => {
  assert.equal(parseGroupMessage({ post_type: 'message', message_type: 'private', user_id: 123456, message: [] }), null);
  assert.equal(parseGroupMessage({ post_type: 'notice', notice_type: 'group_increase' }), null);
  assert.equal(parseGroupMessage(null), null);
  assert.equal(parseGroupMessage('not an object'), null);
});

test('QQ 号或群号非法时拒绝，避免脏数据', () => {
  const bad = { post_type: 'message', message_type: 'group', message: [{ type: 'text', data: { text: 'x' } }] };
  assert.equal(parseGroupMessage({ ...bad, group_id: 'abc', user_id: 123456 }), null);
  assert.equal(parseGroupMessage({ ...bad, group_id: 123456, user_id: '' }), null);
  assert.equal(parseGroupMessage({ ...bad, group_id: 123, user_id: 123456 }), null);
});

test('消息段数组转纯文本，图片和表情用占位符', () => {
  assert.equal(extractText([{ type: 'text', data: { text: '看这个' } }, { type: 'image', data: { file: 'a.png' } }]), '看这个[图片]');
  assert.equal(extractText([{ type: 'face', data: { id: '1' } }, { type: 'text', data: { text: '哈哈' } }]), '[表情]哈哈');
  assert.equal(extractText('纯字符串消息'), '纯字符串消息');
  assert.equal(extractText(undefined), '');
});

test('文本清洗掉控制字符和零宽字符，并限制长度', () => {
  const text = extractText([{ type: 'text', data: { text: '\u200B\uFEFF注入\x01文字' } }]);
  assert.equal(text, '注入 文字');
  const long = extractText([{ type: 'text', data: { text: 'a'.repeat(5000) } }]);
  assert.equal(long.length, 1800);
});

test('群名称变更事件解析', () => {
  const meta = parseMetaEvent({ post_type: 'notice', notice_type: 'group_name', sub_type: 'update', group_id: 123456, group_name: '新群名' }, 'group-name');
  assert.equal(meta.groupId, '123456');
  assert.equal(meta.name, '新群名');
  assert.equal(parseMetaEvent({ post_type: 'notice', notice_type: 'group_name', group_id: 123456 }, 'group-name'), null);
});

test('Token 比较使用常量时间且能识别 Bearer 前缀', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  const link = new OneBotLink({ token: 'secret-token' });
  assert.equal(link.acceptsToken('secret-token'), true);
  assert.equal(link.acceptsToken('Bearer secret-token'), true);
  assert.equal(link.acceptsToken('Token secret-token'), true);
  assert.equal(link.acceptsToken('wrong'), false);
  assert.equal(link.acceptsToken(''), false);
  // 未设置 Token 时不校验
  assert.equal(new OneBotLink({ token: '' }).acceptsToken(''), true);
});

test('未启用时不建立连接，状态保持未启用', () => {
  const link = new OneBotLink({ enabled: false, WebSocketImpl: () => { throw new Error('不应连接'); } });
  link.start();
  assert.equal(link.status, '未启用');
  link.stop();
});

test('事件缓冲有上限，不会无限增长', () => {
  const link = new OneBotLink({ enabled: true });
  for (let i = 0; i < 300; i += 1) {
    link.handlePayload({
      post_type: 'message', message_type: 'group', self_id: 1,
      group_id: 123456, user_id: 654321, message_id: i,
      message: [{ type: 'text', data: { text: `消息${i}` } }]
    });
  }
  assert.ok(link.recentEvents.length <= 200, '事件缓冲应被截断');
  assert.equal(link.eventCount, 300);
  link.stop();
});

test('同一条群消息只上报一次（按 message_id 去重）', () => {
  const link = new OneBotLink({ enabled: true });
  const received = [];
  link.on('group-message', message => received.push(message));
  const payload = {
    post_type: 'message', message_type: 'group', self_id: 1,
    group_id: 123456, user_id: 654321, message_id: 900,
    message: [{ type: 'text', data: { text: '重复消息' } }]
  };
  link.handlePayload(payload);
  link.handlePayload(payload);
  assert.equal(received.length, 1);
  link.stop();
});

test('监听 Bot 自己发的消息被丢弃', () => {
  const link = new OneBotLink({ enabled: true });
  const received = [];
  link.on('group-message', message => received.push(message));
  link.handlePayload({
    post_type: 'message', message_type: 'group', self_id: 999,
    group_id: 123456, user_id: 999, message_id: 1,
    message: [{ type: 'text', data: { text: '自己的消息' } }]
  });
  assert.equal(received.length, 0);
  link.stop();
});
