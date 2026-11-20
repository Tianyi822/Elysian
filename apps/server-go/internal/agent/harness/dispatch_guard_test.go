package harness

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"elysian/server/internal/agent/harness/model"
	"elysian/server/internal/agent/harness/sessionstore"
	"elysian/server/internal/agent/harness/state"
	"elysian/server/internal/agent/harness/worker"
)

func TestOperationDispatchGuard(t *testing.T) {
	for _, tc := range []struct {
		name      string
		check     int32
		action    string
		errorCode string
	}{
		{"策略前允许取消", 1, "cancel", ""},
		{"审批前允许取消", 2, "cancel", ""},
		{"外部派发前允许取消", 3, "cancel", "outcome-unknown"},
		{"票据签发时允许取消", 4, "cancel", "outcome-unknown"},
		{"外部派发前保留守卫拒绝", 3, "deny", "maintenance-active"},
		{"派发异常保留未知结果", 3, "panic", "outcome-unknown"},
		{"票据签发时重新检查撤销", 4, "revoke", "capability-revoked"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			const panicValue = "fixture-dispatch-panic"
			var logPath string
			if tc.action == "panic" {
				logPath = openPanicTestLog(t)
			}
			s, _ := openRuntimeTestStore(t)
			run := createRuntimeTestRun(t, s, "dispatch-guard", runtimeStoreTestTime)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			run, err := s.change(ctx, run.ID, "start", func(tx sessionstore.Tx, run *Run) error {
				run.Status = StateRunning
				return saveRun(ctx, tx, run)
			})
			if err != nil {
				t.Fatal(err)
			}
			entered, release := make(chan struct{}), make(chan struct{})
			unblock := sync.OnceFunc(func() { close(release) })
			var checks, invoked atomic.Int32
			catalog := &operationCatalog{execute: func(context.Context, Operation) (CapabilityResult, error) {
				invoked.Add(1)
				return CapabilityResult{}, nil
			}}
			snapshot, err := catalog.Snapshot(ctx, Environment{TrustedReadOnly: []string{"test_read"}})
			if err != nil {
				t.Fatal(err)
			}
			snapshot.Digest = "guard-test-snapshot"
			run.DriverVersion, run.Snapshot = "v2", &snapshot
			m := &Manager{
				store:      s,
				executions: map[string]*executionState{run.ID: {cancel: cancel}},
				deps: Deps{Now: s.now, NewID: state.RandomID, Catalog: catalog, DispatchGuard: func() error {
					if checks.Add(1) == tc.check {
						close(entered)
						<-release
						if tc.action == "panic" {
							panic(panicValue)
						}
						if tc.action == "deny" {
							return bad("maintenance-active", "维护中")
						}
					}
					return nil
				}},
			}
			if err := m.initializeToolRuntime(); err != nil {
				t.Fatal(err)
			}
			defer func() { _ = m.toolRuntime.Close(context.Background()) }()
			a := &agentExecution{manager: m, run: run}
			result := make(chan error, 1)
			finished := make(chan struct{})
			go func() {
				defer close(finished)
				args := json.RawMessage(`{}`)
				result <- a.executeOperation(ctx, 0, model.ToolCall{ID: "call", Name: "test_read", Arguments: args}, args)
			}()
			defer func() { unblock(); <-finished }()
			select {
			case <-entered:
			case err := <-result:
				t.Fatalf("未到达派发守卫：%v", err)
			case <-time.After(5 * time.Second):
				t.Fatal("未到达派发守卫")
			}
			if !m.mu.TryLock() {
				t.Fatal("慢守卫占用了 Manager 锁，取消无法推进")
			}
			m.mu.Unlock()
			switch tc.action {
			case "cancel":
				cancelled, err := m.Cancel(context.Background(), run.ID)
				if err != nil || cancelled.CancelRequestedAt == "" {
					t.Fatalf("未保存取消事实：%+v %v", cancelled, err)
				}
			case "revoke":
				if err = m.Revoke(context.Background(), "mcp", "fixture-server", 1, "测试撤销"); err != nil {
					t.Fatal(err)
				}
			}
			unblock()
			err = <-result
			if tc.errorCode != "" {
				runtimeErrorCode(t, err, tc.errorCode)
			} else if !errors.Is(err, context.Canceled) {
				t.Fatalf("守卫返回后应拒绝已取消的操作：%v", err)
			}
			if invoked.Load() != 0 {
				t.Fatal("未获准的操作进入了工具后端")
			}
			if tc.errorCode == "outcome-unknown" {
				barriers, err := m.Barriers(context.Background())
				if err != nil || len(barriers) != 1 || barriers[0].Status != "unknown" {
					t.Fatalf("取消后未保留已落盘的派发保护：%+v %v", barriers, err)
				}
			}
			if tc.action == "panic" {
				assertPanicTestLog(t, logPath, panicValue, "agent/harness/operation.go:")
			}
		})
	}
}

func TestWorkerGuardChecksQueueAfterConcurrentCancellation(t *testing.T) {
	s, _ := openRuntimeTestStore(t)
	run := createRuntimeTestRun(t, s, "queue-guard", runtimeStoreTestTime)
	ctx, stop := context.WithCancel(context.Background())
	entered, release, next := make(chan struct{}), make(chan struct{}), make(chan struct{})
	unblock := sync.OnceFunc(func() { close(release) })
	var guards, dispatched atomic.Int32
	m := &Manager{ctx: ctx, store: s, wake: make(chan struct{}, 1), executions: map[string]*executionState{}, deps: Deps{
		Now: s.now, NewID: state.RandomID, Tools: &runtimeTestTools{},
		DispatchGuard: func() error {
			switch guards.Add(1) {
			case 1:
				close(entered)
				<-release
			case 2:
				close(next)
			}
			return nil
		},
	}}
	m.signal() // 空队列处理完第一轮后，唤醒下一轮，证明 Worker 已越过第一次检查。
	slot := &workerSlot{process: &runtimeTestProcess{run: func(context.Context, string, []worker.Step, worker.Invoker) error {
		dispatched.Add(1)
		return nil
	}}}
	done := make(chan struct{})
	go func() { defer close(done); m.workerLoop(slot) }()
	defer func() { stop(); unblock(); <-done }()
	awaitGuard(t, m, entered)
	if cancelled, err := m.Cancel(ctx, run.ID); err != nil || cancelled.Status != StateCancelled {
		t.Fatalf("未能在查询期间取消排队任务：%+v %v", cancelled, err)
	}
	unblock()
	select {
	case <-next:
	case <-time.After(5 * time.Second):
		t.Fatal("Worker 未越过阻塞的检查")
	}
	got, err := s.get(ctx, run.ID)
	if err != nil || got.Status != StateCancelled || got.StartedAt != "" || dispatched.Load() != 0 {
		t.Fatalf("Worker 启动了已取消的排队任务：%+v %v", got, err)
	}
}

func TestRunningGuardRejectsConcurrentCancellation(t *testing.T) {
	for _, tc := range []struct {
		name string
		call func(context.Context, *agentExecution) error
	}{
		{"模型", func(ctx context.Context, a *agentExecution) error {
			_, err := a.requestModel(ctx, "inference", model.Request{}, nil, 0)
			return err
		}},
		{"计划", func(ctx context.Context, a *agentExecution) error {
			return a.executePlan(ctx, 0, planReply(planFixture).ToolCalls[0])
		}},
		{"提问", func(ctx context.Context, a *agentExecution) error {
			return a.executeUserInput(ctx, 0, userInputReply(questionFixture).ToolCalls[0], "")
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, _ := openRuntimeTestStore(t)
			run := continuousStoreRun(t, s, "running-guard")
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			run, err := s.change(ctx, run.ID, "start", func(tx sessionstore.Tx, r *Run) error {
				r.Status = StateRunning
				return saveRun(ctx, tx, r)
			})
			if err != nil {
				t.Fatal(err)
			}
			entered, release := make(chan struct{}), make(chan struct{})
			unblock := sync.OnceFunc(func() { close(release) })
			m := &Manager{store: s, executions: map[string]*executionState{run.ID: {cancel: cancel}}, deps: Deps{
				Now: s.now, NewID: state.RandomID, DispatchGuard: func() error { close(entered); <-release; return nil },
			}}
			run.Snapshot = &CapabilitySnapshot{Tools: []Capability{planCapability()}}
			a := &agentExecution{manager: m, run: run, pending: &ModelRequestRecord{ID: "original"}}
			result, done := make(chan error, 1), make(chan struct{})
			go func() { defer close(done); result <- tc.call(ctx, a) }()
			defer func() { unblock(); <-done }()
			awaitGuard(t, m, entered)
			cancelled, err := m.Cancel(context.Background(), run.ID)
			if err != nil || cancelled.CancelRequestedAt == "" {
				t.Fatalf("未能在查询期间记录取消：%+v %v", cancelled, err)
			}
			unblock()
			if err = <-result; !errors.Is(err, context.Canceled) {
				t.Fatalf("应以取消而非继续执行结束：%v", err)
			}
			got, err := s.get(context.Background(), run.ID)
			if err != nil || got.LastSeq != cancelled.LastSeq || got.Usage != run.Usage || got.Plan != nil {
				t.Fatalf("取消后留下了新的运行记录或计量：%+v %v", got, err)
			}
		})
	}
}

func TestRequestDispatchGuardDoesNotHoldManagerLock(t *testing.T) {
	for _, tc := range []struct {
		name string
		call func(*Manager, error) error
	}{
		{"状态", func(m *Manager, denied error) error {
			i := m.Info()
			if i.Available || i.Reason != denied.Error() {
				return errors.New("状态未反映维护拒绝")
			}
			return denied
		}},
		{"回答", func(m *Manager, _ error) error {
			_, err := m.AnswerUserInput(context.Background(), "run", "question", AnswerUserInput{RequestID: "answer"})
			return err
		}},
		{"审批", func(m *Manager, _ error) error {
			_, err := m.Decide(context.Background(), "approval", "approved")
			return err
		}},
		{"授权", func(m *Manager, _ error) error {
			_, err := m.DecideAccess(context.Background(), "approval", AccessDecision{RequestID: "decision", ExpectedRevision: 1, ExpectedDigest: "digest", Decision: "once"})
			return err
		}},
		{"撤回授权", func(m *Manager, _ error) error {
			_, err := m.RevokeSessionAuthorization(context.Background(), "session", "authorization", RevokeAuthorizationInput{RequestID: "revoke", ExpectedRevision: 1})
			return err
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, _ := openRuntimeTestStore(t)
			entered, release := make(chan struct{}), make(chan struct{})
			unblock := sync.OnceFunc(func() { close(release) })
			denied := &Error{Status: 503, Code: "maintenance", Message: "维护期间暂停派发"}
			m := &Manager{store: s, deps: Deps{DispatchGuard: func() error { close(entered); <-release; return denied }}}
			result, done := make(chan error, 1), make(chan struct{})
			go func() { defer close(done); result <- tc.call(m, denied) }()
			defer func() { unblock(); <-done }()
			awaitGuard(t, m, entered)
			unblock()
			if err := <-result; err != denied {
				t.Fatalf("应保留维护拒绝：%v", err)
			}
		})
	}
}

func TestWorkspaceDispatchGuardRechecksVersion(t *testing.T) {
	for _, check := range []int32{1, 2} {
		t.Run(map[int32]string{1: "准备前", 2: "发布前"}[check], func(t *testing.T) {
			m, _, task := workspaceManagerFixture(t)
			ctx := context.Background()
			entered, release := make(chan struct{}), make(chan struct{})
			unblock := sync.OnceFunc(func() { close(release) })
			var calls atomic.Int32
			m.deps.DispatchGuard = func() error {
				if calls.Add(1) == check {
					close(entered)
					<-release
				}
				return nil
			}
			result, done := make(chan error, 1), make(chan struct{})
			go func() {
				defer close(done)
				_, err := m.WriteWorkspace(ctx, task.ID, 0, "file", strings.NewReader("过期候选"))
				result <- err
			}()
			defer func() { unblock(); <-done }()
			awaitGuard(t, m, entered)
			newVersion, err := m.WriteWorkspace(ctx, task.ID, 0, "file", strings.NewReader("已提交"))
			if err != nil {
				t.Fatal(err)
			}
			unblock()
			requireWorkspaceCode(t, <-result, "workspace-revision-conflict")
			view, err := m.Workspace(ctx, task.ID, "file")
			if err != nil || view.Version != newVersion || string(view.Content) != "已提交" {
				t.Fatalf("过期候选覆盖已发布的版本：%+v %v", view, err)
			}
		})
	}
}

func awaitGuard(t *testing.T, m *Manager, entered <-chan struct{}) {
	t.Helper()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("未到达维护守卫")
	}
	if !m.mu.TryLock() {
		t.Fatal("慢守卫占用了 Manager 锁")
	}
	m.mu.Unlock()
}
