import { parseNameMap, validateQqTemplate } from './qq-chat.js';

export const DEFAULT_QQ_TO_MC_TEMPLATE = '&a[${groupName}]&r ${userName}：${message}';
const OLD_QQ_TO_MC_TEMPLATE = '&a[QQ群]&r ${userName}: ${message}';
export const resolveQqToMcTemplate = value => !value || value === OLD_QQ_TO_MC_TEMPLATE ? DEFAULT_QQ_TO_MC_TEMPLATE : value;
// 默认带上 QQ 号，让群友能对上「游戏里这个人是谁」
export const DEFAULT_MC_TO_QQ_TEMPLATE = '[服务器] ${player}（QQ ${qq}）: ${message}';
// 旧默认模板：升级时自动迁移到新默认，用户自定义的不动
const OLD_MC_TO_QQ_TEMPLATE = '[服务器] ${player}: ${message}';
export const resolveMcToQqTemplate = value => !value || value === OLD_MC_TO_QQ_TEMPLATE ? DEFAULT_MC_TO_QQ_TEMPLATE : value;
export const DEFAULT_PRESENCE_JOIN_TEMPLATE = '${player} 进入了服务器';
export const DEFAULT_PRESENCE_QUIT_TEMPLATE = '${player} 离开了服务器';
export const DEFAULT_SERVER_ONLINE_TEMPLATE = '服务器已开启';
export const DEFAULT_SERVER_OFFLINE_TEMPLATE = '服务器已关闭';

const keys = ['rconHost', 'rconPort', 'rconPassword', 'mcHost', 'mcPort', 'qqAppId', 'qqAppSecret', 'allowedGroups', 'qqToMcTemplate', 'mcToQqTemplate', 'presenceJoinTemplate', 'presenceQuitTemplate', 'serverOnlineTemplate', 'serverOfflineTemplate', 'groupNames', 'memberNames', 'pluginKey', 'onebotUrl', 'onebotToken'];
const secrets = ['rconPassword', 'qqAppSecret', 'pluginKey', 'onebotToken'];
const relayFlags = ['mcToQqEnabled', 'qqToMcEnabled'];
const booleanFlags = [...relayFlags, 'presenceNotifyEnabled', 'serverStatusNotifyEnabled', 'serverLogEnabled', 'registrationDeleteUnbindEnabled', 'onebotEnabled', 'onebotPreferRealQQ'];

function validatePlainTemplate(value, label, allowed, required = []) {
  if (!value || value.length > 300 || /[\r\n\0]/.test(value)) throw new Error(label + '需为一行且最多 300 字');
  const variables = [...value.matchAll(/\$\{([A-Za-z]+)\}/g)].map(match => match[1]);
  if (variables.some(name => !allowed.includes(name))) throw new Error(label + '包含不支持的变量');
  if (required.some(name => !variables.includes(name))) throw new Error(label + '缺少必需变量');
}

export function validateConfig(input, current = {}) {
  const next = {};
  for (const key of keys) next[key] = String(input[key] ?? current[key] ?? '').trim();
  for (const key of secrets) if (!String(input[key] ?? '').trim()) next[key] = current[key] ?? '';
  if (next.qqAppId && !/^\d{5,32}$/.test(next.qqAppId)) throw new Error('QQ Bot AppID 格式不合法');
  if (input.chatTransport && input.chatTransport !== 'plugin') throw new Error('聊天只支持独立插件连接');
  if (next.pluginKey && !/^[A-Za-z0-9_-]{32,128}$/.test(next.pluginKey)) throw new Error('插件 Key 至少 32 位，仅可用字母、数字、下划线和连字符');
  for (const field of ['rconHost', 'mcHost']) if (next[field] && !/^[a-zA-Z0-9.:-]{1,253}$/.test(next[field])) throw new Error('${field} 格式不合法');
  for (const field of ['rconPort', 'mcPort']) {
    const port = Number(next[field]);
    if (next[field] && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('${field} 必须是 1–65535');
  }
  next.allowedGroups = next.allowedGroups.split(/[\s,，]+/).filter(Boolean).join(',');
  if (next.allowedGroups && !/^[A-Za-z0-9_-]{5,128}(,[A-Za-z0-9_-]{5,128})*$/.test(next.allowedGroups)) throw new Error('群 OpenID 列表格式不合法');
  // OneBot 监听 Bot 的正向 WebSocket 地址，空表示等待外挂 Bot 主动连入（反向）
  if (next.onebotUrl) {
    if (next.onebotUrl.length > 500) throw new Error('OneBot 地址过长');
    if (!/^wss?:\/\/[^\s]{1,500}$/i.test(next.onebotUrl)) throw new Error('OneBot 地址需为 ws:// 或 wss:// 开头');
  }
  if (next.onebotToken && !/^[A-Za-z0-9_-]{8,200}$/.test(next.onebotToken)) throw new Error('OneBot Token 至少 8 位，仅可用字母、数字、下划线和连字符');
  next.qqToMcTemplate = resolveQqToMcTemplate(next.qqToMcTemplate);
  next.mcToQqTemplate = resolveMcToQqTemplate(next.mcToQqTemplate || DEFAULT_MC_TO_QQ_TEMPLATE);
  next.presenceJoinTemplate ||= DEFAULT_PRESENCE_JOIN_TEMPLATE;
  next.presenceQuitTemplate ||= DEFAULT_PRESENCE_QUIT_TEMPLATE;
  next.serverOnlineTemplate ||= DEFAULT_SERVER_ONLINE_TEMPLATE;
  next.serverOfflineTemplate ||= DEFAULT_SERVER_OFFLINE_TEMPLATE;
  validateQqTemplate(next.qqToMcTemplate);
  parseNameMap(next.groupNames, '群名称映射');
  parseNameMap(next.memberNames, '成员显示名映射');
  if (next.mcToQqTemplate.length > 300 || /[\r\n\0]/.test(next.mcToQqTemplate) || !next.mcToQqTemplate.includes('${player}') || !next.mcToQqTemplate.includes('${message}')) throw new Error('MC → QQ 模板需包含 ${player} 和 ${message}，最多 300 字');
  // 允许 MC → QQ 模板使用 ${qq} 显示玩家绑定的 QQ 号
  if (/\$\{(?!player\}|message\}|qq\}|qqOrEmpty\})[^}]*\}/.test(next.mcToQqTemplate)) throw new Error('MC → QQ 模板存在不支持的占位符，可用 ${player}、${message}、${qq}');
  validatePlainTemplate(next.presenceJoinTemplate, '玩家进服模板', ['player', 'online'], ['player']);
  validatePlainTemplate(next.presenceQuitTemplate, '玩家退服模板', ['player', 'online'], ['player']);
  validatePlainTemplate(next.serverOnlineTemplate, '服务器开启模板', ['time']);
  validatePlainTemplate(next.serverOfflineTemplate, '服务器关闭模板', ['time']);
  for (const flag of booleanFlags) {
    const migratedDefault = (flag === 'presenceNotifyEnabled' || flag === 'serverStatusNotifyEnabled') ? current.mcToQqEnabled === true : false;
    const value = input[flag] ?? current[flag] ?? migratedDefault;
    if (value !== true && value !== false) throw new Error('${flag} 开关格式无效');
    next[flag] = value;
  }
  // 布尔标志归一化之后才判断，此时 next.onebotEnabled 一定是真正的布尔值
  if (next.onebotEnabled === true && !next.onebotToken) throw new Error('启用 OneBot 监听前，请设置 Access Token（避免任何人都能接入）');
  if ((next.qqToMcEnabled || next.mcToQqEnabled || next.presenceNotifyEnabled || next.serverStatusNotifyEnabled) && (!next.qqAppId || !next.qqAppSecret || !next.allowedGroups)) throw new Error('开启 QQ 消息功能前，请填完整 QQ Bot 和允许群配置');
  if ((next.qqToMcEnabled || next.mcToQqEnabled) && !next.pluginKey) throw new Error('使用插件聊天转发前，请设置插件 Key');
  if ((next.presenceNotifyEnabled || next.serverStatusNotifyEnabled || next.serverLogEnabled) && !next.pluginKey) throw new Error('开启插件事件或日志前，请设置插件 Key');
  return next;
}

export function publicConfig(config) {
  const defaults = {
    mcToQqTemplate: DEFAULT_MC_TO_QQ_TEMPLATE,
    presenceJoinTemplate: DEFAULT_PRESENCE_JOIN_TEMPLATE,
    presenceQuitTemplate: DEFAULT_PRESENCE_QUIT_TEMPLATE,
    serverOnlineTemplate: DEFAULT_SERVER_ONLINE_TEMPLATE,
    serverOfflineTemplate: DEFAULT_SERVER_OFFLINE_TEMPLATE
  };
  const result = {};
  for (const key of keys) if (!secrets.includes(key)) result[key] = key === 'qqToMcTemplate' ? resolveQqToMcTemplate(config[key]) : config[key] ?? (defaults[key] ?? '');
  result.chatTransport = 'plugin';
  for (const flag of booleanFlags) result[flag] = config[flag] === true;
  for (const key of secrets) result[key + 'Set'] = Boolean(config[key]);
  return result;
}
