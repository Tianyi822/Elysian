package harness

import (
	"elysian/server/internal/agent/harness/model"
	"elysian/server/internal/agent/harness/state"
)

// outputLimit 取思考模式对应的官方默认输出上限（非思考 8K、思考 64K、max 档 128K）；
// 智谱 GLM 关不掉思考，显式关思考的档位也按思考上限取值；运行限额与模型声明的最大输出只能在其上收紧。
func (a *agentExecution) outputLimit(level string) int {
	limit := outputTokensNonThinking
	switch model.ReasoningEffort(level) {
	case "none":
		if a.run.Model != nil && a.run.Model.Provider == model.ProviderZhipu {
			limit = outputTokensThinking
		}
	case "max":
		limit = outputTokensMaxEffort
	default:
		if a.thinkingModel() {
			limit = outputTokensThinking
		}
	}
	if a.run.Limits.OutputTokens > 0 && a.run.Limits.OutputTokens < limit {
		limit = a.run.Limits.OutputTokens
	}
	if a.run.Model != nil && a.run.Model.OutputTokens < limit {
		limit = a.run.Model.OutputTokens
	}
	return limit
}

// thinkingModel 判定生成请求是否按思考模式发送：DeepSeek 与智谱 GLM 的生成接口始终启用思考
// （智谱 GLM 无法关闭），其他供应商以模型是否声明思考档位为准；判定为否时按非思考模式的官方默认取值。
func (a *agentExecution) thinkingModel() bool {
	return a.run.Model != nil && (a.run.Model.Provider == model.ProviderDeepSeek || a.run.Model.Provider == model.ProviderZhipu || len(a.run.Model.Capabilities.ReasoningLevels) > 0)
}

// runReasoningLevel 返回本轮固定的思考等级；未选择时为空，按模型默认档处理。
func (a *agentExecution) runReasoningLevel() string {
	if a.run.Selection == nil {
		return ""
	}
	return a.run.Selection.ReasoningLevel
}

func (a *agentExecution) fits(request model.Request) bool {
	return a.run.Model != nil && estimateRequestTokens(request)+request.MaxTokens <= a.run.Model.ContextTokens
}

// autoCompactPercent 是主动上下文压缩的触发比例。有效容量取模型声明容量与剩余 Run token 预算
// 的较小者：1M 上下文模型受默认 196608 token 预算约束，只看模型容量会让主动压缩永远无法触发；
// 小模型则由自身 ContextTokens 先触发。触发发生在请求仍可容纳时，保留余量给整理请求与整理后的推理。
const autoCompactPercent = 80

// effectiveContextTokens 返回本轮还能承载的 token 估算上限。容量准入、压缩阈值与 Run 预算
// 在装配阶段已统一为 token 单位；模型容量大于剩余预算时，Run 预算才是实际约束。
func (a *agentExecution) effectiveContextTokens() int {
	if a.run.Model == nil || a.run.Model.ContextTokens <= 0 {
		return 0
	}
	capacity := a.run.Model.ContextTokens
	if remaining := a.run.Limits.TokenBudget - a.run.Usage.Tokens; !state.ContinuousRun(a.run) && remaining < capacity {
		capacity = remaining
	}
	if capacity < 1 {
		return 0
	}
	return capacity
}

func (a *agentExecution) contextPressure(request model.Request) bool {
	capacity := a.effectiveContextTokens()
	if capacity == 0 {
		return false
	}
	// Run 预算成为约束时，准入只按提示词估算记账，不预留 MaxTokens；此时把输出上限算进
	// 压力会把「输出上限大于剩余预算」的普通多轮请求误判成满容量。模型容量成为约束时，
	// 输出仍占用模型上下文，按 estimate+MaxTokens 判断。
	if state.ContinuousRun(a.run) {
		return int64(estimateRequestTokens(request))*100 >= int64(max(1, capacity-request.MaxTokens))*autoCompactPercent
	}
	if remaining := a.run.Limits.TokenBudget - a.run.Usage.Tokens; remaining < a.run.Model.ContextTokens {
		return int64(estimateRequestTokens(request))*100 >= int64(capacity)*autoCompactPercent
	}
	return int64(estimateRequestTokens(request)+request.MaxTokens)*100 >= int64(capacity)*autoCompactPercent
}

// proactiveCompactionUseful 只在整理能够降低阈值压力时返回 true。固定的系统提示、工具目录、
// 技能和共享资料不会被工作记忆整理移除；如果它们单独已经达到阈值，后续每一轮都会重复
// 消耗 checkpoint 请求，却不会改善可用上下文。
func (a *agentExecution) proactiveCompactionUseful(request, fixed model.Request) bool {
	return a.contextPressure(request) && !a.contextPressure(fixed)
}

// proactiveCompactionEligible 限定主动压缩只用于普通聊天 v2 Run。工作流实例有独立的步骤与实例
// 预算，旧 v1 保持原行为；二者都不因这次优化多出模型请求。
func (a *agentExecution) proactiveCompactionEligible() bool {
	return a.DriverVersion() == 2 && a.run.WorkflowID == ""
}

// canProactivelyCompact 按实际整理请求预检，并为整理响应与完整原请求留出预算。
// 不依赖模型一定能缩小记忆：失败或重建变大时仍能继续原请求。
func (a *agentExecution) canProactivelyCompact(request, checkpoint model.Request) bool {
	if modelLimitReached(a.run, 2, a.modelRequestReserve("checkpoint")) {
		return false
	}
	// 有供应商用量时预留输出上限；缺失时按完整记忆字节与响应封装开销预留。
	outputReserve := max(checkpoint.MaxTokens, a.run.Limits.MemoryBytes+1024)
	return state.ContinuousRun(a.run) || a.run.Usage.Tokens+estimateRequestTokens(checkpoint)+outputReserve+estimateRequestTokens(request) <= a.run.Limits.TokenBudget
}

// compactableFacts 判定待整理事实是否包含模型答复或工具结果。只有本轮用户输入时不做主动整理：
// 输入由尾部当前状态消息完整保留，压缩既腾不出空间，又会多消耗一次模型请求。
func compactableFacts(groups []factGroup) bool {
	for _, group := range groups {
		for _, message := range group.messages {
			if message.Role == "assistant" || message.Role == "tool" {
				return true
			}
		}
	}
	return false
}

func capacityError() error {
	return bad("context-capacity", "当前模型上下文容量不足以容纳原始目标、工作记忆与未整理事实，请切换到容量更大的模型")
}

type contextFallback struct {
	request        model.Request
	refs           []EvidenceRef
	revision       int
	wikiRefs       []WikiRef
	contextItemIDs []string
}

func (a *agentExecution) restoreContextFallback(fallback *contextFallback) (model.Request, []EvidenceRef, int, error) {
	a.inferenceWikiRefs = fallback.wikiRefs
	a.contextItemIDs = fallback.contextItemIDs
	return fallback.request, fallback.refs, fallback.revision, nil
}
