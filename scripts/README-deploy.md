# Elysian systemd 源码部署

正式安装支持 Ubuntu/Debian、systemd、x86_64 或 arm64，需 root 与访问 apt、GitHub、Go 模块代理和 npm registry 的网络。建议至少 2 核、2 GiB 内存与足够的源码构建及数据备份空间。

## 安装与引导

```bash
git clone https://github.com/Tianyi822/Elysian.git
cd Elysian
sudo bash scripts/install.sh
```

GitHub 不可达时可改用镜像：`git clone https://gitee.com/Chentyit/Elysian.git`，镜像需与主仓库保持同步。仓库须公开或通过部署者自己的 Git 凭据取得源码。脚本安装缺少的工具链及 UFW，以 `elysian-build` 无特权账号在临时源码副本构建，不在面板凭据目录执行源码脚本。Go 工具链固定 1.23.12，bun 固定 1.4.2，下载按官方索引的 SHA256 校验；官方源不可用时自动回退 golang.google.cn、阿里云或 npmmirror 镜像，但仍校验官方摘要；依赖按 bun.lock 和 go.sum 锁定。Go 模块构建默认使用 goproxy.cn，失败再尝试阿里云 goproxy 和 direct；可用 `ELYSIAN_GOPROXY` 或已有 `GOPROXY` 覆盖。Bun 依赖默认使用 `https://registry.npmmirror.com`，可用 `ELYSIAN_BUN_REGISTRY` 或已有 `BUN_CONFIG_REGISTRY` 覆盖；锁文件本身也已固定到该镜像的 tarball。安装脚本会把这两个变量显式传给无特权构建进程，因此系统预装的 Go/Bun 也会在构建时使用镜像；同时写入 `/etc/profile.d/elysian-mirrors.sh`，并在 Go 可用时执行 `go env -w GOPROXY=…`，让新登录 shell 和 root 的手动 Go 命令也使用镜像。卸载会移除 profile 文件，但不会回滚 go env，可用 `go env -u GOPROXY` 自行恢复。安装与在线更新共用 [build-release.sh](build-release.sh)。构建失败时旧服务继续运行；安装切换前预检并备份，启动或健康检查失败时恢复原程序、数据、单元与本次涉及的面板规则。环境文件 `/etc/default/elysian` 保留。

默认前端 `http://<服务器 IP>:48100`，后端 `127.0.0.1:48101`。前端提供页面、静态资源和同源 `/api` 代理，支持 Cookie、上传、SSE 和 WebSocket。正式入口接受 IP 或本机 Host，跨源业务写请求及未允许的域名被拒绝。面板仅管理宿主 UFW 的面板 TCP 规则，保持 UFW 原启停状态，并核验启用的 IPv6；部署者需自行配置云安全组。此部署方式不配置域名反代、HTTPS 或证书。

既有安装需先运行此脚本完成维护能力引导；此后可在系统设置中改端口、重启与更新。Docker 开发环境保留既有回环端口映射，设置页维护功能不可执行。

## 登录与配置

```bash
# 首次启动只打印一次初始密码
journalctl -u elysian -b --no-pager | grep '初始密码'
# 忘记密码时重置（全部会话失效）
HOME=/var/lib/elysian /usr/local/bin/elysian resetpwd
# 服务管理
systemctl status elysian
systemctl restart elysian
```

服务以 root 运行以执行宿主安全操作，SQLite 子进程降权到 `elysian-sqlite`（UID/GID 2001）。`HOME=/var/lib/elysian`，因此数据根为 `/var/lib/elysian/.Elysian`。`/etc/default/elysian` 可配置 Docker/Caddy socket 等环境覆盖；端口仅使用 `config/panel-network.json` 的 `frontendPort` 和 `backendPort` 两个整数，配置损坏拒绝启动。请优先在设置页「保存并重启」修改端口，手写文件不会自动迁移 UFW 规则。

程序版本在 `/opt/elysian/releases`，`current` 符号链接原子选择当前版本，`/usr/local/bin/elysian` 指向当前程序。根拥有的维护程序及共用构建脚本在 `/opt/elysian/maintenance`；在线任务执行当前程序的独立副本，不受服务停止影响。

## 设置页维护与更新

设置页展示当前端口和提交。修改端口前显示新旧地址，提交后显示阶段和日志；新入口完成事务后自动跳转，等待超时保留新旧地址供手动打开。刷新页面从服务端恢复活动／最后任务。端口或版本变化保留登录会话，修改密码使会话失效。

更新主源为 [Tianyi822/Elysian](https://github.com/Tianyi822/Elysian)，GitHub 不可达时回退 [Chentyit/Elysian Gitee 镜像](https://gitee.com/Chentyit/Elysian)；可选「最新提交」跟随默认分支，或「最新发版」使用最新正式 Release 的标签。Gitee 回退的发版策略要求镜像同步 Releases，缺少时明确失败，不回落默认分支。正式发版排除草稿和预发布，轻量或附注标签都解析为完整提交 SHA；暂无正式发版时不回落默认分支。切换策略后需重新检查，两种策略都锁定已检查 SHA 下载源码，以无特权账号构建。旧程序在下载与构建期间继续服务。构建上限 30 分钟，切换后健康等待 60 秒，检查两个入口、静态资源与提交。失败恢复旧版本与数据，成功保留当前和上一成功版本。仓库未公开、GitHub 限流、下载或构建失败会显示具体错误。

任务及日志在 `state/panel-maintenance/<任务 ID>.json` 和 `.log`，日志最多 2 MiB、API 分页读取；事务备份在 `backups/panel-maintenance/<任务 ID>`，安装引导备份在 `backups/install-*`。备份含凭据，目录权限为 0700；确认不再需要恢复后由管理员清理备份。切换时复制 config/data/state 并保留权限和属主，不将版本更新误当成密码重置。

## 中断恢复

服务的 `ExecStartPre` 自动检查事务，提交完成则保留，未提交则恢复旧程序、配置、持久化数据及面板规则；活跃独立 worker 持有锁时由其继续处理。恢复失败会阻止服务启动，保留任务与备份。排查命令：

```bash
journalctl -u elysian -n 100 --no-pager
journalctl -u 'elysian-maintenance-*' -n 100 --no-pager
# 确认独立维护任务已结束，再停服执行恢复
systemctl stop elysian
HOME=/var/lib/elysian /opt/elysian/maintenance/elysian maintenance-recover
systemctl start elysian
```

不要在独立维护任务运行中手动修改 current、端口配置或事务备份。共享 UFW 规则冲突需先在安全页或宿主处理；面板不会拆分用户的端口段、应用配置或共享规则。安装引导若进程被强制终止，可使用保留的 install-* 目录人工恢复 unit、maintenance、data 分类目录和旧版本，再执行该备份对应的 `maintenance-bootstrap-restore <备份>/firewall.json`。

## Docker 与网站

面板进程自身不依赖 Docker，但容器、数据库与网站功能依赖宿主 Docker Engine；Caddy 仅用于网站的域名 HTTPS。缺少依赖时由既有安装引导处理。IP＋端口网站无需 Caddy。面板不会申请、签发或续期证书，网站构建仍使用一次性非特权容器。

## 卸载与验证

`sudo bash scripts/install.sh --uninstall` 停止并注销服务，删除程序版本、维护工具和系统账号，保留 `/var/lib/elysian` 数据、Go/bun 工具链及 UFW 规则；管理员可自行确认后清理面板规则。

前端验证为 `bun run typecheck`、`bun run test`、`bun run build`；Go 门禁为 `bash apps/server-go/dev-check.sh ./...`，全部 Go 检查在开发容器内运行。脚本语法检查为 `bash -n scripts/install.sh scripts/build-release.sh`。`ELYSIAN_SMOKE=1 bash scripts/install.sh` 仅供一次性容器冒烟，跳过 systemd 与系统账号，验证两入口、嵌入页面与首启密码；正式验收需要一次性 Ubuntu/Debian VM，核对远端前端、后端回环、规则迁移、配置持久化、会话、SSE 与 WebSocket，容器冒烟不能替代 VM 验收。
