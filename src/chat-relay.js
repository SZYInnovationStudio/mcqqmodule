import { open, stat } from 'node:fs/promises';

export function cleanChat(value, limit = 180) {
  return String(value ?? '').replace(/[\r\n\t\0-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

export function qqTellraw(nickname, content) {
  const name = cleanChat(nickname, 48) || '群友';
  const message = cleanChat(content, 180);
  if (!message) return null;
  const command = `tellraw @a ${JSON.stringify({ text: '', extra: [{ text: '[QQ群]', color: 'green' }, { text: ` ${name}:${message}` }] })}`;
  if (command.length > 512) throw new Error('群消息过长，无法发送到 MC');
  return command;
}

export function parsePlayerChat(line) {
  const text = String(line ?? '').replace(/\x1b\[[0-9;]*m/g, '');
  // Vanilla / Paper latest.log: [time] [Server thread/INFO]: <player> message
  // Some hosts use [time INFO]: <player> message.
  const match = text.match(/^\[[^\]]+\](?: \[[^\]]*\/INFO\]|\s+INFO)?\s*:\s*<([A-Za-z0-9_]{3,16})>\s+(.+)$/);
  if (!match) return null;
  const content = cleanChat(match[2], 350);
  if (!content || content.startsWith('[QQ群]')) return null;
  return { player: match[1], content };
}

export function parseOnlineList(output) {
  const text = String(output ?? '').replace(/§./g, '').trim();
  const count = text.match(/(?:There are|当前有|在线玩家[：:]?)\s*(\d+)/i);
  const colon = text.lastIndexOf(':');
  if (colon < 0 || !count) return null;
  const names = text.slice(colon + 1).split(/[,，]/).map(name => name.trim()).filter(Boolean);
  if (Number(count[1]) !== names.length || names.some(name => !/^[A-Za-z0-9_]{3,16}$/.test(name))) return null;
  return names;
}

export class ChatLogTail {
  constructor(path, onChat, onError = () => {}) {
    this.path = path;
    this.onChat = onChat;
    this.onError = onError;
    this.position = null;
    this.identity = null;
    this.remainder = '';
    this.timer = null;
    this.running = false;
    this.busy = false;
    this.errorReported = false;
  }

  start() { this.running = true; this.schedule(0); }
  stop() { this.running = false; clearTimeout(this.timer); }
  schedule(delay = 1000) {
    if (this.running) this.timer = setTimeout(() => this.poll().finally(() => this.schedule()), delay);
  }

  async poll() {
    if (this.busy || !this.running) return;
    this.busy = true;
    try {
      const info = await stat(this.path);
      if (!info.isFile()) throw new Error('MC 日志路径不是文件');
      const identity = `${info.dev}:${info.ino}:${info.birthtimeMs}`;
      if (this.position === null || identity !== this.identity || info.size < this.position) {
        this.identity = identity;
        this.position = info.size;
        this.remainder = '';
        return;
      }
      if (info.size === this.position) return;
      const handle = await open(this.path, 'r');
      try {
        const length = Math.min(info.size - this.position, 256 * 1024);
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, this.position);
        this.position += bytesRead;
        const lines = (this.remainder + buffer.subarray(0, bytesRead).toString('utf8')).split(/\r?\n/);
        this.remainder = lines.pop().slice(-4096);
        for (const line of lines) {
          const chat = parsePlayerChat(line);
          if (chat) await this.onChat(chat);
        }
      } finally { await handle.close(); }
      this.errorReported = false;
    } catch (error) {
      if (!this.errorReported) this.onError(error);
      this.errorReported = true;
    } finally { this.busy = false; }
  }
}
