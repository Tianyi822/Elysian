package harness

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
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
