/**
 * 生成 GitHub Release 的正文（简介）。
 *
 * 为什么不直接用 action 的 generate_release_notes：
 * 它在同名 Release 已存在时会「追加」说明，重复推送同一版本就会叠出
 * 多份 Full Changelog。这里改为每次完整重写，保证幂等。
 *
 * 正文包含：
 *   1. 本次版本的更新日志（从 CHANGELOG.md 提取该版本小节）
 *   2. 版本内修订号（8.9.3+1、8.9.3+2 ...），由 CHANGELOG 中该版本内容的哈希决定
 *   3. 下载表与安装说明
 *
 * 输出：dist/RELEASE-NOTES.md（刻意放在 dist/release/ 之外，
 * 避免被 files: dist/release/* 当成附件上传）。
 */
import { createHash } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const releaseDir = join(root, 'dist', 'release');
const outFile = join(root, 'dist', 'RELEASE-NOTES.md');

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const appVersion = pkg.version;

const pom = await readFile(join(root, 'minecraft-plugin', 'pom.xml'), 'utf8');
const pluginVersion = pom.match(/<version>([^<]+)<\/version>/)[1];

const repo = process.env.GITHUB_REPOSITORY || 'SZYInnovationStudio/mcqqmodule';
const tag = `v${appVersion}`;
const base = `https://github.com/${repo}/releases/download/${tag}`;

/* ---------------------- 从 CHANGELOG 提取本版内容 ---------------------- */

let changelog = '';
try {
  changelog = await readFile(join(root, 'CHANGELOG.md'), 'utf8');
} catch {
  console.warn('未找到 CHANGELOG.md，更新日志部分将留空');
}

/** 取某个版本的小节内容（到下一个 `## [` 或文件末尾为止） */
function extractSection(version) {
  // 匹配 `## [8.9.3] - 2026-10-31` 或 `## [8.9.3]`
  const pattern = new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\][^\\n]*\\n([\\s\\S]*?)(?=^## \\[|^---\\s*$|(?![\\s\\S]))`, 'm');
  const match = changelog.match(pattern);
  return match ? match[1].trim() : '';
}

const versionSection = extractSection(appVersion);

/**
 * 版本内修订号（本版本第几次构建）。
 *
 * 依据 REVISIONS.md 里记录的「上次同版本的内容哈希」来判断：
 *   - 本次内容与上次相同 → 重复推送，修订号不变（同一份包不刷出不同编号）
 *   - 本次内容不同 → 真的改了东西，修订号 +1
 *
 * 内容哈希由所有发布产物的字节计算，保证「包变了才算一次」。
 */
async function computeRevision(version) {
  // 1. 计算本次产物内容哈希
  const digest = createHash('sha256');
  const artifacts = (await readdir(releaseDir)).sort();
  for (const name of artifacts) {
    const data = await readFile(join(releaseDir, name));
    digest.update(name).update(data);
  }
  const currentHash = digest.digest('hex').slice(0, 16);

  // 2. 读 REVISIONS.md 里的历史记录
  let revisions = '';
  try { revisions = await readFile(join(root, 'REVISIONS.md'), 'utf8'); } catch { /* 首次运行 */ }
  const matcher = new RegExp(`^${version.replace(/\./g, '\\.')}\\s+(\\d+)\\s+([0-9a-f]{16})`);
  const line = revisions.split(/\r?\n/).map(r => r.trim()).find(r => matcher.test(r)) ?? '';
  const match = line.match(matcher);
  const previousCount = match ? Number(match[1]) : 0;
  const previousHash = match ? match[2] : '';

  // 3. 内容相同 → 沿用；内容不同 → 进位
  const count = previousHash === currentHash ? Math.max(previousCount, 1) : previousCount + 1;

  return { revision: count, currentHash, previousHash, previousCount };
}

const { revision, currentHash, previousHash } = await computeRevision(appVersion);
const fullVersion = `${appVersion}+${revision}`;
const isRepeatBuild = Boolean(previousHash) && previousHash === currentHash;

/* ------------------------------ 下载表 ------------------------------ */

const fmtSize = (bytes) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
};

const files = (await readdir(releaseDir)).sort();
// 下载表按「主要 → 次要」排序，避免校验文件排在最前面
const priority = ['mc-qq-bridge', 'szydmc-chat-bridge', 'daily-checkin-money', 'SHA256SUMS', 'BUILD-INFO'];
const rank = (file) => {
  const index = priority.findIndex((key) => file.includes(key));
  return index === -1 ? priority.length : index;
};
const ordered = [...files].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
const describe = {
  'mc-qq-bridge': '完整公开分发包（后台 + 网页 + 插件源码 + 插件 JAR + 模块包），解压即用',
  'szydmc-chat-bridge': '独立 Minecraft 插件 JAR，丢进服务端 plugins/ 即可',
  'daily-checkin-money': '每日签到增量模块，在后台「模块中心」上传',
  'SHA256SUMS': '全部附件的 SHA-256 校验值',
  'BUILD-INFO': '构建信息（版本、提交、时间）',
};

/* ------------------------------ 拼正文 ------------------------------ */

const lines = [];

lines.push('## 本次更新');
lines.push('');
if (versionSection) {
  lines.push(versionSection);
} else {
  lines.push(`_本版本尚未在 \`CHANGELOG.md\` 中登记更新内容。_`);
}
lines.push('');

lines.push('## 下载');
lines.push('');
lines.push('| 文件 | 大小 | 用途 |');
lines.push('| --- | --- | --- |');
for (const file of ordered) {
  const { size } = await stat(join(releaseDir, file));
  const key = Object.keys(describe).find((k) => file.includes(k));
  const note = key ? describe[key] : '';
  lines.push(`| [${file}](${base}/${file}) | ${fmtSize(size)} | ${note} |`);
}

lines.push('');
lines.push('## 版本信息');
lines.push('');
lines.push(`- 后台：\`${appVersion}\``);
lines.push(`- **本版本第 ${revision} 次更新**（\`${fullVersion}\`）`);
lines.push(`- 插件：\`${pluginVersion}\``);
lines.push('');
lines.push('> 修订号表示同一版本号下的第几次构建，内容有变化才会进位；');
lines.push('> 完整历史见仓库 [CHANGELOG.md](https://github.com/' + repo + '/blob/main/CHANGELOG.md)。');

lines.push('');
lines.push('## 快速安装');
lines.push('');
lines.push('```bash');
lines.push('git clone https://github.com/' + repo + '.git');
lines.push('cd mcqqmodule');
lines.push('npm install && npm start');
lines.push('```');
lines.push('');
lines.push('启动后浏览器打开 `http://127.0.0.1:2556`，首次进入创建管理员账号。');
lines.push('插件安装见 [README.md](https://github.com/' + repo + '#安装-minecraft-插件)，');
lines.push('Linux 长期运行见 [DEPLOY.md](https://github.com/' + repo + '/blob/main/DEPLOY.md)。');
lines.push('');
lines.push('> 本包为**公开分发包**，不含 `data/`、`master.key` 或任何密钥。');
lines.push('> 部署后请自行在后台生成插件 Key，并单独备份 `data/` 目录。');
lines.push('');
lines.push('## 完整变更记录');
lines.push('');
lines.push(`[${tag} 的全部提交](${base.replace('/releases/download/', '/commits/')})`);

await writeFile(outFile, `${lines.join('\n')}\n`);

/* ---------------------- 回写 REVISIONS.md ---------------------- */

try {
  const revFile = join(root, 'REVISIONS.md');
  let content = '';
  try { content = await readFile(revFile, 'utf8'); } catch { /* 首次 */ }
  const row = `${appVersion}       ${revision}    ${currentHash}`;
  const rows = content.split(/\r?\n/);
  // 用正则匹配「版本号 + 空白」，注意 \s 必须写在正则里，不能当普通字符串
  const matcher = new RegExp(`^${appVersion.replace(/\./g, '\\.')}\\s+\\d+\\s+[0-9a-f]*`);
  const hits = rows.map((line, i) => (matcher.test(line.trim()) ? i : -1)).filter(i => i >= 0);
  if (hits.length) {
    // 已有记录：替换第一处，删掉多余的重复行
    rows[hits[0]] = row;
    for (const i of hits.slice(1).reverse()) rows.splice(i, 1);
  } else {
    // 首次记录：去掉末尾空行后追加
    while (rows.length && !rows[rows.length - 1].trim()) rows.pop();
    rows.push(row);
  }
  await writeFile(revFile, `${rows.join('\n')}\n`);
} catch (error) {
  console.warn(`REVISIONS.md 回写失败：${error.message}`);
}

console.log(`RELEASE_NOTES=${outFile}`);
console.log(`版本=${appVersion} 修订=${revision} 完整=${fullVersion}${isRepeatBuild ? '（重复构建，编号不变）' : ''}`);
if (!versionSection) console.warn(`⚠️ CHANGELOG.md 里没有 ${appVersion} 的小节`);
