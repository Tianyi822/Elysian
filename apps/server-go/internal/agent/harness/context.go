package harness

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strconv"
	"strings"

	"elysian/server/internal/agent/harness/model"
	"elysian/server/internal/agent/harness/state"
)

type factGroup struct {
	cursor   MemoryCursor
	refs     []EvidenceRef
	messages []model.Message
}

func cursorAfter(a, b MemoryCursor) bool {
	if a.RunNumber != b.RunNumber {
		return a.RunNumber > b.RunNumber
	}
	x, _ := strconv.ParseInt(a.EventSeq, 10, 64)
	y, _ := strconv.ParseInt(b.EventSeq, 10, 64)
	return x > y
}

func refKey(r EvidenceRef) string { return r.RunID + ":" + r.EventSeq }

// contextFacts 在完整的工具提议/结果组边界读取；未完成旧调用显式标结果未知。
// 不复制工具结果到模型记录或记忆。数据库读取只在父进程发生。
// loadImages 为 false 时（记忆整理与工作流收尾）不读附件字节也不挂图：
// 这些请求本就剥离全部 Images，历史图片只需保留文字注记语义。
type contextFactsResult struct {
	memory WorkingMemory
	groups []factGroup
	shared []model.Message
}

func (a *agentExecution) contextFacts(ctx context.Context, loadImages bool) (WorkingMemory, []factGroup, []model.Message, error) {
	m := a.manager
	m.mu.Lock()
	defer m.mu.Unlock()
	result, err := storeRead(ctx, m.store, "context-facts", func(ctx context.Context) (contextFactsResult, error) {
		memory, groups, shared, err := a.contextFactsRead(ctx, loadImages)
		return contextFactsResult{memory, groups, shared}, err
	})
	if err != nil {
		// Preserve SQLite codes until the read scope has cleaned up and retried.
		err = m.contextStoreErrorLocked(err)
	}
	return result.memory, result.groups, result.shared, err
}

func (a *agentExecution) contextFactsRead(ctx context.Context, loadImages bool) (WorkingMemory, []factGroup, []model.Message, error) {
	m := a.manager
	if m.closed || m.storageError || ctx.Err() != nil {
		return WorkingMemory{}, nil, nil, context.Canceled
	}
	memory, err := readView(ctx, m.store).Memory(ctx, a.run.TaskID, 0)
	if err != nil {
		return memory, nil, nil, err
	}
	invalid, err := wikiArtifactInvalid(ctx, m.store, "memory", a.run.TaskID+":"+strconv.Itoa(memory.Revision))
	if err != nil {
		return memory, nil, nil, err
	}
	if invalid {
		memory = WorkingMemory{TaskID: memory.TaskID, Revision: memory.Revision, Objective: a.run.Task.Goal, Constraints: []string{}, Facts: []MemoryFact{}, Todos: []string{}, OpenQuestions: []string{}}
	}
	runs, err := readView(ctx, m.store).ContextRuns(ctx, a.run.TaskID, memory.Coverage.RunNumber, a.run.RunNumber)
	if err != nil {
		return memory, nil, nil, err
	}
	// 最新计划独立于记忆覆盖游标，压力整理后仍带入下一次推理；计划位于尾部当前状态消息。
	// 同时刷新本 Run 的用量：主动压缩要按剩余 token 预算判断有效容量，不能使用入队时的旧快照。
	for _, run := range runs {
		if run.ID == a.run.ID {
			a.run.Plan = run.Plan
			a.run.Usage = run.Usage
			a.run.Diagnosis = run.Diagnosis
			a.run.CompletionChecks = run.CompletionChecks
		}
	}
	var imagePlans map[string]runImagePlan
	if loadImages {
		imagePlans, err = a.planRunImages(ctx, runs)
		if err != nil {
			return memory, nil, nil, err
		}
	} else {
		a.currentImages = nil
	}
	imageSupport := a.run.Model != nil && a.run.Model.Capabilities.Image
	var groups []factGroup
	for _, run := range runs {
		if run.SupersededByRunID != "" {
			continue
		}
		invalid, e := wikiArtifactInvalid(ctx, m.store, "run", run.ID)
		if e != nil {
			return memory, nil, nil, e
		}
		if invalid {
			groups = append(groups, factGroup{cursor: MemoryCursor{RunNumber: run.RunNumber, EventSeq: run.LastSeq}, refs: []EvidenceRef{{RunID: run.ID, EventSeq: run.LastSeq}}, messages: []model.Message{otherContextMessage("user", "历史运行 "+run.ID+" 的知识来源已撤回，内容已隔离；执行凭据仍留存，不能据此重试外部动作。")}})
			continue
		}
		if run.RunNumber > a.run.RunNumber {
			continue
		}
		if a.run.WorkflowID != "" && (run.WorkflowID != a.run.WorkflowID || run.WorkflowStepID != a.run.WorkflowStepID) {
			continue // 跨步骤只接收固定完成凭据，不串入其他步骤的原始工具过程。
		}
		inputCursor := MemoryCursor{RunNumber: run.RunNumber, EventSeq: "1"}
		if cursorAfter(inputCursor, memory.Coverage) {
			ref := EvidenceRef{RunID: run.ID, EventSeq: "1"}
			prefix := "任务输入（来源 " + refKey(ref) + "）：\n"
			content := prefix + run.Input
			if run.ID == a.run.ID {
				prefix = "本轮用户输入（来源 " + refKey(ref) + "）：\n"
				content = prefix + run.Input
				if a.run.WorkflowID == "" {
					// chat 布局把本轮原文放在尾部当前状态消息；事实组只保留证据引用，避免同一输入在提示词中重复计费。
					content = prefix + "原文已列于本轮上下文（头部或尾部当前状态），此处只保留证据引用。"
				}
			} else if run.RunNumber == 1 && run.Input == a.run.Task.Goal {
				content = "原始目标已列于任务头部；来源 " + refKey(ref)
			}
			breakdown := model.ContextBreakdown{Messages: estimateContextText(run.Input), Other: estimateContextText(prefix)}
			if (run.ID == a.run.ID && a.run.WorkflowID == "") || run.ID != a.run.ID && run.RunNumber == 1 && run.Input == a.run.Task.Goal {
				breakdown = model.ContextBreakdown{Other: estimateContextText(content)}
			}
			beforeImages := len(content)
			var msgImages []model.ImagePart
			if run.Selection != nil && len(run.Selection.Attachments) > 0 {
				if !imageSupport {
					// 模型无图能力：历史图片整单降级为文字注记，不再让续发因历史图片失败。
					content += "\n（该轮附图 " + strconv.Itoa(len(run.Selection.Attachments)) + " 张，当前模型不支持图片输入，未重发）"
				} else if plan, ok := imagePlans[run.ID]; ok {
					msgImages = plan.images
					if plan.dropped > 0 {
						content += "\n（该轮附图 " + strconv.Itoa(plan.dropped) + " 张因容量未重发）"
					}
				}
			}
			breakdown.Other += estimateContextText(content[beforeImages:])
			groups = append(groups, factGroup{cursor: inputCursor, refs: []EvidenceRef{ref}, messages: []model.Message{{Role: "user", Content: content, Images: msgImages, EstimatedBreakdown: &breakdown}}})
		}

		coverage := int64(0)
		if state.ContinuousRun(a.run) && run.RunNumber == memory.Coverage.RunNumber {
			coverage, _ = state.NumberCursor(memory.Coverage.EventSeq)
		}
		records, err := readView(ctx, m.store).ContextModelRequests(ctx, run.ID, coverage)
		if err != nil {
			return memory, nil, nil, err
		}
		calls, err := readView(ctx, m.store).ContextCalls(ctx, run.ID, coverage)
		if err != nil {
			return memory, nil, nil, err
		}
		operations, err := readView(ctx, m.store).ContextOperations(ctx, run.ID, coverage)
		if err != nil {
			return memory, nil, nil, err
		}
		approvals, err := readView(ctx, m.store).SessionApprovals(ctx, run.ID)
		if err != nil {
			return memory, nil, nil, err
		}
		operationByCall := map[string]*Operation{}
		for i := range operations {
			o := &operations[i]
			operationByCall[o.ModelRequestID+":"+o.ModelCallID] = o
		}
		approvalByID := map[string]*Approval{}
		for i := range approvals {
			approvalByID[approvals[i].ID] = &approvals[i]
		}
		items, readErr := readView(ctx, m.store).ContextItems(ctx, run.ID)
		if readErr != nil {
			return memory, nil, nil, readErr
		}
		materialSources := map[string]string{}
		skillBodies := map[string]bool{}
		for _, item := range items {
			materialSources[item.CallID] = item.Source
			if item.Source == "skill-load" && item.Path == "SKILL.md" {
				skillBodies[item.CallID] = true
			}
		}
		events, err := readView(ctx, m.store).ContextEvents(ctx, run.ID, coverage)
		if err != nil {
			return memory, nil, nil, err
		}
		callSeq := map[string]string{}
		for _, event := range events {
			if event.CallID != "" {
				if state.ContinuousRun(a.run) && (callSeq[event.CallID] != "" || event.Type == "call/started" || event.Type == "operation/task-accepted" || strings.HasPrefix(event.Type, "recovery/")) {
					continue
				}
				callSeq[event.CallID] = event.Seq
			}
		}
		for _, record := range records {
			if record.Purpose != "inference" && record.Purpose != "input-material" || record.Status != StateSucceeded || record.Response == nil {
				continue
			}
			response := record.Response
			group := factGroup{cursor: MemoryCursor{RunNumber: run.RunNumber, EventSeq: record.EventSeq}, refs: []EvidenceRef{{RunID: run.ID, EventSeq: record.EventSeq}}}
			assistant := model.Message{Role: "assistant", Content: response.Content}
			// DeepSeek 工具续轮要求回传思考；Messages 映射为公开 thinking 块。
			// https://api-docs.deepseek.com/guides/thinking_mode
			if run.ID == a.run.ID && run.Model != nil && run.Model.Provider == model.ProviderDeepSeek && (run.Model.APIFormat == model.FormatChatCompletions || run.Model.APIFormat == model.FormatAnthropicMessages) && len(response.ToolCalls) > 0 {
				assistant.Reasoning = response.Reasoning
			}
			var results []model.Message
			for index, proposal := range response.ToolCalls {
				// 不沿用供应商私有 continuation 字段；调用 ID 按已保存记录重新命名。
				callID := record.ID + "_" + strconv.Itoa(index)
				assistant.ToolCalls = append(assistant.ToolCalls, model.ToolCall{ID: callID, Name: proposal.Name, Arguments: proposal.Arguments})
				var found *Call
				for i := range calls {
					if calls[i].ModelRequestID == record.ID && calls[i].ModelCallID == proposal.ID {
						found = &calls[i]
						break
					}
				}
				op := operationByCall[record.ID+":"+proposal.ID]
				var approval *Approval
				if op != nil {
					approval = approvalByID[op.ApprovalID]
				}
				fact := state.ProjectToolExecution(run, op, found, approval)
				content := state.ToolFactContent(fact, found)
				if state.ContinuousRun(a.run) && found != nil && found.ModelContent != "" {
					content = found.ModelContent
				}
				if found != nil && state.Terminal(found.Status) {
					if seq := callSeq[found.ID]; seq != "" {
						group.refs = append(group.refs, EvidenceRef{RunID: run.ID, EventSeq: seq})
						c := MemoryCursor{RunNumber: run.RunNumber, EventSeq: seq}
						if cursorAfter(c, group.cursor) {
							group.cursor = c
						}
					}
				} else if run.ID == a.run.ID {
					return memory, nil, nil, bad("invalid-agent-operation", "当前工具调用组尚未闭合")
				}
				if a.run.Snapshot != nil && a.run.Snapshot.ToolLoading == onDemandToolsV2 && found != nil && skillBodies[found.ID] {
					content = `{"status":"skill-instruction-recorded","note":"适用于本轮的完整正文由独立技能上下文提供"}`
				}
				if run.ID != a.run.ID && proposal.Name == toolSearchName && found != nil && found.Status == StateSucceeded && found.Error == nil {
					// 仅改变历史投影，原搜索回执及其快照摘要保持不变。
					b, _ := json.Marshal(map[string]any{"sourceRunId": run.ID, "historical": true, "note": "这是所属历史运行的搜索加载回执，loaded/retained 不代表本轮已加载；当前可调用工具以尾部状态和实际定义为准", "receipt": json.RawMessage(content)})
					content = string(b)
				}
				result := model.Message{Role: "tool", ToolCallID: callID, Content: content}
				if found != nil {
					switch materialSources[found.ID] {
					case "skill-load":
						result.EstimatedBreakdown = &model.ContextBreakdown{Skills: estimateContextText(content)}
					case "mcp-resource", "mcp-prompt":
						result.EstimatedBreakdown = &model.ContextBreakdown{Other: estimateContextText(content)}
					}
				}
				results = append(results, result)
			}
			if !cursorAfter(group.cursor, memory.Coverage) {
				continue
			}
			refsJSON, _ := json.Marshal(group.refs)
			note := "任务事实来源：" + string(refsJSON)
			if run.ID != a.run.ID && run.Status != StateSucceeded {
				note += "。所属运行未成功；下列内容只记录曾收到的模型输出与已确认工具结果，不是成功终答。"
			}
			group.messages = []model.Message{otherContextMessage("user", note), assistant}
			group.messages = append(group.messages, results...)
			groups = append(groups, group)
		}

		if state.ContinuousRun(a.run) {
			for _, event := range events {
				if event.Type != "recovery/recovered" {
					continue
				}
				cursor := MemoryCursor{RunNumber: run.RunNumber, EventSeq: event.Seq}
				if !cursorAfter(cursor, memory.Coverage) {
					continue
				}
				for _, call := range calls {
					if call.ID == event.CallID {
						fact := state.ProjectToolExecution(run, operationByCall[call.ModelRequestID+":"+call.ModelCallID], &call, nil)
						ref := EvidenceRef{RunID: run.ID, EventSeq: event.Seq}
						groups = append(groups, factGroup{cursor: cursor, refs: []EvidenceRef{ref}, messages: []model.Message{otherContextMessage("user", "追加核实证据（保留原工具消息）："+refKey(ref)+"\n"+state.ToolFactContent(fact, &call))}})
					}
				}
			}
		}
		for _, item := range items {
			cursor := MemoryCursor{RunNumber: run.RunNumber, EventSeq: item.EventSeq}
			if !cursorAfter(cursor, memory.Coverage) {
				continue
			}
			ref := EvidenceRef{RunID: run.ID, EventSeq: item.EventSeq}
			detail, _ := json.Marshal(map[string]any{"source": item.Source, "ref": item.Ref, "path": item.Path, "digest": item.Digest, "callId": item.CallID})
			groups = append(groups, factGroup{cursor: cursor, refs: []EvidenceRef{ref}, messages: []model.Message{otherContextMessage("user", "已加载资料来源："+string(detail))}})
		}
		if run.ID != a.run.ID && state.Terminal(run.Status) && run.Status != StateSucceeded {
			cursor := MemoryCursor{RunNumber: run.RunNumber, EventSeq: run.LastSeq}
			if cursorAfter(cursor, memory.Coverage) {
				ref := EvidenceRef{RunID: run.ID, EventSeq: run.LastSeq}
				detail, _ := json.Marshal(map[string]any{"status": run.Status, "endReason": run.EndReason, "error": run.Error})
				groups = append(groups, factGroup{cursor: cursor, refs: []EvidenceRef{ref}, messages: []model.Message{otherContextMessage("user", "历史运行终态（来源 "+refKey(ref)+"）："+string(detail))}})
			}
		}
	}
	if a.run.WorkflowID != "" {
		workflowGroups, err := m.workflowContextFacts(ctx, a.run)
		if err != nil {
			return memory, nil, nil, err
		}
		if a.workflowOutput != nil {
			workflowGroups = append(workflowGroups, a.workflowOutput.fact(a.run))
		}
		for i := range workflowGroups {
			for j := range workflowGroups[i].messages {
				message := &workflowGroups[i].messages[j]
				message.EstimatedBreakdown = &model.ContextBreakdown{Other: estimateContextText(message.Content)}
			}
		}
		// 完成凭据不按共享记忆覆盖游标压制：Task 记忆的 Coverage 会被兄弟分支的
		// 整理推进，但那些整理因作用域隔离吸收不了本作用域的步骤输出，压制等于
		// 静默丢失未整理完成资料。隔离与顺序边界只由 workflowContextFacts 决定；
		// 已吸收资料的重复注入由整理摘要与证据引用兜底，不能以丢失为代价去重。
		groups = append(groups, workflowGroups...)
	}
	sort.SliceStable(groups, func(i, j int) bool { return cursorAfter(groups[j].cursor, groups[i].cursor) })
	// 读取时固定接受输入时的 Session 边界，排除其他任务的工具/记忆。
	messages, err := readView(ctx, m.store).ContextMessages(ctx, a.run.SessionID, a.run.TaskID, a.run.HistorySeq)
	if err != nil {
		return memory, nil, nil, err
	}
	var shared []model.Message
	a.sharedWikiRefs = nil
	for i := len(messages) - 1; i >= 0; i-- {
		invalid, e := wikiArtifactInvalid(ctx, m.store, "message", messages[i].ID)
		if e != nil {
			return memory, nil, nil, e
		}
		if invalid {
			continue
		}
		if a.run.ScopeID != "" {
			continue
		} // 分支只继承父快照，不读取兄弟公开输出。
		refs, e := wikiArtifactRefs(ctx, m.store, "message", messages[i].ID)
		if e != nil {
			return memory, nil, nil, e
		}
		a.sharedWikiRefs = append(a.sharedWikiRefs, refs)
		prefix := "其他任务公开对话：\n"
		if messages[i].Origin == "runtime" {
			prefix = "其他任务运行时结果（运行状态说明）：\n"
		}
		if messages[i].RunStatus == StateCancelled {
			prefix += "（回复已停止，以下为未完成内容）\n"
		}
		shared = append(shared, model.Message{Role: messages[i].Role, Content: prefix + messages[i].Content,
			EstimatedBreakdown: &model.ContextBreakdown{Messages: estimateContextText(messages[i].Content), Other: estimateContextText(prefix)}})
	}
	return memory, groups, shared, nil
}

func (a *agentExecution) tools(ctx context.Context) ([]model.Tool, error) {
	if a.run.Snapshot != nil {
		if a.onDemandTools() {
			if a.run.Snapshot.ToolLoading == onDemandToolsV2 {
				state, err := a.manager.loadedToolsV2(ctx, a.run.ID, *a.run.Snapshot)
				if err != nil {
					return nil, err
				}
				loaded := make(map[string]bool, len(state.Retained))
				for _, name := range state.Retained {
					loaded[name] = true
				}
				return a.run.Snapshot.VisibleModelToolsInOrder(loaded, state.Order), nil
			}
			loaded, err := a.loadedToolNames(ctx)
			if err != nil {
				return nil, err
			}
			return a.run.Snapshot.VisibleModelTools(loaded), nil
		}
		return a.run.Snapshot.ModelTools(), nil
	}
	m := a.manager
	var out []model.Tool
	if m.deps.Tools != nil {
		for _, schema := range m.deps.Tools.Schemas() {
			if allowed(schema.Name) {
				b, _ := json.Marshal(schema.Parameters)
				out = append(out, model.Tool{Name: schema.Name, Description: schema.Description, Parameters: b})
			}
		}
	}
	return out, nil
}

func (a *agentExecution) buildContext(ctx context.Context) (model.Request, []EvidenceRef, int, error) {
	correction, err := a.pendingToolCorrection(ctx)
	if err != nil {
		return model.Request{}, nil, 0, err
	}
	a.toolCorrection = correction
	compacted := false
	var fallback *contextFallback
	for {
		memory, groups, shared, err := a.contextFacts(ctx, true)
		if err != nil {
			return model.Request{}, nil, 0, err
		}
		visibleTools, err := a.tools(ctx)
		if err != nil {
			return model.Request{}, nil, memory.Revision, err
		}
		taskMessages, refs := flattenGroups(groups)
		var base, status []model.Message
		if a.run.WorkflowID == "" {
			base, status = a.chatContext(memory, a.currentImages, visibleTools)
		} else {
			base = baseContext(a, memory, agentSystem, a.currentImages)
		}
		instructions, instructionRefs, itemIDs, err := a.loadedInstructions(ctx, refs)
		if err != nil {
			return model.Request{}, nil, memory.Revision, err
		}
		base = append(base, instructions...)
		a.manager.mu.Lock()
		wikiMessages, navigationRefs, wikiErr := a.wikiRecallLocked(ctx)
		a.manager.mu.Unlock()
		if wikiErr != nil {
			return model.Request{}, nil, memory.Revision, wikiErr
		}
		for i := range wikiMessages {
			wikiMessages[i].EstimatedBreakdown = &model.ContextBreakdown{Other: estimateContextText(wikiMessages[i].Content)}
		}
		refs = append(refs, instructionRefs...)
		a.contextItemIDs = itemIDs
		request := model.Request{Tools: visibleTools, ReasoningLevel: a.runReasoningLevel(), MaxTokens: a.outputLimit(a.runReasoningLevel())}
		if a.toolCorrection {
			request.ToolChoice = toolSearchName
			request.ReasoningLevel = "" // 未声明 disabled 的服务沿用固定函数请求的关闭默认值。
			if a.run.Model != nil && model.ValidateReasoningLevel(*a.run.Model, "disabled") == nil {
				request.ReasoningLevel = "disabled"
			}
			request.MaxTokens = min(request.MaxTokens, 4096)
		}

		// 装配阶段写入当前模型的字节→token 比例：fits 循环只做本地换算，不发官方计数请求。
		request.EstimateRatio = a.estimateRatio()
		sharedStart := 0
		rebuild := false
		// 尾部当前状态消息不参与裁剪：它承载本轮输入与最新计划，必须随每次请求保留。
		compose := func() []model.Message {
			messages := append(append(append(append([]model.Message{}, base...), wikiMessages...), shared...), taskMessages...)
			return append(messages, status...)
		}
		for {
			request.Messages = compose()
			if a.fits(request) {
				if !state.ContinuousRun(a.run) && fallback != nil && a.run.Usage.Tokens+estimateRequestTokens(request) > a.run.Limits.TokenBudget {
					return a.restoreContextFallback(fallback)
				}
				a.manager.mu.Lock()
				if a.run.WikiStrategy == wikiNavigationStrategy {
					a.inferenceWikiRefs = nil
					if len(wikiMessages) != 0 {
						a.inferenceWikiRefs = navigationRefs
					}
				} else {
					a.inferenceWikiRefs, err = a.wikiRecallSourcesLocked(ctx, len(wikiMessages))
				}
				a.manager.mu.Unlock()
				if err != nil {
					return model.Request{}, nil, memory.Revision, err
				}
				for _, sources := range a.sharedWikiRefs[sharedStart:] {
					a.inferenceWikiRefs = state.MergeWikiRefs(a.inferenceWikiRefs, sources)
				}
				request.EstimatedBreakdown = estimateFittedContext(request, a.run.Snapshot)
				fixed := request
				fixed.Messages = append(append(append([]model.Message{}, base...), wikiMessages...), shared...)
				fixed.Messages = append(fixed.Messages, status...)
				if !compacted && a.proactiveCompactionEligible() && a.proactiveCompactionUseful(request, fixed) && compactableFacts(groups) {
					prepared, compactErr := a.prepareConsolidation(ctx, false)
					if compactErr != nil && (ctx.Err() != nil || a.mustStop(compactErr)) {
						return model.Request{}, nil, memory.Revision, compactErr
					}
					if compactErr == nil && a.canProactivelyCompact(request, prepared.request) {
						saved := contextFallback{
							request: request, refs: append([]EvidenceRef(nil), refs...), revision: memory.Revision,
							wikiRefs: append([]WikiRef(nil), a.inferenceWikiRefs...), contextItemIDs: append([]string(nil), a.contextItemIDs...),
						}
						if request.EstimatedBreakdown != nil {
							breakdown := *request.EstimatedBreakdown
							saved.request.EstimatedBreakdown = &breakdown
						}
						updated, compactErr := a.consolidatePrepared(ctx, false, prepared)
						if compactErr != nil && (ctx.Err() != nil || a.mustStop(compactErr)) {
							return model.Request{}, nil, memory.Revision, compactErr
						}
						// 主动整理失败不推翻仍可容纳的本轮请求；下一轮达到阈值时会再次尝试。
						if compactErr == nil && updated != nil && cursorAfter(updated.Coverage, memory.Coverage) {
							fallback = &saved
							compacted = true
							rebuild = true
							break
						}
					}
				}
				return request, refs, memory.Revision, nil
			}
			if len(shared) > 0 {
				shared = shared[1:]
				sharedStart++
				continue
			}
			if len(wikiMessages) > 0 {
				wikiMessages = wikiMessages[:len(wikiMessages)-1]
				continue
			}
			break
		}
		if rebuild {
			continue
		}
		if fallback != nil {
			// 整理已成功，但新的工作记忆比被替换的事实更大，重建请求装不下；
			// 本轮回退到压缩前已验证可容纳的上下文，下一轮再使用新记忆。
			return a.restoreContextFallback(fallback)
		}
		if len(groups) == 0 {
			return request, nil, memory.Revision, capacityError()
		}
		updated, err := a.consolidate(ctx, false)
		if err != nil {
			return request, nil, memory.Revision, err
		}
		if updated == nil || !cursorAfter(updated.Coverage, memory.Coverage) {
			return request, nil, memory.Revision, capacityError()
		}
		compacted = true
	}
}

func (m *Manager) contextStoreErrorLocked(err error) error {
	if transientStorageRead(err) {
		return &Error{Status: 503, Code: "storage-read-transient", Message: "运行记录暂时无法读取，正在等待存储恢复"}
	}
	if _, ok := err.(*Error); !ok && !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
		m.storageFailedLocked()
	}
	return storageFailure(err)
}
