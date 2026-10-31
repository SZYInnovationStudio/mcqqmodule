import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const root = new URL('..', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), 'utf8');
const exists = (rel) => existsSync(new URL(rel, root));

test('存在 CHANGELOG.md 且格式符合 Keep a Changelog', () => {
  assert.ok(exists('CHANGELOG.md'), '必须有 CHANGELOG.md');
  const changelog = read('CHANGELOG.md');
  // 顶部标题
  assert.match(changelog, /^# 更新日志/m);
  // 至少有一条版本小节，形如 ## [8.9.3] - 2026-10-31
  assert.match(changelog, /^## \[\d+\.\d+\.\d+\]/m, '必须有版本小节');
});

test('当前版本号在 CHANGELOG 里已登记', () => {
  const pkg = JSON.parse(read('package.json'));
  const changelog = read('CHANGELOG.md');
  const escaped = pkg.version.replace(/\./g, '\\.');
  assert.match(
    changelog,
    new RegExp(`^## \\[${escaped}\\]`, 'm'),
    `CHANGELOG.md 里缺少 ${pkg.version} 的小节，发版后 Release 正文会是空的`
  );
});

test('CHANGELOG 的小节按版本号从新到旧排列', () => {
  const changelog = read('CHANGELOG.md');
  const versions = [...changelog.matchAll(/^## \[(\d+)\.(\d+)\.(\d+)\]/gm)]
    .map(m => [Number(m[1]), Number(m[2]), Number(m[3])]);
  assert.ok(versions.length >= 2, '至少要有两个版本才能比较顺序');
  for (let i = 1; i < versions.length; i += 1) {
    const [a1, a2, a3] = versions[i - 1];
    const [b1, b2, b3] = versions[i];
    const prev = a1 * 1e6 + a2 * 1e3 + a3;
    const curr = b1 * 1e6 + b2 * 1e3 + b3;
    assert.ok(prev >= curr, `版本顺序错误：${versions[i - 1].join('.')} 应排在 ${versions[i].join('.')} 之前`);
  }
});

test('存在 REVISIONS.md 用于记录版本内构建次数', () => {
  assert.ok(exists('REVISIONS.md'), '必须有 REVISIONS.md');
  const revisions = read('REVISIONS.md');
  assert.match(revisions, /版本内|构建次数|第几次/, 'REVISIONS.md 应说明修订号的含义');
});

test('release-notes 脚本会读取 CHANGELOG 并计算修订号', () => {
  const notes = read('scripts/release-notes.mjs');
  assert.match(notes, /CHANGELOG\.md/, '必须读取 CHANGELOG.md');
  assert.match(notes, /REVISIONS\.md/, '必须读取 REVISIONS.md');
  assert.match(notes, /第 \$\{revision\} 次更新/, '正文必须显示第几次更新');
  assert.match(notes, /本版本/, '正文必须有本次更新小节');
});

test('修订号用内容哈希判断，重复推送不会乱涨', () => {
  const notes = read('scripts/release-notes.mjs');
  // 必须是「内容相同则沿用，不同才进位」的逻辑
  assert.match(notes, /previousHash === currentHash/, '内容相同时应沿用原修订号');
  assert.match(notes, /previousCount \+ 1/, '内容不同时才进位');
});

test('发布包里包含 CHANGELOG 与 REVISIONS', () => {
  const assembler = read('scripts/assemble-release.mjs');
  const included = assembler.match(/const INCLUDED = \[([\s\S]*?)\];/)[1];
  assert.match(included, /'CHANGELOG\.md'/, '公开包应包含 CHANGELOG.md');
  assert.match(included, /'REVISIONS\.md'/, '公开包应包含 REVISIONS.md');
});
