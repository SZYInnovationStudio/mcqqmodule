import { randomUUID, timingSafeEqual } from 'node:crypto';

export function matchesPluginKey(header, expected) {
  const actual = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(String(header ?? ''))?.[1];
  if (!expected || !actual) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class PluginConnectionState {
  constructor(timeoutMs = 30_000) {
    this.timeoutMs = timeoutMs;
    this.state = 'unknown';
    this.lastSeen = 0;
  }

  observe(now = Date.now()) {
    const changed = this.state !== 'online';
    this.state = 'online';
    this.lastSeen = now;
    return changed ? 'online' : null;
  }

  check(now = Date.now()) {
    if (this.state !== 'online' || now - this.lastSeen < this.timeoutMs) return null;
    this.state = 'offline';
    return 'offline';
  }
}

export class PluginChatExchange {
  constructor(onChat, onPresence = () => {}, onLifecycle = () => {}) {
    this.onChat = onChat;
    this.onPresence = onPresence;
    this.onLifecycle = onLifecycle;
    this.outgoing = [];
    this.nextId = 1;
    this.epoch = randomUUID();
    this.seen = new Set();
    this.lastSeen = 0;
  }

  enqueue(components) {
    if (!Array.isArray(components) || !components.length || components.length > 32) throw new Error('插件消息格式无效');
    this.outgoing.push({ id: this.nextId++, components });
    if (this.outgoing.length > 100) this.outgoing.shift();
  }

  exchange(input) {
    if (!input || !Number.isSafeInteger(input.ack) || input.ack < 0 || !Array.isArray(input.sent) || input.sent.length > 20) throw new Error('插件交换请求格式无效');
    this.lastSeen = Date.now();
    if (input.epoch === this.epoch) this.outgoing = this.outgoing.filter(item => item.id > input.ack);
    for (const item of input.sent) {
      if (!item || typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(item.id)) throw new Error('插件玩家事件格式无效');
      const kind = item.kind ?? 'chat';
      if (kind === 'chat') {
        if (typeof item.player !== 'string' || !/^[A-Za-z0-9_]{3,16}$/.test(item.player) || typeof item.message !== 'string' || !item.message.trim() || item.message.length > 350) throw new Error('插件玩家消息格式无效');
      } else if (kind === 'join' || kind === 'quit') {
        const validName = name => typeof name === 'string' && name.length >= 1 && name.length <= 40 && !/[\u0000-\u001f\u007f]/u.test(name);
        if (!validName(item.player) || !Array.isArray(item.players) || item.players.length > 200 || !item.players.every(validName)) throw new Error('插件玩家进出事件格式无效');
      } else if (kind !== 'start' && kind !== 'stop') throw new Error('插件玩家事件类型无效');
      if (this.seen.has(item.id)) continue;
      this.seen.add(item.id);
      if (this.seen.size > 2000) this.seen.delete(this.seen.values().next().value);
      Promise.resolve().then(() => kind === 'chat'
        ? this.onChat({ player: item.player, content: item.message })
        : (kind === 'join' || kind === 'quit')
          ? this.onPresence({ kind, player: item.player, players: item.players })
          : this.onLifecycle({ kind })).catch(() => {});
    }
    return { epoch: this.epoch, receive: this.outgoing.slice(0, 20) };
  }
}
