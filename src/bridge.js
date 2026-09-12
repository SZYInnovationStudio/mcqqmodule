import { randomBytes } from 'node:crypto';
import { QQBot, messageFilter } from '@tencent-connect/qqbot-nodejs';
import { rconCommand } from './rcon.js';
import { queryMotd } from './motd.js';
import { parseOnlineList } from './chat-relay.js';
import { makeQqTellraw, parseNameMap } from './qq-chat.js';
import { McsmOutputRelay, formatMcToQq } from './mcsm.js';
import { resolveQqToMcTemplate, DEFAULT_MC_TO_QQ_TEMPLATE } from './config.js';
import { PluginChatExchange, PluginConnectionState } from './plugin-chat.js';

const CODE_TTL = 5 * 60 * 1000;
const QQ_FORMAT = /^\d{5,20}$/;
const COMMAND_CATEGORY = {
  qqbind: 'QQ 登记', qqconfirm: 'QQ 登记', qqunbind: 'QQ 登记',
  mcbind: 'MC 绑定', mcunbind: 'MC 解绑', mcunallbind: 'MC 解绑', motd: '服务器查询', list: '服务器查询'
};
const redactCode = value => String(value ?? '').replace(/BIND-[A-F0-9]{6}/gi, 'BIND-******');

export class Bridge {
  constructor(store, deps = {}) {
    this.store = store;
    this.rcon = deps.rcon ?? rconCommand;
    this.motd = deps.motd ?? queryMotd;
    this.createBot = deps.createBot ?? (options => new QQBot(options));
    this.createOutputRelay = deps.createOutputRelay ?? ((config, onChat, onError) => new McsmOutputRelay(config, onChat, onError));
    this.send = deps.send ?? ((event, message) => this.sendReply(event, message));
    this.pending = new Map();
    this.seen = new Map();
    this.lastCommand = new Map();
    this.discoveredGroups = new Set();
    this.discoveredSenders = new Set();
    this.status = '未连接';
    this.bot = null;
    this.outputRelay = null;
    this.pluginExchange = new PluginChatExchange(chat => this.sendMcChatToQq(chat), event => this.sendMcPresenceToQq(event));
    this.pluginConnection = new PluginConnectionState();
    this.pluginConnectionTimer = null;
    this.pendingServerStatus = null;
    this.stopped = false;
  }

  start() {
    this.stopped = false;
    this.connect();
    if (this.store.config.chatTransport === 'plugin') {
      this.pluginConnectionTimer = setInterval(() => {
        if (this.pluginConnection.check() === 'offline') {
          void this.sendMcServerStatusToQq('offline').catch(error => this.store.audit('mc-server-status-error', error.message));
        }
      }, 5000);
      this.pluginConnectionTimer.unref?.();
    }
    if (this.store.config.mcToQqEnabled === true && this.store.config.chatTransport !== 'plugin') {
      this.outputRelay = this.createOutputRelay(
        this.store.config,
        chat => this.sendMcChatToQq(chat),
        error => this.store.audit('mcsm-relay-error', error.message)
      );
      this.outputRelay.start();
    }
  }

  stop() {
    this.stopped = true;
    if (this.pluginConnectionTimer) clearInterval(this.pluginConnectionTimer);
    this.pluginConnectionTimer = null;
    this.pendingServerStatus = null;
    this.outputRelay?.stop();
    this.outputRelay = null;
    this.bot?.stop();
    this.bot = null;
    this.status = '未连接';
  }

  restart() {
    this.stop();
    this.pluginExchange = new PluginChatExchange(chat => this.sendMcChatToQq(chat), event => this.sendMcPresenceToQq(event));
    this.start();
  }

  exchangePluginChat(input) {
    if (this.store.config.chatTransport !== 'plugin') throw new Error('插件聊天模式未启用');
    const response = this.pluginExchange.exchange(input);
    if (this.pluginConnection.observe() === 'online') {
      void this.sendMcServerStatusToQq('online').catch(error => this.store.audit('mc-server-status-error', error.message));
    }
    return response;
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
    if (this.stopped || this.store.config.chatTransport !== 'plugin' || this.store.config.mcToQqEnabled !== true || !this.bot || this.status !== '已连接') return;
    const players = event.players.join('、');
    const roster = players.length > 1500 ? `${players.slice(0, 1500)}…（名单过长）` : players || '无';
    const action = event.kind === 'join' ? '进入了服务器' : '离开了服务器';
    await this.sendToAllowedGroups(`[服务器] ${event.player} ${action}\n在线玩家（${event.players.length}）：${roster}`, 'mc-presence-error');
  }

  async sendMcServerStatusToQq(status) {
    if (this.stopped || this.store.config.chatTransport !== 'plugin' || this.store.config.mcToQqEnabled !== true) return;
    this.pendingServerStatus = status;
    await this.flushPendingServerStatus();
  }

  async flushPendingServerStatus() {
    if (!this.pendingServerStatus || this.stopped || !this.bot || this.status !== '已连接') return;
    const status = this.pendingServerStatus;
    this.pendingServerStatus = null;
    const content = status === 'online'
      ? '[服务器] MC 服务器已上线'
      : '[服务器] MC 服务器已离线（可能是关服或插件连接中断）';
    await this.sendToAllowedGroups(content, 'mc-server-status-error');
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
    if (!allowed.includes(group) || !openid || !event.replyTarget) return;
    if (this.store.config.qqToMcEnabled === true && !this.discoveredSenders.has(openid)) {
      this.discoveredSenders.add(openid);
      this.store.audit('chat-sender-discovered', `群 ${group}，成员 OpenID ${openid}，官方 Bot 昵称：${String(event.senderName ?? '未知').slice(0, 48)}`);
    }
    const message = String(event.content ?? '').replace(/^<@!?[^>]+>\s*/, '').trim();
    const isCode = /^BIND-[A-F0-9]{6}$/i.test(message);
    const submittedCode = isCode ? message.toUpperCase() : null;
    const isCommand = /^\/(?:qqbind|qqunbind|mcbind|mcunbind|mcunallbind|motd|list)(?:\s|$)/i.test(message);
    const isChat = !isCommand && !isCode && message && !message.startsWith('/');
    if (!isCommand && !isCode && !(isChat && this.store.config.qqToMcEnabled === true)) return;
    if (event.messageId) {
      const key = `${group}:${event.messageId}`;
      if (this.seen.has(key)) return;
      this.seen.set(key, Date.now());
      for (const [id, at] of this.seen) if (at < Date.now() - 10 * 60 * 1000) this.seen.delete(id);
    }
    if (isChat) {
      try {
        const userName = parseNameMap(this.store.config.memberNames, '成员显示名映射').get(openid) || event.senderName || this.store.state.users[openid]?.qq || '群友';
        const groupName = parseNameMap(this.store.config.groupNames, '群名称映射').get(group) || 'QQ群';
        const command = makeQqTellraw(resolveQqToMcTemplate(this.store.config.qqToMcTemplate), { userName, message, groupId: group, groupName });
        if (command) {
          if (this.store.config.chatTransport === 'plugin') this.pluginExchange.enqueue(JSON.parse(command.slice('tellraw @a '.length)).extra);
          else await this.rcon(this.store.config, command);
        }
      } catch (error) { this.store.audit('qq-to-mc-error', `群 ${group}：${error.message}`); }
      return;
    }
    const ownCode = submittedCode && this.pending.get(openid)?.code === submittedCode && this.pending.get(openid)?.group === group;
    const now = Date.now();
    if (!ownCode && (this.lastCommand.get(openid) ?? 0) + 1500 > now) return;
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
        else if (/^\/qqunbind(?:\s|$)/i.test(message)) reply = this.unbindQq(openid, message);
        else if (/^\/mcbind(?:\s|$)/i.test(message)) reply = await this.bindPlayer(openid, group, message);
        else if (/^\/mcunbind(?:\s|$)/i.test(message)) reply = await this.unbindPlayer(openid, group, message);
        else if (/^\/mcunallbind(?:\s|$)/i.test(message)) reply = await this.unbindAllPlayers(openid, group, message);
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
          reply = names.length ? `当前在线玩家：${names.join('，')}` : '当前没有在线玩家';
        } else reply = '命令格式：/qqbind <QQ号>、/qqunbind、/mcbind <玩家名>、/mcunbind <玩家名>、/mcunallbind、/motd、/list';
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
          command: redactCode(message),
          category: COMMAND_CATEGORY[commandName],
          status: logStatus,
          result: redactCode(logResult)
        });
      } catch {
        try { this.store.audit('player-log-error', '玩家命令日志保存失败'); } catch {}
      }
    }
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
    return `QQ 号 ${pending.qq} 已登记。现在可以发送 /mcbind <玩家名>（例如 /mcbind implayer）、/mcunbind <玩家名>、/motd 或 /list。之前被拦下的命令请重新发送。`;
  }

  unbindQq(openid, message) {
    if (!/^\/qqunbind\s*$/i.test(message)) return '格式：/qqunbind';
    this.store.unregister(openid);
    this.store.audit('qq-unbind', `OpenID ${openid} 解除了 QQ 登记`);
    return 'QQ 号已解除登记。再次使用业务命令前，请先发送 /qqbind <QQ号>。';
  }

  async bindPlayer(openid, group, message) {
    const match = message.match(/^\/mcbind\s+([A-Za-z0-9_]{3,16})\s*$/i);
    if (!match) return '格式：/mcbind <Minecraft 玩家名>，例如 /mcbind implayer';
    const qq = this.store.state.users[openid]?.qq;
    if (!qq) return '请先发送 /qqbind <QQ号> 完成登记。';
    const player = match[1];
    this.store.assertPlayerAvailable(openid, player);
    const result = await this.rcon(this.store.config, `aqqbot whitelist bind ${qq} ${player}`);
    if (/(?:失败|错误|无效|已存在|已绑定|不能|达到上限|too many|already exists|invalid|error|no permission)/i.test(result)) {
      this.store.audit('bind-rejected', `群 ${group}，QQ ${qq}，玩家 ${player}：服务器拒绝绑定`);
      return `服务器未确认绑定，未添加本地记录。服务器响应：${result.slice(0, 500)}`;
    }
    this.store.recordBinding(openid, player, '已发送，待服务器确认');
    this.store.audit('bind-command', `群 ${group}，QQ ${qq}，玩家 ${player}：RCON 已执行`);
    return `已为玩家 ${player} 发送 AQQBot 绑定命令，使用的 QQ 号是 ${qq}。${result ? `\n服务器响应：${result.slice(0, 500)}` : '\n服务器未返回文本，请以 AQQBot/服务器实际绑定状态为准。'}`;
  }

  async unbindPlayer(openid, group, message) {
    const match = message.match(/^\/mcunbind\s+([A-Za-z0-9_]{3,16})\s*$/i);
    if (!match) return '格式：/mcunbind <Minecraft 玩家名>，例如 /mcunbind implayer';
    const binding = this.store.getBindings(openid).find(item => item.player.toLowerCase() === match[1].toLowerCase());
    if (!binding) return '这个玩家不在你的绑定列表中。';
    const result = await this.rcon(this.store.config, `aqqbot whitelist unbind name ${binding.player}`);
    if (!/(?:成功|successfully|unbound)/i.test(result) || /(?:失败|错误|无效|不存在|没有|未绑定|not bound|invalid|error)/i.test(result)) {
      this.store.audit('unbind-unconfirmed', `群 ${group}，OpenID ${openid}，玩家 ${binding.player}：服务器未明确确认解绑`);
      return `服务器未明确确认解绑，本地记录未删除。服务器响应：${result || '（无返回文字）'}。请管理员在 RCON 终端核对。`;
    }
    this.store.removeBinding(openid, binding.player);
    this.store.audit('mc-unbind', `群 ${group}，OpenID ${openid}，玩家 ${binding.player}：服务器确认解绑`);
    return `玩家 ${binding.player} 已从当前 QQ 号解绑；其他玩家和 QQ 登记保持不变。服务器响应：${result.slice(0, 500)}`;
  }

  async unbindAllPlayers(openid, group, message) {
    if (!/^\/mcunallbind\s*$/i.test(message)) return '格式：/mcunallbind';
    const players = this.store.getBindings(openid).map(item => item.player);
    if (!players.length) return '当前 QQ 号没有已记录的 MC 玩家。';
    const done = [];
    for (const player of players) {
      try {
        await this.unbindPlayer(openid, group, `/mcunbind ${player}`);
      } catch (error) {
        return `已解绑 ${done.length} 个玩家：${done.join('、') || '无'}。在 ${player} 处停止：${error.message}；其余玩家未处理。`;
      }
      if (this.store.getBindings(openid).some(item => item.player.toLowerCase() === player.toLowerCase())) {
        return `已解绑 ${done.length} 个玩家：${done.join('、') || '无'}。${player} 未得到服务器明确确认，已停止；其余玩家未处理。`;
      }
      done.push(player);
    }
    return `已逐条解绑 ${done.length} 个玩家：${done.join('、')}。QQ 号登记仍保留。`;
  }
}
