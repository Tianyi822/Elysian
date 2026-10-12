package harness

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"elysian/server/internal/agent/harness/model"
	"elysian/server/internal/agent/harness/worker"
	"elysian/server/internal/agent/tools"
)

type agentTestClient func(context.Context, model.Profile, model.Request) (model.Response, error)

func (f agentTestClient) Complete(c context.Context, p model.Profile, r model.Request) (model.Response, error) {
	return f(c, p, r)
}

type agentTestProcess struct {
	runtimeTestProcess
	runAgent func(context.Context, string, worker.AgentBroker) error
}

func (p *agentTestProcess) RunAgent(ctx context.Context, id string, b worker.AgentBroker) error {
	if p.runAgent != nil {
		return p.runAgent(ctx, id, b)
	}
	for {
		response, err := b.NextModel(ctx)
		if err != nil {
			return err
		}
		if response.Final {
			return b.Finalize(ctx, response.ID)
		}
		for index, call := range response.ToolCalls {
			if index < response.StartIndex {
				continue
			}
			if err = b.ExecuteAgent(ctx, response.ID, index, call.ID, call.Name, call.Args); err != nil {
				return err
			}
		}
	}
}

type agentTestTools struct{ runtimeTestTools }

func (*agentTestTools) Schemas() []tools.PublicSchema {
	var schemas []tools.PublicSchema
	for _, name := range []string{"docker_containers_list", "docker_images_list", "docker_policy_view", "docker_self_container"} {
		schemas = append(schemas, tools.PublicSchema{Name: name, Description: "读取测试状态", Parameters: map[string]any{"type": "object", "properties": map[string]any{}, "additionalProperties": false}})
	}
	return schemas
}

var revisionInPrompt = regexp.MustCompile(`revision=(\d+)`)

func memoryReply(request model.Request) model.Response {
	revision := 0
	for _, msg := range request.Messages {
		if match := revisionInPrompt.FindStringSubmatch(msg.Content); len(match) == 2 {
			revision, _ = strconv.Atoi(match[1])
		}
	}
	args, _ := json.Marshal(memoryProposal{ExpectedRevision: revision, Constraints: []string{}, Facts: []MemoryFact{}, Todos: []string{}, OpenQuestions: []string{}, Summary: "已完成本轮分析"})
	return model.Response{FinishReason: "tool_calls", ToolCalls: []model.ToolCall{{ID: "memory", Name: "store_working_memory", Arguments: args}}}
}
func finalReply(answer string) model.Response {
	return model.Response{Content: answer, FinishReason: "stop"}
}
func toolReply(names ...string) model.Response {
	r := model.Response{FinishReason: "tool_calls"}
	for i, name := range names {
		r.ToolCalls = append(r.ToolCalls, model.ToolCall{ID: fmt.Sprintf("call_%d", i), Name: name, Arguments: json.RawMessage(`{}`)})
	}
	return r
}
func agentManager(t *testing.T, client agentTestClient, change func(*Deps)) (*Manager, Session, *agentTestTools) {
	t.Helper()
	profiles, err := model.Open(filepath.Join(t.TempDir(), "agent-models.json"))
	if err != nil {
		t.Fatal(err)
	}
	secret := "test-only-secret-never-persist-in-runtime"
	profile, err := profiles.Create(model.Input{Provider: model.ProviderOpenAICompatible, APIFormat: model.FormatChatCompletions, Name: "测试模型", BaseURL: "http://127.0.0.1:9/v1", Model: "test", ContextTokens: 65536, OutputTokens: 4096, Capabilities: model.Capabilities{Text: true, Tools: true, Source: "test"}, Active: true, Credential: &secret})
	if err != nil {
		t.Fatal(err)
	}
	invoker := &agentTestTools{}
	deps := Deps{Path: filepath.Join(t.TempDir(), "harness.sqlite"), Tools: invoker, Profiles: profiles, ModelClient: client, Spawn: func(context.Context) (worker.Process, error) { return &agentTestProcess{}, nil }, AgentLimits: DefaultAgentLimits()}
	deps.Limits = DefaultLimits()
	deps.Limits.Concurrency = 1
	if change != nil {
		change(&deps)
	}
	m, err := New(deps)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := m.Close(ctx); err != nil {
			t.Error(err)
		}
	})
	runtimeEventually(t, func() bool { return m.Info().Agent.Available })
	session, err := m.CreateSession(context.Background(), CreateSessionInput{Title: "专用回归会话", ModelProfileID: profile.ID, ModelRevision: profile.Revision})
	if err != nil {
		t.Fatal(err)
	}
	return m, session, invoker
}
func submitAgentTest(t *testing.T, m *Manager, s Session, key, content string) Run {
	t.Helper()
	run, dup, err := m.CreateTask(context.Background(), s.ID, AgentInput{RequestID: key, Content: content})
	if err != nil || dup {
		t.Fatalf("提交失败 duplicate=%v err=%v", dup, err)
	}
	return run
}
func TestAgentDirectAnswerAndAtomicMemory(t *testing.T) {
	var count atomic.Int32
	m, s, _ := agentManager(t, func(_ context.Context, p model.Profile, r model.Request) (model.Response, error) {
		count.Add(1)
		if p.Credential == "" {
			t.Error("父模型客户端未获得固定凭据")
		}
		if r.ToolChoice == "store_working_memory" {
			return memoryReply(r), nil
		}
		return finalReply("没有执行变更"), nil
	}, nil)
	run := submitAgentTest(t, m, s, "direct", "说明可用工具")
	got := runtimeFinished(t, m, run.ID)
	if got.Status != StateSucceeded || got.MemoryStatus != "updated" || count.Load() != 2 || got.Usage.ModelRequests != 2 {
		t.Fatalf("闭环失败：%+v count=%d", got, count.Load())
	}
	if got.Usage.ActualTokens != nil || got.Usage.CachedTokens != nil || got.Usage.EstimatedTokens == 0 {
		t.Fatalf("未知用量不应记为0：%+v", got.Usage)
	}
	history, err := m.Messages(context.Background(), s.ID, "", 50)
	if err != nil || len(history.Items) != 2 || history.Items[1].Content != "没有执行变更" {
		t.Fatalf("公开历史错误：%+v %v", history, err)
	}
	memory, err := m.Memory(context.Background(), run.TaskID, 0)
	if err != nil || memory.Revision != 1 || memory.Coverage.RunNumber != 1 || memory.Objective != "说明可用工具" {
		t.Fatalf("记忆错误：%+v %v", memory, err)
	}
	current, _ := m.GetSession(context.Background(), s.ID)
	if current.ActiveRunID != "" {
		t.Fatal("终态未释放会话")
	}
	records, err := m.ModelRequests(context.Background(), run.ID, "", 50)
	if err != nil || len(records.Items) != 2 {
		t.Fatalf("模型事实缺失：%+v %v", records, err)
	}
	public, _ := json.Marshal(struct {
		Run     Run
		Records Page[ModelRequestRecord]
	}{got, records})
	if strings.Contains(string(public), "test-only-secret") {
		t.Fatal("凭据进入运行记录")
	}
}

func TestAgentSerialToolsBusinessFailureContinues(t *testing.T) {
	var inference atomic.Int32
	var seen string
	m, s, invoker := agentManager(t, func(_ context.Context, _ model.Profile, r model.Request) (model.Response, error) {
		if r.ToolChoice == "store_working_memory" {
			return memoryReply(r), nil
		}
		if inference.Add(1) == 1 {
			return toolReply("docker_containers_list", "docker_images_list"), nil
		}
		raw, _ := json.Marshal(r.Messages)
		seen = string(raw)
		return finalReply("容器读取失败，镜像已读取"), nil
	}, nil)
	var order []string
	invoker.execute = func(_ context.Context, name string) (any, error) {
		order = append(order, name)
		if name == "docker_containers_list" {
			return nil, errors.New("域内部不可公开诊断")
		}
		return []string{"image-evidence"}, nil
	}
	run := submitAgentTest(t, m, s, "tools", "检查容器与镜像")
	got := runtimeFinished(t, m, run.ID)
	if got.Status != StateSucceeded || got.Usage.Calls != 2 || len(order) != 2 || order[0] != "docker_containers_list" || order[1] != "docker_images_list" {
		t.Fatalf("工具循环失败：%+v order=%v", got, order)
	}
	if !strings.Contains(seen, "tool-failed") || !strings.Contains(seen, "image-evidence") || strings.Contains(seen, "域内部不可公开诊断") {
		t.Fatalf("模型工具结果错误：%s", seen)
	}
	calls, _ := m.Calls(context.Background(), run.ID, "", 50)
	if calls.Items[0].Status != StateFailed || calls.Items[1].Status != StateSucceeded || calls.Items[0].ModelRequestID == "" {
		t.Fatalf("工具事实未保留：%+v", calls)
	}
}

func TestAgentMemoryFailureStaleAndContinuationKeepsUncoveredFacts(t *testing.T) {
	var failMemory atomic.Bool
	failMemory.Store(true)
	var seenMu sync.Mutex
	var seen []string
	m, s, _ := agentManager(t, func(_ context.Context, _ model.Profile, r model.Request) (model.Response, error) {
		if r.ToolChoice == "store_working_memory" {
			if failMemory.Load() {
				return model.Response{}, errors.New("测试整理失败")
			}
			return memoryReply(r), nil
		}
		raw, _ := json.Marshal(r.Messages)
		seenMu.Lock()
		seen = append(seen, string(raw))
		seenMu.Unlock()
		return finalReply("保留这条已完成的答复"), nil
	}, nil)
	first := submitAgentTest(t, m, s, "stale-first", "必须保留的原始约束")
	got := runtimeFinished(t, m, first.ID)
	if got.Status != StateSucceeded || got.MemoryStatus != "stale" || got.Warning == nil {
		t.Fatalf("整理失败丢失答复：%+v", got)
	}
	memory, _ := m.Memory(context.Background(), first.TaskID, 0)
	if memory.Revision != 0 {
		t.Fatal("失败整理覆盖了旧记忆")
	}
	failMemory.Store(false)
	next, _, err := m.ContinueTask(context.Background(), first.TaskID, AgentInput{RequestID: "stale-next", Content: "继续处理"})
	if err != nil {
		t.Fatal(err)
	}
	got = runtimeFinished(t, m, next.ID)
	if got.Status != StateSucceeded || got.RunNumber != 2 || got.MemoryStatus != "updated" {
		t.Fatalf("续轮失败：%+v", got)
	}
	seenMu.Lock()
	last := seen[len(seen)-1]
	seenMu.Unlock()
	if !strings.Contains(last, "必须保留的原始约束") || !strings.Contains(last, "保留这条已完成的答复") {
		t.Fatalf("续轮静默丢弃未整理事实：%s", last)
	}
}

func TestAgentBusyIdempotencyAndPinnedModel(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	m, s, _ := agentManager(t, func(ctx context.Context, p model.Profile, r model.Request) (model.Response, error) {
		if r.ToolChoice == "store_working_memory" {
			return memoryReply(r), nil
		}
		once.Do(func() { close(entered) })
		select {
		case <-release:
		case <-ctx.Done():
			return model.Response{}, ctx.Err()
		}
		if p.Revision != 1 {
			t.Error("已接受运行模型被修订改变")
		}
		return finalReply("完成"), nil
	}, nil)
	t.Cleanup(func() {
		select {
		case <-release:
		default:
			close(release)
		}
	})
	run := submitAgentTest(t, m, s, "busy", "等待中的任务")
	<-entered
	duplicate, dup, err := m.CreateTask(context.Background(), s.ID, AgentInput{RequestID: "busy", Content: "等待中的任务"})
	if err != nil || !dup || duplicate.ID != run.ID {
		t.Fatalf("忙碌去重失败：%v %v", dup, err)
	}
	_, _, err = m.CreateTask(context.Background(), s.ID, AgentInput{RequestID: "another", Content: "新任务"})
	var runtimeErr *Error
	if !errors.As(err, &runtimeErr) || runtimeErr.Code != "session-busy" {
		t.Fatalf("忙碌未拒绝：%v", err)
	}
	_, err = m.SwitchSessionModel(context.Background(), s.ID, SwitchModelInput{ModelProfileID: s.ModelProfileID, ModelRevision: 1})
	if !errors.As(err, &runtimeErr) || runtimeErr.Code != "session-busy" {
		t.Fatalf("忙碌仍切换模型：%v", err)
	}
	profile, _ := m.deps.Profiles.Resolve(s.ModelProfileID, 1, true)
	_, err = m.UpdateModelProfile(profile.ID, 1, model.Input{Provider: model.ProviderOpenAICompatible, APIFormat: model.FormatChatCompletions, Name: profile.Name, BaseURL: profile.BaseURL, Model: profile.Model, ContextTokens: profile.ContextTokens, OutputTokens: profile.OutputTokens, Capabilities: profile.Capabilities, Active: false})
	if err != nil {
		t.Fatal(err)
	}
	close(release)
	got := runtimeFinished(t, m, run.ID)
	if got.Status != StateSucceeded {
		t.Fatalf("停用阻止已接受Run收尾：%+v", got)
	}
	duplicate, dup, err = m.CreateTask(context.Background(), s.ID, AgentInput{RequestID: "busy", Content: "等待中的任务"})
	if err != nil || !dup || duplicate.ID != run.ID {
		t.Fatalf("停用改变历史幂等：%v", err)
	}
	_, _, err = m.ContinueTask(context.Background(), run.TaskID, AgentInput{RequestID: "disabled", Content: "继续"})
	if err == nil {
		t.Fatal("停用模型接受新Run")
	}
}

func TestAgentCancellationDuringModelAndMemoryHasNoFinalMessage(t *testing.T) {
	for _, phase := range []string{"inference", "final-memory"} {
		t.Run(phase, func(t *testing.T) {
			entered := make(chan struct{})
			var once sync.Once
			m, s, _ := agentManager(t, func(ctx context.Context, _ model.Profile, r model.Request) (model.Response, error) {
				waiting := phase == "inference" || r.ToolChoice == "store_working_memory"
				if waiting {
					once.Do(func() { close(entered) })
					<-ctx.Done()
					return model.Response{}, ctx.Err()
				}
				return finalReply("仅候选答复"), nil
			}, nil)
			run := submitAgentTest(t, m, s, "cancel", "取消验收")
			<-entered
			if _, err := m.Cancel(context.Background(), run.ID); err != nil {
				t.Fatal(err)
			}
			got := runtimeFinished(t, m, run.ID)
			if got.Status != StateCancelled {
				t.Fatalf("取消被成功覆盖：%+v", got)
			}
			history, _ := m.Messages(context.Background(), s.ID, "", 50)
			if len(history.Items) != 1 {
				t.Fatalf("取消后提交了助手终答：%+v", history)
			}
			memory, _ := m.Memory(context.Background(), run.TaskID, 0)
			if memory.Revision != 0 {
				t.Fatal("取消后更新记忆")
			}
		})
	}
}

func TestAgentTasksShareOnlyPublicDialogue(t *testing.T) {
	var calls atomic.Int32
	var secondPrompt string
	m, s, invoker := agentManager(t, func(_ context.Context, _ model.Profile, r model.Request) (model.Response, error) {
		if r.ToolChoice == "store_working_memory" {
			reply := memoryReply(r)
			var p memoryProposal
			_ = json.Unmarshal(reply.ToolCalls[0].Arguments, &p)
			p.Summary = "另一任务的私有工作记忆"
			reply.ToolCalls[0].Arguments, _ = json.Marshal(p)
			return reply, nil
		}
		switch calls.Add(1) {
		case 1:
			return toolReply("docker_images_list"), nil
		case 2:
			return finalReply("可共享的公开结论"), nil
		default:
			raw, _ := json.Marshal(r.Messages)
			secondPrompt = string(raw)
			return finalReply("第二任务"), nil
		}
	}, nil)
	invoker.execute = func(context.Context, string) (any, error) { return "另一任务的工具轨迹", nil }
	first := submitAgentTest(t, m, s, "task-one", "第一个目标")
	if got := runtimeFinished(t, m, first.ID); got.Status != StateSucceeded {
		t.Fatal(got)
	}
	second := submitAgentTest(t, m, s, "task-two", "第二个目标")
	if got := runtimeFinished(t, m, second.ID); got.Status != StateSucceeded {
		t.Fatal(got)
	}
	if !strings.Contains(secondPrompt, "可共享的公开结论") || strings.Contains(secondPrompt, "另一任务的私有工作记忆") || strings.Contains(secondPrompt, "另一任务的工具轨迹") {
		t.Fatalf("跨任务隔离错误：%s", secondPrompt)
	}
}

func TestAgentFinalStorageFailureDoesNotPublishAnswer(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	m, s, _ := agentManager(t, func(ctx context.Context, _ model.Profile, r model.Request) (model.Response, error) {
		if r.ToolChoice == "store_working_memory" {
			close(entered)
			select {
			case <-release:
			case <-ctx.Done():
				return model.Response{}, ctx.Err()
			}
			return memoryReply(r), nil
		}
		return finalReply("不能提前发布"), nil
	}, nil)
	run := submitAgentTest(t, m, s, "storage-failure", "验收事务失败")
	<-entered
	m.mu.Lock()
	m.store.beforeWrite = func(op string) error {
		if op == "finish" {
			return errors.New("测试写入失败")
		}
		return nil
	}
	m.mu.Unlock()
	close(release)
	runtimeEventually(t, func() bool { return m.Info().Storage == "unavailable" })
	m.mu.Lock()
	m.store.beforeWrite = nil
	m.mu.Unlock()
	history, _ := m.Messages(context.Background(), s.ID, "", 50)
	if len(history.Items) != 1 {
		t.Fatal("终态事务失败却写入答复")
	}
	got, _ := m.Get(context.Background(), run.ID)
	if got.Status == StateSucceeded {
		t.Fatal("存储失败伪装成功")
	}
}

func TestAgentPressureCheckpointAndSmallModelSwitch(t *testing.T) {
	var allowMemory atomic.Bool
	var checkpoints atomic.Int32
	var inference atomic.Int32
	m, s, _ := agentManager(t, func(_ context.Context, _ model.Profile, r model.Request) (model.Response, error) {
		if r.ToolChoice == "store_working_memory" {
			if !allowMemory.Load() {
				return model.Response{}, errors.New("暂不整理")
			}
			checkpoints.Add(1)
			return memoryReply(r), nil
		}
		if inference.Add(1) <= 3 {
			return finalReply(strings.Repeat("e", 2200)), nil
		}
		return finalReply("小上下文续轮完成"), nil
	}, nil)
	first := submitAgentTest(t, m, s, "pressure-1", "保留任务目标")
	if got := runtimeFinished(t, m, first.ID); got.Status != StateSucceeded {
		t.Fatal(got)
	}
	for i := 2; i <= 3; i++ {
		run, _, err := m.ContinueTask(context.Background(), first.TaskID, AgentInput{RequestID: fmt.Sprintf("pressure-%d", i), Content: "继续收集事实"})
		if err != nil {
			t.Fatal(err)
		}
		if got := runtimeFinished(t, m, run.ID); got.Status != StateSucceeded {
			t.Fatal(got)
		}
	}
	profile, _ := m.deps.Profiles.Resolve(s.ModelProfileID, 1, true)
	revised, err := m.UpdateModelProfile(profile.ID, 1, model.Input{Provider: model.ProviderOpenAICompatible, APIFormat: model.FormatChatCompletions, Name: profile.Name, BaseURL: profile.BaseURL, Model: profile.Model, ContextTokens: 7500, OutputTokens: 512, Capabilities: profile.Capabilities, Active: true})
	if err != nil {
		t.Fatal(err)
	}
	selected, err := m.SwitchSessionModel(context.Background(), s.ID, SwitchModelInput{ModelProfileID: profile.ID, ModelRevision: revised.Revision})
	if err != nil {
		t.Fatal(err)
	}
	if selected.ModelChange == nil || len(selected.ModelChange.Differences) == 0 || len(selected.ModelChange.Notices) == 0 {
		t.Fatalf("切换未返回能力差异与缓存提示：%+v", selected)
	}
	allowMemory.Store(true)
	run, _, err := m.ContinueTask(context.Background(), first.TaskID, AgentInput{RequestID: "pressure-4", Content: "继续并给出结论"})
	if err != nil {
		t.Fatal(err)
	}
	got := runtimeFinished(t, m, run.ID)
	if got.Status != StateSucceeded || checkpoints.Load() < 1 {
		t.Fatalf("压力整理失败：%+v checkpoints=%d", got, checkpoints.Load())
	}
	records, _ := m.ModelRequests(context.Background(), run.ID, "", 50)
	found := false
	for _, record := range records.Items {
		if record.Purpose == "checkpoint" {
			found = true
		}
	}
	if !found {
		t.Fatal("容量不足却没有执行检查点")
	}
	memory, _ := m.Memory(context.Background(), first.TaskID, 0)
	if memory.Revision < 1 || memory.Coverage.RunNumber < 1 || memory.Coverage.RunNumber > 4 {
		t.Fatalf("检查点后最终记忆覆盖不完整：%+v", memory)
	}
}

func TestAgentInvalidMemoryReferenceLeavesOldMemory(t *testing.T) {
	m, s, _ := agentManager(t, func(_ context.Context, _ model.Profile, r model.Request) (model.Response, error) {
		if r.ToolChoice != "store_working_memory" {
			return finalReply("公开答复"), nil
		}
		response := memoryReply(r)
		var proposal memoryProposal
		_ = json.Unmarshal(response.ToolCalls[0].Arguments, &proposal)
		proposal.Facts = []MemoryFact{{Text: "越界事实", Sources: []EvidenceRef{{RunID: "other-task", EventSeq: "1"}}}}
		response.ToolCalls[0].Arguments, _ = json.Marshal(proposal)
		return response, nil
	}, nil)
	run := submitAgentTest(t, m, s, "bad-memory", "验证记忆来源")
	got := runtimeFinished(t, m, run.ID)
	if got.Status != StateSucceeded || got.MemoryStatus != "stale" {
		t.Fatalf("错误证据引用被接受：%+v", got)
	}
	memory, _ := m.Memory(context.Background(), run.TaskID, 0)
	if memory.Revision != 0 {
		t.Fatal("错误记忆写入")
	}
}

func TestAgentRequestBudgetReservesFinalConsolidation(t *testing.T) {
	m, s, _ := agentManager(t, func(_ context.Context, _ model.Profile, r model.Request) (model.Response, error) {
		if r.ToolChoice == "store_working_memory" {
			return memoryReply(r), nil
		}
		return toolReply("docker_images_list"), nil
	}, func(d *Deps) { d.AgentLimits.MaxModelRequests = 2 })
	run := submitAgentTest(t, m, s, "budget", "不得无限调用")
	got := runtimeFinished(t, m, run.ID)
	if got.Status != StateFailed || got.EndReason != "model-budget" || got.Usage.ModelRequests != 1 || got.Usage.Calls != 1 {
		t.Fatalf("请求预算失效：%+v", got)
	}
	history, _ := m.Messages(context.Background(), s.ID, "", 50)
	if len(history.Items) != 1 {
		t.Fatal("预算耗尽仍发布终答")
	}
}

func TestAgentUnresponsiveModelKeepsExecutionSlot(t *testing.T) {
	release := make(chan struct{})
	entered := make(chan struct{})
	var once sync.Once
	m, s, _ := agentManager(t, func(context.Context, model.Profile, model.Request) (model.Response, error) {
		once.Do(func() { close(entered) })
		<-release
		return finalReply("迟到"), nil
	}, func(d *Deps) { d.AgentLimits.ModelTimeoutSeconds = 1; d.AgentLimits.CancelGraceSeconds = 1 })
	defer close(release)
	run := submitAgentTest(t, m, s, "unresponsive-model", "模型不协作验收")
	<-entered
	got := runtimeFinished(t, m, run.ID)
	if got.Status != StateInterrupted || got.EndReason != "operation-unresponsive" || m.Info().Agent.Available {
		t.Fatalf("未停止模型释放了执行槽：%+v %+v", got, m.Info())
	}
	m.mu.Lock()
	active := m.activeID
	m.mu.Unlock()
	if active != run.ID {
		t.Fatal("未确认模型停止却清空activeID")
	}
}

func TestAgentTooSmallContextDoesNotSilentlyDropUncoveredHistory(t *testing.T) {
	var inference atomic.Int32
	m, s, _ := agentManager(t, func(_ context.Context, _ model.Profile, r model.Request) (model.Response, error) {
		if r.ToolChoice == "store_working_memory" {
			return model.Response{}, errors.New("整理服务暂不可用")
		}
		inference.Add(1)
		return finalReply(strings.Repeat("uncovered-evidence", 700)), nil
	}, nil)
	first := submitAgentTest(t, m, s, "too-small-first", "保留全部事实")
	if got := runtimeFinished(t, m, first.ID); got.Status != StateSucceeded || got.MemoryStatus != "stale" {
		t.Fatal(got)
	}
	old, _ := m.deps.Profiles.Resolve(s.ModelProfileID, 1, true)
	p, err := m.UpdateModelProfile(old.ID, 1, model.Input{Provider: model.ProviderOpenAICompatible, APIFormat: model.FormatChatCompletions, Name: old.Name, BaseURL: old.BaseURL, Model: old.Model, ContextTokens: 5000, OutputTokens: 256, Capabilities: old.Capabilities, Active: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = m.SwitchSessionModel(context.Background(), s.ID, SwitchModelInput{ModelProfileID: p.ID, ModelRevision: p.Revision}); err != nil {
		t.Fatal(err)
	}
	second, _, err := m.ContinueTask(context.Background(), first.TaskID, AgentInput{RequestID: "too-small-next", Content: "继续"})
	if err != nil {
		t.Fatal(err)
	}
	got := runtimeFinished(t, m, second.ID)
	if got.Status != StateFailed || inference.Load() != 1 {
		t.Fatalf("容量不足却缺失事实继续推理：%+v count=%d", got, inference.Load())
	}
	memory, _ := m.Memory(context.Background(), first.TaskID, 0)
	if memory.Revision != 0 {
		t.Fatal("失败整理错误覆盖历史")
	}
}

func TestAgentKnownUsageBecomesUnknownAfterUnresponsiveRequest(t *testing.T) {
	release := make(chan struct{})
	var requests atomic.Int32
	m, s, _ := agentManager(t, func(_ context.Context, _ model.Profile, _ model.Request) (model.Response, error) {
		if requests.Add(1) == 1 {
			r := toolReply("docker_images_list")
			known, cache := 120, 20
			r.Usage.TotalTokens = &known
			r.Usage.CachedTokens = &cache
			return r, nil
		}
		<-release
		return finalReply("迟到"), nil
	}, func(d *Deps) { d.AgentLimits.ModelTimeoutSeconds = 1; d.AgentLimits.CancelGraceSeconds = 1 })
	defer close(release)
	run := submitAgentTest(t, m, s, "usage-interrupted", "模型中断用量")
	got := runtimeFinished(t, m, run.ID)
	if got.Status != StateInterrupted || got.Usage.ActualTokens != nil || got.Usage.CachedTokens != nil {
		t.Fatalf("部分用量被当成整轮总量：%+v", got)
	}
}

func TestAgentLongGoalDoesNotConsumeMutableMemoryLimit(t *testing.T) {
	m, s, _ := agentManager(t, func(_ context.Context, _ model.Profile, r model.Request) (model.Response, error) {
		if r.ToolChoice == "store_working_memory" {
			return memoryReply(r), nil
		}
		return finalReply("目标已分析"), nil
	}, nil)
	goal := strings.Repeat("g", 24000)
	run := submitAgentTest(t, m, s, "long-goal", goal)
	got := runtimeFinished(t, m, run.ID)
	if got.Status != StateSucceeded || got.MemoryStatus != "updated" {
		t.Fatalf("合法长目标无法生成短记忆：%+v", got)
	}
	memory, _ := m.Memory(context.Background(), run.TaskID, 0)
	if memory.Objective != goal || memory.Revision != 1 {
		t.Fatal("记忆读取未从任务还原原始目标")
	}
	m.mu.Lock()
	var stored string
	err := m.store.db.QueryRow("SELECT document FROM working_memories WHERE task_id=?", run.TaskID).Scan(&stored)
	m.mu.Unlock()
	if err != nil || len(stored) > got.Limits.MemoryBytes || strings.Contains(stored, goal) {
		t.Fatalf("目标重复存入有限记忆快照：bytes=%d err=%v", len(stored), err)
	}
}

func TestAgentChatCompletionsWireLoop(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" || r.Header.Get("Authorization") != "Bearer dedicated-wire-test" {
			t.Error("模型路径或父侧凭据错误")
			w.WriteHeader(400)
			return
		}
		var input struct {
			Messages   []model.Message   `json:"messages"`
			Tools      []json.RawMessage `json:"tools"`
			ToolChoice json.RawMessage   `json:"tool_choice"`
			Stream     bool              `json:"stream"`
		}
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil || input.Stream {
			t.Error("非流式请求格式错误")
			w.WriteHeader(400)
			return
		}
		index := requests.Add(1)
		message := map[string]any{"role": "assistant"}
		reason := "stop"
		switch index {
		case 1:
			if len(input.Tools) != 4 {
				t.Error("域工具白名单错误")
			}
			message["content"] = nil
			message["tool_calls"] = []any{map[string]any{"id": "vendor:call/with.punctuation", "type": "function", "function": map[string]any{"name": "docker_images_list", "arguments": "{}"}}}
			reason = "tool_calls"
		case 2:
			if len(input.Messages) == 0 || input.Messages[len(input.Messages)-1].Role != "tool" || input.Messages[len(input.Messages)-1].ToolCallID == "" {
				t.Error("工具提议与结果未完整重建")
			}
			message["content"] = "HTTP 模型闭环完成"
			message["reasoning_content"] = "不得保存的供应商私有推理"
		case 3:
			if len(input.Tools) != 1 || !strings.Contains(string(input.ToolChoice), "store_working_memory") {
				t.Error("记忆整理错误开放域工具")
			}
			reply := memoryReply(model.Request{Messages: input.Messages})
			message["content"] = nil
			message["tool_calls"] = []any{map[string]any{"id": "memory", "type": "function", "function": map[string]any{"name": "store_working_memory", "arguments": string(reply.ToolCalls[0].Arguments)}}}
			reason = "tool_calls"
		default:
			t.Error("发生自动重试或多余模型请求")
			w.WriteHeader(500)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"index": 0, "message": message, "finish_reason": reason}}, "usage": map[string]any{"prompt_tokens": 15, "completion_tokens": 5, "total_tokens": 20, "prompt_tokens_details": map[string]any{"cached_tokens": 5}}})
	}))
	defer server.Close()
	m, _, _ := agentManager(t, nil, func(d *Deps) { d.ModelClient = model.NewClient(server.Client()) })
	secret := "dedicated-wire-test"
	profile, err := m.CreateModelProfile(model.Input{Provider: model.ProviderOpenAICompatible, APIFormat: model.FormatChatCompletions, Name: "专用 HTTP 验收模型", BaseURL: server.URL + "/v1", Model: "wire", ContextTokens: 65536, OutputTokens: 4096, Capabilities: model.Capabilities{Text: true, Tools: true, Source: "test"}, Active: true, Credential: &secret})
	if err != nil {
		t.Fatal(err)
	}
	session, err := m.CreateSession(context.Background(), CreateSessionInput{ModelProfileID: profile.ID, ModelRevision: profile.Revision})
	if err != nil {
		t.Fatal(err)
	}
	run := submitAgentTest(t, m, session, "wire-loop", "读取镜像后给出结论")
	got := runtimeFinished(t, m, run.ID)
	if got.Status != StateSucceeded || got.MemoryStatus != "updated" || requests.Load() != 3 || got.Usage.ActualTokens == nil || *got.Usage.ActualTokens != 60 || got.Usage.CachedTokens == nil || *got.Usage.CachedTokens != 15 {
		t.Fatalf("HTTP 模型闭环失败：%+v requests=%d", got, requests.Load())
	}
	records, _ := m.ModelRequests(context.Background(), run.ID, "", 50)
	raw, _ := json.Marshal(records)
	if strings.Contains(string(raw), "供应商私有推理") || strings.Contains(string(raw), secret) {
		t.Fatal("私有字段或凭据进入公开模型记录")
	}
}

func TestAgentContinuationClosesInterruptedToolGroupWithoutReplay(t *testing.T) {
	var models, spawns atomic.Int32
	var recovered string
	m, s, invoker := agentManager(t, func(_ context.Context, _ model.Profile, r model.Request) (model.Response, error) {
		if r.ToolChoice == "store_working_memory" {
			return memoryReply(r), nil
		}
		if models.Add(1) == 1 {
			return toolReply("docker_images_list", "docker_policy_view"), nil
		}
		b, _ := json.Marshal(r.Messages)
		recovered = string(b)
		return finalReply("保留已确认结果，未执行结果未知"), nil
	}, func(d *Deps) {
		d.Spawn = func(context.Context) (worker.Process, error) {
			p := &agentTestProcess{}
			if spawns.Add(1) == 1 {
				p.runAgent = func(ctx context.Context, _ string, b worker.AgentBroker) error {
					response, err := b.NextModel(ctx)
					if err != nil {
						return err
					}
					call := response.ToolCalls[0]
					if err = b.ExecuteAgent(ctx, response.ID, 0, call.ID, call.Name, call.Args); err != nil {
						return err
					}
					return &worker.InterruptedError{Err: errors.New("测试 Worker 中断")}
				}
			}
			return p, nil
		}
	})
	first := submitAgentTest(t, m, s, "group-interrupted", "两个工具串行读取")
	if got := runtimeFinished(t, m, first.ID); got.Status != StateInterrupted {
		t.Fatalf("Worker 中断未落状态：%+v", got)
	}
	runtimeEventually(t, func() bool { return m.Info().Agent.Available })
	second, _, err := m.ContinueTask(context.Background(), first.TaskID, AgentInput{RequestID: "group-continue", Content: "继续解释已确认结果"})
	if err != nil {
		t.Fatal(err)
	}
	got := runtimeFinished(t, m, second.ID)
	if got.Status != StateSucceeded || invoker.count.Load() != 1 || !strings.Contains(recovered, "outcome-unknown") || !strings.Contains(recovered, "worker-lost") {
		t.Fatalf("恢复未闭合工具组错误：%+v tools=%d context=%s", got, invoker.count.Load(), recovered)
	}
}
