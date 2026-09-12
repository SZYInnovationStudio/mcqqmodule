const COLORS = {
  '0': 'black', '1': 'dark_blue', '2': 'dark_green', '3': 'dark_aqua',
  '4': 'dark_red', '5': 'dark_purple', '6': 'gold', '7': 'gray',
  '8': 'dark_gray', '9': 'blue', a: 'green', b: 'aqua',
  c: 'red', d: 'light_purple', e: 'yellow', f: 'white'
};
const FORMATS = { k: 'obfuscated', l: 'bold', m: 'strikethrough', n: 'underlined', o: 'italic' };

function clean(value, max) {
  return String(value ?? '')
    .replace(/[\u061C\u200B\u200C\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g, '')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, max);
}

export function parseNameMap(value, label = '名称映射') {
  const input = String(value ?? '');
  if (input.length > 12000) throw new Error(`${label}太长，最多 12000 字`);
  const result = new Map();
  const lines = input.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length > 100) throw new Error(`${label}最多填写 100 行`);
  for (const line of lines) {
    const match = line.match(/^([A-Za-z0-9_-]{5,128})\s*=\s*(.+)$/);
    if (!match || match[2].length > 48 || !clean(match[2], 48)) throw new Error(`${label}格式：每行 OpenID=显示名称，名称最多 48 字`);
    if (result.has(match[1])) throw new Error(`${label}有重复的 OpenID`);
    result.set(match[1], clean(match[2], 48));
  }
  return result;
}

export function validateQqTemplate(template) {
  if (typeof template !== 'string' || template.length > 300 || /[\r\n\0]/.test(template) || !template.includes('${userName}') || !template.includes('${message}')) throw new Error('QQ → MC 模板需包含 ${userName} 和 ${message}，最多 300 字');
  if (/\$\{(?!userName\}|message\}|groupId\}|groupName\})[^}]*\}/.test(template)) throw new Error('QQ → MC 模板存在不支持的占位符');
  return template;
}

export function makeQqTellraw(template, values) {
  validateQqTemplate(template);
  const vars = {
    userName: clean(values.userName, 48) || '群友',
    message: clean(values.message, 180),
    groupId: clean(values.groupId, 64),
    groupName: clean(values.groupName, 48) || 'QQ群'
  };
  if (!vars.message) return null;
  const render = () => {
    const extra = [];
    let style = {};
    const append = text => {
      if (!text) return;
      const props = { text, ...style };
      const last = extra.at(-1);
      if (last && JSON.stringify({ ...last, text: '' }) === JSON.stringify({ ...props, text: '' })) last.text += text;
      else extra.push(props);
    };
    const pattern = /&([0-9a-fA-Fk-oK-OrR])|\$\{(userName|message|groupId|groupName)\}/g;
    let cursor = 0;
    for (const match of template.matchAll(pattern)) {
      append(template.slice(cursor, match.index));
      cursor = match.index + match[0].length;
      if (match[2]) { append(vars[match[2]]); continue; }
      const code = match[1].toLowerCase();
      if (code === 'r') style = {};
      else if (COLORS[code]) style = { color: COLORS[code] };
      else if (FORMATS[code]) style = { ...style, [FORMATS[code]]: true };
    }
    append(template.slice(cursor));
    return `tellraw @a ${JSON.stringify({ text: '', extra })}`;
  };
  let command = render();
  while (command.length > 512 && vars.message.length > 1) {
    vars.message = vars.message.slice(0, -1);
    command = render();
  }
  if (command.length > 512) throw new Error('QQ → MC 模板过长，无法通过 RCON 发送');
  return command;
}
