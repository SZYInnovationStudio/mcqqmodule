import { $, api, message } from './common.js';

let allLogs = [];

function render() {
  const category = $('category').value;
  const status = $('status').value;
  const search = $('search').value.trim().toLowerCase();
  const entries = allLogs.filter(item =>
    (!category || item.category === category) &&
    (!status || item.status === status) &&
    (!search || String(item.qq ?? '').includes(search) || String(item.openid ?? '').toLowerCase().includes(search))
  );
  $('log-summary').textContent = `显示 ${entries.length} 条 / 共 ${allLogs.length} 条`;
  const root = $('log-list');
  root.replaceChildren();
  if (!entries.length) { root.textContent = allLogs.length ? '没有符合筛选条件的记录。' : '还没有玩家命令日志。'; return; }
  for (const item of entries) {
    const card = document.createElement('article');
    card.className = 'player-log-entry';
    const head = document.createElement('div');
    head.className = 'player-log-head';
    const title = document.createElement('strong');
    title.textContent = item.command;
    const tag = document.createElement('span');
    tag.className = 'chip';
    tag.textContent = item.category;
    head.append(title, tag);
    const meta = document.createElement('p');
    meta.className = 'player-log-meta';
    meta.textContent = `${new Date(item.at).toLocaleString()} · ${item.status} · QQ ${item.qq || '未登记'} · OpenID ${item.openid} · 群 ${item.group}`;
    const result = document.createElement('pre');
    result.textContent = item.result || '无返回内容';
    card.append(head, meta, result);
    root.append(card);
  }
}

async function loadLogs() {
  allLogs = await api('player-logs');
  render();
  message('log-message', '日志已更新。');
}

for (const id of ['category', 'status', 'search']) $(id).addEventListener(id === 'search' ? 'input' : 'change', render);
$('refresh').addEventListener('click', () => loadLogs().catch(error => message('log-message', error.message, true)));
$('logout').addEventListener('click', async () => { await api('logout', { method: 'POST' }); location.href = '/'; });

api('auth-state').then(async state => {
  if (!state.authenticated) { location.replace('/'); return; }
  $('current-user').textContent = state.username;
  await loadLogs();
}).catch(error => message('log-message', error.message, true));
