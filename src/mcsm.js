export async function fetchMcsmOutput(config, fetcher = fetch, size = 64) {
  const { mcsmBaseUrl, mcsmApiKey, mcsmDaemonId, mcsmInstanceUuid } = config;
  if (!mcsmBaseUrl || !mcsmApiKey || !mcsmDaemonId || !mcsmInstanceUuid) throw new Error('MCSManager 地址、API Key、Daemon ID 或 Instance UUID 未填完整');
  const url = new URL(`${mcsmBaseUrl.replace(/\/+$/, '')}/api/protected_instance/outputlog`);
  url.searchParams.set('uuid', mcsmInstanceUuid);
  url.searchParams.set('daemonId', mcsmDaemonId);
  url.searchParams.set('size', String(size));
  url.searchParams.set('apikey', mcsmApiKey);
  let response;
  try {
    response = await fetcher(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Requested-With': 'XMLHttpRequest' },
      redirect: 'error',
      signal: AbortSignal.timeout(6000)
    });
  } catch { throw new Error('MCSManager 连接失败或超时'); }
  if (!response.ok) {
    if (response.status === 403) {
      let detail;
      try { detail = await response.json(); } catch {}
      if (/administrator has disabled the use of the API key|enableApiKey/i.test(String(detail?.data ?? ''))) {
        throw new Error('MCSManager HTTP 403：面板管理员禁用了 API Key。请管理员在 MCSManager Web 配置中启用 enableApiKey，并重启面板 Web 服务后再测试。');
      }
    }
    throw new Error(`MCSManager HTTP ${response.status}`);
  }
  let body;
  try { body = await response.json(); } catch { throw new Error('MCSManager 返回了无效 JSON'); }
  if (body?.status !== 200) throw new Error(`MCSManager API ${body?.status ?? '响应异常'}`);
  if (typeof body.data !== 'string' || body.data.length > 4 * 1024 * 1024) throw new Error('MCSManager 输出格式无效或过大');
  return body.data;
}

export function parseMcPlayerChat(line) {
  const text = String(line ?? '').replace(/\x1b\[[0-9;]*m/g, '').replace(/§[0-9a-fk-or]/gi, '');
  const match = text.match(/^\[[^\]]+\](?: \[[^\]]*\/INFO\])?\s*:\s*(?:<([A-Za-z0-9_]{3,16})>\s+|([A-Za-z0-9_]{3,16}):\s+)(.+)$/);
  if (!match) return null;
  const content = match[3].replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 350);
  if (!content || content.startsWith('[QQ群]')) return null;
  return { player: match[1] || match[2], content };
}

export function formatMcToQq(template, { player, content }) {
  const cleanPlayer = String(player ?? '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 32);
  const cleanContent = String(content ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 350);
  return String(template).replace(/\$\{(player|message)\}/g, (_whole, name) => name === 'player' ? cleanPlayer : cleanContent).slice(0, 600);
}

export class McsmOutputRelay {
  constructor(config, onChat, onError = () => {}, getOutput = fetchMcsmOutput) {
    this.config = config;
    this.onChat = onChat;
    this.onError = onError;
    this.getOutput = getOutput;
    this.previous = null;
    this.remainder = '';
    this.timer = null;
    this.running = false;
    this.busy = false;
    this.errorReported = false;
  }

  start() { this.running = true; this.schedule(0); }
  stop() { this.running = false; clearTimeout(this.timer); }
  schedule(delay = 2000) {
    if (this.running) this.timer = setTimeout(() => this.poll().finally(() => this.schedule()), delay);
  }

  async poll() {
    if (!this.running || this.busy) return;
    this.busy = true;
    try {
      const output = await this.getOutput(this.config);
      if (this.previous === null) { this.previous = output; return; }
      if (output === this.previous) return;
      const anchor = this.previous.slice(-Math.min(this.previous.length, 256));
      const index = anchor ? output.lastIndexOf(anchor) : 0;
      this.previous = output;
      if (index < 0) {
        this.remainder = '';
        if (!this.errorReported) this.onError(new Error('MCSManager 输出无法与上次衔接，本轮跳过以避免重发旧聊天'));
        this.errorReported = true;
        return;
      }
      const added = output.slice(index + anchor.length);
      const lines = (this.remainder + added).split(/\r?\n/);
      this.remainder = lines.pop().slice(-4096);
      for (const line of lines) {
        const chat = parseMcPlayerChat(line);
        if (chat) await this.onChat(chat);
      }
      this.errorReported = false;
    } catch (error) {
      if (!this.errorReported) this.onError(error);
      this.errorReported = true;
    } finally { this.busy = false; }
  }
}
