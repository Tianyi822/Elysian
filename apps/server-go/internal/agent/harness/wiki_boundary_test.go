package harness

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"testing"

	"elysian/server/internal/agent/harness/model"
)

func TestWikiMaintenanceFenceInterruptsQueuedAndRunningJobsAtomically(t *testing.T) {
	ctx := context.Background()
	s, path := openRuntimeTestStore(t)
	fence := filepath.Join(t.TempDir(), "agent-workflow-recovery.json")
	m := &Manager{store: s, deps: Deps{Path: path, Now: s.now, NewID: randomID, WorkflowRecoveryFence: fence}}
	response := model.Response{FinishReason: "stop", Content: "保存的供应商响应"}
	for _, kind := range []string{"extraction", "embedding"} {
		for _, state := range []string{StateQueued, StateRunning, StateSucceeded} {
			job := WikiJob{ID: kind + "-" + state, Kind: kind, OriginKind: "fixture", OriginID: state, Status: state, Input: "固定快照", Response: &response, CreatedAt: stamp(s.now()), CandidateIDs: []string{}, Sources: []WikiRef{}}
			if err := s.write(ctx, "test-wiki-maintenance", func(tx *sql.Tx) error { return saveWikiJob(ctx, tx, job) }); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := os.WriteFile(fence, []byte(`{"version":1,"reason":"panel-rollback","createdAt":"2026-10-10T00:00:00Z"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.ExecContext(ctx, `CREATE TRIGGER reject_wiki_freeze BEFORE UPDATE ON wiki_jobs WHEN NEW.id='embedding-running' BEGIN SELECT RAISE(ABORT,'测试冻结失败'); END`); err != nil {
		t.Fatal(err)
	}
	if err := m.recoverWorkflows(ctx); err == nil {
		t.Fatal("冻结写入故障未阻止启动")
	}
	if _, err := os.Stat(fence); err != nil {
		t.Fatal("事务失败时过早消费维护标记")
	}
	job, err := readWikiJob(ctx, s.db, "extraction-queued")
	if err != nil || job.Status != StateQueued {
		t.Fatalf("冻结未原子回滚：%+v %v", job, err)
	}
	if _, err := s.db.ExecContext(ctx, "DROP TRIGGER reject_wiki_freeze"); err != nil {
		t.Fatal(err)
	}
	if err := m.recoverWorkflows(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(fence); !os.IsNotExist(err) {
		t.Fatalf("冻结成功后未消费维护标记：%v", err)
	}
	if err := m.recoverWikiJobs(ctx); err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"extraction", "embedding"} {
		for _, state := range []string{StateQueued, StateRunning, StateSucceeded} {
			job, err := readWikiJob(ctx, s.db, kind+"-"+state)
			if err != nil || job.Input != "固定快照" || job.Response == nil || job.Response.Content != response.Content {
				t.Fatalf("恢复丢失固定输入或模型响应：%+v %v", job, err)
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

func TestWikiEvidenceRejectsFabricatedExcerptAndEvent(t *testing.T) {
	m, session := wikiTestManager(t)
	ctx := context.Background()
	run := submitAgentTest(t, m, session, "evidence-check", "容器检查")
	finished := runtimeFinished(t, m, run.ID)
	if finished.Status != StateSucceeded {
		t.Fatalf("运行失败：%+v", finished)
	}
	space, err := m.CreateWikiSpace(ctx, "业务知识", "business")
	if err != nil {
		t.Fatal(err)
	}
	for _, evidence := range []WikiEvidence{
		{Kind: "run", RunID: run.ID, Text: "没有执行过的部署成功"},
		{Kind: "run", RunID: run.ID, EventSeq: "9223372036854775807", Text: "检查已完成"},
		{Kind: "run", Text: "检查已完成"},
	} {
		_, err := m.CreateWikiPage(ctx, space.ID, WikiPageInput{Slug: "fabricated", Title: "检查证据", Markdown: "候选正文", Evidence: []WikiEvidence{evidence}})
		if err == nil {
			t.Fatalf("伪造来源或摘录被采纳：%+v", evidence)
		}
	}
	page, err := m.CreateWikiPage(ctx, space.ID, WikiPageInput{Slug: "verified", Title: "检查证据", Markdown: "候选正文", Evidence: []WikiEvidence{{Kind: "run", RunID: run.ID, EventSeq: finished.LastSeq, Text: "检查已完成"}}})
	if err != nil || page.Evidence[0].Digest != wikiDigest("run", "检查已完成") {
		t.Fatalf("真实摘录被拒绝：%+v %v", page, err)
	}
}
