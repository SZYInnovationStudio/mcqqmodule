import { $, api, message } from './common.js';

function label(text, value, name, readonly = false) {
  const node = document.createElement('label');
  node.textContent = text;
  const input = document.createElement('input');
  input.name = name;
  input.value = value ?? '';
  input.readOnly = readonly;
  input.required = name === 'qq';
  if (name === 'qq') { input.inputMode = 'numeric'; input.pattern = '[0-9]{5,20}'; }
  if (name === 'players') input.title = '多个玩家名用逗号分隔；留空代表仅保留 QQ 登记';
  node.append(input);
  return node;
}

function userCard(user) {
  const card = document.createElement('article');
  card.className = 'user-card';
  const head = document.createElement('div');
  head.className = 'user-head';
  const title = document.createElement('strong');
  title.textContent = `QQ ${user.qq || '未设置'}`;
  const state = document.createElement('span');
  state.className = 'chip';
  state.textContent = user.bindings.length ? `已有 ${user.bindings.length} 个玩家记录` : '仅登记 QQ';
  head.append(title, state);
  const detail = document.createElement('p');
  detail.className = 'hint';
  detail.textContent = `OpenID：${user.openid} · ${user.source === 'self-confirmed' ? '用户自行确认' : '旧版记录'} · 登记于 ${new Date(user.registeredAt).toLocaleString()}`;
  const form = document.createElement('form');
  form.className = 'user-form';
  form.append(label('QQ 号', user.qq, 'qq'), label('Minecraft 玩家名（多个用逗号分隔）', user.bindings.map(item => item.player).join(', '), 'players'));
  const actions = document.createElement('div');
  actions.className = 'user-actions';
  const save = document.createElement('button');
  save.className = 'secondary';
  save.type = 'submit';
  save.textContent = '保存修改';
  const remove = document.createElement('button');
  remove.className = 'danger';
  remove.type = 'button';
  remove.textContent = '删除记录';
  actions.append(save, remove);
  const note = document.createElement('small');
  note.className = 'user-note';
  note.textContent = user.bindings.length ? `本地状态：${user.bindings.map(item => `${item.player}：${item.status}`).join('；')}` : '尚无玩家绑定记录';
  const status = document.createElement('p');
  status.className = 'message';
  status.setAttribute('role', 'status');
  form.append(actions, note, status);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    save.disabled = true;
    try {
      await api('users', { method: 'POST', body: JSON.stringify({ openid: user.openid, qq: form.elements.qq.value, players: form.elements.players.value }) });
      status.textContent = '已修改本平台记录；如涉及已绑定玩家，请到服务器核对 AQQBot。';
      await loadUsers();
    } catch (error) { status.textContent = error.message; status.classList.add('error'); }
    finally { save.disabled = false; }
  });
  remove.addEventListener('click', async () => {
    if (!window.confirm(`确定删除 QQ ${user.qq} 的本平台登记与绑定记录？这不会解除服务器 AQQBot 中的绑定。`)) return;
    remove.disabled = true;
    try {
      await api('users/delete', { method: 'POST', body: JSON.stringify({ openid: user.openid }) });
      message('page-message', `已删除 QQ ${user.qq} 的本平台记录；服务器 AQQBot 未自动解绑。`);
      await loadUsers();
    } catch (error) { status.textContent = error.message; status.classList.add('error'); remove.disabled = false; }
  });
  card.append(head, detail, form);
  return card;
}

async function loadUsers() {
  const users = await api('users');
  const root = $('users-list');
  root.replaceChildren();
  if (!users.length) { root.textContent = '还没有用户登记。请让群友先发送 /qqbind <QQ号>。'; return; }
  for (const user of users.sort((a, b) => (b.registeredAt ?? '').localeCompare(a.registeredAt ?? ''))) root.append(userCard(user));
}

$('refresh').addEventListener('click', () => loadUsers().catch(error => message('page-message', error.message, true)));
$('logout').addEventListener('click', async () => { await api('logout', { method: 'POST' }); location.href = '/'; });
api('auth-state').then(async state => {
  if (!state.authenticated) { location.replace('/'); return; }
  $('current-user').textContent = state.username;
  await loadUsers();
}).catch(() => { location.replace('/'); });
