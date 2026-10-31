import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';

const root = new URL('..', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), 'utf8');
const exists = (rel) => existsSync(new URL(rel, root));

/**
 * 公开分发包里不含 .github/，所以工作流相关的检查只在 Git 仓库内执行。
 * 这样用户在解压后的包里跑 npm test 也能全绿，而不是被一个必然的 ENOENT 吓到。
 */
const inRepo = exists('.github/workflows/release.yml');
const workflow = inRepo ? read('.github/workflows/release.yml') : '';
const assembler = read('scripts/assemble-release.mjs');
const pkg = JSON.parse(read('package.json'));
const maybe = inRepo ? test : test.skip;

test('发版工作流由 package.json 版本号决定 tag', maybe, () => {
  assert.match(workflow, /name: Build and Publish Release/);
  assert.match(workflow, /tag_name:/);
  // 版本号只能来自 package.json，工作流不得自行改写仓库
  assert.doesNotMatch(workflow, /git commit|git push/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /npm run build:checkin/);
  assert.match(workflow, /mvn -B -U/);
  assert.match(workflow, /node scripts\/assemble-release\.mjs/);
});

test('发版工作流有写入 Release 的权限且不并发覆盖', maybe, () => {
  assert.match(workflow, /permissions:\s*\n\s*contents: write/);
  assert.match(workflow, /cancel-in-progress: false/);
});

test('Release 正文由脚本完整重写，不追加自动变更说明', maybe, () => {
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

test('设置页里每个 data-test 按钮都指向真实存在的测试接口', () => {
  // 通用逻辑是 api(`test/${button.dataset.test}`)，指向不存在的接口就会静默失败
  const html = read('public/settings.html');
  const js = read('public/settings.js');
  const serverSource = read('src/server.js');

  const buttons = [...html.matchAll(/data-test="([a-zA-Z0-9_-]+)"/g)].map((m) => m[1]);
  // 页面确实用了通用 data-test 逻辑
  const usesGeneric = /api\(`test\/\$\{button\.dataset\.test\}`/.test(js);
  if (usesGeneric) {
    for (const name of buttons) {
      assert.match(
        serverSource,
        new RegExp(`path === '/api/test/${name}'`),
        `设置页的 data-test="${name}" 在 server.js 里没有对应接口`
      );
    }
  }
});

test('OneBot 状态按钮使用独立 id，不冒充通用测试按钮', () => {
  const html = read('public/settings.html');
  const js = read('public/settings.js');
  // 状态查询走 /api/status，不是 /api/test/onebot
  assert.match(html, /id="onebot-status-button"/);
  assert.match(js, /\$\('onebot-status-button'\)/);
  assert.doesNotMatch(html, /data-test="onebot"/, 'data-test="onebot" 会去请求不存在的 /api/test/onebot');
});

test('模块中心显示的宿主版本取自 package.json，不写死', async () => {
  // 之前 module-manager.js 里写死 SERVER_VERSION = '8.8.2'，
  // 升到 8.9.x 后模块中心还显示旧版本，属于典型的发版遗漏。
  const mm = read('src/module-manager.js');
  assert.doesNotMatch(
    mm,
    /SERVER_VERSION\s*=\s*['"]\d+\.\d+\.\d+['"]/,
    'SERVER_VERSION 不能写死版本号，应从 package.json 读取'
  );
  assert.match(mm, /package\.json/, 'SERVER_VERSION 应读取 package.json');
});

test('源码与页面里不得残留硬编码的当前版本号', () => {
  const files = ['src/module-manager.js', 'src/bridge.js', 'src/server.js', 'public/modules.html', 'public/templates.html'];
  const version = pkg.version;
  for (const file of files) {
    const content = read(file);
    // 允许出现「历史升级说明」里的小版本，但不允许出现和当前版本相同的裸字符串
    const hardcoded = new RegExp(`['"]${version.replace(/\./g, '\\.')}['"]`);
    assert.doesNotMatch(
      content,
      hardcoded,
      `${file} 里写死了当前版本号 ${version}，发版时容易漏改`
    );
  }
});

test('模块中心页面版本徽标由脚本动态填充', () => {
  const html = read('public/modules.html');
  const js = read('public/modules.js');
  assert.match(html, /id="host-badge"/, '标题栏版本徽标应有可被脚本填充的 id');
  assert.doesNotMatch(html, /eyebrow">\d+\.\d+\.\d+ ·/, '页面里不应写死版本号');
  assert.match(js, /host-badge/);
});
