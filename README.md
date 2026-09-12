# Elysian

Elysian 是 Agent 辅助的运维工作台：把当前事故、Agent 的分析过程、待审批动作与审计记录放在同一个界面里，供值班工程师扫视与决策。产品定位是克制、高密度、适合长时间使用的运维控制台，不做宣传页或角色展示页。

## 当前阶段

只实现 Web 侧、可本地运行的前端演示。没有生产后端，不连接真实 Kubernetes、SSH、云厂商或数据库，不调用真实模型，没有用户认证与多租户。

演示数据来自本地 mock。唯一的网络请求是同源的 mock 事件流端点 `GET /api/events`（SSE），用于固定实时刷新的传输形状，不涉及任何真实基础设施地址。界面固定位置常驻「演示数据·未连接真实基础设施」标识，危险动作一律标注为 mock 或待接入，不会呈现为已执行。

## 快速开始

脚手架尚未落地，本阶段目前只有共识文档。落地后以下命令必须全部可用。

```bash
bun install
bun run dev       # 启动开发服务器并显示工作台
bun run build     # 构建
bun run test      # Vitest 全量测试
bun run preview   # 以 mock 事件流端点服务构建产物
```

## 目录

```text
apps/web                        # 本期唯一实现的入口：React + Vite 工作台
packages/foundation/contracts   # @elysian/contracts：跨端领域协议，唯一权威
docs/adr/                       # 决策记录
docs/source/                    # 起点文件（历史材料）
```

其余目录（`apps/server`、`apps/worker`、`apps/cli`、`packages/harness/*`、`packages/skills/*`、`packages/capabilities/*`、`profiles/` 等）属目标结构，本阶段不建目录，理由与清单见 `docs/adr/0001-phase-one-scope-and-monorepo-skeleton.md`。

## 边界与红线

以下摘要来自本地共识文档 `AGENTS.md`；因为该文档不入版本库，仓库内保留一份摘要，完整版以其为准。

- 不接入真实 Kubernetes、SSH、云厂商或数据库凭证。
- 不执行 Shell、任意 JavaScript 或用户提供的脚本。
- 不实现真正的模型调用，不把随机文本伪装成真实 Agent 结论。
- 不实现生产级权限系统，只保留前端状态与接口占位。
- 高风险动作必须显示明确的审批状态，不能伪装成已经执行。
- 不 vendor Cordis 源码，不让框架运行时进入浏览器依赖图。
- 界面状态一律「文字 + 颜色」，不依赖颜色单独表达；不做 Hero、巨型标题、装饰性渐变与卡片堆叠。

## 文档入口

- `CONTEXT.md`：术语与领域的唯一权威，含枚举取值与中文标签表。
- `AGENTS.md`：工程约定、目录与边界、契约层规则、mock 与数据层约定、验收标准。
- `docs/adr/`：决策记录，记录「为什么」。
- `docs/source/project-prompt.md`：项目起点提示词原文，历史材料，冲突时以共识文档为准。

`CONTEXT.md` 与 `AGENTS.md` 是本地工作区的共识文档，按约定不入版本库（列在 `.gitignore`），因此新克隆的仓库里看不到它们；仓库内共享的部分是 `README.md` 与 `docs/`。
