import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../minecraft-plugin/src/main/java/dev/szydmc/chatbridge/ChatBridgePlugin.java', import.meta.url), 'utf8');

test('插件保留日志上传且不接收或执行后台控制台命令', () => {
  assert.match(source, /request\.add\("serverLogs", logs\)/);
  assert.match(source, /request\.addProperty\("pluginVersion", getDescription\(\)\.getVersion\(\)\)/);
  assert.doesNotMatch(source, /commandResults|scheduleConsoleCommand|createCommandSender|dispatchCommand/);
});

test('插件仅使用 Bukkit 公共聊天与消息接口', () => {
  assert.match(source, /AsyncPlayerChatEvent/);
  assert.match(source, /player\.sendMessage\(text\)/);
  assert.doesNotMatch(source, /io\.papermc|net\.kyori|AsyncChatEvent/);
});
