import { randomInt } from 'node:crypto';

const defaults = { min: 1000, max: 10000, commandTemplate: 'money give ${player} ${amount}' };
const locks = new Set();
const dayKey = now => new Date(now + 8 * 3600000).toISOString().slice(0, 10);
const tomorrow = now => new Date((Math.floor((now + 8 * 3600000) / 86400000) + 1) * 86400000 - 8 * 3600000).toISOString();
const validPlayer = value => typeof value === 'string' && /^[\p{L}\p{N}_.!<>\-（）]{1,32}$/u.test(value);

function settingsOf(state) { return { min: state.settings?.min ?? defaults.min, max: state.settings?.max ?? defaults.max, commandTemplate: state.settings?.commandTemplate ?? defaults.commandTemplate }; }
function validateSettings(input) {
  if (!input || !Number.isSafeInteger(input.min) || !Number.isSafeInteger(input.max) || input.min < 1 || input.max > 1000000 || input.min > input.max) throw new Error('金额必须为 1～1000000 的整数，且最低值不能高于最高值');
  const template = input.commandTemplate;
  if (typeof template !== 'string' || template.length > 150 || /[\r\n\0]/.test(template) || !template.includes('${player}') || !template.includes('${amount}') || /\$\{(?!player\}|amount\})[^}]*\}/.test(template)) throw new Error('命令模板必须包含 ${player} 和 ${amount}，且不能包含其他占位符或换行');
  return { min: input.min, max: input.max, commandTemplate: template };
}

async function command(request, api) {
  const { openid, qq, message } = request;
  const match = /^\/(?:qd|签到)(?:\s+add\s+(\S+))?\s*$/iu.exec(message);
  if (!match) return { reply: '格式：/qd 或 /签到；多个玩家请发送 /qd add 玩家名。' };
  if (api.getRegistration(openid) !== qq) return { reply: 'QQ 登记已变更，请重新发送签到命令。' };
  if (locks.has(qq)) return { reply: '签到正在处理，请稍后查询结果。' };
  locks.add(qq);
  try {
    if (!api.enabled()) return { reply: '每日签到当前已关闭。' };
    const now = Date.now();
    const day = dayKey(now);
    const state = await api.readState();
    state.claims ??= {};
    const prior = state.claims[qq];
    if (prior?.day === day) return { reply: `今天已签到：${prior.player} 获得 ${prior.amount} 游戏币。下次可领取：${tomorrow(now)}（UTC+8 为次日 00:00）。` };
    const settings = settingsOf(state);
    const choice = match[1];
    let player;
    if (choice) {
      if (!validPlayer(choice)) return { reply: '玩家名格式无效。' };
      player = choice;
    } else {
      const players = [...new Set(await api.queryPlayers(qq))];
      if (!players.length) return { reply: '当前 QQ 号没有绑定 MC 玩家，请先使用 /mcbind 玩家名。' };
      if (players.some(name => !validPlayer(name))) throw new Error('AQQBot 返回的玩家名格式无效');
      if (players.length > 1) {
        return { reply: `你的 QQ 名下有 ${players.length} 个玩家：\n${players.map((name, index) => `${index + 1}. ${name}`).join('\n')}\n请选择奖励发给谁：/qd add 玩家名（或 /签到 add 玩家名）。也可以直接发送选择命令；每天只能领取一次。` };
      }
      player = players[0];
    }
    if (api.getRegistration(openid) !== qq || (await api.playerOwner(player)) !== qq || !api.enabled()) return { reply: 'QQ 登记、玩家归属或模块状态已变化，未发放奖励。' };
    const amount = randomInt(settings.min, settings.max + 1);
    let output;
    try { output = await api.reward(player, amount, settings.commandTemplate); }
    catch (error) {
      state.records = [{ at: new Date().toISOString(), qq, openid, player, amount, status: '失败', detail: String(error.message).slice(0, 120) }, ...(state.records ?? [])].slice(0, 100);
      await api.writeState(state);
      api.audit(`QQ ${qq} 向 ${player} 签到发放失败`);
      throw error;
    }
    state.claims[qq] = { day, player, amount, at: new Date().toISOString() };
    state.records = [{ at: state.claims[qq].at, qq, openid, player, amount, status: '成功', detail: String(output).slice(0, 120) }, ...(state.records ?? [])].slice(0, 100);
    await api.writeState(state);
    api.audit(`QQ ${qq} 签到成功，玩家 ${player}，奖励 ${amount}`);
    return { reply: `签到成功！${player} 获得 ${amount} 游戏币。下次可领取：${tomorrow(now)}（UTC+8 为次日 00:00）。` };
  } finally { locks.delete(qq); }
}

export async function handle(request, api) {
  if (request.method === 'COMMAND') return command(request, api);
  if (request.method === 'GET' && request.path === 'settings') {
    const state = await api.readState();
    const today = dayKey(Date.now());
    const records = state.records ?? [];
    const claims = Object.values(state.claims ?? {}).filter(item => item.day === today);
    return { body: { id: 'daily-checkin-money', version: api.moduleVersion, enabled: api.enabled(), settings: settingsOf(state), todayCount: claims.length, todayAmount: claims.reduce((sum, item) => sum + item.amount, 0), records } };
  }
  if (request.method === 'POST' && request.path === 'settings') {
    const settings = validateSettings(request.input);
    const state = await api.readState();
    state.settings = settings;
    await api.writeState(state);
    api.audit(`管理员 ${request.username} 修改签到设置`);
    return { body: { ok: true, settings } };
  }
  if (request.method === 'POST' && request.path === 'test') {
    const settings = validateSettings(request.input);
    const output = await api.testRewardTemplate(settings.commandTemplate);
    return { body: { ok: true, output: String(output ?? ''), note: '只执行 help 查询，没有发放游戏币；请核对经济插件实际命令。' } };
  }
  return { status: 404, body: { error: '未找到' } };
}
