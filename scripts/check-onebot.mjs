/**
 * 端到端验证 OneBot 反向接入：完全模拟 NapCat 的握手与上报。
 *
 * 用法：node scripts/check-onebot.mjs
 * 会临时起一个服务端（独立端口 + 临时 data 目录），用真实 WebSocket 客户端连接，
 * 验证鉴权、事件接收、状态回报，然后清理。不碰现有 data/。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = fileURLToPath(new URL('..', import.meta.url));
const PORT = 2611;
const TOKEN = 'test_token_abc123';

const dataDir = mkdtempSync(join(tmpdir(), 'mcqq-onebot-'));
const child = spawn(process.execPath, [join(root, 'src', 'server.js')], {
  cwd: dataDir,
  env: { ...process.env, MCQQ_PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe']
});

let out = '';
child.stdout.on('data', d => { out += d.toString(); });
let err = '';
child.stderr.on('data', d => { err += d.toString(); });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
};

async function api(path, options = {}) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    ...options,
    headers: { Origin: `http://127.0.0.1:${PORT}`, ...(options.headers ?? {}) }
  });
  return res;
}

async function main() {
  // 等服务端起来
  for (let i = 0; i < 40; i += 1) {
    try { await api('/api/auth-state'); break; } catch { await sleep(250); }
  }
  check('服务端启动', true);

  // 首次设置管理员并登录，拿到 cookie
  const cookieJar = [];
  const capture = res => {
    const set = res.headers.getSetCookie?.() ?? [];
    for (const c of set) cookieJar.push(c.split(';')[0]);
  };
  let res = await api('/api/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'tester', password: 'test1234' })
  });
  capture(res);
  check('创建管理员', res.ok, `HTTP ${res.status}`);

  const auth = { Cookie: cookieJar.join('; ') };

  // 场景 A：未启用时，WS 必须被拒绝
  const rejected = await new Promise(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/onebot/ws?access_token=${TOKEN}`);
    ws.on('open', () => { ws.close(); resolve('opened'); });
    ws.on('error', e => resolve('rejected: ' + e.message));
    setTimeout(() => resolve('timeout'), 3000);
  });
  check('未启用时拒绝连接', rejected.startsWith('rejected'), rejected);

  // 启用 OneBot 并保存配置
  res = await api('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({
      mqtt: undefined,
      qqAppId: '',
      qqAppSecret: '',
      allowedGroups: 'test_group_openid',
      pluginKey: 'a'.repeat(32),
      onebotEnabled: true,
      onebotToken: TOKEN,
      onebotUrl: ''
    })
  });
  const cfgText = await res.text();
  check('保存 OneBot 配置', res.ok, res.ok ? '' : cfgText.slice(0, 200));
  await sleep(600);

  // 场景 B：Token 错误必须被拒（401）
  const badToken = await new Promise(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/onebot/ws?access_token=wrong_token`);
    ws.on('open', () => { ws.close(); resolve('opened'); });
    ws.on('error', e => resolve('rejected: ' + e.message));
    setTimeout(() => resolve('timeout'), 3000);
  });
  check('错误 Token 被拒绝', badToken.startsWith('rejected'), badToken);

  // 场景 C：正确 Token 连接成功
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/onebot/ws`, {
    headers: { Authorization: `Bearer ${TOKEN}` }
  });
  const opened = await new Promise(resolve => {
    ws.on('open', () => resolve(true));
    ws.on('error', e => resolve('error: ' + e.message));
    setTimeout(() => resolve('timeout'), 4000);
  });
  check('正确 Token 连接成功', opened === true, String(opened));

  // 场景 D：上报群消息，状态中应能看到真实 QQ 号
  ws.send(JSON.stringify({
    post_type: 'message',
    message_type: 'group',
    self_id: 10001,
    group_id: 987654321,
    user_id: 123456789,
    message_id: 555,
    time: Math.floor(Date.now() / 1000),
    sender: { card: '测试甲', nickname: '甲' },
    message: [{ type: 'text', data: { text: '你好世界' } }]
  }));
  await sleep(700);

  res = await api('/api/status', { headers: auth });
  const status = await res.json();
  check('状态显示已连接', status.onebot?.status === '已连接', JSON.stringify(status.onebot?.status));
  check('识别到监听 QQ 号', status.onebot?.selfId === '10001', String(status.onebot?.selfId));
  check('收到事件计数 > 0', (status.onebot?.eventCount ?? 0) > 0, String(status.onebot?.eventCount));
  check('事件含真实 QQ 号', JSON.stringify(status.onebot?.recentEvents ?? []).includes('123456789'));

  // 场景 E：群名事件
  ws.send(JSON.stringify({
    post_type: 'notice', notice_type: 'group_name', sub_type: 'update',
    group_id: 987654321, group_name: '测试群改名'
  }));
  await sleep(500);
  res = await api('/api/status', { headers: auth });
  const status2 = await res.json();
  check('记录群名变更', JSON.stringify(status2.onebot?.recentEvents ?? []).includes('测试群改名'));

  ws.close();
  await sleep(300);

  // 汇总
  const failed = results.filter(r => !r.ok);
  console.log('\n================ 结果 ================');
  console.log(`通过 ${results.length - failed.length} / ${results.length}`);
  if (failed.length) {
    console.log('失败项：');
    for (const f of failed) console.log(`  - ${f.name}：${f.detail}`);
    if (err) console.log('服务端 stderr：\n' + err.slice(0, 800));
  }
  return failed.length === 0;
}

let ok = false;
try {
  ok = await main();
} catch (e) {
  console.log('❌ 异常：' + e.message);
  if (err) console.log(err.slice(0, 800));
} finally {
  child.kill('SIGKILL');
  await sleep(300);
  try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
process.exit(ok ? 0 : 1);
