import { $, api, message } from './common.js';

let state = { lines: [], enabled: false, connected: false };
function render() {
  const term = $('server-log-search').value.trim().toLowerCase();
  const shown = state.lines.filter(item => item.line.toLowerCase().includes(term));
  const output = $('server-log-output');
  output.textContent = shown.length ? shown.map(item => item.line).join('\n') : (term ? '没有匹配日志' : '暂无日志');
  $('server-log-count').textContent = '显示 ' + shown.length + ' / ' + state.lines.length + ' 行；插件' + (state.connected ? '已连接' : '未连接');
  $('server-log-enabled').checked = state.enabled;
  if ($('follow-server-logs').checked) output.scrollTop = output.scrollHeight;
}
async function refresh(silent = false) {
  if (!silent) message('server-log-message', '正在读取日志…');
  try {
    state = await api('server-logs');
    render();
    if (!state.enabled) message('server-log-message', '日志同步当前关闭。');
    else if (!state.connected) message('server-log-message', '日志同步已开启，但 MC 插件当前未连接。', true);
    else if (!silent) message('server-log-message', '已读取最新服务器日志。');
  } catch (error) { message('server-log-message', error.message, true); }
}
$('server-log-enabled').addEventListener('change', async event => {
  const enabled = event.currentTarget.checked;
  event.currentTarget.disabled = true;
  try {
    await api('server-logs/setting', { method: 'POST', body: JSON.stringify({ enabled }) });
    await refresh();
  } catch (error) {
    event.currentTarget.checked = !enabled;
    message('server-log-message', error.message, true);
  } finally { event.currentTarget.disabled = false; }
});
$('server-log-search').addEventListener('input', render);
$('refresh-server-logs').addEventListener('click', () => { void refresh(); });
$('logout').addEventListener('click', async () => { await api('logout', { method: 'POST' }); location.href = '/'; });
api('auth-state').then(async auth => {
  if (!auth.authenticated) { location.replace('/'); return; }
  $('current-user').textContent = auth.username;
  await refresh();
  setInterval(() => {
    if (document.visibilityState === 'visible' && !$('pause-server-logs').checked) void refresh(true);
  }, 2000);
}).catch(() => { location.replace('/'); });
