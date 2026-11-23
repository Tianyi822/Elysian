package sqlite

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
)

func installLegacyKnowledgeFixture(t *testing.T, s *store) {
	t.Helper()
	if err := s.write(context.Background(), "legacy-fixture", func(tx *sql.Tx) error {
		if _, err := tx.Exec(wikiSchema + "DROP TABLE context_exclusions; DROP TABLE agent_record_rebuild; PRAGMA user_version=11"); err != nil {
			return err
		}
		for _, spec := range retiredWikiRecordSpecs {
			if err := installRecordTriggers(tx, spec); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func retainedRecordLines(t *testing.T, raw []byte) []byte {
	t.Helper()
	var retained []byte
	for _, line := range bytes.SplitAfter(raw, []byte{10}) {
		if len(line) == 0 {
			continue
		}
		var envelope recordLine
		if err := json.Unmarshal(line, &envelope); err != nil {
			t.Fatal(err)
		}
		if !strings.HasPrefix(envelope.Type, "wiki_") {
			retained = append(retained, line...)
		}
	}
	return retained
}

func TestRetirementRebuildResumesWithIdenticalRetainedRecords(t *testing.T) {
	s, path := openRuntimeTestStore(t)
	session, task, run := sessionStoreFixture(t, s, "history", runtimeStoreTestTime)
	assertRetirementComplete(t, s)
	acceptSessionTestRun(t, s, task, run, true)
	finishSessionTestRun(t, s, run.ID, "原回复", nil)
	other := createRuntimeTestRun(t, s, "other", runtimeStoreTestTime)
	otherOwner := recordOwner{"batch-run", other.ID}
	otherPath, _ := s.recordPath(otherOwner)
	_, otherBefore := readRecordLines(t, s, otherOwner)
	otherStat, err := os.Stat(otherPath)
	if err != nil {
		t.Fatal(err)
	}

	installLegacyKnowledgeFixture(t, s)
	if _, err := s.db.Exec(`INSERT INTO wiki_spaces VALUES('space','旧资料','global','{"id":"space"}');
 INSERT INTO wiki_pages(id,space_id,slug,status,current_revision,document) VALUES('page','space','private','active',1,'{"body":"旧资料"}');
 INSERT INTO wiki_embedding_requests VALUES('embedding','running','{}');`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(`INSERT INTO wiki_recalls VALUES(?, '{"sources":[{"pageId":"page","revision":1}]}')`, run.ID); err != nil {
		t.Fatal(err)
	}
	owner := recordOwner{"session", session.ID}
	_, before := readRecordLines(t, s, owner)
	want := retainedRecordLines(t, before)
	if bytes.Equal(before, want) {
		t.Fatal("旧夹具没有生成独立流水")
	}
	injected := errors.New("restart after replica replacement")
	s.setRecordHook(func(stage string) error {
		if stage == "retirement-published" {
			return injected
		}
		return nil
	})
	if err := s.migrateRetiredData(); !errors.Is(err, injected) {
		t.Fatalf("未留下待确认迁移：%v", err)
	}
	if got := runtimeStoreCount(t, s, "agent_record_rebuild"); got != 1 {
		t.Fatalf("迁移待办=%d", got)
	}

	if err := s.close(); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		reopened, err := openStore(path, s.now)
		if err != nil {
			t.Fatal(err)
		}
		assertRetirementComplete(t, reopened)
		_, got := readRecordLines(t, reopened, owner)
		if !bytes.Equal(want, got) {
			t.Fatal("普通流水字节、序号或摘要改变")
		}
		var excluded bool
		if err = reopened.db.QueryRow("SELECT EXISTS(SELECT 1 FROM context_exclusions WHERE kind='run' AND id=?)", run.ID).Scan(&excluded); err != nil || !excluded {
			t.Fatalf("旧来源未隔离：%v", err)
		}
		view := &view{store: reopened}
		history, err := view.TaskHistory(context.Background(), task.ID, 0, run.ID, 1, "")
		if err != nil || len(history) > 0 {
			t.Fatalf("任务历史暴露了已隔离的轮次：%v %v", history, err)
		}
		unchanged, err := os.Stat(otherPath)
		if err != nil || !os.SameFile(otherStat, unchanged) {
			t.Fatalf("无关流水被替换：%v", err)
		}
		if b, err := os.ReadFile(otherPath); err != nil || !bytes.Equal(b, otherBefore) {
			t.Fatalf("无关流水被改写：%v", err)
		}
		if err = reopened.close(); err != nil {
			t.Fatal(err)
		}
	}
}

func assertRetirementComplete(t *testing.T, s *store) {
	t.Helper()
	var count, version int
	if err := s.db.QueryRow("PRAGMA user_version").Scan(&version); err != nil || version != 12 {
		t.Fatalf("schema=%d: %v", version, err)
	}
	for _, query := range []string{
		"SELECT COUNT(*) FROM sqlite_master WHERE name GLOB 'wiki_*' OR name GLOB 'agent_record_wiki_*'",
		"SELECT COUNT(*) FROM agent_record_outbox WHERE " + retiredFacts,
		"SELECT COUNT(*) FROM agent_record_rebuild",
	} {
		if err := s.db.QueryRow(query).Scan(&count); err != nil || count != 0 {
			t.Fatalf("清理残留 %s: %d, %v", query, count, err)
		}
	}
}

func TestRetirementStopsAffectedActiveRunAndRejectsCorruptReplica(t *testing.T) {
	for _, corrupt := range []bool{false, true} {
		t.Run(map[bool]string{false: "valid", true: "corrupt"}[corrupt], func(t *testing.T) {
			s, path := openRuntimeTestStore(t)
			session, task, run := sessionStoreFixture(t, s, "affected", runtimeStoreTestTime)
			acceptSessionTestRun(t, s, task, run, true)
			_, otherTask, other := sessionStoreFixture(t, s, "independent", runtimeStoreTestTime)
			acceptSessionTestRun(t, s, otherTask, other, true)
			installLegacyKnowledgeFixture(t, s)
			if _, err := s.db.Exec("INSERT INTO wiki_run_spaces VALUES(?,'[\"legacy-space\"]')", run.ID); err != nil {
				t.Fatal(err)
			}
			ctx := context.Background()
			dispatched := Operation{ID: "external-operation", RunID: run.ID, TaskID: task.ID, Status: "dispatched", DispatchID: "original-dispatch"}
			if err := s.write(ctx, "legacy-dispatch", func(tx *sql.Tx) error {
				if err := saveOperation(ctx, tx, dispatched); err != nil {
					return err
				}
				return saveResourceLease(ctx, tx, ResourceLease{ID: "resource-lease", RunID: run.ID,
					OperationID: dispatched.ID, State: "held", Claims: []ResourceClaim{}})
			}); err != nil {
				t.Fatal(err)
			}
			owner := recordOwner{"session", session.ID}
			name, _ := s.recordPath(owner)
			_, before := readRecordLines(t, s, owner)
			if corrupt {
				if err := os.WriteFile(name, append(before, []byte("foreign\n")...), 0600); err != nil {
					t.Fatal(err)
				}
			}
			if err := s.close(); err != nil {
				t.Fatal(err)
			}
			reopened, err := openStore(path, s.now)
			if corrupt {
				if err == nil {
					reopened.close()
					t.Fatal("损坏副本被覆盖")
				}
				db, err := sql.Open("sqlite", path)
				if err != nil {
					t.Fatal(err)
				}
				defer db.Close()
				var version int
				if err = db.QueryRow("PRAGMA user_version").Scan(&version); err != nil || version != 11 {
					t.Fatalf("核验失败仍写入了迁移：%d %v", version, err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			defer reopened.close()
			assertRetirementComplete(t, reopened)
			got, err := reopened.get(context.Background(), run.ID)
			if err != nil || got.Status != StateInterrupted || got.EndReason != "context-retired" {
				t.Fatalf("旧运行仍可继续：%+v %v", got, err)
			}
			operation, err := readOperation(ctx, reopened.reader(ctx), dispatched.ID)
			if err != nil || operation.DispatchID != dispatched.DispatchID || operation.Status != "unknown" {
				t.Fatalf("派发身份或未确认结果丢失：%+v %v", operation, err)
			}
			for _, table := range []string{"execution_barriers", "resource_leases"} {
				var status string
				if err := reopened.db.QueryRow("SELECT state FROM "+table+" WHERE operation_id=?", dispatched.ID).Scan(&status); err != nil || status != "unknown" {
					t.Fatalf("%s 保护已失效：%s %v", table, status, err)
				}
			}
			next, err := reopened.get(context.Background(), other.ID)
			if err != nil || next.Status != StateQueued {
				t.Fatalf("迁移改变了普通运行：%+v %v", next, err)
			}
			updated, err := readSession(context.Background(), reopened.reader(context.Background()), session.ID)
			if err != nil || updated.ActiveRunID != "" {
				t.Fatalf("会话仍被旧运行占用：%+v %v", updated, err)
			}
		})
	}
}

func TestRetirementFencesWorkflowBetweenSteps(t *testing.T) {
	s, _ := openRuntimeTestStore(t)
	session, task, _ := sessionStoreFixture(t, s, "legacy-workflow", runtimeStoreTestTime)
	installLegacyKnowledgeFixture(t, s)
	w := WorkflowInstance{ID: "legacy-workflow", SessionID: session.ID, TaskID: task.ID,
		Status: StateReady, LastSeq: "0", ReadyAt: stamp(s.now())}
	raw, err := json.Marshal(w)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if err := s.write(ctx, "workflow-fixture", func(tx *sql.Tx) error {
		if _, err := tx.Exec(`INSERT INTO workflow_instances(id,request_id,canonical_input,session_id,state,ready_at,document)
 VALUES(?,?,'{}',?,?,?,?)`, w.ID, w.ID, w.SessionID, w.Status, w.ReadyAt, raw); err != nil {
			return err
		}
		_, err := tx.Exec("INSERT INTO wiki_visible_pages VALUES('workflow',?,'page',1,'legacy')", w.ID)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.migrateRetiredData(); err != nil {
		t.Fatal(err)
	}
	fenced, err := readWorkflow(ctx, s.reader(ctx), w.ID)
	if err != nil || fenced.Status != StateRecoveryRequired || !fenced.GateClosed || fenced.Error == nil || fenced.Error.Code != "context-retired" {
		t.Fatalf("没有活动轮次的旧工作流未关闭推进：%+v %v", fenced, err)
	}
	assertRetirementComplete(t, s)
}
