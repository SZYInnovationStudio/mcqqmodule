# MC × QQ：本项目完整命令对照

本项目使用 QQ 官方 Bot。建议在目标 QQ 群里 **@机器人后**发送下面的命令；机器人只处理已填入后台“允许使用的群 OpenID”的群。QQ 平台的指令配置用于展示/方便输入，真正的执行逻辑以本项目收到的消息文本为准。指令名称必须与下表一致。

## QQ 官方 Bot 指令配置：只添加这 4 个

| 指令名（输入框自带 `/` 时不要再加） | 指令介绍建议填写 | 用户实际发送的格式 | 参数规则 |
| --- | --- | --- | --- |
| `register` | 登记自己的 QQ 号 | `/register <QQ号>` | 必填；5～20 位数字，例如 `/register 36000000` |
| `confirm` | 二次核对并确认 QQ 登记 | `/confirm BIND-XXXXXX` | 必填；机器人临时给的码，5 分钟内、同一用户同一群有效 |
| `bind` | 绑定 Minecraft 玩家 | `/bind <玩家名>` | 必填；3～16 位英文字母、数字或下划线，例如 `/bind implayer` |
| `motd` | 查询服务器介绍与在线人数 | `/motd` | 不带参数 |

实际群消息示例：

```text
@机器人 /register 36000000
@机器人 /confirm BIND-4A5EB8
@机器人 /bind implayer
@机器人 /motd
```

`BIND-4A5EB8` 只是示例，实际验证码每次随机生成；**不要**把 `BIND-XXXXXX` 注册成第五个固定指令。现在确认流程推荐明确使用 `/confirm`，而不是只发验证码。

首次发送 `/bind` 或 `/motd`、尚未登记时，机器人只会提示先发送 `/register <QQ号>`。用户登记 QQ 号并确认后，不必每次再填 QQ 号。登记码只确认用户重复核对了填写的数字，**不能证明该 QQ 号归属**，也不会执行 MC 绑定。`/logs`、`/chat` 已按要求取消，不要添加。

## 服务器 RCON 命令：不要添加到 QQ 指令配置

管理员在后台“RCON 终端”可发送 Minecraft 控制台命令，例如：

```text
list
aqqbot whitelist bind 36000000 implayer
```

`list` 用于测试 RCON 连接并查看在线玩家。`aqqbot whitelist bind <数字QQ号> <玩家名>` 是根据你提供的 AQQBot 指令格式实现的；当群友发送 `/bind implayer` 时，平台自动把登记的 QQ 号和玩家名填入，并通过 RCON 发送。**群友不需要、也不应该在 QQ 里输入这条 RCON 命令。** AQQBot 不同版本的实际执行结果，需以终端返回及服务器状态为准。

`/motd` 不调用 RCON，而是查询 Minecraft 服务器的游戏状态协议。RCON 终端仅管理员可用；它可以执行高权限服务器命令，切勿把后台暴露到公网。

## 配置顺序

1. 在 QQ 开放平台给机器人配置群消息能力及上表四个指令名；若页面自动显示 `/`，指令名只填文字部分。
2. 在本平台“修改信息”填写 QQ Bot AppID、AppSecret；让机器人在目标群收到一条 @消息，到总览操作记录找到“群 OpenID”，再填入允许群列表。
3. 填写并测试 RCON、Minecraft 游戏地址。用后台 RCON 终端发送 `list` 测试。
4. 在目标群按“登记 → 确认 → 绑定 / 查询”的顺序测试。

QQ 官方 SDK 的群消息与回复方式可参阅[腾讯官方 Node.js SDK 使用指南](https://github.com/tencent-connect/qqbot-nodejs/blob/main/USAGE.md)。
