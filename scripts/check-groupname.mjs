/**
 * 验证「群名」能否正确显示。
 *
 * 真实痛点：游戏里一直显示 [QQ群]，因为「群 OpenID → 真实群号」的对应
 * 原先只能靠消息内容碰运气来学。
 *
 * 现在两条路：
 *   ① 拿到发送者 QQ 号后，去成员名单里反查他属于哪个群
 *   ② 用最近发言的显示名去撞成员名单
 */
import { Bridge } from '../src/bridge.js';
import { OneBotLink } from '../src/onebot.js';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
};

function makeStore(config = {}) {
  const users = {};
  return {
    config: {
      allowedGroups: 'group_openid_aaaa',
      onebotEnabled: true,
      onebotPreferRealQQ: true,
      qqToMcEnabled: true,
      ...config
    },
    state: { users },
    audit: () => {},
    qqOwner: (qq, except = '') => Object.entries(users).find(([id, u]) => id !== except && u.qq === qq)?.[0] ?? null,
    register: (openid, qq, group, source) => { users[openid] = { qq, group, source }; },
    recordPlayerCommand: () => {}
  };
}

/* ============ 场景一：真名是「=SZYD MC | 1.21.11更新=」 ============ */
const store = makeStore();
const onebot = new OneBotLink({ enabled: false });
const bridge = new Bridge(store, { onebot, send: async () => {}, rcon: async () => '' });

// 监听 Bot 连上后拿到：群列表 + 成员名单
bridge.handleOneBotMeta({ kind: 'group-name', groupId: '987654321', name: '=SZYD MC | 1.21.11更新=' });
bridge.handleGroupMembers({
  groupId: '987654321',
  members: [
    { userId: '3628385871', card: 'AAA机器人批发(ZHANGZHAORUI)', nickname: 'ZHANGZHAORUI' },
    { userId: '3907189135', card: 'George_Goh', nickname: 'George' }
  ]
});

const enqueued = [];
bridge.pluginExchange.enqueue = components => enqueued.push(components);

// 官方 Bot 收到 Beibing 的消息（他有登记 QQ 3628385871）
store.state.users['openid_beibing'] = { qq: '3628385871' };
await bridge.handleEvent({
  kind: 'group',
  groupOpenid: 'group_openid_aaaa',
  senderId: 'openid_beibing',
  senderName: 'Beibing',
  content: '测试',
  messageId: 'm-1',
  replyTarget: { scope: 'group', targetId: 'group_openid_aaaa' }
});

const text = JSON.stringify(enqueued[0] ?? []);
console.log(`\n实际输出：${text}\n`);

check('群名显示为真实群名', text.includes('=SZYD MC | 1.21.11更新='), text.slice(0, 120));
check('不再显示兜底的 [QQ群]', !text.includes('[QQ群]'));
check('QQ 号正确显示', text.includes('3628385871'));

/* ============ 场景二：多群环境不能张冠李戴 ============ */
const store2 = makeStore({ allowedGroups: 'group_openid_bbbb' });
// 注意：必须在创建 Bridge 之前就把登记数据准备好
store2.state.users['openid_jia'] = { qq: '200000002' };
const bridge2 = new Bridge(store2, { onebot: new OneBotLink({ enabled: false }), send: async () => {}, rcon: async () => '' });

bridge2.handleOneBotMeta({ kind: 'group-name', groupId: '111111111', name: '一号群' });
bridge2.handleOneBotMeta({ kind: 'group-name', groupId: '222222222', name: '二号群' });
bridge2.handleGroupMembers({
  groupId: '111111111',
  members: [{ userId: '100000001', card: '甲', nickname: '甲' }]
});
bridge2.handleGroupMembers({
  groupId: '222222222',
  members: [{ userId: '200000002', card: '乙', nickname: '乙' }]
});

const enq2 = [];
bridge2.pluginExchange.enqueue = c => enq2.push(c);
await bridge2.handleEvent({
  kind: 'group',
  groupOpenid: 'group_openid_bbbb',
  senderId: 'openid_jia',
  senderName: '乙',
  content: 'x',
  messageId: 'm-2',
  replyTarget: { scope: 'group', targetId: 'group_openid_bbbb' }
});
const text2 = JSON.stringify(enq2[0] ?? []);
console.log(`多群输出：${text2}\n`);
check('多群时匹配到正确的群', text2.includes('二号群'), text2.slice(0, 120));
check('不会错配成一号群', !text2.includes('一号群'));

/* ============ 场景三：关闭 OneBot 时退回旧行为 ============ */
const store3 = makeStore({ onebotEnabled: false });
const bridge3 = new Bridge(store3, { onebot: new OneBotLink({ enabled: false }), send: async () => {}, rcon: async () => '' });
bridge3.handleOneBotMeta({ kind: 'group-name', groupId: '987654321', name: '不该显示' });
check('关闭 OneBot 时群名不生效', bridge3.realGroupNameFor('group_openid_aaaa') === '');

const failed = results.filter(r => !r.ok);
console.log('\n================ 结果 ================');
console.log(`通过 ${results.length - failed.length} / ${results.length}`);
if (failed.length) for (const f of failed) console.log(`  ❌ ${f.name}：${f.detail}`);
process.exit(failed.length ? 1 : 0);
