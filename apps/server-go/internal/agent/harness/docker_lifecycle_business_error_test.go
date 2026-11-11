package harness

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"

	"elysian/server/internal/agent/harness/model"
	domaindocker "elysian/server/internal/docker"
	"elysian/server/internal/seam"
)

type dockerLifecycleFailureBridge struct {
	seam.AgentDatabaseContainers
	t       *testing.T
	action  string
	failure *seam.AgentContainerError
	calls   atomic.Int32
}

func (b *dockerLifecycleFailureBridge) Lifecycle(_ context.Context, id, action string) (bool, error) {
	b.calls.Add(1)
	if id != strings.Repeat("c", 64) || action != b.action {
		b.t.Errorf("database lifecycle target changed: id=%s action=%s", id, action)
	}
	return true, b.failure
}

func TestDockerLifecycleDomainPrecheckContinuesAndExecutionFailureStops(t *testing.T) {
	for _, tool := range []struct{ name, action, arguments string }{
		{"docker_container_power", "stop", `{"id":"` + strings.Repeat("c", 64) + `","action":"stop"}`},
		{"docker_container_remove", "remove", `{"id":"` + strings.Repeat("c", 64) + `"}`},
	} {
		for _, preflight := range []bool{true, false} {
			name := "execution-failure"
			failure := &seam.AgentContainerError{Code: "database-container-operation-failed", Message: "数据库持久卷身份核对失败"}
			wantState, wantRequests := StateFailed, int32(2)
			if preflight {
				name = "preflight-rejected"
				failure.Message = "仅允许操作面板受管数据库容器，数据库变更未执行"
				failure.NotDispatched = true
				wantState, wantRequests = StateSucceeded, 3
			}
			t.Run(tool.name+"/"+name, func(t *testing.T) {
				domain := &dockerLifecycleFailureBridge{t: t, action: tool.action, failure: failure}
				bridge, _ := dockerCatalogBridge(t, func(agent *domaindocker.AgentFacade) { agent.SetDatabaseContainers(domain) })
				var requests atomic.Int32
				m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, request model.Request) (model.Response, error) {
					if request.ToolChoice == "store_working_memory" {
						return memoryReply(request), nil
					}
					switch requests.Add(1) {
					case 1:
						return searchReply(tool.name), nil
					case 2:
						reply := toolReply(tool.name)
						reply.ToolCalls[0].Arguments = json.RawMessage(tool.arguments)
						return reply, nil
					default:
						text := allRequestText(request)
						if !strings.Contains(text, failure.Code) || !strings.Contains(text, failure.Message) {
							t.Errorf("domain refusal did not reach the model: %s", text)
						}
						return finalReply("已确认未派发，请重新选择受管容器"), nil
					}
				}, func(d *Deps) { d.Tools, d.Catalog = bridge, &Extensions{MountRoot: "/srv"} })
				ctx := context.Background()
				run, _, err := m.CreateTask(ctx, session.ID, AgentInput{RequestID: "docker-lifecycle-" + name, Content: "操作数据库容器", AuthorizationMode: AuthorizationOnDemand, PermissionMode: PermissionFull})
				if err != nil {
					t.Fatal(err)
				}
				finished := runtimeFinished(t, m, run.ID)
				if finished.Status != wantState || requests.Load() != wantRequests || domain.calls.Load() != 1 {
					t.Fatalf("unexpected lifecycle recovery: run=%+v requests=%d domainCalls=%d", finished, requests.Load(), domain.calls.Load())
				}
				if !preflight && (finished.EndReason != failure.Code || finished.Error == nil || finished.Error.Message != failure.Message) {
					t.Fatalf("execution failure lost its public reason: %+v", finished)
				}
				calls, err := m.Calls(ctx, run.ID, "", 50)
				if err != nil || len(calls.Items) != 2 {
					t.Fatalf("missing search or lifecycle receipt: %+v %v", calls, err)
				}
				call := calls.Items[1]
				if call.Tool != tool.name || call.Status != StateFailed || call.Error == nil || call.Error.Code != failure.Code || call.Error.Message != failure.Message {
					t.Fatalf("domain failure was not preserved: %+v", call)
				}
				lines, _ := readRecordLines(t, m.store, recordOwner{"session", session.ID})
				var copied *Call
				for _, line := range lines {
					if line.Type == "calls" && line.Key == call.ID {
						var persisted Call
						if json.Unmarshal(line.Document, &persisted) == nil {
							copied = &persisted
						}
					}
				}
				if copied == nil || !reflect.DeepEqual(*copied, call) {
					t.Fatalf("SQLite and JSONL lifecycle receipts differ: %+v", copied)
				}
			})
		}
	}
}
