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

Docker 开发分两个编排：根 `docker-compose.yml` 只跑前端 dev 与容器内 sshd；Go API 由 `apps/server-go/docker-compose.go-dev.yml` 提供（监听容器内 48101，只发布宿主回环 48102），vite 把 `/api/*` 同源代理过去。日常用 `bash scripts/dev.sh up` 一条命令按正确顺序起两个栈（`down` 停止、`restart-go` 让 Go 代码或环境变量变更生效）；手动起时 macOS Docker Desktop 需要把 `ELYSIAN_DOCKER_MOUNT_ROOT` 指向已共享的宿主路径（仓库根 `.env` 会被脚本透传给两个栈），Linux 默认为 `/srv`。开发账号 `dev / dev-elysian` 需显式开启：`ELYSIAN_AUTH_DEV=1 bash scripts/dev.sh up`。

Go 后端的开发与门禁一律在 Docker 容器内跑：`bash apps/server-go/dev-check.sh ./...`（缺省全量，可传包路径缩小范围）。宿主机命令只覆盖前端与契约包：`bun run test` 覆盖 web 和契约包。

顶栏内存自检每五秒读取 Go 后端单进程的实际常驻内存，单位为 MiB；Linux 优先使用 `/proc/self/smaps_rollup`，回落到 `smaps`，仅有 `statm` 时以 ≈ 标注近似，无法读取时显示不可用。顶栏只显图标与绝对用量，名称由按钮的 `aria-label` 与悬停提示承载，不显百分比——百分比与仪表盘的「内存占用率」同屏会被读成同一口径的两个数。点击展开明细，分「进程常驻（RSS）」与「Go 运行时」两组口径列出堆与 GC 读数，两套口径不能相加，理由写在标题右侧问号的浮层里。占比以 `/proc/meminfo` 的系统总内存为参照（容器内属于宿主 Linux 内核，不表示容器限额），连同这个分母一起显示在明细中，总量不可读时不推断百分比；系统总内存达到 1024 MiB 时以 GiB 展示。采样不主动触发垃圾回收，不包含浏览器、开发启动器或其他容器。

面板监听宿主回环地址 `127.0.0.1:48100`。挂载 Docker socket 等价于授予宿主级容器管理权限，因此不要把面板反向代理到不可信网络。面板有单管理员登录：服务端会话加 HttpOnly Cookie，除四条鉴权豁免路径（`/api/health` 与 `/api/auth` 的 login、session、logout）外，全部 `/api/*` 读写都要求已登录会话。同机回环上的自有工具复用浏览器本就按 host 共享的这枚会话，回跳地址由服务端按白名单裁决（`docs/adr/0017-*`），面板仍是单用户、不含多租户。

## 部署

源码一键部署入口是 `scripts/install.sh`（Ubuntu/Debian 虚拟机，root 执行）：按官方校验安装锁定版本的 Go 与 bun 工具链，构建前端与 Go 单二进制，写 systemd 服务（裸机模式，只绑 `127.0.0.1:48101`），首启初始密码打印在 stdout，`--uninstall` 卸载（保留 `~/.Elysian` 数据）。忘记密码时在部署机执行 `HOME=/var/lib/elysian /usr/local/bin/elysian resetpwd`。

## 数据库页

Docker 环境中的 MariaDB、MySQL、Redis 使用 `/api/databases` 和数据库协议 WebSocket。创建时必须输入明确的版本标签；缺少镜像时先拉取，再创建容器与专属持久卷，或验证现有容器的引擎、版本、管理员和普通账号后接管。MariaDB/MySQL 卡片对应逻辑库；Redis 卡片对应容器的 DB 0。访问范围分别映射到宿主回环端口、容器网络以及显式确认的所有宿主网卡端口。

普通删除只删除 SQL 逻辑库或清空 Redis DB 0，保留容器和卷。最后一个 SQL 逻辑库删除后显示空容器卡片，可复用容器或单独删除容器及专属卷；删除容器前会检查其他数据库。创建失败的登记显示待处理状态，可修复后核对。容器外部停机、删除和数据库状态变化由列表刷新反映。

数据库卡片的终端由服务端建立数据库协议连接，使用受限普通账号，不启动 Shell 或数据库命令行客户端。终端有限制输入、输出、执行时间、空闲时间和并发数；Redis 响应在协议读取阶段限制字节数，SQL 驱动按行输出并限制结果总量。普通账号仅拥有目标 SQL 库权限；Redis 普通账号使用 ACL 排除危险命令。数据库列表不返回密码；点击复制时才从服务端读取，响应禁止缓存。服务端登记与凭证保存在 `~/.Elysian/config/databases.json`，文件权限为 `0600`。

Docker 环境中的 SQLite 使用面板持久卷 `~/.Elysian/data/sqlite`：可新建空库、上传单个独立 SQLite 快照、在受限数据库协议终端内读写、下载一致性快照，以及确认后删除实际文件。上传上限为 256 MiB，单库上限为 1 GiB，托管 SQLite 总量上限为 4 GiB；WAL 模式原库须先导出独立快照。文件登记位于 `~/.Elysian/config/sqlite-databases.json`，中断的创建、上传或删除会显示待处理状态。SQLite 终端允许常用查询、增删改、表/索引/视图 DDL 与事务语句，不支持文件操作、扩展加载、触发器或虚拟表创建。非 Docker 本地开发中的 SQLite 与其他数据库仍是演示状态。

## 结构与边界

网站项目通过容器运行，Java、Node、Go、Python 的版本由后端自动获取：语言官方正式发布记录与 Docker 官方镜像精确标签取交集，包含五年前版本线及历史正式补丁，排除预发布、快照和浮动标签。添加项目窗口通过同源 API 读取目录并支持版本号搜索。目录缓存六小时，过期后按请求自动刷新，获取失败时明确提示并保留已有缓存；缓存位于 `~/.Elysian/state/website-runtime-catalog.json`，生产代码不维护固定版本表。`bun run check:website-runtimes` 可诊断官方来源与镜像库的自动获取路径；本地演示仍使用可复现 mock。

- `apps/web/`：工作台页面、store、HTTP/WebSocket 与 mock adapter。
- `apps/server-go/`：Go 后端（chi）：同源 API、Docker Engine 调用、数据库协议与本机操作。
- `packages/foundation/contracts/`：跨端类型与纯常量。
- `CONTEXT.md`、`AGENTS.md`、`docs/`：本地设计文档，不进入版本库。

没有接入真实 Kubernetes、云平台或 Agent 推理。真实数据库的账号边界与请求守卫已经实现；面板已落地单管理员登录与服务端会话鉴权，多租户与人员级权限仍待后续完成。SQL 驱动会先解码单个结果行再执行应用侧输出截断，极端超大单行仍可能造成瞬时内存峰值；不要把此版本当作不可信用户可访问的数据库代理。所有 Docker 和数据库操作均具有真实效果，操作前应核对目标容器、版本、端口与删除确认内容。
