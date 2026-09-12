import { $, api, message } from './common.js';

async function loadConfig() {
  const config = await api('config');
  for (const element of $('config-form').elements) {
    if (!element.name) continue;
    if (element.type === 'password') {
      element.value = '';
      element.placeholder = config[`${element.name}Set`] ? '已保存；留空保持不变' : '尚未设置';
    } else if (element.type === 'checkbox') {
      element.checked = config[element.name] === true;
    } else element.value = config[element.name] ?? '';
  }
}

$('config-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const form = event.currentTarget;
    const config = Object.fromEntries(new FormData(form));
    config.mcToQqEnabled = form.elements.mcToQqEnabled.checked;
    config.qqToMcEnabled = form.elements.qqToMcEnabled.checked;
    await api('config', { method: 'POST', body: JSON.stringify(config) });
    await loadConfig();
    message('config-message', '信息已保存。现在可以在右侧测试连接。');
  } catch (error) { message('config-message', error.message, true); }
  finally { button.disabled = false; }
});

$('account-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button');
  button.disabled = true;
  try {
    await api('account', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
    location.href = '/?accountChanged=1';
  } catch (error) { message('account-message', error.message, true); button.disabled = false; }
});

for (const button of document.querySelectorAll('[data-test]')) button.addEventListener('click', async () => {
  button.disabled = true;
  $('test-output').textContent = '正在连接…';
  try { $('test-output').textContent = JSON.stringify(await api(`test/${button.dataset.test}`, { method: 'POST' }), null, 2); }
  catch (error) { $('test-output').textContent = `测试失败：${error.message}`; }
  finally { button.disabled = false; }
});

$('logout').addEventListener('click', async () => { await api('logout', { method: 'POST' }); location.href = '/'; });

api('auth-state').then(async state => {
  if (!state.authenticated) { location.replace('/'); return; }
  $('current-user').textContent = state.username;
  $('account-username').value = state.username;
  await loadConfig();
}).catch(() => { location.replace('/'); });
