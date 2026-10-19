package harness

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"elysian/server/internal/agent/harness/model"
	"elysian/server/internal/agent/harness/worker"
)

type approvalShutdownProcess struct {
	worker.Process
	wrap func(worker.AgentBroker) worker.AgentBroker
}

func (p *approvalShutdownProcess) RunAgent(ctx context.Context, id string, broker worker.AgentBroker) error {
	return p.Process.(worker.AgentProcess).RunAgent(ctx, id, p.wrap(broker))
}

type approvalShutdownBroker struct {
	worker.AgentBroker
	first     *atomic.Bool
	entered   chan struct{}
	cancelled chan struct{}
	release   <-chan struct{}
}

func (b *approvalShutdownBroker) DriverVersion() int {
	return b.AgentBroker.(interface{ DriverVersion() int }).DriverVersion()
}

func (b *approvalShutdownBroker) ExecuteAgent(ctx context.Context, responseID string, index int, callID, name string, args json.RawMessage) error {
	err := b.AgentBroker.ExecuteAgent(ctx, responseID, index, callID, name, args)
	if errors.Is(err, worker.ErrSuspended) && b.first.CompareAndSwap(false, true) {
		close(b.entered)
		<-ctx.Done()
		close(b.cancelled)
		<-b.release
	}
	return err
}

func TestApprovalShutdownBeforeSuspensionAcknowledged(t *testing.T) {
	for _, realWorker := range []bool{false, true} {
		for _, workflow := range []bool{false, true} {
			for _, decision := range []string{"pending", "approved", "cancelled"} {
				name := map[bool]string{false: "fake-worker", true: "real-worker"}[realWorker] + "/" + map[bool]string{false: "agent", true: "workflow-agent"}[workflow] + "/" + decision
				t.Run(name, func(t *testing.T) {
					ctx := context.Background()
					entered, cancelled, release := make(chan struct{}), make(chan struct{}), make(chan struct{})
					var first atomic.Bool
					var requests, proposals, calls atomic.Int32
					var releaseOnce sync.Once
					unblock := func() { releaseOnce.Do(func() { close(release) }) }
					m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, request model.Request) (model.Response, error) {
						requests.Add(1)
						switch request.ToolChoice {
						case "store_working_memory":
							return memoryReply(request), nil
						case "workflow_finish":
							return workflowFinishReply(workflowAgentTestOutput), nil
						}
						if missingOperationTools(request, "test_write") {
							return searchReply("test"), nil
						}
						for _, message := range request.Messages {
							if businessToolResult(request, message) {
								return finalReply("操作已确认完成"), nil
							}
						}
						proposals.Add(1)
						return toolReply("test_write"), nil
					}, func(d *Deps) {
						d.Catalog = &operationCatalog{execute: func(context.Context, Operation) (CapabilityResult, error) {
							calls.Add(1)
							return CapabilityResult{Value: json.RawMessage(`{"done":true}`)}, nil
						}}
						d.Spawn = func(ctx context.Context) (worker.Process, error) {
							var process worker.Process = &agentTestProcess{}
							var err error
							if realWorker {
								process, err = worker.Spawn(ctx, worker.Options{Path: os.Args[0], Args: []string{"-test.run=^TestRuntimeWorkerHelper$"}, Env: []string{"HOME=/tmp", "ELYSIAN_RUNTIME_TEST_CHILD=1"}})
								if err != nil {
									return nil, err
								}
							}
							return &approvalShutdownProcess{Process: process, wrap: func(b worker.AgentBroker) worker.AgentBroker {
								return &approvalShutdownBroker{AgentBroker: b, first: &first, entered: entered, cancelled: cancelled, release: release}
							}}, nil
						}
					})
					t.Cleanup(unblock)
					var runID, workflowID string
					if workflow {
						w := startWorkflowAgentTest(t, m, session, nil)
						w = workflowWait(t, m, w.ID, StateWaitingApproval)
						runID, workflowID = w.ActiveRunID, w.ID
					} else {
						runID = submitAgentTest(t, m, session, "shutdown-race", "审批后执行操作").ID
					}
					a := waitingApproval(t, m, runID)
					select {
					case <-entered:
					case <-time.After(5 * time.Second):
						t.Fatal("未到达审批持久化后的挂起窗口")
					}
					if decision == "approved" {
						if _, err := m.Decide(ctx, a.ID, "approved"); err != nil {
							t.Fatal(err)
						}
					} else if decision == "cancelled" {
						if _, err := m.Cancel(ctx, runID); err != nil {
							t.Fatal(err)
						}
					}
					deps := m.deps
					closed := make(chan error, 1)
					go func() { closed <- m.Close(context.Background()) }()
					select {
					case <-cancelled:
					case <-time.After(5 * time.Second):
						t.Fatal("关闭未取消在途 Worker 上下文")
					}
					unblock()
					if err := <-closed; err != nil {
						t.Fatal(err)
					}
					persisted, err := openStore(deps.Path, deps.Now)
					if err != nil {
						t.Fatal(err)
					}
					before, readErr := persisted.get(ctx, runID)
					closeErr := persisted.close()
					expected := map[string]string{"pending": StateWaitingApproval, "approved": StateQueued, "cancelled": StateCancelled}[decision]
					if readErr != nil || closeErr != nil || before.Status != expected || before.Resume == nil || before.Resume.ResponseID == "" || requests.Load() != 2 || proposals.Load() != 1 || calls.Load() != 0 {
						t.Fatalf("关机改写了已持久审批边界：%+v read=%v close=%v requests=%d proposals=%d calls=%d", before, readErr, closeErr, requests.Load(), proposals.Load(), calls.Load())
					}
					m, err = New(deps)
					if err != nil {
						t.Fatal(err)
					}
					t.Cleanup(func() { _ = m.Close(context.Background()) })
					if decision == "cancelled" {
						got := runtimeFinished(t, m, runID)
						if got.Status != StateCancelled || calls.Load() != 0 || requests.Load() != 2 {
							t.Fatal("用户取消被挂起保留逻辑覆盖")
						}
						if workflow {
							workflowWait(t, m, workflowID, StateCancelled)
						}
						return
					}
					if decision == "pending" {
						resumed := waitingApproval(t, m, runID)
						if resumed.ID != a.ID {
							t.Fatal("重启重建了原审批")
						}
						if _, err = m.Decide(ctx, a.ID, "approved"); err != nil {
							t.Fatal(err)
						}
					}
					got := runtimeFinished(t, m, runID)
					expectedRequests := int32(4)
					if workflow {
						expectedRequests = 5
						workflowWait(t, m, workflowID, StateSucceeded)
					}
					if got.Status != StateSucceeded || calls.Load() != 1 || proposals.Load() != 1 || requests.Load() != expectedRequests {
						t.Fatalf("重启未复用原模型提议或重复执行：%+v requests=%d proposals=%d calls=%d", got, requests.Load(), proposals.Load(), calls.Load())
					}
				})
			}
		}
	}
}
