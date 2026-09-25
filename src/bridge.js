import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { QQBot, messageFilter } from '@tencent-connect/qqbot-nodejs';
import { rconCommand } from './rcon.js';
import { queryMotd } from './motd.js';
import { parseOnlineList } from './chat-relay.js';
import { makeQqComponents, parseNameMap } from './qq-chat.js';
import { formatMcToQq } from './mc-chat-format.js';
import { normalizeCommand } from './commands.js';
import { resolveQqToMcTemplate, DEFAULT_MC_TO_QQ_TEMPLATE, DEFAULT_PRESENCE_JOIN_TEMPLATE, DEFAULT_PRESENCE_QUIT_TEMPLATE, DEFAULT_SERVER_ONLINE_TEMPLATE, DEFAULT_SERVER_OFFLINE_TEMPLATE } from './config.js';
import { formatMessageTemplate } from './message-templates.js';
import { PluginChatExchange, PluginConnectionState } from './plugin-chat.js';
import { unbindConfirmed, bindRejected, safePlayer, queryPlayerOwner, queryAqqbot } from './aqqbot.js';

const CODE_TTL = 5 * 60 * 1000;
const readBotVersion = () => JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const BEIJING_TIME = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const QQ_FORMAT = /^\d{5,20}$/;
const COMMAND_CATEGORY = {
  qqbind: 'QQ 登记', qqconfirm: 'QQ 登记', qqunbind: 'QQ 登记',
  mcbind: 'MC 绑定', mcunbind: 'MC 解绑', mcunallbind: 'MC 解绑', mymc: '服务器查询', motd: '服务器查询', list: '服务器查询', tps: '性能查询', status: '连接查询'
};
const redactCode = value => String(value ?? '').replace(/BIND-[A-F0-9]{6}/gi, 'BIND-******');
const stripConsoleFormatting = value => String(value ?? '')
  .replace(/§x(?:§[0-9a-f]){6}/gi, '')
  .replace(/§[0-9a-fk-or]/gi, '')
  .replace(/\x1b\[[0-9;]*m/g, '')
  .trim();

export function formatTpsOutput(value) {
  const clean = stripConsoleFormatting(value);
  if (!clean) return 'RCON 未返回 TPS 信息';
  const match = /TPS\s+from\s+last\s+1m\s*,\s*5m\s*,\s*15m\s*:\s*([*!]?\d+(?:\.\d+)?)\s*,\s*([*!]?\d+(?:\.\d+)?)\s*,\s*([*!]?\d+(?:\.\d+)?)/i.exec(clean);
  if (!match) return clean;
  return `最近 1 分钟：${match[1]}\n最近 5 分钟：${match[2]}\n最近 15 分钟：${match[3]}`;
}

export class Bridge {
  constructor(store, deps = {}) {
    this.store = store;
    this.rcon = deps.rcon ?? rconCommand;
    this.isQqClearing = deps.isQqClearing ?? (() => false);
    this.readVersion = deps.readVersion ?? readBotVersion;
    this.motd = deps.motd ?? queryMotd;
    this.createBot = deps.createBot ?? (options => new QQBot(options));
    this.modules = deps.modules ?? null;
    this.send = deps.send ?? ((event, message) => this.sendReply(event, message));
    this.pending = new Map();
    this.seen = new Map();
    this.lastCommand = new Map();
    this.discoveredGroups = new Set();
    this.discoveredSenders = new Set();
    this.status = '未连接';
    this.bot = null;
    this.pluginExchange = new PluginChatExchange(chat => this.sendMcChatToQq(chat), event => this.sendMcPresenceToQq(event), event => this.sendMcLifecycleToQq(event));
    this.pluginConnection = new PluginConnectionState();
    this.pluginVersion = '未上报';
    this.pluginConnectionTimer = null;
    this.pendingServerStatus = null;
    this.aqqbotDatabase = { available: false, reason: '尚未收到插件快照', rows: [], capturedAt: null, receivedAt: null };
    this.serverLogs = [];
    this.serverLogSequence = 0;
    this.serverLogBatches = new Set();
    this.lastServerNotice = { status: null, at: 0 };
    this.stopped = false;
  }

  start() {
    this.stopped = false;
    this.connect();
    this.pluginConnectionTimer = setInterval(() => {
      if (this.pluginConnection.check() === 'offline') {
        void this.sendMcServerStatusToQq('offline').catch(error => this.store.audit('mc-server-status-error', error.message));
      }
    }, 5000);
    this.pluginConnectionTimer.unref?.();
  }

  stop() {
    this.stopped = true;
    if (this.pluginConnectionTimer) clearInterval(this.pluginConnectionTimer);
    this.pluginConnectionTimer = null;
    this.pendingServerStatus = null;
    this.bot?.stop();
    this.bot = null;
    this.status = '未连接';
  }

  restart() {
    this.stop();
    this.stopped = false;
    this.pluginExchange = new PluginChatExchange(chat => this.sendMcChatToQq(chat), event => this.sendMcPresenceToQq(event), event => this.sendMcLifecycleToQq(event));
    this.start();
  }

  exchangePluginChat(input) {
    const response = this.pluginExchange.exchange(input);
    this.observeAqqbotSnapshot(input?.aqqbotSnapshot);
    this.observeServerLogs(input?.serverLogs);
    this.observePluginVersion(input?.pluginVersion);
    const explicitStop = input.sent.some(item => item?.kind === 'stop');
    if (this.pluginConnection.observe() === 'online' && !explicitStop) {
      void this.sendMcServerStatusToQq('online').catch(error => this.store.audit('mc-server-status-error', error.message));
    }
    return {
      ...response,
      logEnabled: this.store.config.serverLogEnabled === true
    };
  }

  observePluginVersion(value) {
    if (value === undefined) return;
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(value)) throw new Error('插件版本格式无效');
    this.pluginVersion = value;
  }

  observeAqqbotSnapshot(input) {
    if (!input || typeof input !== 'object') return;
    const captured = Number(input.capturedAt);
    const base = {
      available: input.available === true,
      reason: typeof input.reason === 'string' ? input.reason.slice(0, 160) : '',
      capturedAt: Number.isFinite(captured) && captured > 0 ? new Date(captured).toISOString() : null,
      receivedAt: new Date().toISOString(),
      rows: []
    };
    if (base.available) {
      if (!Array.isArray(input.rows) || input.rows.length > 5000) return;
      const seen = new Set();
      for (const item of input.rows) {
        const qq = String(item?.qq ?? '').trim();
        if (!/^\d{5,20}$/.test(qq) || seen.has(qq) || !Array.isArray(item.players)) continue;
        seen.add(qq);
        const players = [...new Set(item.players.map(value => String(value).trim()).filter(value => /^[A-Za-z0-9_]{3,16}$/.test(value)))].slice(0, 100);
        base.rows.push({ qq, players });
      }
      base.rows.sort((a, b) => a.qq.localeCompare(b.qq));
    }
    this.aqqbotDatabase = base;
  }

  getAqqbotDatabase() {
    return {
      ...this.aqqbotDatabase,
      connected: this.pluginExchange.lastSeen > Date.now() - 10000,
      rows: this.aqqbotDatabase.rows.map(item => ({ ...item, openid: this.store.qqOwner(item.qq) || '' }))
    };
  }

  observeServerLogs(batch) {
    if (this.store.config.serverLogEnabled !== true || !batch || typeof batch !== 'object') return;
    const source = String(batch.source ?? '');
    const start = Number(batch.start);
    const end = Number(batch.end);
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(source) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || !Array.isArray(batch.lines) || batch.lines.length > 200) return;
    const batchId = source + ':' + start + ':' + end;
    if (this.serverLogBatches.has(batchId)) return;
    const clean = batch.lines.map(line => String(line)).filter(line => line.length > 0 && line.length <= 1000 && !/[\0]/.test(line));
    this.serverLogBatches.add(batchId);
    if (this.serverLogBatches.size > 4000) this.serverLogBatches.delete(this.serverLogBatches.values().next().value);
    const receivedAt = new Date().toISOString();
    for (const line of clean) this.serverLogs.push({ id: ++this.serverLogSequence, receivedAt, line });
    if (this.serverLogs.length > 2000) this.serverLogs.splice(0, this.serverLogs.length - 2000);
  }

  getServerLogs() {
    return {
      enabled: this.store.config.serverLogEnabled === true,
      connected: this.pluginExchange.lastSeen > Date.now() - 10000,
      lines: this.serverLogs.slice()
    };
  }

  connect() {
    const { qqAppId, qqAppSecret } = this.store.config;
    if (!qqAppId || !qqAppSecret) { this.status = '未配置'; return; }
    try {
      const bot = this.createBot({ appId: qqAppId, appSecret: qqAppSecret });
      bot.use?.(messageFilter({ skipSelfEcho: true, dedup: { windowMs: 10000 } }));
      this.bot = bot;
      this.status = '连接中';
      bot.on('ready', () => {
        if (this.bot !== bot) return;
        this.status = '已连接';
        void this.flushPendingServerStatus().catch(error => this.store.audit('mc-server-status-error', error.message));
      });
      bot.on('resumed', () => {
        if (this.bot !== bot) return;
        this.status = '已连接';
        void this.flushPendingServerStatus().catch(error => this.store.audit('mc-server-status-error', error.message));
      });
      bot.on('error', error => {
        if (this.bot !== bot) return;
        this.status = '连接异常';
        this.store.audit('bot-error', error.message);
      });
      bot.on('message', (_context, message) => {
        this.handleEvent(message).catch(error => this.store.audit('bot-error', error.message));
      });
      Promise.resolve(bot.start()).catch(error => {
        if (this.bot !== bot || this.stopped) return;
        this.status = '连接失败';
        this.store.audit('bot-error', error.message);
      });
    } catch (error) {
      this.status = '连接失败';
      this.store.audit('bot-error', error.message);
    }
  }

  async sendReply(event, message) {
    if (!this.bot) throw new Error('QQ 官方 Bot 未连接');
    await this.bot.sendText(event.replyTarget, message);
  }

  async sendMcChatToQq(chat) {
    if (this.stopped || this.store.config.mcToQqEnabled !== true || !this.bot || this.status !== '已连接') return;
    const content = formatMcToQq(this.store.config.mcToQqTemplate || DEFAULT_MC_TO_QQ_TEMPLATE, chat);
    await this.sendToAllowedGroups(content, 'mc-to-qq-error');
  }

  async sendMcPresenceToQq(event) {
    if (this.stopped || this.store.config.presenceNotifyEnabled !== true || !this.bot || this.status !== '已连接') return;
    const template = event.kind === 'join'
      ? this.store.config.presenceJoinTemplate || DEFAULT_PRESENCE_JOIN_TEMPLATE
      : this.store.config.presenceQuitTemplate || DEFAULT_PRESENCE_QUIT_TEMPLATE;
    const content = formatMessageTemplate(template, { player: event.player, online: event.players.length });
    await this.sendToAllowedGroups(content, 'mc-presence-error');
  }

  async sendMcLifecycleToQq(event) {
    await this.sendMcServerStatusToQq(event.kind === 'start' ? 'online' : 'offline');
  }

  async sendMcServerStatusToQq(status) {
    if (this.stopped || this.store.config.serverStatusNotifyEnabled !== true) return;
    const now = Date.now();
    if (this.lastServerNotice.status === status && now - this.lastServerNotice.at < 60_000) return;
    this.lastServerNotice = { status, at: now };
    this.pendingServerStatus = status;
    await this.flushPendingServerStatus();
  }

  async flushPendingServerStatus() {
    if (!this.pendingServerStatus || this.stopped || !this.bot || this.status !== '已连接') return;
    const status = this.pendingServerStatus;
    this.pendingServerStatus = null;
    const template = status === 'online'
      ? this.store.config.serverOnlineTemplate || DEFAULT_SERVER_ONLINE_TEMPLATE
      : this.store.config.serverOfflineTemplate || DEFAULT_SERVER_OFFLINE_TEMPLATE;
    const time = BEIJING_TIME.format(new Date()).replace('T', ' ');
    await this.sendToAllowedGroups(formatMessageTemplate(template, { time }), 'mc-server-status-error');
  }

  async sendToAllowedGroups(content, auditCategory) {
    for (const targetId of this.store.config.allowedGroups?.split(',').filter(Boolean) ?? []) {
      try { await this.bot.sendText({ scope: 'group', targetId }, content); }
      catch (error) { this.store.audit(auditCategory, `群 ${targetId}：${error.message}`); }
    }
  }

  async handleEvent(event) {
    if (event.kind !== 'group' || event.senderIsBot === true || event.raw?.author?.bot === true) return;
    const openid = String(event.senderId ?? '');
    const group = String(event.groupOpenid ?? '');
    const allowed = this.store.config.allowedGroups?.split(',').filter(Boolean) ?? [];
    if (group && !allowed.includes(group) && !this.discoveredGroups.has(group)) {
      this.discoveredGroups.add(group);
      this.store.audit('group-discovered', `发现 QQ 群 OpenID：${group}；请填到“修改信息”允许群列表`);
    }
    if (!allowed.includes(group) || !/^[A-Za-z0-9_-]{5,128}$/.test(openid) || event.replyTarget?.scope !== 'group' || event.replyTarget.targetId !== group) return;
    if (this.store.config.qqToMcEnabled === true && !this.discoveredSenders.has(openid)) {
      this.discoveredSenders.add(openid);
      this.store.audit('chat-sender-discovered', `群 ${group}，成员 OpenID ${openid}，官方 Bot 昵称：${String(event.senderName ?? '未知').slice(0, 48)}`);
    }
    const originalMessage = String(event.content ?? '').replace(/^<@!?[^>]+>\s*/, '').trim();
    const message = normalizeCommand(originalMessage);
    const module = this.modules?.commandFor(message) ?? null;
    const isCode = /^BIND-[A-F0-9]{6}$/i.test(message);
    const submittedCode = isCode ? message.toUpperCase() : null;
    const isCommand = /^\/(?:qqbind|qqunbind|mcbind|mcunbind|mcunallbind|mymc|motd|list|tps|status)(?:\s|$)/i.test(message);
    const commandLike = /^[\u200B-\u200D\u2060\uFEFF]*[\/／]/u.test(message);
    const isChat = !isCommand && !isCode && message && !commandLike;
    if (!isCommand && !isCode && !module && !(isChat && this.store.config.qqToMcEnabled === true)) return;
    if (event.messageId) {
      const key = `${group}:${event.messageId}`;
      if (this.seen.has(key)) return;
      this.seen.set(key, Date.now());
      for (const [id, at] of this.seen) if (at < Date.now() - 10 * 60 * 1000) this.seen.delete(id);
    }
    if (isChat && !module) {
      try {
        const userName = parseNameMap(this.store.config.memberNames, '成员显示名映射').get(openid) || event.senderName || this.store.state.users[openid]?.qq || '群友';
        const groupName = parseNameMap(this.store.config.groupNames, '群名称映射').get(group) || 'QQ群';
        const components = makeQqComponents(resolveQqToMcTemplate(this.store.config.qqToMcTemplate), { userName, message, groupId: group, groupName });
        if (components) this.pluginExchange.enqueue(components);
      } catch (error) { this.store.audit('qq-to-mc-error', `群 ${group}：${error.message}`); }
      return;
    }
    const ownCode = submittedCode && this.pending.get(openid)?.code === submittedCode && this.pending.get(openid)?.group === group;
    const now = Date.now();
    if (!ownCode && !module && (this.lastCommand.get(openid) ?? 0) + 1500 > now) return;
    this.lastCommand.set(openid, now);
    const commandName = isCode ? 'qqconfirm' : message.split(/\s+/)[0].slice(1).toLowerCase();
    const qqBefore = this.store.state.users[openid]?.qq;
    let logStatus = '已回复';
    let logResult = '';
    try {
      let reply;
      if (/^\/qqbind(?:\s|$)/i.test(message)) reply = this.beginRegistration(openid, group, message);
      else if (isCode) reply = this.confirmRegistration(openid, group, submittedCode);
      else {
        const user = this.store.state.users[openid];
        if (!user?.qq) { reply = '请先登记 QQ 号：/qqbind <你的QQ号>。按提示二次确认后，重新发送刚才的命令。'; logStatus = '未登记拦截'; }
        else if (module) reply = await this.modules.handleCommand(module, { message, openid, group, qq: user.qq });
        else if (/^\/qqunbind(?:\s|$)/i.test(message)) reply = await this.unbindQq(openid, message);
        else if (/^\/mcbind(?:\s|$)/i.test(message)) reply = await this.bindPlayer(openid, group, message);
        else if (/^\/mcunbind(?:\s|$)/i.test(message)) reply = await this.unbindPlayer(openid, group, message);
        else if (/^\/mcunallbind(?:\s|$)/i.test(message)) reply = await this.unbindAllPlayers(openid, group, message);
        else if (/^\/mymc(?:\s|$)/i.test(message)) reply = await this.myMc(openid, message);
        else if (/^\/status\s*$/i.test(message)) reply = await this.bridgeStatus();
        else if (/^\/motd\s*$/i.test(message)) {
          const info = await this.motd(this.store.config);
          const shown = (info.players ?? []).slice(0, 30);
          const names = info.online === 0 ? '（暂无在线玩家）' : shown.length
            ? `（${shown.join('，')}${Number(info.online) > shown.length ? `；仅显示服务器提供的 ${shown.length} 人` : ''}）`
            : '（服务器未提供玩家名单）';
          reply = `🎮 服务器状态\n👥 当前在线：${info.online ?? '?'} 人（上限 ${info.max ?? '?'} 人）\n🧑 在线玩家：${names}\n\n📢 服务器介绍：\n${info.motd || '（空）'}${info.version ? `\n\n🧩 游戏版本：${info.version}` : ''}`;
        } else if (/^\/list\s*$/i.test(message)) {
          let names = parseOnlineList(await this.rcon(this.store.config, 'list'));
          if (!names) {
            const info = await this.motd(this.store.config);
            if (Number.isInteger(info.online) && info.players?.length === info.online) names = info.players;
          }
          if (!names) throw new Error('服务器没有提供完整的当前在线玩家名单');
          reply = `在线玩家（${names.length}）：${names.length ? names.join('，') : '无'}`;
        } else if (/^\/tps\s*$/i.test(message)) {
          const output = await this.rcon(this.store.config, 'tps');
          reply = `⚡ 服务器 TPS\n${formatTpsOutput(output)}`;
        } else reply = '命令格式：/qqbind <QQ号>、/qqunbind、/mcbind <玩家名>、/mcunbind <玩家名>、/mcunallbind、/mymc、/motd、/list、/tps、/status';
      }
      await this.send(event, reply.slice(0, 1800));
      logResult = reply;
    } catch (error) {
      logStatus = '失败';
      logResult = `操作失败：${error.message}`;
      this.store.audit('command-error', `${openid}：${error.message}`);
      await this.send(event, `操作失败：${error.message}`);
    } finally {
      try {
        this.store.recordPlayerCommand({
          openid, group,
          qq: this.store.state.users[openid]?.qq ?? qqBefore ?? '',
          command: redactCode(originalMessage),
          category: module ? module.name : COMMAND_CATEGORY[commandName],
          status: logStatus,
          result: redactCode(logResult)
        });
      } catch {
        try { this.store.audit('player-log-error', '玩家命令日志保存失败'); } catch {}
      }
    }
  }

  async bridgeStatus() {
    const config = this.store.config;
    let rconState = '未配置';
    if (config.rconHost && config.rconPort && config.rconPassword) {
      try {
        await this.rcon(config, 'list');
        rconState = '正常';
      } catch {
        rconState = '异常（连接或认证失败）';
      }
    }
    const now = Date.now();
    const plugin = this.pluginConnection;
    const pluginState = !plugin.lastSeen
      ? '未连接（尚未收到心跳）'
      : now - plugin.lastSeen >= plugin.timeoutMs
        ? '异常（心跳超时）'
        : '正常（最近心跳 ' + Math.max(0, Math.floor((now - plugin.lastSeen) / 1000)) + ' 秒前）';
    const botState = this.status === '已连接' ? '正常' : this.status;
    return [
      '📊 桥接服务状态',
      '🕒 当前时间：' + BEIJING_TIME.format(new Date(now)) + '（UTC+8）',
      '🔌 插件连接：' + pluginState,
      '🧱 插件版本：' + this.pluginVersion,
      '🎮 RCON 连接：' + rconState,
      '🤖 QQ Bot 连接：' + botState,
      '🧩 BOT 服务端版本：' + this.readVersion()
    ].join('\n');
  }

  assertRegistrationCurrent(openid, user) {
    if (this.store.state.users[openid] !== user) throw new Error('QQ 登记已变更，请重新发送命令');
  }

  beginRegistration(openid, group, message) {
    if (this.store.state.users[openid]?.qq) return `已登记 QQ 号 ${this.store.state.users[openid].qq}，无需重复登记。`;
    const qq = message.match(/^\/qqbind\s+(\d{5,20})\s*$/i)?.[1];
    if (!qq || !QQ_FORMAT.test(qq)) return '格式：/qqbind <你的QQ号>，例如 /qqbind 36000000';
    if (this.store.qqOwner(qq, openid)) return '这个 QQ 号已被登记，请联系管理员核对。';
    const pending = { group, qq, code: `BIND-${randomBytes(3).toString('hex').toUpperCase()}`, expires: Date.now() + CODE_TTL };
    this.pending.set(openid, pending);
    return `请二次核对你填写的 QQ 号：${qq}\n如果正确，请由你本人在本群 @机器人发送：${pending.code}\n有效期：5 分钟。确认后自动登记，不需要管理员审核。注意：此步骤不验证 QQ 号归属，也不会绑定 MC 玩家。`;
  }

  confirmRegistration(openid, group, code) {
    const pending = this.pending.get(openid);
    if (!pending || pending.code !== code || pending.group !== group) return '确认码无效，或不属于你及当前群。请重新发送 /qqbind <QQ号>。';
    if (pending.expires < Date.now()) { this.pending.delete(openid); return '确认码已过期，请重新发送 /qqbind <QQ号>。'; }
    this.store.register(openid, pending.qq, group);
    this.pending.delete(openid);
    this.lastCommand.delete(openid);
    this.store.audit('register', `OpenID ${openid} 自填并确认 QQ ${pending.qq}`);
    return 'QQ 号 ' + pending.qq + ' 已登记。现在可以发送 /mymc 查询名下玩家，也可以使用 /mcbind <玩家名>、/mcunbind <玩家名>、/motd 或 /list。之前被拦下的命令请重新发送。';
  }

  async unbindQq(openid, message) {
    if (!/^\/qqunbind\s*$/i.test(message)) return '格式：/qqunbind';
    const user = this.store.state.users[openid];
    const qq = user?.qq;
    if (!qq) return '请先发送 /qqbind <QQ号> 完成登记。';
    const result = await queryAqqbot(this.store.config, this.rcon, 'qq', qq);
    if (result.players.length) return 'AQQBot 中仍有 ' + result.players.length + ' 个玩家绑定：' + result.players.join('、') + '。请先用 /mcunbind 或 /mcunallbind 解除。';
    this.assertRegistrationCurrent(openid, user);
    this.store.unregister(openid);
    this.store.audit('qq-unbind', 'OpenID ' + openid + ' 解除了 QQ 登记');
    return 'QQ 号已解除登记。再次使用业务命令前，请先发送 /qqbind <QQ号>。';
  }

  async myMc(openid, message) {
    if (!/^\/mymc\s*$/i.test(message)) return '格式：/mymc';
    const user = this.store.state.users[openid];
    const qq = user?.qq;
    if (!qq) return '请先发送 /qqbind <QQ号> 完成登记。';
    const result = await queryAqqbot(this.store.config, this.rcon, 'qq', qq);
    this.assertRegistrationCurrent(openid, user);
    return result.players.length ? 'QQ ' + qq + ' 名下的 MC 玩家（' + result.players.length + '）：' + result.players.join('、') : 'QQ ' + qq + ' 名下暂无 MC 玩家。';
  }

  async bindPlayer(openid, group, message) {
    const match = message.match(/^\/mcbind\s+(\S+)\s*$/i);
    if (!match) return '格式：/mcbind <Minecraft 玩家名>，例如 /mcbind implayer';
    const user = this.store.state.users[openid];
    const qq = user?.qq;
    if (!qq) return '请先发送 /qqbind <QQ号> 完成登记。';
    const player = safePlayer(match[1]);
    const owner = await queryPlayerOwner(this.store.config, this.rcon, player);
    if (owner === qq) return '玩家 ' + player + ' 已在 AQQBot 中绑定当前 QQ 号。';
    if (owner) return '玩家 ' + player + ' 已绑定其他 QQ 号，不能重复绑定。';
    this.assertRegistrationCurrent(openid, user);
    if (this.isQqClearing(qq)) throw new Error('该 QQ 正在后台清除 AQQBot 绑定，请稍后重试');
    const result = String(await this.rcon(this.store.config, 'aqqbot whitelist bind ' + qq + ' ' + player) ?? '');
    if (bindRejected(result)) {
      this.store.audit('bind-rejected', '群 ' + group + '，QQ ' + qq + '，玩家 ' + player + '：服务器拒绝绑定');
      return '服务器未确认绑定。服务器响应：' + result.slice(0, 500);
    }
    const confirmed = await queryPlayerOwner(this.store.config, this.rcon, player);
    this.store.audit('mc-bind', '群 ' + group + '，QQ ' + qq + '，玩家 ' + player + '：AQQBot 绑定命令已执行');
    return confirmed === qq
      ? '已为玩家 ' + player + ' 发送 AQQBot 绑定命令，使用的 QQ 号是 ' + qq + '。' + (result ? '\n服务器响应：' + result.slice(0, 500) : '\n服务器查询已确认绑定。')
      : '已为玩家 ' + player + ' 发送 AQQBot 绑定命令，使用的 QQ 号是 ' + qq + '。\n服务器查询尚未确认，请以 AQQBot 实际绑定状态为准。';
  }

  async unbindPlayer(openid, group, message) {
    const match = message.match(/^\/mcunbind\s+(\S+)\s*$/i);
    if (!match) return '格式：/mcunbind <Minecraft 玩家名>，例如 /mcunbind implayer';
    const player = safePlayer(match[1]);
    const user = this.store.state.users[openid];
    const qq = user?.qq;
    if (!qq) return '请先发送 /qqbind <QQ号> 完成登记。';
    const owner = await queryPlayerOwner(this.store.config, this.rcon, player);
    if (owner === null) return 'AQQBot 中没有玩家 ' + player + ' 的绑定。';
    if (owner !== qq) return '玩家 ' + player + ' 不属于当前 QQ 号，未发送解绑命令。';
    this.assertRegistrationCurrent(openid, user);
    if (this.isQqClearing(qq)) throw new Error('该 QQ 正在后台清除 AQQBot 绑定，请稍后重试');
    const result = String(await this.rcon(this.store.config, 'aqqbot whitelist unbind player ' + player) ?? '');
    if (!unbindConfirmed(result)) {
      this.store.audit('unbind-unconfirmed', '群 ' + group + '，QQ ' + qq + '，玩家 ' + player + '：服务器未明确确认解绑');
      return '服务器未明确确认解绑。服务器响应：' + (result || '（无返回文字）') + '。请管理员在 RCON 终端核对。';
    }
    const after = await queryPlayerOwner(this.store.config, this.rcon, player);
    if (after !== null) return 'AQQBot 回复成功，但查询显示玩家 ' + player + ' 仍有绑定，请管理员核对。';
    this.store.audit('mc-unbind', '群 ' + group + '，QQ ' + qq + '，玩家 ' + player + '：服务器确认解绑');
    return '玩家 ' + player + ' 已从当前 QQ 号解绑；其他玩家和 QQ 登记保持不变。服务器响应：' + result.slice(0, 500);
  }

  async unbindAllPlayers(openid, group, message) {
    if (!/^\/mcunallbind\s*$/i.test(message)) return '格式：/mcunallbind';
    const user = this.store.state.users[openid];
    const qq = user?.qq;
    if (!qq) return '请先发送 /qqbind <QQ号> 完成登记。';
    const players = (await queryAqqbot(this.store.config, this.rcon, 'qq', qq)).players;
    if (!players.length) return '当前 QQ 号没有已绑定的 MC 玩家。';
    const done = [];
    for (const player of players) {
      try {
        this.assertRegistrationCurrent(openid, user);
        const reply = await this.unbindPlayer(openid, group, '/mcunbind ' + player);
        if ((await queryPlayerOwner(this.store.config, this.rcon, player)) !== null) return '已解绑 ' + done.length + ' 个玩家：' + (done.join('、') || '无') + '。' + player + ' 未得到服务器明确确认，已停止；其余玩家未处理。' + reply;
      } catch (error) {
        return '已解绑 ' + done.length + ' 个玩家：' + (done.join('、') || '无') + '。在 ' + player + ' 处停止：' + error.message + '；其余玩家未处理。';
      }
      done.push(player);
    }
    return '已逐条解绑 ' + done.length + ' 个玩家：' + done.join('、') + '。QQ 号登记仍保留。';
  }
}
