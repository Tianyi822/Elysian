# 0005 实时刷新用 mock SSE 固定传输形状

- 状态：已确认（2026-09-12 用户决定：先用极简 SSE mock 把 transport 形状固定下来，尽可能真实）
- 相关：`AGENTS.md` 的「实时刷新与事件流」与「Mock 与数据层约定」，`CONTEXT.md` 的「事件流」「事件源」「类型化事件」

## 背景

起点提示词只要求「Agent run 时间线的模拟刷新」，没有规定刷新怎么发生。可选路径差别很大：在 store 里放个定时器改状态最省事，但它把刷新实现成界面自己的行为，传输形状被推迟到接入期才定义，而重连、乱序、断线续传这些真实世界里必然遇到的问题，演示期一个都不会暴露。

用户决定先用极简的 SSE mock 把 transport 形状固定下来，并尽可能真实。

## 决定

刷新走服务端到客户端的单向事件流，用 SSE 承载，形状与未来真实网关一致。

- 端点：`GET /api/events`，响应 `Content-Type: text/event-stream`。本期由 dev 与 preview 的 mock 端点提供，未来由真实 gateway 提供同一路径。
- 帧格式：严格按 SSE 写。`event:` 命名事件类型，`data:` 单行 JSON，`id:` 单调递增事件 id，`retry:` 重连间隔，空行分隔帧，心跳用注释帧 `: keep-alive`。
- 事件名沿用契约里的事件名（`agent/status`、`agent/pre-step`、`tools/post-execute`、`approval/request`、`approval/decided`、`skills/change`）。Elysian 新增的运维域事件（`incident/created`、`incident/updated`）先登记进 `CONTEXT.md` 再使用。
- 断线续传：客户端用浏览器原生 `EventSource`，重连时自动回送 `Last-Event-ID`；mock 端点据此从该 id 之后重放，不重发已投递事件。
- 只做下行：SSE 只传「已发生的事实」，也就是 emit 型事件。waterfall、serial、parallel 这些需要应答的语义属于 harness 内部，要双向通道，本期不做——真实 Cordis gateway 用 WebSocket 承载那部分。
- 降级：事件源连不上时 adapter 回落到同契约的内存事件源，界面在固定位置标注已降级，因此测试与静态演示不依赖服务端。

## 理由

传输层的真实性只有在存在真实传输时才成立。定时器方案下刷新是一次本地状态变更；SSE 方案下刷新是一条带 id、可重放、可能断线的事件。形状不同，下游就不同：契约里事件信封长什么样、adapter 的接口是「订阅加退订」还是「读一次快照」、测试要断言什么，都由这个决定推出来。

`EventSource` 是浏览器原生能力，不需要引入依赖，也不需要 WebSocket 那样自己管握手、心跳与重连，符合「极简」。

断线续传与心跳是本方案里最容易被省掉、也最容易被证明必需的两项：省掉它们，演示期看不出任何问题，接入真实流时会一次性暴露乱序与丢事件。

## 放弃的方案

store 内定时器模拟刷新：最省事，但把传输形状推迟到接入期，等于把风险留到最难改的时候。

WebSocket mock：能承载双向语义，也离真实 Cordis gateway 更近（它的事件流走 `/api/remote.mux`），但本期要自己实现握手、心跳、重连与帧协议，与「极简」冲突。等真正需要上行应答时再引入。

## 影响与验证

这是本阶段唯一的网络请求，指向同源 mock 端点，不涉及任何真实基础设施。它把起点约束里的「全部数据来自浏览器内存」放松为「同源 mock 端点加内存降级」，理由是传输真实性优先。这一处放松必须写在 `README.md` 与 `AGENTS.md` 里，否则会被当成不可解释的网络请求。

mock 端点不做鉴权、不做多客户端、不做背压、不做事件持久化，重放只覆盖进程内最近的事件。

验证方式：帧解析器有契约测试，覆盖多行 `data`、注释帧、`retry`、`Last-Event-ID` 重放与乱序到达；adapter 契约测试对 SSE 实现与内存降级实现运行同一套断言。
