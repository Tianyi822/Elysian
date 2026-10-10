package harness

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

var runtimeStoreTestTime = time.Date(2026, 10, 10, 0, 0, 0, 123456789, time.UTC)

func openRuntimeTestStore(t *testing.T) (*store, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "data", "agent-runs.sqlite")
	s, err := openStore(path, func() time.Time { return runtimeStoreTestTime })
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := s.close(); err != nil {
			t.Errorf("关闭运行数据库失败：%v", err)
		}
	})
	return s, path
}

func createRuntimeTestRun(t *testing.T, s *store, suffix string, at time.Time) Run {
	t.Helper()
	task := Task{
		ID: "task-" + suffix, RequestID: "request-" + suffix, Kind: "tool-batch", DriverVersion: "v1",
		CreatedAt: stamp(at), Steps: []Step{{Tool: "docker_containers_list", Args: map[string]any{}}},
	}
	run := Run{ID: "run-" + suffix, TaskID: task.ID, Status: StateQueued, CreatedAt: task.CreatedAt, Limits: DefaultLimits(), LastSeq: "0"}
	if err := s.create(context.Background(), task, run, `{"kind":"tool-batch","steps":[{"tool":"docker_containers_list","args":{}}]}`); err != nil {
		t.Fatal(err)
	}
	run, err := s.get(context.Background(), run.ID)
	if err != nil {
		t.Fatal(err)
	}
	return run
}

func startRuntimeTestRun(t *testing.T, s *store, id string) Run {
	t.Helper()
	ctx := context.Background()
	run, err := s.change(ctx, id, "start", func(tx *sql.Tx, run *Run) error {
		run.Status = StateRunning
		run.StartedAt = stamp(runtimeStoreTestTime)
		index := 0
		call := Call{ID: "call-" + id, RunID: id, Tool: "docker_containers_list", Status: StateRunning, StartedAt: run.StartedAt, Args: map[string]any{}, StepIndex: index}
		if err := saveCall(ctx, tx, call); err != nil {
			return err
		}
		return s.event(ctx, tx, run, "call/started", call.ID, &index, nil)
	})
	if err != nil {
		t.Fatal(err)
	}
	return run
}

func runtimeStoreCount(t *testing.T, s *store, table string) int {
	t.Helper()
	var n int
	if err := s.db.QueryRow("SELECT count(*) FROM " + table).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestRuntimeStoreLockHelper(t *testing.T) {
	path := os.Getenv("ELYSIAN_TEST_STORE_LOCK_PATH")
	if path == "" {
		return
	}
	s, err := openStore(path, func() time.Time { return runtimeStoreTestTime })
	if err == nil {
		s.close()
		t.Fatal("第二进程取得了正在使用的运行数据库")
	}
	if !strings.Contains(err.Error(), "另一个面板进程") {
		t.Fatalf("未因跨进程锁被拒绝：%v", err)
	}
}

func TestRuntimeStoreLocksPermissionsAndWAL(t *testing.T) {
	s, path := openRuntimeTestStore(t)
	createRuntimeTestRun(t, s, "one", runtimeStoreTestTime)
	for _, file := range []string{path, path + ".lock", path + "-wal", path + "-shm"} {
		info, err := os.Stat(file)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0600 {
			t.Errorf("运行数据文件权限过宽：%s %o", file, info.Mode().Perm())
		}
	}
	info, err := os.Stat(filepath.Dir(path))
	if err != nil || info.Mode().Perm() != 0700 {
		t.Fatalf("数据目录权限错误：%v %v", info, err)
	}
	var journal string
	if err := s.db.QueryRow("PRAGMA journal_mode").Scan(&journal); err != nil || journal != "wal" {
		t.Fatalf("未启用 WAL：%s %v", journal, err)
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	command := exec.Command(executable, "-test.run=^TestRuntimeStoreLockHelper$")
	command.Env = append(os.Environ(), "ELYSIAN_TEST_STORE_LOCK_PATH="+path)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("跨进程锁失效：%v %s", err, output)
	}
	if err := s.close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := openStore(path, func() time.Time { return runtimeStoreTestTime })
	if err != nil {
		t.Fatalf("关闭后未释放进程锁：%v", err)
	}
	if err := reopened.close(); err != nil {
		t.Fatal(err)
	}
}

func TestRuntimeStoreRejectsUnsafePaths(t *testing.T) {
	for _, path := range []string{"", "relative.sqlite"} {
		if s, err := openStore(path, time.Now); err == nil {
			s.close()
			t.Fatalf("非绝对路径被接受：%q", path)
		}
	}
	for _, suffix := range []string{"", ".lock"} {
		t.Run("symlink"+suffix, func(t *testing.T) {
			root := t.TempDir()
			target := filepath.Join(root, "target")
			if err := os.WriteFile(target, []byte("保留内容"), 0600); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(root, "agent.sqlite")
			if err := os.Symlink(target, path+suffix); err != nil {
				t.Fatal(err)
			}
			if s, err := openStore(path, time.Now); err == nil {
				s.close()
				t.Fatal("数据库或锁允许符号链接")
			}
			contents, err := os.ReadFile(target)
			if err != nil || string(contents) != "保留内容" {
				t.Fatal("拒绝符号链接时改写了目标")
			}
		})
	}
}

func TestRuntimeStoreStateCallAndEventCommitAtomically(t *testing.T) {
	s, _ := openRuntimeTestStore(t)
	ctx := context.Background()
	injected := errors.New("注入持久化失败")
	s.beforeWrite = func(op string) error {
		if op != "submit" {
			t.Fatalf("写入故障注入点错误：%s", op)
		}
		return injected
	}
	err := s.create(ctx, Task{ID: "task-rejected", RequestID: "request-rejected"}, Run{ID: "run-rejected", TaskID: "task-rejected", Status: StateQueued, LastSeq: "0"}, "{}")
	if !errors.Is(err, injected) {
		t.Fatalf("存储故障未返回：%v", err)
	}
	for _, table := range []string{"tasks", "runs", "calls", "run_events"} {
		if count := runtimeStoreCount(t, s, table); count != 0 {
			t.Fatalf("失败提交残留了 %s：%d", table, count)
		}
	}
	s.beforeWrite = nil
	run := createRuntimeTestRun(t, s, "atomic", runtimeStoreTestTime)
	if _, err := s.db.Exec(`CREATE TEMP TRIGGER fail_runtime_event BEFORE INSERT ON run_events BEGIN SELECT RAISE(ABORT, '注入事件落盘失败'); END;`); err != nil {
		t.Fatal(err)
	}
	_, err = s.change(ctx, run.ID, "start", func(tx *sql.Tx, candidate *Run) error {
		candidate.Status = StateRunning
		if err := saveRun(ctx, tx, candidate); err != nil {
			return err
		}
		call := Call{ID: "call-atomic", RunID: run.ID, Tool: "docker_containers_list", Status: StateRunning, Args: map[string]any{}}
		if err := saveCall(ctx, tx, call); err != nil {
			return err
		}
		return s.event(ctx, tx, candidate, "call/started", call.ID, nil, nil)
	})
	if err == nil {
		t.Fatal("事件 INSERT 失败未回滚事务")
	}
	actual, err := s.get(ctx, run.ID)
	if err != nil || !reflect.DeepEqual(actual, run) || runtimeStoreCount(t, s, "calls") != 0 || runtimeStoreCount(t, s, "run_events") != 1 {
		t.Fatalf("状态/工具意图/事件出现部分提交：%+v %v", actual, err)
	}
	if _, err := s.db.Exec("DROP TRIGGER fail_runtime_event"); err != nil {
		t.Fatal(err)
	}
	started := startRuntimeTestRun(t, s, run.ID)
	if started.Status != StateRunning || started.LastSeq != "2" || runtimeStoreCount(t, s, "calls") != 1 || runtimeStoreCount(t, s, "run_events") != 2 {
		t.Fatalf("成功事务未一起提交：%+v", started)
	}
}

func TestRuntimeStoreRecoveryInterruptsInFlightWithoutReplayingQueue(t *testing.T) {
	s, path := openRuntimeTestStore(t)
	queued := createRuntimeTestRun(t, s, "queued", runtimeStoreTestTime)
	active := createRuntimeTestRun(t, s, "active", runtimeStoreTestTime)
	startRuntimeTestRun(t, s, active.ID)
	if err := s.close(); err != nil {
		t.Fatal(err)
	}
	recovered, err := openStore(path, func() time.Time { return runtimeStoreTestTime.Add(time.Minute) })
	if err != nil {
		t.Fatal(err)
	}
	defer recovered.close()
	ctx := context.Background()
	if err := recovered.recover(ctx); err != nil {
		t.Fatal(err)
	}
	actual, err := recovered.get(ctx, active.ID)
	if err != nil || actual.Status != StateInterrupted || actual.EndReason != "panel-restarted" || actual.Error == nil || actual.EndedAt == "" || actual.LastSeq != "3" {
		t.Fatalf("运行恢复未进入中断终态：%+v %v", actual, err)
	}
	calls, err := recovered.calls(ctx, active.ID, "", 50)
	if err != nil || len(calls.Items) != 1 || calls.Items[0].Status != StateInterrupted || calls.Items[0].Error == nil || calls.Items[0].Error.Code != "outcome-unknown" || calls.Items[0].Result != nil {
		t.Fatalf("在途调用被伪装为已确认结果：%+v %v", calls, err)
	}
	unchanged, err := recovered.get(ctx, queued.ID)
	if err != nil || !reflect.DeepEqual(unchanged, queued) {
		t.Fatalf("恢复改写了未派发队列：%+v %v", unchanged, err)
	}
	ids, err := recovered.queued(ctx)
	if err != nil || !reflect.DeepEqual(ids, []string{queued.ID}) {
		t.Fatalf("中断任务回到了队列：%v %v", ids, err)
	}
	if err := recovered.recover(ctx); err != nil {
		t.Fatal(err)
	}
	again, err := recovered.get(ctx, active.ID)
	if err != nil || !reflect.DeepEqual(again, actual) {
		t.Fatalf("重复恢复生成了第二次状态变化：%+v %v", again, err)
	}
}

func TestRuntimeStorePaginationUsesStableCursors(t *testing.T) {
	s, _ := openRuntimeTestStore(t)
	ctx := context.Background()
	runs := []Run{
		createRuntimeTestRun(t, s, "one", runtimeStoreTestTime),
		createRuntimeTestRun(t, s, "two", runtimeStoreTestTime),
		createRuntimeTestRun(t, s, "three", runtimeStoreTestTime),
	}
	first, err := s.list(ctx, ListQuery{Limit: 2})
	if err != nil || len(first.Items) != 2 || first.Items[0].ID != runs[2].ID || first.Items[1].ID != runs[1].ID || !first.HasMore || first.NextCursor == "" {
		t.Fatalf("首批运行分页错误：%+v %v", first, err)
	}
	createRuntimeTestRun(t, s, "newer", runtimeStoreTestTime)
	second, err := s.list(ctx, ListQuery{Limit: 2, Cursor: first.NextCursor})
	if err != nil || len(second.Items) != 1 || second.Items[0].ID != runs[0].ID || second.HasMore {
		t.Fatalf("并发新增导致重复或丢失运行：%+v %v", second, err)
	}
	filtered, err := s.list(ctx, ListQuery{Status: StateQueued, RequestID: "request-two", Limit: 2})
	if err != nil || len(filtered.Items) != 1 || filtered.Items[0].ID != runs[1].ID {
		t.Fatalf("状态/幂等键过滤错误：%+v %v", filtered, err)
	}
	for i := 0; i < 3; i++ {
		index := i
		_, err := s.change(ctx, runs[0].ID, "call", func(tx *sql.Tx, run *Run) error {
			call := Call{ID: "call-page-" + string(rune('a'+index)), RunID: run.ID, StepIndex: index, Tool: "docker_containers_list", Status: StateSucceeded, Args: map[string]any{}, Result: json.RawMessage(`[]`)}
			if err := saveCall(ctx, tx, call); err != nil {
				return err
			}
			return s.event(ctx, tx, run, "call/finished", call.ID, &index, nil)
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	calls, err := s.calls(ctx, runs[0].ID, "", 2)
	if err != nil || len(calls.Items) != 2 || calls.Items[0].StepIndex != 0 || calls.Items[1].StepIndex != 1 || !calls.HasMore || calls.NextCursor != "2" {
		t.Fatalf("调用顺序分页错误：%+v %v", calls, err)
	}
	lastCalls, err := s.calls(ctx, runs[0].ID, calls.NextCursor, 2)
	if err != nil || len(lastCalls.Items) != 1 || lastCalls.Items[0].StepIndex != 2 || lastCalls.HasMore {
		t.Fatalf("调用续页错误：%+v %v", lastCalls, err)
	}
	events, err := s.events(ctx, runs[0].ID, "1", 2)
	if err != nil || len(events.Items) != 2 || events.Items[0].Seq != "2" || events.Items[1].Seq != "3" || events.NextCursor != "3" || !events.HasMore {
		t.Fatalf("事件游标不是严格后继：%+v %v", events, err)
	}
	lastEvents, err := s.events(ctx, runs[0].ID, events.NextCursor, 2)
	if err != nil || len(lastEvents.Items) != 1 || lastEvents.Items[0].Seq != "4" || lastEvents.HasMore || lastEvents.NextCursor != "4" {
		t.Fatalf("事件续页错误：%+v %v", lastEvents, err)
	}
	empty, err := s.events(ctx, runs[0].ID, "4", 2)
	if err != nil || len(empty.Items) != 0 || empty.NextCursor != "4" {
		t.Fatalf("没有新事件时丢失续传位置：%+v %v", empty, err)
	}
	for _, cursor := range []string{"-1", "+1", "01", "1.5", "9223372036854775808", "5"} {
		_, err := s.events(ctx, runs[0].ID, cursor, 2)
		var rejected *Error
		if !errors.As(err, &rejected) || rejected.Status != 400 {
			t.Fatalf("非法或未来游标未拒绝：%q %v", cursor, err)
		}
	}
}

func TestRuntimeStoreSweepRetainsActiveAndRecentRuns(t *testing.T) {
	s, _ := openRuntimeTestStore(t)
	ctx := context.Background()
	old := runtimeStoreTestTime.Add(-60 * 24 * time.Hour)
	queued := createRuntimeTestRun(t, s, "old-queued", old)
	active := createRuntimeTestRun(t, s, "old-running", old)
	startRuntimeTestRun(t, s, active.ID)
	oldFinished := createRuntimeTestRun(t, s, "old-finished", old)
	startRuntimeTestRun(t, s, oldFinished.ID)
	recent := createRuntimeTestRun(t, s, "recent-finished", runtimeStoreTestTime)
	for _, item := range []struct {
		id string
		at time.Time
	}{{oldFinished.ID, old}, {recent.ID, runtimeStoreTestTime.Add(-time.Hour)}} {
		_, err := s.change(ctx, item.id, "finish", func(tx *sql.Tx, run *Run) error {
			run.Status = StateSucceeded
			run.EndedAt = stamp(item.at)
			return s.event(ctx, tx, run, "run/succeeded", "", nil, nil)
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	if err := s.sweep(ctx, 30); err != nil {
		t.Fatal(err)
	}
	if _, err := s.get(ctx, oldFinished.ID); err == nil {
		t.Fatal("超过保留期的终态没有清理")
	}
	for _, id := range []string{queued.ID, active.ID, recent.ID} {
		if _, err := s.get(ctx, id); err != nil {
			t.Fatalf("清理误删活动或近期运行 %s：%v", id, err)
		}
	}
	for _, table := range []string{"calls", "run_events"} {
		var count int
		if err := s.db.QueryRow("SELECT count(*) FROM "+table+" WHERE run_id=?", oldFinished.ID).Scan(&count); err != nil || count != 0 {
			t.Fatalf("终态清理残留关联 %s：%d %v", table, count, err)
		}
	}
	if count := runtimeStoreCount(t, s, "tasks"); count != 3 {
		t.Fatalf("任务快照没有与运行一起清理：%d", count)
	}
}

func TestRuntimeStoreClosedDatabaseIsAConsistentCopy(t *testing.T) {
	s, path := openRuntimeTestStore(t)
	ctx := context.Background()
	run := createRuntimeTestRun(t, s, "snapshot", runtimeStoreTestTime)
	startRuntimeTestRun(t, s, run.ID)
	before, err := s.get(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	beforeEvents, err := s.events(ctx, run.ID, "", 100)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.close(); err != nil {
		t.Fatal(err)
	}
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	snapshot := filepath.Join(t.TempDir(), "snapshot.sqlite")
	if err := os.WriteFile(snapshot, contents, 0600); err != nil {
		t.Fatal(err)
	}
	restored, err := openStore(snapshot, func() time.Time { return runtimeStoreTestTime })
	if err != nil {
		t.Fatal(err)
	}
	defer restored.close()
	actual, err := restored.get(ctx, run.ID)
	if err != nil || !reflect.DeepEqual(actual, before) {
		t.Fatalf("只复制主库遗漏了已提交状态：%+v %v", actual, err)
	}
	actualEvents, err := restored.events(ctx, run.ID, "", 100)
	if err != nil || !reflect.DeepEqual(actualEvents, beforeEvents) {
		t.Fatalf("快照事件与状态不一致：%+v %v", actualEvents, err)
	}
	if err := restored.recover(ctx); err != nil {
		t.Fatal(err)
	}
	after, err := restored.get(ctx, run.ID)
	if err != nil || after.Status != StateInterrupted || after.LastSeq != "3" {
		t.Fatalf("快照恢复没有处理在途运行：%+v %v", after, err)
	}
}

func TestRuntimeStoreRejectsNewerSchemaWithoutDowngrade(t *testing.T) {
	s, path := openRuntimeTestStore(t)
	if _, err := s.db.Exec(fmt.Sprintf("PRAGMA user_version=%d", schemaVersion+1)); err != nil {
		t.Fatal(err)
	}
	if err := s.close(); err != nil {
		t.Fatal(err)
	}
	if opened, err := openStore(path, time.Now); err == nil {
		opened.close()
		t.Fatal("旧程序打开了更高版本数据库")
	} else if !strings.Contains(err.Error(), "版本高于") {
		t.Fatalf("拒绝高版本时返回了错误原因：%v", err)
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var version int
	if err := db.QueryRow("PRAGMA user_version").Scan(&version); err != nil || version != schemaVersion+1 {
		t.Fatalf("拒绝打开时篡改了版本号：%d %v", version, err)
	}
}
