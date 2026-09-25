const aliases = new Map([
  ['登记', 'qqbind'],
  ['解除登记', 'qqunbind'],
  ['绑定', 'mcbind'],
  ['解绑', 'mcunbind'],
  ['全部解绑', 'mcunallbind'],
  ['我的绑定', 'mymc'],
  ['状态', 'motd'],
  ['桥接状态', 'status'],
  ['在线', 'list'],
  ['性能', 'tps']
]);

export function normalizeCommand(message) {
  return String(message ?? '').replace(/^\/([^\s]+)(?=\s|$)/u, (matched, name) =>
    aliases.has(name) ? '/' + aliases.get(name) : matched);
}

