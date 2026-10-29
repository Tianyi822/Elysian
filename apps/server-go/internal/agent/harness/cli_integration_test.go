package harness

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"

	"elysian/server/internal/agent/harness/model"
	"elysian/server/internal/agent/harness/toolbridge"
	"elysian/server/internal/agent/harness/worker"
	"elysian/server/internal/agent/tools"
	filetools "elysian/server/internal/agent/tools/files"
	cliclient "elysian/server/internal/cli/client"
	"elysian/server/internal/files"
	"elysian/server/internal/security"
)

// 真实 Harness、SQLite/JSONL、HTTP 路由和 worker 子进程；替身只提供受控模型响应。
func TestCLIAndWebHTTPShareImagesEditsHistoryAndCancellation(t *testing.T) {
	ctx := context.Background()
	bridge, extensions, _ := cliFileIntegrationTools(t)
	var sawImage atomic.Bool
	var block atomic.Bool
	var ask atomic.Bool
	m, s, _ := agentManager(t, func(ctx context.Context, _ model.Profile, request model.Request) (model.Response, error) {
		if request.ToolChoice == "store_working_memory" {
			return usageReply(memoryReply(request), 20, 10), nil
		}
		if block.Load() {
			<-ctx.Done()
			return model.Response{}, ctx.Err()
		}
		if ask.CompareAndSwap(true, false) {
			return userInputReply(questionFixture), nil
		}
		for _, message := range request.Messages {
			if len(message.Images) > 0 {
				sawImage.Store(true)
			}
		}
		response := usageReply(finalReply("实际内核公开答复"), 100, 20)
		response.Reasoning = "历史完整思考"
		zero := 0
		response.Usage.CachedTokens = &zero
		return response, nil
	}, func(d *Deps) {
		d.Tools, d.Catalog = bridge, extensions
		d.Spawn = func(ctx context.Context) (worker.Process, error) {
			return worker.Spawn(ctx, worker.Options{Path: os.Args[0], Args: []string{"-test.run=^TestRuntimeWorkerHelper$"}, Env: []string{"HOME=/tmp", "ELYSIAN_RUNTIME_TEST_CHILD=1"}})
		}
	})
	server := httptest.NewServer(http.StripPrefix("/api/agent", m.Router()))
	defer server.Close()
	cli := cliclient.New(server.URL)
	// 使用 Web 的 JSON/HTTP 契约改名，再由 CLI 回读同一会话。
	body := strings.NewReader(`{"title":"Web 与 CLI 共用"}`)
	req, _ := http.NewRequest("PUT", server.URL+"/api/agent/sessions/"+s.ID+"/title", body)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", server.URL)
	resp, err := server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatal(resp.StatusCode)
	}
	session, err := cli.GetSession(ctx, s.ID)
	if err != nil || session.Title != "Web 与 CLI 共用" {
		t.Fatalf("会话互读失败：%+v %v", session, err)
	}
	secret := "controlled-provider"
	profile, err := m.deps.Profiles.Create(model.Input{Provider: model.ProviderOpenAICompatible, APIFormat: model.FormatChatCompletions, BaseURL: "http://127.0.0.1:9/v1", Model: "image-model", ContextTokens: 65536, OutputTokens: 4096, Capabilities: model.Capabilities{Text: true, Tools: true, Image: true, Source: "manual"}, Active: true, Credential: &secret})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = cli.SwitchSessionModel(ctx, s.ID, cliclient.SwitchModelInput{ModelProfileID: profile.ID, ModelRevision: profile.Revision}); err != nil {
		t.Fatal(err)
	}
	raw := testPNGBytes(t, 2, 3)
	image, err := cli.UploadImage(ctx, "测试.png", raw)
	if err != nil {
		t.Fatal(err)
	}
	first, err := cli.CreateTask(ctx, s.ID, cliclient.AgentInput{RequestID: "cli-image-first", Content: "查看图片", Attachments: []cliclient.AttachmentRef{{ID: image.ID}}, AuthorizationMode: "on-demand", ExtensionMode: "enabled"})
	if err != nil {
		t.Fatal(err)
	}
	finished := runtimeFinished(t, m, first.ID)
	if finished.Status != StateSucceeded || !sawImage.Load() {
		t.Fatalf("图片未到实际内核：%+v", finished)
	}
	found, err := cli.ListRuns(ctx, s.ID, "cli-image-first", "")
	if err != nil || len(found.Items) != 1 || found.Items[0].ID != first.ID {
		t.Fatalf("精确 pending 回读失败：%+v %v", found, err)
	}
	messages, err := cli.ListMessages(ctx, s.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	var user cliclient.Message
	for _, msg := range messages.Items {
		if msg.Role == "user" {
			user = msg
		}
	}
	if len(user.Attachments) != 1 {
		t.Fatal("公开消息未带图片引用")
	}
	exported, err := cli.AttachmentContent(ctx, image.ID)
	if err != nil || !bytes.Equal(raw, exported) {
		t.Fatal("已发送图片无法导出")
	}
	edited, err := cli.ContinueTask(ctx, first.TaskID, cliclient.AgentInput{RequestID: "cli-edit", Content: "编辑后的图片问题", ReplaceMessageID: user.ID, Attachments: []cliclient.AttachmentRef{{ID: image.ID}}, AuthorizationMode: "on-demand", ExtensionMode: "enabled"})
	if err != nil {
		t.Fatal(err)
	}
	if done := runtimeFinished(t, m, edited.ID); done.Status != StateSucceeded {
		t.Fatalf("编辑失败：%+v", done)
	}
	response, err := server.Client().Get(server.URL + "/api/agent/sessions/" + s.ID + "/messages")
	if err != nil {
		t.Fatal(err)
	}
	var public cliclient.Page[cliclient.Message]
	err = json.NewDecoder(response.Body).Decode(&public)
	_ = response.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	for _, msg := range public.Items {
		if msg.ID == user.ID {
			t.Fatal("被替换轮次重新混入 Web 公开历史")
		}
	}
	requests, err := cli.ModelRequests(ctx, first.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	foundReasoning := false
	for _, request := range requests.Items {
		if request.Response != nil && request.Response.Reasoning == "历史完整思考" {
			foundReasoning = true
		}
	}
	if !foundReasoning {
		t.Fatal("旧 Run 完整思考无法回读")
	}
	timeline, err := cli.TimelineSnapshot(ctx, edited.ID)
	if err != nil || timeline.Usage == nil || timeline.Usage.ActualTokens == nil {
		t.Fatalf("实际用量未返回：%+v %v", timeline, err)
	}
	block.Store(true)
	running, err := cli.ContinueTask(ctx, first.TaskID, cliclient.AgentInput{RequestID: "cli-cancel", Content: "等待并取消"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = cli.CancelRun(ctx, running.ID); err != nil {
		t.Fatal(err)
	}
	if done := runtimeFinished(t, m, running.ID); done.Status != StateCancelled {
		t.Fatalf("取消未收敛：%+v", done)
	}
	runtimeEventually(t, func() bool { return m.Info().Agent.Available })
	block.Store(false)
	ask.Store(true)
	waiting, err := cli.ContinueTask(ctx, first.TaskID, cliclient.AgentInput{RequestID: "cli-input", Content: "请确认范围"})
	if err != nil {
		t.Fatal(err)
	}
	question := waitUserInput(t, m, waiting.ID)
	receipt, err := cli.AnswerUserInput(ctx, waiting.ID, question.ID, cliclient.AnswerUserInputInput{RequestID: "cli-answer", Answers: map[string]cliclient.UserInputAnswer{"scope": {OptionID: "panel"}, "period": {Text: "最近一次采样"}}})
	if err != nil || receipt.UserInput.Status != "answered" || receipt.Run.ID != waiting.ID {
		t.Fatalf("澄清回答未续接原 Run：%+v %v", receipt, err)
	}
	if done := runtimeFinished(t, m, waiting.ID); done.Status != StateSucceeded {
		t.Fatalf("澄清未完成：%+v", done)
	}
}

// 文件门面、能力目录和授权检查沿用生产实现，只写容器内的隔离业务目录。
func cliFileIntegrationTools(t *testing.T) (*toolbridge.Bridge, *Extensions, string) {
	t.Helper()
	if runtime.GOOS != "linux" || os.Geteuid() != 0 {
		t.Skip("真实文件授权验收要求 Linux root 测试容器")
	}
	mount, err := os.MkdirTemp("/var/lib", "ely-cli-integration-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(mount) })
	root := filepath.Join(mount, "business")
	if err = os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	facade, err := files.NewAgentFacade(files.Deps{Available: true, Accounts: security.NewSystemAccounts()}, files.AgentOptions{
		Authorize: func(ctx context.Context) error { return tools.ConsumeBackend(ctx, tools.DispatchID(ctx)) },
		ResolveRoot: func(ctx context.Context, _ string, _ bool) (files.AgentRootAuthorization, error) {
			op, ok := tools.Payload(ctx).(Operation)
			if !ok || op.FileRoot == nil || op.Authorization == nil {
				return files.AgentRootAuthorization{}, errors.New("缺少文件派发授权")
			}
			identity := op.FileRoot
			return files.AgentRootAuthorization{Path: identity.Path, Writable: identity.Writable, Device: identity.Device, Inode: identity.Inode}, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	bridge, err := toolbridge.NewWithPlugins(nil, filetools.Plugin(filetools.Deps{Facade: facade}, filetools.Config{}))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := bridge.Close(context.Background()); err != nil {
			t.Error(err)
		}
	})
	extensions := &Extensions{MountRoot: mount, InspectFileRoot: func(_ context.Context, path string, write bool) (FileRootIdentity, error) {
		identity, err := files.InspectAgentRoot(files.AgentRoot{Path: path, Writable: write})
		return FileRootIdentity{Path: identity.Path, Writable: identity.Writable, Device: identity.Device, Inode: identity.Inode}, err
	}}
	return bridge, extensions, root
}

func TestCLIApprovalDispatchesRealFileToolWithoutSessionAuthorization(t *testing.T) {
	for _, mode := range []string{"ask", "assist", "full"} {
		t.Run(mode, func(t *testing.T) {
			ctx := context.Background()
			bridge, extensions, root := cliFileIntegrationTools(t)
			var count atomic.Int32
			m, s, _ := agentManager(t, func(_ context.Context, _ model.Profile, r model.Request) (model.Response, error) {
				if r.ToolChoice == "store_working_memory" {
					return memoryReply(r), nil
				}
				if missingOperationTools(r, "file_write") {
					return searchReply("file_write"), nil
				}
				if count.Add(1) == 1 {
					args, _ := json.Marshal(map[string]string{"root": root, "path": "approved.txt", "content": "只在明确批准后写入", "expected": "missing"})
					return model.Response{FinishReason: "tool_calls", ToolCalls: []model.ToolCall{{ID: "write", Name: "file_write", Arguments: args}}}, nil
				}
				return finalReply("文件已写入"), nil
			}, func(d *Deps) {
				d.Tools, d.Catalog = bridge, extensions
				d.Spawn = func(ctx context.Context) (worker.Process, error) {
					return worker.Spawn(ctx, worker.Options{Path: os.Args[0], Args: []string{"-test.run=^TestRuntimeWorkerHelper$"}, Env: []string{"HOME=/tmp", "ELYSIAN_RUNTIME_TEST_CHILD=1"}})
				}
			})
			server := httptest.NewServer(http.StripPrefix("/api/agent", m.Router()))
			defer server.Close()
			cli := cliclient.New(server.URL)
			run, err := cli.CreateTask(ctx, s.ID, cliclient.AgentInput{RequestID: "cli-real-approval", Content: "写入隔离测试文件", AuthorizationMode: "on-demand", ExtensionMode: "enabled", PermissionMode: mode})
			if err != nil {
				t.Fatal(err)
			}
			if mode != "full" {
				approval := waitingApproval(t, m, run.ID)
				if _, err = os.Stat(filepath.Join(root, "approved.txt")); !os.IsNotExist(err) {
					t.Fatal("批准前已执行写操作")
				}
				approvals, err := cli.ListApprovalsByRun(ctx, run.ID)
				if err != nil || len(approvals) != 1 || approvals[0].Access == nil {
					t.Fatalf("CLI 未读到授权卡：%+v %v", approvals, err)
				}
				a := approvals[0]
				_, err = cli.DecideAccess(ctx, approval.ID, cliclient.AccessDecisionInput{RequestID: "cli-allow-file", ExpectedRevision: a.Access.Revision, ExpectedDigest: a.Access.Digest, Decision: "once"})
				if err != nil {
					t.Fatal(err)
				}
			} else {
				if done := runtimeFinished(t, m, run.ID); done.Status != StateSucceeded {
					t.Fatalf("完全开放未执行: %+v", done)
				}
				approvals, err := cli.ListApprovalsByRun(ctx, run.ID)
				if err != nil || len(approvals) != 0 {
					t.Fatalf("完全开放仍询问: %+v %v", approvals, err)
				}
			}
			if done := runtimeFinished(t, m, run.ID); done.Status != StateSucceeded {
				t.Fatalf("真实工具未完成：%+v", done)
			}
			raw, err := os.ReadFile(filepath.Join(root, "approved.txt"))
			if err != nil || string(raw) != "只在明确批准后写入" {
				t.Fatalf("真实文件结果错误：%q %v", raw, err)
			}
			if rows, err := m.SessionAuthorizations(ctx, s.ID); err != nil || len(rows) != 0 {
				t.Fatalf("逐次审批不应创建会话授权: %+v %v", rows, err)
			}
			calls, err := cli.ListCalls(ctx, run.ID, "")
			if err != nil {
				t.Fatal(err)
			}
			found := false
			for _, call := range calls.Items {
				if call.Tool == "file_write" && call.Status == "succeeded" {
					found = true
				}
			}
			if !found {
				t.Fatalf("工具回执不可回读：%+v", calls)
			}
		})
	}
}
