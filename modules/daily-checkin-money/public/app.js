const id = value => document.getElementById(value);
const endpoint = '/api/modules/daily-checkin-money';
async function call(path, options = {}) {
  const response = await fetch(`${endpoint}/${path}`, { credentials: 'same-origin', headers: options.body ? { 'Content-Type': 'application/json' } : {}, ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
function notice(text, error = false) { id('message').textContent = text; id('message').classList.toggle('error', error); }
function preview() {
  const form = id('settings-form');
  id('preview').textContent = '命令预览：' + String(form.elements.commandTemplate.value).replaceAll('${player}', 'Steve').replaceAll('${amount}', String(form.elements.min.value || 1000));
}
function formSettings() {
  const form = id('settings-form');
  return { min: Number(form.elements.min.value), max: Number(form.elements.max.value), commandTemplate: form.elements.commandTemplate.value };
}
async function refresh() {
  const data = await call('settings');
  id('module-version').textContent = `daily-checkin-money · v${data.version} · ${data.enabled ? '已启用' : '已关闭'}`;
  id('enabled').checked = data.enabled;
  for (const [key, value] of Object.entries(data.settings)) id('settings-form').elements[key].value = value;
  preview();
  id('count').textContent = data.todayCount;
  id('amount').textContent = data.todayAmount;
  const root = id('records'); root.replaceChildren();
  for (const row of data.records) {
    const tr = document.createElement('tr');
    for (const value of [new Date(row.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }), `${row.qq} / ${row.openid}`, row.player, row.amount, row.status]) {
      const td = document.createElement('td'); td.textContent = String(value); tr.append(td);
    }
    root.append(tr);
  }
  if (!data.records.length) root.textContent = '暂无签到记录';
}
id('settings-form').addEventListener('input', preview);
id('settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  try { await call('settings', { method: 'POST', body: JSON.stringify(formSettings()) }); notice('设置已保存。'); await refresh(); }
  catch (error) { notice(error.message, true); }
});
id('test-command').addEventListener('click', async () => {
  try {
    const data = await call('test', { method: 'POST', body: JSON.stringify(formSettings()) });
    notice(`只读测试完成：${data.output || 'RCON 无帮助输出'}。${data.note}`);
  } catch (error) { notice(error.message, true); }
});
id('enabled').addEventListener('change', async event => {
  const enabled = event.currentTarget.checked;
  try {
    const response = await fetch('/api/modules/toggle', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'daily-checkin-money', enabled }) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error);
    notice(enabled ? '签到已启用。' : '签到已关闭。'); await refresh();
  } catch (error) { event.currentTarget.checked = !enabled; notice(error.message, true); }
});
id('refresh').addEventListener('click', () => refresh().catch(error => notice(error.message, true)));
fetch('/api/auth-state').then(response => response.json()).then(auth => {
  if (!auth.authenticated) { location.replace('/'); return; }
  id('current-user').textContent = auth.username;
  return refresh();
}).catch(error => notice(error.message, true));
