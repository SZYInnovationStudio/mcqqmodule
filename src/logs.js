const CHAT = [/<([A-Za-z0-9_]{3,16})>\s+(.+)$/, /\[CHAT\]\s+([A-Za-z0-9_]{3,16}):\s+(.+)$/i];

function shanghaiDate(now) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

export function recentPlayerMessages(log, now = new Date()) {
  const text = String(log ?? '').replace(/\x1b\[[0-9;]*m/g, '');
  const date = shanghaiDate(now);
  const min = now.getTime() - 120000;
  const found = [];
  for (const line of text.split(/\r?\n/)) {
    const time = line.match(/(?:^|\[)(\d{2}):(\d{2}):(\d{2})(?:\]|\s)/);
    if (!time) continue;
    const stamp = `${date}T${time[1]}:${time[2]}:${time[3]}+08:00`;
    let timestamp = Date.parse(stamp);
    if (timestamp > now.getTime() + 1000) timestamp -= 86400000;
    if (timestamp < min || timestamp > now.getTime() + 1000) continue;
    const chat = CHAT.map(pattern => line.match(pattern)).find(Boolean);
    if (chat) found.push({ time: `${time[1]}:${time[2]}:${time[3]}`, player: chat[1], message: chat[2].trim() });
  }
  return found.slice(-20);
}
