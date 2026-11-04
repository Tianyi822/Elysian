package harness

import (
	"context"
	"database/sql"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"elysian/server/internal/agent/harness/model"
	"elysian/server/internal/agent/tools"
)

func awaitDeleteSignal(t *testing.T, ch <-chan struct{}) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(5 * time.Second):
		t.Fatal("未收到预期信号")
	}
}

func TestForceDeleteRunningModelIgnoresLateResultAndKeepsOtherSessions(t *testing.T) {
	started, cancelled, release := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	m, session, _ := agentManager(t, func(ctx context.Context, _ model.Profile, req model.Request) (model.Response, error) {
		if calls.Add(1) == 1 {
			close(started)
			<-ctx.Done()
			close(cancelled)
			<-release // 故意不响应取消；删除不等待其回执。
			if req.OnContent != nil {
				req.OnContent("不应复活")
			}
			return finalReply("迟到结果"), nil
		}
		if req.ToolChoice == "store_working_memory" {
			return memoryReply(req), nil
		}
		return finalReply("其他会话正常"), nil
	}, nil)
	defer close(release)
	run := submitAgentTest(t, m, session, "delete-model", "等待模型")
	awaitDeleteSignal(t, started)
	if err := m.DeleteSession(context.Background(), session.ID); err != nil {
		t.Fatal(err)
	}
	awaitDeleteSignal(t, cancelled)
	if _, err := m.Get(context.Background(), run.ID); !isNotFound(err) {
		t.Fatalf("运行未删除：%v", err)
	}
	runtimeEventually(t, func() bool { return m.Info().Agent.Available })
	other, err := m.CreateSession(context.Background(), CreateSessionInput{ModelProfileID: session.ModelProfileID, ModelRevision: session.ModelRevision})
	if err != nil {
		t.Fatal(err)
	}
	next := submitAgentTest(t, m, other, "after-delete", "正常继续")
	runtimeEventually(t, func() bool {
		r, err := m.Get(context.Background(), next.ID)
		return err == nil && r.Status == StateSucceeded
	})
	m.mu.Lock()
	if m.storageError || m.blocked != "" {
		t.Errorf("删除冻结了全局派发：%s", m.blocked)
	}
	m.mu.Unlock()
}

func TestForceDeleteOperationCancelsLateAcceptedTask(t *testing.T) {
	started, cancelled, release, taskCancelled := make(chan struct{}), make(chan struct{}), make(chan struct{}), make(chan struct{})
	reference := tools.TaskReference{Domain: "fixture", ID: "task-owned", RequestID: "request-owned"}
	catalog := &operationCatalog{execute: func(ctx context.Context, _ Operation) (CapabilityResult, error) {
		close(started)
		<-ctx.Done()
		close(cancelled)
		<-release
		return CapabilityResult{Task: &reference}, nil
	}}
	m, session, _ := agentManager(t, operationClient(), func(d *Deps) {
		d.Catalog = catalog
		d.CancelTask = func(_ context.Context, got tools.TaskReference) error {
			if got != reference {
				t.Errorf("取消身份错误：%+v", got)
			}
			select {
			case <-taskCancelled:
			default:
				close(taskCancelled)
			}
			return nil
		}
	})
	run := submitAgentTest(t, m, session, "delete-operation", "执行任务")
	approval := waitingApproval(t, m, run.ID)
	if _, err := m.Decide(context.Background(), approval.ID, "approved"); err != nil {
		t.Fatal(err)
	}
	awaitDeleteSignal(t, started)
	if err := m.DeleteSession(context.Background(), session.ID); err != nil {
		t.Fatal(err)
	}
	awaitDeleteSignal(t, cancelled)
	close(release)
	awaitDeleteSignal(t, taskCancelled)
	runtimeEventually(t, func() bool {
		m.mu.Lock()
		defer m.mu.Unlock()
		var count int
		err := m.store.db.QueryRow("SELECT COUNT(*) FROM session_task_cleanup").Scan(&count)
		return err == nil && count == 0 && len(m.executions) == 0 && !m.storageError && m.blocked == ""
	})
	if _, err := m.Get(context.Background(), run.ID); !isNotFound(err) {
		t.Fatalf("迟到任务复活：%v", err)
	}
}

func TestForceDeleteWaitingTaskAndLateMonitor(t *testing.T) {
	inspecting, release, cancelled := make(chan struct{}), make(chan struct{}), make(chan struct{})
	reference := tools.TaskReference{Domain: "fixture", ID: "waiting-task", RequestID: "waiting-request"}
	m, session, _ := agentManager(t, operationClient(), func(d *Deps) {
		d.Catalog = &operationCatalog{execute: func(context.Context, Operation) (CapabilityResult, error) {
			return CapabilityResult{Task: &reference}, nil
		}}
		d.InspectTask = func(ctx context.Context, _ tools.TaskReference) (tools.TaskStatus, error) {
			select {
			case <-inspecting:
			default:
				close(inspecting)
			}
			select {
			case <-release:
			case <-ctx.Done():
				return tools.TaskStatus{}, ctx.Err()
			}
			return tools.TaskStatus{Terminal: true, State: "succeeded", Value: map[string]bool{"done": true}}, nil
		}
		d.CancelTask = func(context.Context, tools.TaskReference) error {
			select {
			case <-cancelled:
			default:
				close(cancelled)
			}
			return nil
		}
	})
	run := submitAgentTest(t, m, session, "delete-waiting", "等待后台任务")
	approval := waitingApproval(t, m, run.ID)
	if _, err := m.Decide(context.Background(), approval.ID, "approved"); err != nil {
		t.Fatal(err)
	}
	awaitDeleteSignal(t, inspecting)
	if err := m.DeleteSession(context.Background(), session.ID); err != nil {
		t.Fatal(err)
	}
	awaitDeleteSignal(t, cancelled)
	close(release)
	runtimeEventually(t, func() bool {
		m.mu.Lock()
		defer m.mu.Unlock()
		var n int
		_ = m.store.db.QueryRow("SELECT COUNT(*) FROM session_task_cleanup").Scan(&n)
		return n == 0
	})
	if !m.Info().Agent.Available {
		t.Fatalf("迟到对账冻结其他会话：%+v", m.Info())
	}
}

func TestForceDeleteStatesAndRollback(t *testing.T) {
	for _, state := range []string{StateQueued, StateRunning, StateWaitingInput, StateWaitingApproval, StateWaitingResource, StateWaitingTask, StateRecoveryRequired} {
		t.Run(state, func(t *testing.T) {
			m, profile := sessionAPIManager(t)
			ctx := context.Background()
			session, err := m.CreateSession(ctx, CreateSessionInput{ModelProfileID: profile.ID, ModelRevision: profile.Revision})
			if err != nil {
				t.Fatal(err)
			}
			run, _, err := m.CreateTask(ctx, session.ID, AgentInput{RequestID: "delete-state", Content: "删除状态"})
			if err != nil {
				t.Fatal(err)
			}
			_, err = m.store.change(ctx, run.ID, "fixture-state", func(tx *sql.Tx, r *Run) error { r.Status = state; return nil })
			if err != nil {
				t.Fatal(err)
			}
			m.store.beforeWrite = func(op string) error {
				if op == "delete-session" {
					return errors.New("模拟写失败")
				}
				return nil
			}
			if err = m.DeleteSession(ctx, session.ID); err == nil {
				t.Fatal("存储失败却报告成功")
			}
			m.store.beforeWrite = nil
			if _, err = m.GetSession(ctx, session.ID); err != nil {
				t.Fatal("失败删除丢失记录", err)
			}
			if err = m.DeleteSession(ctx, session.ID); err != nil {
				t.Fatal(err)
			}
			if _, err = m.Get(ctx, run.ID); !isNotFound(err) {
				t.Fatal("运行残留", err)
			}
		})
	}
}

func TestForceDeleteTaskCleanupSurvivesRestart(t *testing.T) {
	m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, req model.Request) (model.Response, error) {
		if req.ToolChoice == "store_working_memory" {
			return memoryReply(req), nil
		}
		return finalReply("完成"), nil
	}, nil)
	ctx := context.Background()
	run, _, err := m.CreateTask(ctx, session.ID, AgentInput{RequestID: "delete-restart", Content: "取消不丢失"})
	if err != nil {
		t.Fatal(err)
	}
	runtimeFinished(t, m, run.ID)
	ref := tools.TaskReference{Domain: "fixture", ID: "durable-task", RequestID: "durable-request"}
	err = m.store.write(ctx, "fixture-task", func(tx *sql.Tx) error {
		return saveOperation(ctx, tx, Operation{ID: "durable-operation", RunID: run.ID, Status: StateWaitingTask, Task: &ref})
	})
	if err != nil {
		t.Fatal(err)
	}
	if err = m.DeleteSession(ctx, session.ID); err != nil {
		t.Fatal(err)
	}
	cancelled := make(chan struct{})
	if err = m.Close(ctx); err != nil {
		t.Fatal(err)
	}
	m.deps.CancelTask = func(_ context.Context, got tools.TaskReference) error {
		if got != ref {
			t.Errorf("身份变化：%+v", got)
		}
		select {
		case <-cancelled:
		default:
			close(cancelled)
		}
		return nil
	}
	m = reopenOperationManager(t, m)
	awaitDeleteSignal(t, cancelled)
	if _, err = m.GetSession(ctx, session.ID); !isNotFound(err) {
		t.Fatalf("重启恢复了被删会话：%v", err)
	}
}

func TestForceDeleteActiveWorkflowCascadesScopes(t *testing.T) {
	m, session := workflowTestManager(t, &operationCatalog{})
	workflow := workflowStepsTest(t, m, session, workflowOneOperation("test_write"))
	workflow = workflowWait(t, m, workflow.ID, StateWaitingApproval)
	workflowIdle(t, m)
	if err := m.DeleteSession(context.Background(), workflow.SessionID); err != nil {
		t.Fatal(err)
	}
	if _, err := m.GetSession(context.Background(), session.ID); err != nil {
		t.Fatal("误删了来源会话", err)
	}
	for _, table := range []string{"workflow_instances", "workflow_scopes", "workflow_nodes", "runs", "operations", "approvals"} {
		var n int
		if err := m.store.db.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&n); err != nil || n != 0 {
			t.Fatalf("%s 残留 %d：%v", table, n, err)
		}
	}
}

func TestForceDeleteReleasesOnlyItsUnresponsiveExecution(t *testing.T) {
	m, profile := sessionAPIManager(t)
	ctx := context.Background()
	session, err := m.CreateSession(ctx, CreateSessionInput{ModelProfileID: profile.ID, ModelRevision: profile.Revision})
	if err != nil {
		t.Fatal(err)
	}
	run, _, err := m.CreateTask(ctx, session.ID, AgentInput{RequestID: "delete-unresponsive", Content: "删除阻塞运行"})
	if err != nil {
		t.Fatal(err)
	}
	cancelled := false
	target := &executionState{cancel: func() { cancelled = true }, deletedDone: make(chan struct{})}
	other := &executionState{}
	m.executions = map[string]*executionState{run.ID: target, "unrelated": other}
	m.executionUnresponsiveLocked(target, "目标未停止")
	m.executionUnresponsiveLocked(other, "其他会话未停止")
	if err = m.DeleteSession(ctx, session.ID); err != nil {
		t.Fatal(err)
	}
	if !cancelled || !target.deleted || m.blocked == "" || m.executions["unrelated"] != other {
		t.Fatal("删除错误地清除了其他会话屏障")
	}
}

func TestForceDeleteSchema9MigrationPreservesHistory(t *testing.T) {
	s, _ := openRuntimeTestStore(t)
	session, task, run := sessionStoreFixture(t, s, "migration-nine", time.Now())
	acceptSessionTestRun(t, s, task, run, true)
	if _, err := s.db.Exec("DROP TABLE session_task_cleanup; PRAGMA user_version=9"); err != nil {
		t.Fatal(err)
	}
	if err := migrateStore(s.db); err != nil {
		t.Fatal(err)
	}
	if _, err := readSession(context.Background(), s.db, session.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.get(context.Background(), run.ID); err != nil {
		t.Fatal(err)
	}
	var count, version int
	if err := s.db.QueryRow("SELECT COUNT(*) FROM session_task_cleanup").Scan(&count); err != nil || count != 0 {
		t.Fatal("清理清单迁移失败", err)
	}
	if err := s.db.QueryRow("PRAGMA user_version").Scan(&version); err != nil || version != 10 {
		t.Fatalf("版本：%d %v", version, err)
	}
}
