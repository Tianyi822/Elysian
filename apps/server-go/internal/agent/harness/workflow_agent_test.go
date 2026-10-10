package harness

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"elysian/server/internal/agent/harness/model"
)

const workflowAgentTestSchema = `{"type":"object","additionalProperties":false,"required":["ok","count"],"properties":{"ok":{"type":"boolean"},"count":{"type":"integer","minimum":9007199254740993}}}`
const workflowAgentTestOutput = `{"count":9007199254740993,"ok":true}`

func workflowFinishReply(output string) model.Response {
	return model.Response{FinishReason: "tool_calls", ToolCalls: []model.ToolCall{{ID: "finish", Name: "workflow_finish", Arguments: json.RawMessage(output)}}}
}

func startWorkflowAgentTest(t *testing.T, m *Manager, session Session, steps []WorkflowStepDefinition) WorkflowInstance {
	t.Helper()
	input := "{}"
	if steps == nil {
		steps = []WorkflowStepDefinition{{ID: "inspect", Kind: "agent", Instruction: "核对输入并给出结果", Input: WorkflowBinding{LiteralJSON: &input}, OutputSchemaJSON: workflowAgentTestSchema, Finish: &WorkflowBinding{Step: &WorkflowOutputBinding{StepID: "inspect", Pointer: ""}}}}
	}
	definition, err := m.PutWorkflowDefinition(context.Background(), "", 0, WorkflowDefinition{Name: "结构化结果验收", Enabled: true, Goal: "按固定步骤分析状态", InputSchemaJSON: `{"type":"object"}`, OutputSchemaJSON: steps[len(steps)-1].OutputSchemaJSON, Entry: steps[0].ID, Steps: steps})
	if err != nil {
		t.Fatal(err)
	}
	w, duplicate, err := m.CreateWorkflow(context.Background(), CreateWorkflowInput{RequestID: "workflow-agent-test", DefinitionID: definition.ID, DefinitionRevision: definition.Revision, SourceSessionID: session.ID, InputJSON: input})
	if err != nil || duplicate {
		t.Fatalf("提交失败 duplicate=%v err=%v", duplicate, err)
	}
	return w
}

func workflowAgentSettled(t *testing.T, m *Manager, id string) WorkflowInstance {
	t.Helper()
	var result WorkflowInstance
	runtimeEventually(t, func() bool {
		var err error
		result, err = m.GetWorkflow(context.Background(), id)
		return err == nil && (result.Status == StateSucceeded || result.Status == StateRecoveryRequired || result.Status == StateFailed || result.Status == StateCancelled)
	})
	return result
}

func workflowAgentRuns(t *testing.T, m *Manager, id string) []Run {
	t.Helper()
	m.mu.Lock()
	defer m.mu.Unlock()
	runs, err := readDocuments[Run](context.Background(), m.store.db, "SELECT document FROM runs WHERE workflow_id=? ORDER BY run_number", id)
	if err != nil {
		t.Fatal(err)
	}
	return runs
}

func TestWorkflowAgentFinishPublishesWithMemoryAndRun(t *testing.T) {
	enteredMemory := make(chan struct{})
	releaseMemory := make(chan struct{})
	var calls atomic.Int32
	m, session, _ := agentManager(t, func(ctx context.Context, _ model.Profile, request model.Request) (model.Response, error) {
		calls.Add(1)
		var response model.Response
		switch request.ToolChoice {
		case "workflow_finish":
			if len(request.Tools) != 1 || request.Tools[0].Name != "workflow_finish" || string(request.Tools[0].Parameters) != workflowAgentTestSchema {
				t.Error("结构化收尾混入执行工具或改变输出契约")
			}
			joined, _ := json.Marshal(request.Messages)
			if !strings.Contains(string(joined), "状态已核对") {
				t.Error("结构化收尾没有包含本轮完整公开答复")
			}
			response = workflowFinishReply(workflowAgentTestOutput)
		case "store_working_memory":
			found := false
			for _, message := range request.Messages {
				if strings.Contains(message.Content, workflowAgentTestOutput) {
					found = true
				}
				for _, call := range message.ToolCalls {
					if call.Name == "workflow_finish" {
						t.Error("收尾控制函数被当作未闭合业务调用")
					}
				}
			}
			if !found {
				t.Error("工作记忆遗漏已验证的精确结构化结果")
			}
			close(enteredMemory)
			select {
			case <-releaseMemory:
			case <-ctx.Done():
				return model.Response{}, ctx.Err()
			}
			response = memoryReply(request)
		default:
			for _, tool := range request.Tools {
				if tool.Name == "workflow_finish" {
					t.Error("主循环获得了父端收尾函数")
				}
			}
			response = finalReply("状态已核对")
		}
		tokens := 10
		response.Usage.TotalTokens = &tokens
		return response, nil
	}, func(d *Deps) { d.AgentLimits.MaxModelRequests = 3 })
	w := startWorkflowAgentTest(t, m, session, nil)
	select {
	case <-enteredMemory:
	case <-time.After(5 * time.Second):
		t.Fatal("没有进入工作流记忆整理")
	}
	runs := workflowAgentRuns(t, m, w.ID)
	if len(runs) != 1 || runs[0].Status != StateRunning || runs[0].WorkflowOutputJSON != "" || runs[0].WorkflowOutputRequestID != "" {
		t.Fatalf("记忆完成前发布了最终结果：%+v", runs)
	}
	close(releaseMemory)
	w = workflowAgentSettled(t, m, w.ID)
	runs = workflowAgentRuns(t, m, w.ID)
	if w.Status != StateSucceeded || w.OutputJSON != workflowAgentTestOutput || len(runs) != 1 || runs[0].Status != StateSucceeded || runs[0].WorkflowOutputJSON != "" || runs[0].WorkflowOutputRequestID == "" || runs[0].MemoryStatus != "updated" {
		t.Fatalf("结构化结果没有与成功终态一同提交：%+v %+v", w, runs)
	}
	if calls.Load() != 3 || runs[0].Usage.ModelRequests != 3 || w.Usage.ModelRequests != 3 || w.Usage.Tokens != 30 || runs[0].Usage.Calls != 0 {
		t.Fatalf("收尾未共用请求预算或占用工具次数：%+v %+v calls=%d", w.Usage, runs[0].Usage, calls.Load())
	}
}

func TestWorkflowAgentInvalidOutputCannotPublishOrConsolidate(t *testing.T) {
	tests := map[string]model.Response{
		"schema":        workflowFinishReply(`{"ok":"yes","count":9007199254740993}`),
		"prose":         finalReply("看起来通过了"),
		"duplicate-key": workflowFinishReply(`{"ok":true,"ok":false,"count":9007199254740993}`),
		"mixed-tools":   {FinishReason: "tool_calls", ToolCalls: []model.ToolCall{{ID: "finish", Name: "workflow_finish", Arguments: json.RawMessage(workflowAgentTestOutput)}, {ID: "read", Name: "docker_containers_list", Arguments: json.RawMessage(`{}`)}}},
	}
	for name, response := range tests {
		t.Run(name, func(t *testing.T) {
			var requests atomic.Int32
			m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, request model.Request) (model.Response, error) {
				requests.Add(1)
				if request.ToolChoice == "workflow_finish" {
					return response, nil
				}
				if request.ToolChoice == "store_working_memory" {
					t.Error("无效工作流结果进入记忆整理")
				}
				return finalReply("仅为候选答复"), nil
			}, nil)
			w := startWorkflowAgentTest(t, m, session, nil)
			w = workflowAgentSettled(t, m, w.ID)
			runs := workflowAgentRuns(t, m, w.ID)
			if w.Status != StateRecoveryRequired || w.OutputJSON != "" || len(runs) != 1 || runs[0].Status != StateFailed || runs[0].WorkflowOutputJSON != "" || runs[0].WorkflowOutputRequestID != "" || requests.Load() != 2 || runs[0].Usage.Calls != 0 {
				t.Fatalf("无效结果变成成功或触发执行：%+v %+v requests=%d", w, runs, requests.Load())
			}
		})
	}
}

func TestWorkflowAgentMemoryFailureStillCommitsValidatedOutput(t *testing.T) {
	m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, request model.Request) (model.Response, error) {
		switch request.ToolChoice {
		case "workflow_finish":
			return workflowFinishReply(workflowAgentTestOutput), nil
		case "store_working_memory":
			return model.Response{}, errors.New("模拟记忆服务失败")
		default:
			return finalReply("状态已核对"), nil
		}
	}, nil)
	w := startWorkflowAgentTest(t, m, session, nil)
	w = workflowAgentSettled(t, m, w.ID)
	runs := workflowAgentRuns(t, m, w.ID)
	if w.Status != StateSucceeded || w.OutputJSON != workflowAgentTestOutput || len(runs) != 1 || runs[0].MemoryStatus != "stale" || runs[0].Warning == nil {
		t.Fatalf("可恢复记忆失败丢弃了合法结果：%+v %+v", w, runs)
	}
	if runs[0].Usage.ActualTokens != nil || runs[0].Usage.CachedTokens != nil || w.Usage.Tokens <= 0 {
		t.Fatal("未知实际用量被伪造为已知或免除实例预算扣账")
	}
}

func TestWorkflowAgentCancelAfterOutputDoesNotPublishCandidate(t *testing.T) {
	entered := make(chan struct{})
	m, session, _ := agentManager(t, func(ctx context.Context, _ model.Profile, request model.Request) (model.Response, error) {
		switch request.ToolChoice {
		case "workflow_finish":
			return workflowFinishReply(workflowAgentTestOutput), nil
		case "store_working_memory":
			close(entered)
			<-ctx.Done()
			return model.Response{}, ctx.Err()
		default:
			return finalReply("仅为候选答复"), nil
		}
	}, nil)
	w := startWorkflowAgentTest(t, m, session, nil)
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("没有进入候选结果之后的记忆整理")
	}
	runs := workflowAgentRuns(t, m, w.ID)
	if _, err := m.Cancel(context.Background(), runs[0].ID); err != nil {
		t.Fatal(err)
	}
	got := runtimeFinished(t, m, runs[0].ID)
	if got.Status != StateCancelled || got.WorkflowOutputJSON != "" || got.WorkflowOutputRequestID != "" {
		t.Fatalf("取消后发布了候选输出：%+v", got)
	}
	memory, err := m.Memory(context.Background(), got.TaskID, 0)
	if err != nil || memory.Revision != 0 {
		t.Fatalf("取消后更新了记忆：%+v %v", memory, err)
	}
}

func TestWorkflowAgentInstanceBudgetRejectsWithoutBlockingOtherAgents(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	var requests atomic.Int32
	m, session, _ := agentManager(t, func(ctx context.Context, _ model.Profile, request model.Request) (model.Response, error) {
		requests.Add(1)
		close(entered)
		select {
		case <-release:
			return finalReply("请求预算即将耗尽"), nil
		case <-ctx.Done():
			return model.Response{}, ctx.Err()
		}
	}, nil)
	w := startWorkflowAgentTest(t, m, session, nil)
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("模型请求没有开始")
	}
	m.mu.Lock()
	err := m.store.write(context.Background(), "test-workflow-budget", func(tx *sql.Tx) error {
		current, err := readWorkflow(context.Background(), tx, w.ID)
		if err != nil {
			return err
		}
		current.Limits.ModelRequests = 1
		return saveWorkflow(context.Background(), tx, &current)
	})
	m.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	close(release)
	w = workflowAgentSettled(t, m, w.ID)
	runs := workflowAgentRuns(t, m, w.ID)
	if w.Status != StateFailed || len(runs) != 1 || runs[0].EndReason != "workflow-budget" || requests.Load() != 1 || w.Usage.ModelRequests != 1 {
		t.Fatalf("实例预算未拒绝收尾请求：%+v %+v requests=%d", w, runs, requests.Load())
	}
	if !m.Info().Agent.Available {
		t.Fatal("正常预算耗尽被误判为全局存储失效")
	}
}

func TestWorkflowAgentCrossStepContextUsesCompletionEvidence(t *testing.T) {
	const schema = `{"type":"object","additionalProperties":false,"required":["source"],"properties":{"source":{"type":"string"}}}`
	const firstOutput = `{"source":"first-completed"}`
	const secondOutput = `{"source":"second-completed"}`
	input := "{}"
	steps := []WorkflowStepDefinition{
		{ID: "first", Kind: "agent", Instruction: "读取第一份状态", Input: WorkflowBinding{LiteralJSON: &input}, OutputSchemaJSON: schema, Next: "second"},
		{ID: "second", Kind: "agent", Instruction: "只根据上一步完成凭据继续", Input: WorkflowBinding{Step: &WorkflowOutputBinding{StepID: "first", Pointer: ""}}, OutputSchemaJSON: schema, Finish: &WorkflowBinding{Step: &WorkflowOutputBinding{StepID: "second", Pointer: ""}}},
	}
	var secondInference atomic.Bool
	m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, request model.Request) (model.Response, error) {
		second := false
		for _, message := range request.Messages {
			second = second || strings.Contains(message.Content, "当前工作流步骤：second")
		}
		switch request.ToolChoice {
		case "workflow_finish":
			if second {
				return workflowFinishReply(secondOutput), nil
			}
			return workflowFinishReply(firstOutput), nil
		case "store_working_memory":
			if !second {
				return model.Response{}, errors.New("保留第一步未整理事实以验证隔离")
			}
			return memoryReply(request), nil
		default:
			if !second {
				return finalReply("前一步原始过程不应跨步骤混入"), nil
			}
			found := false
			for _, message := range request.Messages {
				if strings.Contains(message.Content, "前一步原始过程不应跨步骤混入") {
					t.Error("跨步骤上下文包含旧步骤的原始模型过程")
				}
				if strings.Contains(message.Content, "流程步骤 first 完成资料") && strings.Contains(message.Content, firstOutput) && strings.Contains(message.Content, "来源 ") {
					found = true
				}
			}
			if !found {
				t.Error("跨步骤上下文遗漏带证据的完成输出")
			}
			secondInference.Store(true)
			return finalReply("第二步完成"), nil
		}
	}, nil)
	w := startWorkflowAgentTest(t, m, session, steps)
	w = workflowAgentSettled(t, m, w.ID)
	if w.Status != StateSucceeded || w.OutputJSON != secondOutput || !secondInference.Load() {
		t.Fatalf("后续 Agent 未消费前序完成凭据：%+v", w)
	}
}

func TestWorkflowAgentFinalMemoryBudgetFailureCannotSucceedStale(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	var requests atomic.Int32
	m, session, _ := agentManager(t, func(ctx context.Context, _ model.Profile, request model.Request) (model.Response, error) {
		requests.Add(1)
		if request.ToolChoice == "workflow_finish" {
			return workflowFinishReply(workflowAgentTestOutput), nil
		}
		if request.ToolChoice == "store_working_memory" {
			t.Error("实例额度不足仍发起记忆请求")
			return memoryReply(request), nil
		}
		close(entered)
		select {
		case <-release:
			return finalReply("状态已核对"), nil
		case <-ctx.Done():
			return model.Response{}, ctx.Err()
		}
	}, nil)
	w := startWorkflowAgentTest(t, m, session, nil)
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("模型请求没有开始")
	}
	m.mu.Lock()
	err := m.store.write(context.Background(), "test-workflow-memory-budget", func(tx *sql.Tx) error {
		current, err := readWorkflow(context.Background(), tx, w.ID)
		if err != nil {
			return err
		}
		current.Limits.ModelRequests = 2
		return saveWorkflow(context.Background(), tx, &current)
	})
	m.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	close(release)
	w = workflowAgentSettled(t, m, w.ID)
	runs := workflowAgentRuns(t, m, w.ID)
	if w.Status != StateFailed || w.OutputJSON != "" || len(runs) != 1 || runs[0].Status != StateFailed || runs[0].EndReason != "workflow-budget" || runs[0].WorkflowOutputRequestID != "" || requests.Load() != 2 {
		t.Fatalf("实例预算耗尽被当作普通记忆 stale 成功：%+v %+v requests=%d", w, runs, requests.Load())
	}
	if !m.Info().Agent.Available {
		t.Fatal("实例预算耗尽阻断了其他 Agent")
	}
}

func TestWorkflowAgentActualUsageOverflowPersistsBeforeFailure(t *testing.T) {
	for _, phase := range []string{"workflow-output", "final-memory"} {
		t.Run(phase, func(t *testing.T) {
			var requests atomic.Int32
			m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, request model.Request) (model.Response, error) {
				requests.Add(1)
				tokens := 10
				var response model.Response
				switch request.ToolChoice {
				case "workflow_finish":
					response = workflowFinishReply(workflowAgentTestOutput)
					if phase == "workflow-output" {
						tokens = 300000
					}
				case "store_working_memory":
					response = memoryReply(request)
					if phase == "final-memory" {
						tokens = 300000
					}
				default:
					response = finalReply("状态已核对")
				}
				response.Usage.TotalTokens = &tokens
				return response, nil
			}, nil)
			w := startWorkflowAgentTest(t, m, session, nil)
			w = workflowAgentSettled(t, m, w.ID)
			runs := workflowAgentRuns(t, m, w.ID)
			expectedCalls := 2
			if phase == "final-memory" {
				expectedCalls = 3
			}
			expectedTokens := 300000 + 10*(expectedCalls-1)
			if w.Status != StateFailed || w.OutputJSON != "" || w.Usage.Tokens != expectedTokens || len(runs) != 1 || runs[0].EndReason != "workflow-budget" || runs[0].WorkflowOutputRequestID != "" || requests.Load() != int32(expectedCalls) {
				t.Fatalf("实际超额未终止或已发生用量丢失：%+v %+v requests=%d", w, runs, requests.Load())
			}
			if runs[0].Usage.ActualTokens == nil || *runs[0].Usage.ActualTokens != expectedTokens {
				t.Fatal("已确认的实际 token 未保存")
			}
			m.mu.Lock()
			records, err := readDocuments[ModelRequestRecord](context.Background(), m.store.db, "SELECT document FROM model_requests WHERE run_id=? ORDER BY request_index", runs[0].ID)
			m.mu.Unlock()
			if err != nil || len(records) != expectedCalls || records[len(records)-1].Purpose != phase || records[len(records)-1].Response == nil {
				t.Fatalf("超额响应被回滚或丢弃：%+v %v", records, err)
			}
		})
	}
}

func TestWorkflowAgentRunBudgetFailureCannotSucceedStale(t *testing.T) {
	m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, request model.Request) (model.Response, error) {
		tokens := 10
		var response model.Response
		switch request.ToolChoice {
		case "workflow_finish":
			response = workflowFinishReply(workflowAgentTestOutput)
		case "store_working_memory":
			response = memoryReply(request)
			tokens = 130000
		default:
			response = finalReply("状态已核对")
		}
		response.Usage.TotalTokens = &tokens
		return response, nil
	}, nil)
	w := startWorkflowAgentTest(t, m, session, nil)
	w = workflowAgentSettled(t, m, w.ID)
	runs := workflowAgentRuns(t, m, w.ID)
	if w.Status != StateRecoveryRequired || w.OutputJSON != "" || w.Usage.Tokens != 130020 || len(runs) != 1 || runs[0].Status != StateFailed || runs[0].EndReason != "workflow-step-budget" || runs[0].WorkflowOutputRequestID != "" {
		t.Fatalf("步骤运行预算耗尽被当作普通记忆 stale 成功：%+v %+v", w, runs)
	}
	if runs[0].Usage.ActualTokens == nil || *runs[0].Usage.ActualTokens != 130020 || w.Usage.Tokens >= w.Limits.Tokens {
		t.Fatal("步骤与实例预算混淆或实际用量未保存")
	}
}
