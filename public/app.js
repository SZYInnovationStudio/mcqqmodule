import { $, api, message, renderRecords } from './common.js';

function view(mode, username = '') {
  const authenticated = mode === 'dashboard';
  document.body.classList.toggle('auth-page', !authenticated);
  $('loading-view').hidden = true;
  $('setup-view').hidden = mode !== 'setup';
  $('login-view').hidden = mode !== 'login';
  $('dashboard').hidden = !authenticated;
  $('main-nav').hidden = !authenticated;
  $('mobile-nav').hidden = !authenticated;
  $('logout').hidden = !authenticated;
  $('current-user').hidden = !authenticated;
  $('current-user').textContent = username;
}

function connection(id, text, tone = '') {
  const item = $(id);
  item.textContent = text;
  item.dataset.tone = tone;
}

function renderStatus(status, config) {
  const groups = String(config.allowedGroups ?? '').split(',').filter(Boolean).length;
  $('registered-count').textContent = String(status.registered);
  $('bot-detail').textContent = groups ? groups + ' 个允许群' : '未配置允许群';
  connection('bot-status', status.bot, status.bot === '已连接' ? 'good' : '');
  connection('rcon-status', status.rconConfigured ? '已配置' : '未配置');
  connection('plugin-status', status.pluginConnected ? '在线' : '未连接', status.pluginConnected ? 'good' : '');
  const pluginDetail = status.pluginVersion && status.pluginVersion !== '未上报' ? '版本 ' + status.pluginVersion : '尚未上报版本';
  $('plugin-version').textContent = pluginDetail;
  $('plugin-detail').textContent = pluginDetail;
  $('plugin-indicator').textContent = status.pluginConnected ? '在线' : '未连接';
  $('plugin-card').dataset.tone = status.pluginConnected ? 'good' : '';
  const listener = status.onebot;
  connection('onebot-status', listener?.enabled ? listener.status || '等待连接' : '未启用', listener?.connected ? 'good' : '');

  const directions = [config.qqToMcEnabled && 'QQ → MC', config.mcToQqEnabled && 'MC → QQ'].filter(Boolean);
  $('relay-indicator').textContent = ['已关闭', '单向转发', '双向转发'][directions.length];
  $('relay-detail').textContent = directions.join(' · ') || '可在连接设置中开启';
  $('relay-card').dataset.tone = directions.length ? 'good' : '';

  const next = $('dashboard-next');
  next.hidden = status.rconConfigured && status.bot === '已连接' && status.pluginConnected;
  if (!status.rconConfigured || status.bot === '未配置') {
    $('next-title').textContent = '完成连接配置';
    $('next-description').textContent = '在连接设置中填写 RCON、官方 QQ Bot 与插件信息。';
  } else if (!status.pluginConnected) {
    $('next-title').textContent = '聊天插件未连接';
    $('next-description').textContent = '确认 Bukkit 插件已安装，并核对平台地址和插件 Key。';
  } else if (status.bot !== '已连接') {
    $('next-title').textContent = '官方 QQ Bot 尚未连接';
    $('next-description').textContent = '请核对 AppID 与 AppSecret。';
  }
}

async function refresh() {
  const button = $('refresh');
  button.disabled = true;
  message('dashboard-message', '');
  try {
    const [status, audit, config] = await Promise.all([api('status'), api('audit'), api('config')]);
    renderStatus(status, config);
    renderRecords('audit', audit, item => [item.detail, `${new Date(item.at).toLocaleString('zh-CN', { hour12: false })} · ${item.kind}`], '暂无操作记录');
    const now = new Date();
    const updated = $('dashboard-updated');
    updated.dateTime = now.toISOString();
    updated.textContent = now.toLocaleTimeString('zh-CN', { hour12: false }) + ' 更新';
    updated.hidden = false;
  } catch (error) { message('dashboard-message', error.message, true); }
  finally { button.disabled = false; }
}

$('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button');
  button.disabled = true;
  message('login-message', '');
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
  message('setup-message', '');
  try {
    const result = await api('setup', { method: 'POST', body: JSON.stringify({ username: $('setup-username').value, password: $('setup-password').value }) });
    $('setup-password').value = '';
    $('setup-confirm').value = '';
    view('dashboard', result.username);
    await refresh();
  } catch (error) { message('setup-message', error.message, true); }
  finally { button.disabled = false; }
});

$('refresh').addEventListener('click', refresh);
$('logout').addEventListener('click', async () => {
  try { await api('logout', { method: 'POST' }); view('login'); }
  catch (error) { message('dashboard-message', error.message, true); }
});

api('auth-state').then(async state => {
  if (state.setupRequired) return view('setup');
  if (!state.authenticated) {
    if (new URLSearchParams(location.search).has('accountChanged')) message('login-message', '账户已修改，请重新登录。');
    return view('login');
  }
  view('dashboard', state.username);
  await refresh();
}).catch(error => {
  view('login');
  message('login-message', error.message, true);
});
