import { $, api, message } from './common.js';

let selectedBundle = null;

function summary(bundle) {
  const formats = new Set(['bridge-module-v2', 'szydmc-module-v1']);
  if (!bundle || !formats.has(bundle.format) || !bundle.manifest || !Array.isArray(bundle.files)) throw new Error('不是受支持的模块包');
  const { id, name, version, description = '', entry = '', permissions = ['*'] } = bundle.manifest;
  if (!id || !name || !version) throw new Error('模块清单缺少 ID、名称或版本');
  return [
    `名称：${name}`,
    `模块 ID：${id}`,
    `版本：${version}`,
    `格式：${bundle.format === 'bridge-module-v2' ? '通用 v2' : '旧版 v1（兼容）'}`,
    `文件：${bundle.files.length} 个`,
    `服务端代码：${entry ? '包含 ' + entry : '无（纯页面）'}`,
    `权限：${permissions.includes('*') ? '完整宿主权限' : permissions.join('、')}`,
    description ? `说明：${description}` : ''
  ].filter(Boolean).join('\n');
}

function renderList(state) {
  $('module-count').textContent = String(state.modules.length);
  $('enabled-count').textContent = String(state.modules.filter(item => item.enabled).length);
  $('host-version').textContent = state.serverVersion;
  const root = $('module-list');
  root.replaceChildren();
  root.classList.toggle('empty', !state.modules.length);
  if (!state.modules.length) root.textContent = '还没有安装增量模块。';
  for (const item of state.modules) {
    const row = document.createElement('article');
    row.className = 'module-item';
    const content = document.createElement('div');
    const title = document.createElement('strong');
    const description = document.createElement('p');
    const meta = document.createElement('small');
    const format = document.createElement('small');
    title.textContent = `${item.name} · ${item.version}`;
    description.textContent = item.description || '没有填写简介';
    meta.textContent = `${item.id} · ${item.hasServer ? '页面与接口' : '纯页面'} · ${item.installedAt ? new Date(item.installedAt).toLocaleString('zh-CN') : '安装时间未知'} · ${item.enabled ? '已启用' : '已关闭'}`;
    format.className = 'module-format';
    format.textContent = `${item.format === 'bridge-module-v2' ? '通用 v2' : '旧版兼容'} · ${item.permissions?.includes('*') ? '完整权限' : '受限接口'}`;
    content.append(title, description, meta, format);
    const open = document.createElement('a');
    open.className = 'secondary link-button';
    open.href = item.pageUrl;
    open.textContent = '打开';
    const toggle = document.createElement('button');
    toggle.type = 'button'; toggle.className = 'secondary'; toggle.textContent = item.enabled ? '关闭' : '启用';
    toggle.addEventListener('click', async () => {
      toggle.disabled = true;
      try { await api('modules/toggle', { method: 'POST', body: JSON.stringify({ id: item.id, enabled: !item.enabled }) }); await refresh(); }
      catch (error) { message('module-message', error.message, true); toggle.disabled = false; }
    });
    const actions = document.createElement('div'); actions.className = 'module-actions'; actions.append(open, toggle);
    row.append(content, actions);
    root.append(row);
  }
  const errors = $('module-errors');
  errors.hidden = !state.errors.length;
  errors.textContent = state.errors.length ? '以下模块启动失败：\n' + state.errors.map(item => `${item.id}：${item.error}`).join('\n') : '';
}

async function refresh() {
  try { renderList(await api('modules')); }
  catch (error) { message('module-message', error.message, true); }
}

$('module-file').addEventListener('change', async event => {
  selectedBundle = null;
  $('install-module').disabled = true;
  const file = event.currentTarget.files[0];
  if (!file) { $('module-preview').textContent = '尚未选择文件。'; return; }
  if (file.size > 34 * 1024 * 1024) { $('module-preview').textContent = '文件超过 34 MiB，无法上传。'; return; }
  try {
    const bundle = JSON.parse(await file.text());
    $('module-preview').textContent = summary(bundle);
    selectedBundle = bundle;
    $('install-module').disabled = false;
    message('module-message', '清单已读取。点击安装或升级后，服务端会再做完整校验。');
  } catch (error) {
    $('module-preview').textContent = `读取失败：${error.message}`;
    message('module-message', '模块包无法读取。', true);
  }
});

$('install-module').addEventListener('click', async event => {
  if (!selectedBundle) return;
  event.currentTarget.disabled = true;
  message('module-message', '正在校验并安装或升级模块…');
  try {
    const result = await api('modules/install', { method: 'POST', body: JSON.stringify(selectedBundle) });
    message('module-message', `已安装或升级 ${result.installed.name} ${result.installed.version}。`);
    selectedBundle = null;
    $('module-file').value = '';
    $('module-preview').textContent = '安装完成。可以从右侧列表打开。';
    await refresh();
  } catch (error) {
    message('module-message', error.message, true);
    event.currentTarget.disabled = false;
  }
});

$('refresh-modules').addEventListener('click', () => { void refresh(); });
$('logout').addEventListener('click', async () => { await api('logout', { method: 'POST' }); location.href = '/'; });
api('auth-state').then(async auth => {
  if (!auth.authenticated) { location.replace('/'); return; }
  $('current-user').textContent = auth.username;
  await refresh();
}).catch(() => { location.replace('/'); });
