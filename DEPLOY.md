# 上传到 Linux 服务器长期运行

`mc-qq-bridge-full-private-8.8.2.zip` 是**完整私有迁移包**：包含程序、网页、`data/` 内的管理员账户与加密配置、`master.key`、日志、现有 `node_modules`，以及独立聊天插件 JAR。包内 `minecraft-plugin/server-config/config.yml` 已预填与后台一致的插件 Key。它不包含 Git 历史或旧压缩包。请只通过私密渠道上传，不要公开分享或提交到 Git。下面以有 SSH 权限的 Linux 服务器为例。

## 1. 上传并安装

先在服务器安装 Node.js 22 或更新版本、npm 和 unzip。在 SSH 终端检查：

```sh
node -v
npm -v
```

把 `mc-qq-bridge-full-private-8.8.2.zip` 上传到服务器的用户目录，然后执行：

```sh
mkdir -p "$HOME/mc-qq-bridge"
unzip mc-qq-bridge-full-private-8.8.2.zip -d "$HOME/mc-qq-bridge"
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
4. 在 QQ 官方 Bot 平台按 [COMMANDS.md](COMMANDS.md) 按需添加英文命令及中文别名；群友先 `/qqbind <QQ号>` 并按提示二次确认，再使用 `/mcbind <玩家名>`、`/motd` 等命令。
5. 管理员可在「玩家日志」查看分类记录，在「RCON 终端」手动发令并查看管理员执行日志。
6. 聊天互通只通过独立插件连接。在修改信息页确认插件 Key 已配置并测试插件连接，再分别开启 QQ → MC 与 MC → QQ；RCON 继续用于 AQQBot 白名单和管理员终端。

双向聊天只支持独立插件。把包内 `minecraft-plugin/target/szydmc-chat-bridge-1.1.3.jar` 放进 MC 服务端的 `plugins/`，把 `minecraft-plugin/server-config/config.yml` 放进 MC 服务端的 `plugins/SZYDMCChatBridge/`，然后重启 MC。第二个文件已预填插件 Key，不必再手抄；不要把它公开。插件默认连接同一台机器上的 `127.0.0.1:2556`；若 MC 和后台在不同机器或不同容器内，必须先设置可达的安全隧道或 HTTPS 反向代理，并修改插件配置的 `bridge-url`。网页里点“测试插件连接”确认连通。插件不会替换当前 AQQBot 白名单，也不会同步其旧绑定文件。

本版插件会把玩家进服、退服推送到允许的 QQ 群，且只发单行消息，例如 `[服务器] Alice 离开了服务器`，不附加在线名单。在线人数与名单改由 QQ 的 `/list` 回复显示，例如 `在线玩家（1）：Alice`，零人时为 `在线玩家（0）：无`。进出服播报跟随网页的 **MC → QQ** 开关；不包含 QQ 入群／退群播报。8.7.0 必须更新后台程序；整库页依赖桥接插件只读 AQQBot data.yml 并同步快照。

后台现会利用现有插件每秒的心跳播报 `[服务器] MC 服务器已上线`；若连续约 30 秒无心跳，则播报 `[服务器] MC 服务器已离线（可能是关服或插件连接中断）`。两种通知也跟随 **MC → QQ** 开关。如果已安装上一版带进出服播报的 JAR，这次只需更新并重启后台，原 JAR 与插件 Key 不必更改。后台自身停机时无法发送离线通知；后台重启后第一次收到心跳会再次播报“上线”。8.0 启动时会备份旧状态文件，移除本地 MC 绑定快照和导入占位用户，保留已登记的 OpenID→QQ。后台查询和群命令直接读取 AQQBot。更新远程服务器时先备份并保留其当前 data 目录，不要用本压缩包的本机副本覆盖远程数据。

这些连接信息**已经在完整私有压缩包的 `data/` 中**。部署完成后，删除服务器上传目录里多余的私有 ZIP 副本，并**单独、安全地备份服务器上的整个 `data/` 目录**，尤其是 `master.key`：丢失它就无法解密已有配置和日志。不要把完整包或 `data/` 放进公开网盘或 Git 仓库。

## 更新程序

以后获得新版压缩包时，先备份服务器的 `data/`，再替换程序文件并执行 `npm ci --omit=dev`、`npm test`、`sudo systemctl restart mc-qq-bridge`。不要删除或覆盖原有 `data/`。如果换服务器，同样要把旧服务器的 `data/` 整体安全迁移，或者在新服务器重新配置。

## 5. 中文命令与插件连接

QQ 官方 Bot 可配置英文命令及中文别名，包含 /绑定、/解绑、/全部解绑、/我的绑定等。群友完成 QQ 登记后，查询、绑定和解绑从 AQQBot 实时读取；纯数字玩家名（包括 011）按文本原样处理。后台 AQQBot 查询页仅按 QQ 号或玩家名实时查询。中文别名沿用对应英文命令的回复格式。

已有远程安装请先安全备份远程 data 目录，只更新程序、网页与文档，并保留远程配置和管理员账户；然后运行 npm ci --omit=dev、npm test 并重启服务。首次启动自动备份并清除旧 MC 绑定快照，AQQBot 服务端记录不会被删除。

旧 MCSManager 聊天配置会在首次启动时从加密配置中移除。不要覆盖远程当前 data 目录；安装包里的 JAR 和插件 config.yml 可用于新安装，已有安装若 Key 一致则无需更换 JAR。

8.2 的“QQ 登记”页显示当前后台的 QQ 号与 OpenID 对应关系，支持搜索和刷新；AQQBot 绑定仍在独立查询页实时读取。更新远程服务时保留原有 data 目录。

8.3 新增 /status 和 /桥接状态；请按需在 QQ 官方 Bot 平台配置新命令，原 /状态 保持 MOTD 查询。

8.4 新增 QQ 登记后台修改与删除，并加强群命令入口及登记变更期间的身份检查。更新服务端程序后重启 Node 服务，/status 才能反映新运行版本；独立插件 JAR 未改动。

8.5 增加管理员 AQQBot 单个/全部解绑和登记删除联动开关。开关默认关闭，保存在加密配置中；开启后删除登记需要输入 QQ 号二次确认，AQQBot 解绑全部核对成功才会删除登记。AQQBot 管理操作依赖可用的 RCON。

8.5.1 把写操作移到独立“绑定管理”页，支持 QQ、OpenID、玩家名搜索、单条新增/修改/解绑、全选、批量解绑和批量改绑；“QQ 登记”页可由管理员新建登记。新增只读“AQQBot 整库”页，新版 JAR 默认读取 plugins/AQQBot/data.yml，通过已有插件 Key 认证连接同步；如目录不同，请修改插件 config.yml 的 aqqbot-data-path。

## 8.7.0 升级说明

建议把 MC 服务端 `plugins/` 中的桥接插件更新为 `minecraft-plugin/target/szydmc-chat-bridge-1.1.3.jar`，并保留原插件 Key。可以暂时继续使用 1.1.1 或 1.1.2：8.7.0 后台不再下发控制台命令，聊天、整库、服务器日志和生命周期仍兼容；稍后再更新即可。配置新增 `server-log-path: '../../logs/latest.log'`；默认路径从 `plugins/SZYDMCChatBridge/` 指向服务端 `logs/latest.log`，目录结构不同才需要修改。

登录后台后，在“消息模板”页设置聊天、进退服和开关服模板及两个通知开关；在“服务器日志”页决定是否同步日志。日志开关默认关闭。开启表示允许插件读取并向桥接后台传输 `latest.log`；后台页面只读，进程内最多保留最近 2000 行，重启后台后清空。

“服务器远程终端”只使用 RCON；AQQBot 查询、绑定、解绑和 TPS 查询同样需要 RCON。QQ 平台如需使用 TPS 查询，请增加 `/tps` 和中文 `/性能` 命令。插件 1.1.3 会在心跳中上报版本且不接收后台控制台命令，但继续传输服务器日志、聊天、整库快照和生命周期事件。






插件 1.1.3 上线后，QQ 的 `/status` 与后台 `/api/status` 会显示插件版本。继续使用 1.1.1 或 1.1.2 时其他功能兼容，但插件版本显示“未上报”。

8.8.0 的后台使用通用模块中心。新模块按 `MODULE-SPEC.md` 制作 `.mcqqmodule`；旧 `.szydmodule` 继续兼容。新功能使用新的模块 ID，同一模块 ID 仅接受更高版本升级。v2 模块拥有完整宿主接口权限，只安装可信模块。已安装模块保存在 `data/modules`，部署和备份时应与其他 `data` 文件一起保留。

## 8.8.2 通用模块与每日签到

先更新服务端，再登录后台的模块中心上传 `daily-checkin-money-1.2.0.mcqqmodule`。已有 1.0.0 或 1.1.0 可直接升级同一模块 ID，签到记录、设置和开关会保留。`/qd add 玩家名` 无需先查询，发放前仍核对 QQ 登记与 AQQBot 玩家归属。模块页可独立开关、配置奖励范围与经济命令模板。插件 JAR 仍为 1.1.3。上传之前确认经济插件支持模板中的 RCON 命令。
