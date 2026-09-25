import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Storage } from '../src/storage.js';
import { Bridge } from '../src/bridge.js';
import { queryAqqbot, safePlayer } from '../src/aqqbot.js';
import { bindAqqbotPlayer, clearAqqbotPlayer, clearAllAqqbot, clearSelectedAqqbot, moveAqqbotPlayer, moveSelectedAqqbot, searchAqqbotAdmin } from '../src/aqqbot-admin.js';

function withStore(run) {
  const dir = mkdtempSync(join(tmpdir(), 'mcqq-aqqbot-'));
  return Promise.resolve().then(() => run(new Storage(dir), dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function mockAqqbot() {
  const owners = new Map([['011', '36000000'], ['Steve', '36000000'], ['other', '36000001']]);
  const calls = [];
  const rcon = async (_config, command) => {
    calls.push(command);
    if (command.startsWith('aqqbot whitelist query player ')) {
      const player = command.slice('aqqbot whitelist query player '.length);
      return '§a[SZYDBOT] 查询结果:\n§bQQ号: ' + (owners.get(player) ?? 'null') + '\n§d游戏名: ' + (owners.has(player) ? player : '');
    }
    if (command.startsWith('aqqbot whitelist query qq ')) {
      const qq = command.slice('aqqbot whitelist query qq '.length);
      return '§a[SZYDBOT] 查询结果:\n§bQQ号: ' + qq + '\n§d游戏名: ' + [...owners].filter(([, owner]) => owner === qq).map(([name]) => name).join(', ');
    }
    if (command.startsWith('aqqbot whitelist bind ')) {
      const [, , , qq, player] = command.split(' ');
      owners.set(player, qq);
      return '绑定成功';
    }
    if (command.startsWith('aqqbot whitelist unbind player ')) {
      const player = command.slice('aqqbot whitelist unbind player '.length);
      owners.delete(player);
      return '解绑成功';
    }
    throw new Error('意外命令：' + command);
  };
  return { owners, calls, rcon };
}

test('AQQBot 查询按原样保留纯数字玩家名及前导零', async () => {
  const mock = mockAqqbot();
  assert.deepEqual(await queryAqqbot({}, mock.rcon, 'qq', '36000000'), { qq: '36000000', players: ['011', 'Steve'] });
  assert.deepEqual(await queryAqqbot({}, mock.rcon, 'player', '011'), { qq: '36000000', players: ['011'] });
  assert.equal(safePlayer('011'), '011');
  assert.deepEqual(mock.calls, ['aqqbot whitelist query qq 36000000', 'aqqbot whitelist query player 011']);
});

test('查询输入限制为安全的单个名称，错误响应不会当成空记录', async () => {
  const calls = [];
  const rcon = async (_config, command) => { calls.push(command); return '未知命令'; };
  await assert.rejects(queryAqqbot({}, rcon, 'qq', '3600 0000'), /QQ 号格式/);
  await assert.rejects(queryAqqbot({}, rcon, 'player', 'x;op'), /玩家名格式/);
  assert.deepEqual(calls, []);
  await assert.rejects(queryAqqbot({}, rcon, 'player', '011'), /未返回可识别/);
});

test('命令查询、绑定、解绑及全部解绑都读取 AQQBot 实时结果，回复保持原格式', () => withStore(async store => {
  store.register('USER_OPENID_123', '36000000', 'GROUP_OPENID_123');
  const mock = mockAqqbot();
  const bridge = new Bridge(store, { rcon: mock.rcon });
  assert.match(await bridge.myMc('USER_OPENID_123', '/mymc'), /QQ 36000000 名下的 MC 玩家（2）：011、Steve/);
  assert.match(await bridge.bindPlayer('USER_OPENID_123', 'GROUP_OPENID_123', '/mcbind 7'), /已为玩家 7 发送 AQQBot 绑定命令/);
  assert.match(await bridge.unbindPlayer('USER_OPENID_123', 'GROUP_OPENID_123', '/mcunbind 011'), /已从当前 QQ 号解绑；其他玩家和 QQ 登记保持不变/);
  assert.match(await bridge.unbindAllPlayers('USER_OPENID_123', 'GROUP_OPENID_123', '/mcunallbind'), /已逐条解绑 2 个玩家：Steve、7/);
  assert.match(await bridge.myMc('USER_OPENID_123', '/mymc'), /名下暂无 MC 玩家/);
  assert.equal(store.state.bindings, undefined);
  assert.equal(mock.owners.has('other'), true);
  assert.ok(mock.calls.includes('aqqbot whitelist bind 36000000 7'));
  assert.ok(mock.calls.includes('aqqbot whitelist unbind player 011'));
}));

test('其他 QQ 的玩家不会被解绑，服务器未确认解绑时停止全部解绑', () => withStore(async store => {
  store.register('USER_OPENID_123', '36000000', 'GROUP_OPENID_123');
  const mock = mockAqqbot();
  const bridge = new Bridge(store, { rcon: mock.rcon });
  assert.match(await bridge.unbindPlayer('USER_OPENID_123', 'GROUP_OPENID_123', '/mcunbind other'), /不属于当前 QQ 号/);
  assert.equal(mock.calls.includes('aqqbot whitelist unbind player other'), false);
  const rejecting = async (config, command) => command === 'aqqbot whitelist unbind player 011' ? '解绑失败' : mock.rcon(config, command);
  const second = new Bridge(store, { rcon: rejecting });
  assert.match(await second.unbindAllPlayers('USER_OPENID_123', 'GROUP_OPENID_123', '/mcunallbind'), /已停止/);
  assert.deepEqual([...mock.owners].filter(([, qq]) => qq === '36000000').map(([name]) => name), ['011', 'Steve']);
}));

test('解除 QQ 登记前查询 AQQBot，名下有玩家时保留登记', () => withStore(async store => {
  store.register('USER_OPENID_123', '36000000', 'GROUP_OPENID_123');
  const mock = mockAqqbot();
  const bridge = new Bridge(store, { rcon: mock.rcon });
  assert.match(await bridge.unbindQq('USER_OPENID_123', '/qqunbind'), /请先用/);
  assert.ok(store.state.users.USER_OPENID_123);
  mock.owners.delete('011');
  mock.owners.delete('Steve');
  assert.match(await bridge.unbindQq('USER_OPENID_123', '/qqunbind'), /已解除登记/);
  assert.equal(store.state.users.USER_OPENID_123, undefined);
}));

test('8.0 清除旧绑定快照和导入占位用户，同时备份原文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcqq-migrate-'));
  try {
    const old = { users: {
      USER_OPENID_123: { qq: '36000000', group: 'GROUP_OPENID_123' },
      '36000001': { qq: '36000001', source: 'aqqbot-import' }
    }, bindings: { USER_OPENID_123: [{ player: '011' }], '36000001': [{ player: 'stale' }] }, audit: [] };
    writeFileSync(join(dir, 'state.json'), JSON.stringify(old));
    const store = new Storage(dir);
    assert.equal(store.state.version, 8);
    assert.equal(store.state.bindings, undefined);
    assert.equal(store.state.users['36000001'], undefined);
    assert.equal(store.state.users.USER_OPENID_123.qq, '36000000');
    const backups = readdirSync(dir).filter(name => name.startsWith('state.json.before-v8-'));
    assert.equal(backups.length, 1);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, backups[0]), 'utf8')), old);
    new Storage(dir);
    assert.equal(readdirSync(dir).filter(name => name.startsWith('state.json.before-v8-')).length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('管理员可按 QQ 清除单个纯数字玩家并核对 AQQBot，其他 QQ 不受影响', async () => {
  const mock = mockAqqbot();
  const result = await clearAqqbotPlayer({}, mock.rcon, '36000000', '011');
  assert.deepEqual(result, { qq: '36000000', removed: ['011'], remaining: ['Steve'] });
  assert.equal(mock.owners.has('011'), false);
  assert.equal(mock.owners.get('other'), '36000001');
  await assert.rejects(clearAqqbotPlayer({}, mock.rcon, '36000000', 'other'), /不属于 QQ/);
  assert.equal(mock.calls.includes('aqqbot whitelist unbind player other'), false);
});

test('管理员全清逐个解绑，遇到失败停止并报告已确认部分', async () => {
  const mock = mockAqqbot();
  const rejecting = async (config, command) => {
    if (command === 'aqqbot whitelist unbind player Steve') return '解绑失败';
    return mock.rcon(config, command);
  };
  await assert.rejects(clearAllAqqbot({}, rejecting, '36000000'), error => {
    assert.deepEqual(error.removed, ['011']);
    return /未明确确认/.test(error.message);
  });
  assert.equal(mock.owners.has('011'), false);
  assert.equal(mock.owners.get('Steve'), '36000000');
  assert.equal(mock.owners.get('other'), '36000001');
  const finished = await clearAllAqqbot({}, mock.rcon, '36000000');
  assert.deepEqual(finished, { qq: '36000000', removed: ['Steve'], remaining: [] });
  assert.equal(mock.owners.get('other'), '36000001');
});

test('无法识别的玩家列表不会作为 RCON 解绑命令执行', async () => {
  const calls = [];
  const rcon = async (_config, command) => {
    calls.push(command);
    return 'QQ号: 36000000\n游戏名: good, bad player';
  };
  await assert.rejects(clearAllAqqbot({}, rcon, '36000000'), /玩家名格式无效/);
  assert.deepEqual(calls, ['aqqbot whitelist query qq 36000000']);
});


test('独立绑定管理支持 QQ、OpenID、纯数字玩家查询及新增修改', () => withStore(async store => {
  store.register('USER_OPENID_123', '36000000', 'GROUP_OPENID_123');
  const mock = mockAqqbot();
  assert.deepEqual(await searchAqqbotAdmin(store, {}, mock.rcon, 'openid', 'USER_OPENID_123'), {
    qq: '36000000', openid: 'USER_OPENID_123', players: ['011', 'Steve'], source: 'openid'
  });
  assert.equal((await searchAqqbotAdmin(store, {}, mock.rcon, 'player', '011')).qq, '36000000');
  await bindAqqbotPlayer({}, mock.rcon, '36000000', '007');
  assert.equal(mock.owners.get('007'), '36000000');
  await moveAqqbotPlayer({}, mock.rcon, '36000000', '007', '36000002', '008');
  assert.equal(mock.owners.has('007'), false);
  assert.equal(mock.owners.get('008'), '36000002');
}));

test('批量改绑和批量解绑只处理勾选玩家并保留其他 QQ', async () => {
  const mock = mockAqqbot();
  const moved = await moveSelectedAqqbot({}, mock.rcon, '36000000', ['011', 'Steve'], '36000002');
  assert.deepEqual(moved.completed, ['011', 'Steve']);
  assert.equal(mock.owners.get('011'), '36000002');
  assert.equal(mock.owners.get('other'), '36000001');
  const cleared = await clearSelectedAqqbot({}, mock.rcon, '36000002', ['011', 'Steve']);
  assert.deepEqual(cleared.completed, ['011', 'Steve']);
  assert.equal(mock.owners.has('011'), false);
  assert.equal(mock.owners.get('other'), '36000001');
});
