import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { QQBot, messageFilter } from '@tencent-connect/qqbot-nodejs';
import { rconCommand } from './rcon.js';
import { queryMotd } from './motd.js';
import { parseOnlineList } from './chat-relay.js';
import { makeQqComponents, parseNameMap } from './qq-chat.js';
import { formatMcToQq, stripMentions } from './mc-chat-format.js';
import { normalizeCommand } from './commands.js';
import { resolveQqToMcTemplate, DEFAULT_MC_TO_QQ_TEMPLATE, DEFAULT_PRESENCE_JOIN_TEMPLATE, DEFAULT_PRESENCE_QUIT_TEMPLATE, DEFAULT_SERVER_ONLINE_TEMPLATE, DEFAULT_SERVER_OFFLINE_TEMPLATE } from './config.js';
import { formatMessageTemplate } from './message-templates.js';
import { PluginChatExchange, PluginConnectionState } from './plugin-chat.js';
import { unbindConfirmed, bindRejected, safePlayer, queryPlayerOwner, queryAqqbot } from './aqqbot.js';
import { OneBotLink } from './onebot.js';

const CODE_TTL = 5 * 60 * 1000;
const PLUGIN_OFFLINE_CONFIRM_MS = 90_000;
const readBotVersion = () => JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const BEIJING_TIME = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const QQ_FORMAT = /^\d{5,20}$/;
const COMMAND_CATEGORY = {
  qqbind: 'QQ 登记', qqconfirm: 'QQ 登记', qqunbind: 'QQ 登记',
  mcbind: 'MC 绑定', mcunbind: 'MC 解绑', mcunallbind: 'MC 解绑', mymc: '服务器查询', motd: '服务器查询', list: '服务器查询', tps: '性能查询', status: '连接查询'
};
const redactCode = value => String(value ?? '').replace(/BIND-[A-F0-9]{6}/gi, 'BIND-******');

/**
 * 把官方 Bot 收到的内容还原成「群友实际打的字」，用于和 OneBot 上报文本对齐。
 * 命令也一样要能对上：用户发 /qqbind，OneBot 收到的也是 /qqbind，
 * 不能因为它是命令就跳过学习，否则第一次用命令的人永远学不到真实 QQ 号。
 */
const normalCommandText = value => String(value ?? '').trim();
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
    this.pluginStopTimer = null;
    this.pluginOfflineConfirmMs = deps.pluginOfflineConfirmMs ?? PLUGIN_OFFLINE_CONFIRM_MS;
    this.pendingServerStatus = null;
    this.aqqbotDatabase = { available: false, reason: '尚未收到插件快照', rows: [], capturedAt: null, receivedAt: null };
    this.serverLogs = [];
    this.serverLogSequence = 0;
    this.serverLogBatches = new Set();
    this.lastServerNotice = { status: null, at: 0 };
    this.stopped = false;

    // ---- OneBot 监听 Bot（只读）：补齐真实 QQ 号、群名、成员变动 ----
    this.onebot = deps.onebot ?? null;
    /** 真实 QQ 号 → 最近活跃时间；用于把官方 Bot 的 OpenID 关联到真实 QQ */
    this.realQQByGroupUser = new Map();
    /** 群号 → 群名称（来自 OneBot 的群名上报或群名称事件） */
    this.groupNamesByRealId = new Map();
    /** 内容指纹 → 时间，用于官方 Bot 与 OneBot 双源去重 */
    this.relayFingerprints = new Map();
    /** 双源去重时间窗 */
    this.relayDedupWindowMs = deps.relayDedupWindowMs ?? 15_000;
    /** OpenID → 真实 QQ 号（由 OneBot 群消息间接学习得到） */
    this.openidToRealQQ = new Map();
    /** OpenID → 监听 Bot 报告的最新显示名（群名片优先） */
    this.displayNamesByOpenid = new Map();
    /** 群 OpenID → 真实群号 */
    this.openidGroupToReal = new Map();
    /** 真实群号 → 群 OpenID */
    this.realGroupToOpenid = new Map();
    /** 最近的 OneBot 群消息，用于和官方 Bot 侧做内容匹配 */
    this.recentOneBotMessages = [];
    /** 本平台刚发出的内容，用来识别监听 Bot 收回来的自己人回声 */
    this.recentOwnSent = [];
    /** 玩家名 → { qq, at } 缓存，避免同一玩家连续发言时反复查 RCON */
    this.playerQQCache = new Map();
    this.playerQQCacheMs = deps.playerQQCacheMs ?? 60_000;
    if (this.onebot) this.bindOneBotEvents();
  }

  /** 把 OneBot 的事件接到现有处理链上 */
  bindOneBotEvents() {
    this.onebot.on('group-message', message => {
      try { this.handleOneBotGroupMessage(message); }
      catch (error) { this.store.audit('onebot-error', error.message); }
    });
    this.onebot.on('meta', event => {
      try { this.handleOneBotMeta(event); }
      catch (error) { this.store.audit('onebot-error', error.message); }
    });
    this.onebot.on('status', status => this.store.audit('onebot-status', `OneBot 监听状态：${status}`));
  }

  /** 记录 OneBot 拿到的真实 QQ 号，供绑定时自动取用 */
  handleOneBotGroupMessage(message) {
    if (!message.groupId || !message.userId) return;
    // 机器人自己发的消息不算：本平台通过官方 Bot 往群里发的内容，
    // 也会被监听 Bot 收进来。若当成「群友发言」学习，就会把机器人自己的
    // 内容错认成某个群友，污染 OpenID↔QQ 关联。
    if (this.isOwnSentText(message.text)) return;
    this.rememberRealQQ(message.groupId, message.userId);
    if (message.text) {
      const key = this.fingerprint(message.groupId, message.userId, message.text);
      this.relayFingerprints.set(key, Date.now());
      // 供官方 Bot 侧做「同内容+时间窗」关联，学习 OpenID ↔ 真实 QQ
      this.rememberOneBotMessage(message);
    }
    this.pruneFingerprints();
  }

  /** 记下本平台刚发出的内容，用来识别监听 Bot 收回来的「自己人回声」 */
  rememberOwnSentText(content) {
    const text = String(content ?? '').trim();
    if (!text) return;
    this.recentOwnSent.push({ text, at: Date.now() });
    const cutoff = Date.now() - this.relayDedupWindowMs;
    this.recentOwnSent = this.recentOwnSent.filter(item => item.at >= cutoff);
    if (this.recentOwnSent.length > 50) this.recentOwnSent.shift();
  }

  /** 这条文本是不是本平台刚发出去的（监听 Bot 的回声） */
  isOwnSentText(text) {
    const value = String(text ?? '').trim();
    if (!value) return false;
    const cutoff = Date.now() - this.relayDedupWindowMs;
    this.recentOwnSent = this.recentOwnSent.filter(item => item.at >= cutoff);
    return this.recentOwnSent.some(item => item.text === value);
  }

  /**
   * 暂存 OneBot 收到的消息，等待官方 Bot 侧匹配。
   * 两个 Bot 看到的群标识不同（OpenID vs 真实群号），无法直接对应，
   * 因此只能用「内容 + 发送者显示名 + 时间窗」做保守关联。
   */
  rememberOneBotMessage(message) {
    this.recentOneBotMessages.push({
      text: message.text,
      displayName: message.displayName,
      nickname: message.nickname,
      userId: message.userId,
      groupId: message.groupId,
      at: Date.now()
    });
    if (this.recentOneBotMessages.length > 300) this.recentOneBotMessages.shift();
  }

  /**
   * OneBot 是否真正参与工作。
   * 关闭时必须完全退回旧版行为：不学习、不去重、不用 OneBot 群名，
   * 所有消息只走官方 Bot 的原有路径。
   */
  isOneBotActive() {
    return this.store.config.onebotEnabled === true && Boolean(this.onebot);
  }

  /**
   * 官方 Bot 收到一条群聊后，尝试找到对应的 OneBot 消息。
   * 同时学习两件事：
   *   1. OpenID → 真实 QQ 号
   *   2. 群 OpenID → 真实群号
   * 只有「内容相同、时间窗内、候选唯一」时才学习，避免张冠李戴。
   */
  learnFromOfficial(openid, groupOpenid, senderName, text) {
    if (!this.isOneBotActive()) return null;
    const cutoff = Date.now() - this.relayDedupWindowMs;
    this.recentOneBotMessages = this.recentOneBotMessages.filter(item => item.at >= cutoff);
    if (!text) return null;
    const candidates = this.recentOneBotMessages.filter(item =>
      item.text === text && item.at >= cutoff && (!senderName || !item.displayName || item.displayName === senderName || item.nickname === senderName));
    if (candidates.length !== 1) return null;

    const hit = candidates[0];
    // 群 OpenID → 真实群号
    if (groupOpenid && hit.groupId && this.openidGroupToReal.get(groupOpenid) !== hit.groupId) {
      this.openidGroupToReal.set(groupOpenid, hit.groupId);
      this.realGroupToOpenid.set(hit.groupId, groupOpenid);
      this.store.audit('onebot-link', `群 OpenID ${groupOpenid} 关联到真实群号 ${hit.groupId}`);
    }
    // OpenID → 真实 QQ
    if (this.openidToRealQQ.get(openid) !== hit.userId) {
      this.openidToRealQQ.set(openid, hit.userId);
      this.store.audit('onebot-link', `OpenID ${openid} 关联到真实 QQ ${hit.userId}（依据群消息内容与时间窗）`);
    }
    // 顺带记下监听源看到的显示名，聊天时优先使用
    this.rememberDisplayName(openid, hit.displayName);
    return hit.userId;
  }

  /** 取某个 OpenID 已知的真实 QQ 号（可能为空） */
  realQQForOpenid(openid) {
    return this.openidToRealQQ.get(openid) ?? null;
  }

  /**
   * 从监听 Bot 学到的最新显示名（群名片优先）。
   * 记在 openidToRealQQ 命中之后，因为要先确认是同一个人。
   */
  rememberDisplayName(openid, displayName) {
    if (!openid || !displayName) return;
    this.displayNamesByOpenid.set(openid, String(displayName).slice(0, 48));
  }

  /** 监听源优先：拿到过就用它，否则返回空让调用方兜底 */
  displayNameFromOneBot(openid, officialName) {
    if (!this.isOneBotActive()) return '';
    const learned = this.displayNamesByOpenid.get(openid);
    if (learned) return learned;
    if (!officialName) return '';
    // 还没学到同一个人时，按「同显示名」从最近上报里找一次
    const cutoff = Date.now() - this.relayDedupWindowMs;
    const hit = this.recentOneBotMessages.find(item => item.at >= cutoff &&
      (item.displayName === officialName || item.nickname === officialName));
    return hit?.displayName ?? '';
  }

  /** 取某个群 OpenID 对应的真实群号（可能为空） */
  realGroupIdFor(groupOpenid) {
    return this.openidGroupToReal.get(groupOpenid) ?? null;
  }

  /** 取某个真实群号对应的群 OpenID（可能为空） */
  groupOpenidFor(realGroupId) {
    return this.realGroupToOpenid.get(realGroupId) ?? null;
  }

  handleOneBotMeta(event) {
    if (event.kind === 'group-name' && event.groupId && event.name) {
      this.groupNamesByRealId.set(event.groupId, event.name);
      this.store.audit('onebot-group-name', `群 ${event.groupId} 名称更新为「${event.name}」`);
      return;
    }
    if ((event.kind === 'member-join' || event.kind === 'member-leave') && event.groupId && event.userId) {
      const label = event.kind === 'member-join' ? '加入' : '离开';
      this.store.audit('onebot-member', `QQ ${event.userId} ${label}群 ${event.groupId}`);
    }
  }

  rememberRealQQ(groupId, userId) {
    this.realQQByGroupUser.set(`${groupId}:${userId}`, Date.now());
    // 只保留最近 5000 条，防止长期运行内存增长
    if (this.realQQByGroupUser.size > 5000) {
      const oldest = [...this.realQQByGroupUser.entries()].sort((a, b) => a[1] - b[1])[0];
      if (oldest) this.realQQByGroupUser.delete(oldest[0]);
    }
  }

  /** 取某个群成员最近上报的真实 QQ 号 */
  realQQFor(groupId, userId) {
    return this.realQQByGroupUser.has(`${groupId}:${userId}`) ? userId : null;
  }

  /** 双源去重指纹：同一群、同一人、同一内容在一个时间窗内只转发一次 */
  fingerprint(groupId, userId, text) {
    return `${groupId}|${userId}|${String(text ?? '').toLowerCase()}`;
  }

  pruneFingerprints() {
    const cutoff = Date.now() - this.relayDedupWindowMs;
    for (const [key, at] of this.relayFingerprints) if (at < cutoff) this.relayFingerprints.delete(key);
  }

  /**
   * 判断这条消息是否已在时间窗内转发过；用于官方 Bot 与 OneBot 去重。
   *
   * 注意这里的判据必须同时满足「同群 + 同人 + 同内容 + 同消息 ID」，
   * 否则用户连续发两次同样的「哈哈哈」会被误杀，表现为「游戏里偶尔不同步」。
   */
  isDuplicateRelay(groupId, userId, text, messageId = '') {
    if (!this.isOneBotActive()) return false;
    const key = messageId
      ? `${this.fingerprint(groupId, userId, text)}|mid:${messageId}`
      : this.fingerprint(groupId, userId, text);
    const seen = this.relayFingerprints.get(key);
    if (seen && Date.now() - seen < this.relayDedupWindowMs) return true;
    this.relayFingerprints.set(key, Date.now());
    this.pruneFingerprints();
    return false;
  }

  getOneBotStatus() {
    return this.onebot ? this.onebot.getStatus() : { enabled: false, status: '未配置', connected: false, recentEvents: [] };
  }

  getGroupNameMap() {
    return Object.fromEntries(this.groupNamesByRealId);
  }

  /**
   * 官方 Bot 只给群 OpenID，OneBot 给的是真实群号。
   * 优先级：手工配置映射 > 监听 Bot 学到的群名 > 空。
   */
  realGroupNameFor(groupOpenid) {
    const configured = parseNameMap(this.store.config.groupNames, '群名称映射').get(groupOpenid);
    if (configured) return configured;
    if (!this.isOneBotActive()) return '';
    // 已经学过「群 OpenID → 真实群号」就直接查
    const realId = this.openidGroupToReal.get(groupOpenid);
    if (realId) {
      const name = this.groupNamesByRealId.get(realId);
      if (name) return name;
    }
    // 还没学过关系统时，若只监听到一个群，可以直接用它的名字
    const names = [...new Set(this.groupNamesByRealId.values())];
    return names.length === 1 ? names[0] : '';
  }

  start() {
    this.stopped = false;
    this.connect();
    this.onebot?.start();
    this.pluginConnectionTimer = setInterval(() => this.checkPluginConnection(), 5000);
    this.pluginConnectionTimer.unref?.();
  }

  stop() {
    this.stopped = true;
    this.onebot?.stop();
    if (this.pluginConnectionTimer) clearInterval(this.pluginConnectionTimer);
    this.pluginConnectionTimer = null;
    if (this.pluginStopTimer) clearTimeout(this.pluginStopTimer);
    this.pluginStopTimer = null;
    this.pendingServerStatus = null;
    this.bot?.stop();
    this.bot = null;
    this.status = '未连接';
  }

  restart() {
    this.stop();
    this.stopped = false;
    this.pluginExchange = new PluginChatExchange(chat => this.sendMcChatToQq(chat), event => this.sendMcPresenceToQq(event), event => this.sendMcLifecycleToQq(event));
    this.onebot?.restart({
      enabled: this.store.config.onebotEnabled === true,
      token: this.store.config.onebotToken ?? '',
      forwardUrl: this.store.config.onebotUrl ?? ''
    });
    this.start();
  }

  exchangePluginChat(input) {
    const response = this.pluginExchange.exchange(input);
    this.observeAqqbotSnapshot(input?.aqqbotSnapshot);
    this.observeServerLogs(input?.serverLogs);
    this.observePluginVersion(input?.pluginVersion);
    const explicitStop = input.sent.some(item => item?.kind === 'stop');
    this.pluginConnection.observe();
    if (!explicitStop) {
      this.cancelPluginOffline();
      if (this.lastServerNotice.status !== 'online') {
        void this.sendMcServerStatusToQq('online').catch(error => this.store.audit('mc-server-status-error', error.message));
      }
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
    // 查出这个玩家在 AQQBot 里绑定的 QQ 号，让群里能看到是谁
    const qq = await this.resolveQQForPlayer(chat?.player);
    const content = formatMcToQq(this.store.config.mcToQqTemplate || DEFAULT_MC_TO_QQ_TEMPLATE, { ...chat, qq });
    await this.sendToAllowedGroups(content, 'mc-to-qq-error');
  }

  /**
   * 解析玩家绑定的 QQ 号，三级兜底：
   *   1. 进程内缓存（避免同一玩家连续发言时反复查询）
   *   2. AQQBot 快照（插件同步过来的，最新最省事）
   *   3. 实时 RCON 查询（快照过期或还没同步时兜底）
   *
   * 只靠快照是不够的：插件没开启整库同步、或刚启动还没收到快照时，
   * 快照是空的，会误报「未绑定」。
   */
  async resolveQQForPlayer(player) {
    const name = String(player ?? '').trim();
    if (!name) return '';

    // 1. 缓存
    const cached = this.playerQQCache.get(name);
    if (cached && Date.now() - cached.at < this.playerQQCacheMs) return cached.qq;

    // 2. 快照
    const fromSnapshot = this.qqForPlayer(name);

    // 3. 实时查询（快照没查到才查，避免不必要的 RCON 压力）
    let qq = fromSnapshot;
    if (!qq) {
      try {
        const owner = await queryPlayerOwner(this.store.config, this.rcon, name);
        if (owner) qq = String(owner);
      } catch (error) {
        this.store.audit('player-qq-lookup-error', `查询玩家 ${name} 的 QQ 失败：${error.message}`);
      }
    }

    // 查到就缓存，查不到也缓存短时间，避免刷屏时反复打 RCON
    this.playerQQCache.set(name, { qq, at: Date.now() });
    if (this.playerQQCache.size > 500) {
      const oldest = [...this.playerQQCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) this.playerQQCache.delete(oldest[0]);
    }
    return qq;
  }

  /**
   * 查玩家绑定的 QQ 号（只看快照，不发 RCON）。
   * 优先用最近一次 AQQBot 快照（插件同步过来的），比实时 RCON 查询快得多。
   */
  qqForPlayer(player) {
    const name = String(player ?? '').trim();
    if (!name) return '';
    for (const row of this.aqqbotDatabase.rows ?? []) {
      if (Array.isArray(row.players) && row.players.includes(name)) return row.qq;
    }
    return '';
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
    if (event.kind === 'start') {
      this.cancelPluginOffline();
      return;
    }
    this.schedulePluginOffline(this.pluginConnection.lastSeen);
  }

  cancelPluginOffline() {
    if (this.pluginStopTimer) clearTimeout(this.pluginStopTimer);
    this.pluginStopTimer = null;
  }

  checkPluginConnection(now = Date.now()) {
    if (this.pluginConnection.check(now) === 'offline') this.schedulePluginOffline(this.pluginConnection.lastSeen);
  }

  schedulePluginOffline(lastSeen) {
    if (this.pluginStopTimer) return;
    const remaining = Math.max(0, lastSeen + this.pluginOfflineConfirmMs - Date.now());
    this.pluginStopTimer = setTimeout(() => {
      this.pluginStopTimer = null;
      if (this.stopped || this.pluginConnection.lastSeen > lastSeen) return;
      void this.sendMcServerStatusToQq('offline').catch(error => this.store.audit('mc-server-status-error', error.message));
    }, remaining);
    this.pluginStopTimer.unref?.();
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
    this.rememberOwnSentText(content);
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
    // 清掉消息正文里残留的 @ 标记，否则到 MC 里会变成一串看不懂的 OpenID
    const message = normalizeCommand(stripMentions(originalMessage));
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
    // 学习必须在分支之前：用户可能直接发 /qqbind 或别的命令，而不是普通聊天。
    // 只在聊天分支里学，会导致「第一次用命令的人永远学不到真实 QQ 号」。
    const learnedRealQQ = this.learnFromOfficial(openid, group, String(event.senderName ?? ''), normalCommandText(message));
    if (isChat && !module) {
      try {
        // 优先用监听 Bot 的显示名与群名，官方 Bot 只作兜底。
        // 监听源看得到群名片，比官方 Bot 的昵称准确得多。
        const memberMap = parseNameMap(this.store.config.memberNames, '成员显示名映射');
        const groupMap = parseNameMap(this.store.config.groupNames, '群名称映射');
        const sentDisplayName = event.senderName;
        const userName = memberMap.get(openid)
          || this.displayNameFromOneBot(openid, sentDisplayName)
          || sentDisplayName
          || this.store.state.users[openid]?.qq
          || '群友';
        const groupName = groupMap.get(group) || this.realGroupNameFor(group) || 'QQ群';
        // 双源去重：带上 messageId，避免「连续两次相同内容」被误杀
        if (learnedRealQQ && this.isDuplicateRelay(group, learnedRealQQ, message, event.messageId ?? '')) {
          this.store.audit('qq-to-mc-dedup', `群 ${group}：同一条消息已由监听 Bot 转发，跳过官方 Bot 副本`);
          return;
        }
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
        // 未登记时先尝试用 OneBot 识别的真实 QQ 号自动登记，成功就不必拦下
        if (!user?.qq) await this.ensureRegistered(openid, group);
        const current = this.store.state.users[openid];
        if (!current?.qq) { reply = '请先登记 QQ 号：/qqbind <你的QQ号>。按提示二次确认后，重新发送刚才的命令。'; logStatus = '未登记拦截'; }
        else if (module) reply = await this.modules.handleCommand(module, { message, openid, group, qq: current.qq });
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

  /**
   * 自动登记：已通过 OneBot 得知真实 QQ 号时，无需用户手填。
   * 返回 null 表示无法自动完成，调用方继续走手动流程。
   */
  autoRegister(openid, group) {
    if (!this.isOneBotActive()) return null;
    if (this.store.config.onebotPreferRealQQ === false) return null;
    const realQQ = this.realQQForOpenid(openid);
    if (!realQQ) return null;
    if (this.store.state.users[openid]?.qq) return { qq: this.store.state.users[openid].qq, already: true };
    // 这个真实 QQ 若已被别的 OpenID 登记，不能自动抢过来
    if (this.store.qqOwner(realQQ, openid)) return null;
    try {
      this.store.register(openid, realQQ, group, 'onebot-auto');
      this.store.audit('register', `OpenID ${openid} 经 OneBot 自动登记真实 QQ ${realQQ}`);
      return { qq: realQQ, already: false };
    } catch (error) {
      // 不静默吞掉：自动登记失败要留痕，否则用户会莫名被拦在命令外
      this.store.audit('onebot-auto-register-error', `OpenID ${openid} 自动登记 QQ ${realQQ} 失败：${error.message}`);
      return null;
    }
  }

  async ensureRegistered(openid, group) {
    if (this.store.state.users[openid]?.qq) return true;
    const auto = this.autoRegister(openid, group);
    if (auto) return true;
    return false;
  }

  beginRegistration(openid, group, message) {
    if (this.store.state.users[openid]?.qq) return `已登记 QQ 号 ${this.store.state.users[openid].qq}，无需重复登记。`;
    // 已有真实 QQ 号就直接登记，不再让用户手填和二次确认
    const auto = this.autoRegister(openid, group);
    if (auto) {
      return `已通过监听 Bot 自动识别你的 QQ 号：${auto.qq}，登记完成。\n现在可以直接使用 /mcbind <玩家名>、/mymc、/motd、/list 等命令。`;
    }
    // 允许 /qqbind 不带参数：先尝试自动识别，识别不到再提示正确格式
    const bare = /^\/qqbind\s*$/i.test(message);
    const qq = message.match(/^\/qqbind\s+(\d{5,20})\s*$/i)?.[1];
    if (bare) {
      const hint = this.isOneBotActive()
        ? '监听 Bot 还没识别到你的 QQ 号。\n请先在群里随便发一句话（不要是命令），然后再发 /qqbind；或者直接手填：/qqbind <你的QQ号>'
        : '格式：/qqbind <你的QQ号>，例如 /qqbind 36000000';
      return hint;
    }
    if (!qq || !QQ_FORMAT.test(qq)) return '格式：/qqbind <你的QQ号>，例如 /qqbind 36000000';
    if (this.store.qqOwner(qq, openid)) return '这个 QQ 号已被登记，请联系管理员核对。';
    const pending = { group, qq, code: `BIND-${randomBytes(3).toString('hex').toUpperCase()}`, expires: Date.now() + CODE_TTL };
    this.pending.set(openid, pending);
    const note = this.isOneBotActive()
      ? '\n提示：监听 Bot 尚未识别到你的 QQ 号，稍后在群里发一句话再来一次 /qqbind 可自动完成。'
      : '';
    return `请二次核对你填写的 QQ 号：${qq}\n如果正确，请由你本人在本群 @机器人发送：${pending.code}\n有效期：5 分钟。确认后自动登记，不需要管理员审核。注意：此步骤不验证 QQ 号归属，也不会绑定 MC 玩家。${note}`;
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
