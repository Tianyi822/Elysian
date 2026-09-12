# 起点文件

本目录保存本项目的起点文件 `project-prompt.md`：Elysian Web 项目初始化提示词，原文照录，未做任何修改，用于保留项目最初的意图与约束来源。

**它是历史材料，不是当前共识。** 与共识文档冲突时，一律以 `CONTEXT.md`（术语与领域）、`AGENTS.md`（工程约定与边界）、`docs/adr/`（决策与理由）为准。

已知需要以共识文档覆盖的冲突与澄清有三处，均已在共识文档中定死：

1. 契约层落点：起点文件同时把 `packages/foundation/contracts` 说成共享协议层、又把 `contracts` 列为 Web 应用内部目录。共识取双层落点（见 `docs/adr/0002-contract-layer-and-cordis-seam-fidelity.md`）。
2. `capability-broker` 与 Cordis 生态的 `seam` 是两个不同的东西：前者是受控调用入口组件，后者是可替换能力的三角色模型。共识以 `seam` 为权威英文术语（见 `docs/adr/0002-contract-layer-and-cordis-seam-fidelity.md`）。
3. 严重等级与风险等级的取值起点文件未给，共识定为两套独立的四档枚举（见 `docs/adr/0004-ops-severity-risk-and-approval-enums.md`）。

维护规则：本目录内容不再改动。若起点文件的某条约束被最终推翻，在 `docs/adr/` 里记一条新决策，不要回来编辑原文。
