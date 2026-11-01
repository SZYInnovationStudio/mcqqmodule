import test from 'node:test';
import assert from 'node:assert/strict';
import { Bridge } from '../src/bridge.js';
import { OneBotLink } from '../src/onebot.js';

/** 造一个最小可用的 Bridge：不连 Bot、不连插件，只测 OneBot 相关的纯逻辑 */
function makeBridge(configOverride = {}, deps = {}) {
  const audits = [];
  const users = {};
  const store = {
    config: {
      allowedGroups: 'group_openid_aaaa',
      onebotEnabled: true,
      onebotPreferRealQQ: true,
      qqToMcEnabled: true,
      ...configOverride
    },
    state: { users, audit: [] },
    audit: (kind, detail) => audits.push({ kind, detail }),
    qqOwner: (qq, exceptOpenid = '') =>
      Object.entries(users).find(([openid, user]) => openid !== exceptOpenid && user.qq === qq)?.[0] ?? null,
    register: (openid, qq, group, source) => {
      if (users[openid]) throw new Error('此 OpenID 已登记');
      users[openid] = { qq, group, source, registeredAt: new Date().toISOString() };
    },
    recordPlayerCommand: () => {},
    ...deps.store
  };
  // 默认挂一个不连网的 OneBotLink，只有传了实例 isOneBotActive 才可能为真
  const onebot = 'onebot' in deps ? deps.onebot : new OneBotLink({ enabled: false });
  const bridge = new Bridge(store, { ...deps, onebot });
  return { bridge, store, users, audits };
}

const oneBotMessage = (over = {}) => ({
  kind: 'group-message',
  groupId: '987654321',
  userId: '123456789',
  messageId: '1',
  text: '大家好',
  displayName: '群名片甲',
  nickname: '昵称乙',
  time: Math.floor(Date.now() / 1000),
  ...over
});

test('没有 OneBot 时状态为未配置，不抛错', () => {
  const { bridge } = makeBridge();
  const status = bridge.getOneBotStatus();
  assert.equal(status.enabled, false);
  assert.equal(status.connected, false);
});

test('OneBot 群消息会被记录，用于后续关联', () => {
  const { bridge } = makeBridge();
  bridge.handleOneBotGroupMessage(oneBotMessage());
  assert.equal(bridge.realQQFor('987654321', '123456789'), '123456789');
});

test('官方 Bot 与 OneBot 同内容消息可关联出真实 QQ 号', () => {
  const { bridge } = makeBridge();
  bridge.handleOneBotGroupMessage(oneBotMessage({ text: '你好世界' }));
  const realQQ = bridge.learnFromOfficial('openid_user_1', 'group_openid_aaaa', '群名片甲', '你好世界');
  assert.equal(realQQ, '123456789');
  assert.equal(bridge.realQQForOpenid('openid_user_1'), '123456789');
});

test('同时学习群 OpenID 与真实群号的对应关系', () => {
  const { bridge } = makeBridge();
  bridge.handleOneBotGroupMessage(oneBotMessage({ text: '对应关系' }));
  bridge.learnFromOfficial('openid_user_1', 'group_openid_aaaa', '群名片甲', '对应关系');
  assert.equal(bridge.realGroupIdFor('group_openid_aaaa'), '987654321');
  assert.equal(bridge.groupOpenidFor('987654321'), 'group_openid_aaaa');
});

test('内容对不上时不乱关联', () => {
  const { bridge } = makeBridge();
  bridge.handleOneBotGroupMessage(oneBotMessage({ text: '原始内容' }));
  const realQQ = bridge.learnFromOfficial('openid_user_1', 'group_openid_aaaa', '群名片甲', '完全不同的内容');
  assert.equal(realQQ, null);
  assert.equal(bridge.realQQForOpenid('openid_user_1'), null);
});

test('候选不唯一时放弃关联，宁可不认也不认错', () => {
  const { bridge } = makeBridge();
  // 两个不同的人发了同样内容
  bridge.handleOneBotGroupMessage(oneBotMessage({ userId: '111111', displayName: '同名', text: '一样的话' }));
  bridge.handleOneBotGroupMessage(oneBotMessage({ userId: '222222', displayName: '同名', text: '一样的话', messageId: '2' }));
  const realQQ = bridge.learnFromOfficial('openid_user_1', 'group_openid_aaaa', '同名', '一样的话');
  assert.equal(realQQ, null);
});

test('已过期的时间窗不参与关联', () => {
  const { bridge } = makeBridge({}, { relayDedupWindowMs: 50 });
  bridge.handleOneBotGroupMessage(oneBotMessage({ text: '过期消息' }));
  // 人为把时间推远
  bridge.recentOneBotMessages.forEach(item => { item.at = Date.now() - 10_000; });
  const realQQ = bridge.learnFromOfficial('openid_user_1', 'group_openid_aaaa', '群名片甲', '过期消息');
  assert.equal(realQQ, null);
});

test('有真实 QQ 号时自动登记，无需手填', () => {
  const { bridge, users } = makeBridge();
  bridge.handleOneBotGroupMessage(oneBotMessage({ text: '自动登记我' }));
  bridge.learnFromOfficial('openid_user_1', 'group_openid_aaaa', '群名片甲', '自动登记我');
  const result = bridge.autoRegister('openid_user_1', 'group_openid_aaaa');
  assert.equal(result.qq, '123456789');
  assert.equal(users.openid_user_1.qq, '123456789');
  assert.equal(users.openid_user_1.source, 'onebot-auto');
});

test('关闭自动取号偏好时退回手动流程', () => {
  const { bridge, users } = makeBridge({ onebotPreferRealQQ: false });
  bridge.handleOneBotGroupMessage(oneBotMessage({ text: '不要自动' }));
  bridge.learnFromOfficial('openid_user_1', 'group_openid_aaaa', '群名片甲', '不要自动');
  assert.equal(bridge.autoRegister('openid_user_1', 'group_openid_aaaa'), null);
  assert.equal(users.openid_user_1, undefined);
});

test('OneBot 未启用时不自动登记', () => {
  const { bridge } = makeBridge({ onebotEnabled: false });
  bridge.handleOneBotGroupMessage(oneBotMessage({ text: '不该登记' }));
  bridge.learnFromOfficial('openid_user_1', 'group_openid_aaaa', '群名片甲', '不该登记');
  assert.equal(bridge.autoRegister('openid_user_1', 'group_openid_aaaa'), null);
});

test('真实 QQ 已被他人登记时不抢注', () => {
  const { bridge, users } = makeBridge();
  users.other_openid = { qq: '123456789' };
  bridge.handleOneBotGroupMessage(oneBotMessage({ text: '冲突了' }));
  bridge.learnFromOfficial('openid_user_1', 'group_openid_aaaa', '群名片甲', '冲突了');
  assert.equal(bridge.autoRegister('openid_user_1', 'group_openid_aaaa'), null);
  assert.equal(users.openid_user_1, undefined);
});

test('beginRegistration 在已知真实 QQ 时直接完成登记', () => {
  const { bridge, users } = makeBridge();
  bridge.handleOneBotGroupMessage(oneBotMessage({ text: '直接登记' }));
  bridge.learnFromOfficial('openid_user_1', 'group_openid_aaaa', '群名片甲', '直接登记');
  const reply = bridge.beginRegistration('openid_user_1', 'group_openid_aaaa', '/qqbind');
  assert.match(reply, /自动识别/);
  assert.equal(users.openid_user_1.qq, '123456789');
});

test('已知真实 QQ 但没有 OneBot 时，beginRegistration 仍要求手填', () => {
  const { bridge } = makeBridge({ onebotEnabled: false });
  const reply = bridge.beginRegistration('openid_user_1', 'group_openid_aaaa', '/qqbind');
  assert.match(reply, /格式：\/qqbind/);
});

test('双源去重在时间窗内生效，窗口外允许再次转发', () => {
  const { bridge } = makeBridge({}, { relayDedupWindowMs: 50 });
  assert.equal(bridge.isDuplicateRelay('g1', 'u1', '重复内容'), false);
  assert.equal(bridge.isDuplicateRelay('g1', 'u1', '重复内容'), true);
  // 窗口过期后可以再次发送
  for (const [key] of bridge.relayFingerprints) bridge.relayFingerprints.set(key, Date.now() - 1000);
  assert.equal(bridge.isDuplicateRelay('g1', 'u1', '重复内容'), false);
});

test('真实 QQ 记录不会无限增长', () => {
  const { bridge } = makeBridge();
  for (let i = 0; i < 5200; i += 1) {
    bridge.rememberRealQQ('100000', String(200000 + i));
  }
  assert.ok(bridge.realQQByGroupUser.size <= 5000);
});

/* ---------------- 自动登记的落库来源必须被 Storage 接受 ---------------- */

test('自动登记使用的来源 onebot-auto 被 Storage 认可', async () => {
  const { Storage } = await import('../src/storage.js');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'dsh-obb-'));
  try {
    const store = new Storage(dir);
    // 这里必须真的注册成功，否则 autoRegister 会被 catch 吞掉变成静默失败
    store.register('openid_user_9', '123456789', 'group_openid_aaaa', 'onebot-auto');
    assert.equal(store.state.users.openid_user_9.qq, '123456789');
    assert.equal(store.state.users.openid_user_9.source, 'onebot-auto');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('自动登记在真实 Storage 上端到端跑通', async () => {
  const { Storage } = await import('../src/storage.js');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'dsh-obb2-'));
  try {
    const store = new Storage(dir);
    store.config = { ...store.config, onebotEnabled: true, onebotPreferRealQQ: true };
    const onebot = new OneBotLink({ enabled: false });
    const bridge = new Bridge(store, { onebot });

    // OneBot 收到消息，官方 Bot 侧匹配上
    bridge.handleOneBotGroupMessage({ groupId: '987654321', userId: '123456789', text: '端到端', displayName: '甲', nickname: '甲' });
    assert.equal(bridge.learnFromOfficial('openid_e2e', 'group_openid_aaaa', '甲', '端到端'), '123456789');

    // 自动登记应当真的写进 Storage
    const result = bridge.autoRegister('openid_e2e', 'group_openid_aaaa');
    assert.ok(result, '自动登记不应返回 null');
    assert.equal(result.qq, '123456789');
    assert.equal(store.state.users.openid_e2e.qq, '123456789');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------- 关闭 OneBot 时必须完整退回旧版方案 ---------------- */

test('【回退】关闭 OneBot 时不学习、不去重、群名只认手工配置', () => {
  const { bridge, users } = makeBridge({ onebotEnabled: false });
  assert.equal(bridge.isOneBotActive(), false);

  // 即使 OneBot 侧收到了消息（比如配置刚关闭，连接还在收尾），也不参与任何逻辑
  bridge.handleOneBotGroupMessage(oneBotMessage({ text: '关闭后不该生效' }));

  // 不学习
  assert.equal(bridge.learnFromOfficial('openid_user_1', 'group_openid_aaaa', '群名片甲', '关闭后不该生效'), null);
  assert.equal(bridge.realQQForOpenid('openid_user_1'), null);

  // 不去重：旧版是每条都转发
  assert.equal(bridge.isDuplicateRelay('g1', 'u1', '同一条'), false);
  assert.equal(bridge.isDuplicateRelay('g1', 'u1', '同一条'), false);

  // 群名只认手工配置
  assert.equal(bridge.realGroupNameFor('group_openid_aaaa'), '');

  // 不自动登记
  assert.equal(bridge.autoRegister('openid_user_1', 'group_openid_aaaa'), null);
  assert.equal(users.openid_user_1, undefined);
});

test('【回退】关闭 OneBot 时手工群名映射仍然生效', () => {
  const { bridge } = makeBridge({ onebotEnabled: false, groupNames: 'group_openid_aaaa=我的主群' });
  assert.equal(bridge.realGroupNameFor('group_openid_aaaa'), '我的主群');
});

test('【回退】开启 OneBot 时群名优先用手工配置，其次才用监听结果', () => {
  const { bridge } = makeBridge({ groupNames: 'group_openid_aaaa=手工群名' });
  bridge.handleOneBotMeta({ kind: 'group-name', groupId: '987654321', name: '监听群名' });
  assert.equal(bridge.realGroupNameFor('group_openid_aaaa'), '手工群名');
  // 没有手工映射的群才用监听到的名字
  assert.equal(bridge.realGroupNameFor('group_openid_other'), '监听群名');
});

test('【回退】开启 OneBot 但未传入连接实例时，同样按关闭处理', () => {
  // config 写着启用，但真的没有 onebot 实例，不应崩也不应半开
  const { bridge } = makeBridge({}, { onebot: null });
  assert.equal(bridge.isOneBotActive(), false);
  assert.equal(bridge.learnFromOfficial('o1', 'g1', '张三', '消息'), null);
  assert.equal(bridge.isDuplicateRelay('g1', 'u1', '消息'), false);
});

test('【回退】关闭 OneBot 后自动登记与手填流程都回到旧版', () => {
  const { bridge, users } = makeBridge({ onebotEnabled: false });
  const reply = bridge.beginRegistration('openid_user_1', 'group_openid_aaaa', '/qqbind 123456789');
  // 旧版：返回二次确认提示，含确认码
  assert.match(reply, /请二次核对/);
  assert.match(reply, /BIND-[A-F0-9]{6}/);
  // 此时还没登记
  assert.equal(users.openid_user_1, undefined);
  // 关闭时提示里不应出现监听 Bot 的引导语
  assert.doesNotMatch(reply, /监听 Bot 尚未识别/);
});

/* ---------------- 学习时机：命令也必须参与学习 ---------------- */

test('【学习时机】命令消息同样参与学习，不会因为不是聊天而漏掉', async () => {
  const { Bridge } = await import('../src/bridge.js');
  const users = {};
  const audits = [];
  const sends = [];
  const store = {
    config: {
      allowedGroups: 'group_openid_aaaa',
      onebotEnabled: true,
      onebotPreferRealQQ: true,
      qqToMcEnabled: true
    },
    state: { users },
    audit: (kind, detail) => audits.push({ kind, detail }),
    qqOwner: (qq, except = '') => Object.entries(users).find(([id, u]) => id !== except && u.qq === qq)?.[0] ?? null,
    register: (openid, qq, group, source) => { users[openid] = { qq, group, source }; },
    recordPlayerCommand: () => {}
  };
  const bridge = new Bridge(store, {
    onebot: new OneBotLink({ enabled: false }),
    send: async (_e, reply) => sends.push(reply),
    rcon: async () => ''
  });

  // OneBot 先看到用户发了 /qqbind
  bridge.handleOneBotGroupMessage({
    groupId: '987654321', userId: '123456789', text: '/qqbind',
    displayName: '张三', nickname: '张三'
  });

  // 官方 Bot 随后也收到 /qqbind（命令，不是普通聊天）
  await bridge.handleEvent({
    kind: 'group',
    groupOpenid: 'group_openid_aaaa',
    senderId: 'openid_user_1',
    senderName: '张三',
    content: '/qqbind',
    messageId: 'm-cmd-1',
    replyTarget: { scope: 'group', targetId: 'group_openid_aaaa' }
  });

  // 关键：命令也要参与学习，否则第一次用命令的人永远学不到真实 QQ 号
  assert.equal(bridge.realQQForOpenid('openid_user_1'), '123456789', '命令消息必须参与学习');
  // 学到之后，同样的 /qqbind 应当直接自动登记
  assert.equal(users.openid_user_1?.qq, '123456789', '学到后应自动登记');
});

test('【学习时机】/qqbind 不带参数且在已识别时直接自动登记', () => {
  const { bridge, users } = makeBridge();
  bridge.handleOneBotGroupMessage(oneBotMessage({ text: '/qqbind' }));
  bridge.learnFromOfficial('openid_user_1', 'group_openid_aaaa', '群名片甲', '/qqbind');
  const reply = bridge.beginRegistration('openid_user_1', 'group_openid_aaaa', '/qqbind');
  assert.match(reply, /自动识别/);
  assert.equal(users.openid_user_1.qq, '123456789');
});

test('【学习时机】/qqbind 不带参数且未识别时给出可操作提示', () => {
  const { bridge } = makeBridge();
  const reply = bridge.beginRegistration('openid_user_1', 'group_openid_aaaa', '/qqbind');
  // 启用 OneBot 时应提示先发言再试，而不是干巴巴的格式错误
  assert.match(reply, /监听 Bot 还没识别到/);
  assert.match(reply, /发一句话/);
});

/* ---------------- 优先监听源：群名与显示名都要用 OneBot 的 ---------------- */

test('【优先监听】群名来自监听 Bot，而不是兜底的「QQ群」', () => {
  const { bridge } = makeBridge();
  bridge.handleOneBotMeta({ kind: 'group-name', groupId: '987654321', name: '我的测试群' });
  bridge.openidGroupToReal.set('group_openid_aaaa', '987654321');
  assert.equal(bridge.realGroupNameFor('group_openid_aaaa'), '我的测试群');
});

test('【优先监听】多个群时不会张冠李戴', () => {
  const { bridge } = makeBridge();
  bridge.handleOneBotMeta({ kind: 'group-name', groupId: '111', name: '群一' });
  bridge.handleOneBotMeta({ kind: 'group-name', groupId: '222', name: '群二' });
  // 还没建立 openid→群号 对应时，多个群不能乱猜
  assert.equal(bridge.realGroupNameFor('group_openid_unknown'), '');
  bridge.openidGroupToReal.set('group_openid_unknown', '222');
  assert.equal(bridge.realGroupNameFor('group_openid_unknown'), '群二');
});

test('【优先监听】显示名优先用监听源的群名片', () => {
  const { bridge } = makeBridge();
  bridge.handleOneBotGroupMessage(oneBotMessage({ text: '你好', displayName: '张三（群名片）', nickname: '张小三' }));
  const name = bridge.displayNameFromOneBot('openid_user_1', '张小三');
  assert.equal(name, '张三（群名片）');
});

test('【优先监听】手工配置的群名映射优先级最高', () => {
  const { bridge } = makeBridge({ groupNames: 'group_openid_aaaa=手工群名' });
  bridge.handleOneBotMeta({ kind: 'group-name', groupId: '987654321', name: '监听到的群名' });
  bridge.openidGroupToReal.set('group_openid_aaaa', '987654321');
  assert.equal(bridge.realGroupNameFor('group_openid_aaaa'), '手工群名');
});

test('【优先监听】关闭 OneBot 时不使用监听源的名字', () => {
  const { bridge } = makeBridge({ onebotEnabled: false });
  bridge.handleOneBotMeta({ kind: 'group-name', groupId: '987654321', name: '不该生效' });
  assert.equal(bridge.realGroupNameFor('group_openid_aaaa'), '');
  assert.equal(bridge.displayNameFromOneBot('openid_user_1', '官方昵称'), '');
});

/* ---------------- 连续相同消息不能被误杀 ---------------- */

test('【不误杀】同一个人连续发两次相同内容，两条都要转发', () => {
  const { bridge } = makeBridge();
  // 第一次
  assert.equal(bridge.isDuplicateRelay('g1', 'u1', '哈哈哈', 'msg-1'), false);
  // 第二次内容相同但 messageId 不同，是合法的新消息
  assert.equal(bridge.isDuplicateRelay('g1', 'u1', '哈哈哈', 'msg-2'), false);
});

test('【不误杀】同一条消息（messageId 相同）才会被判重复', () => {
  const { bridge } = makeBridge();
  assert.equal(bridge.isDuplicateRelay('g1', 'u1', '内容', 'msg-1'), false);
  assert.equal(bridge.isDuplicateRelay('g1', 'u1', '内容', 'msg-1'), true, '同一条消息应判重复');
});

test('【不误杀】没有 messageId 时退回按内容去重，仍能挡住双源重复', () => {
  const { bridge } = makeBridge();
  assert.equal(bridge.isDuplicateRelay('g1', 'u1', '内容'), false);
  assert.equal(bridge.isDuplicateRelay('g1', 'u1', '内容'), true);
});

/* ---------------- 机器人自己的回声不能污染学习 ---------------- */

test('【回声过滤】本平台发出的内容，被监听 Bot 收到后不算群友发言', async () => {
  const { bridge } = makeBridge();
  // 平台往群里发了一条 MC → QQ 的消息
  bridge.rememberOwnSentText('[服务器] Alice（QQ 123456789）: 你好');
  // 监听 Bot 把这条也收进来了
  bridge.handleOneBotGroupMessage({
    groupId: '987654321',
    userId: '999999',
    text: '[服务器] Alice（QQ 123456789）: 你好',
    displayName: '某人',
    nickname: '某人'
  });
  // 不应该把这条当成某人发的，更不该被用来学习 OpenID↔QQ
  const learned = bridge.learnFromOfficial('openid_user_1', 'group_openid_aaaa', '某人', '[服务器] Alice（QQ 123456789）: 你好');
  assert.equal(learned, null, '自己发的回声不能被用来学习');
});

test('【回声过滤】正常群友发言不受影响', () => {
  const { bridge } = makeBridge();
  bridge.rememberOwnSentText('[服务器] Alice（QQ 123456789）: 你好');
  bridge.handleOneBotGroupMessage(oneBotMessage({ text: '这是群友说的话' }));
  assert.equal(bridge.realQQFor('987654321', '123456789'), '123456789', '正常发言仍应被记录');
});

/* ---------------- 群成员名单：不再靠碰运气 ---------------- */

const membersEvent = (groupId = '987654321') => ({
  groupId,
  members: [
    { userId: '111111111', card: '张三（群名片）', nickname: '张小三' },
    { userId: '222222222', card: '', nickname: '只有昵称' },
    { userId: '333333333', card: '李四', nickname: '李四' }
  ]
});

test('【成员名单】建立「群名片 → 真实 QQ」索引', () => {
  const { bridge } = makeBridge();
  bridge.handleGroupMembers(membersEvent());
  bridge.openidGroupToReal.set('group_openid_aaaa', '987654321');
  bridge.applyMemberIndexToLearned();

  assert.equal(bridge.realQQByDisplayName('group_openid_aaaa', '张三（群名片）'), '111111111');
  assert.equal(bridge.realQQByDisplayName('group_openid_aaaa', '只有昵称'), '222222222', '没有群名片时回退到昵称');
  assert.equal(bridge.realQQByDisplayName('group_openid_aaaa', '不存在的人'), '');
});

test('【成员名单】常见词也能查到，不再因候选不唯一而学不到', () => {
  const { bridge } = makeBridge();
  bridge.handleGroupMembers(membersEvent());
  bridge.openidGroupToReal.set('group_openid_aaaa', '987654321');
  bridge.applyMemberIndexToLearned();
  const qq = bridge.resolveQQForOpenid('openid_new', 'group_openid_aaaa', '张三（群名片）');
  assert.equal(qq, '111111111');
  assert.equal(bridge.realQQForOpenid('openid_new'), '111111111', '应记住这次关联');
});

test('【成员名单】用户已登记时优先用登记值', () => {
  const { bridge, users } = makeBridge();
  users.openid_user_1 = { qq: '999999999' };
  bridge.handleGroupMembers(membersEvent());
  bridge.openidGroupToReal.set('group_openid_aaaa', '987654321');
  bridge.applyMemberIndexToLearned();
  const qq = bridge.resolveQQForOpenid('openid_user_1', 'group_openid_aaaa', '张三（群名片）');
  assert.equal(qq, '999999999', '登记值优先级高于成员名单');
});

test('【成员名单】关闭 OneBot 时不使用成员名单', () => {
  const { bridge } = makeBridge({ onebotEnabled: false });
  bridge.handleGroupMembers(membersEvent());
  bridge.openidGroupToReal.set('group_openid_aaaa', '987654321');
  bridge.applyMemberIndexToLearned();
  assert.equal(bridge.realQQByDisplayName('group_openid_aaaa', '张三（群名片）'), '');
});

test('【成员名单】非法群号或非法成员被过滤', () => {
  const { bridge } = makeBridge();
  bridge.handleGroupMembers({ groupId: 'abc', members: [] });
  assert.equal(bridge.membersByGroupId.size, 0, '非法群号应被忽略');

  bridge.handleGroupMembers({
    groupId: '987654321',
    members: [{ userId: 'abc', card: '坏数据' }, { userId: '444444444', card: '好人' }]
  });
  const index = bridge.membersByGroupId.get('987654321');
  assert.equal(index.members.length, 1, '非法用户 ID 应被过滤');
  assert.equal(index.byCard.get('好人'), '444444444');
});

/* ---------------- 关联必须持久化，重启不能丢 ---------------- */

test('【持久化】OpenID↔QQ 关联写进 Storage，重启后仍在', async () => {
  const { Storage } = await import('../src/storage.js');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'dsh-persist-'));
  try {
    // 第一次：建立关联
    const store1 = new Storage(dir);
    store1.config = { ...store1.config, onebotEnabled: true };
    const bridge1 = new Bridge(store1, { onebot: new OneBotLink({ enabled: false }) });
    bridge1.linkRealQQ('openid_persist', '3628385871');
    assert.equal(store1.getRealQQ('openid_persist'), '3628385871', '应写入持久化');

    // 第二次：新建实例（模拟重启），关联应自动回填
    const store2 = new Storage(dir);
    store2.config = { ...store2.config, onebotEnabled: true };
    const bridge2 = new Bridge(store2, { onebot: new OneBotLink({ enabled: false }) });
    assert.equal(bridge2.realQQForOpenid('openid_persist'), '3628385871', '重启后关联不应丢失');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('【持久化】非法 QQ 号或非法 OpenID 不会被记住', async () => {
  const { Storage } = await import('../src/storage.js');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'dsh-persist2-'));
  try {
    const store = new Storage(dir);
    store.rememberRealQQ('openid_ok', 'abc');
    store.rememberBad?.('x');
    store.rememberRealQQ('bad openid!', '123456789');
    store.rememberRealQQ('__proto__', '123456789');
    assert.equal(store.listRealQQ().length, 0, '脏数据不应被记住');
    assert.equal(store.getRealQQ('openid_ok'), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------- 群名：不再靠消息内容碰运气 ---------------- */

test('【群名】用成员 QQ 号反推群号，一次就能定下来', () => {
  const { bridge } = makeBridge();
  bridge.handleOneBotMeta({ kind: 'group-name', groupId: '987654321', name: '=SZYD MC | 1.21.11更新=' });
  bridge.handleGroupMembers({
    groupId: '987654321',
    members: [{ userId: '3628385871', card: 'Beibing', nickname: 'Beibing' }]
  });
  // 已知这个 OpenID 的真实 QQ 是 3628385871，反推他属于哪个群
  const realGroup = bridge.linkGroupByMemberQQ('group_openid_aaaa', '3628385871');
  assert.equal(realGroup, '987654321');
  assert.equal(bridge.realGroupNameFor('group_openid_aaaa'), '=SZYD MC | 1.21.11更新=');
});

test('【群名】多群时按成员归属精确匹配，不会张冠李戴', () => {
  const { bridge } = makeBridge();
  bridge.handleOneBotMeta({ kind: 'group-name', groupId: '111111111', name: '一号群' });
  bridge.handleOneBotMeta({ kind: 'group-name', groupId: '222222222', name: '二号群' });
  bridge.handleGroupMembers({ groupId: '111111111', members: [{ userId: '100000001', card: '甲', nickname: '甲' }] });
  bridge.handleGroupMembers({ groupId: '222222222', members: [{ userId: '200000002', card: '乙', nickname: '乙' }] });

  // 乙属于二号群
  assert.equal(bridge.linkGroupByMemberQQ('group_openid_bbbb', '200000002'), '222222222');
  assert.equal(bridge.realGroupNameFor('group_openid_bbbb'), '二号群');
  // 不会错配成一号群
  assert.notEqual(bridge.realGroupNameFor('group_openid_bbbb'), '一号群');
});

test('【群名】用显示名撞成员名单也能推断群号', () => {
  const { bridge } = makeBridge();
  bridge.handleOneBotMeta({ kind: 'group-name', groupId: '987654321', name: '我的群' });
  bridge.handleGroupMembers({
    groupId: '987654321',
    members: [{ userId: '3628385871', card: '群名片甲', nickname: '昵称甲' }]
  });
  // 监听 Bot 收到了这个人的消息（显示名能对上成员名单）
  bridge.handleOneBotGroupMessage({
    groupId: '987654321', userId: '3628385871', text: '你好',
    displayName: '群名片甲', nickname: '昵称甲'
  });
  // 官方 Bot 侧还没确定群号，靠显示名撞
  const inferred = bridge.inferGroupIdByMember('group_openid_aaaa');
  assert.equal(inferred, '987654321');
  assert.equal(bridge.realGroupNameFor('group_openid_aaaa'), '我的群');
});

test('【群名】关闭 OneBot 时推断不生效', () => {
  const { bridge } = makeBridge({ onebotEnabled: false });
  bridge.handleOneBotMeta({ kind: 'group-name', groupId: '987654321', name: '不该生效' });
  bridge.handleGroupMembers({ groupId: '987654321', members: [{ userId: '3628385871', card: 'Beibing' }] });
  assert.equal(bridge.linkGroupByMemberQQ('group_openid_aaaa', '3628385871'), '');
  assert.equal(bridge.realGroupNameFor('group_openid_aaaa'), '');
});
