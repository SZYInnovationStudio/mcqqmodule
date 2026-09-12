# 上传到 Linux 服务器长期运行

`mc-qq-bridge-full-private-2026-09-13-player-presence.zip` 是**完整私有迁移包**：包含程序、网页、`data/` 内的管理员账户与加密配置、`master.key`、日志、现有 `node_modules`，以及独立聊天插件 JAR。包内 `minecraft-plugin/server-config/config.yml` 已预填与后台一致的插件 Key。它不包含 Git 历史或旧压缩包。请只通过私密渠道上传，不要公开分享或提交到 Git。下面以有 SSH 权限的 Linux 服务器为例。

## 1. 上传并安装

先在服务器安装 Node.js 22 或更新版本、npm 和 unzip。在 SSH 终端检查：

```sh
node -v
npm -v
```

把 `mc-qq-bridge-full-private-2026-09-13-player-presence.zip` 上传到服务器的用户目录，然后执行：

```sh
mkdir -p "$HOME/mc-qq-bridge"
unzip mc-qq-bridge-full-private-2026-09-13-player-presence.zip -d "$HOME/mc-qq-bridge"
cd "$HOME/mc-qq-bridge"
npm ci --omit=dev
npm test
chmod 700 data
chmod 600 data/*
```

完整包虽然带有本机 `node_modules`，但上传到 Linux 后仍须运行 `npm ci`，按包内的 `package-lock.json` 重装适用于**服务器系统**的依赖；此操作不会删除 `data/`。测试通过后再设置长期运行。

## 2. 设为开机自启（systemd）

先查看自己的登录用户名、项目绝对路径和 Node 路径：

```sh
whoami
pwd
command -v node
```

将 `deploy/mc-qq-bridge.service.example` 复制为 `/etc/systemd/system/mc-qq-bridge.service`，用编辑器把其中的 `User=`、`WorkingDirectory=` 和 `ExecStart=` 改成上面查到的实际值。`ExecStart=` 第一段必须是 Node 的实际绝对路径；后面保留 `src/server.js`。例如：

```sh
sudo cp deploy/mc-qq-bridge.service.example /etc/systemd/system/mc-qq-bridge.service
sudo nano /etc/systemd/system/mc-qq-bridge.service
sudo systemctl daemon-reload
sudo systemctl enable --now mc-qq-bridge
sudo systemctl status mc-qq-bridge --no-pager
```

若启动失败，查看最近错误：

```sh
sudo journalctl -u mc-qq-bridge -n 50 --no-pager
```

项目目录及 `data/` 必须归 `User=` 指定的用户所有，程序才能读写配置和日志。如果原本机服务还在用同一 QQ Bot 凭证，请在启用远程服务前停止本机旧服务，避免两个实例同时处理消息。服务启动后会一直在服务器运行，退出或机器重启后由 systemd 拉起。

## 3. 安全打开管理网页

后台只监听**服务器自己的** `127.0.0.1:2556`，不能直接用服务器公网 IP 打开。这是为了保护拥有完整服务器权限的 RCON 终端。不要在防火墙里公开 2556，也不要公开 RCON 端口。

在你自己的电脑上打开一个终端，保持下面的 SSH 隧道运行（把用户名和服务器地址换成自己的）：

```sh
ssh -N -L 127.0.0.1:2556:127.0.0.1:2556 your_login_user@your_server_address
```

然后在你电脑的浏览器打开 `http://127.0.0.1:2556/`。网页和 QQ Bot 程序都运行在**远程服务器**；你的电脑只负责安全查看后台。关闭 SSH 隧道不会停止服务器上的服务。如果本机 2556 已被旧版测试程序占用，请先停止那个本机程序，否则隧道无法占用此端口。

## 4. 首次设置与日常使用

1. 完整包已带原管理员账户，直接用原用户名和密码登录；不会再出现首次设置页面。
2. 进入「修改信息」，核对已迁移的 Minecraft、RCON 和 QQ 官方 Bot 配置。旧配置里的 `127.0.0.1` 在新机器上指**新服务器自身**；若 MC 在别的机器或容器内，必须改成新服务器能访问到的地址。
3. 先测试 MOTD 和 RCON。QQ Bot 连上后，到允许的群 @机器人发一条消息，在总览操作记录找到群 OpenID，填进允许群列表并保存。
4. 在 QQ 官方 Bot 平台按 [COMMANDS.md](COMMANDS.md) 添加七个指令名；群友先 `/qqbind <QQ号>` 并按提示二次确认，再使用 `/mcbind <玩家名>`、`/motd` 等命令。
5. 管理员可在「玩家日志」查看分类记录，在「RCON 终端」手动发令并查看管理员执行日志。
6. 聊天互通在「修改信息」中分别开启：QQ → MC 用 RCON；MC → QQ 需额外填写 MCSManager 面板地址、API Key、Daemon ID、Instance UUID，先测试 MC 控制台能显示玩家聊天。若 AQQBot 自身也在转发聊天，请服主自行关闭重复的方向；本平台不会修改插件配置文件。

当前聊天已配置为独立插件模式。把包内 `minecraft-plugin/target/szydmc-chat-bridge-1.0.0.jar` 放进 MC 服务端的 `plugins/`，把 `minecraft-plugin/server-config/config.yml` 放进 MC 服务端的 `plugins/SZYDMCChatBridge/`，然后重启 MC。第二个文件已预填插件 Key，不必再手抄；不要把它公开。插件默认连接同一台机器上的 `127.0.0.1:2556`；若 MC 和后台在不同机器或不同容器内，必须先设置可达的安全隧道或 HTTPS 反向代理，并修改插件配置的 `bridge-url`。网页里点“测试插件连接”确认连通。插件不会替换当前 AQQBot 白名单，也不会同步其旧绑定文件。

本版插件还会把玩家进服、退服推送到允许的 QQ 群，并附上事件发生时的在线人数和名单，例如 `在线玩家（1）：Alice`。这些播报跟随网页的 **MC → QQ** 开关；不包含 QQ 入群／退群播报。要让新功能生效，后台程序与 MC 插件 JAR 都必须替换为本包内版本，并分别重启。

这些连接信息**已经在完整私有压缩包的 `data/` 中**。部署完成后，删除服务器上传目录里多余的私有 ZIP 副本，并**单独、安全地备份服务器上的整个 `data/` 目录**，尤其是 `master.key`：丢失它就无法解密已有配置和日志。不要把完整包或 `data/` 放进公开网盘或 Git 仓库。

## 更新程序

以后获得新版压缩包时，先备份服务器的 `data/`，再替换程序文件并执行 `npm ci --omit=dev`、`npm test`、`sudo systemctl restart mc-qq-bridge`。不要删除或覆盖原有 `data/`。如果换服务器，同样要把旧服务器的 `data/` 整体安全迁移，或者在新服务器重新配置。
