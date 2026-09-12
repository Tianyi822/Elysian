# 0001 本期范围与 monorepo 骨架

- 状态：已确认（2026-09-12 访谈第 1 轮）
- 相关：`AGENTS.md` 的「当前阶段与范围」与「目录与边界」，`CONTEXT.md` 的「契约」

## 背景

项目起点提示词给出了一整棵 monorepo 目录树（`apps/{server,web,worker,cli}`、`packages/{foundation,agent,harness,skills,capabilities,execution,persistence,integrations,api,bundles}`、`profiles/`、`vendor/`），但同一份提示词又限定本阶段只实现 Web 侧与本地可运行演示。两种读法会导致完全不同的交付物：一种是照树建目录，一种是只建能跑的东西。

如果把整棵树建成空目录，会得到一堆没有内容的壳：空目录不构成边界，也不会被任何测试或构建验证，几个月后没人知道哪个目录是活的。更糟的是验收标准会变得含混——「目录都在」看起来像完成，实际什么都没实现。

## 决定

本期只真实落地三处：workspace 根骨架（`package.json`、`tsconfig`、workspace glob）、`apps/web`、`packages/foundation/contracts`。其余边界写进 `AGENTS.md` 的「目标结构」清单与本文档，不建空目录，等真正实现时再建。

workspace glob 定为 `apps/*`、`packages/*`、`packages/*/*`。这样 `packages/foundation/contracts` 这种两层分组与未来 `packages/api` 这种一层包可以共存，不必为了目录深度统一而重排结构。

## 理由

只有代码与契约构成边界。未实现的部分写成文档可以被评审、被质疑、被修改；写成空目录只会腐烂，并且掩盖「其实没做」这个事实。

契约先行是本期的核心价值：`@elysian/contracts` 是浏览器侧与未来服务端唯一共享的稳定协议层，先把它立起来，后续所有模块都围绕它生长，而不是先铺目录再倒推接口。

## 放弃的方案

照树建全目录加占位 README：噪声大，且会让「本期完成」这件事失去判据。

本期不做 monorepo、先做单包：与起点提示词的固定技术约束冲突，而且共享契约没有落点，未来还要做一次迁移。

## 影响与验证

`bun install` 后 workspace 只识别 `@elysian/web` 与 `@elysian/contracts` 两个包；`bun run build` 只构建 web。目标结构清单由 `AGENTS.md` 单一维护，实现新边界时同时把它从清单里移除——避免同一个事实出现两个家。

契约包必须保持零运行时依赖，用一个断言测试守住，这样它能同时被浏览器与未来的服务端引用。
