# 0003 前端技术栈基线

- 状态：已确认（2026-09-12 访谈第 1、2 轮）
- 相关：`AGENTS.md` 的「固定技术约束」与「视觉与可访问性红线」

## 背景

起点提示词固定了 Bun、TypeScript、React、Vite、Lucide，并给了一条有张力的约束：使用成熟 UI 组件库或轻量 CSS 方案，不自行引入庞大的设计系统。同时产品要求是高密度、可长时间扫描、表格列宽稳定、状态不能只靠颜色——这类界面用默认风格宽松的组件库会得到大量改造工作，用纯手写 CSS 又会拖慢一致性。

测试栈、状态管理、路由、主题四项提示词没有指定，需要一并定死，否则实现期会出现多人多栈。

## 决定

- 样式与组件：Tailwind CSS v4（`@tailwindcss/vite`）加 Radix 无样式原语（Dialog、Select、Tooltip、Tabs、DropdownMenu、Popover、Checkbox 等按需引入），表格、时间线、状态标签、筛选器、面板自建。
- 图标：Lucide，不手写常见图标 SVG。
- 状态：zustand，store 只依赖 adapter 接口，业务组件不直接持有 mock 数据。
- 路由：React Router v7，页面级子路由与事件详情用嵌套路由，筛选条件进 search params。
- 测试：Vitest + Testing Library + jsdom，测试与源码同目录。
- 主题：深色为默认，语义令牌在 Tailwind `@theme` 中定义，浅色主题同步定义并在系统设置页切换。

## 理由

Radix 提供无样式的可访问性原语，样式完全由 Tailwind 令牌控制，因此密度、列宽与对比度都能直接压到运维控制台需要的水平，同时不引入一套自带设计语言的系统——这正是「不引入庞大设计系统」的可执行解。

Vitest 与 Vite 共用同一套配置与转换管线，Testing Library 在 jsdom 上是最成熟的组合，`createMemoryRouter` 可以直接断言路由，满足验收标准里「覆盖路由」这一条；`bun run test` 只是调用 vitest，不违背「Bun 作为脚本运行器」。

zustand 与既有 Orbit 项目的用法一致，且它的极简模型不依赖框架运行时，未来把 mock adapter 换成 HTTP 或 SSE adapter 时 store 代码不受影响。

React Router v7 的嵌套路由天然匹配「侧边栏 + 页面级子路由」的结构，筛选条件进 URL 后可分享、可回退，也让筛选逻辑可测。

## 放弃的方案

Ant Design 5：表格与筛选开箱即用，交付最快，但体量大、观感偏传统管理后台，与「克制」的产品定位有张力，且会与自定义令牌层争夺样式权威。

Mantine 7：组件与 hooks 齐全、密度可调，但同样等于引入一整套设计系统。

shadcn/ui：起步最快、可访问性开箱即用，但默认间距与圆角偏宽松，改造成紧凑运维风的量不比自己写小，还会引入一批用不到的组件。

bun:test 加 happy-dom：零额外测试框架、启动最快，但 happy-dom 在少数组件行为上与 jsdom 存在差异，对一个要覆盖交互与状态的界面来说是不必要的风险。

React Context 加 useReducer：零依赖，但高密度多页面下 Provider 嵌套与重渲染控制成本更高，也不适合未来接流式事件。

## 影响与验证

工作量集中在 `apps/web/src/components` 的自建组件层，这是本决定的主要代价，需要在一开始就把表格与状态标签的密度规则固定下来，避免每个页面各写一套。

验证方式：`bun run test` 覆盖路由、事件筛选、审批状态变化与技能启停；视觉上以桌面与窄屏两个视口检查无重叠、无溢出、列宽不跳动。
