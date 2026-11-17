package harness

import (
	"bytes"
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"modernc.org/sqlite"
)

func TestRecordWorkerPurgeDuringFileSyncDoesNotRecreateWatermark(t *testing.T) {
	s, _ := openRuntimeTestStore(t)
	r := createRuntimeTestRun(t, s, "purge-during-sync", runtimeStoreTestTime)
	entered, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	s.setRecordHook(func(stage string) error {
		if stage == "synced" {
			once.Do(func() { close(entered); <-release })
		}
		return nil
	})
	s.startRecordWorker(nil)
	defer s.stopRecordWorker()
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	if _, err := s.change(context.Background(), r.ID, "dirty-before-purge", func(tx *sql.Tx, r *Run) error {
		return s.event(context.Background(), tx, r, "test/purge", "", nil, nil)
	}); err != nil {
		t.Fatal(err)
	}
	awaitDeleteSignal(t, entered)
	owner := recordOwner{"batch-run", r.ID}
	if err := s.write(context.Background(), "purge-owner", func(tx *sql.Tx) error { return purgeRecordOwner(context.Background(), tx, owner) }); err != nil {
		t.Fatal(err)
	}
	close(release)
	s.wakeRecordWorker()
	runtimeEventually(t, func() bool {
		var n int
		s.db.QueryRow("SELECT COUNT(*) FROM agent_record_cleanup").Scan(&n)
		return n == 0
	})
	var count int
	if err := s.db.QueryRow("SELECT COUNT(*) FROM agent_record_watermarks WHERE owner_kind=? AND owner_id=?", owner.kind, owner.id).Scan(&count); err != nil || count != 0 {
		t.Fatal("清理后出现孤立水位", count, err)
	}
}

func TestTaskHistoryRetrievesOriginalReceiptInBoundedChunks(t *testing.T) {
	ctx := context.Background()
	s, _ := openRuntimeTestStore(t)
	r := continuousStoreRun(t, s, "history-receipt")
	payload := strings.Repeat("证据", 4000)
	result, _ := json.Marshal(map[string]string{"actualReceipt": payload})
	call := Call{ID: "history-receipt-call", RunID: r.ID, Tool: "read-receipt", Status: StateSucceeded, Result: result, ModelRequestID: "old-request"}
	r, err := s.change(ctx, r.ID, "receipt", func(tx *sql.Tx, r *Run) error {
		if err := saveCall(ctx, tx, call); err != nil {
			return err
		}
		return s.event(ctx, tx, r, "call/finished", call.ID, nil, nil)
	})
	if err != nil {
		t.Fatal(err)
	}
	var contents strings.Builder
	offset := 0
	for i := 0; i < 100; i++ {
		args, _ := json.Marshal(map[string]any{"reference": r.ID + ":" + r.LastSeq, "offset": offset})
		page, err := readTaskHistory(ctx, s.db, r.TaskID, args)
		raw, _ := json.Marshal(page)
		if err != nil || len(raw) > 16384 || len(page.Items) != 1 {
			t.Fatalf("分段越界或回执缺失：%d %v", len(raw), err)
		}
		var chunk struct {
			Content    string `json:"content"`
			NextOffset int    `json:"nextOffset"`
		}
		if err = json.Unmarshal(page.Items[0], &chunk); err != nil {
			t.Fatal(err)
		}
		contents.WriteString(chunk.Content)
		if chunk.NextOffset == 0 {
			break
		}
		if chunk.NextOffset <= offset {
			t.Fatal("分段游标没有前进")
		}
		offset = chunk.NextOffset
	}
	if !json.Valid([]byte(contents.String())) || !strings.Contains(contents.String(), payload) {
		t.Fatal("压缩后无法取回完整原始回执")
	}
}

func TestContinuousNewVerificationSurvivesCoveredOriginalRequest(t *testing.T) {
	ctx := context.Background()
	s, _ := openRuntimeTestStore(t)
	r := continuousStoreRun(t, s, "covered-verification")
	call := Call{ID: "covered-call", RunID: r.ID, ModelRequestID: "covered-model", ModelCallID: "covered-proposal", Tool: "read-receipt", Status: StateInterrupted, Error: &Failure{Code: "outcome-unknown", Message: "原结果未知"}}
	r, err := s.change(ctx, r.ID, "original-fact", func(tx *sql.Tx, r *Run) error {
		r.Status = StateRunning
		if err := saveCall(ctx, tx, call); err != nil {
			return err
		}
		return s.event(ctx, tx, r, "call/finished", call.ID, nil, nil)
	})
	if err != nil {
		t.Fatal(err)
	}
	memory := WorkingMemory{TaskID: r.TaskID, Revision: 1, Objective: r.Input, Coverage: MemoryCursor{RunNumber: r.RunNumber, EventSeq: r.LastSeq}, Facts: []MemoryFact{}, Todos: []string{}, OpenQuestions: []string{}, Constraints: []string{}}
	if err = s.write(ctx, "cover-original", func(tx *sql.Tx) error { return saveWorkingMemory(ctx, tx, memory) }); err != nil {
		t.Fatal(err)
	}
	call.Status, call.Error, call.Result = StateSucceeded, nil, json.RawMessage(`{"newVerification":"已确认实际完成"}`)
	if _, err = s.change(ctx, r.ID, "new-proof", func(tx *sql.Tx, r *Run) error {
		if err := saveCall(ctx, tx, call); err != nil {
			return err
		}
		return s.event(ctx, tx, r, "recovery/recovered", call.ID, nil, nil)
	}); err != nil {
		t.Fatal(err)
	}
	r, _ = s.get(ctx, r.ID)
	a := &agentExecution{manager: &Manager{store: s}, run: r}
	_, groups, _, err := a.contextFacts(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	var text strings.Builder
	for _, group := range groups {
		for _, message := range group.messages {
			text.WriteString(message.Content)
		}
	}
	if !strings.Contains(text.String(), "追加核实证据") || !strings.Contains(text.String(), "已确认实际完成") {
		t.Fatal("压缩游标隐藏了之后到达的新证据", text.String())
	}
}

func TestRecordWorkerDoesNotHoldSQLiteOrManagerDuringFileIO(t *testing.T) {
	s, _ := openRuntimeTestStore(t)
	run := createRuntimeTestRun(t, s, "slow-file", runtimeStoreTestTime)
	entered, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	s.setRecordHook(func(stage string) error {
		if stage == "append" {
			once.Do(func() { close(entered); <-release })
		}
		return nil
	})
	s.startRecordWorker(nil)
	defer s.stopRecordWorker()
	if _, err := s.change(context.Background(), run.ID, "slow-record", func(tx *sql.Tx, r *Run) error { return s.event(context.Background(), tx, r, "test/slow", "", nil, nil) }); err != nil {
		t.Fatal(err)
	}
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("未进入文件写入")
	}
	defer close(release)
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	if _, err := s.get(ctx, run.ID); err != nil {
		t.Fatal("文件同步占用了 SQLite 连接", err)
	}
	if _, err := s.change(ctx, run.ID, "inflight-receipt", func(tx *sql.Tx, r *Run) error { return s.event(ctx, tx, r, "test/receipt", "", nil, nil) }); err != nil {
		t.Fatal("文件同步阻止在途回执入库", err)
	}
	waitCtx, stop := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer stop()
	if err := s.waitRecords(waitCtx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("派发越过未同步水位", err)
	}
}

func TestUnchangedSaveDoesNotAmplifyOutboxOrJSONL(t *testing.T) {
	s, _ := openRuntimeTestStore(t)
	run := createRuntimeTestRun(t, s, "same-document", runtimeStoreTestTime)
	_, before := readRecordLines(t, s, recordOwner{"batch-run", run.ID})
	var initial int
	s.db.QueryRow("SELECT COUNT(*) FROM agent_record_outbox").Scan(&initial)
	for range 100 {
		if err := s.write(context.Background(), "unchanged", func(tx *sql.Tx) error { return saveRun(context.Background(), tx, &run) }); err != nil {
			t.Fatal(err)
		}
	}
	var afterCount int
	s.db.QueryRow("SELECT COUNT(*) FROM agent_record_outbox").Scan(&afterCount)
	_, after := readRecordLines(t, s, recordOwner{"batch-run", run.ID})
	if afterCount != initial || !bytes.Equal(before, after) {
		t.Fatalf("无变化保存放大记录：%d -> %d", initial, afterCount)
	}
}

var writeCancellationOnce sync.Once
var writeCancellationMu sync.Mutex
var writeCancellation context.CancelFunc

// Cancel from inside a real INSERT, after SQLite has evaluated 64 rows. This
// exercises rollback/connection reuse rather than cancelling a preflight SELECT.
func TestActualInsertCancellationPreservesRollbackProtection(t *testing.T) {
	writeCancellationOnce.Do(func() {
		if err := sqlite.RegisterScalarFunction("elysian_test_cancel_insert", 1, func(_ *sqlite.FunctionContext, args []driver.Value) (driver.Value, error) {
			if args[0].(int64) == 64 {
				writeCancellationMu.Lock()
				cancel := writeCancellation
				writeCancellationMu.Unlock()
				if cancel != nil {
					cancel()
				}
			}
			return args[0], nil
		}); err != nil {
			t.Fatal(err)
		}
	})
	for i := 0; i < 10; i++ {
		t.Run(string(rune('a'+i)), func(t *testing.T) {
			s, _ := openRuntimeTestStore(t)
			if _, err := s.db.Exec("CREATE TABLE cancellation_probe(value INTEGER)"); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			writeCancellationMu.Lock()
			writeCancellation = cancel
			writeCancellationMu.Unlock()
			err := s.write(ctx, "cancelled-insert", func(tx *sql.Tx) error {
				_, err := tx.ExecContext(ctx, `WITH RECURSIVE n(v) AS (SELECT 1 UNION ALL SELECT v+1 FROM n WHERE v<100000)
 INSERT INTO cancellation_probe SELECT elysian_test_cancel_insert(v) FROM n`)
				return err
			})
			cancel()
			writeCancellationMu.Lock()
			writeCancellation = nil
			writeCancellationMu.Unlock()
			if err == nil {
				t.Fatal("取消 INSERT 意外成功")
			}
			uncertain := commitUnconfirmed(err)
			var count int
			if err := s.db.QueryRow("SELECT COUNT(*) FROM cancellation_probe").Scan(&count); err != nil || count != 0 {
				t.Fatalf("第 %d 轮残留写入或连接失效：%d %v %v", i, count, err, s.recordsFault())
			}
			if uncertain {
				var failure *Error
				if !errors.As(storageFailure(err), &failure) || failure.Status != 503 || s.recordsFault() == nil {
					t.Fatal("回滚无法确认时，读取成功清除了写保护", err)
				}
				if err := s.waitRecords(context.Background()); err == nil {
					t.Fatal("回滚未知后仍允许外部派发")
				}
			} else if s.recordsFault() != nil {
				t.Fatal("已确认回滚仍冻结存储", s.recordsFault())
			}
		})
	}
}

func TestActualCommitWithLostAcknowledgementRetainsIdentityAndProtection(t *testing.T) {
	s, _ := openRuntimeTestStore(t)
	run := createRuntimeTestRun(t, s, "commit-reply-lost", runtimeStoreTestTime)
	s.failAfterCommit = context.Canceled
	_, err := s.change(context.Background(), run.ID, "committed-unknown", func(tx *sql.Tx, r *Run) error {
		r.Phase = "committed-fact"
		return s.event(context.Background(), tx, r, "test/committed", "", nil, nil)
	})
	if !commitUnconfirmed(err) {
		t.Fatalf("丢失提交确认降为请求取消：%v", err)
	}
	var failure *Error
	if !errors.As(storageFailure(err), &failure) || failure.Status != 503 || failure.Code != "storage-commit-unconfirmed" {
		t.Fatal("提交未知被映射为可重投的取消")
	}
	stored, err := s.get(context.Background(), run.ID)
	if err != nil || stored.Phase != "committed-fact" || stored.RequestID != run.RequestID || s.recordsFault() == nil {
		t.Fatal("真实提交被丢弃或成功读取清除了写保护", err)
	}
}

func TestModelFactAndHistoricalReportRemainImmutableAfterVerification(t *testing.T) {
	s, _ := openRuntimeTestStore(t)
	_, task, run := sessionStoreFixture(t, s, "verified-report", runtimeStoreTestTime)
	run.DriverVersion = "v2"
	run.BudgetPolicy = continuousBudgetPolicy
	run.RecoveryPolicy = continuousRecoveryPolicy
	run = acceptSessionTestRun(t, s, task, run, true)
	call := Call{ID: "verified-call", RunID: run.ID, StepIndex: 0, Tool: "test-write", Status: StateInterrupted, StartedAt: stamp(s.now()), EndedAt: stamp(s.now()), Error: &Failure{Code: "outcome-unknown", Message: "结果待核实"}}
	if err := s.write(context.Background(), "unknown-fact", func(tx *sql.Tx) error { return saveCall(context.Background(), tx, call) }); err != nil {
		t.Fatal(err)
	}
	if err := finishFailedTestRun(s, run.ID, StateInterrupted, &Failure{Code: "outcome-unknown", Message: "原结果未知"}); err != nil {
		t.Fatal(err)
	}
	historical, err := s.get(context.Background(), run.ID)
	if err != nil {
		t.Fatal(err)
	}
	report, _ := json.Marshal(historical.Report)
	var content string
	s.db.QueryRow("SELECT json_extract(document,'$.modelContent') FROM calls WHERE id=?", call.ID).Scan(&content)
	call.Status = StateSucceeded
	call.Error = nil
	call.Result = json.RawMessage(`{"verified":true}`)
	if _, err := s.change(context.Background(), run.ID, "verified-fact", func(tx *sql.Tx, r *Run) error {
		if err := saveCall(context.Background(), tx, call); err != nil {
			return err
		}
		return s.event(context.Background(), tx, r, "recovery/recovered", call.ID, nil, nil)
	}); err != nil {
		t.Fatal(err)
	}
	latest, _ := s.get(context.Background(), run.ID)
	if err := projectCurrentReport(context.Background(), s.db, &latest); err != nil {
		t.Fatal(err)
	}
	current, _ := json.Marshal(latest.Report)
	var after string
	s.db.QueryRow("SELECT json_extract(document,'$.modelContent') FROM calls WHERE id=?", call.ID).Scan(&after)
	if content == "" || content != after || !bytes.Equal(report, current) || latest.CurrentReport == nil || latest.CurrentReport.Completed != 1 || latest.CurrentReport.Unconfirmed != 0 || latest.Report.Unconfirmed != 1 || latest.Status != StateInterrupted {
		t.Fatalf("核实改写了原模型事实或终态：%+v", latest)
	}
}
