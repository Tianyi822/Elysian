package harness

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"elysian/server/internal/agent/harness/sessionstore"
)

func TestTaskHistoryRetrievesOriginalReceiptInBoundedChunks(t *testing.T) {
	ctx := context.Background()
	s, _ := openRuntimeTestStore(t)
	r := continuousStoreRun(t, s, "history-receipt")
	payload := strings.Repeat("证据", 4000)
	result, _ := json.Marshal(map[string]string{"actualReceipt": payload})
	call := Call{ID: "history-receipt-call", RunID: r.ID, Tool: "read-receipt", Status: StateSucceeded, Result: result, ModelRequestID: "old-request"}
	r, err := s.change(ctx, r.ID, "receipt", func(tx sessionstore.Tx, r *Run) error {
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
		page, err := readTaskHistory(ctx, s, r.TaskID, args)
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
	r, err := s.change(ctx, r.ID, "original-fact", func(tx sessionstore.Tx, r *Run) error {
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
	if err = s.write(ctx, "cover-original", func(tx sessionstore.Tx) error { return saveWorkingMemory(ctx, tx, memory) }); err != nil {
		t.Fatal(err)
	}
	call.Status, call.Error, call.Result = StateSucceeded, nil, json.RawMessage(`{"newVerification":"已确认实际完成"}`)
	if _, err = s.change(ctx, r.ID, "new-proof", func(tx sessionstore.Tx, r *Run) error {
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

func TestModelFactAndHistoricalReportRemainImmutableAfterVerification(t *testing.T) {
	s, _ := openRuntimeTestStore(t)
	_, task, run := sessionStoreFixture(t, s, "verified-report", runtimeStoreTestTime)
	run.DriverVersion = "v2"
	run.BudgetPolicy = continuousBudgetPolicy
	run.RecoveryPolicy = continuousRecoveryPolicy
	run = acceptSessionTestRun(t, s, task, run, true)
	call := Call{ID: "verified-call", RunID: run.ID, StepIndex: 0, Tool: "test-write", Status: StateInterrupted, StartedAt: stamp(s.now()), EndedAt: stamp(s.now()), Error: &Failure{Code: "outcome-unknown", Message: "结果待核实"}}
	if err := s.write(context.Background(), "unknown-fact", func(tx sessionstore.Tx) error { return saveCall(context.Background(), tx, call) }); err != nil {
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
	if _, err := s.change(context.Background(), run.ID, "verified-fact", func(tx sessionstore.Tx, r *Run) error {
		if err := saveCall(context.Background(), tx, call); err != nil {
			return err
		}
		return s.event(context.Background(), tx, r, "recovery/recovered", call.ID, nil, nil)
	}); err != nil {
		t.Fatal(err)
	}
	latest, _ := s.get(context.Background(), run.ID)
	current, _ := json.Marshal(latest.Report)
	var after string
	s.db.QueryRow("SELECT json_extract(document,'$.modelContent') FROM calls WHERE id=?", call.ID).Scan(&after)
	if content == "" || content != after || string(report) != string(current) || latest.Report.Unconfirmed != 1 || latest.Status != StateInterrupted {
		t.Fatalf("核实改写了原模型事实或终态：%+v", latest)
	}
}
