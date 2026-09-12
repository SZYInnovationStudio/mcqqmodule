export function parseOnlineList(output) {
  const text = String(output ?? '').replace(/§./g, '').trim();
  const count = text.match(/(?:There are|当前有|在线玩家[：:]?)\s*(\d+)/i);
  const colon = Math.max(text.lastIndexOf(':'), text.lastIndexOf('：'));
  if (colon < 0 || !count) return null;
  const names = text.slice(colon + 1).split(/[,，]/).map(name => name.trim()).filter(Boolean);
  if (Number(count[1]) !== names.length || names.some(name => !/^[A-Za-z0-9_]{3,16}$/.test(name))) return null;
  return names;
}
