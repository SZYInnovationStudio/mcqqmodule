/**
 * 汇总 GitHub Release 附件。
 *
 * 输入（由 release.yml 在此脚本之前生成）：
 *   - package.json 的 version                    → 后台版本
 *   - minecraft-plugin/pom.xml 的 version        → 插件版本
 *   - minecraft-plugin/target/szydmc-chat-bridge-<插件版本>.jar
 *   - dist/daily-checkin-money-<模块版本>.mcqqmodule
 *
 * 输出（全部写到 dist/release/）：
 *   - 公开分发包 ZIP：只含程序、网页、文档、插件 JAR 与模块包，绝不含 data/ 与密钥
 *   - 独立插件 JAR
 *   - 增量模块包
 *   - 校验清单和构建信息
 *
 * 这个脚本不接触 data/，也不读任何密钥文件：私有包由人工另外处理。
 */
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = join(root, 'dist', 'release');

/** 公开分发包中允许出现的顶层内容，其余一律不带。 */
const INCLUDED = [
  'src',
  'public',
  'modules',
  'scripts',
  'deploy',
  'tasks',
  'package.json',
  'package-lock.json',
  'README.md',
  'COMMANDS.md',
  'MODULE-SPEC.md',
  'DEPLOY.md',
  'LICENSE',
  'Dockerfile',
  '.dockerignore',
  'minecraft-plugin/maven-settings.xml',
  'minecraft-plugin/pom.xml',
  'minecraft-plugin/README.md',
  'minecraft-plugin/src',
];

/** 明确排除：数据、密钥、依赖、构建中间产物。 */
const EXCLUDED_PATTERNS = [
  /(^|\/)\.git(\/|$)/,
  /(^|\/)\.github(\/|$)/,
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)data(\/|$)/,
  /(^|\/)dist(\/|$)/,
  /(^|\/)coverage(\/|$)/,
  /(^|\/)\.env/,
  /(^|\/)master\.key$/,
  /(^|\/)target(\/|$)/,
  /\.log$/,
  /\.zip$/,
];

const isExcluded = (relPath) => EXCLUDED_PATTERNS.some((re) => re.test(relPath));

async function walk(absDir, baseDir, acc) {
  const entries = await readdir(absDir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = join(absDir, entry.name);
    const rel = relative(baseDir, abs).split('\\').join('/');
    if (isExcluded(rel)) continue;
    if (entry.isDirectory()) {
      await walk(abs, baseDir, acc);
    } else if (entry.isFile()) {
      acc.push(rel);
    }
  }
  return acc;
}

/**
 * 收集公开分发包应含的文件清单。
 * 插件 JAR 不放这里：它由调用方以 plugins/ 前缀单独加入，避免把 target/ 带进包内。
 */
async function collectFiles() {
  const files = [];
  for (const item of INCLUDED) {
    const abs = join(root, item);
    let stat;
    try {
      const { statSync } = await import('node:fs');
      stat = statSync(abs);
    } catch {
      console.warn(`跳过不存在的条目：${item}`);
      continue;
    }
    if (stat.isDirectory()) {
      await walk(abs, root, files);
    } else {
      files.push(item.split('\\').join('/'));
    }
  }
  return [...new Set(files)].sort();
}

let cachedPluginJar;
async function findPluginJar() {
  if (cachedPluginJar !== undefined) return cachedPluginJar;
  const pom = await readFile(join(root, 'minecraft-plugin', 'pom.xml'), 'utf8');
  const pluginVersion = pom.match(/<version>([^<]+)<\/version>/)[1];
  const relPath = `minecraft-plugin/target/szydmc-chat-bridge-${pluginVersion}.jar`;
  try {
    const buf = await readFile(join(root, relPath));
    cachedPluginJar = { rel: relPath, abs: join(root, relPath), version: pluginVersion, data: buf };
  } catch {
    console.warn('未找到插件 JAR，公开包将不含插件（本地开发时正常）');
    cachedPluginJar = null;
  }
  return cachedPluginJar;
}

/* ---------- 最小 ZIP 写入器（仅用 Node 内置能力，不引入额外依赖） ---------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i += 1) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

function dosDateTime(date) {
  const time =
    ((date.getHours() & 0x1f) << 11) |
    ((date.getMinutes() & 0x3f) << 5) |
    ((date.getSeconds() / 2) & 0x1f);
  const day =
    (((date.getFullYear() - 1980) & 0x7f) << 9) |
    (((date.getMonth() + 1) & 0x0f) << 5) |
    (date.getDate() & 0x1f);
  return { time, day };
}

function zipStore(entries) {
  const now = new Date();
  const { time, day } = dosDateTime(now);
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const data = entry.data;
    const crc = crc32(data);
    const compressed = deflateRawSync(data, { level: 9 });
    const useDeflate = compressed.length < data.length;
    const payload = useDeflate ? compressed : data;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, nameBuf, payload);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(time, 12);
    dir.writeUInt16LE(day, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(payload.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt16LE(0, 30);
    dir.writeUInt16LE(0, 32);
    dir.writeUInt16LE(0, 34);
    dir.writeUInt16LE(0, 36);
    dir.writeUInt32LE(0, 38);
    dir.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([dir, nameBuf]));

    offset += local.length + nameBuf.length + payload.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuf, end]);
}

/* ---------------------------------- 主流程 --------------------------------- */

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const appVersion = pkg.version;
const pluginJar = await findPluginJar();
const pluginVersion = pluginJar ? pluginJar.version : '(未编译)';

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const files = await collectFiles();
console.log(`公开分发包文件数：${files.length}`);

const entries = [];
for (const rel of files) {
  entries.push({ name: rel, data: await readFile(join(root, rel)) });
}

// 插件 JAR 以 plugins/ 前缀放进公开包，方便直接丢进服务端 plugins/ 目录
if (pluginJar) {
  entries.push({
    name: `plugins/szydmc-chat-bridge-${pluginVersion}.jar`,
    data: pluginJar.data,
  });
}

const zipName = `mc-qq-bridge-${appVersion}.zip`;
await writeFile(join(outDir, zipName), zipStore(entries));
console.log(`ZIP=${zipName}`);

// 独立插件 JAR
if (pluginJar) {
  const jarName = `szydmc-chat-bridge-${pluginVersion}.jar`;
  await copyFile(pluginJar.abs, join(outDir, jarName));
  console.log(`JAR=${jarName}`);
}

// 增量模块包
const distFiles = await readdir(join(root, 'dist'));
for (const file of distFiles) {
  if (file.endsWith('.mcqqmodule') || file.endsWith('.szydmodule')) {
    await copyFile(join(root, 'dist', file), join(outDir, file));
    console.log(`MODULE=${file}`);
  }
}

// 校验清单
const released = await readdir(outDir);
const sums = [];
for (const file of released.sort()) {
  const data = await readFile(join(outDir, file));
  sums.push(`${createHash('sha256').update(data).digest('hex')}  ${file}`);
}
await writeFile(join(outDir, 'SHA256SUMS.txt'), `${sums.join('\n')}\n`);

// 构建信息
await writeFile(
  join(outDir, 'BUILD-INFO.txt'),
  [
    `后台版本: ${appVersion}`,
    `插件版本: ${pluginVersion}`,
    `构建时间: ${new Date().toISOString()}`,
    `提交: ${process.env.GITHUB_SHA || 'local'}`,
    `运行: ${process.env.GITHUB_RUN_ID || 'local'}`,
    '',
    '本包为公开分发包，不含 data/、master.key 或任何密钥。',
  ].join('\n')
);

console.log('=== dist/release ===');
for (const file of (await readdir(outDir)).sort()) {
  const { size } = await import('node:fs').then((m) => m.statSync(join(outDir, file)));
  console.log(`${String(size).padStart(9)}  ${file}`);
}
