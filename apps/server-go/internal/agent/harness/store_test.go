package harness

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"elysian/server/internal/agent/harness/sessionstore"
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
	run, err := s.change(ctx, id, "start", func(tx sessionstore.Tx, run *Run) error {
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
