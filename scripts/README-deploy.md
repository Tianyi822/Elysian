# Elysian systemd 源码部署

正式安装支持 Ubuntu/Debian、systemd、x86_64 或 arm64，需 root 与访问 apt、GitHub、Go 模块代理和 npm registry 的网络。建议至少 2 核、2 GiB 内存与足够的源码构建及数据备份空间。

## 安装与引导

```bash
git clone https://github.com/Tianyi822/Elysian.git
cd Elysian
sudo bash scripts/install.sh
```

GitHub 不可达时可改用镜像：`git clone https://gitee.com/Chentyit/Elysian.git`，镜像需与主仓库保持同步。仓库须公开或通过部署者自己的 Git 凭据取得源码。脚本安装缺少的工具链、OpenSSH 与 UFW，并自动检测安装 Docker 与 Caddy（详见「Docker 与网站」），以 `elysian-build` 无特权账号在临时源码副本构建，不在面板凭据目录执行源码脚本。Go 工具链固定 1.23.12，bun 固定 1.4.2，下载按官方索引的 SHA256 校验；官方源不可用时自动回退 golang.google.cn、阿里云或 npmmirror 镜像，但仍校验官方摘要；依赖按 bun.lock 和 go.sum 锁定。Go 模块构建默认使用 goproxy.cn，失败再尝试阿里云 goproxy 和 direct；可用 `ELYSIAN_GOPROXY` 或已有 `GOPROXY` 覆盖。Bun 依赖默认使用 `https://registry.npmmirror.com`，可用 `ELYSIAN_BUN_REGISTRY` 或已有 `BUN_CONFIG_REGISTRY` 覆盖；锁文件本身也已固定到该镜像的 tarball。安装脚本会把这两个变量显式传给无特权构建进程，因此系统预装的 Go/Bun 也会在构建时使用镜像；同时写入 `/etc/profile.d/elysian-mirrors.sh`，并在 Go 可用时执行 `go env -w GOPROXY=…`，让新登录 shell 和 root 的手动 Go 命令也使用镜像。`scripts/uninstall.sh` 会移除 profile 文件，并在删除本面板安装路径的 Go 时执行 `go env -u GOPROXY` 复位；`--keep-tools` 保留工具链与 go env 设置。安装与在线更新共用 [build-release.sh](build-release.sh)。构建失败时旧服务继续运行；安装切换前预检并备份，启动或健康检查失败时恢复原程序、数据、单元与本次涉及的面板规则。环境文件 `/etc/default/elysian` 保留。

Bun 本体安装包按 GitHub → npmmirror 顺序下载，curl 持续监测传输速度，连续 15 秒低于 100 KiB/s、请求超时或失败即回退备用源，清除失败下载的残留文件；每次连接最多 10 秒、传输最多 600 秒，不对低速或 HTTP 错误重复下载同一源，仅连接类故障保留一次 IPv4 回退。GitHub Release 元数据总请求预算 10 秒，连续 5 秒低于 1 KiB/s 也提前退出，失败后使用脚本内固定版本的官方 SHA256。镜像下载同样验证官方摘要，校验失败不解压、不安装。此策略用于 Bun 工具链安装，构建阶段的 `bun install` 继续使用配置的 npm registry。

默认前端 `http://<服务器公网 IP 或域名>:48100`，后端 `127.0.0.1:48101`。前端提供页面、静态资源和同源 `/api` 代理，支持 Cookie、上传、SSE 和 WebSocket。正式入口接受 IP 或本机 Host，跨源业务写请求及未允许的域名被拒绝。安装脚本默认启用 OpenSSH（sshd 开机自启），按 `sshd -T` 的实际端口放行 SSH，并在放行面板前端 TCP 规则后启用 UFW；已存在的 UFW 规则保持不动。默认值只在安装时声明，重跑安装脚本会重新声明，之后以安全页的启停与规则为准。面板管理宿主 UFW 的面板 TCP 规则与安全页规则，并核验启用的 IPv6；部署者需自行配置云安全组。此部署方式不配置域名反代、HTTPS 或证书。

既有安装需先运行此脚本完成维护能力引导；此后可在系统设置中改端口、重启与更新。Docker 开发环境保留既有回环端口映射，设置页维护功能不可执行。

## 登录与配置

```bash
# 首次启动只打印一次初始密码；重复安装的历史记录仅显示最近一条
journalctl -u elysian -b --no-pager | grep '初始密码：' | tail -n 1
# 忘记密码时重置（全部会话失效）
HOME=/var/lib/elysian /usr/local/bin/elysian resetpwd
# 服务管理
systemctl status elysian
systemctl restart elysian
```

systemd 日志会保留多次安装的初始密码记录，上述查询仅显示本次系统启动以来最近的一条生成记录；密码已修改或重置后，该记录不再代表当前密码。重新安装保留有效凭据时沿用原密码，不生成新初始密码；已有凭据文件不可用时拒绝自动覆盖，并提示检查权限或执行重置命令。

`sudo ely resetpwd` 直接进入重置密码，`ely agent` 打开 Agent，`ely upgrade` 更新面板，`ely help upgrade` 查看来源、版本策略和确认参数。

`resetpwd` 在交互终端中分行显示账号、密码要求与会话失效提醒，两次输入均不回显；过短或不一致时就地重试，Ctrl+C 取消，成功与失败分开显示结果。输入结束或取消后恢复终端属性与行首位置。管道或文件输入按顺序消费两行，校验失败直接以非零状态退出，不自动重试，也不输出密码。

服务以 root 运行以执行宿主安全操作，SQLite 子进程降权到 `elysian-sqlite`（UID/GID 2001）。`HOME=/var/lib/elysian`，因此数据根为 `/var/lib/elysian/.Elysian`。`/etc/default/elysian` 可配置 Docker/Caddy socket 等环境覆盖；端口仅使用 `config/panel-network.json` 的 `frontendPort` 和 `backendPort` 两个整数，配置损坏拒绝启动。请优先在设置页「保存并重启」修改端口，手写文件不会自动迁移 UFW 规则。

程序版本在 `/opt/elysian/releases`，`current` 符号链接原子选择当前版本，`/usr/local/bin/elysian` 指向当前程序。根拥有的维护程序及共用构建脚本在 `/opt/elysian/maintenance`；在线任务执行当前程序的独立副本，不受服务停止影响。

## 设置页维护与更新

设置页展示当前端口和提交。端口维护提交后显示新旧地址、阶段和日志；新入口完成事务后自动跳转，等待超时保留新旧地址供手动打开。刷新页面从服务端恢复活动／最后任务。端口或版本变化保留登录会话，修改密码使会话失效。

维护提交先保存 `queued/checking` 任务并派发独立 worker，宿主预检在 worker 内进行；构建前与切换前的全部预检共用累计三分钟预算，构建耗时不占该预算。预检失败成为可查询的失败任务。新增已鉴权的 `GET /api/panel/tasks/by-request/{requestId}` 按精确请求编号返回任务，未找到返回 404。页面发出请求前将版本化编号、操作类型和精确输入保存在同标签页的 sessionStorage；网络失败、超时或 5xx 显示「提交结果未确认」，每两秒按编号继续查询，404 不代表提交失败。刷新与重新登录后继续对账，期间阻止新维护操作；不自动重发写请求，人工重试使用原编号和原输入。

任务轮询网络断连累计两分钟后转入每五秒健康探测，每次请求及响应体读取限时三秒，并响应页面取消。活动更新结束后独立核对同源健康端点的实际提交，只有与目标 SHA 一致才提示成功并刷新；版本不一致保留错误和手动重载入口。历史成功任务不会自动刷新页面，迟到响应不能跨任务或登录代次更新展示。

面板更新固定使用 [GitHub：Tianyi822/Elysian](https://github.com/Tianyi822/Elysian) 检查、读取更新日志和下载源码，失败时显示原因，不提供 Gitee 来源或自动回退。可选「最新提交」跟随仓库默认分支，或「最新发版」使用最新正式 Release 的标签。正式发版排除草稿和预发布，轻量或附注标签都解析为完整提交 SHA；暂无正式发版时不回落默认分支。切换策略后需重新检查，检查结果按策略保存，任务锁定 GitHub、策略和已检查 SHA，以无特权账号构建。省略来源或 auto 的请求固定使用 GitHub。历史 Gitee 任务保持原来源，待确认提交沿用原输入与编号精确对账；已有任务直接返回，未受理请求明确拒绝，不改投 GitHub。资源不足时可按已确认清单提前停止面板，由独立维护进程构建并恢复业务。构建上限 30 分钟，切换后健康等待 60 秒，检查两个入口、静态资源与提交。失败恢复旧版本与数据，成功保留当前和上一成功版本。仓库未公开、上游限流、下载或构建失败会显示具体错误。

任务及日志在 `state/panel-maintenance/<任务 ID>.json` 和 `.log`，日志最多 2 MiB、API 分页读取；事务备份在 `backups/panel-maintenance/<任务 ID>`，安装引导备份在 `backups/install-*`。备份含凭据，目录权限为 0700；确认不再需要恢复后由管理员清理备份。切换时复制 config/data/state 并保留权限和属主，不将版本更新误当成密码重置。

## 中断恢复

服务的 `ExecStartPre` 自动检查事务，提交完成则保留，未提交则恢复旧程序、配置、持久化数据及面板规则；活跃独立 worker 持有锁时由其继续处理。恢复失败会阻止服务启动，保留任务与备份。

维护进程状态使用 `alive/dead/unknown`，任务可选返回 `workerStatus` 并保留兼容的 `workerDead`；每次 systemd 核对有独立五秒预算，超时、DBus 错误和异常输出均为 unknown。只有明确 dead、最新记录超过十分钟未推进、已取得 worker 锁且在存储锁内重新核对仍满足条件，才收敛为失败或需要恢复的终态。状态未知时保留任务、worker 文件及维护保护；启动恢复无法确认状态会返回明确错误，修复 systemd 后重试。

排查命令：

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

面板进程自身不依赖 Docker，但容器、数据库与网站功能依赖宿主 Docker Engine；Caddy 用于网站域名 HTTPS。安装脚本在构建完成后、面板版本切换前检测并安装依赖，先按 worker→operations 顺序取得现有维护锁，并核对持久化维护任务，防止与维护任务和业务写冲突。Docker 已装且响应时只读复用，守护进程未响应时只尝试拉起服务，失败不会覆盖既有安装；缺失时通过 [Docker 官方 apt 安装流程](https://docs.docker.com/engine/install/ubuntu/)，使用 [阿里云](https://developer.aliyun.com/mirror/docker-ce)／[清华 TUNA](https://mirrors.tuna.tsinghua.edu.cn/help/docker-ce/) 提供的 Docker CE 仓库，不下载或执行远端安装脚本。真实验证包括同一本机 Unix socket 的 `docker info` 和 Engine API ≥ 1.41；CLI 显式指定该目标并清空 `DOCKER_HOST`、`DOCKER_CONTEXT` 和相关 TLS/API 覆盖，不以当前终端的远端引擎代替面板运行通道。仅新装 Docker 设置开机自启，既有安装只报告实测自启状态。Caddy 缺失时经官方 cloudsmith apt 源安装，卸载范围按明确清单与归属、使用状态核验。

`ELYSIAN_DOCKER_MIRROR=auto` 为默认值，按阿里云 → 清华 TUNA → 官方源探测；`aliyun`、`tuna`、`official` 固定单一来源，失败不自动换源。每个来源以短超时读取发布公钥与签名 `InRelease`，主公钥指纹固定为 `9DC858229FC7DD38854AE2D88D81803C0EBFCD88`，真实 GPG/GPGV 核验签名、发行版代号、架构和 stable 频道后才写入 `docker.sources` 与 `docker.asc`。仅支持 Ubuntu/Debian 的 amd64／arm64，发行版或架构不可识别时拒绝写入。既有源若不等于当前候选、存在旧 `docker.list` 或路径权限异常，保留原文件并明确报告；不删除已有 containerd、runc 或其他冲突运行时。apt 使用 `--no-remove` 防止自动移除其他软件，进入 apt 安装后失败不自动换源或重投，保留私有日志、已写配置和首次文件归属供重试核对。

```bash
sudo bash scripts/install.sh                                # 国内源自动回退
sudo env ELYSIAN_DOCKER_MIRROR=tuna bash scripts/install.sh   # 固定清华源
```

Docker 与 Caddy 通道分别按安装环境变量 `ELYSIAN_DOCKER_SOCKET`／`ELYSIAN_CADDY_SOCKET`、`/etc/default/elysian` 同名配置、默认 `/var/run/docker.sock`／`/run/caddy/admin.sock` 的顺序解析；显式安装环境覆盖会在同一事务中原子持久化到环境文件，只规范化对应键，保留另一通道、其余项及原权限、属主，保证安装与面板服务使用同一路径。Docker 验证失败时不改写环境文件或 Caddy。路径须为无空白、冒号、引号和控制字符的绝对路径；无法安全解析的配置、符号链接目标及文件冲突会明确拒绝自动改写。

依赖准备前通过 `maintenance-install-check --before-platform-dependencies` 核对维护记录、SSH／宿主端口、网站登记和防火墙，暂缓 Docker 端口查询，允许 daemon 缺失、停止或遗留失效 socket 的机器进入依赖准备。Docker 启动并通过真实协议验证后立即执行不带阶段参数的完整安装预检，冲突或未知结果阻止 Caddy 接入与版本切换；切换前的完整核验仍保留。该阶段参数只对安装预检有效，普通维护、重启与改端口不放宽 Docker 端口核验。

目标 Unix socket 的 `GET /config/` 已返回 HTTP 200 和有效 JSON 时直接复用，Caddyfile 不改写、服务不重启；手工管理的 Caddy 也可按此方式复用。目标未就绪时，安装器只自动接入能核对标准 systemd 启动命令、`caddy` 运行身份及真实 Caddyfile，且自启状态为 `enabled`、`disabled` 或 `enabled-runtime` 的服务；其他链接、别名或静态单元由管理员先准备管理通道。从磁盘配置识别旧的本机 Unix 或回环 TCP 管理端点，读取真实运行 JSON，保留动态路由、证书及其余设置，仅调整管理监听。磁盘候选配置须通过 `caddy validate` 和适配后 JSON 比对；活跃服务通过 `POST /load` 原子应用，不重启，原本停止的服务才启动。最终验证目标 API，并将实际运行 JSON 与候选逐项比对；单次请求限 5 秒、响应限 4 MiB、就绪验证总预算 30 秒，包含请求、重试等待、JSON 解析与配置比较。本机管理 API 请求强制绕过终端 HTTP/ALL_PROXY 代理，确保回环 TCP 和 Unix socket 始终直连。无法读取旧运行配置、识别服务或安全解析超过 256 KiB 等配置时在写入前中止，保留原服务，由管理员用既有管理方式准备通道后重跑。API 原文及证书不会输出到终端。

候选 Caddyfile 的适配比对仅将 HTTP `file_server.hide` 中精确等于本次临时配置文件的路径替换为最终 Caddyfile 路径，以处理 Caddy 自动隐藏输入配置文件的行为；显式隐藏项、路由、证书与其他字段仍须逐项一致。真实运行配置比对不做此替换，保持完整 JSON 核对。

接入事务暂存在 `/var/lib/elysian/.Elysian/backups/platform-install-active` 的 0700 私有目录，记录 Caddyfile、Elysian 专属 systemd drop-in、tmpfiles 和环境文件的原内容、权限、属主及存在性，同时保存原运行 JSON 和服务启停、自启状态。任意应用或验证失败恢复原文件和运行 JSON；管理端点均不可达时尝试恢复文件后重启旧服务并回灌原运行 JSON。恢复失败保留未提交记录并阻止后续安装，修复后重跑；安装启动会在取得同一组维护锁后先恢复未提交事务。恢复成功归档私有恢复记录，候选校验详情保存在归档内的 `validate.log`，该日志与 `journalctl -u caddy` 分别用于检查安装器校验和服务运行；依赖成功提交后清理活动事务。后续面板切换失败不拆散已验证的 Caddy 与环境配置。仅本次新装 Caddy 时声明 `80,443/tcp`；复用 Caddy 不动既有 UFW 规则，未提交依赖事务只撤销可确认由本事务新增的精确规则。摘要分别核对 80、443 及 UFW 已启用的 IPv6，受限来源不会误报为公开放行。IP＋端口网站无需 Caddy，面板不申请、签发或续期证书。

安装阶段头只显示编号与名称；双 TTY 且终端支持刷新时，在终端底部维护一条总体进度条，显示当前动作、转圈与实测耗时，输出行会覆盖并重绘这条状态行，不在滚动历史里留下多条进度条。curl 下载不输出独立进度条，详细输出保存在 `/tmp/elysian-build.*` 等私有日志，失败回显末 40 行并保留完整日志。`NO_COLOR` 只关闭颜色，`TERM=dumb` 与输出重定向降级为纯文本；收尾摘要使用自适应终端宽度的分区横线与对齐键值，全部取实测值。

## 卸载与验证

`sudo bash scripts/uninstall.sh` 是唯一卸载入口，默认彻底清理：先展示程序、四类数据、凭据、日志、缓存、账号及依赖清单，确认后执行；`--yes` 按该清单免交互执行，包含删除全部面板数据。需要保留时显式使用 `--keep-data`、`--keep-dependencies`、`--keep-tools`、`--keep-caddy-config`；`--purge-data` 是默认数据清理行为的兼容参数，`--dry-run` 只预览。安装和卸载通过固定生命周期锁串行，卸载同时取得 worker→operations 维护锁；无法确认面板服务停止时，在删除程序与数据前中止。保留数据时保留对应的 `elysian`／`elysian-sqlite` 账号，全部删除才清理三个账号与组。

安装器把新增 Docker/Caddy 包名、安装前不存在的 apt 源与公钥摘要，以及新装 Go/Bun 的二进制摘要保存到 root 私有的 `/var/lib/elysian-installer`；复用组件、旧安装和安装前已有的包不自动认领。卸载只清理可核对的归属：Docker 须无容器（含停止状态）、镜像、卷和自定义网络，并核对可用的 containerd 命名空间；Caddy 须仍与首次软件包默认配置基线及真实运行 JSON 一致。停止或不可达的服务不能当成空服务；任何归属、配置、权限或业务使用异常都保留现场、列为未完成项并非零退出。包清理先用 apt 模拟检查，再用 dpkg 精确 purge 清单，拒绝自动移除其他依赖；apt 源与公钥只删除新增且内容未变的文件。业务数据目录 `/var/lib/docker`、`/var/lib/containerd`、`/var/lib/caddy` 不盲删，恢复备份单独列出由管理员核对后清理。

保留 Caddy 时，默认只精确移除管理接入：配置先备份并 `caddy validate`，候选保留原文件权限和属主；运行配置须与磁盘一致，存在动态路由时拒绝 reload 并保留完整管理通道。热加载显式访问旧 Unix 管理端点，并核验新端点实际配置；失败恢复原配置，结果无法确认时保留辅助文件并明确报告。程序保留但启动文件缺失或服务 failed 也算未完成。已修改的管理文件、源码、SSH、用户 UFW 规则和非本安装器新增的软件不盲删；结尾区分已删除、主动保留、未完成及私有恢复备份，不以统一成功横幅掩盖异常。

安装在源码构建前检查标准 Caddy 服务的启动文件与服务用户读取权限。程序存在但启动文件缺失时直接给出原因；管理员停止 Caddy 后，可使用 `sudo bash scripts/install.sh --restore-caddyfile /可信备份的绝对路径/Caddyfile` 校验并原子恢复缺失目标，然后继续安装。该选项不覆盖已有文件，不自动选择历史备份，不把配置缺失视为没有网站。

旧安装没有可信收据时，使用 `sudo bash scripts/uninstall.sh --remove-legacy-components caddy,docker,go,bun` 明确选择旧组件清理；也可只列部分名称。该选择不写入或伪造安装收据，审计仅记录为显式旧组件清理。程序展示固定软件包、apt 源／公钥、Go/Bun 标准安装路径后统一确认，`--keep-*` 优先。Docker 业务资源检查及 apt 模拟／dpkg 精确清单继续生效；旧 Caddy 仅在标准启动方式、默认欢迎站点、真实运行 JSON 与磁盘一致时清理，动态路由或其他业务配置继续阻止移除。该参数不隐式删除容器、镜像、卷或业务数据，管理员须单独决定其处置。

Docker 包与服务移除后核对 `/run/docker.sock`：拒绝符号链接、非 socket、非 root 所有、多硬链接和仍有监听的端点，仅在连接明确返回 `ECONNREFUSED` 且设备号／inode 未变时删除失效 socket，防止下次安装被遗留路径误判阻塞；无法确认时保留并非零退出。

前端验证为 `bun run typecheck`、`bun run test`、`bun run build`；Go 门禁为 `bash apps/server-go/dev-check.sh ./...`，全部 Go 检查在开发容器内运行。安装脚本测试通过专用 Docker 镜像运行，源码只读挂载，不挂 Docker socket、不发布宿主端口、运行期断网；工具安装、临时文件、Unix/TCP fixture 和真实 Caddy 进程全部在容器内，容器退出后自动删除。纯逻辑自测覆盖 TUI 与依赖辅助函数，事务故障测试覆盖动态路由保留、零重启复用、服务缺失、校验和 API 失败、显式隐藏规则变化、环境持久化失败、跨进程恢复与恢复失败保留记录；真实 Caddy 测试覆盖静态站点自动隐藏配置文件、嵌套路由、热迁移到 Unix 管理端点及原运行配置恢复。

```bash
docker build -f scripts/Dockerfile.install-test -t elysian-install-test:local scripts
docker run --rm --network none \
  --mount "type=bind,src=$PWD,dst=/workspace,readonly" \
  elysian-install-test:local -c 'set -e
    bash -n scripts/tui.sh scripts/install.sh scripts/docker-apt.sh scripts/docker-apt.test.sh scripts/uninstall.sh scripts/platform-lifecycle.sh scripts/platform-lifecycle.test.sh scripts/build-release.sh scripts/install-platform.test.sh scripts/install-caddy-config.test.sh scripts/install-download.test.sh scripts/install-helpers.test.sh scripts/uninstall-helpers.test.sh
    bash scripts/docker-apt.test.sh
    bash scripts/install-download.test.sh
    bash scripts/install-caddy-config.test.sh
    bash scripts/install-helpers.test.sh
    bash scripts/uninstall-helpers.test.sh
    bash scripts/platform-lifecycle.test.sh
    bash scripts/install-platform.test.sh'
```

`ELYSIAN_SMOKE=1 bash scripts/install.sh` 仅供一次性容器冒烟，跳过 systemd、系统账号与平台依赖阶段，验证两入口、嵌入页面与首启密码；正式验收需要一次性 Ubuntu/Debian VM，核对远端前端、后端回环、规则迁移、配置持久化、会话、SSE 与 WebSocket，以及 Docker/Caddy 自动安装、已有运行路由及证书保留、依赖失败停止与重跑幂等；命令桩和容器内 Caddy 测试不能替代真实 apt、systemd 的完整安装验收。
