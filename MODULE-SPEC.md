# 通用模块技术规范 v2

服务端 8.8.0 使用 `bridge-module-v2` 格式，推荐扩展名为 `.mcqqmodule`。旧版 `szydmc-module-v1` 与 `.szydmodule` 继续支持，已安装模块不需要重装。模块位于 `data/modules/<模块ID>`，同一 ID 上传更高版本时保留 `state.json`、启用状态和首次安装时间；加载失败会自动恢复旧版。

## 权限模型

服务端模块属于管理员信任的本地代码，使用完整宿主权限。v2 清单用 `"permissions": ["*"]` 表示完整权限。模块可通过 `api.host` 使用：

- `runRcon(command)`：执行任意 RCON 命令。
- `readConfig()`、`writeConfig(config)`：读取或更新完整连接配置。
- `listRegistrations()`、`createRegistration()`、`updateRegistration()`、`deleteRegistration()`：管理 QQ 与 OpenID 登记。
- `queryAqqbot()`、`bindPlayer()`、`unbindPlayer()`、`clearPlayers()`、`movePlayer()`：查询及管理 AQQBot 绑定。
- `readStatus()`、`readAqqbotDatabase()`、`readServerLogs()`：读取运行状态与只读数据。
- `notifyGroups(content)`：向已允许的 QQ 群发送消息。

模块的服务端代码与后台进程权限相同，因此只能安装来源明确、经过审核的包。完整权限不代表绕过后台登录：模块页面接口仍要求管理员登录，QQ群模块命令仍先经过允许群、OpenID、QQ 登记和命令白名单检查。

## 包格式

```json
{
  "format": "bridge-module-v2",
  "manifest": {
    "id": "example-module",
    "name": "示例模块",
    "version": "1.0.0",
    "description": "模块说明",
    "page": "index.html",
    "entry": "server/main.mjs",
    "commands": ["example"],
    "permissions": ["*"]
  },
  "files": [
    {
      "path": "public/index.html",
      "sha256": "文件原始字节的 SHA-256",
      "content": "文件原始字节的 Base64"
    },
    {
      "path": "server/main.mjs",
      "sha256": "……",
      "content": "……"
    }
  ]
}
```

`public/` 可放 HTML、CSS、JS、JSON、SVG、PNG、JPG 和 WEBP。`server/` 可放 JS、MJS 与 JSON，入口必须是 `server/` 下的 MJS 文件，因此模块可以拆分多个服务端源码文件。单包最多 500 个文件，解码后总计不超过 32 MiB，单文件不超过 1 MiB；每个文件都必须提供匹配的 SHA-256。

`commands` 最多声明 8 个英文或中文命令，不得占用内置命令或其他模块命令。`page` 是 `public/` 下的入口页面。页面地址为 `/modules/<模块ID>/`，接口地址为 `/api/modules/<模块ID>/...`。

## 服务端入口

入口导出 `handle` 函数：

```js
export async function handle(request, api) {
  if (request.method === 'POST' && request.path === 'run') {
    const output = await api.host.runRcon('list');
    return { status: 200, body: { output } };
  }
  return { status: 404, body: { error: '未找到' } };
}
```

后台请求包含 `method`、模块内相对 `path`、JSON `input`、查询参数 `query` 和管理员 `username`。QQ群命令请求使用 `method: 'COMMAND'`，并包含 `message`、`openid`、`group` 和 `qq`，返回 `{ reply: '回复文字' }`。

通用接口还包括 `serverVersion`、`moduleVersion`、`moduleFormat`、`permissions`、`enabled()`、`readState()`、`writeState()` 和 `audit()`。为兼容旧模块，`getRegistration()`、`queryPlayers()`、`playerOwner()`、`reward()` 与 `testRewardTemplate()` 继续保留。

## 构建每日签到模块

运行 `npm run build:checkin` 生成 `dist/daily-checkin-money-1.2.0.mcqqmodule`。它使用通用 v2 格式和完整权限声明，可从旧版 1.0.0 或 1.1.0 直接升级并保留签到记录与设置。`/qd add 玩家名` 会核对发送者登记 QQ 和 AQQBot 玩家归属，每个 QQ 每个北京时间自然日只成功领取一次。
