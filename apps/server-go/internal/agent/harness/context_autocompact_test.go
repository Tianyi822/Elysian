package harness

import (
	"context"
	"encoding/json"
	"strings"
	"sync/atomic"
	"testing"

	"elysian/server/internal/agent/harness/model"
)

// 请求仍能装下时，达到有效容量的 80% 就应先整理，而不是等溢出后才被动 checkpoint。
func TestAgentProactiveCompactionBeforeContextPressure(t *testing.T) {
	var inferences atomic.Int32
	m, session, invoker := agentManager(t, func(_ context.Context, _ model.Profile, request model.Request) (model.Response, error) {
		if request.ToolChoice == "store_working_memory" {
			return memoryReply(request), nil
		}
		if inferences.Add(1) == 1 {
			return toolReply("docker_images_list"), nil
		}
		return finalReply("已完成"), nil
	}, func(deps *Deps) { deps.AgentLimits.TokenBudget = tokenBudgetCeiling })
	invoker.execute = func(context.Context, string) (any, error) {
		return strings.Repeat("x", 250000), nil
	}
	profile, err := m.deps.Profiles.Resolve(session.ModelProfileID, 1, true)
	if err != nil {
		t.Fatal(err)
	}
	revised, err := m.UpdateModelProfile(profile.ID, 1, model.Input{Provider: profile.Provider, APIFormat: profile.APIFormat,
		BaseURL: profile.BaseURL, Model: profile.Model, ContextTokens: 300000, OutputTokens: 512,
		Capabilities: profile.Capabilities, Active: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = m.SwitchSessionModel(context.Background(), session.ID, SwitchModelInput{ModelProfileID: revised.ID, ModelRevision: revised.Revision}); err != nil {
		t.Fatal(err)
	}
	run := submitAgentTest(t, m, session, "auto-compact", "读取镜像后给出结论")
	got := runtimeFinished(t, m, run.ID)
	if got.Status != StateSucceeded {
		t.Fatalf("运行失败：%+v", got)
	}
	records, err := m.ModelRequests(context.Background(), run.ID, "", 50)
	if err != nil {
		t.Fatal(err)
	}
	inferenceIndexes := []int{}
	checkpoint := -1
	for _, record := range records.Items {
		switch record.Purpose {
		case "inference":
			inferenceIndexes = append(inferenceIndexes, record.Index)
		case "checkpoint":
			checkpoint = record.Index
		}
	}
	if len(inferenceIndexes) != 2 || checkpoint <= inferenceIndexes[0] || checkpoint >= inferenceIndexes[1] {
		t.Fatalf("未在容量阈值前主动整理：inference=%v checkpoint=%d", inferenceIndexes, checkpoint)
	}
}

// 1M 上下文模型受默认 196608 token 预算约束时，主动压缩仍必须能按剩余预算触发。
func TestAgentProactiveCompactionWithinRunBudgetOnLargeModel(t *testing.T) {
	var inferences atomic.Int32
	m, session, invoker := agentManager(t, func(_ context.Context, _ model.Profile, request model.Request) (model.Response, error) {
		if request.ToolChoice == "store_working_memory" {
			return memoryReply(request), nil
		}
		if inferences.Add(1) == 1 {
			return toolReply("docker_images_list"), nil
		}
		return finalReply("已完成"), nil
	}, nil)
	invoker.execute = func(context.Context, string) (any, error) {
		return strings.Repeat("x", 150000), nil
	}
	profile, err := m.deps.Profiles.Resolve(session.ModelProfileID, 1, true)
	if err != nil {
		t.Fatal(err)
	}
	revised, err := m.UpdateModelProfile(profile.ID, 1, model.Input{Provider: profile.Provider, APIFormat: profile.APIFormat,
		BaseURL: profile.BaseURL, Model: profile.Model, ContextTokens: 1048576, OutputTokens: 512,
		Capabilities: profile.Capabilities, Active: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = m.SwitchSessionModel(context.Background(), session.ID, SwitchModelInput{ModelProfileID: revised.ID, ModelRevision: revised.Revision}); err != nil {
		t.Fatal(err)
	}
	run := submitAgentTest(t, m, session, "auto-compact-large", "读取镜像后给出结论")
	got := runtimeFinished(t, m, run.ID)
	if got.Status != StateSucceeded {
		t.Fatalf("运行失败：%+v", got)
	}
	records, err := m.ModelRequests(context.Background(), run.ID, "", 50)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, record := range records.Items {
		if record.Purpose == "checkpoint" {
			found = true
		}
	}
	if !found {
		t.Fatal("1M 模型在 Run 预算内未能触发主动压缩")
	}
}

// 主动压缩不能吃掉本轮推理最后一个请求槽；预算不足时宁可跳过压缩让推理继续。
func TestAgentSkipsProactiveCompactionWhenRequestsAreTight(t *testing.T) {
	var inferences atomic.Int32
	m, session, invoker := agentManager(t, func(_ context.Context, _ model.Profile, request model.Request) (model.Response, error) {
		if request.ToolChoice == "store_working_memory" {
			return memoryReply(request), nil
		}
		if inferences.Add(1) == 1 {
			return toolReply("docker_images_list"), nil
		}
		return finalReply("已完成"), nil
	}, func(deps *Deps) {
		deps.AgentLimits.MaxModelRequests = 3
		deps.AgentLimits.TokenBudget = tokenBudgetCeiling
	})
	invoker.execute = func(context.Context, string) (any, error) {
		return strings.Repeat("x", 250000), nil
	}
	profile, err := m.deps.Profiles.Resolve(session.ModelProfileID, 1, true)
	if err != nil {
		t.Fatal(err)
	}
	revised, err := m.UpdateModelProfile(profile.ID, 1, model.Input{Provider: profile.Provider, APIFormat: profile.APIFormat,
		BaseURL: profile.BaseURL, Model: profile.Model, ContextTokens: 300000, OutputTokens: 512,
		Capabilities: profile.Capabilities, Active: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = m.SwitchSessionModel(context.Background(), session.ID, SwitchModelInput{ModelProfileID: revised.ID, ModelRevision: revised.Revision}); err != nil {
		t.Fatal(err)
	}
	run := submitAgentTest(t, m, session, "auto-compact-tight", "读取镜像后给出结论")
	got := runtimeFinished(t, m, run.ID)
	if got.Status != StateSucceeded || got.Usage.ModelRequests != 3 {
		t.Fatalf("紧预算运行失败：%+v", got)
	}
	records, err := m.ModelRequests(context.Background(), run.ID, "", 50)
	if err != nil {
		t.Fatal(err)
	}
	for _, record := range records.Items {
		if record.Purpose == "checkpoint" {
			t.Fatal("请求槽不足时仍执行了主动压缩")
		}
	}
}

func TestEffectiveContextCapacityUsesModelAndRunBudget(t *testing.T) {
	for _, test := range []struct {
		name    string
		context int
		budget  int
		used    int
		want    int
	}{
		{"large model limited by run budget", 1048576, 196608, 0, 196608},
		{"large model with used budget", 1048576, 196608, 100000, 96608},
		{"small model limited by context", 65536, 196608, 0, 65536},
		{"remaining budget smaller", 65536, 100000, 40000, 60000},
		{"budget exhausted", 1048576, 196608, 200000, 0},
	} {
		t.Run(test.name, func(t *testing.T) {
			a := agentExecution{run: Run{Model: &model.Profile{ContextTokens: test.context}, Limits: Limits{TokenBudget: test.budget}, Usage: Usage{Tokens: test.used}}}
			if got := a.effectiveContextTokens(); got != test.want {
				t.Fatalf("有效容量=%d，期望 %d", got, test.want)
			}
		})
	}
}

func TestCanProactivelyCompactReservesBothRequests(t *testing.T) {
	request := model.Request{Messages: []model.Message{{Role: "user", Content: strings.Repeat("x", 1000)}}}
	estimate := estimateRequest(request)
	a := agentExecution{run: Run{
		Limits: Limits{MaxModelRequests: 16, TokenBudget: 2*estimate + 32, MemoryBytes: 16},
		Usage:  Usage{ModelRequests: 1, Tokens: 1},
	}}
	if !a.canProactivelyCompact(request, estimate, estimate) {
		t.Fatal("预算充足时不应跳过主动压缩")
	}
	a.run.Limits.TokenBudget = 2*estimate + 10
	if a.canProactivelyCompact(request, estimate, estimate) {
		t.Fatal("token 预算不足以容纳压缩后的推理时仍允许压缩")
	}
	a.run.Limits.TokenBudget = 1000000
	a.run.Limits.MaxModelRequests = 3
	if a.canProactivelyCompact(request, estimate, estimate) {
		t.Fatal("请求槽不足时仍允许主动压缩")
	}
}

func TestProactiveCompactionEligibility(t *testing.T) {
	for _, test := range []struct {
		name     string
		driver   string
		workflow string
		want     bool
	}{
		{"普通聊天 v2", "v2", "", true},
		{"旧 v1", "v1", "", false},
		{"工作流 v2", "v2", "workflow-1", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			a := agentExecution{run: Run{DriverVersion: test.driver, WorkflowID: test.workflow}}
			if got := a.proactiveCompactionEligible(); got != test.want {
				t.Fatalf("eligibility=%v，期望 %v", got, test.want)
			}
		})
	}
}

// 整理成功但新的工作记忆让重建请求装不下时，本轮回到压缩前已验证可容纳的请求，而不是失败。
func TestAgentProactiveCompactionFallsBackWhenMemoryGrows(t *testing.T) {
	var inferences, memories atomic.Int32
	m, session, invoker := agentManager(t, func(_ context.Context, _ model.Profile, request model.Request) (model.Response, error) {
		if request.ToolChoice == "store_working_memory" {
			reply := memoryReply(request)
			if memories.Add(1) >= 2 {
				var proposal memoryProposal
				if err := json.Unmarshal(reply.ToolCalls[0].Arguments, &proposal); err != nil {
					return model.Response{}, err
				}
				proposal.Summary = strings.Repeat("m", 14000)
				reply.ToolCalls[0].Arguments, _ = json.Marshal(proposal)
			}
			return reply, nil
		}
		switch inferences.Add(1) {
		case 1:
			return finalReply("首轮完成"), nil
		case 2:
			return toolReply("docker_images_list"), nil
		default:
			return finalReply("续轮完成"), nil
		}
	}, nil)
	invoker.execute = func(context.Context, string) (any, error) { return "evidence", nil }
	profile, err := m.deps.Profiles.Resolve(session.ModelProfileID, 1, true)
	if err != nil {
		t.Fatal(err)
	}
	first, err := m.UpdateModelProfile(profile.ID, 1, model.Input{Provider: profile.Provider, APIFormat: profile.APIFormat,
		BaseURL: profile.BaseURL, Model: profile.Model, ContextTokens: 110000, OutputTokens: 512,
		Capabilities: profile.Capabilities, Active: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = m.SwitchSessionModel(context.Background(), session.ID, SwitchModelInput{ModelProfileID: first.ID, ModelRevision: first.Revision}); err != nil {
		t.Fatal(err)
	}
	initial := submitAgentTest(t, m, session, "fallback-first", strings.Repeat("g", 30000))
	if got := runtimeFinished(t, m, initial.ID); got.Status != StateSucceeded {
		t.Fatalf("首轮失败：%+v", got)
	}
	second, err := m.UpdateModelProfile(profile.ID, first.Revision, model.Input{Provider: profile.Provider, APIFormat: profile.APIFormat,
		BaseURL: profile.BaseURL, Model: profile.Model, ContextTokens: 45000, OutputTokens: 512,
		Capabilities: profile.Capabilities, Active: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = m.SwitchSessionModel(context.Background(), session.ID, SwitchModelInput{ModelProfileID: second.ID, ModelRevision: second.Revision}); err != nil {
		t.Fatal(err)
	}
	next, _, err := m.ContinueTask(context.Background(), initial.TaskID, AgentInput{RequestID: "fallback-second", Content: "继续"})
	if err != nil {
		t.Fatal(err)
	}
	got := runtimeFinished(t, m, next.ID)
	if got.Status != StateSucceeded {
		t.Fatalf("压缩后重建失败未回退：%+v", got)
	}
	records, err := m.ModelRequests(context.Background(), next.ID, "", 50)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, record := range records.Items {
		if record.Purpose == "checkpoint" {
			found = true
		}
	}
	if !found {
		t.Fatal("未触发主动压缩")
	}
}
