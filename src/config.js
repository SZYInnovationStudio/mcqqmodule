const keys = ['mcsmUrl', 'mcsmApiKey', 'daemonId', 'instanceId', 'rconHost', 'rconPort', 'rconPassword', 'mcHost', 'mcPort', 'qqAppId', 'qqAppSecret', 'allowedGroups'];
const secrets = ['mcsmApiKey', 'rconPassword', 'qqAppSecret'];

function endpoint(value, protocols) {
  if (!value) return '';
  const url = new URL(value);
  if (!protocols.includes(url.protocol) || url.username || url.password || url.hash) throw new Error('连接地址格式不合法');
  return url.toString().replace(/\/$/, '');
}

export function validateConfig(input, current = {}) {
  const next = {};
  for (const key of keys) next[key] = String(input[key] ?? current[key] ?? '').trim();
  for (const key of secrets) if (!String(input[key] ?? '').trim()) next[key] = current[key] ?? '';
  next.mcsmUrl = endpoint(next.mcsmUrl, ['http:', 'https:']);
  if (next.qqAppId && !/^\d{5,32}$/.test(next.qqAppId)) throw new Error('QQ Bot AppID 格式不合法');
  for (const field of ['rconHost', 'mcHost']) if (next[field] && !/^[a-zA-Z0-9.:-]{1,253}$/.test(next[field])) throw new Error(`${field} 格式不合法`);
  for (const field of ['rconPort', 'mcPort']) {
    const port = Number(next[field]);
    if (next[field] && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error(`${field} 必须是 1–65535`);
  }
  next.allowedGroups = next.allowedGroups.split(/[\s,，]+/).filter(Boolean).join(',');
  if (next.allowedGroups && !/^[A-Za-z0-9_-]{5,128}(,[A-Za-z0-9_-]{5,128})*$/.test(next.allowedGroups)) throw new Error('群 OpenID 列表格式不合法');
  return next;
}

export function publicConfig(config) {
  const result = { ...config };
  for (const key of secrets) {
    result[`${key}Set`] = Boolean(result[key]);
    delete result[key];
  }
  return result;
}
