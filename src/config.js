import { validateQqTemplate } from './qq-chat.js';

export const DEFAULT_QQ_TO_MC_TEMPLATE = '&a[QQ群]&r ${userName}: ${message}';
export const DEFAULT_MC_TO_QQ_TEMPLATE = '[服务器] ${player}: ${message}';
const keys = ['rconHost', 'rconPort', 'rconPassword', 'mcHost', 'mcPort', 'qqAppId', 'qqAppSecret', 'allowedGroups', 'mcsmBaseUrl', 'mcsmApiKey', 'mcsmDaemonId', 'mcsmInstanceUuid', 'qqToMcTemplate', 'mcToQqTemplate'];
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
  next.qqToMcTemplate ||= DEFAULT_QQ_TO_MC_TEMPLATE;
  next.mcToQqTemplate ||= DEFAULT_MC_TO_QQ_TEMPLATE;
  validateQqTemplate(next.qqToMcTemplate);
  if (next.mcToQqTemplate.length > 300 || /[\r\n\0]/.test(next.mcToQqTemplate) || !next.mcToQqTemplate.includes('${player}') || !next.mcToQqTemplate.includes('${message}')) throw new Error('MC → QQ 模板需包含 ${player} 和 ${message}，最多 300 字');
  for (const flag of relayFlags) {
    const value = input[flag] ?? current[flag] ?? false;
    if (value !== true && value !== false) throw new Error(`${flag} 开关格式无效`);
    next[flag] = value;
  }
  if (next.qqToMcEnabled && (!next.rconHost || !next.rconPort || !next.rconPassword || !next.qqAppId || !next.qqAppSecret || !next.allowedGroups)) throw new Error('开启 QQ → MC 前，请填完整 RCON、QQ Bot 和允许群配置');
  if (next.mcToQqEnabled && (!next.mcsmBaseUrl || !next.mcsmApiKey || !next.mcsmDaemonId || !next.mcsmInstanceUuid || !next.qqAppId || !next.qqAppSecret || !next.allowedGroups)) throw new Error('开启 MC → QQ 前，请填完整 MCSManager、QQ Bot 和允许群配置');
  return next;
}

export function publicConfig(config) {
  const result = {};
  for (const key of keys) if (!secrets.includes(key)) result[key] = config[key] ?? (key === 'qqToMcTemplate' ? DEFAULT_QQ_TO_MC_TEMPLATE : key === 'mcToQqTemplate' ? DEFAULT_MC_TO_QQ_TEMPLATE : '');
  for (const flag of relayFlags) result[flag] = config[flag] === true;
  for (const key of secrets) {
    result[`${key}Set`] = Boolean(config[key]);
  }
  return result;
}
