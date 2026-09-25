import { $, api, message } from './common.js';

async function load() {
  const config = await api('templates');
  const form = $('template-form');
  for (const element of form.elements) {
    if (!element.name) continue;
    if (element.type === 'checkbox') element.checked = config[element.name] === true;
    else element.value = config[element.name] ?? '';
  }
}
$('template-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const payload = Object.fromEntries(new FormData(form));
    payload.presenceNotifyEnabled = form.elements.presenceNotifyEnabled.checked;
    payload.serverStatusNotifyEnabled = form.elements.serverStatusNotifyEnabled.checked;
    await api('templates', { method: 'POST', body: JSON.stringify(payload) });
    message('template-message', '消息模板和通知开关已保存。');
  } catch (error) { message('template-message', error.message, true); }
  finally { button.disabled = false; }
});
$('logout').addEventListener('click', async () => { await api('logout', { method: 'POST' }); location.href = '/'; });
api('auth-state').then(async state => {
  if (!state.authenticated) { location.replace('/'); return; }
  $('current-user').textContent = state.username;
  await load();
}).catch(() => { location.replace('/'); });
