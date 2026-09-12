# 0002 契约层落点与 Cordis seam 保真度

- 状态：双层落点已确认；保真度按推荐落地待复核（2026-09-12 访谈第 1、3 轮）
- 相关：`AGENTS.md` 的「契约层规则」与「Cordis seam 对齐」，`CONTEXT.md` 的「契约」「类型化事件」「能力接缝」

## 背景

起点提示词内部有一处冲突：`## 目标项目结构` 说 `packages/foundation/contracts` 是「所有模块共享的稳定协议层」，而 `## 前端架构要求` 又把 `contracts` 列为 Web 应用内部的五分之一（`app`、`features`、`components`、`stores`、`contracts`、`adapters`）。照前者做，web 侧展示态类型会被推进共享包；照后者做，未来服务端无法复用协议。这处冲突必须在动工前定死，否则契约边界会随实现漂移。

第二处需要定的是保真度。起点提示词要求「通过类型化接口模拟未来的 Cordis service 和 event seam」，但没有说模拟到什么程度。事实是真实 Cordis 的形状已经可以核对：本地 `deepseek-harness` vendor 了 `@deepseek-ai/cordis` 4.0.2，其 `Context` 用 `declare module` 扩展以声明 ctx 键与类型化事件，事件声明带 `@mode`（`emit | waterfall | serial | parallel`），服务以名字注册到 ctx，并且已有一批与运维域直接相关的既有取值（`AgentStatus = idle | running`、`TurnEndReason`、`ApprovalOutcome = allowed-once | rejected | cancelled | unavailable`、`ApprovalPolicy = ask | never`、`SandboxMode`）。命名上它用 seam 描述可替换能力的三角色模型，而起点提示词另造了 `capability-broker`；`bundles` 与 `profiles` 则本来就是它的原话。

## 决定

契约分两层，职责不重叠。`packages/foundation/contracts`（`@elysian/contracts`）放跨端领域协议：`Events` 接口、`Context` 服务声明、领域类型、枚举与中文标签表、13 个职责模块词典。`apps/web/src/contracts` 只放 web 侧视图模型与 adapter 接口，以及聚合它们的 `ElysianGateway`。

契约按 Cordis 真实形状定义：`Events` 用 `declare module '@elysian/contracts'` 扩展并带 `@mode` JSDoc，事件名用 `域/动作`（`approval/request`、`tools/pre-execute`），waterfall 回调带 `next()`；`Context` 用同样的方式声明 `skills`、`approvals`、`audit` 等键。实现由 web 侧 adapter 提供，本期不引入 Cordis 运行时。

命名上，生态里已有的概念一律沿用其词，不另造同义词。`seam` 是权威英文词，`capability-broker` 保留为「能力代理」这个运行时组件的名字，它是 seam 的门面与消费者，不是 seam 的同义词。Elysian 只新增生态里没有的运维域词汇：严重等级、风险等级、事故状态、运行状态、审批队列状态、审计类型。

Elysian 与 `deepseek-harness` 的关系按「独立产品、仅共享 Cordis 底座与词汇」处理：不共享代码，不消费它的 `/api` 与 `/api/remote.mux`，不承诺成为它的控制台。对齐词汇是为了降低未来的接入成本，不是硬约束。

## 理由

双层落点同时满足提示词的两节，且冲突点消失：协议在共享包里被服务端与浏览器共同引用，视图模型留在 web 侧随界面演进，两者不会互相污染。

保真度选择贴近真实形状的理由是可替换性。如果契约的形状与真实 Cordis 一致，未来接入时是**替换实现**而不是**修改类型**——adapter 层换实现，类型与 store 不动。如果只做中性自定义类型，就需要长期维护一层翻译，而翻译层会在两边各自演进时持续产生错位。

术语沿用生态既有词的理由是避免同义词分裂：`seam`、`skill`、`bundle`、`profile` 都是 Cordis 生态的既有概念，Elysian 造同义词只会让未来读两边代码的人多学一套词。

## 放弃的方案

只对齐领域类型、事件机制简化为单一 emit/on 总线：本期省事，但 dispatch 语义（waterfall 的 `next()`、serial 的顺序、parallel 的并发）在接入时要补，而那正是最容易出错的语义。

完全中性自定义词汇、未来在 adapter 层做映射：本期自由度最大，代价是一层长期的翻译成本，以及契约与真实运行时之间的语义漂移无人负责。

把 `capability-broker` 当作 seam 的同义词使用：会让「能力如何被替换」与「能力如何被受控调用」这两件事混成一个词。

## 影响与验证

`@elysian/contracts` 必须零运行时依赖（不依赖 React、DOM、Cordis），用断言测试守住，这样它能被未来的服务端复用。

adapter 契约测试写成可复用的断言集合：本期对 mock 实现运行，未来新增真实 adapter 时对同一套断言再跑一次。这是「mock 可替换」这个说法的唯一实证方式，而不是靠口头承诺。

本期不实现的部分要写清楚，避免契约承诺了运行时不提供的语义：不实现 fiber 生命周期、不做插件装载、不做 HMR。
