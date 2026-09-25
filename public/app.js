import { $, api, message, renderRecords } from './common.js';

function view(mode, username = '') {
  $('setup-view').hidden = mode !== 'setup';
  $('login-view').hidden = mode !== 'login';
  $('dashboard').hidden = mode !== 'dashboard';
  $('main-nav').hidden = mode !== 'dashboard';
  $('logout').hidden = mode !== 'dashboard';
  $('current-user').hidden = mode !== 'dashboard';
  $('current-user').textContent = username;
}

async function refresh() {
  const [status, audit] = await Promise.all([api('status'), api('audit')]);
  $('bot-status').textContent = status.bot;
  $('rcon-status').textContent = status.rconConfigured ? '已填写' : '未填写';
  $('registered-count').textContent = String(status.registered);
  if (!status.rconConfigured || status.bot === '未配置') {
    $('next-title').textContent = '先把 QQ Bot、RCON 和插件信息填好';
    $('next-description').textContent = '打开「修改信息」，按顺序填写并保存，再测试连接。';
    $('next-link').href = '/settings';
    $('next-link').textContent = '去修改信息';
  } else if (status.bot !== '已连接') {
    $('next-title').textContent = '检查 QQ 机器人连接';
    $('next-description').textContent = '机器人还没连上。请到「修改信息」核对 QQ 官方 Bot 的 AppID 和 AppSecret。';
    $('next-link').href = '/settings';
    $('next-link').textContent = '检查连接';
  } else {
    $('next-title').textContent = '可以到 QQ 群里试用了';
    $('next-description').textContent = '先发送 /qqbind QQ号 并按回显二次确认，再发送 /mcbind 玩家名进行游戏绑定。';
    $('next-link').href = '/guide';
    $('next-link').textContent = '看使用教程';
  }
  renderRecords('audit', audit, item => [item.detail, `${item.kind} · ${new Date(item.at).toLocaleString()}`], '暂无操作记录');
}

$('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button');
  button.disabled = true;
  try {
    const result = await api('login', { method: 'POST', body: JSON.stringify({ username: $('username').value, password: $('password').value }) });
    $('password').value = '';
    view('dashboard', result.username);
    await refresh();
  } catch (error) { message('login-message', error.message, true); }
  finally { button.disabled = false; }
});

$('setup-form').addEventListener('submit', async event => {
  event.preventDefault();
  if ($('setup-password').value !== $('setup-confirm').value) return message('setup-message', '两次输入的密码不一致', true);
  const button = event.currentTarget.querySelector('button');
  button.disabled = true;
  try {
    const result = await api('setup', { method: 'POST', body: JSON.stringify({ username: $('setup-username').value, password: $('setup-password').value }) });
    $('setup-password').value = '';
    $('setup-confirm').value = '';
    view('dashboard', result.username);
    await refresh();
  } catch (error) { message('setup-message', error.message, true); }
  finally { button.disabled = false; }
});

$('refresh').addEventListener('click', () => refresh().catch(error => message('login-message', error.message, true)));
$('logout').addEventListener('click', async () => { await api('logout', { method: 'POST' }); view('login'); });

api('auth-state').then(async state => {
  if (state.setupRequired) return view('setup');
  if (!state.authenticated) {
    if (new URLSearchParams(location.search).has('accountChanged')) message('login-message', '账户已修改，请重新登录。');
    return view('login');
  }
  view('dashboard', state.username);
  await refresh();
}).catch(() => view('login'));
