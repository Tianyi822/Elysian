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

Agent 的本地 Docker 工具由宿主注入的 kardia 插件管理：提供容器与镜像清单、完整 ID 的单项详情、安全模板容器创建与启停删除、镜像搜索／标签／拉取任务及删除。新建、续聊和编辑重发会补齐已装配且经内核审核的 Docker 目录，旧会话中仅保存拉取任务工具的选择不会继续挡住本地清单；已接受的运行和工作流仍保留固定快照。查询结果只提供有界摘要，容器环境变量、命令及挂载内容不进入工具结果。写操作沿用权限模式、具体操作授权、资源边界和结果未知屏障。

Docker 工具继续经过 `tool_search` 按需加载，不把整个套件或实时 Docker 状态塞进提示词。中英文别名仅用于服务端检索；常驻定义和已加载定义保持稳定前缀，新增定义按持久回执顺序追加，恢复后保持原顺序。见本地 [ADR-0055](docs/adr/0055-agent-local-docker-toolkit.md)。

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
sudo bash scripts/uninstall.sh             # 逐项询问数据处置
```

默认保留面板数据；`--purge-data` 删除全部数据（含未分类文件），`--keep-tools` 保留 Go 与 Bun，`--yes` 免交互。Caddy 管理配置默认保留，交互确认后才精确移除。云安全组、域名解析与 HTTPS 证书由部署者管理。

完整安装、恢复与验证说明见 [部署指南](scripts/README-deploy.md)。

## 原生 CLI 与 Agent 终端

systemd 安装提供全局命令 `ely`，由 `/usr/local/bin/ely` 链接到同一面板二进制；无需 Node.js。`ely` 打开交互菜单，`ely agent` 直接进入 Agent 终端，`sudo ely resetpwd` 直接重置生产面板密码；改密支持两次隐藏输入或标准输入的两行密码，原 `elysian resetpwd` 入口保留。`ely help`、`ely help upgrade` 和各子命令的 `-h`／`--help` 查看参数与示例，`ely --version` 显示构建版本，帮助和版本无需登录或面板运行。

`ely upgrade` 复用已有 CLI 登录，缺少登录时显示登录表单；选择 GitHub／Gitee，再选择最新提交／最新正式发版，检查后确认更新。也可直接运行 `ely upgrade --source github --channel release --yes`（`--yes` 可写为 `-y`），非交互执行必须显式提供来源、策略和确认参数，并已有有效 CLI 登录。更新复用设置页的维护任务、来源锁定、日志、备份与回滚机制，不自动换源。终端显示真实阶段、耗时和可滚动日志；Ctrl+C 退出监控，已接受的服务端任务继续执行，再次运行优先恢复。请求与任务指针独立保存在执行用户的 `~/.elysian/cli/upgrade.json`（0600），不覆盖 Agent 草稿；提交结果未知时先按原请求编号核实，人工重试复用原目标与编号。面板重启后核对实际运行提交；CLI 注册失败可按 `r` 重试，非交互可用原参数与 `--yes` 再次运行。

Web 与 CLI 的新聊天统一按本轮 `permissionMode` 裁决：请求批准保留已确认的只读能力直达，其余逐次确认；帮我批准额外自动批准可恢复的任务工作区写入和无宿主写权限、无出网的隔离执行；完全开放自动批准已启用能力所需的具体操作与运行时权限，包括 MCP、脚本、目录、网络和镜像准备。服务端将具体操作授权与固定参数先持久化再派发，系统禁区和资源限额继续生效；未知准备结果仍须核实，不自动重复执行。新运行使用 `permission-modes/v2`，不创建或复用会话允许项；已接受的旧运行沿用原快照。

侧边栏「知识 Wiki」的 `/wiki` 提供空间选择、刷新、页面浏览和人工编辑，保存按修订检测冲突并保留草稿。完整工作台 `/agent/memory`、聊天记忆选择及专属管理 API 已退役；新接受的聊天（含续聊和编辑重发）使用 `disabled/v1`，不查阅或整理知识库，历史引用仍读取当时的固定修订。未完成的整理和索引任务在恢复时标记功能退役中断，不再执行；已有页面、授权和运行记录保留。浏览、人工编辑和历史引用 API 继续鉴权，退役接口返回 404。决定见 [ADR-0054](docs/adr/0054-wiki-retirement-and-unified-permission-modes.md)。

Agent 终端通过回环 HTTP 消费现有 Go Harness，与 Web 共用服务端会话、模型、公开消息、运行、授权和图片。端口读取面板数据根下 `config/panel-network.json`；面板数据根按 `ELYSIAN_PANEL_HOME`、正式安装目录、执行用户 `~/.Elysian` 的顺序查找。

普通聊天的失败、系统中断和带明确错误的系统自动取消由服务端追加「运行结果」，正文说明真实失败原因；缺少原因时显示通用异常说明。结果与终态同事务保存到 SQLite／JSONL，按 Run 去重，不额外请求模型、不改变运行失败状态，刷新和重新登录可回读。旧失败轮次通过只读终态快照补齐展示；已有思考、正文片段和工具过程保留，正式结果可复制。明确的手动停止沿用保留已接收片段的行为；系统撤回资料等自动终止通过取消事件区分。发送框与编辑重发框使用 16px 字号。

Web 澄清卡片确认普通选项后自动进入下一题，方向键仅切换选项，最后一题手动提交；自定义回答保留输入，通过下一步或 Ctrl／⌘ + Enter 继续。数据库发现要求明确版本标签，不支持 `latest`；参数错误作为失败工具结果交回模型，继续同批工具与原 Run。授权、取消、超时、存储故障及未知执行结果仍按原中断与恢复规则处理。

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
