const $ = id => document.getElementById(id);

async function api(path, options = {}) {
  const response = await fetch(`/api/${path}`, { credentials: 'same-origin', headers: options.body ? { 'Content-Type': 'application/json' } : {}, ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function message(id, text, error = false) {
  const node = $(id);
  node.textContent = text;
  node.classList.toggle('error', error);
}

function view(mode, username = '') {
  $('setup-view').hidden = mode !== 'setup';
  $('login-view').hidden = mode !== 'login';
  $('dashboard').hidden = mode !== 'dashboard';
  $('logout').hidden = mode !== 'dashboard';
  $('current-user').hidden = mode !== 'dashboard';
  $('current-user').textContent = username;
  if (mode === 'dashboard') $('account-username').value = username;
}

async function refresh() {
  const [status, bindings, audit] = await Promise.all([api('status'), api('bindings'), api('audit')]);
  $('bot-status').textContent = status.bot;
  $('rcon-status').textContent = status.rconConfigured ? '已配置' : '待配置';
  $('mcsm-status').textContent = status.mcsmConfigured ? '已配置' : '待配置';
  $('counts').textContent = `${status.registered} / ${status.bindings}`;
  renderRecords('bindings', bindings, item => [`${item.qq} ↔ ${item.player}`, `${item.status} · ${new Date(item.updatedAt).toLocaleString()}`], '暂无绑定记录');
  renderRecords('audit', audit, item => [item.detail, `${item.kind} · ${new Date(item.at).toLocaleString()}`], '暂无操作记录');
}

function renderRecords(id, items, format, empty) {
  const root = $(id);
  root.replaceChildren();
  root.classList.toggle('empty', !items.length);
  if (!items.length) { root.textContent = empty; return; }
  for (const item of items) {
    const row = document.createElement('div');
    const title = document.createElement('strong');
    const meta = document.createElement('small');
    [title.textContent, meta.textContent] = format(item);
    row.className = 'record';
    row.append(title, meta);
    root.append(row);
  }
}

async function loadConfig() {
  const config = await api('config');
  const form = $('config-form');
  for (const element of form.elements) {
    if (!element.name) continue;
    if (element.type === 'password') {
      element.value = '';
      element.placeholder = config[`${element.name}Set`] ? '已保存；留空保持不变' : '尚未设置';
    } else element.value = config[element.name] ?? '';
  }
}

$('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button');
  button.disabled = true;
  try {
    const result = await api('login', { method: 'POST', body: JSON.stringify({ username: $('username').value, password: $('password').value }) });
    $('password').value = '';
    view('dashboard', result.username);
    await Promise.all([loadConfig(), refresh()]);
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
    await Promise.all([loadConfig(), refresh()]);
  } catch (error) { message('setup-message', error.message, true); }
  finally { button.disabled = false; }
});

$('account-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button');
  button.disabled = true;
  try {
    const input = Object.fromEntries(new FormData(event.currentTarget));
    const result = await api('account', { method: 'POST', body: JSON.stringify(input) });
    event.currentTarget.reset();
    $('username').value = result.username;
    view('login');
    message('login-message', '账户已修改，请重新登录。');
  } catch (error) { message('account-message', error.message, true); }
  finally { button.disabled = false; }
});

$('config-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const data = Object.fromEntries(new FormData(event.currentTarget));
    await api('config', { method: 'POST', body: JSON.stringify(data) });
    await loadConfig();
    await refresh();
    message('config-message', '配置已保存，QQ Bot 连接正在刷新。');
  } catch (error) { message('config-message', error.message, true); }
  finally { button.disabled = false; }
});

for (const button of document.querySelectorAll('[data-test]')) button.addEventListener('click', async () => {
  button.disabled = true;
  $('test-output').textContent = '正在连接…';
  try { $('test-output').textContent = JSON.stringify(await api(`test/${button.dataset.test}`, { method: 'POST' }), null, 2); }
  catch (error) { $('test-output').textContent = `测试失败：${error.message}`; }
  finally { button.disabled = false; }
});

$('refresh').addEventListener('click', () => refresh().catch(error => message('config-message', error.message, true)));
$('logout').addEventListener('click', async () => { await api('logout', { method: 'POST' }); view('login'); });

api('auth-state').then(async state => {
  if (state.setupRequired) return view('setup');
  if (!state.authenticated) return view('login');
  view('dashboard', state.username);
  await Promise.all([loadConfig(), refresh()]);
}).catch(() => view('login'));
