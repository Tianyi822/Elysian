package harness

import (
	"context"
	"encoding/json"
	"errors"
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
			return toolReply("docker_images_list", "docker_containers_list"), nil
		}
		return finalReply("已完成"), nil
	}, func(deps *Deps) { deps.AgentLimits.TokenBudget = tokenBudgetCeiling })
	invoker.execute = func(context.Context, string) (any, error) {
		// 两个工具结果合计约 520k 字节，按 token 单位约 260k，超过 300000 容量的 80% 阈值；
		// 单结果受 256 KiB 上限约束，因此拆成两次调用。
		return strings.Repeat("x", 260000), nil
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

// 单个大事实组占满大部分剩余预算，整理后无力回退时必须跳过，直接用原请求答复。
func TestAgentSkipsProactiveCompactionWhenFallbackBudgetIsTight(t *testing.T) {
	var inferences atomic.Int32
	m, session, invoker := agentManager(t, func(_ context.Context, _ model.Profile, request model.Request) (model.Response, error) {
		if request.ToolChoice == "store_working_memory" {
			return memoryReply(request), nil
		}
		if inferences.Add(1) == 1 {
			return toolReply("docker_images_list", "docker_containers_list"), nil
		}
		if !strings.Contains(allRequestText(request), strings.Repeat("x", 150000)) {
			t.Error("跳过整理后丢失了原始工具事实")
		}
		return finalReply("已完成"), nil
	}, nil)
	invoker.execute = func(_ context.Context, name string) (any, error) {
		// 事实总量约 310k 字节（约 155k token），超过默认 196608 预算的 80% 阈值，
		// 而整理预检还要再容纳一次同样大小的 checkpoint，因此必须跳过。
		if name == "docker_containers_list" {
			return strings.Repeat("y", 160000), nil
		}
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
	for _, record := range records.Items {
		if record.Purpose == "checkpoint" {
			t.Fatal("回退预算不足时仍触发主动压缩")
		}
	}
}

// 共享对话不会进入整理请求，预检应按实际 checkpoint 计费，而非把完整推理重复计算两次。
func TestAgentProactiveCompactionWithinRunBudgetOnLargeModel(t *testing.T) {
	var inferences atomic.Int32
	m, session, invoker := agentManager(t, func(_ context.Context, _ model.Profile, request model.Request) (model.Response, error) {
		if request.ToolChoice == "store_working_memory" {
			return memoryReply(request), nil
		}
		switch inferences.Add(1) {
		case 1:
			return usageReply(finalReply(strings.Repeat("h", 231000)), 20, 28000), nil
		case 2:
			// prompt 视为不可参数量级的 20，避免把假 response 反推成校准比例；
			// 大 completion 仍会推进 Run 预算，构造 1M 模型受默认预算约束的场景。
			return usageReply(toolReply("docker_images_list"), 20, 38000), nil
		default:
			return finalReply("已完成"), nil
		}
	}, nil)
	// 共享历史约 231k 字节（约 120k token）使固定上下文接近但未达有效容量的 80%；本轮 14k 字节
	// 工具事实把完整请求推过阈值，而整理请求不含共享历史，因此 1M 模型受默认 196608 预算约束时预检仍可通过。
	invoker.execute = func(context.Context, string) (any, error) { return strings.Repeat("x", 14000), nil }
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
	first := submitAgentTest(t, m, session, "large-history", "记录共享背景")
	if got := runtimeFinished(t, m, first.ID); got.Status != StateSucceeded {
		t.Fatalf("背景运行失败：%+v", got)
	}
	run := submitAgentTest(t, m, session, "large-compact", "读取镜像后给出结论")
	got := runtimeFinished(t, m, run.ID)
	if got.Status != StateSucceeded {
		t.Fatalf("运行失败：%+v", got)
	}
	records, err := m.ModelRequests(context.Background(), run.ID, "", 50)
	if err != nil {
		t.Fatal(err)
	}
	for _, record := range records.Items {
		if record.Purpose == "checkpoint" {
			return
		}
	}
	t.Fatal("1M 模型在剩余 Run 预算允许回退时未主动压缩")
}

// 主动压缩不能吃掉本轮推理最后一个请求槽；预算不足时宁可跳过压缩让推理继续。
func TestAgentSkipsProactiveCompactionWhenRequestsAreTight(t *testing.T) {
	var inferences atomic.Int32
	m, session, invoker := agentManager(t, func(_ context.Context, _ model.Profile, request model.Request) (model.Response, error) {
		if request.ToolChoice == "store_working_memory" {
			return memoryReply(request), nil
		}
		if inferences.Add(1) == 1 {
			return toolReply("docker_images_list", "docker_containers_list"), nil
		}
		return finalReply("已完成"), nil
	}, func(deps *Deps) {
		deps.AgentLimits.MaxModelRequests = 3
		deps.AgentLimits.TokenBudget = tokenBudgetCeiling
	})
	invoker.execute = func(context.Context, string) (any, error) {
		// 与容量阈值用例一致：两次 260k 字节事实按 token 单位超过 300000 容量的 80%。
		return strings.Repeat("x", 260000), nil
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
		Limits: Limits{MaxModelRequests: 16, TokenBudget: 2*estimate + 1041, MemoryBytes: 16},
		Usage:  Usage{ModelRequests: 1, Tokens: 1},
	}}
	if !a.canProactivelyCompact(request, request) {
		t.Fatal("预算充足时不应跳过主动压缩")
	}
	a.run.Limits.TokenBudget--
	if a.canProactivelyCompact(request, request) {
		t.Fatal("token 预算不足以容纳压缩后的推理时仍允许压缩")
	}
	a.run.Limits.TokenBudget = 1000000
	a.run.Limits.MaxModelRequests = 3
	if a.canProactivelyCompact(request, request) {
		t.Fatal("请求槽不足时仍允许主动压缩")
	}
}

func TestCanProactivelyCompactReservesOriginalRequestForFallback(t *testing.T) {
	request := model.Request{Messages: []model.Message{{Role: "user", Content: strings.Repeat("x", 10000)}}}
	fullEstimate := estimateRequest(request)
	checkpoint := model.Request{Messages: []model.Message{{Role: "user", Content: "较短的整理请求"}}, MaxTokens: 2048}
	checkpointEstimate := estimateRequest(checkpoint)
	a := agentExecution{run: Run{
		Model:  &model.Profile{ContextTokens: 65536},
		Limits: Limits{MaxModelRequests: 16, TokenBudget: fullEstimate + checkpointEstimate + 2047, MemoryBytes: 16},
		Usage:  Usage{},
	}}
	if a.canProactivelyCompact(request, checkpoint) {
		t.Fatal("预算只覆盖压缩后的小上下文，未覆盖可能回退的原请求")
	}
	a.run.Limits.TokenBudget++
	if !a.canProactivelyCompact(request, checkpoint) {
		t.Fatal("为原请求回退路径预留完整预算后仍拒绝压缩")
	}
}

func TestProactiveCompactionMustReducePressure(t *testing.T) {
	fixed := model.Request{Messages: []model.Message{{Role: "user", Content: strings.Repeat("f", 5000)}}, MaxTokens: 512}
	request := fixed
	request.Messages = append(append([]model.Message(nil), fixed.Messages...), model.Message{Role: "assistant", Content: strings.Repeat("x", 10000)})
	requestPressure := estimateRequest(request) + request.MaxTokens
	modelCapacity := requestPressure*100/autoCompactPercent - 1
	a := agentExecution{run: Run{
		Model:  &model.Profile{ContextTokens: modelCapacity},
		Limits: Limits{TokenBudget: 2 * modelCapacity},
	}}
	if !a.contextPressure(request) {
		t.Fatal("fixture 未达到完整请求阈值")
	}
	if a.contextPressure(fixed) {
		t.Fatal("fixture 的固定上下文不应独自达到阈值")
	}
	if !a.proactiveCompactionUseful(request, fixed) {
		t.Fatal("可被整理事实导致的压力未触发主动整理")
	}

	fixedPressure := estimateRequest(fixed) + fixed.MaxTokens
	a.run.Model.ContextTokens = fixedPressure*100/autoCompactPercent - 1
	a.run.Limits.TokenBudget = 2 * a.run.Model.ContextTokens
	if !a.contextPressure(request) || !a.contextPressure(fixed) {
		t.Fatal("fixture 未构造固定上下文自身达到阈值")
	}
	if a.proactiveCompactionUseful(request, fixed) {
		t.Fatal("整理无法降低固定上下文压力时仍建议压缩")
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

// 原始目标独自超过阈值时，小工具事实不能触发每轮一次的无效 checkpoint。
func TestAgentDoesNotRepeatCompactionForFixedContext(t *testing.T) {
	var inferences atomic.Int32
	m, session, invoker := agentManager(t, func(_ context.Context, _ model.Profile, request model.Request) (model.Response, error) {
		if request.ToolChoice == "store_working_memory" {
			return usageReply(memoryReply(request), 100, 100), nil
		}
		switch inferences.Add(1) {
		case 1:
			return usageReply(finalReply("首轮完成"), 100, 100), nil
		case 2, 3, 4, 5, 6:
			return usageReply(toolReply("docker_images_list"), 100, 100), nil
		default:
			return finalReply("续轮完成"), nil
		}
	}, func(deps *Deps) {
		deps.AgentLimits.TokenBudget = tokenBudgetCeiling
		deps.AgentLimits.MaxModelRequests = 8
	})
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
	initial := submitAgentTest(t, m, session, "fixed-first", strings.Repeat("g", 30000))
	if got := runtimeFinished(t, m, initial.ID); got.Status != StateSucceeded {
		t.Fatalf("首轮失败：%+v", got)
	}
	// 固定上下文（原始目标 30000 字节约 17.5k token）自身达到 22000 容量的 80% 阈值；
	// contextPressure 在模型容量成为约束时计入 MaxTokens，因此容量需低于原始目标的字节数。
	second, err := m.UpdateModelProfile(profile.ID, first.Revision, model.Input{Provider: profile.Provider, APIFormat: profile.APIFormat,
		BaseURL: profile.BaseURL, Model: profile.Model, ContextTokens: 22000, OutputTokens: 512,
		Capabilities: profile.Capabilities, Active: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = m.SwitchSessionModel(context.Background(), session.ID, SwitchModelInput{ModelProfileID: second.ID, ModelRevision: second.Revision}); err != nil {
		t.Fatal(err)
	}
	next, _, err := m.ContinueTask(context.Background(), initial.TaskID, AgentInput{RequestID: "fixed-second", Content: "继续"})
	if err != nil {
		t.Fatal(err)
	}
	got := runtimeFinished(t, m, next.ID)
	if got.Status != StateSucceeded || got.Usage.Calls != 5 || got.Usage.ModelRequests != 7 {
		t.Fatalf("固定上下文压力消耗了推理请求槽：%+v", got)
	}
	records, err := m.ModelRequests(context.Background(), next.ID, "", 50)
	if err != nil {
		t.Fatal(err)
	}
	for _, record := range records.Items {
		if record.Purpose == "checkpoint" {
			t.Fatalf("固定上下文压力仍反复整理：%+v", record)
		}
	}
}

// 整理成功但新的工作记忆让重建请求装不下时，本轮回到压缩前已验证可容纳的请求，而不是失败。
func TestAgentProactiveCompactionFallsBackWhenMemoryGrows(t *testing.T) {
	for _, tc := range []struct {
		name          string
		contextTokens int
		budget        int
		memoryFails   bool
		checkpoint    bool
	}{
		// token 单位下重建请求（固定上下文约 4.7k + 15800 字记忆摘要约 7.9k）约 12.6k token，
		// 因此把容量压到 12500 才能验证「重建装不下时回退」；容量再低会因工具定义预算不足
		// 无法展示内置工具。整理预检同时预留整理请求、输出余量与完整原请求，token 单位下
		// 默认 MemoryBytes=16384 的 outputReserve 使纯预算回退分支在 80% 压力下不可达，
		// 该公式由 TestCanProactivelyCompactReservesOriginalRequestForFallback 单独覆盖。
		{"window fallback", 12500, 196608, false, true},
		{"insufficient fallback budget", 12500, 30000, false, false},
		{"failed checkpoint", 12500, 196608, true, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var inferences, memories atomic.Int32
			m, session, invoker := agentManager(t, func(_ context.Context, _ model.Profile, request model.Request) (model.Response, error) {
				if request.ToolChoice == "store_working_memory" {
					reply := memoryReply(request)
					if memories.Add(1) >= 2 {
						if tc.memoryFails {
							return model.Response{}, errors.New("checkpoint unavailable")
						}
						var proposal memoryProposal
						if err := json.Unmarshal(reply.ToolCalls[0].Arguments, &proposal); err != nil {
							return model.Response{}, err
						}
						proposal.Summary = strings.Repeat("m", 15800)
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
			}, func(deps *Deps) { deps.AgentLimits.TokenBudget = tc.budget })
			// 10k 事实字节在 token 单位下约 5k token：12500 容量的 80% 阈值由事实组触发，
			// 而整理后的记忆摘要（15800 字）会让重建请求超过容量，从而验证回退路径。
			invoker.execute = func(context.Context, string) (any, error) { return strings.Repeat("e", 10000), nil }
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
			initial := submitAgentTest(t, m, session, "fallback-first", "先检查当前状态")
			if got := runtimeFinished(t, m, initial.ID); got.Status != StateSucceeded {
				t.Fatalf("首轮失败：%+v", got)
			}
			second, err := m.UpdateModelProfile(profile.ID, first.Revision, model.Input{Provider: profile.Provider, APIFormat: profile.APIFormat,
				BaseURL: profile.BaseURL, Model: profile.Model, ContextTokens: tc.contextTokens, OutputTokens: 512,
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
				debugRecords, _ := m.ModelRequests(context.Background(), next.ID, "", 50)
				t.Fatalf("压缩后重建失败未回退：%+v records=%+v", got, debugRecords.Items)
			}
			records, err := m.ModelRequests(context.Background(), next.ID, "", 50)
			if err != nil {
				t.Fatal(err)
			}
			found := false
			for _, record := range records.Items {
				if record.Purpose == "checkpoint" {
					found = true
					if tc.memoryFails && record.Status != StateFailed || !tc.memoryFails && record.Status != StateSucceeded {
						t.Fatalf("整理状态不符合预期：%+v", record)
					}
				}
				if record.Purpose == "inference" && record.MemoryRevision != next.InitialMemoryRevision {
					t.Fatalf("未使用压缩前的记忆修订回退：%+v", record)
				}
			}
			if found != tc.checkpoint {
				t.Fatalf("checkpoint=%v，期望 %v：%+v", found, tc.checkpoint, records.Items)
			}
		})
	}
}
