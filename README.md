# Elysian

Elysian 是 Agent 辅助的运维工作台，用于查看主机状态并操作容器、数据库、文件和安全配置。Web 使用 React、Vite、Tailwind CSS v4；后端使用 Go（`apps/server-go`，chi 路由，发布为内嵌前端产物的单二进制）。非 Docker 本地开发保留可复现的演示数据，Docker 运行时通过同源 API 连接真实 Docker Engine 和数据库。

下拉选择统一复用 Web 的 `components/SelectDropdown`，可自由输入的本地候选字段复用 `components/SuggestionInput`；使用 Radix 浮层、自绘触发器与选项，支持双主题、键盘选择、弹窗内滚动与窄屏避让，不使用系统级 `<select>` 或 `<datalist>`。视口窄于 768px 时，安全、Docker、数据库、平台日志与设置的顶栏页签，以及仪表盘的时间范围，一律改显这类下拉。

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

Go 后端的开发与门禁一律在 Docker 容器内跑：`bash apps/server-go/dev-check.sh ./...`（缺省全量，可传包路径缩小范围）。宿主机的 `bun run test` 经 workspace 脚本运行 Web 的 Vitest 测试、Bun SQLite 测试及契约包的独立 Node 环境测试；契约包可单独执行 `bun run --filter @elysian/contracts test`。`bun run typecheck` 同时检查 Web、契约包源码及两者的 Vitest 测试。

顶栏系统负载读数条合并两个口径：这台机器的 1 分钟 load average（每拍随 `resource/sample` 事件流更新，1/5/15 三档列在明细里）与 Go 后端单进程的实际常驻内存（每五秒读取，单位为 MiB；Linux 优先使用 `/proc/self/smaps_rollup`，回落到 `smaps`，仅有 `statm` 时以 ≈ 标注近似，无法读取时显示不可用）。任一路没到就显示占位，不把缺失当成 0。读数条只显图标与两个数，名称由按钮的 `aria-label` 与悬停提示承载，不显百分比——百分比与仪表盘的「内存占用率」同屏会被读成同一口径的两个数。点击展开分节明细：机器负载三档、面板常驻内存（RSS）与 Go 运行时两组口径，两套口径不能相加，理由写在「Go 运行时」标题右侧问号的浮层里。占比以 `/proc/meminfo` 的系统总内存为参照（容器内属于宿主 Linux 内核，不表示容器限额），连同这个分母一起显示在明细中，总量不可读时不推断百分比；系统总内存达到 1024 MiB 时以 GiB 展示。内存采样不主动触发垃圾回收，不包含浏览器、开发启动器或其他容器。

Docker 开发入口只绑定宿主回环地址 `127.0.0.1:48100`；正式 systemd 安装版通过服务器 IP 与前端端口访问，后端始终监听回环。挂载 Docker socket 等价于授予宿主级容器管理权限，应限制能够访问面板的网络。面板有单管理员登录：服务端会话加 HttpOnly Cookie，除四条鉴权豁免路径（`/api/health` 与 `/api/auth` 的 login、session、logout）外，全部 `/api/*` 读写都要求已登录会话。面板采用单端登录：`admin` 与开发账号 `dev` 共用唯一管理员会话，成功登录原子替换全部旧会话并关闭其已建立的终端连接与 Ely 回答输出流；旧浏览器下一次 API 请求收到 401 后回到登录页；前台页面每 15 秒静默检查会话，切回页面或恢复网络时立即检查，后台检查不延长空闲期限，密码错误、限流或会话写入失败不影响原会话。同一浏览器共享 Cookie 的标签页仍可同时使用；已有多会话在下一次成功登录时统一失效（决策见 `docs/adr/0022-single-session-login.md`）。同机回环上的自有工具复用浏览器本就按 host 共享的这枚会话，回跳地址由服务端按白名单裁决（`docs/adr/0017-*`），面板仍是单用户、不含多租户。

## 部署

源码部署入口是 `sudo bash scripts/install.sh`（Ubuntu/Debian systemd，x86_64／arm64）：按官方校验安装 Go 与 bun，以 `elysian-build` 无特权账号构建内嵌前端的 Go 单二进制，安装版本目录与维护工具、创建 systemd 服务。默认入口 `http://<服务器 IP>:48100`，后端固定 `127.0.0.1:48101`。UFW 仅添加面板前端 TCP 规则并清理精确识别的面板后端遗留规则，保持原启停状态；云安全组、域名反代和 HTTPS 由部署者管理。首启初始密码打印在 stdout。忘记密码时执行 `HOME=/var/lib/elysian /usr/local/bin/elysian resetpwd`。完整部署与恢复说明见 [部署指南](scripts/README-deploy.md)。

系统设置分为模型配置、账号安全和面板维护三个页签；模型配置使用 `/settings?tab=models`，账号安全提供修改密码，面板维护提供端口、重启和源码更新。正式端口的唯一配置来源是 `~/.Elysian/config/panel-network.json`（整数 1–65535、端口互异），损坏时拒绝启动，不回落默认值。服务启动时读取该文件一次，不热加载；手动修改后重启会重读，但不会同步迁移 UFW 规则，因此请使用「系统设置 → 面板维护 → 面板端口 → 保存并重启」。端口迁移检查宿主监听、SSH 配置、网站登记与运行／停用容器预留端口，先开放新前端、切换并检查两入口与页面资源，再删除旧前端规则；交换端口时先撤销即将成为后端的面板放行规则。共享或非面板规则冲突明确中止，不清空 UFW。端口与版本变更保留会话；密码表单通过校验后显示确认弹窗，确认修改使全部会话失效，取消保留输入。端口和更新说明由标题旁问号浮层展示；表单不常驻显示地址，维护连接超时保留新旧入口的手动链接。Docker 开发端口由 compose 与 Vite 配置独立控制；Docker 开发与本地演示的系统设置显示「仅支持 systemd 安装版」。既有安装须先运行升级后的安装脚本完成一次维护能力引导。

在线更新固定来自 [Tianyi822/Elysian](https://github.com/Tianyi822/Elysian)，可选「最新提交」或「最新发版」。最新提交跟随实际默认分支；最新发版使用 GitHub latest 正式 Release，排除草稿和预发布，将发布标签解析为完整提交 SHA。两种策略均锁定检查所得 SHA，经 GitHub 源码归档 API 下载、安全解包，使用 `bun install --frozen-lockfile` 和 `go build -mod=readonly` 构建。安装与在线更新共用 [构建脚本](scripts/build-release.sh)，在线更新不重跑完整安装。构建上限 30 分钟，旧面板在构建期间继续服务；切换前停服备份配置及持久化数据，健康等待 60 秒，检查前后端、页面静态资源与运行提交，成功保留当前及上一成功版本，失败恢复程序、数据、配置和本次涉及的规则。没有正式发版时显示空状态，不回落默认分支；仓库未公开、标签失效、网络或限流错误保留当前程序。切换策略清空旧检查结果，重新检查后才允许更新。更新日志按所选策略读取默认分支或最新正式发版对应的提交记录。

维护由 `systemd-run` 启动当前程序副本执行，面板停服后任务继续运行。端口、重启与更新共用持久化任务、跨进程文件锁和请求提交编号；重复提交返回同一任务，并发维护返回 409。维护开始前等待已经进入的写请求结束，正在获取源码或部署的网站任务会阻止维护，维护期间拒绝新的配置写入。任务、阶段与分页日志位于 `state/panel-maintenance`，切换备份位于 `backups/panel-maintenance`，版本位于 `/opt/elysian/releases`，当前入口为 `/opt/elysian/current`。systemd 启动前恢复未提交的中断事务；恢复失败拒绝启动并保留错误与备份。接口为 `GET /api/panel`、`PUT /api/panel/ports`、`POST /api/panel/restart`、`GET /api/panel/update?channel=commit|release`、`POST /api/panel/update`、`GET /api/panel/commits?channel=commit|release`、`GET /api/panel/tasks/:id?offset=0`；更新提交携带 `channel`、`targetCommit`、`releaseTag` 和 `requestId`，服务端核对同一策略的检查记录并持久化更新来源；省略策略兼容最新提交。执行返回 202 和任务 ID，沿用会话、同源守卫与操作审计，仅迁移任务的健康探测临时允许提交请求的旧 Origin 跨端口访问。

## 数据库页

Docker 环境中的 MariaDB、MySQL、Redis 使用 `/api/databases` 和数据库协议 WebSocket。创建时必须输入明确的版本标签；缺少镜像时先拉取，再创建容器与专属持久卷，或验证现有容器的引擎、版本、管理员和普通账号后接管。MariaDB/MySQL 卡片对应逻辑库；Redis 卡片对应容器的 DB 0。访问范围分别映射到宿主回环端口、容器网络以及显式确认的所有宿主网卡端口。

普通删除只删除 SQL 逻辑库或清空 Redis DB 0，保留容器和卷。最后一个 SQL 逻辑库删除后显示空容器卡片，可复用容器或单独删除容器及专属卷；删除容器前会检查其他数据库。创建失败的登记显示待处理状态，可修复后核对。容器外部停机、删除和数据库状态变化由列表刷新反映。

数据库卡片的终端由服务端建立数据库协议连接，使用受限普通账号，不启动 Shell 或数据库命令行客户端。终端有限制输入、输出、执行时间、空闲时间和并发数；Redis 响应在协议读取阶段限制字节数，SQL 驱动按行输出并限制结果总量。普通账号仅拥有目标 SQL 库权限；Redis 普通账号使用 ACL 排除危险命令。数据库列表不返回密码；点击复制时才从服务端读取，响应禁止缓存。服务端登记与凭证保存在 `~/.Elysian/config/databases.json`，文件权限为 `0600`。

Docker 环境中的 SQLite 使用面板持久卷 `~/.Elysian/data/sqlite`：可新建空库、上传单个独立 SQLite 快照、在受限数据库协议终端内读写、下载一致性快照，以及确认后删除实际文件。上传上限为 256 MiB，单库上限为 1 GiB，托管 SQLite 总量上限为 4 GiB；WAL 模式原库须先导出独立快照。文件登记位于 `~/.Elysian/config/sqlite-databases.json`，中断的创建、上传或删除会显示待处理状态。SQLite 终端允许常用查询、增删改、表/索引/视图 DDL 与事务语句，不支持文件操作、扩展加载、触发器或虚拟表创建。非 Docker 本地开发中的 SQLite 与其他数据库仍是演示状态。

## 文件上传与下载

文件页右键普通文件（含 ZIP、tar.gz）原样下载；目录自动打包为 `<目录名>.tar.gz`，保留顶层目录和空目录。右键文件或列表空白可「上传至当前目录」，右键目录可「上传至该目录」；搜索结果中的「当前目录」仍指页面路径。上传支持多选文件并逐项处理，同名普通文件须选择覆盖或跳过，目录、符号链接与特殊文件不可覆盖；窗口显示固定目标路径、进度、结果与取消入口。

传输经同源 `/api/files`：`POST /downloads` 准备文件，`GET /downloads/{id}` 领取一次性附件；`POST /uploads/check` 核对目标，`PUT /upload` 发送原始文件流。下载交给浏览器管理，不在前端整包缓存；目录在 `~/.Elysian/tmp/files-downloads` 内使用私有临时文件，打开后解除目录项，领取结束、取消、过期或进程退出即释放。下载 ID 与上传核对令牌绑定登录会话，领取／使用期限为 10 分钟；上传使用前核对令牌，流传完后再次核对目标，目标变化须重新确认。上传在目标文件系统私有暂存后原子发布，新建权限 `0644`，覆盖保留属主与权限；失败与取消回读目录，不自动重传。

默认单文件上传与单个临时归档各限 10 GiB，临时归档合计限 20 GiB；普通文件直接下载不设字节上限。目录打包并发 1、上传与下载共享传输并发 2、待领取下载最多 8 个；打包最长 30 分钟、单次传输最长 2 小时，目录上限 50,000 个条目与 64 层。根目录、系统虚拟目录和特殊文件不能下载；归档内部符号链接保存为链接、不展开目标。正在被外部程序修改的文件不提供一致性快照；数据库备份应使用数据库自身的快照或导出能力。外部特权进程在最终核对与覆盖发布之间仍有竞态窗口。本地演示只登记内存上传信息，下载明确提示无真实正文。规范见 [文件传输](docs/specs/2026-10-11-files-transfer.md)。

门禁：`bash apps/server-go/dev-check.sh ./internal/files ./internal/app ./internal/logs`。大文件专项验收在 Go 开发容器内执行：`ELYSIAN_FILES_LARGE_UPLOAD_TEST=1 go test ./internal/files -run TestUploadLargeStreaming -count=1 -v`、`ELYSIAN_FILES_LARGE_DOWNLOAD_TEST=1 go test ./internal/files -run TestDownloadLargeStreaming -count=1 -v`；各传输 3 GiB，使用专用临时目录自动清理并采样内存。

## 网站项目部署

添加项目与重新部署共用三步流程：上传 ZIP／tar.gz 或获取 HTTPS Git → 选择识别出的目录、构建工具、入口与精确版本 → 测试、构建并部署。支持普通 Java、Maven／Gradle（优先项目 Wrapper）、Node、Go、Python 与 HTML；可明确选择已构建产物跳过测试和构建。Git 支持分支、标签、提交与一次性私有令牌，准备后固定实际提交；令牌只用于临时拉取，不写登记与日志。启动命令保持空值，通过「采用建议」或手动填写确认；多入口、多工具与多产物由用户选择。

构建使用一次性非特权容器，每个项目使用独立运行容器。Java 构建 JDK 与运行 JRE 分开设置，Node 可选择服务或 Nginx 静态站点；静态站点的构建版本与运行环境分别记录。构建和测试期间旧项目继续运行，新容器内部端口就绪后完成发布，失败恢复旧版本；当前及上一成功版本保留供回滚。任务支持取消、补充配置继续执行和重新部署；关闭弹窗或刷新后通过「部署任务」恢复查看。未发现测试、测试通过与明确跳过分别显示。

默认单构建并发、2 CPU／2 GiB、20 分钟超时；压缩包上限 512 MiB、展开上限 2 GiB、10 万条目，拒绝路径穿越、链接、特殊文件与损坏包。服务端可通过 ELYSIAN_DEPLOY_CONCURRENCY、ELYSIAN_DEPLOY_CPUS、ELYSIAN_DEPLOY_MEMORY_BYTES、ELYSIAN_DEPLOY_TIMEOUT_SECONDS、ELYSIAN_DEPLOY_ARCHIVE_BYTES、ELYSIAN_DEPLOY_EXPANDED_BYTES、ELYSIAN_DEPLOY_ENTRIES 调整。来源位于 ~/.Elysian/tmp/website-sources，保留 24 小时；任务与日志分别位于 state/website-deployments、logs/website-deployments，保留 30 天；项目删除后真实历史任务继续保留并显示「历史部署成功 · 项目已删除」及完成时间，未创建项目的任务不会标记已删除。任务列表与详情的只读 `projectStatus` 按项目登记和发布记录现场计算（present／deleted／not-created），不迁移旧任务。测试残留只能按已确认的任务 ID 将任务文件和日志移入 backups，恢复时移回同 ID 文件并重启服务；重启中断的任务明确标记且不自动重新发布。旧项目按人工部署项目兼容读取。SSH Git、WAR／Tomcat、提交触发与多环境发布不在支持范围。

真实容器验收需在 Docker 开发后端中显式执行 ELYSIAN_DEPLOY_INTEGRATION=1 go test ./internal/websites -run 'TestDeploymentReal' -timeout 40m；测试会拉取官方精确版本镜像，只创建并清理自己的测试项目。设计与接口约定见本地 [ADR-0018](docs/adr/0018-website-build-and-deployment-pipeline.md)。

## 容器工作区

Docker 页的「工作区」集中保存 compose、`.env`、Dockerfile 和挂载配置，支持上传文件或目录、编辑文本、复制真实绝对路径、检查 compose 引用与构建镜像。文件保存在 `<mountRoot>/elysian/apps/<slug>`，登记表位于 `~/.Elysian/config/container-apps.json`；文件管理不依赖 Docker Engine 就绪，镜像构建需要引擎可用。compose 自检只检查可识别的路径引用，界面同时显示判定范围与未能判定的项目。面板不会执行 `docker compose up`，启动整套服务需在宿主机执行；本地演示模式仅使用内存数据。机制见 [工作区约定](docs/adr/0020-container-app-workspaces.md) 与 [镜像构建约定](docs/adr/0021-container-image-build.md)。

镜像构建派发前持久记录 `mayStillRun` 与派发阶段，仅收到 Docker Engine 完整结束响应后清除。派发后的取消、超时、断流或面板重启不能确认 daemon 已停止时，任务显示「构建停止结果未确认，资源保持占用」，保留工作区与镜像预留、阻止新的镜像构建，Agent 继续保留执行屏障；同名或同摘要镜像存在不能作为停止证明。尚未派发的取消和失败可正常收口。旧失败、取消或中断记录缺少派发证明时也保守保留，未确认记录不按 30 天清理；当前没有自动解除此状态的入口，需要运维核实 Docker 的实际执行状态后处理持久任务记录，不会自动重跑或根据镜像反推成功。

## Agent 能力封装

[agent/kardia](apps/server-go/internal/agent/kardia/) 管理插件、依赖、工具登记、事件和调用生命周期；[agent/tools](apps/server-go/internal/agent/tools/) 提供统一 Registry，[agent/harness](apps/server-go/internal/agent/harness/) 管理固定能力快照、授权、审批、资源锁、审计及恢复。平台工具、任务文件、Bash、技能脚本和 MCP 调用均经过 Registry；父进程先持久化派发决定，再签发绑定 operation、参数摘要、快照和 dispatchId 的内部单次授权，Registry 和域执行后端分别核验，直接调用与重复消费均拒绝。`internal/app` 为页面和插件注入同一组域实例，不向模型开放宿主 shell 或 Docker 传输器。平台能力与权限边界见本地 [ADR-0033](docs/adr/0033-agent-platform-tools-and-permissions.md)。

| 能力子包 | 已封装入口 |
| --- | --- |
| files／workspace | 授权业务目录文本列举、读写、复制、移动、删除；Task 工作区使用不可变候选版本和事务 CAS |
| Bash／scripts | 命令文本、工作区脚本及已加载技能脚本，经固定摘要镜像的受限容器执行 |
| docker | 脱敏摘要、镜像查询和拉取、安全模板创建、精确授权的容器启停重启与删除 |
| security／firewall | SSH、账号与安全状态、精确业务端口规则和 IP 解封；不开放管理入口变更 |
| database | 版本与实例发现、固定元数据和指标、逻辑库创建删除、受管容器及专属卷生命周期；不开放凭据或任意协议终端 |
| websites | 来源分析、构建部署、状态日志、启停、访问配置、回滚、删除和任务取消 |
| containerapps | 工作区文件、自检、内容快照、构建预览、提交、状态日志和取消；不执行 compose up |
| logs／platform／panel | 有界结构化日志、面板进程内存与本机资源采样（内存、CPU 使用率与负载、磁盘挂载占用）、依赖状态、面板信息及更新检查；不开放日志伪造、依赖安装或面板维护写操作 |

调用顺序为 `tools.Install(ctx, root, tools.Plugin, 能力插件...)` → `tools.RegistryFrom(root)` → `registry.Schemas()`／`registry.Execute(root, name, args)`；插件须按依赖顺序传入，装载失败会逆序回滚，宿主退出时逆序销毁返回的 fiber。工具登记跟随提供者的激活代，撤销后旧处理器不可调用；参数模式与调用参数均使用独立快照。接入示例见 [example_test.go](apps/server-go/internal/agent/tools/example_test.go)，边界与设计见本地 [ADR-0023](docs/adr/0023-agent-capability-tool-layer.md)。

审批策略由 harness 集中决定，工具的只读声明不能自行取得免审批权限。默认开放已确认的脱敏查询；普通聊天通过运行时选择卡片申请目录、网络或精确平台资源权限，确认前不能派发。旧运行及工作流继续使用固定 grant；发现资源不构成授权。登录身份、审批和执行配置、模型/MCP 配置、审计事实、系统目录和凭据路径始终禁止通过 Agent 修改。业务文件仅支持无链接、单硬链接的普通文本文件；复制与移动要求同授权根且目标不存在，写删要求原内容摘要。宿主 `rw` 是真实修改，不承诺自动回滚。Bash 的 `rm`、`mv`、重定向及脚本间接删除由容器、挂载权限与系统权限约束，不依赖命令黑名单。长任务采用持久任务引用、状态和分页日志；等待释放 Worker，资源锁与执行屏障保留到终态。提交超时按原 requestId 核实，不重投；停止聊天回复不会取消已接受的部署或构建任务。协议层每次模型请求最多提供 128 个工具定义，单条消息或模型响应最多包含 64 次工具调用；新 Run 的大目录通过按需加载保持更小的可见集，固定目录最多 512 项，超限明确拒绝。门禁为 `bash apps/server-go/dev-check.sh ./internal/agent/... ./internal/app ./cmd/elysian`，临时测试文件使用 `t.TempDir()` 自动清理；需要 root 可信祖先的隔离目录测试随用随建并登记清理。

聊天权限菜单每轮提交 `permissionMode` 并固定策略版本与决定来源：`ask` 对变更、Bash 和脚本逐项审批；`assist` 自动批准可恢复的 Task 工作区写入，以及无宿主写权限、无出网授权的隔离执行；`full` 免除已授权范围内的逐项审批，硬性禁区、资源身份、撤销和执行限额继续生效。MCP 的旧运行仍按原有显式信任规则执行。旧浏览器预览偏好统一迁回 `ask`，保留草稿、附件与未确认的精确请求。新聊天每轮提交 `authorizationMode:"on-demand"`，缺失范围必须显式确认，权限模式不能自行补充授权。输入区的运行时卡片显示操作、目标、权限及运行环境，展开可查看命令、镜像摘要、挂载和实际限额；默认「仅本次允许」，也可选择「本会话允许」或「拒绝」，点击确认后继续原 Run，一次决定同时完成授权与该次操作审批。拒绝成为工具结果，同一 Run 不重复申请等价权限，停止任务保持独立。

系统设置移除「执行配置」「资源授权」，旧 `?tab=execution`／`?tab=grants` 链接转向聊天页。聊天「本会话授权」查看和撤回已记住的允许项：平台权限绑定工具动作和精确对象，文件权限绑定工具动作、业务目录身份和读写方式；脚本允许在同一运行环境、目录和网络范围内执行不同命令，扩大范围须重新确认。MCP 绑定服务修订、目录摘要及工具；不能可靠识别目标时按完整参数匹配。允许项由服务端保存，刷新和重新登录后恢复，不跨会话继承；撤回阻止后续派发并停止相关执行容器与代理，停止未确认保留屏障。旧 profile/grant API 与历史修订继续兼容，不自动变成新会话免确认授权。设计见本地 [ADR-0041](docs/adr/0041-agent-runtime-authorization.md)。

服务端提供固定官方版本、架构和完整镜像摘要的 Bash、Python、Node 环境，默认 0.5 CPU、256 MiB、64 PID；实际执行时限取环境配置、工具限制与 Run 剩余时间的最小值。优先复用本机匹配镜像，缺失时在授权卡片明确列出下载动作；批准后异步准备并展示进度，可取消，失败后由管理员明确重试，结果未知先核实。环境准备不运行项目代码。

文件审批按固定工作区版本显示修改前后；宿主文件仅复用同一 Run 内摘要完全匹配的已确认读取回执，不为预览增加宿主读取。较大或非文本内容显示大小与摘要，缺少原文回执时明确标记仅摘要。宿主文件根还固定设备号和 inode，根被替换后拒绝继续操作；已有文件替换要求能够确认扩展 ACL 不会丢失，无法核验的平台保守拒绝替换。数据库创建／对账与镜像拉取使用独立持久任务；状态和日志使用观察锁、取消使用控制锁，不被原任务的资源锁阻塞。数据库取消后不能确认完成时仍保留未知状态及屏障。Agent 日志仅开放固定阶段、时间、状态或脱敏结构化投影，不把可能含源码秘密及应用凭据的自由输出送入模型。

## Agent 任务运行

Bash 的宿主目录挂载额外要求所有祖先由 root 持有且不可被组或其他用户写入，派发前有界遍历拒绝敏感文件名、链接、硬链接及特殊文件。授权根本身可由业务 UID 写入，实际访问仍受 UNIX 权限约束；目录不满足时拒绝执行。管理员应使用独立普通业务目录，并负责不在已授权目录中随后放入凭据。新模式文件根由已确认操作的独立授权事实解析，批准后立即可用；确认与执行固定并核对设备号、inode、读写权限和业务目录边界，单次复制／移动共用一个目录描述符，不累积到全局根列表。旧运行继续校验其固定 grant 和启动时目录身份。

真实部署保留 `tool-batch/v1` 与旧 `agent/v1` 的四条 Docker 只读工具兼容；新建和继续的单 Agent Run 使用 `agent/v2`。新 v2 会话默认选入已装配的 Agent 平台工具和 Task 工作区工具，旧显式环境继续由兼容 API 固定管理。工作区支持列举、读取、写入、复制、移动和删除；`task_bash_command` 接受完整 Bash 命令文本，`task_bash_script` 执行固定摘要的工作区脚本，新模式按需申请官方 Bash 环境，旧模式仍须选择已有 Bash profile。执行器固定 UID 65532、只读根文件系统、无特权、CPU／内存／PID／时间限额；目录和网络必须被明确授权，出网仅经精确授权代理。全部入口要求管理员会话与同源请求，浏览器断连、退出登录或登录会话替换不取消已接受任务。

Web 的「Ely 智能体」在 `/agent` 提供文本与图片聊天。模型须声明文本与工具调用能力；首条消息创建服务端 Task，后续续用，公开历史以服务端为准；消息接口按 Run 快照回填每轮模型、服务与思考等级，相邻轮次之间显示居中的「模型已切换」「思考等级已切换」分隔线，旧记录缺快照时不显示。答复按 Markdown 渲染，回答增量约 40ms 按词块平滑展示；思考默认折叠一行，展开后在最高 192px 内滚动。刷新、返回与重新登录恢复选中会话，URL `?session=` 优先；浏览器按会话保存草稿、附件、选择和精确 pending 请求，退出登录清空展示而保留历史。失败保留输入，手动重试沿用 requestId。图片上传与模型输入规则保持不变。权限模式与思考等级随每轮提交，在运行及未确认期间锁定；模式与策略版本进入 Run 快照和幂等核对。其余六个 Agent 路由保持空白，所有入口不显示顶部 tab 栏；设置仍复用 `modelSettings`，输出 SSE 仅回读事实，不自动重新提交。本地无后端演示禁用发送，不模拟回复。`GET /api/agent/runtime` 报告各项装配状态，具体可用性由配置和执行结果确认。

回复中的代码块按声明语言高亮，深浅主题分别配色，并提供语言名称与逐块复制按钮；支持常用运维和开发语言（含 JSX、TSX、TOML 及常见别名）。未知语言、未注明语言或单块超过 64 KiB 时完整显示纯文本，不猜测语言、不解析原始 HTML；代码与宽表格可横向滚动，流式追加保留代码块的滚动位置。

回复过程按模型推理请求顺序保留思考、正文与工具调用，后续请求追加到下方；各段思考独立折叠，工具状态紧跟名称并留 8px 间距，成功文字与图标为绿色，失败、拒绝、过期和撤销为危险色，展开后读取参数与分页调用结果，长内容在有界区域内滚动。`GET /api/agent/runs/{id}/timeline` 从原始记录恢复时间线，`/output` SSE 的 `timeline` 字段传输同结构快照并保留旧字段；工作记忆与其他内部整理请求不进入聊天。终答公开消息原位确认对应正文，用户消息、公开最终答复与停止后保留的最终片段可复制；过程正文不提供消息级复制或预留空白，代码块复制独立保留，思考与工具过程不提供复制。失败、超时和停止确认后保留已收到的未完成片段，刷新可恢复，失败与中断的运行在时间线尾部显示「运行未完成：原因」；旧记录中未保存的片段无法补回。仅当前生成段播放逐词动画，向上阅读时暂停自动跟随，迟到读取不得覆盖更新的流式快照。

聊天输入区模型选择器左侧的圆环表示最新聊天 Run 最近一次已确认推理的输入加输出 token 占该 Run 固定模型上下文容量的比例，每次确认响应后更新。悬停、键盘聚焦或触屏轻点打开上方浮层，列出对应模型、上下文用量与进度，并按消息、系统工具、其他、技能、系统提示词、MCP 工具展示本地估算的分类数量和占估算总量的比例。浮层另列本轮累计实际 token、缓存 token，以及全部已完成请求的缓存输入 token 总和除以输入 token 总和得到的平均缓存命中率；累计和平均值包含内部整理请求，上下文及分类仅取最近一次推理。实测未知值不补零，分类估算独立标注，不替代圆环实测值；未采集分类的旧记录保持未知。新 Run 尚无确认响应时显示中性空环，切换所选模型不改写既有容量。普通聊天的提示词按「稳定前缀 + 尾部当前状态」排列：system、原始目标、工作记忆与技能索引在头部，已加载技能正文、知识召回、共享资料与按覆盖游标排序的既有事实随后，本轮用户输入与最新任务计划放在最后一条当前状态消息；`update_plan` 更新与续轮输入变化只改最后一条消息，system、工具定义与既有事实构成的稳定前缀仍可复用。可见工具定义按「常驻与 eager 稳定前缀 + 动态定义按持久搜索回执加载顺序尾部追加」排列，新加载只追加、淘汰只移除尾部动态集合，重启与恢复顺序一致。Anthropic 格式在合并消息后使用三个默认五分钟的 `cache_control` 断点（最后 system、最后工具、合并后倒数第二条消息末块），最后一条易变当前状态消息不设断点、第四处刻意不用，不增加 beta 头或 TTL；实际命中由供应商决定：DeepSeek 的 Anthropic 端点忽略断点、命中来自服务端自动前缀缓存，DeepSeek 与智谱的标准接口按完全一致前缀自动缓存（智谱建议重复前缀 500 token 以上更易命中）；缓存命中按 `cache_read_input_tokens` 与 `prompt_tokens_details.cached_tokens` 读取，缺失时回落 DeepSeek 扁平 `prompt_cache_hit_tokens`；智谱 Coding Plan 套餐按官方口径不适用上下文缓存。策略见本地 [ADR-0035](docs/adr/0035-agent-prompt-cache-strategy.md)。

图片仅支持 JPEG／PNG，不限制每条消息的图片张数，压缩后的图片合计不得超过 8 MiB；每张在浏览器独立处理至不超过 1 MiB、单边不超过 6000 像素。已合规图片保留原字节；超限时优先保留尺寸与细节，PNG 先尝试无损重编码，透明图片保留 PNG；不透明图片按 JPEG 质量 0.95 至 0.80 寻找可用最高档，仍超限才逐步缩小尺寸，每次都从原图绘制。整批处理并核对总量成功后才按序逐张上传，每张独立提供 120 秒上传时限，中途失败或取消停止后续上传，后端继续校验格式、尺寸与限额；失败保留草稿。

浏览器仅缓存待发送、待确认与重试所需的图片；服务端确认接受后清除本次发送的本地字节和预览，历史图片从鉴权接口读取。未确认请求继续沿用精确附件引用与 requestId，手动重试不重复压缩；升级前的超限已上传图片在下一次新发送或编辑重发前压缩并保存替代引用，旧版仅本地、未上传附件须移除后重新添加。

聊天的操作校验、压缩／上传、发送、停止与会话操作错误通过右上角消息组件反馈；待确认发送仍在原位提供手动重试。生成失败、页面加载、处理／上传进度、正在停止，以及同步和模型读取错误与重试入口继续留在页面状态区。

聊天支持停止回复与编辑最后一条用户消息：生成期间发送按钮切换为「停止回复」，取消经既有 Run 接口执行，确认结束后保留部分回答和思考并标记「已停止」，刷新可恢复。空闲时最后一条用户消息可原位编辑，底部草稿独立保留；重发经续轮请求的可选 `replaceMessageId` 指定当前消息，以新 requestId 接受，未确认重试沿用原标识。服务端在同一事务中替换旧轮、恢复该轮开始前的记忆快照并创建新 Run；旧执行记录留存，公开历史和后续上下文排除旧轮。新消息的 `replacesMessageId` 指向最初被替换的消息，连续编辑保持该标识，供多标签增量同步。新回复的回答、思考和流式展示从空白开始。

全局资源与容器事件在支持 Web Locks 和 BroadcastChannel 的同源页面间共享一组连接，连接持有页退出后由其他页面接管，后加入页面回放最近采样和状态。后台及离开页面释放展示订阅，回到前台重新连接；Ely 输出和运行轮询同样只在前台保留，后端已接受任务继续运行。这样避免每个标签重复占用 HTTP/1.1 连接额度、导致普通读取在浏览器排队超时；无共享能力的浏览器保留原订阅及后台释放行为。

Ely 采用左侧会话列表：进入聊天页不自动折叠主导航，继承进入前的收展状态；1100px 及以上点开会话列表时折叠主导航为 64px 图标栏并显示 240px 会话栏，正文最大 800px；展开主导航时暂收起会话栏，聊天内的收展改动不影响其他页面。768–1099px 的会话列表使用左侧抽屉，低于 768px 的主导航也使用抽屉，两者互斥。列表支持新建、切换、刷新、分页与运行中／发送待确认状态，不提供搜索、重命名或删除；静默刷新更新列表内容并保留已加载末页的游标，显式刷新才从第一页重建分页。会话栏使用贴在右侧边缘中部的箭头把手收起，收起后把手留在左侧边缘，点击即可展开；窄屏抽屉沿用同样的关闭把手，并支持 Escape 和关闭回焦。长标题截断且不撑宽 240px 会话栏，抽屉使用实际面板毛玻璃样式。运行中可切换或新建其他会话，只有消息提交在途时暂锁切换；当前运行会话仍禁止重复发送和切换模型。

登录状态由统一会话闸门检查，同网关和回跳参数的在途探测共用请求；页面访问策略不再额外探测登录。受保护的 HTTP、SSE、XHR 与 iframe 下载请求在发起时记录登录代次，旧请求迟到的 401 只使该请求失败，不撤销之后成功建立的新登录。明确拒绝显示无权限，读取失败显示可重试错误，Ely 的加载、拒绝和错误状态卡沿用桌面 24px、窄屏 16px 内距并避让窄屏主导航。回答输出流在新登录替换、登出或面板改密时立即撤销，CLI 改密和自然过期每秒被动复验；开流与重连不延长登录空闲期。

以下表格路径均以 `/api/agent` 为前缀。

| 运行与会话接口 | 用途 |
| --- | --- |
| `POST /runs` | 提交 `{requestId,kind:"tool-batch",steps:[{tool,args:{}}]}`；落盘返回 202，同 requestId 和输入回读 200，冲突 409 |
| `GET /runs?status=&requestId=&sessionId=&taskId=&workflowId=&cursor=&limit=`、`GET /runs/:id` | 分页查询或读取运行详情、固定快照、预算与状态 |
| `GET /runs/:id/calls?cursor=&limit=`、`GET /runs/:id/events?after=&limit=` | 工具结果与事实事件；after、seq 为十进制字符串 |
| `GET /runs/:id/timeline`、`GET /runs/:id/output` | 推理请求、思考、正文和工具状态的只读时间线；输出 SSE 附带同结构 timeline，工具结果展开时经 Calls 分页读取 |
| `POST /runs/:id/cancel` | 请求取消，响应中的状态才是停止事实 |
| `GET/POST /model-services`、`PUT /model-services/:id` | 共享服务信息与多模型列表；整组保存须 expectedRevision，一次原子写入 |
| `POST /model-services/discover` | 以表单连接信息读取远端模型目录；可按 serviceId/expectedRevision 沿用同地址的凭据，不保存配置 |
| `GET/POST /model-profiles`、`PUT /model-profiles/:id` | 模型公开配置与不可变修订；更新须 expectedRevision，服务所属模型经服务端点更新 |
| `GET/POST /sessions`、`GET /sessions/:id` | 创建 `{title,modelProfileId,modelRevision}` 或查询会话；列表可加 `sort=activity` 按活动时间分页，后续页透传返回的 cursor，并可设置 limit；活动游标与缺省创建顺序的数字游标不能混用 |
| `PUT /sessions/:id/model` | 空闲时提交 `{modelProfileId,modelRevision}` 切换模型，返回能力与缓存提示 |
| `GET /sessions/:id/messages?after=&limit=`、`GET /sessions/:id/tasks` | 公开对话和任务分页 |
| `POST /sessions/:id/tasks`、`POST /tasks/:id/runs` | 新任务或继续输入：`{requestId,content,extensionMode?:"enabled",permissionMode?,reasoningLevel?,skills?,resources?,prompts?}` |
| `GET /tools?sessionId=&domain=&available=` | 鉴权工具目录，返回元数据、选择状态与可用性 |
| `GET /tasks/:id`、`GET /tasks/:id/memory?revision=`、`GET /runs/:id/model-requests` | 任务、工作记忆和模型过程；推理请求包含供应商返回的思考文本或公开摘要，不含签名、加密内容与 debug；`request_index=-1` 的 input-material 组记录不在此接口返回，资料组执行事实在 operations 中核对 |
| `GET/PUT /sessions/:id/environment` | 读取或以 `{expectedRevision,environment}` 更新会话环境，首次 expectedRevision 为 0，仅空闲时允许修改 |
| `GET /runs/:id/operations`、`GET /runs/:id/context-items` | 读取本轮的规范化操作与实际载入资料 |
| `GET /approvals?runId=`、`POST /approvals/:id/decision` | 最多 200 条，可精确过滤 Run；决定为 `{decision:"approved"}` 或 `{decision:"denied"}` |
| `GET /execution-barriers`、`POST /execution-barriers/:id/reconcile` | 最近 200 条执行屏障；核实提交 `{decision:"confirmed-completed"或"confirmed-stopped",evidence}` |

一个 Session 包含多个 Task，一个 Task 可有多轮 Run。排队、执行、等待审批、资源或域任务以及整理期间会话保持忙碌，拒绝新输入与环境切换；已接受的同一请求可幂等回读。环境包含 `skills`、`servers`、`executionProfiles`、`grants` 的 `{id,revision,digest?}` 引用，以及 `tools`、`resources:[{serverId,uri}]`、`trustedReadOnly`。Bash 的 `profileId` 必须对应环境内已启用的 Bash 配置，`grantId` 只能引用本轮固定 grant；grant 的 `resources:[{domain,id,access}]` 授予精确平台目标，目录 grant 不授予平台管理权限。所有配置固定具体修订，MCP 目录固定 digest，后续修改不改变已接受 Run；派发前仍复核最新停用与撤销状态。省略 `extensionMode` 时，技能和服务器仍须显式选入环境；普通聊天新建、续聊和编辑重发提交 `extensionMode:"enabled"`，在接受下一轮时自动固定最新已启用 Skill 和已有探测目录的 MCP 工具，覆盖手选旧工具修订，不写回会话环境。资源和提示模板继续显式选择并绑定原服务修订，工作流继续使用实例固定环境。本轮显式技能引用须匹配最终修订，MCP 提示内容不成为系统指令。浏览器 pending 保存精确请求；旧 pending 不补字段，相同 requestId 重试与审批恢复沿用原快照。

模型设置按服务管理：名称、`provider`（`openai-compatible`、`deepseek` 或 `zhipu`）、`apiFormat`、`baseUrl`、`active` 与可选 `credential` 共用，每个服务可配置 1–64 个模型，各模型独立设置 `name`、`model`、`contextTokens`、`outputTokens`、`capabilities`（文本、工具调用、图片/视频/PDF 输入、JSON 结构化输出、原生联网搜索、系统消息、支持的推理等级与来源） 与 `enabled`。API 格式由用户选择 `chat-completions`、`anthropic-messages` 或 `responses`，均须显式声明；不迁移旧配置。整组新增、编辑、移除和共享凭据以一次 CAS 原子写入 `config/agent/models.json`，为各模型追加不可变修订。服务停用保留各模型开关，移除模型阻止新运行并保留历史修订。

DeepSeek 预设只填写服务名称和 `https://api.deepseek.com`；Anthropic 格式基址为 `https://api.deepseek.com/anthropic`，启用时必须填写 API Key。新建模型列表为空，「添加模型」新增空白模型标识与名称；旁边的「获取模型」读取服务目录，搜索、勾选后才加入草稿，不自动选择或保存。DeepSeek 目录按[官方接口](https://api-docs.deepseek.com/zh-cn/api/list-models/)经共享基址的 `GET /models` 获取，使用 Bearer 鉴权，与生成协议独立；自定义 Chat/Responses 使用基址后的 `/models`，Anthropic 使用 `/v1/models`（基址已有 `/v1` 时只追加 `/models`）。目录返回容量时采用其数值，未提供时沿用表单缺省容量；未知模型默认上下文 64000、最大输出 4096 token。DeepSeek Flash 与 Pro 按[官方参数](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)填入上下文 1M、最大输出 384K（393216）；Flash 支持图片输入，Pro 不支持，两者支持 JSON 输出、工具调用、系统消息与 disabled/low/high/max 推理等级（官方默认档 high）。原生联网搜索、视频与 PDF 不作支持声明。已有模型可显式应用官方参数；表单不提供工具调用、结构化输出、原生联网搜索和对话中系统消息的手动勾选，新模型默认声明工具调用、结构化输出与系统消息，原生联网搜索默认不作支持声明，官方预设优先，编辑已有模型沿用已保存的能力值。多模态输入只提供图片和视频的能力声明，文本为新模型默认能力，PDF 文件上传不作为模型输入类型开关；已有文本与 PDF 声明随配置保留。图片、视频与有序推理等级可编辑，并随模型修订保存；能力来源由默认配置、目录或官方预设填入，编辑已有模型时沿用原值，表单不展示来源字段。高级能力为支持范围声明，当前 Ely 运行仍使用文本与工具，未接入 PDF 自动提取或模型原生文档输入；DeepSeek Chat 的思考等级只提供模型声明的档位（关闭／低／高／最高），未选择时落在模型声明的默认档（优先「高」），实际单次输出按思考模式取官方默认上限（非思考 8192、思考 65536，`reasoning_effort=max` 为 131072），并受模型声明的最大输出与运行限额收紧。服务不支持目录时可继续手动添加。自定义服务支持三种兼容协议，本机服务可不填写凭据。凭据只写不回显，省略沿用、输入替换、空串清除；目录读取不会将已保存凭据发送到修改后的服务地址。

智谱预设「智谱 BigModel Coding Plan（国内）」填写服务名称「智谱 BigModel」与 Coding Plan 专属地址 `https://open.bigmodel.cn/api/coding/paas/v4`（与按量付费的 `/api/paas/v4` 不同，套餐须用专属地址），仅接受 Chat Completions 格式，启用时必须填写 API Key；选中预设即按[官方文档](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3)直接带出 GLM-5.3 与 GLM-5.3-Flash 两个模型（可按需增删），端点不提供模型目录时可跳过「获取模型」。两者按官方参数填入上下文 1M、最大输出 128K（131072），模型标识大小写不敏感；GLM-5.3-Flash 支持图片与视频输入，两者支持 JSON 输出、工具调用、系统消息与 low/high/max 推理等级（官方默认档 max）。GLM-5.3 系列无法关闭思考（`thinking` 只能开启），思考强度由 `reasoning_effort` 控制且仅支持 low/high/max，因此智谱模型没有「关闭」档位，声明 disabled 档位会被校验拒绝；实际单次输出按思考模式取官方默认上限（low/high 档 65536、`reasoning_effort=max` 为 131072），整理与工作流收尾这类固定非思考请求因无法关闭思考同样按 65536 取值。智谱的结束原因 `sensitive` 按内容拦截处理，`network_error` 与超出上下文窗口分别报明确错误。

模型访问层通过 `model.Client` 隔离内核，协议适配器负责请求编码、鉴权头和公开响应解码，统一 HTTP 传输负责大小限制、超时、跳转与错误处理。Chat 在 baseUrl 后追加 `/chat/completions`，Responses 追加 `/responses`；Anthropic 追加 `/v1/messages`，已以 `/v1` 结尾则只追加 `/messages`，使用 `x-api-key` 与 `anthropic-version:2023-06-01`。主循环 inference 使用流式响应，兼容服务返回普通 JSON；Chat 读取 `reasoning_content`、Messages 读取 `thinking` 文本、Responses 读取公开 `reasoning.summary`。未显式选择等级时，DeepSeek Chat 自动工具选择启用思考，强制函数输出关闭；DeepSeek Messages 主循环显式启用思考，其他 Messages 服务遵循自身默认设置，Responses 对声明推理能力的模型请求 `summary:auto`。显式等级须属于固定模型修订声明的档位，并参与提交幂等校验与 Run 快照；仅主循环及其工具续轮使用，整理不继承。Chat 发送 `reasoning_effort`，Responses 发送 `reasoning.effort`，Messages 发送 `output_config.effort`；关闭档位在 Chat/Responses 兼容接口映射为 none，DeepSeek Chat 与 Messages 则显式关闭 thinking。DeepSeek Messages 选择强度时显式开启 thinking，其他 Messages 服务沿用自身思考机制，不额外编造 token 预算。整理请求保留原非流式行为。思考增量只保留在内存快照，完整响应校验成功后保存 `response.reasoning`，失败增量不落盘，签名、加密推理与 debug 不保存；浏览器在生成期间通过输出 SSE 读取思考和回答增量，并用 model-requests JSON 接口回读历史思考。Responses 使用完整公开历史和 `store:false`。三种格式均支持文本、工具结果往返、强制函数输出和用量映射。Agent 要求文本与工具能力；HTTP 禁止跳转、Cookie 与自动重试，原始响应上限为基础 512 KiB 加按输出上限预留的分帧开销（每个输出 token 512 字节，思考模式的长回答不被逐帧包装判为超限），目录读取沿用基础上限。模型 JSON 和工具参数拒绝重复键，参数保留数值精度；审批和执行使用字符串 `argumentsJson`，不能经浏览器 `JSON.parse` 后重序列化决定执行内容。实际 token 与缓存用量未报告时保持未知，保守估算单独记录。Go 有 OpenAI 与 Anthropic 官方 SDK，本项目保留 Go 1.23 和标准库访问层，以维持精确 JSON 与无重试的既有边界。

父进程用原始目标、任务记忆、未整理完整事实组和近期公开 user/assistant 对话组装上下文；普通聊天推理采用「稳定头部 + 尾部当前状态」布局，本轮用户输入与最新任务计划只在最后一条当前状态消息保留原文，当前轮输入事实组只留证据引用，整理请求与工作流步骤保持原布局。工具过程与工作记忆按 Task 隔离；思考文本独立展示，不写入工作记忆或跨 Run 上下文，仅 DeepSeek 在同一 Run 的工具续轮回传成功响应的公开思考（Chat 使用 `reasoning_content`，Messages 使用 `thinking` 内容块）。容量准入、主动压缩阈值与 Run 预算统一使用 token 估算：既有 JSON 字节基线只作为输入，按每模型比例折算成 token，图片按每张 1024 token 补偿；比例依次取智谱官方分词器实测、每模型最近已确认响应的官方 `prompt_tokens` 反推校准（中位数加安全余量、有界），以及无官方数据时的保守默认值。智谱分词器（`/paas/v4/tokenizer`）只在已知官方 host 上按有界缓存、串行、超时尝试，任何失败静默回退本地估算，不阻断推理；DeepSeek 没有 token 计数接口，使用官方响应 usage 校准本地比例，不内嵌需 Python 的离线 tokenizer。请求 token 估算达到有效容量的 80%（模型容量成为约束时再计入最大输出预留）时，先对尚未整理的模型答复或工具事实执行主动 checkpoint：有效容量取 Run 固定模型声明容量与剩余 token 预算的较小者，因此 1M 模型按默认 Run 预算触发、小模型按自身容量触发；只用于普通聊天 v2 Run，只有本轮用户输入、去掉未整理事实后仍达到阈值，或预算不足时不触发。预算预检按实际整理请求计算，预留整理输出和完整原请求的回退成本；整理失败，或新记忆使重建请求超出模型容量／剩余预算时，使用压缩前上下文继续。主动与压力 checkpoint、正常答复后的单次整理共用 Run 预算，记忆有证据引用、revision 和覆盖游标，不能静默丢弃当前任务未整理事实。可恢复整理失败保留旧记忆和原始事实，正常答复可成功并标记 stale；取消、时限、存储失效与执行结果未确认仍走终止路径。估算单位、官方能力结论与回退口径见本地 [ADR-0039](docs/adr/0039-agent-context-token-estimation.md)。

### 用户选择与工具续接

普通聊天的新 `agent/v2` Run 始终提供 `request_user_input`。仅当缺少会影响结论或操作的目标、范围或偏好时提问；工具可查询的信息、已有默认值与模型服务错误不触发澄清。“平台占用／平台性能占用”默认查询 Elysian 进程 RSS、Go 内存，并附运行环境 CPU、内存、负载与磁盘，注明采样时间、面板进程和 Linux 内核视角；面板进程 CPU 等未提供的指标明确不可得。

澄清必须是该响应唯一工具调用；非法参数或混批返回可纠正错误，整批不派发其他操作。一次 1–3 题，每题 2–3 个带说明的单选项，可标记一个推荐项，始终允许自定义文本。问题落库后原 Run 进入 `waiting-input`，释放 Worker 和执行槽、保留会话占用；等待不计执行超时，不自动采用推荐值或过期，用户可取消本轮。工作流与旧驱动不开放此工具，选择不替代资源授权或审批。

`POST /api/agent/runs/{runId}/user-inputs/{inputId}/answer` 接收 `{requestId, answers}`；answers 以问题 ID 为键，每题只能给 `{optionId}` 或 `{text}`，一次答完。事务保存答案与原工具结果，将原 Run 入队继续，不增加用户轮次。同一请求编号与相同答案幂等返回，冲突、已取消或归属不符返回 409；队列满返回 429 并保持待答。SQLite schema9 的 `user_inputs` 与 JSONL 账本同事务保存，重启恢复待答，清理随会话级联。

聊天底部以选择卡片替代普通输入区，支持逐题导航、方向键／空格选择、Enter 前进，以及自定义回答中的换行和 Ctrl／⌘ + Enter。推荐项不预选；草稿与附件独立保留，答案按会话及问题保存，刷新和切换可恢复。提交结果未知先回读，人工重试复用原请求编号与答案；等待时停止生成动画和输出流重连。已答或已取消问题在历史中显示可展开的只读摘要，登出隐藏，重新登录后鉴权读取。

DeepSeek Chat 与 Messages 的思考开关及续接与展示回调无关，思考模式的同 Run 工具续轮显式回传空字符串 `reasoning_content` 或 `thinking`，非空时使用已确认原文，暂停恢复沿用同一规则。HTTP 与流式响应共用错误解析，只读最多 8 KiB 正文；已知缺少思考字段错误映射为中文诊断，可附严格 UUID 请求编号，未知错误仅公开 HTTP 状态和通用提示，原始正文与凭据不入公开错误或日志，不自动重试、切换协议或降低等级。设计见本地 [ADR-0036](docs/adr/0036-agent-user-input-and-model-continuation.md)。

### 技能、MCP 与执行配置

Web 管理入口位于设置页「MCP 配置」与「Skill 配置」页签（`/settings?tab=mcp`、`/settings?tab=skills`）。启用后的可用能力从普通聊天下一轮起进入自动目录，无需会话勾选；MCP 探测仍由管理员显式发起，发送消息只读本地配置和已保存目录，不连接服务或启动容器。Skill 内容更新通过固定修订重新导入。自动接入只使能力可发现，不授予执行配置、目录或网络权限；新模式的 Bash、技能脚本、文件及 stdio MCP 可先被发现，在实际使用时申请缺失范围。旧模式仍要求固定环境中的必要授权。不可用候选在 Run 快照 `automatic.unavailable` 保存稳定错误码与固定中文说明（`skill-unavailable`、`mcp-unavailable`、`mcp-catalog-unavailable`、`execution-unavailable`、`mcp-grant-denied`、`capability-revoked`），不含服务地址、凭据或底层错误正文，其他候选继续工作；显式指定的失效能力拒绝提交。自动测试用确定性内存与假 HTTP MCP 覆盖真实 Manager／Worker 循环，真实容器 stdio／脚本验收仍是 opt-in（`ELYSIAN_EXECUTION_TEST_IMAGE`），常规门禁不启动真实容器。非 Docker 开发使用确定性内存演示。

MCP 表单支持 Streamable HTTP 与容器 stdio，已有 Token／环境变量不回显，保存时可保留、替换或显式清除；保存不连接服务。stdio 的目录及网络字段声明运行需求，保存不会授予权限；手动探测先创建独立申请，使用相同选择卡片且只支持「仅本次允许」或「拒绝」，批准后才准备镜像和启动探测容器，探测授权与聊天及其他探测实例隔离。Skill 支持不超过 64 MiB 的 ZIP、HTTPS Git 与面板进程可见的绝对目录（Docker 下须已挂载），更新保留启用状态。导入记录支持取消和终态记录删除，每三秒同步活动任务；提交结果未知时保留原请求和输入，手动核对后复用请求编号。详情提供固定修订文件预览，二进制及超过 256 KiB 的文件不预览。Skill 删除移除全部修订登记、保留磁盘包和导入记录；界面不提供永久撤销操作。

独立 MCP 探测的申请、决定、准备进度与停止回执由 SQLite 同事务账本归档到 `data/agent-records/mcp-probes`；升级只为旧探测补当前状态快照，保留已有记录序号与文件内容。已确认释放的探测保留 30 天，待确认、运行中和结果未知的租约及记录继续保留；JSONL 副本故障阻止新探测派发，重启先补写核对，不重放探测。

| 管理接口 | 用途 |
| --- | --- |
| `GET /skills`、`GET /skills/:id?revision=` | 技能最新公开修订或指定历史版本 |
| `PUT /skills/:id` | `{expectedRevision,enabled}` 显式启停；内容更新重新导入并指定 skillId、expectedRevision |
| `GET/POST /skills/imports`、`GET /skills/imports/:id`、`POST /skills/imports/:id/cancel` | 持久导入任务；新任务 202、相同输入幂等回读 200，列表支持 cursor、limit |
| `GET/POST /mcp-servers`、`GET /mcp-servers/:id?revision=`、`PUT /mcp-servers/:id` | MCP 配置；详情必须指定 revision，更新提交 expectedRevision 与完整配置 |
| `POST /mcp-servers/:id/probe` | 旧接口，以 `{revision}` 初始化并发现目录；新 stdio 探测使用下方独立申请接口 |
| `POST /mcp-servers/:id/probe-request`、`GET /mcp-probe-requests/:id`、`POST /mcp-probe-requests/:id/decision`、`POST /mcp-probe-requests/:id/cancel` | 创建、回读、确认或取消独立探测申请；确认带请求编号与申请修订，仅本次生效 |
| `GET /mcp-servers/:id/catalog?revision=&digest=` | 固定目录；省略 digest 读取该修订最近一次探测目录，返回 modelAliases、resourceAliases、promptAliases |
| `GET/POST /execution-profiles`、`GET/PUT /execution-profiles/:id`、`PUT /execution-profiles/:id/enabled` | Python、Node、Bash 执行配置；写入使用 expectedRevision，启停显式传 enabled |
| `GET/POST /grants`、`GET/PUT /grants/:id`、`PUT /grants/:id/enabled` | 管理员预设的业务目录与网络授权，写入同样检查修订 |
| `POST /skills/:id/revoke`、`POST /mcp-servers/:id/revoke`、`POST /execution-profiles/:id/revoke`、`POST /grants/:id/revoke` | `{revision,reason}` 永久撤销，revision 为 0 撤销该编号全部修订，正数只撤销指定修订 |

技能支持面板进程可见的绝对目录、ZIP 上传和 HTTPS Git。JSON 导入为 `{requestId,source:{kind:"directory",path},enabled}` 或 `{requestId,source:{kind:"git",url,ref,subdirectory?},enabled,credential?}`；Git 必须显式指定分支、标签或提交，服务端锁定完整提交。ZIP 使用 multipart/form-data，依次为 `metadata` JSON（source 为 `{kind:"zip"}`）和 `archive` 文件，拒绝第三部分。包根目录必须有带 YAML frontmatter 的 `SKILL.md`，必填 name、description，可含 license、compatibility、metadata、allowed-tools；名称采用小写字母数字和连字符。包在 `data/skills/packages/<digest>` 按内容保存，拒绝越界路径、链接、特殊文件和重复路径。导入只复制和校验，不执行技能代码、Git hooks 或 submodule；Git 需要面板运行环境安装 git，不支持 SSH Git、Git LFS 内容下载或依赖自动安装。导入任务重启后标 interrupted，不自动重做。

新 Run 使用 `on-demand/v2`，MCP 与技能工具始终搜索后加载；普通聊天常驻 `tool_search`、`request_user_input`、`update_plan`。内置工具不超过 16 项且完整定义符合预算时直接提供，否则也经搜索加载。搜索支持中英文关键词、领域、服务名、技能名、工具原名和精确名称，每次默认 3 项、最多 5 项并支持分页。从下一次推理请求起提供完整定义；先装入本批高排名结果，再保留可容纳的旧定义，动态集合最多 16 项且同时受大小预算限制。搜索回执说明实际加载、最终保留、淘汰、跳过原因及下一页，巨大 Schema 明确跳过而不截断。最终集合随成功回执落盘，审批、重启和整理后按原集合恢复；每次请求保存实际 `toolNames`，隐藏工具及同一响应“搜索后立即调用”均被拦截。可见定义按「常驻与 eager 稳定前缀 + 动态定义尾部追加」排列：常驻与 eager 按快照目录顺序固定，新加载定义按持久搜索回执重放的加载顺序追加到尾部，淘汰只移除动态尾部集合；重启、恢复与旧快照无加载顺序记录时按快照目录顺序兜底，排序不改变可见集合、隐藏拦截或授权。主循环给出目录数量和领域边界，同一子目标连续搜索不超过两次；已穷尽时按能力边界说明不可得。

预算按固定模型容量减去本次实际输出预留得到输入空间 `I`，复用思考等级和输出限额计算：技能索引 `min(2048,floor(I/16))`、完整工具定义（含常驻入口）`min(8192,floor(I/8))`、常驻技能正文 `min(16384,floor(I/4))`。快照记录 `local-text/v1` 本地估算版本与有效预算（用于工具定义与技能材料的加载决策），最终请求继续经过官方优先的 token 容量检查（[ADR-0039](docs/adr/0039-agent-context-token-estimation.md)）；常驻入口无法容纳或合并目录超过既有条目／字节限额时，整个提交明确失败。没有新增配置页调参项。上下文浮层只统计实际发送的索引、正文和可见定义，本地估算不替代供应商实际用量。

技能索引仅发送名称、修订及最多 160 个 Unicode 字符的描述，按本轮相关性、稳定 ID 排序，只放入能完整容纳的条目，未展示项仍可搜索。v2 读取工具使用 `action:list|read`：目录按路径分页，默认 50、最多 100 项；参考文件按字节 offset 分段，默认 16 KiB、最多 64 KiB，保持 UTF-8 边界并返回下一偏移，受工具回执字节限额约束；二进制明确不可读。每次读取验证完整文件摘要，Schema 不枚举全量路径，后端核对固定技能包清单。`SKILL.md` 必须完整读取，按 ID、修订和包摘要去重，重复读取返回已加载引用；超正文或结果预算返回可纠正错误，不写已加载事实。原文在 Task 内保留，整理后独立恢复一份；参考片段不成为常驻正文。续轮提交核算仍适用正文，小模型容纳不下时拒绝提交；编辑重发排除被替换轮次的加载事实。旧无标记及 `on-demand/v1` 快照、已接受操作仍按原语义执行，细节见本地 [ADR-0038](docs/adr/0038-agent-enabled-extensions-and-context-budgets.md) 与历史 [ADR-0034](docs/adr/0034-agent-on-demand-tools.md)。

脚本必须位于包内 `scripts/`，执行前本 Task 已加载同 ID、修订和包摘要的 `SKILL.md`；路径、文件摘要、执行配置与 grant 由固定清单校验，脚本内容、镜像摘要、命令、目录／网络授权与工作区版本一并固定进审批。技能正文、MCP annotations 和输出不会扩大权限；`allowed-tools` 仅是技能自述。MCP 免审批信任须同时匹配别名、服务修订和目录摘要；旧环境缺摘要不推断信任，管理员显式保存环境时固定摘要，服务更新不继承旧信任。启停在下一轮更新目录，永久撤销在派发前核对，旧快照和审批不能绕过，已发生副作用不回滚。MCP 探测同样核对撤销；启动先恢复执行器拒绝表，撤销服务或 grant 会关闭相关 stdio 容器和代理隧道，停止未确认时暂停派发。

普通聊天新 `agent/v2` Run 常驻 `update_plan`，复杂任务自动拆分并在执行中更新，简单问答无需计划。工具提交完整步骤列表（1–20 步，稳定 ID、最多 200 字名称及 pending / in_progress / completed 状态，最多一个进行中），由父进程在同一事务内保存 Run 的可选 `plan`、工具回执和恢复游标，沿用 SQLite schema9 与 JSONL 账本。最新计划独立于工作记忆注入后续推理，不扩大执行授权；无效参数可纠正，完成只依据确认结果，失败或停止不自动完成剩余步骤。时间线与输出 SSE 同步计划，输入框上方默认折叠显示完成数和当前步骤，点击原位展开最高 192px 的列表；等待回答时保留在选择卡片上方。每轮独立，新消息接受后旧计划转入对应历史，刷新和重新登录回读服务端事实；编辑重发排除旧轮公开计划，原记录保留。细节见本地 [ADR-0037](docs/adr/0037-agent-task-planning-and-progress.md)。

主循环按当前固定目录提供工具总数与领域计数，历史答复和工作记忆中的能力描述不作为当前范围；目录摘要不注入完整工具定义。普通聊天的最新用户输入在尾部当前状态消息保留原文，事实组只留指向本轮上下文的证据引用，避免引用任务头部的占位句被当成用户没有新问题；工作流与旧快照保持原文。整理与结构化收尾仅提供各自专用函数，不注入工具发现说明。

MCP 固定协议版本 `2025-11-25`，支持 Streamable HTTP 的 JSON/SSE 响应及专属容器 stdio，分页发现 tools/resources/prompts，提供 tools/call、resources/read、prompts/get；拒绝服务器反向 sampling、elicitation、roots 等请求。模型工具使用目录返回的稳定 `modelAliases`，资源和提示的 `trustedReadOnly` 使用对应 aliases，不能直接填远端原始名称。参数和结构化结果校验使用 JSON Schema 2020-12，仅允许文档内引用，不下载外部 schema；不支持的约束直接拒绝。派发前重新探测并比较固定目录 digest，目录变化停止旧操作。凭据与 stdio 环境变量只写不回显；HTTP 禁止跳转与重试。`isError` 属于可反馈给模型的业务错误；连接中断或取消不能当作远端已停止，也不能重发同一调用。

MCP 当前不含旧 HTTP+SSE 传输、其他协议版本、OAuth 自动发现、资源模板发现/展开、资源订阅、completion、独立 GET SSE 长连接或事件重连续传。只把文本和结构化数据送给模型，图片、音频、blob 和资源链接保持未读取资料，不自动下载或宣称已理解。远端 HTTP MCP 由父进程直连管理员配置地址，不经过容器的出网授权代理。stdio 服务使用已固定摘要镜像及命令，默认不出网、不挂业务目录；可同时指定 `grantId` 与正数 `grantRevision` 固定目录/网络授权，同一授权修订也必须选入会话环境，执行计划与审批显示其完整内容。stdio 容器由执行器持有，每个操作使用独立 scope 与容器身份；审批前只固定已保存目录，不启动远端进程。消费审批、获取资源租约并落盘派发后才启动目录核验，核验通过才调用业务能力；操作结束确认容器停止后释放租约。最长存活 300 秒，未知停止保留锁和执行屏障，不重发既有调用。管理员显式探测也使用独立临时 scope，结束确认停止，不保留默认作用域的常驻连接。

容器执行需要可访问的 Docker Engine 和同架构 Linux 面板二进制；镜像必须固定 `仓库@sha256:完整摘要`，不能声明额外 VOLUME。新运行时选择在管理员批准后下载固定官方环境；旧固定配置仍要求镜像已存在，执行时不安装解释器。脚本使用 UID/GID 65532、只读根文件系统、全部 capabilities 删除、no-new-privileges、无特权、无 Docker socket、无面板凭据，网络固定 none。技能和 supervisor 放只读 `/bundle`，任务文件复制到 `/workspace`，默认仅有受限临时目录。显式目录 grant 只能引用挂载根内已存在、无符号链接的业务子目录，容器中依序为 `/grants/0` 等；系统目录、凭据目录和面板状态不可授权。配置最多登记 32 个目录，单次执行器最多挂载 16 个。

脚本和 stdio MCP 的授权出网仅支持 HTTP/HTTPS 代理，按精确协议、域名、端口授权；每次连接核对全部 DNS 结果并固定实际拨号 IP，私网还需 privateCidrs。回环、链路本地、实例元数据和特殊地址禁止，不能用通配符或 IP 字面量授权。不遵循代理环境变量的程序无法直连出网；HTTPS CONNECT 限制目标地址，不检查加密隧道里的路径和应用内容。代理每执行最多 4 条同时连接、64 次连接、累计双向 16 MiB。

### 审批、恢复与工作区

运行时申请复用 `GET /api/agent/approvals`；`POST /api/agent/approvals/:id/access-decision` 接收 `{requestId,expectedRevision,expectedDigest,decision:"once"|"session"|"denied"}`。`GET /api/agent/sessions/:id/authorizations` 回读当前会话允许项，`DELETE /api/agent/sessions/:id/authorizations/:authorizationId` 以 `{requestId,expectedRevision}` 撤回。结果未知时先回读，人工重试沿用精确请求。Run 快照保持不可变，操作授权单独绑定完整参数、固定环境与范围；执行器和文件门面再次核验。运行库升级到 schema9，新增会话授权表，申请、决定及授权事实与 JSONL 账本同事务保存；维护恢复保留当前整组 Agent 数据及撤销事实，不能从旧备份复活权限或重放未知执行。

已确认的内置脱敏只读和技能资料加载可直接执行；旧模式的变更及脚本按本轮 permissionMode 决定审批，MCP 使用原显式信任规则。新模式缺失权限始终进入运行时申请，精确匹配已记住的会话允许项可免去重复确认。父进程先持久化模型提议，再生成完整 Operation；同一响应的多条调用顺序执行。审批、资源或域任务等待释放 Worker，会话仍保持忙碌；恢复从已保存 responseId/callIndex 继续，不重问模型、不重放已完成调用、不重置预算。等待时间不计入 10 分钟活动执行预算。

审批期限 24 小时，最多 32 个待审批；重复相同决定幂等，不同决定冲突。旧审批的拒绝和到期结束 Run；运行时申请的拒绝作为工具结果交回模型，允许寻找其他办法；取消撤销未消费审批。同意后仍须重新校验版本、撤销、目录摘要、参数和工作区版本，并在派发事务内一次消费。参数、脚本、运行环境或工作区发生变化不能沿用旧审批。面板重启保留 queued、waiting-approval 和 waiting-resource；遗留 running 中断，已派发调用的未知结果不自动补做。普通聊天在镜像准备时因面板关闭或崩溃而中断、且尚未派发命令的，保留原决定并转为新的待确认申请；准备状态标为未知，再次确认只核实本机固定摘要镜像，缺失时继续等待人工核实，不自动重复拉取。

潜在写操作派发前先保存全局 ExecutionBarrier。已确认结果解除该屏障；失联、未确认停止或重启留下 dispatched/unknown 时，后续潜在写操作停止派发，只读核实也须通过资源租约的冲突检查。操作者从目标系统独立核实后，提交 `confirmed-completed` 或 `confirmed-stopped` 及 1 至 8192 字节证据；核实只关闭不确定性记录，不重放调用、不把旧 Run 改成成功，也不撤销已经发生的外部效果。取消先落请求再确认停止，父端不响应超过 5 秒宽限使内核暂停派发；重启不会清除未决写操作屏障。

### 资源锁与执行池

父进程管理有界 Worker 池，默认全局并发 2；`~/.Elysian/config/agent/runtime.json` 可写入 `{"version":1,"concurrency":2}`，并发仅允许 1 至 4，缺文件默认 2，非法配置拒绝启动，修改后重启生效。旧环境变量 `ELYSIAN_AGENT_CONCURRENCY` 不再读取。同一根工作流最多同时占用 2 个执行槽，普通会话仍遵守 busy 约束。每个 Run 独立保存取消、调用和整理状态；取消一个 Run 不终止其他执行槽。审批与资源等待不占 Worker，也不重新消耗模型请求或工具预算。

| 资源与执行接口 | 用途 |
| --- | --- |
| `GET/POST /resource-rules`、`GET/PUT /resource-rules/:id` | 不可变资源规则修订；更新需 `expectedRevision` |
| `GET /resource-locks` | 等待、持有、未知与释放的持久租约，活动状态优先，最多 200 条 |
| `POST /resource-locks/:id/reconcile` | 仅管理探测租约：提交 `{decision:"confirmed-stopped",evidence}`，同一决定幂等 |
| `GET /execution-runtimes` | 当前受管容器身份、MCP 服务修订与生命周期；不返回凭据、命令或环境 |

会话环境通过 `resourceRules:[{id,revision,digest?}]` 固定规则，Operation 与审批保存精确资源声明。规则只能由管理员配置，按能力修订、MCP 原始名称和目录 digest 匹配，再用固定字符串或 JSON Pointer 提取资源身份；`complete` 表示管理员明确声明覆盖全部影响范围。声明无法完整解析时使用全局独占锁，不让模型自行推断权限或锁范围。资源身份不含规则 revision，更新规则不会使同一资源变成互不相干的锁。相同资源支持读共享、写独占及目录子树冲突；stdio 容器按整个目录 grant 声明范围，有网络 grant 时保守全局独占，不用单次工具参数缩小后台进程权限。

资源获取、审批消费、预算预留和派发标记在同一事务完成。冲突进入 `waiting-resource`，保留会话 busy、当前操作及审批，按冲突等待顺序恢复；后续操作不能越过更早的冲突等待者。正常完成确认停止后释放；取消只直接释放尚未获得的等待租约，已派发且停止未知的租约必须保留，重启将遗留持有租约标记未知。任何未知租约或未知执行屏障都阻止新的外部能力派发；操作租约仍须通过对应执行屏障提交核实证据，不能走管理探测核实入口解除。

管理员 `POST /mcp-servers/:id/probe` 无需模型审批，但仍检查维护与永久撤销，先持久化独占生命周期租约再启动。冲突返回 409，不创建等待任务；目录只有在确认停止后才保存。租约的 `scopeId` 是启动前固定的执行容器标签身份，已观测的实际 Docker 容器编号另存 `containerId`，并保留 `source:"mcp-probe"`、`serverId` 与 `serverRevision`。停止未知时返回错误并保留锁，管理员凭目标系统证据确认容器已停止后核实。`/resource-leases` 与其核实入口是 `/resource-locks` 的同状态别名。

| 任务工作区接口 | 用途 |
| --- | --- |
| `GET /tasks/:id/workspace` | 当前数据库版本指针、文件路径、大小和 digest |
| `GET /tasks/:id/workspace?path=` | `{version,path,content}`；content 为原始字节的标准 base64，不是直接文件下载 |
| `PUT /tasks/:id/workspace?path=&expectedRevision=` | 上传原始请求体，创建新文件版本；空工作区 expectedRevision 为 0 |
| `DELETE /tasks/:id/workspace?path=&expectedRevision=` | 删除相对路径并产生新版本 |

工作区只属于会话内 Agent Task，编辑限该会话空闲时；等待审批也不可改，工作区读写不刷新会话活动时间或延长保留期。文件路径禁止绝对路径、越界和链接；每次修改产生不可变版本，通过 expectedRevision 与数据库 CAS 发布当前指针，不以磁盘最大版本猜测当前文件。容器执行后只有完整复制、校验并确认停止的文件才可进入结果事务；非零退出码或展示结果超限不抹掉已经确认的文件变化。失败或未确认导出保留旧指针；孤立候选版本不自动发布。任务工作区与容器应用工作区、网站源码目录分别管理。

### 长期 Wiki 记忆

长期记忆采用有链接、有证据的 Markdown Wiki 组织方式，以 SQLite 为权威存储，支持候选式导入和整空间导出。`harness.sqlite` 显式升级至 schema v5，保留旧批次、会话和活动 `workflow/v1` 的语义。长期记忆按业务空间隔离，可显式选择附带全局空间；`PUT /sessions/:id/memory` 提交 `{spaceId,includeGlobal}`，新会话默认不关联空间。Run 接受时固定空间及页面修订，父进程按原始目标与本轮输入召回有来源的整页内容，最多 8 页、16 KiB。页面和来源都是资料，不能授予工具权限、改变预算或充当系统指令。工作记忆仍属于单个 Task，长期 Wiki 页面与它分别保存。

| 长期记忆接口 | 用途 |
| --- | --- |
| `GET/POST /memory-spaces` | 列出或创建业务／全局空间 |
| `PUT /memory-spaces/:spaceId`、`GET /sessions/:id/memory` | 以 `expectedRevision` 修订空间名称；查询会话的空间选择 |
| `GET/POST /memory-spaces/:spaceId/pages` | 列出或创建页面；`includeWithdrawn=1` 包含撤回页 |
| `GET/PUT/DELETE /memory-spaces/:spaceId/pages/:id` | 读取、产生新修订或撤回；修改提交 `expectedRevision` |
| `GET /memory-spaces/:spaceId/pages/:id/revisions/:revision` | 查询保留的不可变历史修订 |
| `GET /memory-spaces/:spaceId/search?q=&limit=` | 中文双字文本与可用向量索引融合，返回 `degraded` 与回落原因 |
| `POST /memory-spaces/:spaceId/imports`、`GET /memory-spaces/:spaceId/export`、`GET /memory-spaces/:spaceId/checks` | Markdown 导入为待确认候选、导出页面与来源、自检断链／孤立页／过期页／无效来源 |
| `GET /memory-proposals`、`POST /memory-proposals/:id/decision` | 查询候选；提交 `{decision:"approved"}` 或 `rejected` 后原子发布或拒绝 |
| `GET /memory-extractions?cursor=&limit=`、`GET /memory-extractions/:id` | 回读异步提炼状态、固定模型版本、用量及候选编号 |
| `POST /memory-extractions` | `{requestId,runId}` 或 `{requestId,workflowId}`；对成功来源的固定快照发起一次人工提炼，相同请求幂等回读 |
| `GET /embedding-requests?cursor=&limit=` | 索引和查询的独立用量记录；含固定配置修订、估算和供应商实际用量，缺失保持未知，不返回输入正文 |
| `GET/POST /embedding-profiles`、`PUT /embedding-profiles/:id` | 独立 Embedding 服务配置；更新需 `expectedRevision`，凭据只写 |
| `GET/POST /memory-spaces/:spaceId/indexes` | 读取索引覆盖情况；以 `{requestId,profileId,profileRevision}` 提交异步重建，任务状态经 `/memory-extractions/:id` 回读 |

成功普通 Agent Run 与成功根工作流在发布事务中最多入队一次长期记忆提炼；子步骤不重复入队。提炼及索引任务仅在前台没有活动或排队 Run 时开始。提炼固定当次模型版本，最多 60 秒、32 KiB 输入和 4096 token 输出，只允许一次 `propose_wiki_pages` 结构函数，不获得域工具或执行权限；最多生成 4 个待确认候选。模型响应先落盘，再验证并发布候选。失败保留既有页面，任务标记 `stale`；重启将执行中的提炼标为 `interrupted`，不自动重试。需要再次提炼时使用新的人工请求标识，沿用成功来源的固定输入快照，不混入后续任务事实。输入与完整响应仅保存在父端，公开提炼接口不返回它们或凭据。

提炼可建议新页，也可修订固定输入中实际携带的已有页面；修订候选保留准确的 `pageId` 和基准 revision，人工采纳时页面若已变化则拒绝覆盖。运行或工作流证据必须逐字匹配保存的公开答复或成功结果，不能仅凭一个成功编号接受任意文字。维护回滚标记在同一恢复事务内中断所有排队和执行中的提炼／索引任务及未完成向量请求，然后才能移除；原输入和已保存响应保留，核验后显式提交新任务。

页面保存不可变 revision 与 digest，召回、工作记忆、模型过程及后续候选保留来源依赖。撤回会使相关上下文 generation 失效，并取消依赖旧资料的活动运行、撤销未消费审批；新模型请求与结果发布边界继续检查，不能靠旧快照绕过撤回。页面正文最多 16 KiB、全局最多 10000 页。

全文索引由汉字双字片段、英文和标识符词项组成，可额外设置各最多 32 项的 `tags`、`aliases`。观察类页面默认 30 天到期，过期页退出自动召回；偏好、约定和经验默认长期保留。模型可调用 `wiki_search`、`wiki_read` 和 `wiki_follow_links`，只能读取本轮固定的可见修订，调用与返回内容均计入原有限额。被上下文容量裁掉的页面不会记录成已使用来源。

公开消息及工作区查询会标出 `quarantined` 和 `wikiSources`。撤回保留历史内容和文件，隔离版本不能作为脚本输入；人工覆盖单个文件仍继承原工作区的隔离状态，清空工作区后可从有效事实重新生成。证据摘录必须来自已保存的成功公开答复或结果，来源会话清理后保留有界摘录并标记 `originalCleared`；撤回不等于删除审计或彻底遗忘。

Embedding 使用独立的 `config/agent/embeddings.json`，采用 0600 文件、原子替换与同步，保留不可变修订。索引以页面修订／digest 与 Embedding 修订为键，更新页面不会误用旧向量；显式重建受单任务 60 秒限制，未完成时保留已确认索引并显示回落。查询使用余弦相似度与文本名次 RRF 合并；索引缺失、部分过期或供应商失败时继续提供中文双字文本结果。HTTP 不重试、不跟随跳转，响应上限 512 KiB，查询向量请求另限 3 秒。Web 经 `/agent/memory` 页（agentMemory 域）消费正式 memory-spaces 接口；旧 `/wiki/*` 入口保留为同一状态的兼容接口，但前端不消费。设计见本地 [ADR-0029](docs/adr/0029-agent-wiki-memory-and-embeddings.md)。

启用 Embedding 后，索引重建会向该配置地址发送页面标题和正文，混合检索会发送查询文本（自动召回时包含任务目标／当前输入）；供应商按自己的规则处理这些内容。每次索引或查询先写入独立请求记录再发送，估算与供应商报告的实际 token、缓存 token 分开保存，不并入 Agent 对话预算；未报告的字段不补零，失败响应中已报告的用量仍保留。公开账本只含输入字节数与摘要，不含正文、查询原文、向量或凭据，终态记录保留 30 天。维护期间直接服务调用也禁止修改 Embedding 配置和发起新请求。

### 工作流与隔离分支

管理员可保存不可变模板修订，将 Agent 分析、直接能力操作、人工确认和条件分支组成流程。`workflow/v1` 保留顺序执行；显式指定 `languageVersion:"workflow/v2"` 可加入有界并行、数组迭代和固定修订的子流程。每个实例创建专用 Session 与根 Task，从来源会话复制模型修订及能力环境，不复制来源历史或文件；接受时固定完整子流程模板闭包，并检查全部嵌套步骤的能力。非终态实例占用专用会话，普通任务输入、切换配置和人工工作区编辑均拒绝；等待审批或资源释放执行槽。Web 的 `/agent/workflows` 提供模板表单及高级 JSON 编辑、实例执行树和人工恢复入口；不提供定时触发或自动重试。

| 工作流接口 | 用途 |
| --- | --- |
| `GET/POST /workflow-definitions` | 最新模板列表；创建模板返回 201 |
| `GET /workflow-definitions/:id?revision=`、`PUT /workflow-definitions/:id` | 读取最新或历史修订；更新提交完整模板字段及 expectedRevision，创建新修订 |
| `POST /workflow-instances` | `{requestId,definitionId,definitionRevision,sourceSessionId,inputJson}`；必须明确模板修订，新实例 202、幂等回读 200 |
| `GET /workflow-instances?status=&cursor=&limit=`、`GET /workflow-instances/:id` | 查询实例状态、固定快照、累计预算与 allowedActions |
| `GET /workflow-instances/:id/execution-tree` | v2 的作用域、稳定节点身份、尝试、当前状态与节点 allowedActions |
| `GET /workflow-instances/:id/steps?cursor=&limit=`、`GET /workflow-instances/:id/events?cursor=&limit=` | 阶段尝试和工作流事实分页；cursor、seq 为十进制字符串 |
| `POST /workflow-instances/:id/cancel` | 保存取消请求，状态回读确认收尾 |
| `POST /workflow-instances/:id/recover` | `{requestId,expectedRevision,nodeId?,action,evidence,outputJson?}`；v2 必须指明 nodeId；明确恢复 202、相同请求回读 200 |

模板字段为 `name`、`enabled`、`goal`、`inputSchemaJson`、`outputSchemaJson`、`entry`、`steps`。每步包含 `id`、`kind`、`input` 和 `outputSchemaJson`。`agent` 需要 instruction，可用 selection 显式选择技能/MCP 资料；`operation` 需要固定环境内的 capability 别名；`approval` 需要人工确认说明 instruction；这三种步骤必须二选一指定 next 或 finish。`condition` 使用 condition、then、else 选择分支。最多 32 步，必须全部可达且无循环，前序结果引用必须在所有到达路径上都已完成。

v2 新增 `parallel`（`parallel:{join:"all",branches:[{id,input,body}]}`）、`foreach`（`foreach:{items,body}`）和 `subworkflow`（`subworkflow:{definitionId,definitionRevision}`）。`body` 为含 `entry`、`steps`、`outputSchemaJson` 的局部有向无环图；每个局部图最多 32 步，最多嵌套 4 层、展开 256 节点、单次 8 分支或 32 个数组项。空数组直接产出 `[]`；并行结果按分支 ID 组成对象，迭代结果按原数组顺序组成数组，子流程直接返回其输出。绑定只读取本作用域输入及前序节点，不跨分支读取未完成结果。

每个子作用域有独立 Task，展开时复制父工作记忆及工作区的固定版本；分支后续记忆、工具事实和文件互不污染。汇合保留父文件，把分支新增或修改文件放到 `.workflow/<nodeId>/<ordinal>/`，不把分支删除应用到父目录；归档准备完成后以数据库版本 CAS 与输出、后继 ready 一起提交。展开与汇合有持久回执，重启不重复执行已完成分支。分支失败关闭整个实例的新派发入口，已派发分支仍保存真实结果；恢复指定失败节点，成功兄弟分支不重跑。Wiki 来源随输入、工作记忆、文件和结构化结果穿过分支及汇合；撤回同时隔离后续消费者和无活动 Run 的阶段边界，不能通过恢复沿用失效来源。

input/finish 绑定严格五选一：`{literalJson:"精确 JSON 字符串"}`、`{input:"JSON Pointer"}`、`{step:{stepId,pointer}}`、`{object:{字段名:绑定}}`、`{array:[绑定]}`；finish 可以读取本步结果。条件 op 为 eq/ne/lt/lte/gt/gte/exists/and/or/not，使用 left/right 或 children 组合，不执行表达式代码。Schema 使用 JSON Schema 2020-12 的已支持范围，拒绝外部引用与未知约束。JSON 字符串保留数值精度；实例 inputJson 不超过 32 KiB，工作流请求体 1 MiB、结果值 256 KiB，绑定深度 32、节点 4096。

Agent 步骤在公开答复后经专用 `workflow_finish` 函数提交结构化对象结果，计入原有预算；校验通过并随成功事实落盘后才推进下一步。直接能力操作复用现有审批、撤销、执行屏障和工作区检查。人工确认输出固定 `{approved:true}`，不替代后续写操作的独立审批；条件步骤输出 `{matched:布尔值}`。阶段输出、证据引用与工作区版本可以在 steps 中回读。

失败或中断进入 recovery-required，禁止自动重试。输入绑定缺失也保存失败 Run 与尝试，可凭外部证据补录 Agent 或操作步骤的结果，不派发缺少参数的操作。恢复 action 为 continue（维护冻结的确认边界）、renew-approval（未派发操作重新申请审批）、retry（新 Run 明确重试）或 accept-result（补录通过 Schema 校验的外部结果），以 allowedActions 为当前提示，提交时再次校验。恢复需要 1 至 8192 字节证据，不能重置预算、改变固定环境或绕过永久撤销。未知执行必须先人工核实屏障；confirmed-completed 可支持结果补录，confirmed-stopped 之后只能明确重试。补录保留独立人工完成证据，不把原 Run/Call 的失败或中断终态改成成功。

工作流恢复只能继续使用仍然有效的资料来源。Wiki 页面撤回后，依赖该页的输入、记忆、文件与结果永久失效；更新页面或恢复历史修订不会解除旧快照的失效，continue、retry、renew-approval 和 accept-result 均不能绕过。需要继续业务时，应结束原实例，以有效来源重新创建任务或流程；原实例保留审计事实。

非终态实例上限 32；每实例累计活动执行 60 分钟、模型请求 64 次、工具调用 64 次、256000 token、结果 8 MiB，每步最多 3 次尝试，单 Run 仍受下表更小的限额约束。v2 的全部子作用域共用根实例预算，并发运行先预留额度、收尾时结算，不能各自获得一份额度；每个根实例最多同时运行 2 个 Run。审批等待不计活动时间，恢复和重试不获得新额度。取消、预算耗尽或拒绝审批会撤销全部未消费分支审批，等待已派发运行确认停止后才释放会话。设计见本地 [ADR-0028](docs/adr/0028-agent-workflow-scopes-and-resource-concurrency.md)。

| 默认限额 | 值 |
| --- | --- |
| Run 并发、排队、工具调用数 | 2、32、每 Run 16 次；显式资料加载也消耗工具次数 |
| 请求与工具结果 | JSON 提交 64 KiB；工具单次 256 KiB、累计 2 MiB；列表工具最多 200 个完整条目 |
| 批次与 Agent 时间 | 批次 5 分钟；Agent 活动执行 10 分钟；工具 30 秒；模型单次 60 秒；取消宽限 5 秒 |
| 模型与记忆 | 最多 16 次请求（含整理）、单次输出按思考模式默认（非思考 8192、思考 65536、max 档 131072，模型最大输出与运行限额可收紧）、总预算 196608 token、用户输入 32 KiB、可变记忆 16 KiB、校验后响应 2 MiB |
| 技能导入 | ZIP 64 MiB、展开 64 MiB、2048 文件、待处理 32、并发 1、5 分钟；SKILL.md 1 MiB、frontmatter 64 KiB |
| MCP | 单消息 512 KiB、目录合计 512 项/4 MiB、单 schema 128 KiB、每类最多 64 页、内容最多 128 块 |
| 执行环境 | 新模式默认 0.5 CPU、256 MiB、64 PID；旧配置最多 1 CPU、512 MiB、128 PID、5 分钟；harness 脚本仍受更短的工具 30 秒和 Run 剩余时限约束，配置只能进一步收紧 |
| 容器输出与工作区 | stdout/stderr 合计 2 MiB；工作区每版本 128 MiB/4096 文件、归档总量 2 GiB；旧版本也计入容量 |

既有分页接口返回 `{items,nextCursor,hasMore}`，普通分页默认 50、Run 事件默认 100、工作流事件默认 50，上限 200；operations/context-items 和审批/屏障为数组，不承诺分页。环境最多 32 技能、32 MCP 服务、128 工具选择、64 资源、16 执行配置、32 授权、256 只读信任别名。队列满返回 429，非法或超前事件游标返回 400。

父进程独占 `~/.Elysian/data/harness.sqlite`，状态及事实事件在同一 SQLite WAL 事务提交；`data/agent-records` 按会话或独立批次保存已持久化运行事实的 JSONL 副本，SQLite 仍是查询与事务的权威来源。副本通过同事务待写队列提交后同步落盘，重启先补写核对再开放派发；副本故障停止派发，不把已提交事务重做，也不采集原始 HTTP 或凭据。Worker 只经受限匿名 JSONL 管道请求模型和工具，不持有数据库、凭据、Docker socket 或域对象。Worker 继承系统权限，不是安全沙箱；脚本与 stdio MCP 才使用受限容器。stderr 仅保留前 4 KiB 内存诊断，无任务日志 API，logBytes 为预留字段。Agent 配置集中在 `config/agent/` 的 `models.json`、`skills.json`、`mcp-servers.json`、`execution.json`、`embeddings.json`、`runtime.json`；旧 `config/agent-*.json` 不迁移也不再读取。包与工作区在 `data/skills`、`data/agent-workspaces`；凭据配置采用 0600 原子写入和同步。会话无活动 30 天且无活动 Run、无非终态工作流、无未决执行屏障时级联清理所属事实、工作区与 JSONL；批次终态保留 30 天，幂等记录随数据保留，配置历史和技能包不随会话删除。会话删除事务先写入持久清理记录，文件删除成功才移除记录；清理失败或进程中断后继续清理。JSONL 待写账本保留到所属会话或批次清理，可用于缺失文件或截断尾部的重建；完整行错改及额外内容会阻止派发，须修复后重启核对。设计见本地 [ADR-0030](docs/adr/0030-agent-config-and-jsonl-records.md)。

`app.Runtime.Close(ctx)` 统一回收 Worker、技能导入、MCP、执行容器、库与插件。启动核对并清理带本执行器标签的遗留容器及卷，无法确认停止则停止派发；不清理无关容器。正式维护冻结新派发与审批恢复，停服后备份 config/data。维护回退始终原位保留当前全部 Agent 配置、运行库、技能与工作区，包括已完成工作流的回执；其他领域恢复旧快照前，先同步落盘 `state/panel-maintenance/agent-workflow-recovery.json`。内核启动消费标记，将非终态工作流冻结为 recovery-required 并撤销未消费审批，事务成功后才删除并同步标记；完成回执和未知执行屏障保留。当前库损坏、无法核实，或当前库缺失而备份含 Agent 数据时拒绝自动恢复，不能拼接新旧事实。旧二进制不支持新 schema 时保持 Agent 不可用，不能降级运行库来启动。自动化验收使用假模型、假 MCP、临时配置及专用执行容器，不读取生产凭据；实际模型/MCP 连通性需操作者提供配置。设计分别见本地 [ADR-0024](docs/adr/0024-agent-task-runtime-kernel.md)、[ADR-0025](docs/adr/0025-single-agent-sessions-and-working-memory.md)、[ADR-0026](docs/adr/0026-agent-capabilities-approvals-and-execution.md)、[ADR-0027](docs/adr/0027-agent-sequential-workflows.md)。

## 结构与边界

网站项目通过容器运行，Java、Node、Go、Python 的版本由后端自动获取：语言官方正式发布记录与 Docker 官方镜像精确标签取交集，包含五年前版本线及历史正式补丁，排除预发布、快照和浮动标签。添加项目窗口通过同源 API 读取目录并支持版本号搜索。目录缓存六小时，过期后按请求自动刷新，获取失败时明确提示并保留已有缓存；缓存位于 `~/.Elysian/state/website-runtime-catalog.json`，生产代码不维护固定版本表。`bun run check:website-runtimes` 可诊断官方来源与镜像库的自动获取路径；本地演示仍使用可复现 mock。

- `apps/web/`：工作台页面、store、HTTP/WebSocket 与 mock adapter。
- `apps/server-go/`：Go 后端（chi）：同源 API、Docker Engine 调用、数据库协议、本机操作与 Agent 任务运行内核；Worker 由同一二进制托管。
- `packages/foundation/contracts/`：跨端类型与纯常量。
- `CONTEXT.md`、`AGENTS.md`、`docs/`：本地设计文档，不进入版本库。

没有接入真实 Kubernetes 或云平台操作；单 Agent 通过用户配置的模型执行内置只读任务，并可在固定能力和审批范围内调用 MCP 或执行容器脚本。真实数据库的账号边界与请求守卫已经实现；面板已落地单管理员登录与服务端会话鉴权，多租户与人员级权限仍待后续完成。SQL 驱动会先解码单个结果行再执行应用侧输出截断，极端超大单行仍可能造成瞬时内存峰值；不要把此版本当作不可信用户可访问的数据库代理。所有 Docker 和数据库操作均具有真实效果，操作前应核对目标容器、版本、端口与删除确认内容。
