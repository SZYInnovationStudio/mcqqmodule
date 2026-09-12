import { randomBytes } from 'node:crypto';
import { readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const MC_TO_QQ_TEMPLATE = '[服务器] ${player}: ${message}';
export const QQ_TO_MC_TEMPLATE = '&a[QQ群]&r ${userName}: ${message}';

export function replaceYamlField(source, path, value) {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/);
  const stack = [];
  let matches = 0;
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(/^( *)([A-Za-z_][A-Za-z0-9_-]*):(?:\s*(.*))?$/);
    if (!match) continue;
    const indent = match[1].length;
    while (stack.length && stack.at(-1).indent >= indent) stack.pop();
    stack.push({ indent, key: match[2] });
    if (stack.map(item => item.key).join('.') !== path.join('.')) continue;
    matches++;
    lines[index] = `${match[1]}${match[2]}: ${value}`;
  }
  if (matches !== 1) throw new Error(`AQQBot 文件中 ${path.join('.')} 应恰好出现一次，实际 ${matches} 次；未修改文件`);
  return lines.join(newline);
}

export function prepareRelayFiles(configText, messagesText, { mcToQqEnabled, qqToMcEnabled }) {
  let nextConfig = replaceYamlField(configText, ['chat', 'group_to_server', 'enable'], String(qqToMcEnabled === true));
  nextConfig = replaceYamlField(nextConfig, ['chat', 'server_to_group', 'enable'], String(mcToQqEnabled === true));
  let nextMessages = replaceYamlField(messagesText, ['qq', 'chat_from_game'], JSON.stringify(MC_TO_QQ_TEMPLATE));
  nextMessages = replaceYamlField(nextMessages, ['game', 'chat_from_qq'], JSON.stringify(QQ_TO_MC_TEMPLATE));
  return { configText: nextConfig, messagesText: nextMessages };
}

async function atomicReplace(path, content, mode) {
  const temp = `${path}.codex-tmp-${randomBytes(6).toString('hex')}`;
  try {
    await writeFile(temp, content, { flag: 'wx', mode });
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

export async function applyAqqbotRelay(config, rcon) {
  const configPath = config.aqqbotConfigPath;
  const messagesPath = config.aqqbotMessagesPath;
  if (!configPath || !messagesPath) throw new Error('请先填写服务器正在使用的 AQQBot config.yml 和 messages.yml 路径；下载副本无效');
  const [realConfig, realMessages] = await Promise.all([realpath(configPath), realpath(messagesPath)]);
  if (dirname(realConfig) !== dirname(realMessages)) throw new Error('两个 AQQBot 文件必须位于同一个插件目录');
  const [configInfo, messagesInfo, configText, messagesText] = await Promise.all([
    stat(realConfig), stat(realMessages), readFile(realConfig, 'utf8'), readFile(realMessages, 'utf8')
  ]);
  if (!configInfo.isFile() || !messagesInfo.isFile()) throw new Error('AQQBot 路径不是普通文件');
  const prepared = prepareRelayFiles(configText, messagesText, config);
  const files = [
    { path: realConfig, original: configText, next: prepared.configText, mode: configInfo.mode & 0o777 },
    { path: realMessages, original: messagesText, next: prepared.messagesText, mode: messagesInfo.mode & 0o777 }
  ].filter(file => file.original !== file.next);
  if (!files.length) return { changed: false, output: 'AQQBot 文件已与开关及模板一致' };
  const suffix = `${Date.now()}-${randomBytes(4).toString('hex')}`;
  for (const file of files) {
    file.backup = `${file.path}.backup-${suffix}`;
    await writeFile(file.backup, file.original, { flag: 'wx', mode: 0o600 });
  }
  const written = [];
  try {
    for (const file of files) {
      await atomicReplace(file.path, file.next, file.mode);
      written.push(file);
    }
    const output = await rcon(config, 'aqqbot reload');
    if (/(?:失败|错误|无效|不存在|unknown command|error|failed)/i.test(output)) throw new Error(`AQQBot 重载未成功：${output.slice(0, 300)}`);
    return { changed: true, output: output || '已发送 aqqbot reload；服务器未返回文字' };
  } catch (error) {
    for (const file of written.reverse()) await atomicReplace(file.path, file.original, file.mode).catch(() => {});
    if (written.length) await rcon(config, 'aqqbot reload').catch(() => {});
    throw new Error(`AQQBot 开关更新失败，已尝试恢复原文件：${error.message}`);
  }
}
