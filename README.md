# MC × QQ 管理平台

本地运行的 MCSManager / QQ 官方 Bot 桥接服务。管理网页固定在 `127.0.0.1:2556`，不对公网开放。服务器配置和 QQ Bot 配置由管理网页填写；密钥加密存放在被 Git 忽略的 `data/` 目录。

## 运行

需要 Node.js 22 或更新版本。在项目目录启动：

```powershell
npm start
```

浏览器打开 `http://127.0.0.1:2556`。首次使用时自行设置管理员用户名和密码：密码至少 6 位，只能使用字母和数字，且必须同时包含字母和数字；之后用该账户登录。登录后可在「修改用户名或密码」中更改，修改后需要重新登录。账户以加盐 scrypt 哈希保存在 Git 忽略的 `data/admin.json`，不再需要启动环境变量中的密码。

随后填写 RCON 主机、端口和密码；MCSManager URL、API Key、Daemon ID、实例 UUID；Minecraft 主机/游戏端口；QQ 官方 Bot 的 AppID、AppSecret 和允许使用的群 OpenID。请不要把管理网页、`data/`、密码或 API Key 暴露到公网。RCON 需在 MC 服务端启用，并设置强密码。

页面分为四个入口：`/` 总览；`/settings` 修改连接信息和管理员账户；`/users` 已登记及已绑定用户列表，可修改、删除本平台记录；`/guide` 使用教程。既有 MC/RCON/MCSManager 信息继续保留。旧 OneBot 配置不再使用，新 Bot 凭证需重新填写。

MC 服务端的 `server.properties` 需要配置 `enable-rcon=true`、`rcon.port` 和 `rcon.password`，重启服务器后才会生效。RCON 端口尽量只允许本平台所在主机访问；远程连接建议使用专用内网或隧道，不要把明文 RCON 暴露到公网。面板 URL 建议使用 HTTPS。

QQ 群内命令：`/register <QQ号>`、`/bind <玩家名>`、`/motd`、`/logs`。用户先在群里 @机器人发送 `/register 36000000`（换成自己的数字 QQ 号），机器人回显号码并给出 `BIND-XXXXXX`。同一 OpenID 的用户在同群 5 分钟内回复该码后自动登记，不需管理员审核。**这只二次确认填写的号码，不能证明号码归属，也不会执行玩家绑定。**登记后再发 `/bind <自己填写的玩家名>`，此时才通过 RCON 执行 `aqqbot whitelist bind <登记QQ号> <玩家名>`。RCON 输出会显示在回复中，但真实绑定结果仍以 AQQBot/服务器状态为准。`/logs` 读取 MCSManager 的控制台输出缓冲区，仅能查询缓冲区内有时间戳的玩家聊天消息，最多显示最近 20 条。

QQ 官方 Bot 通过腾讯 SDK 的 WebSocket Gateway 连接。若不知道群 OpenID，先保存 AppID/AppSecret，在群里 @机器人发消息，然后到总览“操作记录”查看发现的群 OpenID。若现有 AQQBot 也会响应同一群内的 `/bind`，需避免两个机器人功能同时处理该指令。管理后台只绑定本机地址；确认码在服务重启后失效。管理员在 `/users` 修改或删除用户，仅影响本平台记录，**不会自动修改或解除服务器 AQQBot 绑定**。没有真实连接信息时，自动测试只验证模拟协议交互，不代表已连通你的 MC 服务器或 QQ Bot。

MCSManager 官方资料：[API Key](https://docs.mcsmanager.com/apis/get_apikey.html)、[实例 API](https://docs.mcsmanager.com/zh_cn/apis/api_instance.html)。QQ Bot 接入使用[腾讯官方 Node.js SDK](https://github.com/tencent-connect/qqbot-nodejs)。

## Git 约定

每个完成阶段都做 Git 提交。运行数据、密钥与日志不提交。
