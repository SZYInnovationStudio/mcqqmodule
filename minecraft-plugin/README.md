# SZYDMCChatBridge 1.1.4

当前源码仅使用 Bukkit 公共 API，以 Spigot 1.13.2 API 和 Java 8 字节码目标编译。通用包可安装在 Minecraft 1.13 至 1.21.11 的 CraftBukkit、Spigot、Paper、Purpur、Leaves，以及其他完整实现 Bukkit API 的衍生核心上。服务器运行所需 Java 版本由服务端核心决定。

插件负责 QQ ↔ Minecraft 聊天、玩家进退服、服务器生命周期、只读日志和 AQQBot 整库快照，不接收或执行后台控制台命令。Fabric、Forge、NeoForge 原生服务端不实现 Bukkit API，不能直接安装本插件。

## 下载

仓库已提供可直接安装的 JAR：

最新通用版：[`../public/new/szydmc-chat-bridge-1.1.4.jar`](../public/new/szydmc-chat-bridge-1.1.4.jar)

历史构建位于 [`../public/old/`](../public/old/)；旧版使用 Paper 1.21.11 API，只用于回退。

## 安装

1. 关闭 Minecraft 服务器，把 JAR 放入 `plugins/`。
2. 启动一次服务器后关闭，打开 `plugins/SZYDMCChatBridge/config.yml`。
3. 把后台生成的插件 Key 写入 `key`，保持 `bridge-url` 指向管理平台的 `/api/plugin/exchange`。
4. 使用 AQQBot 整库功能时确认 `aqqbot-data-path` 指向 `plugins/AQQBot/data.yml`；日志功能默认读取 `logs/latest.log`。
5. 重启服务器，在管理后台测试插件连接并开启需要的功能。

同机部署默认地址为 `http://127.0.0.1:2556/api/plugin/exchange`。分开部署时应使用 HTTPS 反向代理或安全隧道，不要公开后台管理端口或插件 Key。

## 构建

```bash
mvn -U -gs minecraft-plugin/maven-settings.xml -s minecraft-plugin/maven-settings.xml -f minecraft-plugin/pom.xml clean package
```

编译结果：`minecraft-plugin/target/szydmc-chat-bridge-1.1.4.jar`。
