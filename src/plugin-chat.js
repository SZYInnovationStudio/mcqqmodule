export class PluginChatExchange {
  constructor(onChat) {
    this.onChat = onChat;
    this.outgoing = [];
    this.nextId = 1;
    this.seen = new Set();
  }

  enqueue(components) {
    if (!Array.isArray(components) || !components.length || components.length > 32) throw new Error('插件消息格式无效');
    this.outgoing.push({ id: this.nextId++, components });
    if (this.outgoing.length > 100) this.outgoing.shift();
  }

  exchange(input) {
    if (!input || !Number.isSafeInteger(input.ack) || input.ack < 0 || !Array.isArray(input.sent) || input.sent.length > 20) throw new Error('插件交换请求格式无效');
    this.outgoing = this.outgoing.filter(item => item.id > input.ack);
    for (const item of input.sent) {
      if (!item || typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(item.id) || typeof item.player !== 'string' || !/^[A-Za-z0-9_]{3,16}$/.test(item.player) || typeof item.message !== 'string' || !item.message.trim() || item.message.length > 350) throw new Error('插件玩家消息格式无效');
      if (this.seen.has(item.id)) continue;
      this.seen.add(item.id);
      if (this.seen.size > 2000) this.seen.delete(this.seen.values().next().value);
      Promise.resolve().then(() => this.onChat({ player: item.player, content: item.message })).catch(() => {});
    }
    return { receive: this.outgoing.slice(0, 20) };
  }
}
