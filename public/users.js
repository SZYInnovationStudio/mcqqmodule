import { $, api, message } from './common.js';

const type = $('query-type');
const value = $('query-value');
const result = $('query-result');
let busy = false;

type.addEventListener('change', () => {
  const byQq = type.value === 'qq';
  $('query-label').textContent = byQq ? 'QQ 号' : 'Minecraft 玩家名';
  value.value = '';
  value.inputMode = byQq ? 'numeric' : 'text';
  value.placeholder = byQq ? '输入 QQ 号' : '输入玩家名（纯数字也可以）';
  result.hidden = true;
  message('query-message', '');
});
value.addEventListener('input', () => { result.hidden = true; });
$('query-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  const query = { type: type.value, value: value.value.trim() };
  if (query.type === 'qq' && !/^\d{5,20}$/.test(query.value)) return message('query-message', 'QQ 号需要 5–20 位数字', true);
  busy = true;
  result.hidden = true;
  message('query-message', '正在查询 AQQBot…');
  try {
    const data = await api('aqqbot/query', { method: 'POST', body: JSON.stringify(query) });
    $('result-qq').textContent = data.qq ? 'QQ 号：' + data.qq : 'QQ 号：未绑定';
    $('result-players').textContent = data.players.length ? 'Minecraft 玩家：' + data.players.join('、') : 'Minecraft 玩家：无';
    result.hidden = false;
    message('query-message', '已从 AQQBot 读取当前结果。');
  } catch (error) { message('query-message', error.message, true); }
  finally { busy = false; }
});
$('logout').addEventListener('click', async () => { await api('logout', { method: 'POST' }); location.href = '/'; });
api('auth-state').then(state => {
  if (!state.authenticated) { location.replace('/'); return; }
  $('current-user').textContent = state.username;
}).catch(() => { location.replace('/'); });
