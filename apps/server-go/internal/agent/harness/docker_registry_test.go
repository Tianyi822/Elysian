package harness

import (
	"context"
	"encoding/json"
	"strings"
	"sync/atomic"
	"testing"

	"elysian/server/internal/agent/harness/model"
	"elysian/server/internal/agent/harness/toolbridge"
	"elysian/server/internal/agent/kardia"
	"elysian/server/internal/agent/tools"
)

func TestNativeDockerSearchFailureCanDiscoverOtherRegistries(t *testing.T) {
	bridge, _ := dockerCatalogBridge(t)
	var step atomic.Int32
	m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, request model.Request) (model.Response, error) {
		if request.ToolChoice == "store_working_memory" {
			return memoryReply(request), nil
		}
		switch step.Add(1) {
		case 1:
			return searchReply("docker_image_search"), nil
		case 2:
			reply := toolReply("docker_image_search")
			reply.ToolCalls[0].Arguments = json.RawMessage(`{"term":"mysql"}`)
			return reply, nil
		case 3:
			if !strings.Contains(allRequestText(request), "docker-registry-query-failed") {
				t.Error("搜索失败未返回模型")
			}
			return searchReply("docker_registry_list"), nil
		case 4:
			return toolReply("docker_registry_list"), nil
		default:
			if !strings.Contains(allRequestText(request), "https://dockerproxy.net") {
				t.Error("预设源未返回模型")
			}
			return finalReply("已找到其他镜像源，可直接查询 MySQL 版本"), nil
		}
	}, func(d *Deps) { d.Tools, d.Catalog = bridge, &Extensions{MountRoot: "/srv"} })
	run, _, err := m.CreateTask(context.Background(), session.ID, AgentInput{RequestID: "docker-registry-recovery", Content: "查询 MySQL 镜像", AuthorizationMode: AuthorizationOnDemand})
	if err != nil {
		t.Fatal(err)
	}
	finished := runtimeFinished(t, m, run.ID)
	if finished.Status != StateSucceeded {
		t.Fatalf("搜索失败中断整轮：%+v", finished.Error)
	}
	calls, err := m.Calls(context.Background(), run.ID, "", 50)
	if err != nil || len(calls.Items) != 4 {
		t.Fatalf("%+v %v", calls, err)
	}
	if calls.Items[1].Status != StateFailed || calls.Items[3].Status != StateSucceeded {
		t.Fatal(calls.Items)
	}
	approvals, _ := m.ApprovalsByRun(context.Background(), "", run.ID)
	if len(approvals) != 0 {
		t.Fatal("只读源发现触发了审批")
	}
	_, raw := readRecordLines(t, m.store, recordOwner{"session", session.ID})
	if strings.Contains(string(raw), "404 page not found") {
		t.Fatal("原始上游响应进入记录")
	}
}

// 状态由模拟域 Inspector 给出，原生运行内核负责审批、等待、失败回执和下一次派发。
func TestDockerConfirmedFailureResumesAndReauthorizesNextRegistry(t *testing.T) {
	for _, mode := range []PermissionMode{PermissionAsk, PermissionAssist, PermissionFull} {
		t.Run(string(mode), func(t *testing.T) {
			var submitted atomic.Int32
			plugin := &kardia.Plugin{Name: "registry-pull-fixture", Inject: kardia.InjectMap{tools.ServiceName: nil}, Apply: func(c *kardia.Context, _ any) (kardia.Disposable, error) {
				return nil, tools.RegisterAll(c, tools.Descriptor{Name: "docker_image_pull", Description: "拉取镜像", Parameters: tools.Schema{Type: tools.SchemaObject, Required: []string{"id", "requestId"}, Properties: map[string]tools.Schema{"id": {Type: tools.SchemaString}, "requestId": {Type: tools.SchemaString}, "registry": {Type: tools.SchemaString}}}, Metadata: tools.Metadata{Domain: "docker", Action: "pull", Effect: "write", Exposure: "agent", ResourceType: "docker-image", ResourceKeyArgument: "id", Async: true, TaskDomain: "docker-image-pull", TaskRequestArgument: "requestId", Version: "2"}, Handler: func(c *kardia.Context, args tools.Arguments) (any, error) {
					ctx := tools.Lifetime(c)
					if err := tools.ConsumeBackend(ctx, tools.DispatchID(ctx)); err != nil {
						return nil, err
					}
					requestID, _ := tools.StringArg(args, "requestId")
					submitted.Add(1)
					return tools.Submission{Value: map[string]string{"state": "running"}, Task: tools.TaskReference{Domain: "docker-image-pull", ID: requestID, RequestID: requestID}}, nil
				}})
			}}
			bridge, err := toolbridge.NewWithPlugins(nil, plugin)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = bridge.Close(context.Background()) })
			var step atomic.Int32
			m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, request model.Request) (model.Response, error) {
				if request.ToolChoice == "store_working_memory" {
					return memoryReply(request), nil
				}
				switch step.Add(1) {
				case 1:
					return searchReply("docker_image_pull"), nil
				case 2:
					reply := toolReply("docker_image_pull")
					reply.ToolCalls[0].Arguments = json.RawMessage(`{"id":"mysql:8.4","requestId":"first"}`)
					return reply, nil
				case 3:
					if !strings.Contains(allRequestText(request), "failed") {
						t.Error("失败任务没有返回模型")
					}
					reply := toolReply("docker_image_pull")
					reply.ToolCalls[0].Arguments = json.RawMessage(`{"id":"mysql:8.4","requestId":"second","registry":"https://dockerproxy.net"}`)
					return reply, nil
				default:
					if !strings.Contains(allRequestText(request), "succeeded") {
						t.Error("换源成功没有返回模型")
					}
					return finalReply("换源后拉取成功"), nil
				}
			}, func(d *Deps) {
				d.Tools, d.Catalog = bridge, &Extensions{MountRoot: "/srv"}
				d.InspectTask = func(_ context.Context, ref tools.TaskReference) (tools.TaskStatus, error) {
					state := "succeeded"
					if ref.RequestID == "first" {
						state = "failed"
					}
					return tools.TaskStatus{State: state, Terminal: true, Failed: state == "failed", Value: map[string]string{"state": state}}, nil
				}
			})
			run, _, err := m.CreateTask(context.Background(), session.ID, AgentInput{RequestID: "pull-switch", Content: "拉取 MySQL", AuthorizationMode: AuthorizationOnDemand, PermissionMode: mode})
			if err != nil {
				t.Fatal(err)
			}
			if mode != PermissionFull {
				first := waitingApproval(t, m, run.ID)
				if submitted.Load() != 0 {
					t.Fatal("批准前已经派发")
				}
				if _, err = m.DecideAccess(context.Background(), first.ID, accessInput(first, "once", "first-registry")); err != nil {
					t.Fatal(err)
				}
				second := waitingApproval(t, m, run.ID)
				if first.ID == second.ID || !strings.Contains(second.Operation.ArgumentsJSON, "dockerproxy.net") || submitted.Load() != 1 {
					t.Fatalf("换源未重新确认：%+v", second)
				}
				original := second.Operation
				changed := original
				changed.ArgumentsJSON = strings.ReplaceAll(changed.ArgumentsJSON, "dockerproxy.net", "docker.1ms.run")
				if accessDigest(original) == accessDigest(changed) {
					t.Fatal("镜像源未绑定授权摘要")
				}
				if _, err = m.DecideAccess(context.Background(), second.ID, accessInput(second, "once", "second-registry")); err != nil {
					t.Fatal(err)
				}
			}
			finished := runtimeFinished(t, m, run.ID)
			if finished.Status != StateSucceeded || submitted.Load() != 2 {
				t.Fatalf("%+v calls=%d", finished.Error, submitted.Load())
			}
			leases, err := m.ResourceLeases(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			for _, lease := range leases {
				if lease.RunID == run.ID && (lease.State == "held" || lease.State == "unknown") {
					t.Fatal("终态仍占租约")
				}
			}
		})
	}
}
