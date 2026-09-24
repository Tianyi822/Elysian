# Elysian

Elysian 是 Agent 辅助的运维工作台：把当前事故、Agent 的分析过程、待审批动作与审计记录放在同一个界面里，供值班工程师扫视与决策。产品定位是克制、高密度、适合长时间使用的运维控制台，不做宣传页或角色展示页。

## 当前阶段

Web 侧当前只交付**仪表盘**一个界面（模板化卡片网格布局，ADR-0007）：单机资源监控（CPU、内存、网络 IO、磁盘 IO 的当前值与迷你趋势，以及运行负载 1/5/15 分钟与磁盘按挂载点占用的横向条形图）在内容区顶部，指标卡、按职责模块拆分与最近活动在其后，侧边栏底部保留切换主题，数据全部来自本地 mock。此前的七个界面（事件中心、事故详情、Agent 运行、技能目录、审批队列、审计日志、系统设置）已删除，其领域概念保留在契约与 mock 数据集里，界面将在后续阶段按同一模板逐个回归。

不连接真实 Kubernetes、SSH、云厂商或数据库，不调用真实模型，没有用户认证与多租户，不实现生产级权限系统。唯一的网络请求是同源的 mock 事件流端点 `GET /api/events`（SSE），由 dev 与 preview 的 Vite 插件提供；端点不可用时界面自动降级到内存事件源。所有动作都停在「待接入真实执行」，不会呈现为已执行。

## 快速开始

```bash
bun install
bun run dev        # 启动开发服务器与 mock 事件流端点，打开工作台
bun run build      # 生产构建
bun run preview    # 以 mock 事件流端点服务构建产物
bun run test       # Vitest 全量测试
bun run typecheck  # Web 应用与契约包的类型检查
```

### Docker 开发（宿主机编辑，容器内跑）

源码通过挂载同步到 Ubuntu 容器；改代码走 Vite 热更新，不必每次重建镜像。依赖装在容器 volume 里，不会覆盖宿主机的 `node_modules`。编排含 `docker:dind` 边车（privileged），为容器页提供 Engine API；web 容器经共享卷上的符号链接访问 `/var/run/docker.sock`。在 Docker 运行时（`ELYSIAN_DOCKER=1`）容器页的列表、镜像、启停与终端走真实 Engine（`/api/docker`）；宿主机本地 `bun run dev` 仍用 mock 容器数据。容器内资源指标历史写入命名 volume `elysian_metrics`，挂载到 `/var/lib/elysian`（SQLite 文件 `metrics.sqlite`），不会落在宿主绑定目录 `.:/app` 下。本地 `bun run dev`（未设 `ELYSIAN_DOCKER`）时仪表盘筛选栏会显示「演示数据」；`docker compose up` 注入 `ELYSIAN_DOCKER=1` 后该标识隐藏，图表走容器内采样与持久化库。

```bash
docker compose up          # 前台启动，浏览器打开 http://localhost:5173
docker compose up -d       # 后台
docker compose down        # 停掉
docker compose build       # 仅当 Dockerfile.dev 变更时
```

## 目录与版本库范围

仓库跟踪 `README.md`、`.gitignore` 与全部代码；设计文档留在本地工作区，不入库。

```text
README.md                       # 本文件
apps/web/                       # React + Vite 工作台：外壳与仪表盘
packages/foundation/contracts/  # @elysian/contracts：跨端领域协议，零运行时依赖
CONTEXT.md / AGENTS.md          # 本地共识文档，不入库
docs/                           # 决策记录与规格，不入库
.scratch/                       # 票与规划材料，不入库
```

目标结构里尚未实现的边界（`apps/server`、`apps/worker`、`apps/cli`、`packages/harness/*`、`packages/skills/*`、`packages/capabilities/*`、`packages/execution/*`、`packages/persistence`、`packages/integrations`、`packages/api`、`packages/bundles`、`profiles/`）只登记在本地文档里，本阶段不建目录。

## 边界与红线

以下摘要来自本地共识文档 `AGENTS.md`。该文档与 `docs/` 都不入版本库，仓库内保留这份摘要，完整版以其为准。

- 不接入真实 Kubernetes、SSH、云厂商或数据库凭证；界面上的数据库凭证只作演示并明确标注。
- 不执行 Shell、任意 JavaScript 或用户提供的脚本。
- 不实现真正的模型调用，不把随机文本伪装成真实 Agent 结论。
- 不实现生产级权限系统，只保留前端状态与接口占位。
- 高风险动作必须显示明确的审批状态，不能伪装成已经执行。
- 不 vendor Cordis 源码，不让框架运行时进入浏览器依赖图。
- 界面状态一律「文字 + 颜色」，不依赖颜色单独表达；布局采用模板化卡片网格，可访问性底线见本地 `AGENTS.md`。

## 本地文档

设计文档有意留在本地工作区、不进版本库，需要时在开发机上查看。

- `CONTEXT.md`：术语与领域的唯一权威，含枚举取值与中文标签表。
- `AGENTS.md`：工程约定、目录与边界、契约层规则、mock 与数据层约定、验收标准。
- `docs/adr/`：决策记录，记录「为什么」。
- `docs/specs/2026-09-12-web-workbench-spec.md`：本阶段的规格。
- `.scratch/web-workbench/issues/`：拆分后的 11 张票与验收标准。
