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
