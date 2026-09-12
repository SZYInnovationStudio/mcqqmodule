# SZYDMCChatBridge 独立聊天插件

适用于 Paper / Purpur 1.21.11（Java 21）。负责 QQ ↔ MC 聊天及 MC 玩家进服／退服播报，不改 AQQBot 白名单、不执行控制台命令、不读取 MCSManager，也不修改 `server.properties`。

## 安装

1. 把 [szydmc-chat-bridge-1.0.0.jar](target/szydmc-chat-bridge-1.0.0.jar) 放进 MC 服务端的 `plugins/`，重启 MC。插件会生成 `plugins/SZYDMCChatBridge/config.yml`。
2. 打开网页“修改信息”→“独立聊天插件”，点“生成并复制插件 Key”。先把 Key 粘贴到插件 `config.yml` 的 `key:`，再在网页保存。Key 至少 32 位，两个地方必须完全一致，不要发到 QQ 群。
3. `bridge-url` 默认是 `http://127.0.0.1:2556/api/plugin/exchange`，只适用于**MC 插件和网页程序在同一台机器**。若分开部署，必须用 HTTPS 反向代理或安全隧道让插件访问平台；不能把网页的管理员端口或 Key 明文暴露到公网。当前网页程序只监听 `127.0.0.1:2556`，需要由部署者设置安全隧道，不能直接写公网 IP。
4. 再次重启 MC，网页将“聊天接入方式”切为“独立插件”，按需开启 QQ → MC、MC → QQ 两个开关并保存。等待约 2 秒，点“测试插件连接”，应显示 `connected: true`。
5. 请服主自行关闭 AQQBot **自身的聊天转发**，否则可能出现重复消息；保留 AQQBot 的白名单功能。不要修改其白名单文件。

插件每秒主动向平台的 `/api/plugin/exchange` 发一次带 `Authorization: Bearer <Key>` 的请求；MC 不额外开放端口。Key 在网页程序中加密保存，在 MC 插件配置里由服主保管。消息有去重和确认，短暂断线会重试；进程重启前尚未确认的聊天不保证恢复。

玩家进出服时，网页 **MC → QQ** 开关开启且 QQ Bot 在线，就向允许的群发送单行消息：`[服务器] Alice 进入了服务器` 或 `[服务器] Alice 离开了服务器`。在线人数与名单只在 QQ 的 `/list` 回复中显示，例如 `在线玩家（1）：Alice`。此功能不包含 QQ 群成员进退群事件。

## 自行编译

使用 Java 21 和 Maven：

```sh
mvn -f minecraft-plugin/pom.xml package
```

若本机 Maven 镜像缺少 Paper API，可用仓库中的 `maven-settings.xml` 覆盖本机镜像：

```sh
mvn -U -gs minecraft-plugin/maven-settings.xml -s minecraft-plugin/maven-settings.xml -f minecraft-plugin/pom.xml package
```

JAR 在 `minecraft-plugin/target/szydmc-chat-bridge-1.0.0.jar`。
