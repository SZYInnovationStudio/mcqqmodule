/**
 * 生成 GitHub Release 的正文（简介）。
 *
 * 为什么不直接用 action 的 generate_release_notes：
 * 它在同名 Release 已存在时会「追加」说明，重复推送同一版本就会叠出
 * 多份 Full Changelog。这里改为每次完整重写，保证幂等。
 *
 * 输出：dist/RELEASE-NOTES.md（刻意放在 dist/release/ 之外，
 * 避免被 files: dist/release/* 当成附件上传）。
 */
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

const lines = [];
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
lines.push('## 版本');
lines.push('');
lines.push(`- 后台：\`${appVersion}\``);
lines.push(`- 插件：\`${pluginVersion}\``);
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
console.log(`RELEASE_NOTES=${outFile}`);
