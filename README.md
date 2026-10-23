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
- **Ely 智能体**：模型服务配置、内置只读诊断、运行时授权、审批、任务规划与长期记忆。
- **单机部署**：Ubuntu/Debian systemd 安装、单二进制、在线更新与版本回滚。

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
HOME=/var/lib/elysian /usr/local/bin/elysian resetpwd
```

卸载：

```bash
sudo bash scripts/uninstall.sh --dry-run   # 只预览，不修改
sudo bash scripts/uninstall.sh             # 逐项询问数据处置
```

默认保留面板数据；`--purge-data` 删除全部数据（含未分类文件），`--keep-tools` 保留 Go 与 Bun，`--yes` 免交互。Caddy 管理配置默认保留，交互确认后才精确移除。云安全组、域名解析与 HTTPS 证书由部署者管理。

完整安装、恢复与验证说明见 [部署指南](scripts/README-deploy.md)。

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
