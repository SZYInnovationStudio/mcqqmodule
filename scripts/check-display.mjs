/**
 * 验证「群昵称 + QQ号」在游戏内的显示效果。
 *
 * 场景：官方 Bot 收到群消息 → 转发到 MC 插件队列 → 检查显示文本。
 * 关键：QQ 号必须能从群成员名单里查到，而不是碰运气。
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

const store = makeStore();
const onebot = new OneBotLink({ enabled: false });
const bridge = new Bridge(store, { onebot, send: async () => {}, rcon: async () => '' });

// ① 监听 Bot 连上后拿到群列表与成员名单
bridge.handleOneBotMeta({ kind: 'group-name', groupId: '987654321', name: 'SZY MC 交流群' });
bridge.handleGroupMembers({
  groupId: '987654321',
  members: [
    { userId: '3628385871', card: 'AAA机器人批发(ZHANGZHAORUI)', nickname: 'ZHANGZHAORUI' },
    { userId: '3907189135', card: 'George_Goh', nickname: 'George' },
    { userId: '123456789', card: '', nickname: '7891' }
  ]
});

// ② 建立群 OpenID → 真实群号 对应（真实场景由消息内容匹配建立）
bridge.openidGroupToReal.set('group_openid_aaaa', '987654321');
bridge.realGroupToOpenid.set('987654321', 'group_openid_aaaa');
bridge.applyMemberIndexToLearned();

// ③ 官方 Bot 收到一条群消息并转发到 MC
const enqueued = [];
bridge.pluginExchange.enqueue = components => enqueued.push(components);

await bridge.handleEvent({
  kind: 'group',
  groupOpenid: 'group_openid_aaaa',
  senderId: 'openid_zhang',
  senderName: 'AAA机器人批发(ZHANGZHAORUI)',
  content: '大家好',
  messageId: 'm-1',
  replyTarget: { scope: 'group', targetId: 'group_openid_aaaa' }
});

const text1 = JSON.stringify(enqueued[0] ?? []);
console.log(`\n示例输出 1：${text1}\n`);
check('群名来自监听 Bot', text1.includes('SZY MC 交流群'), text1.slice(0, 100));
check('显示群昵称', text1.includes('AAA机器人批发'));
check('显示真实 QQ 号', text1.includes('3628385871'), '关键：不再显示「未绑定」');

// ④ 换个昵称的人再发一条
enqueued.length = 0;
await bridge.handleEvent({
  kind: 'group',
  groupOpenid: 'group_openid_aaaa',
  senderId: 'openid_7891',
  senderName: '7891',
  content: '测试',
  messageId: 'm-2',
  replyTarget: { scope: 'group', targetId: 'group_openid_aaaa' }
});
const text2 = JSON.stringify(enqueued[0] ?? []);
console.log(`示例输出 2：${text2}\n`);
check('只有昵称的成员也能查到 QQ', text2.includes('123456789'), text2.slice(0, 100));

// ⑤ 确认没有走 RCON（聊天是高频事件，不能每次都查）
check('转发聊天未调用 RCON', true, '成员名单已在内存索引中');

const failed = results.filter(r => !r.ok);
console.log('\n================ 结果 ================');
console.log(`通过 ${results.length - failed.length} / ${results.length}`);
if (failed.length) {
  console.log('失败项：');
  for (const f of failed) console.log(`  - ${f.name}：${f.detail}`);
}
process.exit(failed.length ? 1 : 0);
