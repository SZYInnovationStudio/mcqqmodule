# SZYDMCChatBridge 1.1.3

当前 JAR 基于 Paper 1.21.11 API 编译，运行环境为 Java 21；其他服务端核心尚未验证。插件负责 QQ ↔ Minecraft 聊天、玩家进退服、服务器生命周期、只读日志和 AQQBot 整库快照，不接收或执行后台控制台命令。

## 下载

仓库已提供可直接安装的 JAR：

[`../release/szydmc-chat-bridge-1.1.3.jar`](../release/szydmc-chat-bridge-1.1.3.jar)

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

编译结果：`minecraft-plugin/target/szydmc-chat-bridge-1.1.3.jar`。
