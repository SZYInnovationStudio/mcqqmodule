import net from 'node:net';

function varint(value) {
  const bytes = [];
  do {
    let part = value & 0x7f;
    value >>>= 7;
    if (value) part |= 0x80;
    bytes.push(part);
  } while (value);
  return Buffer.from(bytes);
}

function readVarint(buffer, start = 0) {
  let value = 0;
  let shift = 0;
  for (let i = start; i < Math.min(buffer.length, start + 5); i++) {
    value |= (buffer[i] & 0x7f) << shift;
    if (!(buffer[i] & 0x80)) return { value, next: i + 1 };
    shift += 7;
  }
  return null;
}

function flatten(description) {
  if (typeof description === 'string') return description;
  if (!description || typeof description !== 'object') return '';
  return `${description.text ?? ''}${(description.extra ?? []).map(flatten).join('')}`;
}

export function queryMotd({ mcHost, mcPort }, timeoutMs = 4000) {
  if (!mcHost || !mcPort) return Promise.reject(new Error('Minecraft 地址和端口未配置'));
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: mcHost, port: Number(mcPort) });
    let data = Buffer.alloc(0);
    let done = false;
    const timer = setTimeout(() => finish(new Error('服务器状态查询超时')), timeoutMs);
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    socket.on('error', error => finish(new Error(`无法连接 MC 服务器：${error.message}`)));
    socket.on('close', () => { if (!done) finish(new Error('MC 服务器关闭了状态连接')); });
    socket.on('connect', () => {
      const host = Buffer.from(mcHost, 'utf8');
      const port = Buffer.alloc(2);
      port.writeUInt16BE(Number(mcPort));
      const handshake = Buffer.concat([varint(0), varint(767), varint(host.length), host, port, varint(1)]);
      socket.write(Buffer.concat([varint(handshake.length), handshake, Buffer.from([1, 0])]));
    });
    socket.on('data', chunk => {
      data = Buffer.concat([data, chunk]);
      if (data.length > 1024 * 1024) return finish(new Error('状态响应过大'));
      const frame = readVarint(data);
      if (!frame || data.length < frame.next + frame.value) return;
      const id = readVarint(data, frame.next);
      if (!id || id.value !== 0) return finish(new Error('MC 状态响应无效'));
      const size = readVarint(data, id.next);
      if (!size || size.next + size.value > data.length) return finish(new Error('MC 状态内容无效'));
      try {
        const status = JSON.parse(data.subarray(size.next, size.next + size.value).toString('utf8'));
        const players = (Array.isArray(status.players?.sample) ? status.players.sample : [])
          .map(item => typeof item?.name === 'string' ? item.name.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 64) : '')
          .filter(Boolean).slice(0, 100);
        finish(null, { motd: flatten(status.description).replace(/§./g, '').trim(), online: status.players?.online ?? null, max: status.players?.max ?? null, version: status.version?.name ?? '', players });
      } catch { finish(new Error('MC 状态 JSON 无效')); }
    });
  });
}
