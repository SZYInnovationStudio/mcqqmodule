import { $, api, message } from './common.js';

function addEntry(command, output, error = false) {
  const root = $('terminal-output');
  root.querySelector('.terminal-empty')?.remove();
  const entry = document.createElement('div');
  entry.className = `terminal-entry${error ? ' error' : ''}`;
  const title = document.createElement('strong');
  title.textContent = `> ${command}`;
  const time = document.createElement('small');
  time.textContent = new Date().toLocaleTimeString();
  const result = document.createElement('pre');
  result.textContent = output || '服务器没有返回文字。';
  entry.append(title, time, result);
  root.prepend(entry);
  while (root.children.length > 20) root.lastElementChild.remove();
}

$('terminal-form').addEventListener('submit', async event => {
  event.preventDefault();
  const command = $('command').value.trim();
  if (!command) return;
  if (/^(?:\/?stop|\/?op|\/?deop|\/?ban|\/?pardon|\/?whitelist)\b/i.test(command) && !window.confirm(`确认向服务器发送高权限命令？\n${command}`)) return;
  const button = $('send-command');
  button.disabled = true;
  message('terminal-message', '正在等待 RCON 返回…');
  try {
    const response = await api('rcon/command', { method: 'POST', body: JSON.stringify({ command }) });
    addEntry(command, response.output);
    message('terminal-message', '命令已发送。请查看服务器返回内容；无返回文字不代表操作一定成功。');
    $('command').value = '';
  } catch (error) {
    addEntry(command, error.message, true);
    message('terminal-message', error.message, true);
  } finally { button.disabled = false; $('command').focus(); }
});

$('clear-output').addEventListener('click', () => {
  $('terminal-output').replaceChildren();
  const empty = document.createElement('p');
  empty.className = 'terminal-empty';
  empty.textContent = '显示已清空。';
  $('terminal-output').append(empty);
});

$('logout').addEventListener('click', async () => { await api('logout', { method: 'POST' }); location.href = '/'; });

api('auth-state').then(async state => {
  if (!state.authenticated) { location.replace('/'); return; }
  $('current-user').textContent = state.username;
  const status = await api('status');
  $('connection-title').textContent = status.rconConfigured ? 'RCON 已填写，可以发送命令' : 'RCON 尚未配置';
  $('send-command').disabled = !status.rconConfigured;
}).catch(() => { location.replace('/'); });
