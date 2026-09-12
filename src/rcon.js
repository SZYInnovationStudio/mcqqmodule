import net from 'node:net';

function packet(id, type, body) {
  const text = Buffer.from(body, 'utf8');
  const out = Buffer.alloc(14 + text.length);
  out.writeInt32LE(10 + text.length, 0);
  out.writeInt32LE(id, 4);
  out.writeInt32LE(type, 8);
  text.copy(out, 12);
  return out;
}

export function rconCommand({ rconHost, rconPort, rconPassword }, command, timeoutMs = 5000) {
  if (!rconHost || !rconPort || !rconPassword) return Promise.reject(new Error('RCON 配置不完整'));
  if (!/^[a-zA-Z0-9_.-]+$/.test(rconHost)) return Promise.reject(new Error('RCON 主机名格式无效'));
  if (!command || command.length > 512 || /[\r\n\0]/.test(command)) return Promise.reject(new Error('命令格式无效'));
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: rconHost, port: Number(rconPort) });
    let buffer = Buffer.alloc(0);
    let authenticated = false;
    let finished = false;
    let idle;
    const timer = setTimeout(() => end(new Error('RCON 响应超时')), timeoutMs);
    const chunks = [];
    const end = (error, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(idle);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    socket.on('connect', () => socket.write(packet(101, 3, rconPassword)));
    socket.on('error', error => end(new Error(`RCON 连接失败：${error.message}`)));
    socket.on('close', () => { if (!finished) end(new Error('RCON 连接意外关闭')); });
    socket.on('data', data => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length >= 4) {
        const length = buffer.readInt32LE(0);
        if (length < 10 || length > 1024 * 1024) return end(new Error('RCON 数据包长度无效'));
        if (buffer.length < length + 4) break;
        const frame = buffer.subarray(0, length + 4);
        buffer = buffer.subarray(length + 4);
        const id = frame.readInt32LE(4);
        const type = frame.readInt32LE(8);
        if (id === -1) return end(new Error('RCON 密码错误'));
        if (!authenticated && id === 101 && type === 2) {
          authenticated = true;
          socket.write(packet(102, 2, command.replace(/^\//, '')));
        } else if (authenticated && id === 102) {
          chunks.push(frame.subarray(12, frame.length - 2).toString('utf8'));
          clearTimeout(idle);
          idle = setTimeout(() => end(null, chunks.join('').trim()), 200);
        }
      }
    });
  });
}
