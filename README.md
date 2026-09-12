# MC × QQ 管理平台

本地运行的 Minecraft RCON / QQ 官方 Bot 桥接服务。管理网页固定在 `127.0.0.1:2556`，不对公网开放。服务器配置和 QQ Bot 配置由管理网页填写；密钥加密存放在被 Git 忽略的 `data/` 目录。

要上传到远程 Linux 服务器长期运行，请从 [DEPLOY.md](DEPLOY.md) 开始。完整私有迁移包包含本机 `data/` 和密钥，只能私密保存、传输；不要公开分享。

## 运行

需要 Node.js 22 或更新版本。在项目目录启动：

```powershell
npm start
```

浏览器打开 `http://127.0.0.1:2556`。首次使用时自行设置管理员用户名和密码：密码至少 6 位，只能使用字母和数字，且必须同时包含字母和数字；之后用该账户登录。登录后可在「修改用户名或密码」中更改，修改后需要重新登录。账户以加盐 scrypt 哈希保存在 Git 忽略的 `data/admin.json`，不再需要启动环境变量中的密码。

随后填写 RCON 主机、端口和密码；Minecraft 主机/游戏端口；QQ 官方 Bot 的 AppID、AppSecret 和允许使用的群 OpenID。聊天互通有两个独立开关：QQ → MC 使用官方 Bot 接收允许群的普通消息，再通过 RCON 发送固定 `tellraw @a`；MC → QQ 每两秒读取一次 MCSManager 实例控制台输出，只把新出现的玩家聊天推送到允许群。后者需要填写面板地址、API Key、Daemon ID 和 Instance UUID，并先用“测试 MC 控制台”确认输出里确实有玩家聊天。首次连接只建立基线，不重发已有消息；若输出截断导致无法衔接，就跳过该轮，避免重复发送。QQ 官方 Bot 的主动群消息有平台额度限制。两个显示模板可在网页修改，默认 QQ → MC 为 `&a[QQ群]&r ${userName}: ${message}`，MC → QQ 为 `[服务器] ${player}: ${message}`。

本平台不会修改 AQQBot 的 `config.yml`、`messages.yml`，也不会修改服务器配置。若服务器里的 AQQBot 已自行转发聊天，服主需自行关闭相应方向，否则可能收到重复消息。无需读取 `logs/latest.log`，但 MC → QQ 能否工作取决于 MCSManager 的实时控制台是否包含玩家聊天。API Key 只在后台使用并加密保存，不回传网页。请不要把管理网页、`data/`、密码或 AppSecret 暴露到公网。RCON 需在 MC 服务端启用，并设置强密码。

页面分为六个入口：`/` 总览；`/settings` 修改连接信息和管理员账户；`/terminal` 仅管理员使用的 RCON 远程终端，可查看最近 100 条管理员命令日志；`/player-logs` 玩家命令日志，可按 QQ 登记、MC 绑定、MC 解绑、服务器查询分类筛选；`/users` 已登记及已绑定用户列表，可修改、删除本平台记录；`/guide` 使用教程。两种日志分别加密保存在 Git 忽略的 `data/rcon-log.enc` 与 `data/player-log.enc`，仅登录管理员可通过网页读取。玩家日志保留最近 200 条被机器人处理的命令，不包括普通聊天，并遮盖临时确认码。可直接照着 [COMMANDS.md](COMMANDS.md) 配置 QQ 侧的七个指令。本平台的 QQ 接入使用官方 Bot，不使用 OneBot；服务器里的 AQQBot 仅用于现有白名单绑定指令。

MC 服务端的 `server.properties` 需要配置 `enable-rcon=true`、`rcon.port` 和 `rcon.password`，重启服务器后才会生效。RCON 端口尽量只允许本平台所在主机访问；远程连接建议使用专用内网或隧道，不要把明文 RCON 暴露到公网。

QQ 群内命令：`/qqbind <QQ号>`、`/qqunbind`、`/mcbind <玩家名>`、`/mcunbind <玩家名>`、`/mcunallbind`、`/motd`。用户先在群里 @机器人发送 `/qqbind 36000000`，机器人回显号码并给出临时登记码。同一 OpenID 的用户在同群 5 分钟内直接发送登记码后自动登记，不需管理员审核。**这只二次确认填写的号码，不能证明号码归属，也不会执行玩家绑定。**登记后再发 `/mcbind <玩家名>`，此时才通过 RCON 执行 `aqqbot whitelist bind <qq> <player>`，其中占位符分别代表已登记的 QQ 号和玩家名。`/mcunbind` 与 `/mcunallbind` 仅按玩家逐条发送 `aqqbot whitelist unbind name <player>`；不会修改 MC 服务器配置。所有业务命令先要求登记 QQ，`/qqbind` 本身例外。按用户要求，不提供聊天日志查询。

QQ 官方 Bot 通过腾讯 SDK 的 WebSocket Gateway 连接。若不知道群 OpenID，先保存 AppID/AppSecret，在群里 @机器人发消息，然后到总览“操作记录”查看发现的群 OpenID。管理后台只绑定本机地址；确认码在服务重启后失效。管理员在 `/users` 修改或删除用户，仅影响本平台记录，**不会自动修改或解除服务器 AQQBot 绑定**。没有真实连接信息时，自动测试只验证模拟协议交互，不代表已连通你的 MC 服务器或 QQ Bot。

QQ Bot 接入使用[腾讯官方 Node.js SDK](https://github.com/tencent-connect/qqbot-nodejs)。

## Git 约定

每个完成阶段都做 Git 提交。运行数据、密钥与日志不提交。
