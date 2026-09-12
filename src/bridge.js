import { randomBytes } from 'node:crypto';
import { QQBot } from '@tencent-connect/qqbot-nodejs';
import { rconCommand } from './rcon.js';
import { queryMotd } from './motd.js';

const CODE_TTL = 5 * 60 * 1000;
const QQ_FORMAT = /^\d{5,20}$/;

export class Bridge {
  constructor(store, deps = {}) {
    this.store = store;
    this.rcon = deps.rcon ?? rconCommand;
    this.motd = deps.motd ?? queryMotd;
    this.createBot = deps.createBot ?? (options => new QQBot(options));
    this.send = deps.send ?? ((event, message) => this.sendReply(event, message));
    this.pending = new Map();
    this.seen = new Map();
    this.lastCommand = new Map();
    this.discoveredGroups = new Set();
    this.status = '未连接';
    this.bot = null;
    this.stopped = false;
  }

  start() { this.stopped = false; this.connect(); }

  stop() {
    this.stopped = true;
    this.bot?.stop();
    this.bot = null;
    this.status = '未连接';
  }

  restart() { this.stop(); this.start(); }

  connect() {
    const { qqAppId, qqAppSecret } = this.store.config;
    if (!qqAppId || !qqAppSecret) { this.status = '未配置'; return; }
    try {
      const bot = this.createBot({ appId: qqAppId, appSecret: qqAppSecret });
      this.bot = bot;
      this.status = '连接中';
      bot.on('ready', () => { if (this.bot === bot) this.status = '已连接'; });
      bot.on('resumed', () => { if (this.bot === bot) this.status = '已连接'; });
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

  async handleEvent(event) {
    if (event.kind !== 'group') return;
    const openid = String(event.senderId ?? '');
    const group = String(event.groupOpenid ?? '');
    const allowed = this.store.config.allowedGroups?.split(',').filter(Boolean) ?? [];
    if (group && !allowed.includes(group) && !this.discoveredGroups.has(group)) {
      this.discoveredGroups.add(group);
      this.store.audit('group-discovered', `发现 QQ 群 OpenID：${group}；请填到“修改信息”允许群列表`);
    }
    if (!allowed.includes(group) || !openid || !event.replyTarget) return;
    const message = String(event.content ?? '').replace(/^<@!?[^>]+>\s*/, '').trim();
    const isCode = /^BIND-[A-F0-9]{6}$/i.test(message);
    if (!/^\/(?:register|confirm|bind|motd)(?:\s|$)/i.test(message) && !isCode) return;
    if (event.messageId) {
      const key = `${group}:${event.messageId}`;
      if (this.seen.has(key)) return;
      this.seen.set(key, Date.now());
      for (const [id, at] of this.seen) if (at < Date.now() - 10 * 60 * 1000) this.seen.delete(id);
    }
    const ownCode = isCode && this.pending.get(openid)?.code === message.toUpperCase() && this.pending.get(openid)?.group === group;
    const now = Date.now();
    if (!ownCode && (this.lastCommand.get(openid) ?? 0) + 1500 > now) return;
    this.lastCommand.set(openid, now);
    try {
      let reply;
      if (/^\/register(?:\s|$)/i.test(message)) reply = this.beginRegistration(openid, group, message);
      else if (isCode || /^\/confirm(?:\s|$)/i.test(message)) reply = this.confirmRegistration(openid, group, message.replace(/^\/confirm\s*/i, '').toUpperCase());
      else {
        const user = this.store.state.users[openid];
        if (!user?.qq) reply = '使用前请先登记：/register <你的QQ号>。机器人会回显号码，请核对后由本人发送确认码。';
        else if (/^\/bind(?:\s|$)/i.test(message)) reply = await this.bindPlayer(openid, group, message);
        else if (/^\/motd\s*$/i.test(message)) {
          const info = await this.motd(this.store.config);
          reply = `MOTD：${info.motd || '（空）'}\n在线：${info.online ?? '?'} / ${info.max ?? '?'}${info.version ? `\n版本：${info.version}` : ''}`;
        } else reply = '命令格式：/register <QQ号>、/bind <玩家名>、/motd';
      }
      await this.send(event, reply.slice(0, 1800));
    } catch (error) {
      this.store.audit('command-error', `${openid}：${error.message}`);
      await this.send(event, `操作失败：${error.message}`);
    }
  }

  beginRegistration(openid, group, message) {
    if (this.store.state.users[openid]?.qq) return `已登记 QQ 号 ${this.store.state.users[openid].qq}，无需重复登记。`;
    const qq = message.match(/^\/register\s+(\d{5,20})\s*$/i)?.[1];
    if (!qq || !QQ_FORMAT.test(qq)) return '格式：/register <你的QQ号>，例如 /register 36000000';
    if (this.store.qqOwner(qq, openid)) return '这个 QQ 号已被登记，请联系管理员核对。';
    const pending = { group, qq, code: `BIND-${randomBytes(3).toString('hex').toUpperCase()}`, expires: Date.now() + CODE_TTL };
    this.pending.set(openid, pending);
    return `请二次核对你填写的 QQ 号：${qq}\n如果正确，请由你本人在本群发送确认码：${pending.code}\n有效期：5 分钟。确认后自动登记，不需要管理员审核。注意：此步骤不验证 QQ 号归属，也不会绑定 MC 玩家。`;
  }

  confirmRegistration(openid, group, code) {
    const pending = this.pending.get(openid);
    if (!pending || pending.code !== code || pending.group !== group) return '确认码无效，或不属于你及当前群。请重新发送 /register <QQ号>。';
    if (pending.expires < Date.now()) { this.pending.delete(openid); return '确认码已过期，请重新发送 /register <QQ号>。'; }
    this.store.register(openid, pending.qq, group);
    this.pending.delete(openid);
    this.store.audit('register', `OpenID ${openid} 自填并确认 QQ ${pending.qq}`);
    return `QQ 号 ${pending.qq} 已登记。现在可以发送 /bind <玩家名>（例如 /bind implayer），或发送 /motd。`;
  }

  async bindPlayer(openid, group, message) {
    const match = message.match(/^\/bind\s+([A-Za-z0-9_]{3,16})\s*$/i);
    if (!match) return '格式：/bind <Minecraft 玩家名>，例如 /bind implayer';
    const qq = this.store.state.users[openid]?.qq;
    if (!qq) return '请先发送 /register <QQ号> 完成登记。';
    const player = match[1];
    const result = await this.rcon(this.store.config, `aqqbot whitelist bind ${qq} ${player}`);
    this.store.recordBinding(openid, player, '已发送，待服务器确认');
    this.store.audit('bind-command', `群 ${group}，QQ ${qq}，玩家 ${player}：RCON 已执行`);
    return `已为玩家 ${player} 发送 AQQBot 绑定命令，使用的 QQ 号是 ${qq}。${result ? `\n服务器响应：${result.slice(0, 500)}` : '\n服务器未返回文本，请以 AQQBot/服务器实际绑定状态为准。'}`;
  }
}
