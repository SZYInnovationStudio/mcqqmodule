import { $, api, message } from './common.js';

let registrations = [];
let editingOpenid = null;
let busy = false;
let revision = 0;
let refreshId = 0;
const unlinkSwitch = $('unlink-on-delete');

function cell(row, value) {
  const td = document.createElement('td');
  td.textContent = value;
  row.append(td);
  return td;
}

function action(label, className, handler) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  button.disabled = busy;
  button.addEventListener('click', handler);
  return button;
}

async function mutate(path, payload, success) {
  if (busy) return;
  busy = true;
  revision++;
  message('registration-message', '正在保存…');
  try {
    registrations = await api(path, { method: 'POST', body: JSON.stringify(payload) });
    editingOpenid = null;
    render();
    message('registration-message', success);
  } catch (error) {
    message('registration-message', error.message, true);
  } finally {
    busy = false;
    render();
  }
}

function editRow(item) {
  const row = document.createElement('tr');
  row.className = 'registration-edit-row';
  const holder = document.createElement('td');
  holder.colSpan = 5;
  const form = document.createElement('form');
  form.className = 'registration-edit-form';
  const qqLabel = document.createElement('label');
  qqLabel.textContent = 'QQ 号';
  const qqInput = document.createElement('input');
  qqInput.type = 'text';
  qqInput.inputMode = 'numeric';
  qqInput.autocomplete = 'off';
  qqInput.required = true;
  qqInput.value = item.qq;
  qqLabel.append(qqInput);
  const openidLabel = document.createElement('label');
  openidLabel.textContent = 'OpenID';
  const openidInput = document.createElement('input');
  openidInput.type = 'text';
  openidInput.autocomplete = 'off';
  openidInput.required = true;
  openidInput.value = item.openid;
  openidLabel.append(openidInput);
  const buttons = document.createElement('div');
  buttons.className = 'registration-actions';
  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'secondary';
  save.textContent = '保存修改';
  buttons.append(save, action('取消', 'ghost', () => {
    editingOpenid = null;
    render();
  }));
  form.append(qqLabel, openidLabel, buttons);
  form.addEventListener('submit', event => {
    event.preventDefault();
    void mutate('registrations/update', {
      currentOpenid: item.openid,
      openid: openidInput.value.trim(),
      qq: qqInput.value.trim()
    }, '登记关系已修改，列表已更新。');
  });
  holder.append(form);
  row.append(holder);
  return row;
}

function render() {
  const term = $('search').value.trim().toLowerCase();
  const shown = registrations.filter(item => item.qq.includes(term) || item.openid.toLowerCase().includes(term));
  const rows = $('registration-rows');
  rows.replaceChildren();
  for (const item of shown) {
    const tr = document.createElement('tr');
    const date = item.registeredAt ? new Date(item.registeredAt) : null;
    for (const value of [item.qq, item.openid, item.group || '—', date && !Number.isNaN(date.getTime()) ? date.toLocaleString('zh-CN') : '—']) cell(tr, value);
    const controls = document.createElement('td');
    const controlButtons = document.createElement('div');
    controlButtons.className = 'registration-actions';
    controlButtons.append(
      action('修改', 'secondary', () => {
        editingOpenid = item.openid;
        render();
      }),
      action('删除', 'ghost danger', async () => {
        if (busy) return;
        try {
          const setting = await api('registrations/delete-setting');
          if (setting.enabled !== unlinkSwitch.checked) {
            unlinkSwitch.checked = setting.enabled;
            return message('registration-message', '联动解绑开关已在其他页面改变，请核对后重新点击删除。', true);
          }
          const payload = { openid: item.openid };
          let success = 'QQ 登记已删除，AQQBot 绑定未改动。';
          if (setting.enabled) {
            const typed = window.prompt('二次确认：删除 QQ 登记前，将逐个解绑 AQQBot 名下全部玩家。请输入 QQ 号“' + item.qq + '”。');
            if (typed === null) return;
            if (typed.trim() !== item.qq) return message('registration-message', 'QQ 号不一致，未执行删除。', true);
            payload.confirmQq = item.qq;
            success = 'AQQBot 名下玩家已全部确认解绑，QQ 登记已删除。';
          } else if (!window.confirm('确定只删除 QQ ' + item.qq + ' 与 OpenID ' + item.openid + ' 的登记？AQQBot 中的 MC 绑定会保留。')) return;
          await mutate('registrations/delete', payload, success);
        } catch (error) {
          message('registration-message', error.message, true);
        }
      })
    );
    controls.append(controlButtons);
    tr.append(controls);
    rows.append(tr);
    if (editingOpenid === item.openid) rows.append(editRow(item));
  }
  if (!shown.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 5;
    td.className = 'registration-empty';
    td.textContent = term ? '没有匹配的登记关系' : '暂无 QQ 登记关系';
    tr.append(td);
    rows.append(tr);
  }
  $('registration-count').textContent = '显示 ' + shown.length + ' / ' + registrations.length + ' 条登记';
}

async function refresh(silent = false) {
  if (busy) return;
  const id = ++refreshId;
  const startedAtRevision = revision;
  if (!silent) message('registration-message', '正在读取登记关系…');
  try {
    const latest = await api('registrations');
    if (id !== refreshId || startedAtRevision !== revision) return;
    registrations = latest;
    render();
    if (!silent) message('registration-message', '已更新。');
  } catch (error) {
    message('registration-message', error.message, true);
  }
}

async function loadDeleteSetting() {
  const state = await api('registrations/delete-setting');
  unlinkSwitch.checked = state.enabled === true;
}

$('create-registration').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  const qq = $('create-qq').value.trim();
  const openid = $('create-openid').value.trim();
  const group = $('create-group').value.trim();
  if (!/^\d{5,20}$/.test(qq)) return message('registration-message', 'QQ 号需要 5–20 位数字', true);
  await mutate('registrations/create', { qq, openid, group }, '登记关系已新建，列表已更新。');
  if (registrations.some(item => item.qq === qq && item.openid === openid)) $('create-registration').reset();
});

unlinkSwitch.addEventListener('change', async () => {
  const enabled = unlinkSwitch.checked;
  unlinkSwitch.disabled = true;
  try {
    const state = await api('registrations/delete-setting', {
      method: 'POST',
      body: JSON.stringify({ enabled })
    });
    unlinkSwitch.checked = state.enabled;
    message('registration-message', state.enabled
      ? '已开启：删除登记时会先逐个解绑 AQQBot，全部确认后才删除登记。'
      : '已关闭：删除登记不会改动 AQQBot 绑定。');
  } catch (error) {
    unlinkSwitch.checked = !enabled;
    message('registration-message', error.message, true);
  } finally {
    unlinkSwitch.disabled = false;
  }
});

$('search').addEventListener('input', render);
$('refresh').addEventListener('click', () => { void refresh(); });
$('logout').addEventListener('click', async () => { await api('logout', { method: 'POST' }); location.href = '/'; });

api('auth-state').then(async state => {
  if (!state.authenticated) { location.replace('/'); return; }
  $('current-user').textContent = state.username;
  await loadDeleteSetting();
  await refresh();
  setInterval(() => {
    if (document.visibilityState === 'visible' && !editingOpenid) void refresh(true);
  }, 10000);
}).catch(() => { location.replace('/'); });

