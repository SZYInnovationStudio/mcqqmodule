# 上传到 Linux 服务器长期运行

这个压缩包只有程序源码、网页、依赖锁文件和教程，**不包含**本机的 `data/`、管理员账户、QQ Bot 密钥、RCON 密码、日志、`node_modules` 或 Git 历史。上传后在服务器上重新填写配置。下面以有 SSH 权限的 Linux 服务器为例。

## 1. 上传并安装

先在服务器安装 Node.js 22 或更新版本、npm 和 unzip。在 SSH 终端检查：

```sh
node -v
npm -v
```

把 `mc-qq-bridge-2026-09-12.zip` 上传到服务器的用户目录，然后执行：

```sh
mkdir -p "$HOME/mc-qq-bridge"
unzip mc-qq-bridge-2026-09-12.zip -d "$HOME/mc-qq-bridge"
cd "$HOME/mc-qq-bridge"
npm ci --omit=dev
npm test
```

`npm ci` 会按包内的 `package-lock.json` 安装适用于**服务器系统**的依赖，所以不要上传 Windows 上的 `node_modules`。测试通过后再设置长期运行。

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

项目目录必须归 `User=` 指定的用户所有，程序才能在第一次运行时创建 `data/`。服务启动后会一直在服务器运行，退出或机器重启后由 systemd 拉起。

## 3. 安全打开管理网页

后台只监听**服务器自己的** `127.0.0.1:2556`，不能直接用服务器公网 IP 打开。这是为了保护拥有完整服务器权限的 RCON 终端。不要在防火墙里公开 2556，也不要公开 RCON 端口。

在你自己的电脑上打开一个终端，保持下面的 SSH 隧道运行（把用户名和服务器地址换成自己的）：

```sh
ssh -N -L 127.0.0.1:2556:127.0.0.1:2556 your_login_user@your_server_address
```

然后在你电脑的浏览器打开 `http://127.0.0.1:2556/`。网页和 QQ Bot 程序都运行在**远程服务器**；你的电脑只负责安全查看后台。关闭 SSH 隧道不会停止服务器上的服务。如果本机 2556 已被旧版测试程序占用，请先停止那个本机程序，否则隧道无法占用此端口。

## 4. 首次设置与日常使用

1. 首次打开后台，自己创建管理员用户名和密码。
2. 进入「修改信息」，填写 Minecraft 游戏地址/端口、RCON 地址/端口/密码、QQ 官方 Bot 的 AppID/AppSecret。若 MC 服务与本平台在同一台服务器，通常可将相应地址填 `127.0.0.1`；若 MC 在别的机器或容器内，填服务器能访问到的实际地址。
3. 先测试 MOTD 和 RCON。QQ Bot 连上后，到允许的群 @机器人发一条消息，在总览操作记录找到群 OpenID，填进允许群列表并保存。
4. 在 QQ 官方 Bot 平台按 [COMMANDS.md](COMMANDS.md) 添加六个指令名；群友先 `/qqbind <QQ号>` 并按提示二次确认，再使用 `/mcbind <玩家名>`、`/motd` 等命令。
5. 管理员可在「玩家日志」查看分类记录，在「RCON 终端」手动发令并查看管理员执行日志。

这些连接信息**不在压缩包里**，只会在服务器首次填写后保存到服务器的 `data/`。**请单独、安全地备份服务器上的整个 `data/` 目录**，尤其是 `master.key`：丢失它就无法解密已有配置和日志。不要把 `data/` 放进公开网盘或 Git 仓库。

## 更新程序

以后获得新版压缩包时，先备份服务器的 `data/`，再替换程序文件并执行 `npm ci --omit=dev`、`npm test`、`sudo systemctl restart mc-qq-bridge`。不要删除或覆盖原有 `data/`。如果换服务器，同样要把旧服务器的 `data/` 整体安全迁移，或者在新服务器重新配置。
