import { $, api, message } from './common.js';

const searchType = $('search-type');
const searchValue = $('search-value');
const selectAll = $('select-all');
const selected = new Set();
let current = null;
let currentQuery = null;
let editing = null;
let busy = false;

function setBusy(value) {
  busy = value;
  for (const control of document.querySelectorAll('button,input,select')) control.disabled = value;
}

function updateSelection() {
  $('selected-count').textContent = '已选 ' + selected.size + ' 个';
  selectAll.checked = Boolean(current?.players.length) && selected.size === current.players.length;
  selectAll.indeterminate = selected.size > 0 && selected.size < (current?.players.length ?? 0);
}

function makeButton(label, className, callback) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  button.addEventListener('click', callback);
  return button;
}

function editRow(player) {
  const row = document.createElement('tr');
  row.className = 'binding-edit-row';
  const cell = document.createElement('td');
  cell.colSpan = 5;
  const form = document.createElement('form');
  form.className = 'binding-edit';
  const qqLabel = document.createElement('label');
  qqLabel.textContent = '新 QQ 号';
  const qq = document.createElement('input');
  qq.value = current.qq;
  qq.inputMode = 'numeric';
  qq.required = true;
  qqLabel.append(qq);
  const playerLabel = document.createElement('label');
  playerLabel.textContent = '新玩家名';
  const newPlayer = document.createElement('input');
  newPlayer.value = player;
  newPlayer.required = true;
  playerLabel.append(newPlayer);
  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'secondary';
  save.textContent = '保存修改';
  form.append(qqLabel, playerLabel, save, makeButton('取消', 'ghost', () => {
    editing = null;
    render();
  }));
  form.addEventListener('submit', event => {
    event.preventDefault();
    const nextQq = qq.value.trim();
    const nextPlayer = newPlayer.value.trim();
    if (!/^\d{5,20}$/.test(nextQq)) return message('binding-message', 'QQ 号需要 5–20 位数字', true);
    const typed = window.prompt('二次确认：请输入原玩家名“' + player + '”以修改绑定。');
    if (typed === null) return;
    if (typed.trim() !== player) return message('binding-message', '原玩家名不一致，未修改。', true);
    void perform('bindings/edit', {
      oldQq: current.qq, oldPlayer: player, newQq: nextQq, newPlayer: nextPlayer, confirmPlayer: player
    }, '已修改玩家绑定。');
  });
  cell.append(form);
  row.append(cell);
  return row;
}

function render() {
  const root = $('binding-rows');
  root.replaceChildren();
  $('binding-result').hidden = !current;
  if (!current) return;
  $('summary-qq').textContent = current.qq ? 'QQ：' + current.qq : 'QQ：未找到绑定';
  $('summary-openid').textContent = '登记 OpenID：' + (current.openid || '无');
  $('summary-count').textContent = '玩家：' + current.players.length + ' 个';
  for (const player of current.players) {
    const row = document.createElement('tr');
    const checkCell = document.createElement('td');
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = selected.has(player);
    check.setAttribute('aria-label', '选择玩家 ' + player);
    check.addEventListener('change', () => {
      if (check.checked) selected.add(player);
      else selected.delete(player);
      updateSelection();
    });
    checkCell.append(check);
    const name = document.createElement('td');
    name.textContent = player;
    const qq = document.createElement('td');
    qq.textContent = current.qq;
    const openid = document.createElement('td');
    openid.textContent = current.openid || '—';
    const actions = document.createElement('td');
    actions.append(
      makeButton('修改', 'secondary', () => { editing = player; render(); }),
      makeButton('解绑', 'ghost danger', () => {
        const typed = window.prompt('二次确认：请输入玩家名“' + player + '”以解绑。');
        if (typed === null) return;
        if (typed.trim() !== player) return message('binding-message', '玩家名不一致，未解绑。', true);
        void perform('aqqbot/clear-player', {
          qq: current.qq, player, confirmPlayer: player
        }, '已确认解绑玩家 ' + player + '。');
      })
    );
    row.append(checkCell, name, qq, openid, actions);
    root.append(row);
    if (editing === player) root.append(editRow(player));
  }
  if (!current.players.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 5;
    cell.textContent = '没有查到玩家绑定';
    row.append(cell);
    root.append(row);
  }
  updateSelection();
}

async function lookup(query) {
  const data = await api('bindings/search', { method: 'POST', body: JSON.stringify(query) });
  currentQuery = query;
  current = data;
  selected.clear();
  editing = null;
  render();
}

async function perform(path, payload, success, afterSuccess) {
  if (busy) return;
  setBusy(true);
  message('binding-message', '正在向 AQQBot 执行并核对…');
  let succeeded = false;
  let failure = '';
  try {
    await api(path, { method: 'POST', body: JSON.stringify(payload) });
    succeeded = true;
    if (afterSuccess) afterSuccess();
  } catch (error) {
    failure = error.message;
  }
  try {
    if (currentQuery) await lookup(currentQuery);
  } catch (error) {
    current = null;
    render();
    failure += (failure ? '；' : '') + '刷新失败：' + error.message;
  } finally {
    setBusy(false);
  }
  message('binding-message', succeeded ? success + (failure ? ' 但' + failure : '') : failure + '；请刷新核对当前绑定。', !succeeded || Boolean(failure));
}

$('search-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  const query = { type: searchType.value, value: searchValue.value.trim() };
  if (!query.value) return;
  setBusy(true);
  message('binding-message', '正在实时查询 AQQBot…');
  try {
    await lookup(query);
    message('binding-message', '已读取服务器当前绑定。');
  } catch (error) {
    current = null;
    render();
    message('binding-message', error.message, true);
  } finally { setBusy(false); }
});

searchType.addEventListener('change', () => {
  searchValue.value = '';
  searchValue.placeholder = searchType.value === 'qq' ? '输入 QQ 号' : searchType.value === 'openid' ? '输入 OpenID' : '输入玩家名';
  current = null;
  currentQuery = null;
  render();
});
searchValue.addEventListener('input', () => {
  current = null;
  currentQuery = null;
  render();
});
selectAll.addEventListener('change', () => {
  selected.clear();
  if (selectAll.checked) for (const player of current?.players ?? []) selected.add(player);
  render();
});

$('batch-delete').addEventListener('click', () => {
  if (!current?.qq || !selected.size) return message('binding-message', '请先勾选要解绑的玩家。', true);
  const typed = window.prompt('二次确认：将解绑选中的 ' + selected.size + ' 个玩家。请输入原 QQ 号“' + current.qq + '”。');
  if (typed === null) return;
  if (typed.trim() !== current.qq) return message('binding-message', 'QQ 号不一致，未执行。', true);
  void perform('bindings/clear-selected', {
    qq: current.qq, players: [...selected], confirmQq: current.qq
  }, '选中的玩家已逐个解绑。');
});

$('batch-move').addEventListener('click', () => {
  if (!current?.qq || !selected.size) return message('binding-message', '请先勾选要改绑的玩家。', true);
  const newQq = $('batch-qq').value.trim();
  if (!/^\d{5,20}$/.test(newQq)) return message('binding-message', '请输入 5–20 位目标 QQ 号。', true);
  const typed = window.prompt('二次确认：将选中的 ' + selected.size + ' 个玩家改绑到 QQ “' + newQq + '”。请输入目标 QQ 号。');
  if (typed === null) return;
  if (typed.trim() !== newQq) return message('binding-message', '目标 QQ 号不一致，未执行。', true);
  void perform('bindings/move-selected', {
    oldQq: current.qq, newQq, players: [...selected], confirmQq: newQq
  }, '选中的玩家已逐个改绑到 QQ ' + newQq + '。');
});

$('create-binding').addEventListener('submit', event => {
  event.preventDefault();
  const qq = $('new-qq').value.trim();
  const player = $('new-player').value.trim();
  if (!/^\d{5,20}$/.test(qq)) return message('binding-message', 'QQ 号需要 5–20 位数字', true);
  const typed = window.prompt('二次确认：请输入玩家名“' + player + '”以新增 AQQBot 绑定。');
  if (typed === null) return;
  if (typed.trim() !== player) return message('binding-message', '玩家名不一致，未绑定。', true);
  void perform('bindings/create', { qq, player, confirmPlayer: player }, '已为玩家 ' + player + ' 建立 AQQBot 绑定。', () => {
    searchType.value = 'qq';
    searchValue.value = qq;
    currentQuery = { type: 'qq', value: qq };
  });
});

$('logout').addEventListener('click', async () => { await api('logout', { method: 'POST' }); location.href = '/'; });
api('auth-state').then(state => {
  if (!state.authenticated) { location.replace('/'); return; }
  $('current-user').textContent = state.username;
}).catch(() => { location.replace('/'); });
