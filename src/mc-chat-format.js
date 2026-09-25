export function formatMcToQq(template, { player, content }) {
  const cleanPlayer = String(player ?? '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 32);
  const cleanContent = String(content ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 350);
  return String(template).replace(/\$\{(player|message)\}/g, (_whole, name) => name === 'player' ? cleanPlayer : cleanContent).slice(0, 600);
}

