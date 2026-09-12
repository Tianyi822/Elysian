# 0004 运维域分级与审批枚举

- 状态：按推荐落地待复核（2026-09-12 访谈第 3 轮）
- 相关：`CONTEXT.md` 的「枚举与中文标签」，`AGENTS.md` 的「契约层规则」

## 背景

起点提示词要求严重等级有清晰、可访问的视觉差异，要求高风险动作必须显示明确的审批状态，并且「不能伪装成已经执行」。这些都需要一套写死的分级取值，但提示词没有给出取值。

Cordis 生态里没有可直接借用的运维分级：只有三档遥测严重度（`info | warn | error`）和一组近似风险梯的沙箱模式（`read-only | workspace-write | danger-full-access`），以及审批的决策结果（`allowed-once | rejected | cancelled | unavailable`）。也就是说，严重等级、风险等级与审批队列状态必须由 Elysian 自己定义，而审批的决策结果应当沿用生态既有取值。

还有一个容易被做错的点：事故的严重度与动作的风险度看起来相似，很容易被合并成一个枚举，但它们在运维语义里是两个维度。

## 决定

严重等级 `Severity` 取 `sev1` 至 `sev4`（中文标签：致命、严重、一般、提示），`sev1` 最高。风险等级 `RiskLevel` 取 `low`、`medium`、`high`、`critical`（低、中、高、致命）。两套枚举完全独立，各有自己的颜色令牌，不互相赋值。

审批分两层。队列生命周期 `ApprovalStatus` 取 `pending`、`approved`、`rejected`、`expired`，属于 Elysian 的运维域；决策结果 `ApprovalOutcome` 沿用 Cordis 的 `allowed-once`、`rejected`、`cancelled`、`unavailable`，其中 `unavailable` 必须按失败关闭处理。审批策略 `ApprovalPolicy` 沿用 `ask | never`。

事故状态 `IncidentStatus` 取 `open`、`analyzing`、`awaiting-approval`、`mitigating`、`resolved`、`closed`；运行状态 `RunStatus` 取 `queued`、`running`、`waiting-approval`、`succeeded`、`failed`、`cancelled`；审计类型 `AuditKind` 取 `event`、`decision`、`tool-call`、`approval`、`execution`。

## 理由

严重度与风险度必须分离，否则审批队列无法只按风险排序，事件列表也无法只按严重度排序；更实质的问题是「一条 sev1 事故」不等于「一个高风险动作」，合并枚举会让界面被迫用同一个筛选项回答两个不同的问题。

审批分两层是为了让 Elysian 的产品语义与 Cordis 的治理语义各归其位：队列状态回答「这条请求现在处于流程的哪一步」，决策结果回答「这次判断的结论是什么」。把两者压成一个枚举，未来接入真实审批回执时必然要对不上。

四档而不是三档，是因为高密度事故列表里「致命」与「严重」必须在扫视层面可区分；三档会让大量事故挤在同一档。`sev1`–`sev4` 的写法对齐 SRE 习惯，中文标签承担界面可读性。

## 放弃的方案

一套四档严重度、动作风险复用该值：概念最少，但如上所述会在审批队列与事件列表里产生语义冲突。

三档（高/中/低）：接近生态遥测的三档，界面最简单，但事故分级的区分度不足。

直接用 `P0`–`P3` 表示严重等级：`P` 系列通常表达处置优先级而非严重度，用它表示严重度会让两个本可分离的字段永久合并。

## 影响与验证

契约包导出枚举取值与中文标签表，界面文案从标签表取用，禁止组件内硬编码。测试断言枚举取值与标签的全覆盖，缺一个标签即失败。

风险等级为 `critical` 的动作必须进入审批队列且不能标为已执行；`unavailable` 的审批结果按失败关闭处理，这两条要有对应的测试，而不只是界面约定。

审批过期语义（`expired` 由谁产生、过期后是否允许重提）尚未决定，已登记在 `AGENTS.md` 的未决事项里。
