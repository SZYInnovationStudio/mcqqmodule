const QQ = /^\d{5,20}$/;
const PLAYER = /^[\p{L}\p{N}_.!<>\-（）]{1,32}$/u;
const UNBIND_REJECTED = /(?:失败|错误|无效|不存在|没有|未绑定|用法|未知命令|not bound|invalid|error|no permission|usage|unknown command)/i;
const BIND_REJECTED = /(?:失败|错误|无效|已存在|已绑定|不能|无法|拒绝|达到上限|没有权限|用法|未知命令|too many|already exists|failed|not allowed|invalid|error|no permission|usage|unknown command)/i;

export function safePlayer(player) {
  if (typeof player !== 'string' || !PLAYER.test(player)) throw new Error('玩家名格式无效：仅支持单个安全名称，最长 32 个字符');
  return player;
}

export function safeQq(qq) {
  if (typeof qq !== 'string' || !QQ.test(qq)) throw new Error('QQ 号格式无效');
  return qq;
}

export function unbindConfirmed(result) {
  return /(?:成功|successfully|unbound)/i.test(result) && !UNBIND_REJECTED.test(result);
}

export function bindRejected(result) {
  return BIND_REJECTED.test(result);
}

export async function queryAqqbot(config, rcon, type, value) {
  if (type !== 'qq' && type !== 'player') throw new Error('查询类型无效');
  const token = type === 'qq' ? safeQq(value) : safePlayer(value);
  const output = await rcon(config, 'aqqbot whitelist query ' + type + ' ' + token);
  const clean = String(output ?? '').replace(/§[0-9A-FK-OR]/gi, '');
  const qqMatch = clean.match(/QQ号\s*:\s*(\d{5,20}|null)/i);
  const namesMatch = clean.match(/游戏名\s*:\s*([^\r\n]*)/i);
  if (!qqMatch || !namesMatch) throw new Error('AQQBot 未返回可识别的查询结果');
  const qq = qqMatch[1].toLowerCase() === 'null' ? null : qqMatch[1];
  const players = namesMatch[1].trim() ? namesMatch[1].split(/\s*[,，]\s*/).filter(Boolean) : [];
  return { qq, players };
}

export async function queryPlayerOwner(config, rcon, player) {
  return (await queryAqqbot(config, rcon, 'player', player)).qq;
}
