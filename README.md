# MC × QQ 管理平台

基于 QQ 官方 Bot、Minecraft RCON 和独立 Bukkit 插件的管理平台。当前服务端版本为 **8.9.9**，聊天插件版本为 **1.1.4**。

插件只调用 Bukkit 公共 API，适用于 CraftBukkit、Spigot、Paper、Purpur、Leaves，以及其他完整实现 Bukkit API 的衍生服务端。新版以 Spigot 1.13.2 API 编译，`api-version` 为 `1.13`，字节码目标为 Java 8，可覆盖 Minecraft 1.13 至 1.21.11 的 Bukkit 系服务端；实际 Java 版本仍以所用服务端的要求为准。Fabric、Forge、NeoForge 本身不实现 Bukkit API，不在兼容范围内。

## 双 Bot 方案（8.9.0 新增）

官方 Bot 只能拿到 OpenID，看不到真实 QQ 号，也拿不到完整群名称。8.9.0 支持再接一个 **OneBot v11 监听 Bot**（NapCat / Lagrange / LLOneBot 等外挂框架登录的小号）来补齐这些信息。

**核心原则：监听 Bot 只收不发。** 外挂号只当“耳朵”，群里的所有发言一律由官方 Bot 发出，避免封号风险，也让“谁在说话”始终清晰。

| 能力 | 官方 Bot | 监听 Bot（OneBot） |
| --- | --- | --- |
| 群消息发送、命令回复 | ✅ 负责 | ❌ 绝不发言 |
| 真实 QQ 号 | ❌ 只有 OpenID | ✅ 可见 |
| 群名称、群名片 | ❌ 需手工映射 | ✅ 自动获取 |
| 入群 / 退群事件 | ❌ | ✅ |
| 接收 @ 消息 | ✅ | ✅ |

开启监听 Bot 后，平台用「内容 + 发送者 + 时间窗」把官方 Bot 的 OpenID 与真实 QQ 号对应起来，`/qqbind` 手填和二次确认可以完全跳过；两个 Bot 同时收到的同一条消息会去重，不会在 MC 里刷两遍。

**关闭监听 Bot 时，平台完全退回旧版行为**：不学习、不去重、群名只认手工配置、登记回到 `/qqbind` + 确认码流程。这条回退路径有专门的测试守着。

接入方式二选一：

- **反向（推荐）**：在外挂框架里填上报地址 `ws://127.0.0.1:2556/api/onebot/ws`，并设置 Access Token。
- **正向**：在后台填外挂框架的 `ws://` 地址，由平台主动连过去。

启用前必须设置至少 8 位的 Access Token，否则任何人都能接入。未启用时该 WebSocket 入口直接拒绝连接。


## 主要功能

- QQ 与 Minecraft 双向聊天、玩家进服和退服通知、服务器开启和关闭通知。
- 可选的双 Bot 方案：OneBot 监听 Bot 只收不发，补齐真实 QQ 号与群名称。
- AQQBot 绑定查询、QQ/OpenID 登记、玩家绑定管理和只读整库查看。
- `/status`、`/motd`、`/list`、`/tps`、绑定、解绑和每日签到等中英文命令。
- 管理后台提供连接设置、消息模板、服务器日志、RCON 终端和模块管理。
- 群命令使用固定白名单，普通群消息不能作为 RCON 或 Minecraft 控制台命令执行。
- 支持通用 `.mcqqmodule` 增量模块及旧模块格式。

命令说明见 [COMMANDS.md](COMMANDS.md)，模块制作说明见 [MODULE-SPEC.md](MODULE-SPEC.md)。

## 运行要求

- Node.js 22 或更高版本。
- Minecraft 1.13 至 1.21.11 的 Bukkit API 兼容服务端；Java 版本按该服务端要求安装。
- Minecraft 已开启 RCON。
- QQ 官方 Bot 的 AppID、AppSecret 和允许群 OpenID。
- 使用绑定功能时，Minecraft 服务端需安装并配置 AQQBot。
- 或者，发给ai他会做的，，，。。额，记得让ai让你审核。。不然炸了不管（）


## 插件 JAR 与历史构建

所有正式插件产物统一放在 `public/` 下，并按新版、历史版分类：

| 分类 | 插件版本 | 兼容说明 | 下载 |
| --- | --- | --- | --- |
| 新版 | 1.1.4 | Bukkit 通用版；CraftBukkit、Spigot、Paper、Purpur、Leaves 等 | [`public/new/szydmc-chat-bridge-1.1.4.jar`](public/new/szydmc-chat-bridge-1.1.4.jar) |
| 历史版 | 1.1.3 | 原 Paper 1.21.11 专用构建 | [`public/old/szydmc-chat-bridge-1.1.3.jar`](public/old/szydmc-chat-bridge-1.1.3.jar) |
| 历史版 | 1.0.0 | Git 历史中的最早 Paper 1.21.11 构建 | [`public/old/szydmc-chat-bridge-1.0.0.jar`](public/old/szydmc-chat-bridge-1.0.0.jar) |

正常安装请选择 `public/new/` 中版本号最高的 JAR。`public/old/` 只用于回退；Git 历史中没有可独立还原的 1.1.1 和 1.1.2 源码，因此没有伪造这两个版本的构建。`minecraft-plugin/target/` 是本地编译临时目录，不作为下载位置。

## 安装管理平台

1. 下载或克隆仓库，进入项目根目录。
2. 安装依赖并启动：

   ```bash
   npm install
   npm start
   ```

3. 浏览器打开 `http://127.0.0.1:2556`，首次进入时创建管理员账号。
4. 在“修改信息”中填写 Minecraft 地址、RCON、QQ Bot AppID/AppSecret、允许群 OpenID。
5. 在“独立聊天插件”中生成至少 32 位的插件 Key，保存后台设置。
6. 按下一节安装 JAR，并把同一个 Key 写入插件配置。
7. 后台测试插件、RCON 和 QQ Bot 连接，随后开启需要的转发与通知开关。

Linux 长期运行和反向代理配置见 [DEPLOY.md](DEPLOY.md)。运行产生的管理员、密钥、登记和日志数据保存在 `data/`，该目录已从 Git 排除，不要公开上传。

## 安装 Minecraft 插件

1. 关闭 Minecraft 服务器。
2. 下载 [`public/new/szydmc-chat-bridge-1.1.4.jar`](public/new/szydmc-chat-bridge-1.1.4.jar)，放入服务端 `plugins/`。
3. 启动一次服务器，让插件生成 `plugins/SZYDMCChatBridge/config.yml`，然后关闭服务器。
4. 编辑配置：

   ```yaml
   bridge-url: 'http://127.0.0.1:2556/api/plugin/exchange'
   key: '后台生成的插件Key'
   aqqbot-data-path: '../AQQBot/data.yml'
   server-log-path: '../../logs/latest.log'
   ```

5. `key` 必须与后台保存的插件 Key 完全一致。平台与 Minecraft 不在同一台机器时，将 `bridge-url` 改为经过 HTTPS 反向代理或安全隧道公开的地址。
6. 重新启动 Minecraft，在后台点击“测试插件连接”；连接成功后再开启 QQ → MC、MC → QQ、日志同步和生命周期通知。
7. 如果 AQQBot 自己也开启了聊天转发，请关闭其聊天转发，避免消息重复；保留白名单和绑定功能。

插件只读取 AQQBot 数据和服务器日志，不修改 AQQBot 数据；插件不接收后台控制台命令，TPS 与管理员命令统一通过 RCON 执行。

## 自行构建 JAR

在项目根目录执行：

```bash
mvn -U -gs minecraft-plugin/maven-settings.xml -s minecraft-plugin/maven-settings.xml -f minecraft-plugin/pom.xml clean package
```

构建结果位于 `minecraft-plugin/target/szydmc-chat-bridge-1.1.4.jar`。发布时把最新版本放入 `public/new/`，被替代且确有构建来源的旧版本移入 `public/old/`。

## 结束语

ChatGPT 和我开发，可能有不足之处，谅解，有问题可以提问
在研究TG和代替AQQBOT请期待
                                    --ZHANGZHAORUI
