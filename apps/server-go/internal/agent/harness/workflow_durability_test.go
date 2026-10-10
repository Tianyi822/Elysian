package harness

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"elysian/server/internal/agent/harness/model"
	"elysian/server/internal/agent/harness/workspace"
)

func TestWorkflowDurabilityV3MigrationKeepsApprovalAndIdempotency(t *testing.T) {
	for _, status := range []string{"pending", "approved"} {
		t.Run(status, func(t *testing.T) {
			ctx := context.Background()
			path := filepath.Join(t.TempDir(), "v3.sqlite")
			db, err := sql.Open("sqlite", path)
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			if _, err = db.Exec(schema + sessionSchema + capabilitySchema + "PRAGMA user_version=3;"); err != nil {
				t.Fatal(err)
			}
			at := stamp(time.Now())
			session := Session{ID: "legacy-session", Title: "升级前会话", CreatedAt: at, LastActivityAt: at, ActiveRunID: "legacy-run", LastSeq: "0"}
			task := Task{ID: "legacy-task", SessionID: session.ID, RequestID: "legacy-request", Kind: "agent", DriverVersion: "v2", CreatedAt: at, Goal: "保留已接受操作"}
			run := Run{ID: "legacy-run", SessionID: session.ID, TaskID: task.ID, RequestID: task.RequestID, RunNumber: 1, Status: StateWaitingApproval, Input: task.Goal, CreatedAt: at, LastSeq: "1", Limits: DefaultAgentLimits()}
			if status == "approved" {
				run.Status = StateQueued
			}
			operation := Operation{ID: "legacy-operation", RunID: run.ID, TaskID: task.ID, ModelRequestID: "legacy-response", ModelCallID: "legacy-call", ArgumentsJSON: `{"n":9007199254740993}`, Capability: Capability{Name: "test_write", Source: "mcp-tool", Parameters: json.RawMessage(`{"type":"object"}`)}, Status: "waiting-approval", Policy: "approval-required", ApprovalID: "legacy-approval", CallID: "legacy-tool-call", CreatedAt: at}
			approval := Approval{ID: operation.ApprovalID, RunID: run.ID, OperationID: operation.ID, Status: status, CreatedAt: at, ExpiresAt: stamp(time.Now().Add(time.Hour)), Operation: operation}
			if status == "approved" {
				approval.Decision = status
				approval.DecidedAt = at
			}
			encode := func(v any) string {
				b, e := json.Marshal(v)
				if e != nil {
					t.Fatal(e)
				}
				return string(b)
			}
			canonical := `{"content":"保留已接受操作","argumentsJson":"{\"n\":9007199254740993}"}`
			for _, statement := range []struct {
				query string
				args  []any
			}{
				{"INSERT INTO sessions(id,last_activity_at,active_run_id,last_seq,document) VALUES(?,?,?,?,?)", []any{session.ID, at, run.ID, 0, encode(session)}},
				{"INSERT INTO tasks(id,request_id,input,document,session_id) VALUES(?,?,?,?,?)", []any{task.ID, task.RequestID, canonical, encode(task), session.ID}},
				{"INSERT INTO runs(id,task_id,state,created_at,document,session_id,request_id,canonical_input,run_number) VALUES(?,?,?,?,?,?,?,?,?)", []any{run.ID, task.ID, run.Status, at, encode(run), session.ID, task.RequestID, canonical, 1}},
				{"INSERT INTO operations(id,run_id,model_request_id,call_index,state,document) VALUES(?,?,?,?,?,?)", []any{operation.ID, run.ID, operation.ModelRequestID, 0, operation.Status, encode(operation)}},
				{"INSERT INTO approvals(id,operation_id,run_id,state,expires_at,document) VALUES(?,?,?,?,?,?)", []any{approval.ID, operation.ID, run.ID, approval.Status, approval.ExpiresAt, encode(approval)}},
			} {
				if _, err = db.Exec(statement.query, statement.args...); err != nil {
					t.Fatal(err)
				}
			}
			if err = db.Close(); err != nil {
				t.Fatal(err)
			}
			store, err := openStore(path, time.Now)
			if err != nil {
				t.Fatal(err)
			}
			defer store.close()
			var version int
			if err = store.db.QueryRow("PRAGMA user_version").Scan(&version); err != nil || version != schemaVersion {
				t.Fatalf("迁移版本=%d err=%v", version, err)
			}
			actual, input, err := store.request(ctx, task.RequestID)
			if err != nil || actual.ID != run.ID || actual.Status != run.Status || actual.RequestID != task.RequestID || input != canonical {
				t.Fatalf("迁移破坏幂等回读：%+v %q %v", actual, input, err)
			}
			for _, record := range []struct{ table, id, raw string }{{"sessions", session.ID, encode(session)}, {"tasks", task.ID, encode(task)}, {"runs", run.ID, encode(run)}, {"operations", operation.ID, encode(operation)}, {"approvals", approval.ID, encode(approval)}} {
				var raw string
				if err = store.db.QueryRow("SELECT document FROM "+record.table+" WHERE id=?", record.id).Scan(&raw); err != nil || raw != record.raw {
					t.Fatalf("迁移改写%s事实：%s err=%v", record.table, raw, err)
				}
			}
			rows, err := store.db.Query("PRAGMA foreign_key_check")
			if err != nil {
				t.Fatal(err)
			}
			if rows.Next() {
				rows.Close()
				t.Fatal("迁移破坏旧审批的外键引用")
			}
			if err = rows.Close(); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestWorkflowDurabilityQueuedAndApprovedResumeOnce(t *testing.T) {
	for _, state := range []string{"queued", "approved"} {
		t.Run(state, func(t *testing.T) {
			ctx := context.Background()
			var calls atomic.Int32
			m, s := workflowTestManager(t, &operationCatalog{execute: func(context.Context, Operation) (CapabilityResult, error) {
				calls.Add(1)
				return CapabilityResult{Value: json.RawMessage(`{"ok":true}`)}, nil
			}})
			name := "test_write"
			if state == "queued" {
				name = "test_read"
				m.mu.Lock()
				m.store.beforeWrite = func(op string) error {
					if op == "start" {
						return errors.New("注入开始事务前存储故障")
					}
					return nil
				}
				m.mu.Unlock()
			}
			w := workflowStepsTest(t, m, s, workflowOneOperation(name))
			var approval Approval
			if state == "queued" {
				runtimeEventually(t, func() bool { return m.Info().Storage == "unavailable" })
				var err error
				w, err = m.GetWorkflow(ctx, w.ID)
				if err != nil {
					t.Fatal(err)
				}
				if w.Status != StateQueued || calls.Load() != 0 {
					t.Fatalf("落盘失败仍派发：%+v calls=%d", w, calls.Load())
				}
				m = reopenOperationManager(t, m)
			} else {
				w = workflowWait(t, m, w.ID, StateWaitingApproval)
				approval = waitingApproval(t, m, w.ActiveRunID)
				workflowIdle(t, m)
				var paused atomic.Bool
				m.mu.Lock()
				m.deps.DispatchGuard = func() error {
					if paused.Load() {
						return errors.New("验收暂停派发")
					}
					return nil
				}
				m.store.beforeWrite = func(op string) error {
					if op == "approval-decision" {
						paused.Store(true)
					}
					return nil
				}
				m.mu.Unlock()
				if _, err := m.Decide(ctx, approval.ID, "approved"); err != nil {
					t.Fatal(err)
				}
				var err error
				w, err = m.GetWorkflow(ctx, w.ID)
				if err != nil {
					t.Fatal(err)
				}
				if w.Status != StateQueued || calls.Load() != 0 {
					t.Fatalf("审批提交后暂停窗口失效：%+v calls=%d", w, calls.Load())
				}
				if err = m.Close(ctx); err != nil {
					t.Fatal(err)
				}
				paused.Store(false)
				m = reopenOperationManager(t, m)
			}
			w = workflowWait(t, m, w.ID, StateSucceeded)
			if calls.Load() != 1 || w.Usage.Calls != 1 {
				t.Fatalf("恢复重复派发或预算错误：%+v calls=%d", w, calls.Load())
			}
			if approval.ID != "" {
				list, err := m.Approvals(ctx)
				if err != nil {
					t.Fatal(err)
				}
				var consumed bool
				for _, a := range list {
					if a.ID == approval.ID {
						consumed = a.Status == "consumed"
					}
				}
				if !consumed {
					t.Fatal("已批准审批恢复后没有消费原身份")
				}
			}
			m = reopenOperationManager(t, m)
			if got := workflowWait(t, m, w.ID, StateSucceeded); got.OutputJSON != w.OutputJSON || calls.Load() != 1 {
				t.Fatal("成功流程重启后再次执行")
			}
		})
	}
}

func TestWorkflowDurabilityResultWorkspaceAndAdvanceAreAtomic(t *testing.T) {
	for _, fail := range []bool{false, true} {
		name := "提交后重启"
		if fail {
			name = "推进事务故障"
		}
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			files, err := workspace.Open(filepath.Join(t.TempDir(), "workspaces"))
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = files.Close() })
			var calls atomic.Int32
			catalog := &operationCatalog{execute: func(ctx context.Context, o Operation) (CapabilityResult, error) {
				calls.Add(1)
				version, err := files.PrepareWrite(ctx, o.TaskID, o.WorkspaceRevision, "receipt.txt", strings.NewReader("真实工作区结果"))
				return CapabilityResult{Value: json.RawMessage(`{"ok":true}`), Workspace: &version}, err
			}}
			m, s, _ := agentManager(t, func(_ context.Context, _ model.Profile, r model.Request) (model.Response, error) {
				if r.ToolChoice == "store_working_memory" {
					return memoryReply(r), nil
				}
				return finalReply("准备完成"), nil
			}, func(d *Deps) { d.Catalog = catalog; d.Workspaces = files })
			approveEnvironment(t, m, s)
			steps := workflowOneOperation("test_write")
			steps[0].Finish = nil
			steps[0].Next = "verify"
			steps = append(steps, WorkflowStepDefinition{ID: "verify", Kind: "approval", Instruction: "核对已保存结果", Input: workflowTestOutput("act", ""), OutputSchemaJSON: `{"type":"object"}`, Finish: &WorkflowBinding{Step: &WorkflowOutputBinding{StepID: "verify"}}})
			w := workflowStepsTest(t, m, s, steps)
			w = workflowWait(t, m, w.ID, StateWaitingApproval)
			approval := waitingApproval(t, m, w.ActiveRunID)
			firstRun := w.ActiveRunID
			workflowIdle(t, m)
			if fail {
				m.mu.Lock()
				_, err = m.store.db.Exec(`CREATE TEMP TRIGGER reject_workflow_advance BEFORE INSERT ON workflow_events WHEN json_extract(NEW.document,'$.type')='workflow/ready' BEGIN SELECT RAISE(ABORT,'注入结果提交后的推进故障'); END;`)
				m.mu.Unlock()
				if err != nil {
					t.Fatal(err)
				}
			}
			if _, err = m.Decide(ctx, approval.ID, "approved"); err != nil {
				t.Fatal(err)
			}
			if fail {
				runtimeEventually(t, func() bool { return m.Info().Storage == "unavailable" })
				current, err := m.Workspace(ctx, w.TaskID, "")
				if err != nil || current.Version.Revision != 0 || len(current.Files) != 0 {
					t.Fatalf("推进失败仍暴露新工作区：%+v %v", current, err)
				}
				run, err := m.Get(ctx, firstRun)
				if err != nil || run.Status == StateSucceeded {
					t.Fatalf("推进失败仍宣称步骤成功：%+v %v", run, err)
				}
				m = reopenOperationManager(t, m)
				w = workflowWait(t, m, w.ID, StateRecoveryRequired)
				if w.CurrentStepID != "act" || calls.Load() != 1 {
					t.Fatalf("失败后重放或推进：%+v calls=%d", w, calls.Load())
				}
				barriers, err := m.Barriers(ctx)
				if err != nil || len(barriers) != 1 || barriers[0].Status != "unknown" {
					t.Fatalf("未知执行证据丢失：%+v %v", barriers, err)
				}
			} else {
				runtimeEventually(t, func() bool {
					var err error
					w, err = m.GetWorkflow(ctx, w.ID)
					return err == nil && w.CurrentStepID == "verify" && w.Status == StateWaitingApproval
				})
				current, err := m.Workspace(ctx, w.TaskID, "receipt.txt")
				if err != nil || string(current.Content) != "真实工作区结果" || current.Version.Revision < 1 {
					t.Fatalf("已提交结果缺少工作文件：%+v %v", current, err)
				}
				m.mu.Lock()
				attempt, err := readWorkflowAttempt(ctx, m.store.db, firstRun)
				m.mu.Unlock()
				if err != nil || attempt.Status != StateSucceeded || attempt.WorkspaceRevision != current.Version.Revision || attempt.OutputCallID == "" {
					t.Fatalf("完成凭据与文件版本未一起提交：%+v %v", attempt, err)
				}
				m = reopenOperationManager(t, m)
				w = workflowWait(t, m, w.ID, StateWaitingApproval)
				again, err := m.Workspace(ctx, w.TaskID, "receipt.txt")
				if err != nil || again.Version != current.Version || string(again.Content) != string(current.Content) || w.CurrentStepID != "verify" || calls.Load() != 1 {
					t.Fatalf("重启丢失提交窗口或重放：%+v %+v %v", w, again, err)
				}
			}
		})
	}
}

func TestWorkflowDurabilityCrashChargesReservationsOnlyOnce(t *testing.T) {
	ctx := context.Background()
	var calls atomic.Int32
	m, s := workflowTestManager(t, &operationCatalog{execute: func(context.Context, Operation) (CapabilityResult, error) {
		calls.Add(1)
		return CapabilityResult{}, nil
	}})
	w := workflowStepsTest(t, m, s, workflowOneOperation("test_write"))
	w = workflowWait(t, m, w.ID, StateWaitingApproval)
	workflowIdle(t, m)
	runID := w.ActiveRunID
	if err := m.Close(ctx); err != nil {
		t.Fatal(err)
	}
	store, err := openStore(m.deps.Path, m.deps.Now)
	if err != nil {
		t.Fatal(err)
	}
	var reserved int64
	var before WorkflowUsage
	// 构造父进程已将时间/模型/工具预算写入，但尚未保存任何完成回执的崩溃点。
	err = store.write(ctx, "crash-reservation-fixture", func(tx *sql.Tx) error {
		current, err := readWorkflow(ctx, tx, w.ID)
		if err != nil {
			return err
		}
		current.Status = StateRunning
		current.Usage = WorkflowUsage{ActiveMilliseconds: 7000, ModelRequests: 2, Calls: 3, Tokens: 4096, ResultBytes: 8192}
		if err = saveWorkflow(ctx, tx, &current); err != nil {
			return err
		}
		run, err := readRun(ctx, tx, runID)
		if err != nil {
			return err
		}
		run.Status = StateRunning
		run.ActiveMilliseconds = 1000
		isolated := &Manager{store: store}
		if err = isolated.workflowReserveTime(ctx, tx, &run); err != nil {
			return err
		}
		if err = isolated.workflowReserveModel(ctx, tx, &run, 1234); err != nil {
			return err
		}
		if err = isolated.workflowReserveCall(ctx, tx, &run); err != nil {
			return err
		}
		reserved = run.WorkflowActiveReserved
		if err = saveRun(ctx, tx, &run); err != nil {
			return err
		}
		current, err = readWorkflow(ctx, tx, w.ID)
		before = current.Usage
		return err
	})
	if err != nil {
		store.close()
		t.Fatal(err)
	}
	if err = store.close(); err != nil {
		t.Fatal(err)
	}
	m = reopenOperationManager(t, m)
	w = workflowWait(t, m, w.ID, StateRecoveryRequired)
	want := before
	want.ActiveMilliseconds += reserved
	want.ReservedMilliseconds = 0
	if reserved <= 0 || w.Usage != want || calls.Load() != 0 {
		t.Fatalf("崩溃退还了未确认预算：got=%+v want=%+v calls=%d", w.Usage, want, calls.Load())
	}
	run, err := m.Get(ctx, runID)
	if err != nil || run.Status != StateInterrupted || run.WorkflowActiveReserved != 0 || run.ActiveMilliseconds != 1000+reserved {
		t.Fatalf("运行预算未收口：%+v %v", run, err)
	}
	m = reopenOperationManager(t, m)
	if again := workflowWait(t, m, w.ID, StateRecoveryRequired); again.Usage != want || calls.Load() != 0 {
		t.Fatalf("第二次重启重复扣账或派发：%+v calls=%d", again.Usage, calls.Load())
	}
}
