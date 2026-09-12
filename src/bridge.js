import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { rconCommand } from './rcon.js';
import { queryMotd } from './motd.js';
import { McsmClient } from './mcsm.js';
import { recentPlayerMessages } from './logs.js';

const CODE_TTL = 5 * 60 * 1000;

export class Bridge {
  constructor(store, deps = {}) {
    this.store = store;
    this.rcon = deps.rcon ?? rconCommand;
    this.motd = deps.motd ?? queryMotd;
    this.mcsm = deps.mcsm ?? (config => new McsmClient(config));
    this.send = deps.send ?? ((event, message) => this.sendReply(event, message));
    this.pending = new Map();
    this.seen = new Map();
    this.lastCommand = new Map();
    this.actions = new Map();
    this.status = '未连接';
    this.ws = null;
    this.reconnectTimer = null;
    this.stopped = false;
  }

  start() { this.stopped = false; this.connect(); }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    if (this.ws) this.ws.close();
    this.ws = null;
    this.status = '未连接';
  }

  restart() { this.stop(); this.start(); }

  connect() {
    const { onebotWsUrl, onebotToken } = this.store.config;
    if (!onebotWsUrl) { this.status = '未配置'; return; }
    try {
      const ws = new WebSocket(onebotWsUrl, { headers: onebotToken ? { Authorization: `Bearer ${onebotToken}` } : {}, handshakeTimeout: 8000 });
      this.ws = ws;
      this.status = '连接中';
      ws.on('open', () => { if (this.ws === ws) this.status = '已连接'; });
      ws.on('message', data => {
        let event;
        try { event = JSON.parse(data.toString()); } catch { return; }
        if (event.echo && this.actions.has(event.echo)) {
          const action = this.actions.get(event.echo);
          this.actions.delete(event.echo);
          clearTimeout(action.timer);
          event.status === 'ok' || event.retcode === 0 ? action.resolve(event.data) : action.reject(new Error(`OneBot 回复失败：${event.retcode}`));
        } else if (event.post_type === 'message') {
          this.handleEvent(event).catch(error => this.store.audit('bot-error', error.message));
        }
      });
      ws.on('error', () => { if (this.ws === ws) this.status = '连接失败'; });
      ws.on('close', () => {
        if (this.ws !== ws) return;
        this.ws = null;
        this.status = '已断开';
        for (const action of this.actions.values()) { clearTimeout(action.timer); action.reject(new Error('OneBot 连接断开')); }
        this.actions.clear();
        if (!this.stopped) this.reconnectTimer = setTimeout(() => this.connect(), 5000);
      });
    } catch (error) { this.status = `连接失败：${error.message}`; }
  }

  action(action, params) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('OneBot 未连接'));
    return new Promise((resolve, reject) => {
      const echo = randomBytes(8).toString('hex');
      const timer = setTimeout(() => { this.actions.delete(echo); reject(new Error('OneBot 回复超时')); }, 8000);
      this.actions.set(echo, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ action, params, echo }), error => {
        if (error) { clearTimeout(timer); this.actions.delete(echo); reject(error); }
      });
    });
  }

  async sendReply(event, message) {
    await this.action('send_group_msg', { group_id: Number(event.group_id), message: `${event.user_id}：${message}`, auto_escape: true });
  }

  async handleEvent(event) {
    if (event.message_type !== 'group' || event.post_type !== 'message') return;
    const qq = String(event.user_id ?? '');
    const group = String(event.group_id ?? '');
    const allowed = this.store.config.allowedGroups?.split(',').filter(Boolean) ?? [];
    if (!allowed.includes(group) || !/^\d{5,20}$/.test(qq) || qq === String(event.self_id ?? '')) return;
    const raw = typeof event.raw_message === 'string' ? event.raw_message : Array.isArray(event.message) ? event.message.filter(item => item.type === 'text').map(item => item.data?.text ?? '').join('') : String(event.message ?? '');
    const message = raw.trim();
    const isCode = /^BIND-[A-Z0-9]{6}$/i.test(message);
    if (!/^\/(?:bind|motd|logs)(?:\s|$)/i.test(message) && !isCode) return;
    if (event.message_id != null) {
      const key = `${group}:${event.message_id}`;
      if (this.seen.has(key)) return;
      this.seen.set(key, Date.now());
      for (const [id, at] of this.seen) if (at < Date.now() - 10 * 60 * 1000) this.seen.delete(id);
    }
    const now = Date.now();
    const ownCode = isCode && this.pending.get(qq)?.code === message.toUpperCase() && this.pending.get(qq)?.group === group;
    if (!ownCode && (this.lastCommand.get(qq) ?? 0) + 1500 > now) return;
    this.lastCommand.set(qq, now);
    try {
      let reply;
      if (isCode) reply = this.confirmRegistration(qq, group, message.toUpperCase());
      else if (!this.store.state.users[qq]) reply = this.beginRegistration(qq, group);
      else if (/^\/bind(?:\s|$)/i.test(message)) reply = await this.bindPlayer(qq, group, message);
      else if (/^\/motd\s*$/i.test(message)) {
        const info = await this.motd(this.store.config);
        reply = `MOTD：${info.motd || '（空）'}\n在线：${info.online ?? '?'} / ${info.max ?? '?'}${info.version ? `\n版本：${info.version}` : ''}`;
      } else if (/^\/logs\s*$/i.test(message)) {
        const log = await this.mcsm(this.store.config).outputLog();
        const lines = recentPlayerMessages(log);
        reply = lines.length ? `最近 2 分钟玩家消息：\n${lines.map(line => `[${line.time}] ${line.player}: ${line.message}`).join('\n')}` : '最近 2 分钟没有可识别的玩家消息（或面板日志缓冲区未包含这段记录）。';
      } else reply = '命令格式：/bind <玩家名>、/motd、/logs';
      await this.send(event, reply.slice(0, 1800));
    } catch (error) {
      this.store.audit('command-error', `${qq}：${error.message}`);
      await this.send(event, `操作失败：${error.message}`);
    }
  }

  beginRegistration(qq, group) {
    let pending = this.pending.get(qq);
    if (!pending || pending.expires < Date.now() || pending.group !== group) {
      pending = { group, code: `BIND-${randomBytes(4).toString('hex').slice(0, 6).toUpperCase()}`, expires: Date.now() + CODE_TTL };
      this.pending.set(qq, pending);
    }
    return `先登记你的 QQ 号\n登记码：${pending.code}\n有效期：5 分钟\n请由你本人在本群发送这串码。此步骤只获取并登记 QQ 号，不会绑定游戏玩家。登记成功后，再发送 /bind <玩家名>。`;
  }

  confirmRegistration(qq, group, code) {
    const pending = this.pending.get(qq);
    if (!pending || pending.code !== code || pending.group !== group) return '登记码无效，或不属于你的 QQ 号及当前群。请重新发送功能命令获取新码。';
    if (pending.expires < Date.now()) { this.pending.delete(qq); return '登记码已过期，请重新发送功能命令获取新码。'; }
    this.pending.delete(qq);
    this.store.register(qq);
    this.store.audit('register', `QQ ${qq} 经登记码确认`);
    return `QQ 号 ${qq} 已登记。现在可以发送 /bind <玩家名>（例如 /bind implayer）真正绑定 Minecraft 玩家，也可以发送 /motd 或 /logs 查询。`;
  }

  async bindPlayer(qq, group, message) {
    const match = message.match(/^\/bind\s+([A-Za-z0-9_]{3,16})\s*$/i);
    if (!match) return '格式：/bind <Minecraft 玩家名>，例如 /bind implayer';
    const player = match[1];
    const command = `aqqbot whitelist bind ${qq} ${player}`;
    const result = await this.rcon(this.store.config, command);
    this.store.recordBinding(qq, player, '已发送，待服务器确认');
    this.store.audit('bind-command', `群 ${group}，QQ ${qq}，玩家 ${player}：RCON 已执行`);
    return `已为玩家 ${player} 发送 AQQBot 绑定命令，使用的 QQ 号是 ${qq}。${result ? `\n服务器响应：${result.slice(0, 500)}` : '\n服务器未返回文本，请以 AQQBot/服务器实际绑定状态为准。'}`;
  }
}
