/**
 * 验证「优先监听源」：群名与 QQ 号来自 OneBot，而不是官方 Bot 的兜底值。
 *
 * 模拟真实抢答：OneBot 先上报消息，官方 Bot 稍后收到同一条，
 * 检查转发到 MC 的内容里用的是监听源的名字与群名。
 */
import { Bridge } from '../src/bridge.js';
import { OneBotLink } from '../src/onebot.js';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
};

/** 最小 Store */
function makeStore() {
  const users = {};
  return {
    config: {
      allowedGroups: 'group_openid_aaaa',
      onebotEnabled: true,
      onebotPreferRealQQ: true,
      qqToMcEnabled: true,
      qqToMcTemplate: '&a[${groupName}]&r ${userName}：${message}'
    },
    state: { users },
    audit: () => {},
    qqOwner: (qq, except = '') => Object.entries(users).find(([id, u]) => id !== except && u.qq === qq)?.[0] ?? null,
    register: (openid, qq, group, source) => { users[openid] = { qq, group, source }; },
    recordPlayerCommand: () => {}
  };
}

const store = makeStore();
const onebot = new OneBotLink({ enabled: false });
const bridge = new Bridge(store, { onebot, send: async () => {}, rcon: async () => '' });

// 模拟：监听 Bot 连上后拉到了群列表
onebot.emit('meta', { kind: 'group-name', groupId: '987654321', name: '我的测试群' });
onebot.emit('meta', { kind: 'group-name', groupId: '111111111', name: '另一个群' });

// 监听 Bot 先收到群消息（带群名片）
bridge.handleOneBotGroupMessage({
  groupId: '987654321',
  userId: '123456789',
  text: '大家好',
  displayName: '张三（群名片）',
  nickname: '张小三'
});

// 官方 Bot 随后收到同一条消息（只有昵称，没有群名片，也没有群名）
const enqueued = [];
bridge.pluginExchange.enqueue = components => enqueued.push(components);

await bridge.handleEvent({
  kind: 'group',
  groupOpenid: 'group_openid_aaaa',
  senderId: 'openid_user_1',
  senderName: '张小三',
  content: '大家好',
  messageId: 'm-1',
  replyTarget: { scope: 'group', targetId: 'group_openid_aaaa' }
});

const text = JSON.stringify(enqueued);
check('转发到 MC 的内容非空', enqueued.length > 0, `enqueue ${enqueued.length} 次`);
check('群名来自监听源（我的测试群）', text.includes('我的测试群'), text.slice(0, 160));
check('不显示兜底的「QQ群」', !text.includes('QQ群'));
check('显示名优先用群名片', text.includes('张三（群名片）'), '应优先于官方 Bot 的昵称');
check('学到了真实 QQ 号', bridge.realQQForOpenid('openid_user_1') === '123456789', String(bridge.realQQForOpenid('openid_user_1')));

// 自动登记应能直接成功
const auto = bridge.beginRegistration('openid_user_1', 'group_openid_aaaa', '/qqbind');
check('自动登记成功', /自动识别/.test(auto), auto.slice(0, 60));
check('登记了正确 QQ', store.state.users.openid_user_1?.qq === '123456789', String(store.state.users.openid_user_1?.qq));

const failed = results.filter(r => !r.ok);
console.log('\n================ 结果 ================');
console.log(`通过 ${results.length - failed.length} / ${results.length}`);
process.exit(failed.length ? 1 : 0);
