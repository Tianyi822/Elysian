package harness

import (
	"context"
	"encoding/json"
	"strings"
	"sync/atomic"
	"testing"

	"elysian/server/internal/agent/harness/model"
	"elysian/server/internal/agent/tools"
	domaindatabase "elysian/server/internal/database"
	domaindocker "elysian/server/internal/docker"
	"elysian/server/internal/seam"
)

// Keep the real database preflight and replace only its returned mutation. The
// asynchronous Docker receipt still goes through the domain's durable task store.
type correctedServiceBridge struct {
	seam.AgentDatabaseContainers
	t        *testing.T
	prepared atomic.Int32
	executed atomic.Int32
}

func (b *correctedServiceBridge) PrepareCreate(ctx context.Context, input seam.AgentServiceContainerInput, imageID string) (func(context.Context) (any, error), bool, error) {
	b.prepared.Add(1)
	if input.Port != 3306 || input.HostPort != 3306 {
		b.t.Errorf("JSON integer changed before domain preflight: port=%d hostPort=%d", input.Port, input.HostPort)
	}
	run, handled, err := b.AgentDatabaseContainers.PrepareCreate(ctx, input, imageID)
	if err != nil || !handled || run == nil {
		return run, handled, err
	}
	return func(context.Context) (any, error) {
		b.executed.Add(1)
		return map[string]any{"database": map[string]string{"id": "fixture-database", "name": "orders"}}, nil
	}, true, nil
}

func serviceCorrectionArguments(port, requestID string, corrected bool) json.RawMessage {
	env := ""
	if corrected {
		env = `,"env":["MYSQL_DATABASE=orders"]`
	}
	return json.RawMessage(`{"name":"mysql84","image":"mysql:8.4@sha256:` + strings.Repeat("a", 64) + `","requestId":"` + requestID + `","resourceTier":"small","networkScope":"any-host","port":` + port + `,"hostPort":` + port + `,"credentials":["MYSQL_ROOT_PASSWORD"],"volumes":["/var/lib/mysql"]` + env + `}`)
}

func TestServiceSubmissionCorrectsJSONNumbersAndReauthorizesWithoutUnknownProtection(t *testing.T) {
	for _, port := range []string{"3306", "3306.0", "3.306e3"} {
		t.Run(port, func(t *testing.T) {
			ctx := context.Background()
			db := domaindatabase.NewAgentFacade(domaindatabase.Deps{EngineAvailable: true, Engine: unusedDatabaseTransport{}, Views: &dockerCatalogViews{}, AgentAuthorize: tools.Revalidate})
			domain := &correctedServiceBridge{AgentDatabaseContainers: db.ContainerBridge(tools.Revalidate), t: t}
			var facade *domaindocker.AgentFacade
			bridge, _ := dockerCatalogBridge(t, func(a *domaindocker.AgentFacade) {
				facade = a
				a.SetDatabaseContainers(domain)
			})
			firstRequest, correctedRequest := strings.Repeat("b", 64), strings.Repeat("c", 64)
			var requests atomic.Int32
			m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, request model.Request) (model.Response, error) {
				if request.ToolChoice == "store_working_memory" {
					return memoryReply(request), nil
				}
				switch requests.Add(1) {
				case 1:
					return searchReply("docker_container_create_service"), nil
				case 2:
					reply := toolReply("docker_container_create_service")
					reply.ToolCalls[0].Arguments = serviceCorrectionArguments(port, firstRequest, false)
					return reply, nil
				case 3:
					text := allRequestText(request)
					if !strings.Contains(text, "docker-operation-rejected") || !strings.Contains(text, "MYSQL_DATABASE") || !strings.Contains(text, "not-started") {
						t.Error("safe preflight reason and execution evidence did not reach the model")
					}
					reply := toolReply("docker_container_create_service")
					reply.ToolCalls[0].Arguments = serviceCorrectionArguments(port, correctedRequest, true)
					return reply, nil
				default:
					if !strings.Contains(allRequestText(request), "fixture-database") {
						t.Error("confirmed corrected task result did not reach the model")
					}
					return finalReply("已核对测试回执，数据库为 orders。"), nil
				}
			}, func(d *Deps) {
				d.Tools, d.Catalog = bridge, &Extensions{MountRoot: "/srv"}
				d.InspectTask = func(ctx context.Context, ref tools.TaskReference) (tools.TaskStatus, error) {
					task, err := facade.InspectContainerOperation(ctx, ref.ID)
					if err != nil {
						return tools.TaskStatus{}, err
					}
					if ref.Domain != domaindocker.ContainerOperationDomain || ref.RequestID != correctedRequest || task.RequestID != ref.RequestID || task.Target != ref.Target || task.Digest != ref.Digest {
						t.Error("corrected submission lost its durable task identity")
					}
					return tools.TaskStatus{Outcome: tools.TaskOutcome(task.State), State: task.State, Value: domaindocker.AgentOperationReceipt(task), ErrorCode: task.ErrorCode, Error: task.Message}, nil
				}
			})
			run, _, err := m.CreateTask(ctx, session.ID, AgentInput{RequestID: "correct-service", Content: "部署 MySQL，small 档，开放3306，初始数据库使用 orders", AuthorizationMode: AuthorizationOnDemand, PermissionMode: PermissionAsk})
			if err != nil {
				t.Fatal(err)
			}
			first := waitingApproval(t, m, run.ID)
			if domain.prepared.Load() != 0 || domain.executed.Load() != 0 {
				t.Fatal("domain was entered before approval")
			}
			if _, err := m.DecideAccess(ctx, first.ID, accessInput(first, "once", "approve-initial")); err != nil {
				t.Fatal(err)
			}
			second := waitingApproval(t, m, run.ID)
			if second.ID == first.ID || second.Operation.RunID != run.ID || !strings.Contains(second.Operation.ArgumentsJSON, "MYSQL_DATABASE=orders") || domain.prepared.Load() != 1 || domain.executed.Load() != 0 {
				t.Fatalf("correction did not wait for its own approval: prepared=%d executed=%d approval=%+v", domain.prepared.Load(), domain.executed.Load(), second)
			}
			rejected, err := readOperation(ctx, m.store.db, first.Operation.ID)
			if err != nil || rejected.Status != "completed" || rejected.Task != nil || rejected.Error == nil || rejected.Error.Code != "docker-operation-rejected" || rejected.Error.Evidence == nil || rejected.Error.Evidence.Execution != "not-started" {
				t.Fatalf("preflight rejection retained unknown or task state: operation=%+v error=%v", rejected, err)
			}
			assertDomainProtection(t, m, rejected, "released")
			assertServiceProtectionConfirmed(t, m, run.ID, 1)
			if first.Access.Digest == second.Access.Digest {
				t.Fatal("corrected arguments reused the original approval digest")
			}
			if _, err := m.DecideAccess(ctx, second.ID, accessInput(second, "once", "approve-corrected")); err != nil {
				t.Fatal(err)
			}
			finished := runtimeFinished(t, m, run.ID)
			if finished.Status != StateSucceeded || requests.Load() != 4 || domain.prepared.Load() != 2 || domain.executed.Load() != 1 {
				t.Fatalf("correction failed or replayed: status=%s error=%+v requests=%d prepared=%d executed=%d", finished.Status, finished.Error, requests.Load(), domain.prepared.Load(), domain.executed.Load())
			}
			completed, err := readOperation(ctx, m.store.db, second.Operation.ID)
			if err != nil || completed.Status != "completed" || completed.Error != nil || completed.Task == nil || completed.Task.ID == "" || completed.Task.RequestID != correctedRequest {
				t.Fatalf("corrected task did not settle: operation=%+v error=%v", completed, err)
			}
			assertDomainProtection(t, m, completed, "released")
			assertServiceProtectionConfirmed(t, m, run.ID, 2)
			calls, err := m.Calls(ctx, run.ID, "", 10)
			if err != nil || len(calls.Items) != 3 || calls.Items[1].Status != StateFailed || calls.Items[2].Status != StateSucceeded {
				t.Fatalf("rejected and corrected calls lost their separate facts: calls=%+v error=%v", calls.Items, err)
			}
		})
	}
}

func assertServiceProtectionConfirmed(t *testing.T, m *Manager, runID string, want int) {
	t.Helper()
	barriers, err := m.Barriers(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	count := 0
	for _, barrier := range barriers {
		if barrier.RunID == runID {
			count++
			if barrier.Status != "confirmed" {
				t.Fatalf("service preflight or completed task retained protection: %+v", barrier)
			}
		}
	}
	if count != want {
		t.Fatalf("service barrier count=%d want=%d", count, want)
	}
}
