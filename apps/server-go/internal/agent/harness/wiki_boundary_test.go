package harness

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
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

func TestWikiExtractionRevisionCandidatesKeepFixedBase(t *testing.T) {
	for _, stale := range []bool{false, true} {
		name := "publish"
		if stale {
			name = "reject-stale"
		}
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, request model.Request) (model.Response, error) {
				if request.ToolChoice == "store_working_memory" {
					return memoryReply(request), nil
				}
				if request.ToolChoice != "propose_wiki_pages" {
					return finalReply("已核对容器健康状态"), nil
				}
				var input struct {
					ExistingPages []WikiPage     `json:"existingPages"`
					Evidence      []WikiEvidence `json:"evidence"`
				}
				if err := json.Unmarshal([]byte(request.Messages[1].Content), &input); err != nil || len(input.ExistingPages) != 1 {
					t.Errorf("提炼输入未固定已有页面：%+v %v", input, err)
					return model.Response{}, errors.New("固定页面缺失")
				}
				old := input.ExistingPages[0]
				args, _ := json.Marshal(map[string]any{"pages": []map[string]any{{"pageId": old.ID, "expectedRevision": old.Revision, "slug": old.Slug, "title": old.Title, "markdown": old.Markdown + "\n确认健康后再继续。", "kind": old.Kind, "evidenceIds": []string{input.Evidence[0].ID}}}})
				return model.Response{FinishReason: "tool_calls", ToolCalls: []model.ToolCall{{ID: "revision", Name: "propose_wiki_pages", Arguments: args}}}, nil
			}, nil)
			space, err := m.CreateWikiSpace(ctx, "修订知识", "business")
			if err != nil {
				t.Fatal(err)
			}
			page, err := m.CreateWikiPage(ctx, space.ID, WikiPageInput{Slug: "container-check", Title: "容器检查", Markdown: "先确认容器状态。", Kind: "runbook", Tags: []string{"Docker"}, Aliases: []string{"容器体检"}})
			if err != nil {
				t.Fatal(err)
			}
			if _, err = m.SetWikiSessionSpace(ctx, session.ID, space.ID, false); err != nil {
				t.Fatal(err)
			}
			run := submitAgentTest(t, m, session, "revise-one", "容器检查")
			if finished := runtimeFinished(t, m, run.ID); finished.Status != StateSucceeded {
				t.Fatalf("运行失败：%+v", finished)
			}
			// 仅直接驱动兼容编译实现，生产不会再派生或调度这些任务。
			finished, err := m.Get(ctx, run.ID)
			if err != nil {
				t.Fatal(err)
			}
			if err = m.store.write(ctx, "legacy-extraction-fixture", func(tx *sql.Tx) error {
				if err := snapshotWikiRunSpaces(ctx, tx, run.ID, session.ID); err != nil {
					return err
				}
				return m.enqueueWikiNavigationExtraction(ctx, tx, &finished)
			}); err != nil {
				t.Fatal(err)
			}
			m.runNextWikiJob()
			var candidates []WikiCandidate
			runtimeEventually(t, func() bool {
				candidates, err = m.ListWikiCandidates(ctx, space.ID, "pending")
				return err == nil && len(candidates) == 1
			})
			proposal := candidates[0]
			if proposal.PageID != page.ID || proposal.Page.ExpectedRevision != page.Revision || len(proposal.Page.Evidence) != 1 || proposal.Page.Evidence[0].Text != "容器检查" || proposal.Reason != "manual-protection" {
				t.Fatalf("修订候选丢失基准或真实证据：%+v", proposal)
			}
			if len(proposal.Page.Tags) != 1 || proposal.Page.Tags[0] != "Docker" || len(proposal.Page.Aliases) != 1 || proposal.Page.Aliases[0] != "容器体检" {
				t.Fatalf("修订候选丢失固定页面元信息：%+v", proposal)
			}
			if stale {
				if _, err = m.UpdateWikiPage(ctx, page.ID, WikiPageInput{ExpectedRevision: page.Revision, Slug: page.Slug, Title: page.Title, Markdown: "用户较新的修订", Kind: page.Kind}); err != nil {
					t.Fatal(err)
				}
			}
			_, err = m.DecideWikiCandidate(ctx, proposal.ID, "approved")
			if stale && err == nil || !stale && err != nil {
				t.Fatalf("基准修订裁决错误：stale=%v err=%v", stale, err)
			}
			current, err := m.GetWikiPage(ctx, page.ID)
			if err != nil || current.Revision != page.Revision+1 {
				t.Fatalf("修订编号错误：%+v %v", current, err)
			}
			if stale && current.Markdown != "用户较新的修订" || !stale && current.Markdown != "先确认容器状态。\n确认健康后再继续。" {
				t.Fatalf("覆盖错误：%+v", current)
			}
		})
	}
}
