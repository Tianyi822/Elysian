package harness

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"

	"elysian/server/internal/agent/harness/model"
	"elysian/server/internal/agent/harness/toolbridge"
	"elysian/server/internal/agent/kardia"
	"elysian/server/internal/agent/tools"
	databasetools "elysian/server/internal/agent/tools/database"
	domaindatabase "elysian/server/internal/database"
	"elysian/server/internal/seam"
)

type unusedDatabaseTransport struct{}

func (unusedDatabaseTransport) Request(context.Context, seam.EngineRequest) (seam.EngineResponse, error) {
	return seam.EngineResponse{}, errors.New("不应请求真实引擎")
}
func (unusedDatabaseTransport) Stream(context.Context, seam.EngineRequest, func([]byte)) (seam.EngineResponse, error) {
	return seam.EngineResponse{}, errors.New("不应请求真实引擎")
}

func databaseBusinessBridge(t *testing.T) *toolbridge.Bridge {
	t.Helper()
	views := &dockerCatalogViews{}
	facade := domaindatabase.NewAgentFacade(domaindatabase.Deps{EngineAvailable: true, Engine: unusedDatabaseTransport{}, Views: views,
		AgentAuthorize: func(ctx context.Context) error { return tools.ConsumeBackend(ctx, tools.DispatchID(ctx)) }})
	bridge, err := toolbridge.NewWithPlugins(views, databasetools.Plugin(databasetools.Deps{Facade: facade}, databasetools.Config{}))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = bridge.Close(context.Background()) })
	return bridge
}

func TestNativeDatabaseBusinessErrorContinuesSameBatchAndPersists(t *testing.T) {
	bridge := databaseBusinessBridge(t)
	var step atomic.Int32
	m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, request model.Request) (model.Response, error) {
		if request.ToolChoice == "store_working_memory" {
			return memoryReply(request), nil
		}
		switch step.Add(1) {
		case 1:
			return searchReply("database_discover"), nil
		case 2:
			reply := toolReply("database_discover", toolSearchName)
			reply.ToolCalls[0].Arguments = json.RawMessage(`{"engine":"MySQL","versionTag":"latest"}`)
			reply.ToolCalls[1].Arguments = json.RawMessage(`{"query":"docker_images_list"}`)
			return reply, nil
		case 3:
			text := allRequestText(request)
			if !strings.Contains(text, "database-version-invalid") || !strings.Contains(text, "latest") || !strings.Contains(text, "docker_images_list") {
				t.Errorf("错误和同批搜索未返回模型：%s", text)
			}
			return toolReply("docker_images_list"), nil
		default:
			if !strings.Contains(allRequestText(request), "local-nginx") {
				t.Error("纠正后的本地镜像查询未完成")
			}
			return finalReply("已检查本地镜像，请使用数据库镜像的明确版本"), nil
		}
	}, func(d *Deps) { d.Tools, d.Catalog = bridge, &Extensions{} })
	run, _, err := m.CreateTask(context.Background(), session.ID, AgentInput{RequestID: "native-database-business", Content: "检查数据库镜像", ExtensionMode: "enabled", AuthorizationMode: AuthorizationOnDemand})
	if err != nil {
		t.Fatal(err)
	}
	finished := runtimeFinished(t, m, run.ID)
	if finished.Status != StateSucceeded {
		t.Fatalf("业务错误中断了整轮：%s %+v", finished.Status, finished.Error)
	}
	calls, err := m.Calls(context.Background(), run.ID, "", 50)
	if err != nil || len(calls.Items) != 4 {
		t.Fatalf("调用记录不完整：%+v %v", calls, err)
	}
	if calls.Items[1].Tool != "database_discover" || calls.Items[1].Status != StateFailed || calls.Items[1].Error == nil || calls.Items[1].Error.Code != "database-version-invalid" || calls.Items[2].Tool != toolSearchName || calls.Items[2].Status != StateSucceeded || calls.Items[3].Status != StateSucceeded {
		t.Fatalf("同批续接记录不符：%+v", calls.Items)
	}
	lines, raw := readRecordLines(t, m.store, recordOwner{"session", session.ID})
	var copied *Call
	for _, line := range lines {
		if line.Type == "calls" && line.Key == calls.Items[1].ID {
			var call Call
			if json.Unmarshal(line.Document, &call) == nil {
				copied = &call
			}
		}
	}
	if copied == nil || !reflect.DeepEqual(*copied, calls.Items[1]) || strings.Contains(string(raw), "不应请求真实引擎") {
		t.Fatalf("SQLite 与 JSONL 业务错误不一致或泄露内部信息：%+v", copied)
	}
	var responseID string
	for _, line := range lines {
		if line.Type != "runs" {
			continue
		}
		var stored Run
		if json.Unmarshal(line.Document, &stored) == nil && stored.Resume != nil && stored.Resume.ResponseID == calls.Items[1].ModelRequestID && stored.Resume.CallIndex == 2 {
			responseID = stored.Resume.ResponseID
		}
	}
	if responseID == "" {
		t.Fatal("同批工具完成后的恢复游标未持久化")
	}
}

func TestNativeBusinessErrorsDoNotHideExecutionFailures(t *testing.T) {
	business := &tools.BusinessError{Code: "controlled-error", Message: "固定公开错误"}
	for _, failure := range []error{errors.New("SECRET_INTERNAL"), context.Canceled, context.DeadlineExceeded,
		errors.Join(business, errors.New("清理失败")), errors.Join(business, &tools.DeniedError{Name: "docker_images_list", Reason: "拒绝"})} {
		t.Run(failure.Error(), func(t *testing.T) {
			plugin := &kardia.Plugin{Name: "native-error-test", Inject: kardia.InjectMap{tools.ServiceName: nil}, Apply: func(c *kardia.Context, _ any) (kardia.Disposable, error) {
				return nil, tools.RegisterAll(c, tools.Descriptor{Name: "docker_images_list", Description: "读取镜像", Parameters: tools.Schema{Type: tools.SchemaObject},
					Metadata: tools.Metadata{Domain: "docker", Backend: "domain", Action: "list", Exposure: "agent", Effect: "read", ReadOnly: true, Default: true},
					Handler: func(c *kardia.Context, _ tools.Arguments) (any, error) {
						if err := tools.ConsumeBackend(tools.Lifetime(c), tools.DispatchID(tools.Lifetime(c))); err != nil {
							return nil, err
						}
						return nil, failure
					}})
			}}
			bridge, err := toolbridge.NewWithPlugins(nil, plugin)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = bridge.Close(context.Background()) })
			var requests atomic.Int32
			m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, request model.Request) (model.Response, error) {
				if request.ToolChoice == "store_working_memory" {
					return memoryReply(request), nil
				}
				requests.Add(1)
				return toolReply("docker_images_list"), nil
			}, func(d *Deps) { d.Tools = bridge })
			run := submitAgentTest(t, m, session, "native-fatal", "读取镜像")
			finished := runtimeFinished(t, m, run.ID)
			if finished.Status != StateFailed || requests.Load() != 1 {
				t.Fatalf("非业务错误仍继续执行：%s requests=%d", finished.Status, requests.Load())
			}
		})
	}
}
