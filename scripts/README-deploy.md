# Elysian 源码一键部署（Ubuntu/Debian 虚拟机）

本文面向要在真实虚拟机上部署 Elysian 面板的运维人员：拿到源码后运行一个脚本即完成部署，脚本幂等可重跑，支持 `--uninstall` 卸载。

## 定位与适用范围

- 适用系统：Ubuntu 22.04/24.04、Debian 12（bookworm）或更新的 apt 系发行版，架构 x86_64 或 arm64（aarch64）。
- 适用形态：无 Docker 运行时的裸机虚拟机。面板以「裸机直执模式」（`ELYSIAN_BARE_METAL=1`）运行，防火墙、SSH、主机账号、文件等安全操作直接在宿主上执行。
- 面板进程只绑定 `127.0.0.1:48101`（回环红线）；对外服务由你自行配置反向代理，脚本不申请证书、不开防火墙端口。
- 面板本身不依赖 Docker 运行时；安装 Docker 与 Caddy 只是可选的功能扩展（见下文「可选启用容器与网站功能」）。

## 虚拟机前置要求

- root 权限（`sudo bash scripts/install.sh` 亦可，脚本内部自检 root）。
- 可出网：安装过程会访问 Debian/Ubuntu apt 源、`go.dev`（Go 工具链）、GitHub（bun 工具链）、npm registry（前端依赖）与 Go 模块代理。
- 已启用 systemd（Ubuntu/Debian 服务器默认即有）。
- 硬件建议：2 核 CPU / 2 GiB 内存 / 10 GiB 磁盘（构建期峰值约需 2 GiB 内存与 3 GiB 临时空间）。

## 一键部署

```bash
# 1. 拿到源码（克隆或解包均可）
git clone <你的仓库地址> elysian && cd elysian
# 或：tar -xf elysian-src.tar.gz && cd elysian

# 2. 一键安装（幂等：重复执行即升级到当前源码并重启服务）
sudo bash scripts/install.sh
```

脚本依次完成：架构与发行版检测 → apt 安装 curl/ca-certificates/unzip → 安装 Go 与 bun（缺则装，已有且满足版本则复用）→ `bun install` + `bun run build` 构建前端 → 清空并拷贝 `apps/web/dist` 到 `apps/server-go/web/dist`、`CGO_ENABLED=0` 构建嵌入前端的单二进制 → 安装到 `/usr/local/bin/elysian` → 创建系统账号 → 写入并启动 systemd 服务 → 轮询 `/api/health` 就绪 → 打印后续指引。

版本锁定与校验：Go 固定 `1.23.12`（sha256 对照 go.dev 官方下载索引），bun 固定 `1.4.2`（sha256 对照 GitHub Release 官方 asset digest），校验不通过即中止，不落半安装状态。

## 首次登录与初始密码

- 面板首次启动会生成管理员账号 `admin` 的初始密码，只打印一次到进程 stdout，不落任何日志文件。查看方式：

  ```bash
  journalctl -u elysian -b --no-pager | grep '初始密码'
  ```

- 忘记或错过初始密码时，在面板所在机器重置（输入两次新密码，改完所有会话失效）：

  ```bash
  HOME=/var/lib/elysian elysian resetpwd
  ```

- 登录后也可在「系统设置」页修改面板密码。

## 脚本做了什么

- 系统账号：`elysian-sqlite`（固定 uid/gid 2001，SQLite 托管子进程的降权身份，服务端硬编码 2001 降权，账号缺失即建库失败）与 `elysian`（数据目录归属账号，不用于登录、无 shell）。
- systemd 单元 `/etc/systemd/system/elysian.service`：`Restart=always`（间隔 5 秒）、输出走 journal、`StateDirectory=elysian`（systemd 创建并保活 `/var/lib/elysian`）。
- 服务以 root 运行：面板在裸机模式要直接执行 ufw/sshd/账号等宿主操作，且 SQLite 托管子进程降权到 uid 2001 需要 root 父进程（`syscall.Credential` 语义）；`HOME` 显式指向 `/var/lib/elysian`，因此 `~/.Elysian` 即 `/var/lib/elysian/.Elysian`，data/logs/state/backups/tmp/config 分类目录语义与容器部署一致。
- 面板数据全部在 `/var/lib/elysian/.Elysian/`：`data/`（指标与防火墙 SQLite）、`logs/`、`state/`（含面板会话）、`backups/`、`tmp/`、`config/`（含面板凭据 `panel-credentials.json`）。
- 可选环境覆盖：`/etc/default/elysian`（文件可不存在），例如覆盖 `ELYSIAN_DOCKER_SOCKET`、`ELYSIAN_CADDY_SOCKET`；改完执行 `systemctl restart elysian` 生效。

## 升级与卸载

- 升级：更新源码到目标版本后重跑 `sudo bash scripts/install.sh`，脚本会先停服、重建、重启，`/var/lib/elysian` 数据不受影响。
- 卸载：`sudo bash scripts/install.sh --uninstall`。会停止并注销服务、删除 `/usr/local/bin/elysian` 与 systemd 单元、删除 `elysian`/`elysian-sqlite` 账号；保留 `/var/lib/elysian`（含面板凭据与数据），彻底清除请手动 `rm -rf /var/lib/elysian`；Go 与 bun 工具链一并保留。

## 可选启用容器与网站功能

面板的容器页、数据库页与网站页依赖宿主上的 Docker Engine（容器运行时）与 Caddy（网站域名 HTTPS 的反代），两者都是可选安装，面板自身不依赖它们即可运行：

- 安装 Docker Engine：按 Docker 官方文档（docs.docker.com）在虚拟机上安装并启动 docker 后，`systemctl restart elysian`。面板每次请求会现场探测 Docker 通道，就绪后容器与数据库功能自动可用；未就绪时面板会引导安装。
- 安装 Caddy：按 Caddy 官方文档（caddyserver.com）在宿主安装 Caddy。面板不申请、签发或续期证书；网站页的域名模式要求你自行提供公开 CA 证书，由宿主 Caddy 提供 HTTPS，80 端口重定向 443。IP＋端口模式不依赖 Caddy。
- 若你希望面板探测到自定义路径的 socket，可在 `/etc/default/elysian` 设置 `ELYSIAN_DOCKER_SOCKET` / `ELYSIAN_CADDY_SOCKET`。

## 对外访问（自行反代）

面板只监听 `127.0.0.1:48101`。远程访问请在同一台机器上配置你自己的反向代理（Nginx、Caddy、HAProxy 等）把公网端口转发到回环，并自行提供 TLS 证书；面板登录基于 Cookie，反代需保留 `Host` 与 `Cookie` 头并支持 WebSocket 与 SSE 升级（`/api/terminals/ws` 与 `GET /api/events`）。脚本不修改防火墙：如宿主启用了 ufw，放行反代端口的规则由你自己决定与执行。

## 冒烟模式与门禁

- `ELYSIAN_SMOKE=1 bash scripts/install.sh` 进入冒烟模式：跳过 systemd 与系统用户，仅装工具链、构建、以前台进程启动（`HOME=/var/lib/elysian`）、curl `/api/health`、验证嵌入首页与首启密码横幅后清理退出。
- 仓库内门禁 `.zcode/go-migration/script-smoke.sh`（需宿主机有 Docker，不入版本库）：`git archive` 导出当前分支到临时目录，在干净的 `debian:bookworm` 容器内挂载执行上述冒烟模式，期待退出 0。这是部署脚本的回归门禁，改动 `scripts/install.sh` 后应重跑。

## 常见问题

- 端口被占：面板固定 `48101`，`ss -ltnp | grep 48101` 找占用方；48101 冲突时先停掉占用进程再 `systemctl restart elysian`（监听地址固定回环，端口不提供配置）。
- 服务起不来：`journalctl -u elysian -n 100 --no-pager` 看启动错误；构建类问题修复后直接重跑安装脚本。
- 下载校验失败：多为网络劫持或镜像不完整，重跑脚本会重新下载校验。
- 误删 `/usr/local/bin/elysian`：重跑安装脚本即可恢复（构建产物仍在源码树内时仅重装，秒级完成）。
