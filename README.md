# Elysian

Elysian 是 Agent 辅助的运维工作台，用于查看主机状态并操作容器、数据库、文件和安全配置。Web 使用 React、Vite、Tailwind CSS v4；后端使用 Go（`apps/server-go`，chi 路由，发布为内嵌前端产物的单二进制）。非 Docker 本地开发保留可复现的演示数据，Docker 运行时通过同源 API 连接真实 Docker Engine 和数据库。

## 运行

```bash
bun install
bun run dev
bun run typecheck
bun run test
bun run build
bun run preview
```

Docker 开发分两个编排：根 `docker-compose.yml` 只跑前端 dev 与容器内 sshd；Go API 由 `apps/server-go/docker-compose.go-dev.yml` 提供（监听容器内 48101，只发布宿主回环 48102），vite 把 `/api/*` 同源代理过去。日常用 `bash scripts/dev.sh up` 一条命令显式选择两个编排文件、按正确顺序起两个栈并等待同源 API 就绪（`down` 停止、`restart-go` 让 Go 代码或环境变量变更生效）；单独运行根目录的 `docker compose up` 只启动前端。手动起时 macOS Docker Desktop 需要把 `ELYSIAN_DOCKER_MOUNT_ROOT` 指向已共享的宿主路径（仓库根 `.env` 会被脚本透传给两个栈），Linux 默认为 `/srv`。开发账号 `dev / dev-elysian` 需显式开启：`ELYSIAN_AUTH_DEV=1 bash scripts/dev.sh up`。

Docker 安全页管理 Go 开发容器中的 Linux 环境；正式 systemd 安装版管理宿主环境。Go 容器启用 UFW 时，保底规则开放实际内部 API 入口 48101，启动前同步恢复并核验 IPv4 与已启用的 IPv6；恢复失败拒绝启动。该规则只作用于 Go 容器，宿主映射保持回环；正式安装版只保护配置的前端入口，后端不开放。入口规则不能经面板删除、修改或拒绝，端口转发和防扫描避开前后端。安全系统命令限时 30 秒，安全代理限时 65 秒；普通 JSON 读取限时 15 秒、写入限时 60 秒（包括响应体）。写超时显示「操作结果尚未确认」，不自动重放，安全页重新读取事实；错误解除忙碌并提供重试，采集失败不把旧内存值显示为当前读数。

浏览器部署联调使用独立状态卷：`ELYSIAN_AUTH_DEV=1 ELYSIAN_GO_STATE_VOLUME=elysian-browser-qa-state bash scripts/dev.sh up`。保持该变量使用 `restart-go`／`down`；切回日常状态时去掉变量并运行 `bash scripts/dev.sh restart-go`，原卷保留。联调卷与日常卷分别保存凭据、任务和数据，浏览器测试不要往日常卷写入 fixture。容器重建使系统文件回到镜像默认值；验证已启用 UFW 的启动恢复应使用 `docker restart elysian-go-dev-go-1`，保留容器内规则文件。

Go 后端的开发与门禁一律在 Docker 容器内跑：`bash apps/server-go/dev-check.sh ./...`（缺省全量，可传包路径缩小范围）。宿主机命令只覆盖前端与契约包：`bun run test` 覆盖 web 和契约包。

顶栏系统负载读数条合并两个口径：这台机器的 1 分钟 load average（每拍随 `resource/sample` 事件流更新，1/5/15 三档列在明细里）与 Go 后端单进程的实际常驻内存（每五秒读取，单位为 MiB；Linux 优先使用 `/proc/self/smaps_rollup`，回落到 `smaps`，仅有 `statm` 时以 ≈ 标注近似，无法读取时显示不可用）。任一路没到就显示占位，不把缺失当成 0。读数条只显图标与两个数，名称由按钮的 `aria-label` 与悬停提示承载，不显百分比——百分比与仪表盘的「内存占用率」同屏会被读成同一口径的两个数。点击展开分节明细：机器负载三档、面板常驻内存（RSS）与 Go 运行时两组口径，两套口径不能相加，理由写在「Go 运行时」标题右侧问号的浮层里。占比以 `/proc/meminfo` 的系统总内存为参照（容器内属于宿主 Linux 内核，不表示容器限额），连同这个分母一起显示在明细中，总量不可读时不推断百分比；系统总内存达到 1024 MiB 时以 GiB 展示。内存采样不主动触发垃圾回收，不包含浏览器、开发启动器或其他容器。

Docker 开发入口只绑定宿主回环地址 `127.0.0.1:48100`；正式 systemd 安装版通过服务器 IP 与前端端口访问，后端始终监听回环。挂载 Docker socket 等价于授予宿主级容器管理权限，应限制能够访问面板的网络。面板有单管理员登录：服务端会话加 HttpOnly Cookie，除四条鉴权豁免路径（`/api/health` 与 `/api/auth` 的 login、session、logout）外，全部 `/api/*` 读写都要求已登录会话。同机回环上的自有工具复用浏览器本就按 host 共享的这枚会话，回跳地址由服务端按白名单裁决（`docs/adr/0017-*`），面板仍是单用户、不含多租户。

## 部署

源码部署入口是 `sudo bash scripts/install.sh`（Ubuntu/Debian systemd，x86_64／arm64）：按官方校验安装 Go 与 bun，以 `elysian-build` 无特权账号构建内嵌前端的 Go 单二进制，安装版本目录与维护工具、创建 systemd 服务。默认入口 `http://<服务器 IP>:48100`，后端固定 `127.0.0.1:48101`。UFW 仅添加面板前端 TCP 规则并清理精确识别的面板后端遗留规则，保持原启停状态；云安全组、域名反代和 HTTPS 由部署者管理。首启初始密码打印在 stdout。忘记密码时执行 `HOME=/var/lib/elysian /usr/local/bin/elysian resetpwd`。完整部署与恢复说明见 [部署指南](scripts/README-deploy.md)。

系统设置提供修改密码、面板端口、重启和源码更新。正式端口的唯一配置来源是 `~/.Elysian/config/panel-network.json`（整数 1–65535、端口互异），损坏时拒绝启动，不回落默认值。端口迁移检查宿主监听、SSH 配置、网站登记与运行／停用容器预留端口，先开放新前端、切换并检查两入口与页面资源，再删除旧前端规则；交换端口时先撤销即将成为后端的面板放行规则。共享或非面板规则冲突明确中止，不清空 UFW。端口与版本变更保留会话；改密码仍使全部会话失效。Docker 开发与本地演示显示「仅支持 systemd 安装版」。既有安装须先运行升级后的安装脚本完成一次维护能力引导。

在线更新固定来自 [Tianyi822/Elysian](https://github.com/Tianyi822/Elysian) 的实际默认分支，检查后锁定完整提交 SHA，经 GitHub 源码归档 API 下载、安全解包，使用 `bun install --frozen-lockfile` 和 `go build -mod=readonly` 构建。安装与在线更新共用 [构建脚本](scripts/build-release.sh)，在线更新不重跑完整安装。构建上限 30 分钟，旧面板在构建期间继续服务；切换前停服备份配置及持久化数据，健康等待 60 秒，检查前后端、页面静态资源与运行提交，成功保留当前及上一成功版本，失败恢复程序、数据、配置和本次涉及的规则。仓库未公开、网络或限流错误保留当前程序。

维护由 `systemd-run` 启动当前程序副本执行，面板停服后任务继续运行。端口、重启与更新共用持久化任务、跨进程文件锁和请求提交编号；重复提交返回同一任务，并发维护返回 409。维护开始前等待已经进入的写请求结束，正在获取源码或部署的网站任务会阻止维护，维护期间拒绝新的配置写入。任务、阶段与分页日志位于 `state/panel-maintenance`，切换备份位于 `backups/panel-maintenance`，版本位于 `/opt/elysian/releases`，当前入口为 `/opt/elysian/current`。systemd 启动前恢复未提交的中断事务；恢复失败拒绝启动并保留错误与备份。接口为 `GET /api/panel`、`PUT /api/panel/ports`、`POST /api/panel/restart`、`GET/POST /api/panel/update`、`GET /api/panel/tasks/:id?offset=0`；执行返回 202 和任务 ID，沿用会话、同源守卫与操作审计，仅迁移任务的健康探测临时允许提交请求的旧 Origin 跨端口访问。

## 数据库页

Docker 环境中的 MariaDB、MySQL、Redis 使用 `/api/databases` 和数据库协议 WebSocket。创建时必须输入明确的版本标签；缺少镜像时先拉取，再创建容器与专属持久卷，或验证现有容器的引擎、版本、管理员和普通账号后接管。MariaDB/MySQL 卡片对应逻辑库；Redis 卡片对应容器的 DB 0。访问范围分别映射到宿主回环端口、容器网络以及显式确认的所有宿主网卡端口。

普通删除只删除 SQL 逻辑库或清空 Redis DB 0，保留容器和卷。最后一个 SQL 逻辑库删除后显示空容器卡片，可复用容器或单独删除容器及专属卷；删除容器前会检查其他数据库。创建失败的登记显示待处理状态，可修复后核对。容器外部停机、删除和数据库状态变化由列表刷新反映。

数据库卡片的终端由服务端建立数据库协议连接，使用受限普通账号，不启动 Shell 或数据库命令行客户端。终端有限制输入、输出、执行时间、空闲时间和并发数；Redis 响应在协议读取阶段限制字节数，SQL 驱动按行输出并限制结果总量。普通账号仅拥有目标 SQL 库权限；Redis 普通账号使用 ACL 排除危险命令。数据库列表不返回密码；点击复制时才从服务端读取，响应禁止缓存。服务端登记与凭证保存在 `~/.Elysian/config/databases.json`，文件权限为 `0600`。

Docker 环境中的 SQLite 使用面板持久卷 `~/.Elysian/data/sqlite`：可新建空库、上传单个独立 SQLite 快照、在受限数据库协议终端内读写、下载一致性快照，以及确认后删除实际文件。上传上限为 256 MiB，单库上限为 1 GiB，托管 SQLite 总量上限为 4 GiB；WAL 模式原库须先导出独立快照。文件登记位于 `~/.Elysian/config/sqlite-databases.json`，中断的创建、上传或删除会显示待处理状态。SQLite 终端允许常用查询、增删改、表/索引/视图 DDL 与事务语句，不支持文件操作、扩展加载、触发器或虚拟表创建。非 Docker 本地开发中的 SQLite 与其他数据库仍是演示状态。

## 网站项目部署

添加项目与重新部署共用三步流程：上传 ZIP／tar.gz 或获取 HTTPS Git → 选择识别出的目录、构建工具、入口与精确版本 → 测试、构建并部署。支持普通 Java、Maven／Gradle（优先项目 Wrapper）、Node、Go、Python 与 HTML；可明确选择已构建产物跳过测试和构建。Git 支持分支、标签、提交与一次性私有令牌，准备后固定实际提交；令牌只用于临时拉取，不写登记与日志。启动命令保持空值，通过「采用建议」或手动填写确认；多入口、多工具与多产物由用户选择。

构建使用一次性非特权容器，每个项目使用独立运行容器。Java 构建 JDK 与运行 JRE 分开设置，Node 可选择服务或 Nginx 静态站点；静态站点的构建版本与运行环境分别记录。构建和测试期间旧项目继续运行，新容器内部端口就绪后完成发布，失败恢复旧版本；当前及上一成功版本保留供回滚。任务支持取消、补充配置继续执行和重新部署；关闭弹窗或刷新后通过「部署任务」恢复查看。未发现测试、测试通过与明确跳过分别显示。

默认单构建并发、2 CPU／2 GiB、20 分钟超时；压缩包上限 512 MiB、展开上限 2 GiB、10 万条目，拒绝路径穿越、链接、特殊文件与损坏包。服务端可通过 ELYSIAN_DEPLOY_CONCURRENCY、ELYSIAN_DEPLOY_CPUS、ELYSIAN_DEPLOY_MEMORY_BYTES、ELYSIAN_DEPLOY_TIMEOUT_SECONDS、ELYSIAN_DEPLOY_ARCHIVE_BYTES、ELYSIAN_DEPLOY_EXPANDED_BYTES、ELYSIAN_DEPLOY_ENTRIES 调整。来源位于 ~/.Elysian/tmp/website-sources，保留 24 小时；任务与日志分别位于 state/website-deployments、logs/website-deployments，保留 30 天；重启中断的任务明确标记且不自动重新发布。旧项目按人工部署项目兼容读取。SSH Git、WAR／Tomcat、提交触发与多环境发布不在支持范围。

真实容器验收需在 Docker 开发后端中显式执行 ELYSIAN_DEPLOY_INTEGRATION=1 go test ./internal/websites -run 'TestDeploymentReal' -timeout 40m；测试会拉取官方精确版本镜像，只创建并清理自己的测试项目。设计与接口约定见本地 [ADR-0018](docs/adr/0018-website-build-and-deployment-pipeline.md)。

## 结构与边界

网站项目通过容器运行，Java、Node、Go、Python 的版本由后端自动获取：语言官方正式发布记录与 Docker 官方镜像精确标签取交集，包含五年前版本线及历史正式补丁，排除预发布、快照和浮动标签。添加项目窗口通过同源 API 读取目录并支持版本号搜索。目录缓存六小时，过期后按请求自动刷新，获取失败时明确提示并保留已有缓存；缓存位于 `~/.Elysian/state/website-runtime-catalog.json`，生产代码不维护固定版本表。`bun run check:website-runtimes` 可诊断官方来源与镜像库的自动获取路径；本地演示仍使用可复现 mock。

- `apps/web/`：工作台页面、store、HTTP/WebSocket 与 mock adapter。
- `apps/server-go/`：Go 后端（chi）：同源 API、Docker Engine 调用、数据库协议与本机操作。
- `packages/foundation/contracts/`：跨端类型与纯常量。
- `CONTEXT.md`、`AGENTS.md`、`docs/`：本地设计文档，不进入版本库。

没有接入真实 Kubernetes、云平台或 Agent 推理。真实数据库的账号边界与请求守卫已经实现；面板已落地单管理员登录与服务端会话鉴权，多租户与人员级权限仍待后续完成。SQL 驱动会先解码单个结果行再执行应用侧输出截断，极端超大单行仍可能造成瞬时内存峰值；不要把此版本当作不可信用户可访问的数据库代理。所有 Docker 和数据库操作均具有真实效果，操作前应核对目标容器、版本、端口与删除确认内容。
