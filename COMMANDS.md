# MC × QQ 命令清单

QQ 群内建议先 @机器人。机器人只处理后台「允许使用的群 OpenID」里的消息。QQ 官方 Bot 指令配置中只添加下列六个名字；若平台输入框自带 `/`，只填名字本身。

| 指令名 | 群友发送格式 | 作用 | 服务器 RCON 对应命令 |
| --- | --- | --- | --- |
| `qqbind` | `/qqbind <数字QQ号>` | 将消息发送者 OpenID 与自填 QQ 号一对一登记；未登记者也可使用 | 无 |
| `qqunbind` | `/qqunbind` | 名下没有 MC 玩家时解除 QQ 登记 | 无 |
| `mcbind` | `/mcbind <玩家名>` | 把一个 MC 玩家加入自己名下；可绑定多个 | `aqqbot whitelist bind <qq> <player>` |
| `mcunbind` | `/mcunbind <玩家名>` | 只解绑自己名下的指定玩家 | `aqqbot whitelist unbind name <player>` |
| `mcunallbind` | `/mcunallbind` | 逐条解绑自己名下的全部 MC 玩家；任一步未确认则停止 | 对每个玩家逐条发送 `aqqbot whitelist unbind name <player>` |
| `motd` | `/motd` | 查询服务器介绍、版本、在线人数及服务器公开的玩家名单 | 无，使用 Minecraft 状态协议 |

例子：

```text
@机器人 /qqbind 36000000
@机器人 BIND-4A5EB8
@机器人 /mcbind implayer
@机器人 /mcbind secondplayer
@机器人 /motd
@机器人 /mcunbind implayer
@机器人 /mcunallbind
@机器人 /qqunbind
```

`BIND-4A5EB8` 仅为随机确认码示例，五分钟内须由同一 OpenID 在同一群发送，不需要注册为 QQ 指令。二次核对只确认用户自己填写的数字，**不能证明数字 QQ 号的归属**，也不会绑定 MC 玩家。

执行顺序：先确认允许群和发送者 OpenID；`/qqbind` 和本人确认码直接进入登记流程；其他五个业务命令先检查 OpenID 是否已有唯一 QQ 登记。未登记时只回复 `/qqbind <QQ号>`，不执行 RCON 或 MOTD；完成登记后用户重新发送原命令。一个 OpenID 只对应一个 QQ 号，一个 QQ 号也只对应一个 OpenID，但可对应多个 MC 玩家；同一个 MC 玩家不能归属两个 QQ。`/qqunbind` 前需先解绑名下全部 MC 玩家。

`<qq>` 由平台填入已登记的数字 QQ 号，`<player>` 由平台填入用户提供的玩家名；尖括号只是格式占位符，实际发送时不包含。QQ 用户触发游戏绑定/解绑时，RCON 只发送表中的 `aqqbot whitelist bind` 与 `aqqbot whitelist unbind name` 两种命令，不修改 MC 服务器配置。按玩家解绑的格式来自 [AQQBot 源码](https://github.com/alazeprt/AQQBot/blob/refactor/common/src/main/kotlin/top/alazeprt/aqqbot/command/sub/SubUnbind.kt)。插件版本和 RCON 响应需在真实服务器核对：解绑只有在服务器明确回复成功时才从本地记录删除，未确认时停下并保留记录。绑定发送后记录为「待服务器确认」。

管理员网页的 `/terminal` 是独立的手动 RCON 控制台，登录后可输入 `list` 等服务器命令；群友不能使用。旧版 QQ 指令不再使用，也不需要配置。
