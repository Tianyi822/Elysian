# Elysian

**Agent 辅助的单机运维工作台。**

把容器、数据库、网站、文件与安全配置收进一个面板。Web 使用 React + Vite，后端使用 Go 并发布为内嵌前端产物的单二进制；Docker 运行时连接真实 Docker Engine 与数据库，非 Docker 本地开发使用可复现的演示数据。

> 状态：活跃开发中。接口、数据格式和部署脚本可能继续调整；升级前请备份面板数据目录。

## 特性

- **容器与工作区**：容器启停、删除与状态查看，Dockerfile 镜像构建，compose、`.env`、Dockerfile 工作区与引用自检（不代跑 `docker compose up`）。
- **数据库**：MariaDB、MySQL、Redis 的创建、接管、逻辑库管理与受限协议终端；SQLite 上传、下载与托管。
- **网站部署**：HTTPS Git 或 ZIP/tar.gz 来源，Java、Node、Go、Python、HTML 构建，独立运行容器，版本保留与回滚。
- **文件管理**：大文件流式上传与下载、目录打包、同名冲突确认、一次性传输凭证。
- **安全与访问**：UFW 与 SSH 状态、业务端口规则、单管理员会话、同机 SSO 回跳。
- **可观测性**：资源采样与 SSE 实时刷新、面板诊断日志、运行与操作日志。
- **消息组件**：右上角入口与未读圆点，按时间查看操作结果；历史仅保存在当前浏览器、当前站点，刷新和登出保留，主动清空后删除。
- **Ely 智能体**：模型服务配置、文字与 JPEG/PNG 图片会话、文本文件导入、本地 Docker 工具、运行时授权、审批与任务规划。
- **单机部署**：Ubuntu/Debian systemd 安装、单二进制、在线更新与版本回滚。

镜像拉取窗口会记住当前浏览器最近填写的有效镜像源，清空地址恢复官方源；该偏好只保存在浏览器，不修改宿主 Docker 配置。窄屏镜像列表固定名称列，其余列横向滚动；名称隐藏仓库域名、保留组织路径，完整引用可通过悬停、聚焦或轻点查看。进度与「停止拉取」保持在横向滚动区域之外，展示检查、下载、解压和标签回读阶段。Docker 连续 120 秒无拉取数据时终止请求，总时限十五分钟；上游错误即时返回，取消信号沿流式 HTTP 请求传至 Docker Engine，失败或取消后重新读取本地镜像列表。镜像名称搜索与版本列表分开查询，名称搜索不可用不阻止选择已有版本并拉取；拉取失败在镜像列表中保留具体原因，直到手动关闭或发起新的拉取，连接中断时提示先刷新列表核实结果。

操作消息通过 IndexedDB 分页保存，并在多个标签页间同步；新消息只更新未读圆点，不自动弹出，F8 可打开列表。表单校验与能力说明留在原表单，真实提交失败同时保留行内原因与消息记录；消息存储失败在列表内提供重试，未保存条目标记为仅当前页面可用。消息组件与业务弹窗共享 Radix 焦点管理，关闭消息后返回原表单；清空动画只等待当前可见条目。见本地 [ADR-0056](docs/adr/0056-global-message-center.md)。

Web 聊天支持键入、粘贴和拖放：TXT、Markdown、日志、配置与代码等文本文件以 UTF-8 或带 BOM 的 UTF-16 解码，文件名和正文读入可编辑草稿，与输入文字合计最多 32 KiB（按 UTF-8 字节计算）；JPEG/PNG 图片通过附件接口上传，要求模型支持图片且消息附有文字说明，压缩后单图最多 1 MiB、每条消息图片合计最多 8 MiB。PDF、Office、音视频、其他图片格式及文件夹会明确拒绝并在输入区提示；整批导入失败保留原草稿与附件。HTTP IP 访问使用安全随机字节生成请求标识，复制消息和代码在异步剪贴板不可用时使用兼容复制通道。

普通聊天新 Run 使用 `resource-budget/v1`：累计工具与模型请求次数不限且继续计量，默认每轮 196608 token、600 秒活动时间、2 MiB 工具结果；等待用户、审批、资源与异步任务不计活动时间。派发前预留结果容量，回执按实际字节结算。预算耗尽以 `interrupted` 保存原因和进度，不冻结其他会话。Web「继续任务」在同一 Session／Task 创建新 Run，使用当前模型、思考等级和权限模式，保留原目标、执行事实、计划及底部草稿与附件；未知结果须先核实，不重放旧调用。旧快照、批次与工作流保持原限额，不自动分轮。见本地 [ADR-0064](docs/adr/0064-agent-resource-budgets-and-explicit-continuation.md)。

聊天中的平台异步任务在工具条目下显示阶段与进度条。镜像拉取显示 Docker 当前镜像层的真实字节比例；网站部署、容器镜像构建和数据库任务显示受控阶段，不估算百分比。进度经既有任务监视器和输出流更新，刷新可恢复，不增加模型请求或工具调用。Agent 镜像拉取采用 5 分钟无原始数据保护和 2 小时总上限，持续有数据可继续；普通容器页仍使用 120 秒／15 分钟时限。超时及重启导致的未知结果停止进度动画并显示原因，保留任务身份、租约和重投屏障；页面断开或输出流重连不取消已接受任务。见本地 [ADR-0065](docs/adr/0065-agent-async-task-progress-and-pull-timeouts.md)。

Agent 的本地 Docker 工具提供容器与镜像清单、详情与日志、安全模板创建、启停删除和镜像操作。普通聊天新建、续聊和编辑重发不再加载独立 `database_*` 工具，旧运行和审批保留固定快照。官方 MySQL／MariaDB／Redis 经现有 `docker_container_create_service` 创建并纳入数据库页，初始 SQL 库名使用 `env` 的 `MYSQL_DATABASE`／`MARIADB_DATABASE`，凭据由后端管理。`docker_container_inspect` 默认仅提供有界登记与修订，使用可选 `database.id` 按单库读取元数据和指标；唯一的 `docker_container_exec` 对普通安全服务执行有界命令，对受管数据库只接受明确的逻辑库建删参数并同步登记，不开放绕过登记的任意 Shell。创建与执行共用后台任务监视器，不新增状态查询工具；写操作沿用权限、具体授权和结果未知屏障。登记凭据不进入模型参数，命令输出对已知托管凭据脱敏。见本地 [ADR-0071](docs/adr/0071-docker-agent-tool-convergence-and-update-resource-recovery.md)。

Agent 可通过 `docker_registry_list` 读取与 Web 共用的四个镜像源预设，按需用 `docker_registry_probe` 检查单源样本。搜索不可用不等于镜像不存在，查询失败会交回模型选择其他源；拉取支持独立 `registry`，成功后保留原镜像名称与标签。仅未派发的确定拒绝或完整 Engine 失败响应可以确认失败；Agent 收到错误帧后最多等待两秒正常结束，断线、取消、重启或后续标签处理失败继续保留未知屏障。换源使用新请求标识并重新执行具体操作授权，同一请求仅复用相同镜像与源；后端不隐藏回退，不修改宿主 Docker 的镜像配置。见本地 [ADR-0063](docs/adr/0063-agent-image-registry-discovery-and-retry.md)。

Docker 工具继续经过 `tool_search` 按需加载，不把整个套件或实时 Docker 状态塞进提示词。中英文别名仅用于服务端检索；常驻定义和已加载定义保持稳定前缀，新增定义按持久回执顺序追加，恢复后保持原顺序。见本地 [ADR-0055](docs/adr/0055-agent-local-docker-toolkit.md)。

平台异步任务统一区分进行中、成功、已确认失败和结果未知。受理后、业务变更前可证明的数据库失败显示「数据库变更未执行」并释放租约；SQL 可能执行、登记保存失败或停止未确认时继续保留保护。资源等待显示阻塞资源、所属 Run／操作及持续时间；阻塞方结果未知时，等待方中断并明确本工具未派发。任务状态连续 30 秒无法读取也会中断前台等待，后台继续核实，不据此认定执行已停止。管理员通过既有 `POST /api/agent/execution-barriers/{id}/reconcile` 保存证据，按原操作身份先结清域任务、再结清 harness 屏障；中断后仅续办同一核实决定，不重投业务。取消、迟到回执和对账都不自动续跑终态 Run，核实后由用户手动继续。`requestId` 使用 64 位小写十六进制；详情查询的 `database.id` 来自登记摘要，删除受管容器无需先删逻辑库。见本地 [ADR-0072](docs/adr/0072-agent-async-outcomes-and-coordinated-reconciliation.md)。

Agent 会话删除是强制终止操作：运行中、等待审批或结果未确认均可删除，关联后台任务同时请求取消，聊天记录与运行历史不可恢复；已发生的外部变更不会回滚。迟到模型、工具和发送回执不能恢复会话，自动保留期清理仍跳过未决会话。schema10 保存最小域任务取消清单，确保重启后继续取消收尾；接口路径不变。见本地 [ADR-0062](docs/adr/0062-agent-force-session-deletion.md)。

Agent 将工具未加载、参数无效、输出截断和流缺终帧分别记录为明确错误。普通聊天中，完整响应调用了未加载工具时整批不执行，并在原预算内提供一次固定调用搜索工具的纠正机会；该请求关闭思考且输出最多 4096 token，成功加载后恢复本轮思考等级。续聊明确区分未派发提议与已派发未知结果，历史搜索回执不代表当前工具已加载。数据库任务接受前的确定参数错误可返回模型纠正；已接受或结果未知的操作仍须核实。旧数据库工具的参数约定仅适用于已接受的旧快照；新聊天经 Docker 工具传递本地固定摘要镜像和初始库配置。工具目录注册、共享与回收按代串行化，回收完成前同摘要注册等待，等待可取消；事件回调不持有运行时锁。见本地 [ADR-0060](docs/adr/0060-agent-protocol-correction-and-task-rejection.md) 与 [ADR-0061](docs/adr/0061-agent-continuation-tool-facts-and-catalog-lifecycle.md)。

浏览器可选能力缺失时保留基础操作：分词回落到 Unicode 码点，回答流取消与超时不依赖 `AbortSignal.any/timeout`，跨标签共享受限时直接订阅，尺寸观察和系统显示偏好提供兼容路径。界面偏好无法写入时保存在当前页面并通知，聊天待确认请求仍按原持久化规则处理；终端复制和数据库连接失败明确通知。兼容边界与验证矩阵见本地 [ADR-0048](docs/adr/0048-browser-capability-fallbacks.md)。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 前端 | React 19、Vite 8、Tailwind CSS v4、Radix UI、zustand、React Router 7、ECharts 6 |
| 后端 | Go 1.23、chi、SQLite、Docker Engine API、MariaDB/MySQL/Redis 协议 |
| 契约 | TypeScript strict，`packages/foundation/contracts` |
| 运行 | Bun 1.4（包管理与开发服务器）、systemd（生产） |

## 架构

```text
Browser (React)
   │ same-origin /api + SSE
   ▼
Go single binary (chi + embedded web dist)
   ├─ Ely Agent runtime (models, tools, approvals, memory)
   ├─ Docker Engine (host unix socket)
   ├─ MariaDB / MySQL / Redis
   ├─ SQLite (panel data)
   └─ Host: UFW / SSH / systemd / files
```

面板自身不依赖 Docker；容器、数据库和网站功能需要可访问的宿主 Docker Engine。生产服务以 root 运行，用于执行 UFW、sshd 和 SQLite 降权等宿主操作。

SSH 管理在正式安装中操作宿主 systemd 的 OpenSSH 服务及关联 socket，启停选择跨重启保持；Docker 开发仅管理容器内 sshd。停服保留登录统计与记录，设置区域重新开启后显示。页面每 5 秒回读状态与认证事实，裸机优先读取系统 journal、无 SSH 记录时回退认证日志及轮转文件，近七天统计与最近 2000 条列表独立计算；日志读取失败时显示原因。换端口由后端先核对防火墙并放行，再切换监听，失败恢复原配置和服务；外部 Match、认证组合、自定义启动参数或授权文件冲突会明确拒绝。

## 快速开始

### 环境要求

| 场景 | 需要 |
| --- | --- |
| 本地演示 | Bun 1.4+ |
| Docker 开发 | Docker Engine 与 Docker Compose |
| Go 后端开发 | Go 1.23，或使用项目 Docker 开发容器 |
| 生产部署 | Ubuntu/Debian、systemd、root 权限 |

### 本地演示

```bash
bun install
bun run dev
```

打开 <http://127.0.0.1:48100>。非 Docker 运行时使用可复现的演示数据，不连接真实 Docker、数据库或宿主系统。

### Docker 开发

```bash
bash scripts/dev.sh up
```

前端入口 `http://127.0.0.1:48100`；Go API 只发布到 `127.0.0.1:48102`，由 Vite 同源代理 `/api/*`。macOS Docker Desktop 需要把仓库 `.env` 中的 `ELYSIAN_DOCKER_MOUNT_ROOT` 指向已共享的宿主路径。

开发账号需显式开启：

```bash
ELYSIAN_AUTH_DEV=1 bash scripts/dev.sh up
# 用户名 dev，密码 dev-elysian
```

常用脚本：

```bash
bash scripts/dev.sh down          # 停止两个开发栈
bash scripts/dev.sh restart-go    # 让 Go 代码或环境变量变更生效
```

## 开发与验证

| 命令 | 用途 |
| --- | --- |
| `bun run typecheck` | Web、契约包与测试的 TypeScript 检查 |
| `bun run test` | Web Vitest、契约包与 SQLite 测试 |
| `bun run build` | 构建前端产物 |
| `bun run preview` | 预览构建产物，继续提供 mock SSE |
| `bash apps/server-go/dev-check.sh ./...` | Go 后端的 gofmt、vet、build 与 test，在 Docker 容器内运行 |

提交前请至少运行 `bun run typecheck`、`bun run test` 与对应的 Go 门禁。

## 部署

支持 Ubuntu/Debian + systemd，x86_64 与 arm64：

```bash
git clone https://github.com/Tianyi822/Elysian.git
cd Elysian
sudo bash scripts/install.sh
```

安装脚本会校验并准备 Go 与 Bun，以无特权构建账号生成内嵌前端的单二进制，创建 systemd 服务，并检测或安装 Docker 与 Caddy；默认启用 OpenSSH 与 UFW，放行 SSH 实际端口和面板端口。已存在的 UFW 规则保持不动。

安装和在线更新将 Bun 包、Go 模块及 Go 编译缓存保存在 `/var/lib/elysian-build/cache/`，跨任务复用；源码和前端仍逐次构建，锁文件校验与版本切换事务保持有效。首次启用缓存的构建需要预热，后续仅下载缺少的依赖，并复用未变化的 Go 包编译结果。Bun 输出的“已安装包数”包含从缓存生成新 `node_modules` 的包，不等于下载数。缓存不随更新失败或回滚删除，卸载按构建目录清理；升级到支持缓存的更新器后生效。

在线更新固定从 [GitHub 的 Tianyi822/Elysian](https://github.com/Tianyi822/Elysian) 检查版本、读取日志和下载源码，不提供 Gitee 选项或自动回退。最新提交与最新正式 Release 两种策略均锁定完整 SHA；GitHub 不可达时保留错误，待网络恢复后重新检查。

在线更新先检查内存、swap、磁盘、负载和 Agent 运行，展示可调整的临时停机清单。预检有效五分钟；执行前重新采样，仅停止管理员选定且身份未变的对象，达到 1536 MiB 实测可用内存后停止释放；swap 不计入门槛，最低支持目标为 2 GiB 宿主。低内存可确认提前停止面板与 Agent，由独立 systemd 进程继续更新，期间页面暂时离线。成功或失败均恢复本次实际停止的业务；Agent 保存中断历史，由用户手动继续。停止恢复账本、独立收尾和启动恢复覆盖构建失败及维护进程退出，恢复失败保留维护保护。Go 构建采用串行包编译、最多两线程及 768 MiB 软内存目标，不保证固定峰值。首次从旧版升级仍应人工释放负载，新机制在新版更新器运行后生效。

新版更新器在首次停业务前校验并原子升级稳定恢复程序，版本回滚仍保留其恢复能力。服务只在同次开机、静态身份与已确认停止代次均未变时自动启动；主机重启后仍停止、运行历史被 systemd 清除或身份变化的服务保留恢复账本及失败状态，需管理员核实后手动恢复。重启后已自行运行且身份一致的服务仅确认现状，不重复启动。

Docker 缺失时直接使用 Docker CE 签名 apt 仓库安装，默认依次探测阿里云、清华 TUNA、官方源，不依赖 `get.docker.com`。镜像公钥须匹配固定的 Docker 官方主指纹，签名索引须通过校验并包含目标发行版、架构与 stable 频道。可用 `sudo env ELYSIAN_DOCKER_MIRROR=tuna bash scripts/install.sh` 指定 `aliyun`／`tuna`／`official`，指定后不自动换源；缺省 `auto` 仅在安装前探测阶段回退。已有 Docker 正常复用，未知的既有 apt 配置保持原样。Go 本体保留 golang.google.cn／阿里云下载回退、模块保留 goproxy.cn／阿里云代理，Bun 本体及包保留 npmmirror 回退与 registry 配置，工具包仍核验官方摘要。

默认入口：

| 入口 | 地址 |
| --- | --- |
| 面板 | `http://<服务器公网 IP 或域名>:48100` |
| 后端 | `127.0.0.1:48101`（仅本机回环） |

管理员用户名为 `admin`；首次启动的初始密码只打印一次：

```bash
journalctl -u elysian -b --no-pager | grep '初始密码'
```

忘记密码时重置（全部会话失效）：

```bash
sudo ely resetpwd
```

卸载：

```bash
sudo bash scripts/uninstall.sh --dry-run   # 只预览，不修改
sudo bash scripts/uninstall.sh             # 展示彻底清理清单，确认后执行
sudo bash scripts/uninstall.sh --keep-data --keep-dependencies --keep-tools --keep-caddy-config  # 保留数据和运行环境
```

**卸载默认删除全部面板数据与凭据**，并清理程序、构建缓存、账号、管理配置，以及有可信安装记录且未使用的 Docker/Caddy 和工具链；`--yes` 直接执行该清单。需要保留时显式使用 `--keep-data`、`--keep-dependencies`、`--keep-tools` 或 `--keep-caddy-config`，`--purge-data` 为默认清理行为的兼容参数。安装归属记录位于 `/var/lib/elysian-installer`，已有组件和旧安装不自动认领；容器、镜像、卷、自定义网络、动态 Caddy 路由或异常权限会阻止相关依赖清理，列出未完成项并非零退出。软件包移除不会盲删 `/var/lib/docker`、`/var/lib/containerd`、`/var/lib/caddy` 内的业务数据；私有恢复备份单独列出，由管理员核对后清理。云安全组、域名解析与 HTTPS 证书由部署者管理。

安装会在源码构建前检查标准 Caddy 服务的启动配置与读取权限。已安装程序但 `Caddyfile` 缺失时明确中止；先停止 Caddy，再使用 `sudo bash scripts/install.sh --restore-caddyfile /可信备份的绝对路径/Caddyfile` 恢复并继续安装。恢复只接受 root 所有、其他用户不可写且不经过符号链接的文件，校验通过后仅发布到缺失目标，绝不覆盖已有配置。

平台依赖安装前仍核对未完成任务、宿主端口、登记与防火墙，只将 Docker 协议端口核验推迟到 Docker 启动并验证之后；版本切换前继续完整核验，包含停止容器的端口预留。卸载 Docker 后仅清理 root 所有、明确拒绝连接且 inode 未变的残留 socket，活动监听、异常路径与未知状态均保留并报告。

旧安装没有收据时，可明确指定 `sudo bash scripts/uninstall.sh --remove-legacy-components caddy,docker,go,bun` 清理这些组件，无需伪造或补写安装归属。参数只接受这四个固定名称，保留选项优先；Docker 仍须没有业务资源，Caddy 仍须是默认欢迎站点且运行配置与磁盘完全一致，软件包移除仍不得影响其他软件。该参数不会自动删除容器或数据库卷。

完整安装、恢复与验证说明见 [部署指南](scripts/README-deploy.md)。

## 原生 CLI 与 Agent 终端

systemd 安装提供全局命令 `ely`，由 `/usr/local/bin/ely` 链接到同一面板二进制；无需 Node.js。`ely` 打开交互菜单，`ely agent` 直接进入 Agent 终端，`sudo ely resetpwd` 直接重置生产面板密码；改密支持两次隐藏输入或标准输入的两行密码，原 `elysian resetpwd` 入口保留。`ely help`、`ely help upgrade` 和各子命令的 `-h`／`--help` 查看参数与示例，`ely --version` 显示构建版本，帮助和版本无需登录或面板运行。

`ely upgrade` 复用已有 CLI 登录，缺少登录时显示登录表单；固定使用 GitHub，选择最新提交／最新正式发版，检查后确认更新。也可直接运行 `ely upgrade --channel release --yes`（`--yes` 可写为 `-y`），非交互执行必须显式提供策略和确认参数（`--source github` 可省略），并已有有效 CLI 登录。更新复用设置页的维护任务、来源锁定、日志、备份与回滚机制，不自动换源。终端显示真实阶段、耗时和可滚动日志；Ctrl+C 退出监控，已接受的服务端任务继续执行，再次运行优先恢复。请求与任务指针独立保存在执行用户的 `~/.elysian/cli/upgrade.json`（0600），不覆盖 Agent 草稿；提交结果未知时先按原请求编号核实，人工重试复用原目标与编号。历史 Gitee 任务保持原来源；原请求只做精确对账，未受理时由服务端拒绝，不改投 GitHub。面板重启后核对实际运行提交；CLI 注册失败可按 `r` 重试，非交互可用原参数与 `--yes` 再次运行。

`ely upgrade` 在提交前展示同一资源预检。`--yes` 仅确认更新，不自动授权停业务；非交互释放资源须明确提供 `--stop-container <完整ID>`、`--stop-service <unit>`、`--stop-panel`。提交结果未知时沿用已保存的资源计划和请求编号对账，不重新选择停机范围。

Web 与 CLI 的新聊天统一按本轮 `permissionMode` 裁决：请求批准保留已确认的只读能力直达，其余逐次确认；帮我批准额外自动批准可恢复的任务工作区写入和无宿主写权限、无出网的隔离执行；完全开放自动批准已启用能力所需的具体操作与运行时权限，包括 MCP、脚本、目录、网络和镜像准备。服务端将具体操作授权与固定参数先持久化再派发，系统禁区和资源限额继续生效；未知准备结果仍须核实，不自动重复执行。新运行使用 `permission-modes/v2`，不创建或复用会话允许项；已接受的旧运行沿用原快照。

普通聊天按精确名单退役 16 项冗余平台工具，新增 3 项承接入口，可见工具净减少 13 项。新建、续聊与编辑重发在环境副本中按已装配目录承接旧选择，原环境和已接受 Run 保留；容器启停统一为 `docker_container_power`，网站动作在同一项目互斥内核对审批容器并完成重启。异步任务按所属域真实状态转换 Outcome，构建与发布继续等待，未确认结果保留保护；同步确定未派发的登记拒绝交回模型纠正。工具可见集合与定义顺序从同一次持久搜索回执读取共同恢复。决定见 [ADR-0073](docs/adr/0073-agent-platform-tool-slimming.md) 与 [ADR-0072](docs/adr/0072-agent-async-outcomes-and-coordinated-reconciliation.md)。

侧边栏「知识 Wiki」的 `/wiki` 提供空间选择、刷新、页面浏览和人工编辑，保存按修订检测冲突并保留草稿。完整工作台 `/agent/memory`、聊天记忆选择及专属管理 API 已退役；新接受的聊天（含续聊和编辑重发）使用 `disabled/v1`，不查阅或整理知识库，历史引用仍读取当时的固定修订。未完成的整理和索引任务在恢复时标记功能退役中断，不再执行；已有页面、授权和运行记录保留。浏览、人工编辑和历史引用 API 继续鉴权，退役接口返回 404。决定见 [ADR-0054](docs/adr/0054-wiki-retirement-and-unified-permission-modes.md)。

Agent 终端通过回环 HTTP 消费现有 Go Harness，与 Web 共用服务端会话、模型、公开消息、运行、授权和图片。端口读取面板数据根下 `config/panel-network.json`；面板数据根按 `ELYSIAN_PANEL_HOME`、正式安装目录、执行用户 `~/.Elysian` 的顺序查找。

普通聊天的失败、系统中断和带明确错误的系统自动取消由服务端追加「运行结果」，正文说明真实失败原因；缺少原因时显示通用异常说明。结果与终态同事务保存到 SQLite／JSONL，按 Run 去重，不额外请求模型、不改变运行失败状态，刷新和重新登录可回读。旧失败轮次通过只读终态快照补齐展示；已有思考、正文片段和工具过程保留，正式结果可复制。明确的手动停止沿用保留已接收片段的行为；系统撤回资料等自动终止通过取消事件区分。发送框与编辑重发框使用 16px 字号。

Web 澄清卡片确认普通选项后自动进入下一题，方向键仅切换选项，最后一题手动提交；自定义回答保留输入，通过下一步或 Ctrl／⌘ + Enter 继续。数据库创建要求官方镜像的明确数字版本标签，不支持 `latest` 或变体后缀；本地确定的参数拒绝作为失败工具结果交回模型。授权、取消、超时、存储故障及未知执行结果仍按原中断与恢复规则处理。

Agent 可通过内置只读工具 `web_fetch({url})` 自动读取公网 URL 的标题、正文和链接，支持 HTML、纯文本、Markdown 与 JSON，Web 和 CLI 共用调用记录。读取仅发 GET，不携带登录状态、不执行 JavaScript、不访问内网；不支持搜索引擎、PDF 或交互浏览。每次最多 20 秒、5 次重定向、解压后响应 2 MiB、正文 32 KiB、20 条链接，正文截断会明确标记；网络连接与跳转均校验公网地址，网页资料不能授予执行权限。细节见本地 [ADR-0049](docs/adr/0049-agent-public-url-reading.md)。

| 快捷键 | 操作 |
| --- | --- |
| F1 | 全局帮助，可滚动查看全部操作及禁用条件 |
| F2 | 编辑最后一条服务端用户消息并重发；仅会话空闲、装配成功且无未确认提交时可用 |
| F3 | 分页浏览 Run，查看完整思考、工具参数与结果、计划、实际用量及终态原因；`r` 重试 |
| F4 | 添加 JPEG/PNG 图片；`a` 文件选择、`p` 路径、`d` 移除草稿、`e` 导出、`o` 显式外部打开 |
| Enter / Ctrl+J | 发送（未确认时重试原完整请求）/ 换行 |
| Shift+Tab | 切换本轮权限模式，运行中和提交未确认时禁用 |
| Ctrl+S / Ctrl+T / Ctrl+P | 停止本轮 / 展开思考 / 展开计划 |
| Ctrl+A / Ctrl+O | 审批 / 工具详情和用量 |
| PgUp、PgDn、Home、End | 滚动消息；详情使用各自滚动区域 |
| Esc / Ctrl+C | 逐层返回 / 退出整个 CLI；退出客户端不取消服务端已受理任务 |

会话列表支持新建、改名、删除、分页和模型/思考档选择。审批面板支持普通允许/拒绝及运行时本次确认，不提供独立会话授权列表或撤回；澄清问题回答后继续原 Run。普通草稿、编辑草稿及各自图片互相独立，编辑时 Esc 恢复普通草稿。已替换轮次不会重新混入公开对话，但原始 Run 仍可在 F3 查看。

图片通过正式附件 API 上传后只提交服务端引用。准备阶段校正 JPEG 方向、将最长边限制为 6000 像素、单张处理至 1 MiB，每条消息图片合计最多 8 MiB；透明 PNG 保留透明度，合规图片保留原字节。为限制本地解码资源，原文件最多 64 MiB、8000 万像素。处理支持取消；上传结果未知时保留状态，不自动重传。已发送附件从服务端导出，不随草稿移除；无图形环境使用导出的绝对路径。模型图片能力与最终限额由服务端裁决。

本地凭据和状态保存在执行用户的 `~/.elysian/cli/`（区别于面板 `~/.Elysian`），目录 0700、文件 0600，不保存密码。`state.json` 为版本 2，兼容已有纯文本草稿和草稿信封；保存完整待确认请求、普通/编辑草稿、图片引用与上传状态。发送遵循冻结请求、同步持久化、HTTP 派发的顺序，写盘失败禁止派发；文件与目录同步、跨进程文件锁及每会话修订合并防止静默覆盖。恢复只按 `sessionId` 与 `requestId` 查询 Run，同文消息不代表已受理；查不到时保留请求，由人工使用原完整请求重试。损坏或较新状态文件会报错并保留原文件。

用量显示实际 `actualTokens` 与 `cachedTokens`，保留未知和明确零；平均命中率使用服务端 `cacheHitUsage`，分类占比按估算总量计算并标注本地估算，不将预算记账量展示为实际消费。

安装和在线维护的 CLI 链接注册均先持久化意图、原目标与构建标识，修改后验证 `ely --version`，失败恢复原命令；外部同名文件保持原样并报错，卸载只清理本面板受管链接。新 Worker 发起升级时注册属于维护事务，失败按既有策略回滚。旧 Worker 首次升级时，新服务等待升级提交并释放执行锁后补注册；失败保留已提交的面板版本，设置页明确显示“面板升级成功、CLI 注册失败”并提供重试。

维护任务的可选 `cliRegistration` 包含 `status: pending | succeeded | failed` 及 `error`；管理员经同源 `POST /api/panel/tasks/{id}/cli-registration/retry` 重试，沿用维护互斥，只允许当前构建对应的已提交更新。补注册日志放在 `state/panel-maintenance/cli-registration/`，不混入旧版任务扫描。中断的待完成注册在服务重启后恢复，明确失败等待人工重试。

登录后的面板在所有页面持续监控更新，包括 CLI 和其他标签页发起的任务：空闲每 15 秒检测，活动任务每 2 秒读取；断连预算耗尽后每 5 秒探测恢复。更新成功且实际运行提交与目标一致后，当前页面中央显示 160px 圆形 30 秒倒计时，按当前主题配色，无背景遮罩。悬停或键盘聚焦显示“立刻重启”，点击、Enter、Space 或触屏轻点立即重新加载当前地址，到时也自动加载；这里不再次重启服务。离开设置页、切换标签页不会重置截止时间。浏览器冻结或设备休眠期间无法保证准点执行，恢复后立即补做。CLI 注册失败不阻止倒计时，设置页继续提供错误与重试入口；版本核对失败则保留错误与手动重载入口。

发布脚本使用同一完整构建提交注入前后端，已加载目标版本时不重复提示。倒计时和一次性重载标记按标签页保存在 sessionStorage；登出清空。普通服务重启及端口切换继续使用原有流程。

## 配置与数据

正式安装时服务进程 `HOME=/var/lib/elysian`，面板数据位于 `/var/lib/elysian/.Elysian/`；未使用 systemd 的本地运行位于 `~/.Elysian/`。下表路径均相对于该数据根目录。

| 路径 | 内容 |
| --- | --- |
| `config/` | 面板凭据、端口、数据库/网站/容器登记、模型与 MCP/Skill 配置 |
| `data/` | SQLite 数据库、Agent 记录与运行事实 |
| `logs/` | `panel.log`、sshd 日志等 |
| `state/` | 维护任务、启停与密码重置状态 |
| `backups/` | 写系统文件前的备份与维护事务 |
| `tmp/` | 下载打包、上传暂存等临时文件 |

面板端口的唯一来源是 `config/panel-network.json`（1–65535、前后端互异）。修改端口请使用「系统设置 → 面板维护」，不要手改后忘记同步 UFW。

常用环境变量：

| 变量 | 用途 |
| --- | --- |
| `ELYSIAN_DOCKER_SOCKET` | 覆盖 Docker Engine socket |
| `ELYSIAN_CADDY_SOCKET` | 覆盖 Caddy 管理 socket |
| `ELYSIAN_PANEL_HOME` | CLI 显式指定面板数据根（不是 CLI 用户状态目录） |
| `ELYSIAN_AUTH_DEV=1` | 开启开发账号（仅开发环境） |
| `ELYSIAN_DOCKER_MOUNT_ROOT` | Docker 开发的工作区挂载根 |
| `ELYSIAN_GO_STATE_VOLUME` | 浏览器联调使用的独立状态卷 |

## 安全说明

- 面板通过宿主 Docker socket 管理容器，挂载 socket 等价于宿主级容器管理权限；请限制能访问面板的网络，优先使用内网、VPN 或带认证的反向代理。
- 生产 systemd 服务以 root 运行，用于执行 UFW、sshd 与 SQLite 降权等宿主操作；请把面板视为高权限运维工具。
- 默认单管理员、单会话，不包含多租户与人员级权限。
- 面板不向用户或模型提供任意宿主 Shell；网站构建在一次性受限容器内执行，Agent 脚本与 MCP 使用固定摘要的受限容器，工具调用受固定能力与审批约束。
- 所有容器、数据库、文件与防火墙操作都具有真实效果；执行前核对目标、端口与删除确认内容。
- 域名 HTTPS 由宿主 Caddy 使用部署者提供的证书提供；面板不申请、签发或续期证书。
- 仓库不包含真实凭据；模型、数据库与 MCP 凭据由部署者在面板中配置，只写不回显。

## 项目结构

```text
apps/
  web/                      React + Vite 前端
  server-go/                Go 后端：Docker、数据库、文件、网站、Agent 运行内核
packages/
  foundation/contracts/     跨端类型与纯常量
scripts/                    安装、卸载、开发与测试脚本
docs/                       本地设计文档与 ADR（不随仓库分发）
```

## 已知边界

- 面向单台 Linux 主机；不接入 Kubernetes、云厂商或外部 SSH 集群，不提供高可用。
- 不提供多用户、角色与租户隔离；面板是单管理员工具。
- 非 Docker 本地开发使用演示数据；真实 Docker、数据库与网站功能需要 Docker Engine。
- 网站 Git 来源仅支持 HTTPS；不支持 SSH Git、WAR/Tomcat 与多环境发布。
- 网站构建、Agent 容器执行与数据库协议终端有独立限额；具体值以界面与部署配置为准。

## 贡献

欢迎提交 Issue 与 Pull Request。较大的改动请先开 Issue 说明目标、影响面与验证方式；提交前运行「开发与验证」中的检查。

设计与决策记录保留在维护者本地工作区的 `AGENTS.md`、`CONTEXT.md` 与 `docs/`，不进入版本库。

## License

仓库尚未附带 LICENSE 文件。若计划以开源方式使用或分发，请先补充许可证（例如 MIT 或 Apache-2.0）；在此之前默认保留所有权利。
