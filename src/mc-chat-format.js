/**
 * MC → QQ 的聊天格式化。
 *
 * 除了玩家名和消息内容，还支持带上该玩家绑定的 QQ 号：
 * 玩家在 AQQBot 里的绑定关系能让我们知道「游戏内这个人是哪个 QQ」，
 * 显示出来才方便群友对上号。
 */
export function formatMcToQq(template, { player, content, qq = '' }) {
  const cleanPlayer = String(player ?? '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 32);
  const cleanContent = String(content ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 350);
  // QQ 号只允许数字，其他一律当空；避免脏数据串进消息
  const cleanQq = /^\d{5,20}$/.test(String(qq ?? '')) ? String(qq) : '';
  // 没绑定时用占位符，避免出现「（）」这种空括号
  const displayQq = cleanQq || '未绑定';

  return String(template)
    .replace(/\$\{(player|message|qq|qqOrEmpty)\}/g, (_whole, name) => {
      if (name === 'player') return cleanPlayer;
      if (name === 'message') return cleanContent;
      if (name === 'qq') return displayQq;
      return cleanQq;
    })
    // 清理由于变量为空造成的空括号与多余空格
    .replace(/[（(]\s*[）)]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 600);
}

/**
 * 清理 QQ 消息里残留的 @ 标记。
 *
 * 官方 Bot 的 @ 在文本里是 `<@6610E646...>` 这种 OpenID 形式，
 * 直接转发到 MC 会变成一串乱码般的十六进制，玩家看不懂。
 * 这里把它替换成更容易读的形式。
 */
export function stripMentions(text) {
  return String(text ?? '')
    // 纯数字 @（QQ 号形式）要放在前面，否则会被下面的 OpenID 规则抢先匹配成「@用户」：
    // <@123456789> 这类应该显示成 @123456789，群友才能看出被 @ 的是谁
    .replace(/<@!?(\d{5,20})>/g, '@$1')
    // 官方 Bot：<@OpenID> —— OpenID 是字母数字混合串（可能以数字开头），统一简化成「@用户」
    // 注意不能写成纯数字的匹配，那种情况要保留原样显示成 @QQ号
    .replace(/<@!?(?=\w{5,128}\b)(?!\d+>)([A-Za-z0-9_-]{5,128})>/g, '@用户')
    // OneBot 的 CQ 码 [CQ:at,qq=123456]
    .replace(/\[CQ:at,qq=(\d{5,20})\]/g, '@$1')
    .replace(/\[CQ:at,qq=all\]/g, '@全体成员')
    // 其他未闭合的残留标记
    .replace(/<\/?@[^>]*>/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * 清洗 QQ 官方 Bot 泄漏的非文本标记。
 *
 * 群友发表情包、图片、贴纸时，官方 Bot 有时会把内部标记当纯文本传过来，例如：
 *   <faceType=6,faceId="0">,ext="eyJ0ZXh0Ijoi..."""
 *   <qqbot-at-everyone />
 *   <emoji:N>...
 * 这些丢进 MC 里就是一串看不懂的乱码，必须换成可读的占位符。
 */
export function sanitizeQqContent(text) {
  return String(text ?? '')
    // 表情 / 贴纸：<faceType=6,faceId="0">,ext="base64...">
    // 必须一次吃掉整个「标签 + 可选的 ,ext=...」尾巴：
    // 拆成两条规则时，第一条会把标签吃掉，留下孤零零的 ext= 清理不掉
    .replace(/<faceType=[^>]*>(?:\s*,?\s*ext=(?:"[^"]*"|[^\s,>]*))?/gi, '[表情]')
    // 独立出现的 ext="..." 尾巴（base64），整段清掉
    .replace(/,?\s*ext="[^"]*"/gi, '')
    .replace(/,?\s*ext=[^\s,>{]+/gi, '')
    // 官方 Bot 的图片与贴纸标记
    .replace(/<qqbot-(?:cdn|img|pic)[^>]*>/gi, '[图片]')
    .replace(/<qqbot-emoji[^>]*>/gi, '[表情]')
    .replace(/<qqbot-[a-z-]+[^>]*>/gi, '')
    // <emoji:123> 形式
    .replace(/<emoji:\d+>/gi, '[表情]')
    // 其他尖括号标签
    .replace(/<\/?[a-zA-Z][^>]{0,300}>/g, '')
    // 多个占位符合并
    .replace(/(\[表情\])+/g, '[表情]')
    .replace(/(\[图片\])+/g, '[图片]')
    // 清理残留的孤立逗号与多余空格
    .replace(/\s*,\s*(?=\[|$)/g, ' ')
    .replace(/^\s*,\s*/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
