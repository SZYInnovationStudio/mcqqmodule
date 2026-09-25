import { $, api, message } from './common.js';

let snapshot = null;
function render() {
  const rows = $('database-rows');
  rows.replaceChildren();
  const term = $('database-search').value.trim().toLowerCase();
  const all = snapshot?.rows ?? [];
  const shown = all.filter(item => item.qq.includes(term) || item.openid.toLowerCase().includes(term) || item.players.some(player => player.toLowerCase().includes(term)));
  for (const item of shown) {
    const tr = document.createElement('tr');
    for (const value of [item.qq, item.openid || '—', item.players.length ? item.players.join('、') : '无', String(item.players.length)]) {
      const td = document.createElement('td');
      td.textContent = value;
      tr.append(td);
    }
    rows.append(tr);
  }
  if (!shown.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 4;
    td.className = 'database-empty';
    td.textContent = term ? '没有匹配记录' : snapshot?.available ? 'AQQBot 整库为空' : '暂无可展示的整库快照';
    tr.append(td);
    rows.append(tr);
  }
  $('database-count').textContent = '显示 ' + shown.length + ' / ' + all.length + ' 个 QQ，共 ' + all.reduce((sum, item) => sum + item.players.length, 0) + ' 个玩家';
  $('database-time').textContent = snapshot?.capturedAt ? '快照时间 ' + new Date(snapshot.capturedAt).toLocaleString('zh-CN') : '尚未收到快照';
}
async function refresh() {
  const button = $('refresh-database');
  button.disabled = true;
  message('database-message', '正在读取最新快照…');
  try {
    snapshot = await api('aqqbot/database');
    render();
    if (!snapshot.connected) message('database-message', 'MC 插件当前离线；显示最近一次快照。', true);
    else if (!snapshot.available) message('database-message', snapshot.reason || 'AQQBot 整库暂不可用。', true);
    else message('database-message', '已读取插件同步的 AQQBot 整库快照。');
  } catch (error) { message('database-message', error.message, true); }
  finally { button.disabled = false; }
}
$('database-search').addEventListener('input', render);
$('refresh-database').addEventListener('click', () => { void refresh(); });
$('logout').addEventListener('click', async () => { await api('logout', { method: 'POST' }); location.href = '/'; });
api('auth-state').then(async state => {
  if (!state.authenticated) { location.replace('/'); return; }
  $('current-user').textContent = state.username;
  await refresh();
}).catch(() => { location.replace('/'); });
