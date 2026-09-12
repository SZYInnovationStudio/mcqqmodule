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

function view(loggedIn) {
  $('login-view').hidden = loggedIn;
  $('dashboard').hidden = !loggedIn;
  $('logout').hidden = !loggedIn;
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
    await api('login', { method: 'POST', body: JSON.stringify({ password: $('password').value }) });
    $('password').value = '';
    view(true);
    await Promise.all([loadConfig(), refresh()]);
  } catch (error) { message('login-message', error.message, true); }
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
$('logout').addEventListener('click', async () => { await api('logout', { method: 'POST' }); view(false); });

Promise.all([loadConfig(), refresh()]).then(() => view(true)).catch(() => view(false));
