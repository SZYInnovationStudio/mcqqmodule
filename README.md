# MC × QQ 管理平台

本地运行的 MCSManager / OneBot v11 桥接服务。管理网页固定在 `127.0.0.1:2556`，不对公网开放。服务器配置和 QQ Bot 配置由管理网页填写；密钥加密存放在被 Git 忽略的 `data/` 目录。

## 运行

需要 Node.js 22 或更新版本。先设置足够强的管理员密码，再启动：

```powershell
$env:ADMIN_PASSWORD = '请换成你自己的长密码'
npm start
```

浏览器打开 `http://127.0.0.1:2556`，登录并填写 MCSManager URL、API Key、Daemon ID、实例 UUID、Minecraft 主机/端口，以及 OneBot v11 正向 WebSocket 地址、Token 和允许使用的 QQ 群号。请不要把管理网页、`data/`、密码或 API Key 暴露到公网。

QQ 命令计划：`/bind <玩家名>`、`/motd`、`/logs`。首次发送命令时自动登记消息事件中的 QQ 号。绑定码仅对应发起人的 QQ 号，5 分钟有效。绑定确认后通过 MCSManager 发送 `aqqbot whitelist bind <QQ号> <玩家名>`；面板回执只代表发送请求被接受，真实绑定结果要以服务器/AQQBot 输出为准。

MCSManager 官方资料：[API Key](https://docs.mcsmanager.com/apis/get_apikey.html)、[实例 API](https://docs.mcsmanager.com/zh_cn/apis/api_instance.html)。AQQBot 基于 [OneBot v11](https://github.com/alazeprt/AQQBot)。

## Git 约定

每个完成阶段都做 Git 提交。运行数据、密钥与日志不提交。
