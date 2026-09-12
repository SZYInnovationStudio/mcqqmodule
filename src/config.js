import { basename, isAbsolute } from 'node:path';

const keys = ['rconHost', 'rconPort', 'rconPassword', 'mcHost', 'mcPort', 'aqqbotConfigPath', 'aqqbotMessagesPath', 'qqAppId', 'qqAppSecret', 'allowedGroups', 'mcsmBaseUrl', 'mcsmApiKey', 'mcsmDaemonId', 'mcsmInstanceUuid'];
const secrets = ['rconPassword', 'qqAppSecret', 'mcsmApiKey'];
const relayFlags = ['mcToQqEnabled', 'qqToMcEnabled'];

export function validateConfig(input, current = {}) {
  const next = {};
  for (const key of keys) next[key] = String(input[key] ?? current[key] ?? '').trim();
  for (const key of secrets) if (!String(input[key] ?? '').trim()) next[key] = current[key] ?? '';
  if (next.qqAppId && !/^\d{5,32}$/.test(next.qqAppId)) throw new Error('QQ Bot AppID 格式不合法');
  if (next.mcsmBaseUrl) {
    let url;
    try { url = new URL(next.mcsmBaseUrl); } catch { throw new Error('MCSManager 地址必须是 http:// 或 https:// 开头的完整地址'); }
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash || next.mcsmBaseUrl.length > 2048) throw new Error('MCSManager 地址格式不合法：不要包含账号、密码或查询参数');
    next.mcsmBaseUrl = next.mcsmBaseUrl.replace(/\/+$/, '');
  }
  if (next.mcsmApiKey && (next.mcsmApiKey.length > 2048 || /[\x00-\x1f\x7f]/.test(next.mcsmApiKey))) throw new Error('MCSManager API Key 格式不合法');
  for (const field of ['mcsmDaemonId', 'mcsmInstanceUuid']) if (next[field] && !/^[A-Za-z0-9_-]{1,128}$/.test(next[field])) throw new Error(`${field} 格式不合法`);
  for (const field of ['rconHost', 'mcHost']) if (next[field] && !/^[a-zA-Z0-9.:-]{1,253}$/.test(next[field])) throw new Error(`${field} 格式不合法`);
  for (const field of ['rconPort', 'mcPort']) {
    const port = Number(next[field]);
    if (next[field] && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error(`${field} 必须是 1–65535`);
  }
  next.allowedGroups = next.allowedGroups.split(/[\s,，]+/).filter(Boolean).join(',');
  if (next.allowedGroups && !/^[A-Za-z0-9_-]{5,128}(,[A-Za-z0-9_-]{5,128})*$/.test(next.allowedGroups)) throw new Error('群 OpenID 列表格式不合法');
  for (const [key, name] of [['aqqbotConfigPath', 'config.yml'], ['aqqbotMessagesPath', 'messages.yml']]) {
    const path = next[key];
    if (path && (path.length > 1024 || !isAbsolute(path) || basename(path).toLowerCase() !== name || /[\r\n\0]/.test(path))) throw new Error(`${key} 必须是服务器正在使用的 ${name} 完整路径`);
  }
  for (const flag of relayFlags) {
    const value = input[flag] ?? current[flag] ?? false;
    if (value !== true && value !== false) throw new Error(`${flag} 开关格式无效`);
    next[flag] = value;
  }
  if ((next.mcToQqEnabled || next.qqToMcEnabled) && (!next.aqqbotConfigPath || !next.aqqbotMessagesPath)) throw new Error('开启聊天转发前，必须填写服务器正在使用的 AQQBot config.yml 和 messages.yml 完整路径');
  return next;
}

export function publicConfig(config) {
  const result = {};
  for (const key of keys) if (!secrets.includes(key)) result[key] = config[key] ?? '';
  for (const flag of relayFlags) result[flag] = config[flag] === true;
  for (const key of secrets) {
    result[`${key}Set`] = Boolean(config[key]);
  }
  return result;
}
