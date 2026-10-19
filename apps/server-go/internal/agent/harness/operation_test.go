package harness

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"elysian/server/internal/agent/harness/model"
	"elysian/server/internal/agent/harness/worker"
	"elysian/server/internal/agent/harness/workspace"
	"elysian/server/internal/agent/jsonvalue"
)

type operationCatalog struct {
	execute func(context.Context, Operation) (CapabilityResult, error)
	check   func(context.Context, Operation) error
}

func (*operationCatalog) Snapshot(_ context.Context, e Environment) (CapabilitySnapshot, error) {
	return CapabilitySnapshot{Environment: e, Tools: []Capability{
		{Name: "test_read", Source: "mcp-tool", Ref: RevisionRef{ID: "fixture-server", Revision: 1, Digest: "fixture-catalog"}, CatalogDigest: "fixture-catalog", ReadOnly: true, Parameters: json.RawMessage(`{"type":"object"}`)},
		{Name: "test_write", Source: "mcp-tool", Ref: RevisionRef{ID: "fixture-server", Revision: 1, Digest: "fixture-catalog"}, CatalogDigest: "fixture-catalog", Parameters: json.RawMessage(`{"type":"object"}`)},
	}}, nil
}
func (*operationCatalog) Validate(_ Capability, args json.RawMessage) error {
	_, err := jsonvalue.Object(args)
	return err
}
func (c *operationCatalog) Check(ctx context.Context, _ CapabilitySnapshot, o Operation) error {
	if c.check != nil {
		return c.check(ctx, o)
	}
	return nil
}
func (c *operationCatalog) Execute(ctx context.Context, _ CapabilitySnapshot, o Operation) (CapabilityResult, error) {
	if c.execute != nil {
		return c.execute(ctx, o)
	}
	return CapabilityResult{Value: json.RawMessage(`{"ok":true}`)}, nil
}
func approveEnvironment(t *testing.T, m *Manager, s Session) {
	t.Helper()
	e, err := m.GetEnvironment(context.Background(), s.ID)
	if err != nil {
		t.Fatal(err)
	}
	e.TrustedReadOnly = []string{"test_read"}
	e.Servers = []RevisionRef{{ID: "fixture-server", Revision: 1, Digest: "fixture-catalog"}}
	if _, err = m.PutEnvironment(context.Background(), s.ID, e.Revision, e); err != nil {
		t.Fatal(err)
	}
}
func waitingApproval(t *testing.T, m *Manager, id string) Approval {
	t.Helper()
	var found Approval
	runtimeEventually(t, func() bool {
		list, err := m.Approvals(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		for _, a := range list {
			if a.RunID == id && a.Status == "pending" {
				found = a
				return true
			}
		}
		return false
	})
	return found
}

// 假模型也遵守先搜索再调用；搜索回执不当作业务完成结果。
func missingOperationTools(r model.Request, names ...string) bool {
	for _, name := range names {
		if !contains(toolNames(r), name) {
			return true
		}
	}
	return false
}
func businessToolResult(_ model.Request, message model.Message) bool {
	if message.Role != "tool" {
		return false
	}
	var result toolSearchResult
	var envelope struct {
		Result json.RawMessage `json:"result"`
	}
	if json.Unmarshal([]byte(message.Content), &envelope) != nil {
		return true
	}
	return json.Unmarshal(envelope.Result, &result) != nil || (result.Version != onDemandTools && result.Version != onDemandToolsV2)
}
func operationClient() agentTestClient {
	return func(_ context.Context, _ model.Profile, r model.Request) (model.Response, error) {
		if r.ToolChoice == "store_working_memory" {
			return memoryReply(r), nil
		}
		if missingOperationTools(r, "test_write") {
			return searchReply("test"), nil
		}
		for _, msg := range r.Messages {
			if businessToolResult(r, msg) {
				return finalReply("已核实本次操作"), nil
			}
		}
		return toolReply("test_write"), nil
	}
}
func reopenOperationManager(t *testing.T, m *Manager) *Manager {
	t.Helper()
	d := m.deps
	if err := m.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	next, err := New(d)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := next.Close(context.Background()); err != nil {
			t.Error(err)
		}
	})
	runtimeEventually(t, func() bool { return next.Info().Agent.Available })
	return next
}

func TestOperationApprovalResumesRealWorkerWithoutReplayingTools(t *testing.T) {
	ctx := context.Background()
	var reads, writes, inferences atomic.Int32
	cat := &operationCatalog{execute: func(_ context.Context, o Operation) (CapabilityResult, error) {
		if o.Capability.Name == "test_read" {
			reads.Add(1)
		} else {
			writes.Add(1)
			if o.ArgumentsJSON != `{"n":9007199254740993}` {
				t.Errorf("参数精度丢失：%s", o.ArgumentsJSON)
			}
		}
		return CapabilityResult{Value: json.RawMessage(`{"done":true}`)}, nil
	}}
	m, s, _ := agentManager(t, func(_ context.Context, _ model.Profile, r model.Request) (model.Response, error) {
		if r.ToolChoice == "store_working_memory" {
			return memoryReply(r), nil
		}
		inferences.Add(1)
		if missingOperationTools(r, "test_read", "test_write") {
			return searchReply("test"), nil
		}
		for _, msg := range r.Messages {
			if strings.Contains(msg.Content, "另一会话") {
				return finalReply("另一会话可运行"), nil
			}
			if businessToolResult(r, msg) {
				return finalReply("串行完成"), nil
			}
		}
		rsp := toolReply("test_read", "test_write")
		rsp.ToolCalls[1].Arguments = json.RawMessage(`{"n":9007199254740993}`)
		return rsp, nil
	}, func(d *Deps) {
		d.Catalog = cat
		d.Spawn = func(c context.Context) (worker.Process, error) {
			return worker.Spawn(c, worker.Options{Path: os.Args[0], Args: []string{"-test.run=^TestRuntimeWorkerHelper$"}, Env: []string{"HOME=/tmp", "ELYSIAN_RUNTIME_TEST_CHILD=1"}})
		}
	})
	approveEnvironment(t, m, s)
	run := submitAgentTest(t, m, s, "approval-serial", "执行两个操作")
	a := waitingApproval(t, m, run.ID)
	if reads.Load() != 1 || writes.Load() != 0 || a.Operation.CallIndex != 1 {
		t.Fatalf("提前执行或顺序错误：%+v", a)
	}
	_, _, err := m.CreateTask(ctx, s.ID, AgentInput{RequestID: "busy", Content: "补充"})
	runtimeErrorCode(t, err, "session-busy")
	e, _ := m.GetEnvironment(ctx, s.ID)
	_, err = m.PutEnvironment(ctx, s.ID, e.Revision, e)
	runtimeErrorCode(t, err, "session-busy")
	dup, repeated, err := m.CreateTask(ctx, s.ID, AgentInput{RequestID: "approval-serial", Content: "执行两个操作"})
	if err != nil || !repeated || dup.ID != run.ID {
		t.Fatalf("busy期间幂等丢失：%v", err)
	}
	other, err := m.CreateSession(ctx, CreateSessionInput{Title: "第二会话", ModelProfileID: s.ModelProfileID, ModelRevision: s.ModelRevision})
	if err != nil {
		t.Fatal(err)
	}
	otherRun := submitAgentTest(t, m, other, "other-session", "另一会话")
	if got := runtimeFinished(t, m, otherRun.ID); got.Status != StateSucceeded {
		t.Fatalf("审批未释放执行槽：%+v", got)
	}
	if _, err = m.Decide(ctx, a.ID, "approved"); err != nil {
		t.Fatal(err)
	}
	if _, err = m.Decide(ctx, a.ID, "approved"); err != nil {
		t.Fatal(err)
	}
	_, err = m.Decide(ctx, a.ID, "denied")
	runtimeErrorCode(t, err, "decision-conflict")
	got := runtimeFinished(t, m, run.ID)
	if got.Status != StateSucceeded || got.Usage.Calls != 3 || got.Usage.ModelRequests != 4 || reads.Load() != 1 || writes.Load() != 1 || inferences.Load() != 5 {
		t.Fatalf("恢复重放或预算重置：%+v read=%d write=%d inference=%d", got, reads.Load(), writes.Load(), inferences.Load())
	}
	ops, err := m.Operations(ctx, run.ID)
	if err != nil || len(ops) != 3 || ops[2].Status != "completed" {
		t.Fatalf("操作结果未落盘：%+v %v", ops, err)
	}
}

func TestOperationApprovalDecisionBeforeWorkerSuspends(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	var first atomic.Bool
	m, s, _ := agentManager(t, operationClient(), func(d *Deps) {
		d.Catalog = &operationCatalog{}
		d.Spawn = func(context.Context) (worker.Process, error) {
			return &agentTestProcess{runAgent: func(ctx context.Context, id string, b worker.AgentBroker) error {
				p := &agentTestProcess{}
				err := p.RunAgent(ctx, id, b)
				if errors.Is(err, worker.ErrSuspended) && first.CompareAndSwap(false, true) {
					close(entered)
					<-release
				}
				return err
			}}, nil
		}
	})
	run := submitAgentTest(t, m, s, "fast-decision", "执行操作")
	a := waitingApproval(t, m, run.ID)
	<-entered
	if _, err := m.Decide(context.Background(), a.ID, "approved"); err != nil {
		close(release)
		t.Fatal(err)
	}
	close(release)
	if got := runtimeFinished(t, m, run.ID); got.Status != StateSucceeded {
		t.Fatalf("批准早于挂起确认导致错误终态：%+v", got)
	}
}

func TestOperationPendingAndApprovedSurviveRestart(t *testing.T) {
	for _, approved := range []bool{false, true} {
		t.Run(map[bool]string{false: "pending", true: "approved"}[approved], func(t *testing.T) {
			var calls atomic.Int32
			cat := &operationCatalog{execute: func(context.Context, Operation) (CapabilityResult, error) {
				calls.Add(1)
				return CapabilityResult{Value: json.RawMessage(`{}`)}, nil
			}}
			m, s, _ := agentManager(t, operationClient(), func(d *Deps) { d.Catalog = cat })
			run := submitAgentTest(t, m, s, "restart", "执行操作")
			a := waitingApproval(t, m, run.ID)
			runtimeEventually(t, func() bool { m.mu.Lock(); defer m.mu.Unlock(); return m.activeID == "" })
			if approved {
				// 保留决定事务，但在它发出的唤醒到来前阻止旧进程重新取队列。
				var checks atomic.Int32
				m.mu.Lock()
				m.deps.DispatchGuard = func() error {
					if checks.Add(1) > 1 {
						return bad("maintenance-active", "维护中")
					}
					return nil
				}
				m.mu.Unlock()
				if _, err := m.Decide(context.Background(), a.ID, "approved"); err != nil {
					t.Fatal(err)
				}
			}
			d := m.deps
			if err := m.Close(context.Background()); err != nil {
				t.Fatal(err)
			}
			d.DispatchGuard = nil
			m, err := New(d)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = m.Close(context.Background()) })
			if !approved {
				a = waitingApproval(t, m, run.ID)
				if _, err = m.Decide(context.Background(), a.ID, "approved"); err != nil {
					t.Fatal(err)
				}
			}
			if got := runtimeFinished(t, m, run.ID); got.Status != StateSucceeded || calls.Load() != 1 {
				t.Fatalf("重启恢复失败：%+v calls=%d", got, calls.Load())
			}
		})
	}
}

func TestOperationDenyCancelExpireAndRevoke(t *testing.T) {
	for _, action := range []string{"deny", "cancel", "expire", "revoke"} {
		t.Run(action, func(t *testing.T) {
			var calls atomic.Int32
			cat := &operationCatalog{execute: func(context.Context, Operation) (CapabilityResult, error) {
				calls.Add(1)
				return CapabilityResult{}, nil
			}}
			m, s, _ := agentManager(t, operationClient(), func(d *Deps) { d.Catalog = cat })
			run := submitAgentTest(t, m, s, "decision", "执行操作")
			a := waitingApproval(t, m, run.ID)
			ctx := context.Background()
			var err error
			switch action {
			case "deny":
				_, err = m.Decide(ctx, a.ID, "denied")
			case "cancel":
				_, err = m.Cancel(ctx, run.ID)
			case "expire":
				m.mu.Lock()
				err = m.store.write(ctx, "expire-fixture", func(tx *sql.Tx) error {
					a.ExpiresAt = stamp(time.Now().Add(-time.Hour))
					raw, _ := json.Marshal(a)
					_, e := tx.ExecContext(ctx, "UPDATE approvals SET expires_at=?,document=? WHERE id=?", a.ExpiresAt, string(raw), a.ID)
					return e
				})
				m.mu.Unlock()
				if err == nil {
					_, err = m.Approvals(ctx)
				}
			case "revoke":
				err = m.Revoke(ctx, "mcp", "fixture-server", 1, "测试撤销")
				if err == nil {
					_, err = m.Decide(ctx, a.ID, "approved")
				}
			}
			if err != nil {
				t.Fatal(err)
			}
			got := runtimeFinished(t, m, run.ID)
			if got.Status == StateSucceeded || calls.Load() != 0 || got.MemoryStatus != "stale" {
				t.Fatalf("未授权派发或伪造成功：%+v calls=%d", got, calls.Load())
			}
			messages, err := m.Messages(ctx, s.ID, "", 20)
			if err != nil || len(messages.Items) != 1 {
				t.Fatalf("失败生成公开终答：%+v %v", messages, err)
			}
		})
	}
}

func TestOperationUnknownBarrierPersistsAndReconciliationDoesNotRewriteResult(t *testing.T) {
	ctx := context.Background()
	var executions atomic.Int32
	cat := &operationCatalog{execute: func(context.Context, Operation) (CapabilityResult, error) {
		executions.Add(1)
		return CapabilityResult{Unknown: true}, nil
	}}
	m, s, _ := agentManager(t, operationClient(), func(d *Deps) { d.Catalog = cat })
	run := submitAgentTest(t, m, s, "unknown", "执行操作")
	a := waitingApproval(t, m, run.ID)
	if _, err := m.Decide(ctx, a.ID, "approved"); err != nil {
		t.Fatal(err)
	}
	if got := runtimeFinished(t, m, run.ID); got.EndReason != "outcome-unknown" {
		t.Fatalf("丢失未知结果：%+v", got)
	}
	m = reopenOperationManager(t, m)
	barriers, err := m.Barriers(ctx)
	if err != nil || len(barriers) != 1 || barriers[0].Status != "unknown" {
		t.Fatalf("重启丢失屏障：%+v %v", barriers, err)
	}
	run2 := submitAgentTest(t, m, s, "blocked-write", "再执行")
	a = waitingApproval(t, m, run2.ID)
	if _, err = m.Decide(ctx, a.ID, "approved"); err != nil {
		t.Fatal(err)
	}
	runtimeEventually(t, func() bool {
		got, err := m.Get(ctx, run2.ID)
		return err == nil && got.Status == StateWaitingResource
	})
	if got, err := m.Get(ctx, run2.ID); err != nil || got.Usage.Calls != 1 || executions.Load() != 1 {
		t.Fatalf("屏障未阻止派发或资源等待消耗工具预算：%+v %v", got, err)
	}
	b := barriers[0]
	if _, err = m.Reconcile(ctx, b.ID, "外部审计确认已停止", "confirmed-stopped"); err != nil {
		t.Fatal(err)
	}
	if got := runtimeFinished(t, m, run2.ID); got.EndReason != "outcome-unknown" || executions.Load() != 2 {
		t.Fatalf("核实后未从原审批位置恢复：%+v", got)
	}
	if _, err = m.Reconcile(ctx, b.ID, "外部审计确认已停止", "confirmed-stopped"); err != nil {
		t.Fatal(err)
	}
	_, err = m.Reconcile(ctx, b.ID, "另一个结论", "confirmed-completed")
	runtimeErrorCode(t, err, "decision-conflict")
	ops, err := m.Operations(ctx, run.ID)
	if err != nil || ops[1].Status != "unknown" {
		t.Fatalf("核实篡改原结果：%+v %v", ops, err)
	}
}

func TestCapabilitiesMigrateV2WithoutChangingAcceptedRun(t *testing.T) {
	path := filepath.Join(t.TempDir(), "v2.sqlite")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(schema + sessionSchema + "PRAGMA user_version=2;"); err != nil {
		t.Fatal(err)
	}
	_ = db.Close()
	s, err := openStore(path, time.Now)
	if err != nil {
		t.Fatal(err)
	}
	defer s.close()
	var version int
	if err = s.db.QueryRow("PRAGMA user_version").Scan(&version); err != nil || version != schemaVersion {
		t.Fatalf("迁移失败：%d %v", version, err)
	}
	for _, table := range []string{"operations", "approvals", "execution_barriers", "environments", "context_items", "workspace_versions", "capability_revocations"} {
		var n int
		if err = s.db.QueryRow("SELECT count(*) FROM " + table).Scan(&n); err != nil {
			t.Fatal(err)
		}
	}
}

func TestOperationResultStorageFailureLeavesRestartBarrier(t *testing.T) {
	var calls atomic.Int32
	m, s, _ := agentManager(t, operationClient(), func(d *Deps) {
		d.Catalog = &operationCatalog{execute: func(context.Context, Operation) (CapabilityResult, error) {
			calls.Add(1)
			return CapabilityResult{Value: json.RawMessage(`{"ok":true}`)}, nil
		}}
	})
	run := submitAgentTest(t, m, s, "disk-failure-write", "执行写操作")
	a := waitingApproval(t, m, run.ID)
	m.mu.Lock()
	m.store.beforeWrite = func(op string) error {
		if op == "operation-result" {
			return errors.New("注入磁盘故障")
		}
		return nil
	}
	m.mu.Unlock()
	if _, err := m.Decide(context.Background(), a.ID, "approved"); err != nil {
		t.Fatal(err)
	}
	runtimeEventually(t, func() bool { return m.Info().Storage == "unavailable" })
	m = reopenOperationManager(t, m)
	got, err := m.Get(context.Background(), run.ID)
	if err != nil || got.Status != StateInterrupted || calls.Load() != 1 {
		t.Fatalf("存储失败后自动重放：%+v %v calls=%d", got, err, calls.Load())
	}
	barriers, err := m.Barriers(context.Background())
	if err != nil || len(barriers) != 1 || barriers[0].Status != "unknown" {
		t.Fatalf("存储失败丢失派发证据：%+v %v", barriers, err)
	}
}

func TestOperationResultCommittedBeforeWorkerLossIsNeverReplayed(t *testing.T) {
	var calls atomic.Int32
	m, s, _ := agentManager(t, operationClient(), func(d *Deps) {
		d.Catalog = &operationCatalog{execute: func(context.Context, Operation) (CapabilityResult, error) {
			calls.Add(1)
			return CapabilityResult{Value: json.RawMessage(`{}`)}, nil
		}}
		d.Spawn = func(context.Context) (worker.Process, error) {
			return &agentTestProcess{runAgent: func(ctx context.Context, _ string, b worker.AgentBroker) error {
				for {
					r, err := b.NextModel(ctx)
					if err != nil {
						return err
					}
					call := r.ToolCalls[r.StartIndex]
					if err = b.ExecuteAgent(ctx, r.ID, r.StartIndex, call.ID, call.Name, call.Args); err != nil {
						return err
					}
					if call.Name == toolSearchName {
						continue
					}
					return &worker.InterruptedError{Err: errors.New("结果落盘后Worker崩溃")}
				}
			}}, nil
		}
	})
	run := submitAgentTest(t, m, s, "worker-result-loss", "执行写操作")
	a := waitingApproval(t, m, run.ID)
	if _, err := m.Decide(context.Background(), a.ID, "approved"); err != nil {
		t.Fatal(err)
	}
	if got := runtimeFinished(t, m, run.ID); got.Status != StateInterrupted {
		t.Fatalf("工作进程崩溃伪造成功：%+v", got)
	}
	m = reopenOperationManager(t, m)
	ops, err := m.Operations(context.Background(), run.ID)
	if err != nil || len(ops) != 2 || ops[1].Status != "completed" || calls.Load() != 1 {
		t.Fatalf("已保存结果被重复执行：%+v %v", ops, err)
	}
}

func TestOperationApprovalWaitDoesNotConsumeActiveTime(t *testing.T) {
	var nanos atomic.Int64
	nanos.Store(time.Now().UnixNano())
	client := operationClient()
	m, s, _ := agentManager(t, func(ctx context.Context, p model.Profile, r model.Request) (model.Response, error) {
		nanos.Add(int64(time.Second))
		return client(ctx, p, r)
	}, func(d *Deps) {
		d.Catalog = &operationCatalog{}
		d.Now = func() time.Time { return time.Unix(0, nanos.Load()) }
	})
	run := submitAgentTest(t, m, s, "active-budget", "执行操作")
	a := waitingApproval(t, m, run.ID)
	runtimeEventually(t, func() bool { m.mu.Lock(); defer m.mu.Unlock(); return m.activeID == "" })
	before, _ := m.Get(context.Background(), run.ID)
	if before.ActiveMilliseconds != 2000 {
		t.Fatalf("首段活动时间错误：%d", before.ActiveMilliseconds)
	}
	nanos.Add(int64(12 * time.Hour))
	if _, err := m.Decide(context.Background(), a.ID, "approved"); err != nil {
		t.Fatal(err)
	}
	got := runtimeFinished(t, m, run.ID)
	if got.Status != StateSucceeded || got.ActiveMilliseconds != 4000 || got.Usage.ModelRequests != 4 {
		t.Fatalf("暂停时间或预算不正确：%+v", got)
	}
}

func TestOperationWorkspaceCannotCommitAnotherTask(t *testing.T) {
	files, err := workspace.Open(filepath.Join(t.TempDir(), "workspaces"))
	if err != nil {
		t.Fatal(err)
	}
	defer files.Close()
	foreign, err := files.PrepareWrite(context.Background(), "another-task", 0, "file.txt", strings.NewReader("保留其他任务内容"))
	if err != nil {
		t.Fatal(err)
	}
	m, s, _ := agentManager(t, operationClient(), func(d *Deps) {
		d.Workspaces = files
		d.Catalog = &operationCatalog{execute: func(context.Context, Operation) (CapabilityResult, error) {
			return CapabilityResult{Value: json.RawMessage(`{}`), Workspace: &foreign}, nil
		}}
	})
	run := submitAgentTest(t, m, s, "wrong-workspace", "执行操作")
	a := waitingApproval(t, m, run.ID)
	if _, err = m.Decide(context.Background(), a.ID, "approved"); err != nil {
		t.Fatal(err)
	}
	if got := runtimeFinished(t, m, run.ID); got.EndReason != "workspace-result-invalid" {
		t.Fatalf("错误接受跨任务文件：%+v", got)
	}
	m.mu.Lock()
	var count int
	err = m.store.db.QueryRow("SELECT count(*) FROM workspace_versions").Scan(&count)
	m.mu.Unlock()
	if err != nil || count != 0 {
		t.Fatalf("错误结果推进了工作区：%d %v", count, err)
	}
}
