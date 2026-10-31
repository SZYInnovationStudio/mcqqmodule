/**
 * OneBot v11 连接层【只收不发】。
 *
 * 用途：接一个「只监听、绝不发言」的外挂 Bot（NapCat / Lagrange / LLOneBot 等），
 * 用它补齐官方 Bot 拿不到的信息：
 *   - 真实 QQ 号（官方 Bot 只给 OpenID）
 *   - 群名称、群名片、成员昵称
 *   - 入群 / 退群 / 撤回等事件
 *
 * ⚠️ 硬性约束：本模块【不发送任何消息】。
 *   - 不实现 send_group_msg / send_private_msg / send_msg 等任何 outgoing action
 *   - 写入连接的唯一帧都是外挂 Bot 上报的事件，平台从不主动下发
 *   - QQ 群里的所有发言一律由官方 Bot 负责（见 bridge.js 的 this.bot.sendText）
 *
 *   为什么这么设计：用外挂号发言有封号风险，而且会让「谁在说话」变得混乱。
 *   让外挂号只做耳朵、官方号做嘴巴，风险最小、身份最清晰。
 *   本文件之外的代码若试图通过 OneBot 发送，测试会失败
 *   （见 test/onebot.test.js 的「OneBot 只收不发」用例）。
 *
 * 其他设计要点：
 *   - 两种连接方式都会尝试，谁先连上就用谁：
 *       reverse：外挂 Bot 主动连到本平台的 /api/onebot/ws
 *       forward：本平台主动连到外挂 Bot 的 ws 地址
 *   - 鉴权用 Access Token，走 Authorization: Bearer 或 access_token 查询参数。
 *   - 断线自动重连，指数退避。
 */
import { EventEmitter } from 'node:events';
import { createHash, timingSafeEqual } from 'node:crypto';

const WS_OPEN = 1;
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 60_000;
/** 事件缓冲上限，防止后台页面把内存吃光 */
const MAX_BUFFERED_EVENTS = 200;

/** OneBot v11 的群消息 / 通知 / 请求事件类型 */
const GROUP_MESSAGE_TYPES = new Set(['group']);

export function safeEqual(a, b) {
  const left = createHash('sha256').update(String(a ?? '')).digest();
  const right = createHash('sha256').update(String(b ?? '')).digest();
  return timingSafeEqual(left, right);
}

/**
 * 从 OneBot 上报数据里抽出群消息的关键字段。
 * 返回 null 表示不是我们关心的群消息。
 */
export function parseGroupMessage(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.post_type !== 'message') return null;
  if (!GROUP_MESSAGE_TYPES.has(payload.message_type)) return null;

  const groupId = String(payload.group_id ?? '');
  const userId = String(payload.user_id ?? '');
  if (!/^\d{5,20}$/.test(groupId) || !/^\d{5,20}$/.test(userId)) return null;

  const text = extractText(payload.message);
  const sender = payload.sender && typeof payload.sender === 'object' ? payload.sender : {};
  const card = typeof sender.card === 'string' && sender.card.trim() ? sender.card.trim() : '';
  const nickname = typeof sender.nickname === 'string' && sender.nickname.trim() ? sender.nickname.trim() : '';

  return {
    kind: 'group-message',
    groupId,
    userId,
    messageId: String(payload.message_id ?? ''),
    text,
    displayName: card || nickname || userId,
    nickname,
    card,
    time: Number(payload.time) || Math.floor(Date.now() / 1000),
    selfId: String(payload.self_id ?? '')
  };
}

/** 从 OneBot 消息段数组 / 字符串里取出纯文本 */
export function extractText(message) {
  if (typeof message === 'string') return sanitizeText(message);
  if (!Array.isArray(message)) return '';
  const parts = [];
  for (const segment of message) {
    if (!segment || typeof segment !== 'object') continue;
    if (segment.type === 'text' && typeof segment.data?.text === 'string') parts.push(segment.data.text);
    // 图片 / 表情 用占位符，避免整条消息消失
    else if (segment.type === 'image') parts.push('[图片]');
    else if (segment.type === 'face') parts.push('[表情]');
  }
  return sanitizeText(parts.join(''));
}

function sanitizeText(value) {
  return String(value ?? '')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, '')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1800);
}

/** 群名称、群名片这类元信息事件 */
export function parseMetaEvent(payload, kind) {
  if (!payload || typeof payload !== 'object') return null;
  if (kind === 'group-name' && payload.notice_type === 'group_name' && payload.sub_type === 'update') {
    const groupId = String(payload.group_id ?? '');
    const name = typeof payload.group_name === 'string' ? payload.group_name.trim().slice(0, 48) : '';
    if (!/^\d{5,20}$/.test(groupId) || !name) return null;
    return { kind: 'group-name', groupId, name };
  }
  return null;
}

/**
 * 监听 Bot 连接管理。
 * 通过 EventEmitter 把 'group-message'、'meta'、'status' 抛给 Bridge。
 */
export class OneBotLink extends EventEmitter {
  constructor(options = {}) {
    super();
    this.token = String(options.token ?? '');
    this.forwardUrl = String(options.forwardUrl ?? '');
    this.enabled = options.enabled === true;
    this.WebSocketImpl = options.WebSocketImpl ?? null;
    this.log = options.log ?? (() => {});
    this.status = '未启用';
    this.selfId = '';
    this.nickname = '';
    this.lastEventAt = 0;
    this.eventCount = 0;
    this.recentEvents = [];
    this.connection = null;
    this.reconnectTimer = null;
    this.reconnectDelay = RECONNECT_BASE_MS;
    this.stopped = true;
    this.seenMessages = new Map();
    /** 已发出、等待响应的只读查询 */
    this.pendingActions = new Map();
    this.actionSeq = 0;
    /** 连接后是否已经拉过群列表 */
    this.groupListFetched = false;
  }

  /** 判断一次 Reverse 连接带不带合法 token */
  acceptsToken(value) {
    if (!this.token) return true;
    if (typeof value !== 'string' || !value) return false;
    const clean = value.startsWith('Bearer ') ? value.slice(7) : value.startsWith('Token ') ? value.slice(6) : value;
    return safeEqual(clean.trim(), this.token);
  }

  start() {
    this.stopped = false;
    this.reconnectDelay = RECONNECT_BASE_MS;
    if (!this.enabled) {
      this.setStatus('未启用');
      return;
    }
    if (this.forwardUrl) this.openForward();
    else this.setStatus('等待外挂 Bot 连接');
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    try { this.connection?.close(); } catch {}
    this.connection = null;
    this.setStatus('已停止');
  }

  /** 配置变更后重建连接 */
  restart(next = {}) {
    this.stop();
    if ('token' in next) this.token = String(next.token ?? '');
    if ('forwardUrl' in next) this.forwardUrl = String(next.forwardUrl ?? '');
    if ('enabled' in next) this.enabled = next.enabled === true;
    this.start();
  }

  /** 连接就绪后的初始化：拉登录信息与群列表，群名主要靠这里拿到 */
  onConnected() {
    if (this.stopped) return;
    this.groupListFetched = false;
    void (async () => {
      try {
        const login = await this.callAction('get_login_info');
        if (login?.nickname) this.nickname = String(login.nickname).slice(0, 48);
        if (login?.user_id) this.selfId = String(login.user_id);
      } catch { /* 拿不到昵称不影响主流程 */ }
      const groups = await this.fetchGroupList();
      this.groupListFetched = groups.length > 0;
      if (groups.length) this.log(`已从监听 Bot 获取 ${groups.length} 个群的名称`);
      this.emit('status', this.status);
    })();
  }

  setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.emit('status', status);
  }

  /** 主动连接外挂 Bot（正向 WebSocket） */
  openForward() {
    if (this.stopped || !this.forwardUrl) return;
    const Impl = this.WebSocketImpl;
    if (!Impl) { this.setStatus('缺少 WebSocket 实现'); return; }
    try {
      this.setStatus('连接中');
      // Node 的 WebSocket 支持 headers，用来放 Access Token
      const headers = this.token ? { Authorization: `Bearer ${this.token}` } : undefined;
      const ws = new Impl(this.forwardUrl, headers ? { headers } : undefined);
      this.attach(ws, 'forward');
    } catch (error) {
      this.setStatus('连接失败');
      this.log(`OneBot 正向连接失败：${error.message}`);
      this.scheduleReconnect();
    }
  }

  /** 外挂 Bot 连进来（反向 WebSocket） */
  accept(ws) {
    if (!this.enabled) {
      try { ws.close(1008, 'OneBot listening disabled'); } catch {}
      return false;
    }
    this.attach(ws, 'reverse');
    return true;
  }

  attach(ws, mode) {
    try { this.connection?.close(); } catch {}
    this.connection = ws;
    this.mode = mode;
    ws.on('open', () => {
      if (this.connection !== ws) return;
      this.setStatus('已连接');
      this.reconnectDelay = RECONNECT_BASE_MS;
      this.onConnected();
    });
    // 反向连接建立即视为就绪
    if (mode === 'reverse') {
      this.setStatus('已连接');
      this.reconnectDelay = RECONNECT_BASE_MS;
      // 反向连接时外挂 Bot 已经就绪，直接拉群列表
      setTimeout(() => { if (this.connection === ws) this.onConnected(); }, 200);
    }
    ws.on('message', data => {
      if (this.connection !== ws) return;
      this.handleFrame(data);
    });
    ws.on('close', () => {
      if (this.connection !== ws) return;
      this.connection = null;
      this.selfId = '';
      this.nickname = '';
      this.setStatus(this.stopped ? '已停止' : '已断开');
      if (mode === 'forward') this.scheduleReconnect();
    });
    ws.on('error', error => {
      if (this.connection !== ws) return;
      this.log(`OneBot 连接错误：${error?.message ?? error}`);
    });
  }

  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openForward();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  handleFrame(data) {
    let payload;
    try {
      payload = JSON.parse(typeof data === 'string' ? data : data.toString('utf8'));
    } catch { return; }
    this.handlePayload(payload);
  }

  handlePayload(payload) {
    if (!payload || typeof payload !== 'object') return;

    // 任何上报都带 self_id，用来识别监听 Bot 自己
    const selfId = String(payload.self_id ?? '');
    if (selfId && selfId !== this.selfId) {
      this.selfId = selfId;
      this.emit('status', this.status);
    }

    // 收到 Action 响应（我们主动查询的返回值，例如群信息）
    if ('retcode' in payload || (payload.status === 'ok' && 'data' in payload) || payload.post_type === undefined && 'echo' in payload) {
      this.handleActionResponse(payload);
      return;
    }

    // 群名称更新
    const meta = parseMetaEvent(payload, 'group-name');
    if (meta) {
      this.recordEvent(meta);
      this.emit('meta', meta);
      return;
    }

    // 群成员变动
    if (payload.post_type === 'notice' && payload.notice_type === 'group_increase') {
      const item = {
        kind: 'member-join',
        groupId: String(payload.group_id ?? ''),
        userId: String(payload.user_id ?? ''),
        operatorId: String(payload.operator_id ?? '')
      };
      if (/^\d{5,20}$/.test(item.groupId) && /^\d{5,20}$/.test(item.userId)) {
        this.recordEvent(item);
        this.emit('meta', item);
      }
      return;
    }
    if (payload.post_type === 'notice' && payload.notice_type === 'group_decrease') {
      const item = {
        kind: 'member-leave',
        groupId: String(payload.group_id ?? ''),
        userId: String(payload.user_id ?? ''),
        operatorId: String(payload.operator_id ?? '')
      };
      if (/^\d{5,20}$/.test(item.groupId) && /^\d{5,20}$/.test(item.userId)) {
        this.recordEvent(item);
        this.emit('meta', item);
      }
      return;
    }

    const message = parseGroupMessage(payload);
    if (!message) return;

    // 自己发的消息不算（监听 Bot 自己不发言，但防一手回声）
    if (this.selfId && message.userId === this.selfId) return;

    // 同一消息按 groupId:messageId 去重
    if (message.messageId) {
      const key = `${message.groupId}:${message.messageId}`;
      const now = Date.now();
      if (this.seenMessages.has(key)) return;
      this.seenMessages.set(key, now);
      for (const [id, at] of this.seenMessages) if (at < now - 10 * 60 * 1000) this.seenMessages.delete(id);
    }

    this.recordEvent({ kind: 'group-message', groupId: message.groupId, userId: message.userId, text: message.text });
    this.emit('group-message', message);
  }

  recordEvent(event) {
    this.lastEventAt = Date.now();
    this.eventCount += 1;
    this.recentEvents.unshift({ at: new Date().toISOString(), ...event });
    if (this.recentEvents.length > MAX_BUFFERED_EVENTS) this.recentEvents.length = MAX_BUFFERED_EVENTS;
  }

  /* ------------------------- Action 请求（只读查询） ------------------------- */

  /**
   * 发起一个只读查询。注意：这里【只允许查询类 action】，
   * send_* 等发送类动作一律拒绝，遵守「监听 Bot 只收不发」的硬约束。
   */
  callAction(action, params = {}) {
    const READONLY = new Set([
      'get_group_info',
      'get_group_list',
      'get_group_member_info',
      'get_group_member_list',
      'get_login_info',
      'get_stranger_info'
    ]);
    if (!READONLY.has(action)) {
      throw new Error(`OneBot 监听 Bot 只允许只读查询，拒绝执行 ${action}`);
    }
    const ws = this.connection;
    if (!ws || ws.readyState !== WS_OPEN) return Promise.reject(new Error('OneBot 未连接'));
    const echo = `dsh-${action}-${++this.actionSeq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingActions.delete(echo);
        reject(new Error(`OneBot 查询超时：${action}`));
      }, 8000);
      this.pendingActions.set(echo, { resolve, reject, timer });
      try {
        ws.send(JSON.stringify({ action, params, echo }));
      } catch (error) {
        clearTimeout(timer);
        this.pendingActions.delete(echo);
        reject(error);
      }
    });
  }

  handleActionResponse(payload) {
    const echo = payload.echo;
    if (!echo) return;
    const pending = this.pendingActions.get(echo);
    if (!pending) return;
    this.pendingActions.delete(echo);
    clearTimeout(pending.timer);
    if (payload.retcode !== 0 || payload.status === 'failed') {
      pending.reject(new Error(`OneBot 查询失败：${payload.message ?? payload.wording ?? payload.retcode}`));
      return;
    }
    pending.resolve(payload.data);
  }

  /**
   * 主动拉取群信息。列表里会带群名称，用它补全「群号 → 群名」的映射。
   * 这是群名称的主要来源：只依赖 group_name 事件的话，平时根本收不到。
   */
  async fetchGroupList() {
    try {
      const list = await this.callAction('get_group_list');
      if (!Array.isArray(list)) return [];
      const groups = [];
      for (const item of list) {
        const groupId = String(item?.group_id ?? '');
        const name = typeof item?.group_name === 'string' ? item.group_name.trim().slice(0, 48) : '';
        if (!/^\d{5,20}$/.test(groupId) || !name) continue;
        groups.push({ groupId, name });
        this.emit('meta', { kind: 'group-name', groupId, name });
      }
      return groups;
    } catch (error) {
      this.log(`拉取群列表失败：${error.message}`);
      return [];
    }
  }

  /** 拉取单个群的详情（群名等） */
  async fetchGroupInfo(groupId) {
    try {
      const info = await this.callAction('get_group_info', { group_id: Number(groupId), no_cache: true });
      const name = typeof info?.group_name === 'string' ? info.group_name.trim().slice(0, 48) : '';
      if (!name) return null;
      this.emit('meta', { kind: 'group-name', groupId: String(groupId), name });
      return name;
    } catch (error) {
      this.log(`查询群 ${groupId} 信息失败：${error.message}`);
      return null;
    }
  }

  getStatus() {
    return {
      enabled: this.enabled,
      status: this.status,
      mode: this.mode ?? '',
      selfId: this.selfId,
      nickname: this.nickname,
      lastEventAt: this.lastEventAt ? new Date(this.lastEventAt).toISOString() : null,
      eventCount: this.eventCount,
      connected: this.status === '已连接',
      recentEvents: this.recentEvents.slice(0, 20)
    };
  }

  /**
   * 【故意留空】OneBot 通道只收不发。
   *
   * 任何调用都会被立刻拒绝，而不是悄悄发出去。这样即使以后有人误以为
   * 「反正连上了，顺手用外挂号发一条吧」，也会在第一次尝试时就炸出来，
   * 而不是造成封号风险或身份错乱。
   */
  send() {
    throw new Error('OneBot 监听 Bot 只接收消息，不发送任何群消息；群发言请走官方 Bot');
  }
}

/** 判断 WebSocket 是否处于可用状态 */
export const isOpen = ws => ws?.readyState === WS_OPEN;
