import { $, api, message } from './common.js';

const formats = new Map([
  ['bridge-module-v2', '通用 v2'],
  ['szydmc-module-v1', '旧版 v1']
]);
const dateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short', hourCycle: 'h23' });
const fileInput = $('module-file');
const installButton = $('install-module');
const previewPanel = $('module-preview-panel');
let selectedBundle = null;
let selectionVersion = 0;

function textElement(tag, value, className) {
  const element = document.createElement(tag);
  element.textContent = value;
  if (className) element.className = className;
  return element;
}

function renderFacts(list, entries) {
  list.replaceChildren(...entries.map(([label, value, wide]) => {
    const row = document.createElement('div');
    if (wide) row.className = 'module-fact-wide';
    row.append(textElement('dt', label), textElement('dd', value));
    return row;
  }));
}

function formatPermissions(permissions = ['*']) {
  if (!Array.isArray(permissions)) throw new Error('模块权限声明格式无效');
  return permissions.includes('*') ? '完整宿主权限' : permissions.join('、') + '（仅声明，不隔离权限）';
}

function bundleFacts(bundle) {
  if (!bundle || !formats.has(bundle.format) || !bundle.manifest || !Array.isArray(bundle.files)) throw new Error('不是受支持的模块包');
  const { id, name, version, description, entry } = bundle.manifest;
  if (!id || !name || !version) throw new Error('模块清单缺少 ID、名称或版本');
  const facts = [
    ['模块', name + ' · v' + version, true],
    ['模块 ID', id],
    ['包格式', formats.get(bundle.format) + ' · ' + bundle.files.length + ' 个文件'],
    ['服务端入口', entry || '无（纯页面）'],
    ['权限声明', formatPermissions(bundle.manifest.permissions)]
  ];
  if (description) facts.push(['说明', description, true]);
  return facts;
}

function renderModule(item) {
  const row = document.createElement('article');
  row.className = 'module-item';

  const content = document.createElement('div');
  const heading = document.createElement('header');
  heading.className = 'module-item-title';
  const status = textElement('span', item.enabled ? '已启用' : '已停用', 'module-state');
  status.dataset.enabled = item.enabled;
  heading.append(textElement('h3', item.name), textElement('span', 'v' + item.version, 'module-version'), status);
  content.append(heading);
  if (item.description) content.append(textElement('p', item.description, 'module-item-description'));

  const open = textElement('a', '打开模块', 'secondary link-button');
  open.href = item.pageUrl;
  open.setAttribute('aria-label', '打开 ' + item.name);
  const toggle = textElement('button', item.enabled ? '停用' : '启用', 'ghost');
  toggle.type = 'button';
  toggle.setAttribute('aria-label', toggle.textContent + ' ' + item.name);
  toggle.addEventListener('click', async () => {
    toggle.disabled = true;
    message('module-catalog-message', '');
    try {
      const updated = await api('modules/toggle', { method: 'POST', body: JSON.stringify({ id: item.id, enabled: !item.enabled }) });
      item.enabled = updated.enabled;
      status.textContent = item.enabled ? '已启用' : '已停用';
      status.dataset.enabled = item.enabled;
      toggle.textContent = item.enabled ? '停用' : '启用';
      toggle.setAttribute('aria-label', toggle.textContent + ' ' + item.name);
      $('enabled-count').textContent = $('module-list').querySelectorAll('.module-state[data-enabled="true"]').length;
    } catch (error) { message('module-catalog-message', error.message, true); }
    finally { toggle.disabled = false; }
  });
  const actions = document.createElement('div');
  actions.className = 'module-actions';
  actions.append(open, toggle);

  const details = document.createElement('details');
  details.className = 'module-details';
  const facts = document.createElement('dl');
  facts.className = 'module-facts';
  const installedAt = new Date(item.installedAt);
  const properties = [
    ['模块 ID', item.id],
    ['包格式', formats.get(item.format) || item.format],
    ['类型', item.hasServer ? '页面与接口' : '纯页面'],
    ['权限声明', formatPermissions(item.permissions)],
    ['安装时间', Number.isNaN(installedAt.getTime()) ? '未知' : dateFormat.format(installedAt)]
  ];
  if (item.description) properties.push(['说明', item.description, true]);
  renderFacts(facts, properties);
  details.append(textElement('summary', '模块详情'), facts);
  row.append(content, actions, details);
  return row;
}

function renderList(state) {
  $('module-count').textContent = state.modules.length;
  $('enabled-count').textContent = state.modules.filter(item => item.enabled).length;
  $('host-badge').querySelector('#host-version').textContent = state.serverVersion;
  $('module-list').replaceChildren(...(state.modules.length
    ? state.modules.map(renderModule)
    : [textElement('p', '还没有安装模块，可在安装区选择模块包。', 'module-empty')]));

  const errors = $('module-errors');
  errors.hidden = !state.errors.length;
  errors.replaceChildren();
  if (state.errors.length) {
    const list = document.createElement('ul');
    list.append(...state.errors.map(item => textElement('li', item.id + ' · ' + item.error)));
    errors.append(textElement('h3', '模块启动失败'), list);
  }
}

async function refresh() {
  const button = $('refresh-modules');
  const list = $('module-list');
  button.disabled = true;
  list.setAttribute('aria-busy', 'true');
  message('module-catalog-message', '');
  try { renderList(await api('modules')); }
  catch (error) {
    if ($('module-count').textContent === '—') list.replaceChildren(textElement('p', '暂时无法读取模块。', 'module-empty'));
    message('module-catalog-message', error.message, true);
  } finally {
    list.setAttribute('aria-busy', 'false');
    button.disabled = false;
  }
}

function showFileName(file) {
  const name = $('module-file-name');
  name.textContent = file?.name || '尚未选择文件';
  name.title = file?.name || '';
}

fileInput.addEventListener('change', async () => {
  const version = ++selectionVersion;
  selectedBundle = null;
  installButton.disabled = true;
  previewPanel.hidden = true;
  const file = fileInput.files[0];
  showFileName(file);
  message('module-message', '');
  if (!file) return;
  if (file.size > 48 * 1024 * 1024) {
    message('module-message', '文件超过 48 MiB，无法上传。', true);
    return;
  }
  message('module-message', '正在读取模块清单…');
  try {
    const bundle = JSON.parse(await file.text());
    if (version !== selectionVersion) return;
    renderFacts($('module-preview'), bundleFacts(bundle));
    previewPanel.hidden = false;
    selectedBundle = bundle;
    installButton.disabled = false;
    message('module-message', '');
  } catch (error) {
    if (version === selectionVersion) message('module-message', '读取失败：' + error.message, true);
  }
});

installButton.addEventListener('click', async () => {
  if (!selectedBundle) return;
  installButton.disabled = true;
  fileInput.disabled = true;
  message('module-message', '正在验证并安装模块…');
  try {
    const { installed } = await api('modules/install', { method: 'POST', body: JSON.stringify(selectedBundle) });
    selectedBundle = null;
    fileInput.value = '';
    showFileName();
    previewPanel.hidden = true;
    message('module-message', '已安装 ' + installed.name + ' v' + installed.version + '。');
    await refresh();
  } catch (error) { message('module-message', error.message, true); }
  finally {
    fileInput.disabled = false;
    installButton.disabled = !selectedBundle;
  }
});

$('refresh-modules').addEventListener('click', refresh);
$('logout').addEventListener('click', async () => {
  try { await api('logout', { method: 'POST' }); location.href = '/'; }
  catch (error) { message('module-catalog-message', error.message, true); }
});
api('auth-state').then(async auth => {
  if (!auth.authenticated) { location.replace('/'); return; }
  $('current-user').textContent = auth.username;
  await refresh();
}).catch(() => { location.replace('/'); });
