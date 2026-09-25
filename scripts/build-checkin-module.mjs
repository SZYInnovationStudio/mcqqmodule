import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = new URL('../modules/daily-checkin-money/', import.meta.url);
const paths = [
  ['server.mjs', 'server/main.mjs'],
  ['public/index.html', 'public/index.html'],
  ['public/app.js', 'public/app.js'],
  ['public/style.css', 'public/style.css']
];
const files = await Promise.all(paths.map(async ([source, path]) => {
  const data = await readFile(new URL(source, root));
  return { path, sha256: createHash('sha256').update(data).digest('hex'), content: data.toString('base64') };
}));
const bundle = {
  format: 'bridge-module-v2',
  manifest: {
    id: 'daily-checkin-money', name: '每日签到', version: '1.2.0',
    description: 'QQ /qd 与 /签到，按 AQQBot 玩家绑定每日发放经济奖励',
    page: 'index.html', entry: 'server/main.mjs', commands: ['qd', '签到'], permissions: ['*']
  }, files
};
await mkdir('dist', { recursive: true });
const path = join('dist', 'daily-checkin-money-1.2.0.mcqqmodule');
await writeFile(path, JSON.stringify(bundle, null, 2));
console.log(`MODULE_BUNDLE=${path}`);
