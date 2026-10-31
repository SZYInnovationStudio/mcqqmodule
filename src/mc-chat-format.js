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
