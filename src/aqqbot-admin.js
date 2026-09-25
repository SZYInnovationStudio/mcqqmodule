import { bindRejected, queryAqqbot, queryPlayerOwner, safePlayer, safeQq, unbindConfirmed } from './aqqbot.js';

export async function clearAqqbotPlayer(config, rcon, qqInput, playerInput) {
  const qq = safeQq(qqInput);
  const player = safePlayer(playerInput);
  const owner = await queryPlayerOwner(config, rcon, player);
  if (owner === null) throw new Error('玩家 ' + player + ' 已无绑定，请刷新查询结果');
  if (owner !== qq) throw new Error('玩家 ' + player + ' 当前不属于 QQ ' + qq + '，未发送解绑命令');
  const reply = String(await rcon(config, 'aqqbot whitelist unbind player ' + player) ?? '');
  if (!unbindConfirmed(reply)) throw new Error('AQQBot 未明确确认玩家 ' + player + ' 解绑，请刷新并核对服务器结果');
  const after = await queryPlayerOwner(config, rcon, player);
  if (after !== null) throw new Error('玩家 ' + player + ' 解绑后仍有绑定，请刷新并核对服务器结果');
  const remaining = (await queryAqqbot(config, rcon, 'qq', qq)).players;
  if (remaining.includes(player)) throw new Error('QQ 查询仍显示玩家 ' + player + '，请刷新并核对服务器结果');
  return { qq, removed: [player], remaining };
}

export async function clearAllAqqbot(config, rcon, qqInput) {
  const qq = safeQq(qqInput);
  const initial = (await queryAqqbot(config, rcon, 'qq', qq)).players;
  const players = [...new Set(initial.map(safePlayer))];
  const removed = [];
  for (const player of players) {
    try {
      await clearAqqbotPlayer(config, rcon, qq, player);
      removed.push(player);
    } catch (error) {
      error.removed = removed;
      throw error;
    }
  }
  const remaining = (await queryAqqbot(config, rcon, 'qq', qq)).players;
  if (remaining.length) {
    const error = new Error('QQ ' + qq + ' 仍有 ' + remaining.length + ' 个绑定，已停止；请刷新后继续处理');
    error.removed = removed;
    error.remaining = remaining;
    throw error;
  }
  return { qq, removed, remaining: [] };
}

export async function bindAqqbotPlayer(config, rcon, qqInput, playerInput) {
  const qq = safeQq(qqInput);
  const player = safePlayer(playerInput);
  const owner = await queryPlayerOwner(config, rcon, player);
  if (owner === qq) throw new Error('玩家 ' + player + ' 已绑定当前 QQ');
  if (owner !== null) throw new Error('玩家 ' + player + ' 已绑定其他 QQ，未发送绑定命令');
  const reply = String(await rcon(config, 'aqqbot whitelist bind ' + qq + ' ' + player) ?? '');
  if (bindRejected(reply)) throw new Error('AQQBot 拒绝绑定玩家 ' + player + '，请核对服务器');
  if (await queryPlayerOwner(config, rcon, player) !== qq) throw new Error('AQQBot 未确认玩家 ' + player + ' 绑定，请刷新核对');
  return { qq, player };
}

export async function moveAqqbotPlayer(config, rcon, oldQqInput, oldPlayerInput, newQqInput, newPlayerInput) {
  const oldQq = safeQq(oldQqInput);
  const oldPlayer = safePlayer(oldPlayerInput);
  const newQq = safeQq(newQqInput);
  const newPlayer = safePlayer(newPlayerInput);
  if (oldQq === newQq && oldPlayer === newPlayer) throw new Error('QQ 号和玩家名都未改变');
  if (await queryPlayerOwner(config, rcon, oldPlayer) !== oldQq) throw new Error('原玩家绑定已变化，未执行修改');
  if (newPlayer !== oldPlayer) {
    if (await queryPlayerOwner(config, rcon, newPlayer) !== null) throw new Error('新玩家名已有绑定，未执行修改');
    await bindAqqbotPlayer(config, rcon, newQq, newPlayer);
    try {
      await clearAqqbotPlayer(config, rcon, oldQq, oldPlayer);
    } catch (error) {
      throw new Error('新玩家 ' + newPlayer + ' 已绑定，但原玩家 ' + oldPlayer + ' 未确认解绑；请刷新并手动核对：' + error.message);
    }
  } else {
    await clearAqqbotPlayer(config, rcon, oldQq, oldPlayer);
    try {
      await bindAqqbotPlayer(config, rcon, newQq, newPlayer);
    } catch (error) {
      let restored = false;
      try {
        if (await queryPlayerOwner(config, rcon, oldPlayer) === null) {
          await bindAqqbotPlayer(config, rcon, oldQq, oldPlayer);
          restored = true;
        }
      } catch {}
      throw new Error('改绑 QQ ' + newQq + ' 未确认；' + (restored ? '已恢复原 QQ 绑定' : '未能确认原绑定已恢复，请立即查询核对') + '：' + error.message);
    }
  }
  return { oldQq, oldPlayer, newQq, newPlayer };
}

function selectedPlayers(players) {
  if (!Array.isArray(players) || !players.length || players.length > 100) throw new Error('请选择 1–100 个玩家');
  const names = players.map(safePlayer);
  if (new Set(names).size !== names.length) throw new Error('选择中有重复玩家');
  return names;
}

export async function clearSelectedAqqbot(config, rcon, qqInput, selected) {
  const qq = safeQq(qqInput);
  const players = selectedPlayers(selected);
  for (const player of players) {
    if (await queryPlayerOwner(config, rcon, player) !== qq) throw new Error('玩家 ' + player + ' 归属已变化，未开始批量解绑');
  }
  const completed = [];
  for (const player of players) {
    try {
      await clearAqqbotPlayer(config, rcon, qq, player);
      completed.push(player);
    } catch (error) {
      error.completed = completed;
      throw error;
    }
  }
  return { qq, completed };
}

export async function moveSelectedAqqbot(config, rcon, oldQqInput, selected, newQqInput) {
  const oldQq = safeQq(oldQqInput);
  const newQq = safeQq(newQqInput);
  if (newQq === oldQq) throw new Error('目标 QQ 与原 QQ 相同');
  const players = selectedPlayers(selected);
  for (const player of players) {
    if (await queryPlayerOwner(config, rcon, player) !== oldQq) throw new Error('玩家 ' + player + ' 归属已变化，未开始批量改绑');
  }
  const completed = [];
  for (const player of players) {
    try {
      await moveAqqbotPlayer(config, rcon, oldQq, player, newQq, player);
      completed.push(player);
    } catch (error) {
      error.completed = completed;
      throw error;
    }
  }
  return { oldQq, newQq, completed };
}

export async function searchAqqbotAdmin(store, config, rcon, type, value) {
  let qq;
  let openid = null;
  if (type === 'openid') {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{5,128}$/.test(value)) throw new Error('OpenID 格式无效');
    const registration = Object.hasOwn(store.state.users, value) ? store.state.users[value] : null;
    if (!registration?.qq) return { qq: null, openid: value, players: [], source: 'openid' };
    qq = safeQq(registration.qq);
    openid = value;
  } else if (type === 'player') {
    const result = await queryAqqbot(config, rcon, 'player', value);
    if (!result.qq) return { qq: null, openid: null, players: [], source: 'player' };
    qq = result.qq;
  } else if (type === 'qq') {
    qq = safeQq(value);
  } else throw new Error('查询类型无效');
  const result = await queryAqqbot(config, rcon, 'qq', qq);
  return { qq, openid: openid ?? store.qqOwner(qq), players: result.players, source: type };
}
