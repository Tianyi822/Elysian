package harness

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"elysian/server/internal/agent/harness/model"
)

func sessionStoreFixture(t *testing.T, s *store, suffix string, at time.Time) (Session, Task, Run) {
	t.Helper()
	session := Session{ID: "session-" + suffix, Title: "检查容器", CreatedAt: stamp(at), LastActivityAt: stamp(at), ModelProfileID: "model-one", ModelRevision: 1, LastSeq: "0"}
	if err := s.createSession(context.Background(), session); err != nil {
		t.Fatal(err)
	}
	task := Task{ID: "task-" + suffix, SessionID: session.ID, RequestID: "request-" + suffix, Kind: "agent", DriverVersion: "v1", CreatedAt: stamp(at), Goal: "检查容器"}
	run := Run{ID: "run-" + suffix, SessionID: session.ID, TaskID: task.ID, RequestID: task.RequestID, Input: task.Goal, Status: StateQueued, CreatedAt: stamp(at), LastSeq: "0", Limits: DefaultAgentLimits(), Model: &model.Profile{ID: session.ModelProfileID, Revision: 1, Credential: "should-not-persist"}}
	return session, task, run
}

func acceptSessionTestRun(t *testing.T, s *store, task Task, run Run, newTask bool) Run {
	t.Helper()
	accepted, duplicate, err := s.acceptAgent(context.Background(), task, run, `{"input":"`+run.RequestID+`"}`, "message-"+run.ID, newTask)
	if err != nil || duplicate {
		t.Fatalf("接受任务失败：%+v %t %v", accepted, duplicate, err)
	}
	return accepted
}

func finishSessionTestRun(t *testing.T, s *store, id, answer string, memory *WorkingMemory) Run {
	t.Helper()
	ctx := context.Background()
	run, err := s.change(ctx, id, "finish-test", func(tx *sql.Tx, r *Run) error {
		r.Status = StateSucceeded
		r.EndedAt = stamp(s.now())
		r.MemoryStatus = "stale"
		if err := s.finalizeAgent(ctx, tx, r, answer, memory); err != nil {
			return err
		}
		return s.event(ctx, tx, r, "run/succeeded", "", nil, nil)
	})
	if err != nil {
		t.Fatal(err)
	}
	return run
}

func TestSessionStoreMigratesV1WithoutLosingIdempotency(t *testing.T) {
	path := filepath.Join(t.TempDir(), "old.sqlite")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(schema); err != nil {
		t.Fatal(err)
	}
	task := Task{ID: "old-task", RequestID: "old-request", Kind: "tool-batch", DriverVersion: "v1", Steps: []Step{{Tool: "docker_policy_view", Args: map[string]any{}}}}
	run := Run{ID: "old-run", TaskID: task.ID, Status: StateQueued, LastSeq: "0"}
	tb, _ := json.Marshal(task)
	rb, _ := json.Marshal(run)
	if _, err = db.Exec("INSERT INTO tasks(id,request_id,input,document) VALUES(?,?,?,?)", task.ID, task.RequestID, "old-input", string(tb)); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec("INSERT INTO runs(id,task_id,state,created_at,document) VALUES(?,?,?,?,?)", run.ID, task.ID, run.Status, "2026-10-01T00:00:00Z", string(rb)); err != nil {
		t.Fatal(err)
	}
	if err = db.Close(); err != nil {
		t.Fatal(err)
	}
	s, err := openStore(path, time.Now)
	if err != nil {
		t.Fatal(err)
	}
	defer s.close()
	actual, input, err := s.request(context.Background(), task.RequestID)
	if err != nil || input != "old-input" || actual.RequestID != task.RequestID || actual.RunNumber != 1 || actual.Task.ID != task.ID {
		t.Fatalf("迁移改变了原有请求：%+v %q %v", actual, input, err)
	}
	var version int
	if err = s.db.QueryRow("PRAGMA user_version").Scan(&version); err != nil || version != schemaVersion {
		t.Fatalf("迁移版本错误：%d %v", version, err)
	}
	if err = s.close(); err != nil {
		t.Fatal(err)
	}
	s, err = openStore(path, time.Now)
	if err != nil {
		t.Fatal(err)
	}
	defer s.close()
	if _, _, err = s.request(context.Background(), task.RequestID); err != nil {
		t.Fatal(err)
	}
}

func TestSessionStoreConcurrentDedupAndBusyAreAtomic(t *testing.T) {
	s, _ := openRuntimeTestStore(t)
	session, task, run := sessionStoreFixture(t, s, "one", runtimeStoreTestTime)
	const count = 8
	results := make(chan error, count)
	var wg sync.WaitGroup
	for i := 0; i < count; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, _, err := s.acceptAgent(context.Background(), task, run, "same-input", "same-message", true)
			if err == nil && (r.ID != run.ID || r.RunNumber != 1) {
				err = errors.New("重复提交返回不同运行")
			}
			results <- err
		}()
	}
	wg.Wait()
	close(results)
	for err := range results {
		if err != nil {
			t.Fatal(err)
		}
	}
	for _, table := range []string{"tasks", "runs", "messages"} {
		if n := runtimeStoreCount(t, s, table); n != 1 {
			t.Fatalf("重复提交写入多条 %s：%d", table, n)
		}
	}
	if _, _, err := s.acceptAgent(context.Background(), task, run, "different-input", "other-message", true); err == nil {
		t.Fatal("冲突请求未拒绝")
	}
	other := run
	other.ID = "run-other"
	other.RequestID = "request-other"
	if _, _, err := s.acceptAgent(context.Background(), task, other, "other-input", "other-message", false); err == nil {
		t.Fatal("忙碌会话接受了输入")
	}
	stored, err := readSession(context.Background(), s.db, session.ID)
	if err != nil || stored.ActiveRunID != run.ID || stored.LastSeq != "1" {
		t.Fatalf("会话忙碌或消息不一致：%+v %v", stored, err)
	}
	var raw string
	if err = s.db.QueryRow("SELECT document FROM runs WHERE id=?", run.ID).Scan(&raw); err != nil || strings.Contains(raw, "should-not-persist") {
		t.Fatalf("运行快照包含凭据：%v", err)
	}
}

func TestSessionStoreMultiRunKeepsHistoryMemoryAndModelSnapshots(t *testing.T) {
	s, _ := openRuntimeTestStore(t)
	session, task, input := sessionStoreFixture(t, s, "multi", runtimeStoreTestTime)
	first := acceptSessionTestRun(t, s, task, input, true)
	memory := WorkingMemory{TaskID: task.ID, Revision: 1, Objective: task.Goal, Coverage: MemoryCursor{RunNumber: 1, EventSeq: "1"}, Facts: []MemoryFact{}, Constraints: []string{}, Todos: []string{}, OpenQuestions: []string{}}
	finishSessionTestRun(t, s, first.ID, "第一轮答复", &memory)
	switched, err := s.switchModel(context.Background(), session.ID, "model-two", 3)
	if err != nil || switched.ActiveRunID != "" {
		t.Fatalf("空闲模型切换失败：%+v %v", switched, err)
	}
	next := input
	next.ID = "next-run"
	next.RequestID = "next-request"
	next.Input = "继续检查"
	next.Model = &model.Profile{ID: "model-two", Revision: 3}
	second := acceptSessionTestRun(t, s, task, next, false)
	if second.RunNumber != 2 || second.InitialMemoryRevision != 1 || second.HistorySeq != "2" {
		t.Fatalf("续轮输入快照错误：%+v", second)
	}
	old, _, err := s.request(context.Background(), first.RequestID)
	if err != nil || old.ID != first.ID || old.Model.ID != "model-one" {
		t.Fatalf("旧请求没有返回原运行：%+v %v", old, err)
	}
	if _, err = s.switchModel(context.Background(), session.ID, "model-three", 1); err == nil {
		t.Fatal("运行中允许切换模型")
	}
	finishSessionTestRun(t, s, second.ID, "第二轮答复", nil)
	stored, err := s.memory(context.Background(), task.ID, 0)
	if err != nil || stored.Revision != 1 {
		t.Fatalf("stale收尾覆盖了有效记忆：%+v %v", stored, err)
	}
	page, err := s.messages(context.Background(), session.ID, "0", 2)
	if err != nil || len(page.Items) != 2 || !page.HasMore || page.NextCursor != "2" {
		t.Fatalf("历史分页错误：%+v %v", page, err)
	}
	page, err = s.messages(context.Background(), session.ID, page.NextCursor, 2)
	if err != nil || len(page.Items) != 2 || page.HasMore || page.Items[1].Content != "第二轮答复" {
		t.Fatalf("历史续页错误：%+v %v", page, err)
	}
	if _, err = s.messages(context.Background(), session.ID, "99", 2); err == nil {
		t.Fatal("超前历史游标没有拒绝")
	}
	if n := runtimeStoreCount(t, s, "tasks"); n != 1 {
		t.Fatalf("续轮创建了新Task：%d", n)
	}
}

func TestSessionStoreMemoryKeepsLongObjectiveInTaskOnly(t *testing.T) {
	s, _ := openRuntimeTestStore(t)
	_, task, input := sessionStoreFixture(t, s, "long-objective", runtimeStoreTestTime)
	task.Goal = strings.Repeat("a", 32*1024)
	input.Input = task.Goal
	run := acceptSessionTestRun(t, s, task, input, true)
	memory := WorkingMemory{Revision: 1, Objective: task.Goal, MemoryStatus: "updated", Summary: "已核验容器状态"}
	finishSessionTestRun(t, s, run.ID, "检查完成", &memory)
	var raw string
	if err := s.db.QueryRow("SELECT document FROM working_memories WHERE task_id=?", task.ID).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	if len(raw) >= 16*1024 || strings.Contains(raw, `"objective"`) || strings.Contains(raw, `"memoryStatus"`) {
		t.Fatal("工作记忆快照重复持久化了任务目标或派生状态")
	}
	stored, err := s.memory(context.Background(), task.ID, 1)
	if err != nil || stored.Objective != task.Goal || stored.Summary != memory.Summary {
		t.Fatalf("工作记忆未从任务读取完整目标：目标长度=%d %v", len(stored.Objective), err)
	}
}

func TestSessionStoreFinalizationRollsBackAnswerMemoryAndBusyTogether(t *testing.T) {
	s, _ := openRuntimeTestStore(t)
	session, task, input := sessionStoreFixture(t, s, "atomic", runtimeStoreTestTime)
	run := acceptSessionTestRun(t, s, task, input, true)
	ctx := context.Background()
	if _, err := s.db.Exec("CREATE TRIGGER fail_memory BEFORE INSERT ON working_memories BEGIN SELECT RAISE(ABORT,'test-write-failure'); END"); err != nil {
		t.Fatal(err)
	}
	_, err := s.change(ctx, run.ID, "finalize-test", func(tx *sql.Tx, r *Run) error {
		r.Status = StateSucceeded
		r.EndedAt = stamp(s.now())
		if err := s.finalizeAgent(ctx, tx, r, "不能提前公开", &WorkingMemory{Revision: 1, Objective: task.Goal}); err != nil {
			return err
		}
		return s.event(ctx, tx, r, "run/succeeded", "", nil, nil)
	})
	if err == nil {
		t.Fatal("注入记忆写入错误没有失败")
	}
	actual, err := s.get(ctx, run.ID)
	if err != nil || actual.Status != StateQueued {
		t.Fatalf("失败事务泄露终态：%+v %v", actual, err)
	}
	current, err := readSession(ctx, s.db, session.ID)
	if err != nil || current.ActiveRunID != run.ID || current.LastSeq != "1" {
		t.Fatalf("失败事务释放busy或泄露答复：%+v %v", current, err)
	}
	if runtimeStoreCount(t, s, "messages") != 1 || runtimeStoreCount(t, s, "working_memories") != 0 {
		t.Fatal("失败事务留下部分结果")
	}
}

func TestSessionStoreRecoveryReleasesRunningSessionButKeepsQueuedBusy(t *testing.T) {
	s, _ := openRuntimeTestStore(t)
	_, task, input := sessionStoreFixture(t, s, "running", runtimeStoreTestTime)
	run := acceptSessionTestRun(t, s, task, input, true)
	_, queuedTask, queuedInput := sessionStoreFixture(t, s, "queued", runtimeStoreTestTime)
	queued := acceptSessionTestRun(t, s, queuedTask, queuedInput, true)
	ctx := context.Background()
	_, err := s.change(ctx, run.ID, "start", func(tx *sql.Tx, r *Run) error {
		r.Status = StateRunning
		actual, cached := 123, 45
		r.Usage.ActualTokens = &actual
		r.Usage.CachedTokens = &cached
		if err := saveModelRequest(ctx, tx, ModelRequestRecord{ID: "model-completed", RunID: r.ID, Index: 0, Status: StateSucceeded, Response: &model.Response{Usage: model.Usage{TotalTokens: &actual, CachedTokens: &cached}}}); err != nil {
			return err
		}
		if err := saveModelRequest(ctx, tx, ModelRequestRecord{ID: "model-request", RunID: r.ID, Index: 1, Status: StateRunning}); err != nil {
			return err
		}
		return s.event(ctx, tx, r, "run/started", "", nil, nil)
	})
	if err != nil {
		t.Fatal(err)
	}
	if err = s.recover(ctx); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct{ id, busy string }{{run.SessionID, ""}, {queued.SessionID, queued.ID}} {
		session, err := readSession(ctx, s.db, test.id)
		if err != nil || session.ActiveRunID != test.busy {
			t.Fatalf("恢复会话状态错误：%+v %v", session, err)
		}
	}
	requests, err := s.modelRequests(ctx, run.ID, "", 50)
	if err != nil || len(requests.Items) != 2 || requests.Items[1].Status != StateInterrupted || requests.Items[0].Response.Usage.TotalTokens == nil {
		t.Fatalf("中断请求没有恢复：%+v %v", requests, err)
	}
	actual, err := s.get(ctx, run.ID)
	if err != nil || actual.Usage.ActualTokens != nil || actual.Usage.CachedTokens != nil {
		t.Fatalf("恢复把部分usage伪装成完整总量：%+v %v", actual.Usage, err)
	}
}

func TestSessionStoreInterruptedRequestInvalidatesAggregateUsage(t *testing.T) {
	for _, reason := range []string{"tool-unresponsive", "worker-lost", "completed"} {
		t.Run(reason, func(t *testing.T) {
			s, _ := openRuntimeTestStore(t)
			_, task, input := sessionStoreFixture(t, s, reason, runtimeStoreTestTime)
			run := acceptSessionTestRun(t, s, task, input, true)
			ctx := context.Background()
			_, err := s.change(ctx, run.ID, "request-start", func(tx *sql.Tx, r *Run) error {
				r.Status = StateRunning
				actual, cached := 100, 10
				r.Usage.ActualTokens = &actual
				r.Usage.CachedTokens = &cached
				state := StateRunning
				if reason == "completed" {
					state = StateSucceeded
				}
				if err := saveModelRequest(ctx, tx, ModelRequestRecord{ID: "pending-request", RunID: r.ID, Index: 0, Status: state}); err != nil {
					return err
				}
				return s.event(ctx, tx, r, "model/started", "", nil, nil)
			})
			if err != nil {
				t.Fatal(err)
			}
			_, err = s.change(ctx, run.ID, "interrupted", func(tx *sql.Tx, r *Run) error {
				r.Status = StateInterrupted
				r.EndReason = reason
				r.EndedAt = stamp(s.now())
				return s.event(ctx, tx, r, "run/interrupted", "", nil, nil)
			})
			if err != nil {
				t.Fatal(err)
			}
			actual, err := s.get(ctx, run.ID)
			if err != nil {
				t.Fatal(err)
			}
			if reason == "completed" {
				if actual.Usage.ActualTokens == nil || actual.Usage.CachedTokens == nil {
					t.Fatal("已完成请求的已知usage被误清除")
				}
			} else if actual.Usage.ActualTokens != nil || actual.Usage.CachedTokens != nil {
				t.Fatalf("%s保留了部分usage：%+v", reason, actual.Usage)
			}
		})
	}
}

func TestSessionStoreRetentionKeepsWholeActiveSession(t *testing.T) {
	s, _ := openRuntimeTestStore(t)
	ctx := context.Background()
	past := runtimeStoreTestTime.Add(-40 * 24 * time.Hour)
	for _, suffix := range []string{"expire", "recent", "busy"} {
		_, task, input := sessionStoreFixture(t, s, suffix, past)
		run := acceptSessionTestRun(t, s, task, input, true)
		if suffix != "busy" {
			s.now = func() time.Time { return past }
			finishSessionTestRun(t, s, run.ID, "历史答复", &WorkingMemory{Revision: 1, Objective: task.Goal})
			s.now = func() time.Time { return runtimeStoreTestTime }
		}
		if suffix == "recent" {
			if _, err := s.switchModel(ctx, run.SessionID, "other-model", 2); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := s.sweep(ctx, 30); err != nil {
		t.Fatal(err)
	}
	for _, suffix := range []string{"recent", "busy"} {
		if _, err := readSession(ctx, s.db, "session-"+suffix); err != nil {
			t.Fatalf("错误删除活跃会话：%s %v", suffix, err)
		}
		if _, err := s.get(ctx, "run-"+suffix); err != nil {
			t.Fatalf("会话内部旧Run被提前删：%v", err)
		}
	}
	for _, table := range []string{"sessions", "tasks", "runs"} {
		var n int
		column := "id"
		id := strings.TrimSuffix(table, "s") + "-expire"
		if err := s.db.QueryRow(fmt.Sprintf("SELECT COUNT(*) FROM %s WHERE %s=?", table, column), id).Scan(&n); err != nil || n != 0 {
			t.Fatalf("会话清理遗漏 %s：%d %v", table, n, err)
		}
	}
	if n := runtimeStoreCount(t, s, "working_memories"); n != 1 {
		t.Fatalf("记忆没有随整会话清理：%d", n)
	}
}
