package harness

import (
	"context"
	"database/sql"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"elysian/server/internal/agent/harness/model"
)

func sessionAPIManager(t *testing.T) (*Manager, model.Profile) {
	t.Helper()
	s, _ := openRuntimeTestStore(t)
	profiles, err := model.Open(filepath.Join(t.TempDir(), "config", "agent-models.json"))
	if err != nil {
		t.Fatal(err)
	}
	secret := "profile-secret-not-in-response"
	profile, err := profiles.Create(model.Input{Provider: model.ProviderOpenAICompatible, APIFormat: model.FormatChatCompletions, BaseURL: "https://models.invalid/v1", Model: "model-one", ContextTokens: 32000, OutputTokens: 4096, Capabilities: model.Capabilities{Text: true, Tools: true, Source: "manual"}, Active: true, Credential: &secret})
	if err != nil {
		t.Fatal(err)
	}
	m := &Manager{store: s, deps: Deps{Profiles: profiles, AgentLimits: DefaultAgentLimits(), Limits: DefaultLimits(), Now: s.now, NewID: randomID}, workerState: "ready", wake: make(chan struct{}, 1)}
	return m, profile
}

func TestAgentRoutesCreateContinueQueryAndDeduplicate(t *testing.T) {
	m, profile := sessionAPIManager(t)
	handler := m.Router()
	body, _ := json.Marshal(CreateSessionInput{Title: "诊断会话", ModelProfileID: profile.ID, ModelRevision: profile.Revision})
	response := runtimeRouteRequest(handler, "POST", "/sessions", string(body))
	var session Session
	if response.Code != 201 || json.Unmarshal(response.Body.Bytes(), &session) != nil {
		t.Fatalf("创建会话失败：%d %s", response.Code, response.Body.String())
	}
	response = runtimeRouteRequest(handler, "POST", "/sessions/"+session.ID+"/tasks", `{"requestId":"request-first","content":"查看容器状态"}`)
	var first Run
	if response.Code != 202 || json.Unmarshal(response.Body.Bytes(), &first) != nil || first.RunNumber != 1 {
		t.Fatalf("创建任务失败：%d %s", response.Code, response.Body.String())
	}
	repeated := runtimeRouteRequest(handler, "POST", "/sessions/"+session.ID+"/tasks", `{"requestId":"request-first","content":"查看容器状态"}`)
	if repeated.Code != 200 || repeated.Body.String() != response.Body.String() {
		t.Fatalf("重复请求改变了运行：%d %s", repeated.Code, repeated.Body.String())
	}
	for _, request := range []struct{ path, body string }{{"/sessions/" + session.ID + "/tasks", `{"requestId":"request-busy","content":"另一任务"}`}, {"/tasks/" + first.TaskID + "/runs", `{"requestId":"request-busy-two","content":"继续"}`}} {
		result := runtimeRouteRequest(handler, "POST", request.path, request.body)
		if result.Code != 409 {
			t.Fatalf("忙碌会话接受输入：%d %s", result.Code, result.Body.String())
		}
	}
	finishSessionTestRun(t, m.store, first.ID, "容器状态已查询", &WorkingMemory{Revision: 1, Objective: first.Input, Coverage: MemoryCursor{RunNumber: 1, EventSeq: first.LastSeq}})
	response = runtimeRouteRequest(handler, "POST", "/tasks/"+first.TaskID+"/runs", `{"requestId":"request-second","content":"继续检查"}`)
	var second Run
	if response.Code != 202 || json.Unmarshal(response.Body.Bytes(), &second) != nil || second.RunNumber != 2 || second.InitialMemoryRevision != 1 {
		t.Fatalf("续轮失败：%d %s", response.Code, response.Body.String())
	}
	finishSessionTestRun(t, m.store, second.ID, "已完成检查", nil)
	response = runtimeRouteRequest(handler, "GET", "/tasks/"+first.TaskID, "")
	var task Task
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &task) != nil || task.LatestRun == nil || task.LatestRun.ID != second.ID || task.MemoryStatus != "stale" {
		t.Fatalf("任务摘要丢失最新运行：%d %s", response.Code, response.Body.String())
	}
	response = runtimeRouteRequest(handler, "GET", "/sessions/"+session.ID+"/tasks", "")
	var tasks Page[Task]
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &tasks) != nil || len(tasks.Items) != 1 || tasks.Items[0].LatestRun == nil || tasks.Items[0].LatestRun.ID != second.ID {
		t.Fatalf("任务列表缺少最新运行：%d %s", response.Code, response.Body.String())
	}
	response = runtimeRouteRequest(handler, "GET", "/tasks/"+first.TaskID+"/memory", "")
	var memory WorkingMemory
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &memory) != nil || memory.Revision != 1 || memory.MemoryStatus != "stale" {
		t.Fatalf("记忆查询隐去了stale状态：%d %s", response.Code, response.Body.String())
	}
	response = runtimeRouteRequest(handler, "GET", "/runs?sessionId="+session.ID+"&taskId="+first.TaskID, "")
	var runs Page[Run]
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &runs) != nil || len(runs.Items) != 2 {
		t.Fatalf("会话任务运行筛选错误：%d %s", response.Code, response.Body.String())
	}
	response = runtimeRouteRequest(handler, "GET", "/sessions/"+session.ID+"/messages?after=0&limit=2", "")
	var messages Page[Message]
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &messages) != nil || len(messages.Items) != 2 || !messages.HasMore || messages.NextCursor != "2" {
		t.Fatalf("消息分页错误：%d %s", response.Code, response.Body.String())
	}
}

func TestAgentRoutesProfileRevisionsStayPinnedAndSwitchReportsImpact(t *testing.T) {
	m, profile := sessionAPIManager(t)
	handler := m.Router()
	session, err := m.CreateSession(context.Background(), CreateSessionInput{ModelProfileID: profile.ID, ModelRevision: 1})
	if err != nil {
		t.Fatal(err)
	}
	body := `{"expectedRevision":1,"baseUrl":"https://models.invalid/v1","model":"model-two","provider":"openai-compatible","apiFormat":"chat-completions","contextTokens":64000,"outputTokens":2048,"capabilities":{"text":true,"tools":true,"source":"manual"},"active":true}`
	response := runtimeRouteRequest(handler, "PUT", "/model-profiles/"+profile.ID, body)
	var updated model.Profile
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &updated) != nil || updated.Revision != 2 || strings.Contains(response.Body.String(), "profile-secret-not-in-response") {
		t.Fatalf("配置修订或凭据过滤错误：%d %s", response.Code, response.Body.String())
	}
	response = runtimeRouteRequest(handler, "PUT", "/model-profiles/"+profile.ID, body)
	if response.Code != 409 {
		t.Fatalf("旧revision更新没有拒绝：%d", response.Code)
	}
	stored, err := m.GetSession(context.Background(), session.ID)
	if err != nil || stored.ModelRevision != 1 {
		t.Fatalf("编辑配置静默改写Session：%+v %v", stored, err)
	}
	switchBody, _ := json.Marshal(SwitchModelInput{ModelProfileID: profile.ID, ModelRevision: 2})
	response = runtimeRouteRequest(handler, "PUT", "/sessions/"+session.ID+"/model", string(switchBody))
	var switched Session
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &switched) != nil || switched.ModelChange == nil || switched.ModelChange.Before.Revision != 1 || switched.ModelChange.After.Revision != 2 {
		t.Fatalf("模型切换没有版本差异：%d %s", response.Code, response.Body.String())
	}
	for _, notice := range []string{"缓存", "响应速度", "成本"} {
		if !strings.Contains(response.Body.String(), notice) {
			t.Fatalf("切换缺少%s提示：%s", notice, response.Body.String())
		}
	}
	stored, err = m.GetSession(context.Background(), session.ID)
	if err != nil || stored.ModelChange != nil {
		t.Fatalf("瞬态切换提示被持久化：%+v %v", stored, err)
	}
	response = runtimeRouteRequest(handler, "GET", "/model-profiles", "")
	if response.Code != 200 || strings.Contains(response.Body.String(), "profile-secret-not-in-response") {
		t.Fatalf("模型列表泄露凭据：%d %s", response.Code, response.Body.String())
	}
}

func TestAgentRoutesRejectUntrustedFieldsAndUnsupportedModels(t *testing.T) {
	m, profile := sessionAPIManager(t)
	handler := m.Router()
	session, err := m.CreateSession(context.Background(), CreateSessionInput{ModelProfileID: profile.ID, ModelRevision: 1})
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		method, path, body string
		status             int
	}{
		{"POST", "/sessions/" + session.ID + "/tasks", `{"requestId":"bad-role","content":"内容","role":"assistant"}`, 400},
		{"POST", "/sessions/" + session.ID + "/tasks", `{"requestId":"bad-memory","content":"内容","memory":{"summary":"伪造"}}`, 400},
		{"GET", "/sessions/" + session.ID + "/messages?after=99", "", 400},
		{"GET", "/sessions/" + session.ID + "/messages?after=1&after=2", "", 400},
		{"GET", "/sessions?limit=201", "", 400},
		{"GET", "/tasks/unknown/memory?revision=0", "", 400},
		{"POST", "/sessions", `{"modelProfileId":"unknown","modelRevision":1}`, 404},
	} {
		response := runtimeRouteRequest(handler, test.method, test.path, test.body)
		if response.Code != test.status {
			t.Fatalf("请求守卫失败：%s %d %s", test.path, response.Code, response.Body.String())
		}
	}
	routeKey := "route-test-key"
	unsupported, err := m.deps.Profiles.Create(model.Input{Provider: model.ProviderOpenAICompatible, APIFormat: model.FormatChatCompletions, BaseURL: "https://models.invalid/v1", Model: "text-only", ContextTokens: 32000, OutputTokens: 4096, Capabilities: model.Capabilities{Text: true, Tools: false, Source: "manual"}, Active: true, Credential: &routeKey})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = m.CreateSession(context.Background(), CreateSessionInput{ModelProfileID: unsupported.ID, ModelRevision: 1}); err == nil {
		t.Fatal("创建会话接受不支持工具的模型")
	}
	if _, err = m.SwitchSessionModel(context.Background(), session.ID, SwitchModelInput{ModelProfileID: unsupported.ID, ModelRevision: 1}); err == nil {
		t.Fatal("切换接受不支持工具的模型")
	}
	response := runtimeRouteRequest(UnavailableRouter("本地演示不可用"), "POST", "/sessions", `{}`)
	if response.Code != 503 {
		t.Fatalf("演示路由接受会话：%d", response.Code)
	}
}

func TestAgentRoutesMemoryCheckpointDoesNotClaimActiveRunIsFullyCovered(t *testing.T) {
	m, profile := sessionAPIManager(t)
	ctx := context.Background()
	session, err := m.CreateSession(ctx, CreateSessionInput{ModelProfileID: profile.ID, ModelRevision: 1})
	if err != nil {
		t.Fatal(err)
	}
	run, _, err := m.CreateTask(ctx, session.ID, AgentInput{RequestID: "memory-checkpoint", Content: "检查当前容器"})
	if err != nil {
		t.Fatal(err)
	}
	if run.MemoryStatus != "stale" {
		t.Fatalf("新输入未标待整理：%+v", run)
	}
	_, err = m.store.change(ctx, run.ID, "checkpoint", func(tx *sql.Tx, r *Run) error {
		if err := saveWorkingMemory(ctx, tx, WorkingMemory{TaskID: r.TaskID, Revision: 1, Objective: r.Input}); err != nil {
			return err
		}
		r.MemoryStatus = "updated"
		return m.store.event(ctx, tx, r, "memory/updated", "", nil, nil)
	})
	if err != nil {
		t.Fatal(err)
	}
	response := runtimeRouteRequest(m.Router(), "GET", "/tasks/"+run.TaskID+"/memory", "")
	var memory WorkingMemory
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &memory) != nil || memory.Revision != 1 || memory.MemoryStatus != "stale" {
		t.Fatalf("checkpoint被当作整轮已覆盖：%d %s", response.Code, response.Body.String())
	}
	task, err := m.GetTask(ctx, run.TaskID)
	if err != nil || task.MemoryStatus != "stale" || task.LatestRun.MemoryStatus != "stale" {
		t.Fatalf("任务摘要伪装记忆最新：%+v %v", task, err)
	}
}

func TestAgentRoutesPinnedCapableRevisionSurvivesUnsupportedLatestRevision(t *testing.T) {
	m, profile := sessionAPIManager(t)
	ctx := context.Background()
	session, err := m.CreateSession(ctx, CreateSessionInput{ModelProfileID: profile.ID, ModelRevision: 1})
	if err != nil {
		t.Fatal(err)
	}
	input := model.Input{Provider: model.ProviderOpenAICompatible, APIFormat: model.FormatChatCompletions, BaseURL: profile.BaseURL, Model: "text-only", ContextTokens: 32000, OutputTokens: 4096, Capabilities: model.Capabilities{Text: true, Tools: false, Source: "manual"}, Active: true}
	if _, err = m.UpdateModelProfile(profile.ID, 1, input); err != nil {
		t.Fatal(err)
	}
	run, _, err := m.CreateTask(ctx, session.ID, AgentInput{RequestID: "pinned-revision", Content: "使用已选模型检查"})
	if err != nil || run.Model == nil || run.Model.Revision != 1 || !run.Model.Capabilities.Tools {
		t.Fatalf("编辑配置错误阻止了固定旧版Session：%+v %v", run, err)
	}
	finishSessionTestRun(t, m.store, run.ID, "完成检查", nil)
	input.Active = false
	if _, err = m.UpdateModelProfile(profile.ID, 2, input); err != nil {
		t.Fatal(err)
	}
	if _, _, err = m.ContinueTask(ctx, run.TaskID, AgentInput{RequestID: "disabled-profile", Content: "继续"}); err == nil {
		t.Fatal("停用配置没有阻止新运行")
	}
	accepted, err := m.deps.Profiles.Resolve(profile.ID, 1, true)
	if err != nil || !accepted.Capabilities.Tools {
		t.Fatalf("停用丢失了已接受运行需要的旧版：%+v %v", accepted, err)
	}
}

func TestAgentModelServiceRoutesAtomicRevisionsAndCredentialRedaction(t *testing.T) {
	m, _ := sessionAPIManager(t)
	handler := m.Router()
	key := "fake-service-key"
	input := model.ServiceInput{Name: "DeepSeek", Provider: model.ProviderDeepSeek, APIFormat: model.FormatAnthropicMessages, BaseURL: "https://api.deepseek.com/anthropic", Credential: &key, Active: true, Models: []model.ServiceModelInput{
		{Model: "deepseek-flash", ContextTokens: 1000000, OutputTokens: 4096, Capabilities: model.Capabilities{Text: true, Tools: true, Source: "假服务"}, Enabled: true},
		{Model: "deepseek-v4-pro", ContextTokens: 1000000, OutputTokens: 4096, Capabilities: model.Capabilities{Text: true, Tools: true, Source: "假服务"}, Enabled: true},
	}}
	body, _ := json.Marshal(input)
	response := runtimeRouteRequest(handler, "POST", "/model-services", string(body))
	var service model.Service
	if response.Code != 201 || json.Unmarshal(response.Body.Bytes(), &service) != nil || len(service.Models) != 2 || strings.Contains(response.Body.String(), key) {
		t.Fatalf("服务创建或凭据过滤失败：%d %s", response.Code, response.Body.String())
	}
	for i := range input.Models {
		input.Models[i].ID = service.Models[i].ID
	}
	input.Credential = nil
	input.APIFormat = model.FormatResponses
	input.BaseURL = "https://api.deepseek.com"
	update := struct {
		ExpectedRevision int `json:"expectedRevision"`
		model.ServiceInput
	}{1, input}
	body, _ = json.Marshal(update)
	response = runtimeRouteRequest(handler, "PUT", "/model-services/"+service.ID, string(body))
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &service) != nil || service.Revision != 2 || !service.HasCredential || service.Models[0].Revision != 2 || service.Models[0].APIFormat != model.FormatResponses {
		t.Fatalf("服务更新失败：%d %s", response.Code, response.Body.String())
	}
	if repeated := runtimeRouteRequest(handler, "PUT", "/model-services/"+service.ID, string(body)); repeated.Code != 409 {
		t.Fatal("旧服务修订被接收")
	}
	update.ExpectedRevision = 2
	update.Models[1].ContextTokens = 0
	body, _ = json.Marshal(update)
	if invalid := runtimeRouteRequest(handler, "PUT", "/model-services/"+service.ID, string(body)); invalid.Code != 400 {
		t.Fatal("无效组被接收")
	}
	response = runtimeRouteRequest(handler, "GET", "/model-services", "")
	if response.Code != 200 || strings.Contains(response.Body.String(), key) || !strings.Contains(response.Body.String(), `"revision":2`) {
		t.Fatal("服务列表读取或原子保存失败")
	}
	input.APIFormat = "unknown"
	body, _ = json.Marshal(input)
	if invalid := runtimeRouteRequest(handler, "POST", "/model-services", string(body)); invalid.Code != 400 {
		t.Fatal("未知协议被接收")
	}
}
