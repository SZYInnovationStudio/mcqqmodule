import test from 'node:test';
import assert from 'node:assert/strict';
import { formatMcToQq, stripMentions } from '../src/mc-chat-format.js';
import { DEFAULT_MC_TO_QQ_TEMPLATE, validateConfig } from '../src/config.js';

/* ---------------- MC → QQ 显示 QQ 号 ---------------- */

test('MC → QQ 默认模板带上 QQ 号', () => {
  assert.match(DEFAULT_MC_TO_QQ_TEMPLATE, /\$\{qq\}/, '默认模板应含 ${qq}');
  const text = formatMcToQq(DEFAULT_MC_TO_QQ_TEMPLATE, { player: 'Alice', content: '你好', qq: '123456789' });
  assert.equal(text, '[服务器] Alice（QQ 123456789）: 你好');
});

test('没有绑定时显示「未绑定」，不出现空括号', () => {
  const text = formatMcToQq(DEFAULT_MC_TO_QQ_TEMPLATE, { player: 'Alice', content: '你好', qq: '' });
  assert.equal(text, '[服务器] Alice（QQ 未绑定）: 你好');
  assert.doesNotMatch(text, /（）/);
});

test('QQ 号是脏数据时不显示', () => {
  for (const bad of ['abc', '<script>', '123', '']) {
    const text = formatMcToQq('[${player}] ${qq}: ${message}', { player: 'A', content: 'x', qq: bad });
    assert.equal(text, '[A] 未绑定: x', `脏数据 ${JSON.stringify(bad)} 应显示未绑定`);
  }
});

test('模板可用 ${qqOrEmpty} 在无绑定时留空', () => {
  const text = formatMcToQq('${player}${qqOrEmpty}: ${message}', { player: 'A', content: 'x', qq: '' });
  assert.equal(text, 'A: x');
});

/* ---------------- @ 标记清理 ---------------- */

test('清理官方 Bot 的 OpenID 形式 @ 标记', () => {
  assert.equal(stripMentions('<@6610E6460F3C009689F38296C59EA40F> 我去你不早说'), '@用户 我去你不早说');
  assert.equal(stripMentions('<@!ABC123def456> 你好'), '@用户 你好');
});

test('清理纯数字 @ 保留 QQ 号', () => {
  assert.equal(stripMentions('<@123456789> 看这个'), '@123456789 看这个');
});

test('清理 OneBot 的 CQ 码 @ 标记', () => {
  assert.equal(stripMentions('[CQ:at,qq=123456789] 你好'), '@123456789 你好');
  assert.equal(stripMentions('[CQ:at,qq=all] 通知'), '@全体成员 通知');
});

test('清理未闭合的残留 @ 标记', () => {
  assert.equal(stripMentions('</@abc> 文字'), '文字');
});

test('没有 @ 标记时原样返回', () => {
  assert.equal(stripMentions('普通消息'), '普通消息');
  assert.equal(stripMentions(''), '');
  assert.equal(stripMentions(undefined), '');
});

/* ---------------- 模板校验 ---------------- */

const base = {
  qqAppId: '123456', qqAppSecret: 'x', allowedGroups: '123456', pluginKey: 'a'.repeat(32)
};

test('允许 ${qq} 与 ${qqOrEmpty} 占位符', () => {
  for (const tpl of ['[${player}]${qq}: ${message}', '${player}${qqOrEmpty}: ${message}']) {
    const config = validateConfig({ ...base, mcToQqTemplate: tpl });
    assert.equal(config.mcToQqTemplate, tpl);
  }
});

test('拒绝不支持的占位符', () => {
  assert.throws(
    () => validateConfig({ ...base, mcToQqTemplate: '${player}: ${message} ${badvar}' }),
    /不支持的占位符/
  );
});

test('旧默认模板自动迁移到新默认', () => {
  const config = validateConfig({ ...base, mcToQqTemplate: '[服务器] ${player}: ${message}' });
  assert.match(config.mcToQqTemplate, /\$\{qq\}/, '旧默认应被迁移');
});

test('用户自定义模板保持原样，不被迁移覆盖', () => {
  const custom = '&b[游戏]&r ${player} > ${message}';
  const config = validateConfig({ ...base, mcToQqTemplate: custom });
  assert.equal(config.mcToQqTemplate, custom);
});
