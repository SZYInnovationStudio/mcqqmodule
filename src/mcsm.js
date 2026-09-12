export class McsmClient {
  constructor(config, fetchImpl = fetch) {
    this.config = config;
    this.fetch = fetchImpl;
  }

  async request(path, params = {}) {
    const { mcsmUrl, mcsmApiKey, daemonId, instanceId } = this.config;
    if (!mcsmUrl || !mcsmApiKey || !daemonId || !instanceId) throw new Error('MCSManager 配置不完整');
    const url = new URL(path, `${mcsmUrl}/`);
    for (const [key, value] of Object.entries({ apikey: mcsmApiKey, daemonId, uuid: instanceId, ...params })) url.searchParams.set(key, String(value));
    const response = await this.fetch(url, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Requested-With': 'XMLHttpRequest' }, signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`MCSManager HTTP ${response.status}`);
    const body = await response.json();
    if (body.status !== 200) throw new Error(`MCSManager 返回状态 ${body.status}`);
    return body.data;
  }

  instance() { return this.request('/api/instance'); }
  outputLog() { return this.request('/api/protected_instance/outputlog', { size: 256 }); }
}
