import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';

const root = new URL('..', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), 'utf8');

const workflow = read('.github/workflows/release.yml');
const assembler = read('scripts/assemble-release.mjs');
const pkg = JSON.parse(read('package.json'));

test('发版工作流由 package.json 版本号决定 tag', () => {
  assert.match(workflow, /name: Build and Publish Release/);
  assert.match(workflow, /tag_name:/);
  // 版本号只能来自 package.json，工作流不得自行改写仓库
  assert.doesNotMatch(workflow, /git commit|git push/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /npm run build:checkin/);
  assert.match(workflow, /mvn -B -U/);
  assert.match(workflow, /node scripts\/assemble-release\.mjs/);
});

test('发版工作流有写入 Release 的权限且不并发覆盖', () => {
  assert.match(workflow, /permissions:\s*\n\s*contents: write/);
  assert.match(workflow, /cancel-in-progress: false/);
});

test('Release 正文由脚本完整重写，不追加自动变更说明', () => {
  // generate_release_notes 会在同名 Release 上追加，重复推送会叠出多份 Full Changelog
  assert.match(workflow, /generate_release_notes:\s*false/);
  assert.match(workflow, /body_path:\s*dist\/RELEASE-NOTES\.md/);
  assert.match(workflow, /node scripts\/release-notes\.mjs/);
  // 正文脚本必须给出每个附件的下载直链
  const notes = read('scripts/release-notes.mjs');
  assert.match(notes, /releases\/download\//);
});

test('Release 正文不改写 dist/release 之外的内容，避免被当成附件', () => {
  const notes = read('scripts/release-notes.mjs');
  // 输出必须落在 dist/ 根目录，而不是 dist/release/
  assert.match(notes, /join\(root, 'dist', 'RELEASE-NOTES\.md'\)/);
  assert.doesNotMatch(notes, /join\(releaseDir, 'RELEASE-NOTES\.md'\)/);
});

test('打包脚本从不把 data、密钥、依赖和日志放进公开包', () => {
  // 排除规则必须覆盖这些
  for (const pattern of ['data', 'node_modules', 'master\\.key', '\\.env', 'target', '\\.log']) {
    assert.match(assembler, new RegExp(pattern));
  }
  // 允许清单里绝不能出现 data
  const includedBlock = assembler.match(/const INCLUDED = \[([\s\S]*?)\];/)[1];
  assert.doesNotMatch(includedBlock, /'data'/);
  assert.doesNotMatch(includedBlock, /master\.key/);
});

test('打包脚本使用内置能力写 ZIP，不新增运行时依赖', () => {
  assert.match(assembler, /deflateRawSync/);
  assert.doesNotMatch(assembler, /from 'jszip'|from 'adm-zip'|from 'archiver'/);
  // 运行时依赖保持精简
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['@tencent-connect/qqbot-nodejs', 'ws']);
});

test('插件 JAR 若存在，则以 plugins/ 前缀打包而不是 target/ 原路径', () => {
  assert.match(assembler, /name: `plugins\/szydmc-chat-bridge-\$\{pluginVersion\}\.jar`/);
  assert.doesNotMatch(assembler, /files\.push\(pluginJar\.rel\)/);
});

test('插件版本号与 pom.xml 一致，公开目录里的 JAR 命名同步', () => {
  const pom = read('minecraft-plugin/pom.xml');
  const pluginVersion = pom.match(/<version>([^<]+)<\/version>/)[1];
  assert.match(pluginVersion, /^\d+\.\d+\.\d+$/);
  // public/new 下应有同版本 JAR，README 的下载表才不会指空
  const newDir = new URL('public/new/', root);
  if (existsSync(newDir)) {
    const jars = readdirSync(newDir).filter((f) => f.endsWith('.jar'));
    assert.ok(
      jars.includes(`szydmc-chat-bridge-${pluginVersion}.jar`),
      `public/new/ 缺少 ${pluginVersion} 的 JAR：${jars.join(', ')}`
    );
  }
});
