import { $, api, message } from './common.js';

async function loadConfig() {
  const config = await api('config');
  $('plugin-key').type = 'password';
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

$('generate-plugin-key').addEventListener('click', async () => {
  const key = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
  $('plugin-key').value = key;
  try {
    await navigator.clipboard.writeText(key);
    $('plugin-key-message').textContent = 'Key 已复制。先粘贴到插件 config.yml 的 key，再保存本页信息。不要发到 QQ 群。';
  } catch {
    $('plugin-key').type = 'text';
    $('plugin-key-message').textContent = '浏览器无法自动复制；请从上方输入框手动复制 Key，填到插件 config.yml 后保存本页。';
  }
});

$('config-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const form = event.currentTarget;
    const config = Object.fromEntries(new FormData(form));
    config.mcToQqEnabled = form.elements.mcToQqEnabled.checked;
    config.qqToMcEnabled = form.elements.qqToMcEnabled.checked;
    config.onebotEnabled = form.elements.onebotEnabled.checked;
    config.onebotPreferRealQQ = form.elements.onebotPreferRealQQ.checked;
    await api('config', { method: 'POST', body: JSON.stringify(config) });
    await loadConfig();
    message('config-message', '信息已保存，聊天转发和监听 Bot 设置已生效。');
  } catch (error) { message('config-message', error.message, true); }
  finally { button.disabled = false; }
});

// 单独一个按钮查询监听 Bot 状态，不跟连接测试混在一起
$('onebot-status-button')?.addEventListener('click', async () => {
  $('onebot-output').textContent = '正在查询…';
  try {
    const status = await api('status');
    const onebot = status.onebot ?? {};
    $('onebot-output').textContent = [
      `状态：${onebot.status ?? '未知'}`,
      `接入方式：${onebot.mode === 'forward' ? '正向（平台主动连接）' : onebot.mode === 'reverse' ? '反向（外挂 Bot 连入）' : '—'}`,
      `监听 QQ：${onebot.selfId || '—'}`,
      `累计收到事件：${onebot.eventCount ?? 0}`,
      `最近事件：${onebot.lastEventAt ?? '—'}`,
      '',
      '最近上报：',
      ...(onebot.recentEvents?.length
        ? onebot.recentEvents.slice(0, 10).map(item => `  ${item.at}  ${item.kind ?? ''}  ${item.groupId ? `群${item.groupId}` : ''} ${item.userId ? `QQ${item.userId}` : ''} ${(item.text ?? item.name ?? '').slice(0, 40)}`)
        : ['  （尚无事件）']),
      '',
      '提醒：监听 Bot 只收消息，群里的所有发言由官方 Bot 发出。'
    ].join('\n');
  } catch (error) { $('onebot-output').textContent = `查询失败：${error.message}`; }
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
