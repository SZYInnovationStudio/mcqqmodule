import { $, api, message } from './common.js';

function addEntry(item) {
  const root = $('terminal-output');
  const entry = document.createElement('div');
  entry.className = 'terminal-entry' + (item.success ? '' : ' error');
  const title = document.createElement('strong');
  title.textContent = '> ' + item.command;
  const time = document.createElement('small');
  time.textContent = new Date(item.at).toLocaleString() + ' · ' + (item.username || '管理员') + ' · ' + (item.transport || 'rcon').toUpperCase() + ' · ' + (item.success ? '已发送' : '失败');
  const result = document.createElement('pre');
  result.textContent = item.output || '服务器没有返回文字。';
  entry.append(title, time, result);
  root.append(entry);
}

async function loadLogs() {
  const entries = await api('rcon/logs');
  const root = $('terminal-output');
  root.replaceChildren();
  if (!entries.length) {
    const empty = document.createElement('p');
    empty.className = 'terminal-empty';
    empty.textContent = '还没有管理员命令执行日志。';
    root.append(empty);
    return;
  }
  for (const item of entries) addEntry(item);
}

$('terminal-form').addEventListener('submit', async event => {
  event.preventDefault();
  const command = $('command').value.trim();
  if (!command) return;
  if (/^(?:\/?stop|\/?op|\/?deop|\/?ban|\/?pardon|\/?whitelist)\b/i.test(command) && !window.confirm('确认向服务器发送高权限命令？\n' + command)) return;
  const button = $('send-command');
  button.disabled = true;
  message('terminal-message', '正在等待 RCON 返回…');
  try {
    const response = await api('rcon/command', { method: 'POST', body: JSON.stringify({ command }) });
    await loadLogs();
    message('terminal-message', response.logSaved ? '命令已通过 RCON 发送并记入日志。' : '命令已发送，但日志保存失败；请检查后台数据目录。', !response.logSaved);
    $('command').value = '';
  } catch (error) {
    message('terminal-message', error.message, true);
    await loadLogs().catch(() => {});
  } finally { button.disabled = false; $('command').focus(); }
});

$('refresh-log').addEventListener('click', () => loadLogs().catch(error => message('terminal-message', error.message, true)));
$('logout').addEventListener('click', async () => { await api('logout', { method: 'POST' }); location.href = '/'; });

api('auth-state').then(async state => {
  if (!state.authenticated) { location.replace('/'); return; }
  $('current-user').textContent = state.username;
  const status = await api('status');
  $('connection-title').textContent = status.rconConfigured ? 'RCON 已填写，可以发送命令' : 'RCON 尚未配置';
  $('send-command').disabled = !status.rconConfigured;
  await loadLogs();
}).catch(() => { location.replace('/'); });
