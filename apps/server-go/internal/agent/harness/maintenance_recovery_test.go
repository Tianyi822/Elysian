package harness

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"elysian/server/internal/agent/harness/model"
)

func TestRecoverMaintenanceFreezesWikiJobsAndConsumesFence(t *testing.T) {
	ctx := context.Background()
	s, path := openRuntimeTestStore(t)
	fence := filepath.Join(t.TempDir(), "agent-workflow-recovery.json")
	m := &Manager{store: s, deps: Deps{Path: path, Now: s.now, NewID: randomID, WorkflowRecoveryFence: fence}}
	response := model.Response{FinishReason: "stop", Content: "保存的供应商响应"}
	for _, kind := range []string{"extraction", "embedding"} {
		for _, state := range []string{StateQueued, StateRunning, StateSucceeded} {
			job := WikiJob{
				ID: kind + "-" + state, Kind: kind, OriginKind: "fixture", OriginID: state,
				Status: state, Input: "固定快照", Response: &response,
				CreatedAt: stamp(s.now()), CandidateIDs: []string{}, Sources: []WikiRef{},
			}
			if err := s.write(ctx, "test-maintenance-recovery", func(tx *sql.Tx) error {
				return saveWikiJob(ctx, tx, job)
			}); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := os.WriteFile(fence, []byte(`{"version":1,"reason":"panel-rollback","createdAt":"2026-10-10T00:00:00Z"}`), 0600); err != nil {
		t.Fatal(err)
	}

	if err := m.recoverMaintenance(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(fence); !os.IsNotExist(err) {
		t.Fatalf("维护标记未被消费：%v", err)
	}
	for _, kind := range []string{"extraction", "embedding"} {
		for _, state := range []string{StateQueued, StateRunning, StateSucceeded} {
			job, err := readWikiJob(ctx, s.db, kind+"-"+state)
			if err != nil || job.Input != "固定快照" || job.Response == nil || job.Response.Content != response.Content {
				t.Fatalf("维护恢复丢失固定输入或模型响应：%+v %v", job, err)
			}
			if state == StateSucceeded {
				if job.Status != StateSucceeded {
					t.Fatal("维护恢复改写已完成任务")
				}
			} else if job.Status != StateInterrupted || job.MemoryStatus != "stale" || job.Error == nil || job.Error.Code != "maintenance-recovery" {
				t.Fatalf("后台任务未隔离：%+v", job)
			}
		}
	}
}

func TestReadWorkflowRecoveryFenceValidatesFile(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "missing.json")
	if got, err := readWorkflowRecoveryFence(missing); got || err != nil {
		t.Fatalf("缺失标记应视为未设置：%v %v", got, err)
	}
	if got, err := readWorkflowRecoveryFence(""); got || err != nil {
		t.Fatalf("空路径应视为未设置：%v %v", got, err)
	}

	valid := `{"version":1,"reason":"panel-rollback","createdAt":"2026-10-10T00:00:00Z"}`
	cases := []struct {
		name    string
		content string
		mode    os.FileMode
		wantErr bool
	}{
		{name: "valid", content: valid, mode: 0600},
		{name: "wrong mode", content: valid, mode: 0644, wantErr: true},
		{name: "oversized", content: strings.Repeat("x", 4097), mode: 0600, wantErr: true},
		{name: "malformed", content: `{"version":`, mode: 0600, wantErr: true},
		{name: "unknown field", content: `{"version":1,"reason":"panel-rollback","createdAt":"2026-10-10T00:00:00Z","extra":true}`, mode: 0600, wantErr: true},
		{name: "wrong reason", content: `{"version":1,"reason":"other","createdAt":"2026-10-10T00:00:00Z"}`, mode: 0600, wantErr: true},
		{name: "bad time", content: `{"version":1,"reason":"panel-rollback","createdAt":"not-time"}`, mode: 0600, wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "fence.json")
			if err := os.WriteFile(path, []byte(tc.content), tc.mode); err != nil {
				t.Fatal(err)
			}
			if err := os.Chmod(path, tc.mode); err != nil {
				t.Fatal(err)
			}
			got, err := readWorkflowRecoveryFence(path)
			if tc.wantErr {
				if err == nil || got {
					t.Fatalf("非法标记未拒绝：got=%v err=%v", got, err)
				}
				return
			}
			if err != nil || !got {
				t.Fatalf("合法标记未接受：got=%v err=%v", got, err)
			}
		})
	}
}

func TestRecoverMaintenanceRetainsFenceWhenWikiFreezeFails(t *testing.T) {
	ctx := context.Background()
	s, path := openRuntimeTestStore(t)
	fence := filepath.Join(t.TempDir(), "agent-workflow-recovery.json")
	m := &Manager{store: s, deps: Deps{Path: path, Now: s.now, NewID: randomID, WorkflowRecoveryFence: fence}}
	for _, state := range []string{StateQueued, StateRunning} {
		job := WikiJob{ID: state, Kind: "extraction", OriginKind: "fixture", OriginID: state, Status: state, Input: "固定快照", CreatedAt: stamp(s.now()), CandidateIDs: []string{}, Sources: []WikiRef{}}
		if err := s.write(ctx, "test-maintenance-failure", func(tx *sql.Tx) error {
			return saveWikiJob(ctx, tx, job)
		}); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(fence, []byte(`{"version":1,"reason":"panel-rollback","createdAt":"2026-10-10T00:00:00Z"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.ExecContext(ctx, `CREATE TRIGGER reject_wiki_freeze BEFORE UPDATE ON wiki_jobs WHEN NEW.id='running' BEGIN SELECT RAISE(ABORT,'测试冻结失败'); END`); err != nil {
		t.Fatal(err)
	}

	if err := m.recoverMaintenance(ctx); err == nil {
		t.Fatal("冻结写入故障未阻止维护恢复")
	}
	if _, err := os.Stat(fence); err != nil {
		t.Fatalf("事务失败时过早消费维护标记：%v", err)
	}
	job, err := readWikiJob(ctx, s.db, StateQueued)
	if err != nil || job.Status != StateQueued {
		t.Fatalf("冻结未原子回滚：%+v %v", job, err)
	}

	if _, err := s.db.ExecContext(ctx, "DROP TRIGGER reject_wiki_freeze"); err != nil {
		t.Fatal(err)
	}
	if err := m.recoverMaintenance(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(fence); !os.IsNotExist(err) {
		t.Fatalf("重试成功后未消费维护标记：%v", err)
	}
	job, err = readWikiJob(ctx, s.db, StateQueued)
	if err != nil || job.Status != StateInterrupted {
		t.Fatalf("重试后任务未隔离：%+v %v", job, err)
	}
}
