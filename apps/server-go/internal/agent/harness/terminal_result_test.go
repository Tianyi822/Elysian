package harness

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"strings"
	"testing"

	"elysian/server/internal/agent/harness/model"
)

func finishFailedTestRun(s *store, runID, status string, failure *Failure) error {
	_, err := s.change(context.Background(), runID, "finish-result-test", func(tx *sql.Tx, r *Run) error {
		r.Status, r.Error, r.EndReason, r.EndedAt = status, failure, "test-failure", stamp(s.now())
		return s.event(context.Background(), tx, r, "run/"+status, "", nil, failure)
	})
	return err
}

func TestTerminalResultSavedWithFailureAndJSONLExactlyOnce(t *testing.T) {
	for _, reason := range []Failure{{"execution-unavailable", "执行容器通道不可用"}, {"model-failed", "模型请求失败，请检查模型服务与凭据"}, {"model-budget", "模型请求次数或 token 预算已耗尽"}, {"run-timeout", "运行超过总时间限制"}, {"worker-lost", "Worker 中断，未自动重跑"}, {"unknown", ""}} {
		t.Run(reason.Code, func(t *testing.T) {
			s, _ := openRuntimeTestStore(t)
			session, task, run := sessionStoreFixture(t, s, reason.Code, runtimeStoreTestTime)
			run = acceptSessionTestRun(t, s, task, run, true)
			if err := finishFailedTestRun(s, run.ID, StateFailed, &reason); err != nil {
				t.Fatal(err)
			}
			if err := finishFailedTestRun(s, run.ID, StateFailed, &reason); err != nil {
				t.Fatal(err)
			}
			page, err := s.messages(context.Background(), session.ID, "", 100)
			if err != nil || len(page.Items) != 2 {
				t.Fatalf("messages=%+v err=%v", page, err)
			}
			result := page.Items[1]
			want := reason.Message
			if want == "" {
				want = "运行异常结束，未获得可用结果"
			}
			if result.Origin != "runtime" || result.Role != "assistant" || result.RunStatus != StateFailed || result.Content != "本轮任务未能完成。\n\n原因："+want {
				t.Fatalf("运行结果错误：%+v", result)
			}
			lines, _ := readRecordLines(t, s, recordOwner{"session", session.ID})
			count := 0
			for _, line := range lines {
				if line.Type == "messages" {
					var message Message
					json.Unmarshal(line.Document, &message)
					if message.Origin == "runtime" {
						count++
					}
				}
			}
			if count != 1 {
				t.Fatalf("JSONL 结果条目=%d", count)
			}
		})
	}
}

func TestTerminalResultRollbackKeepsRunSessionAndLedgerTogether(t *testing.T) {
	s, _ := openRuntimeTestStore(t)
	session, task, run := sessionStoreFixture(t, s, "result-rollback", runtimeStoreTestTime)
	run = acceptSessionTestRun(t, s, task, run, true)
	_, before := readRecordLines(t, s, recordOwner{"session", session.ID})
	if _, err := s.db.Exec(`CREATE TRIGGER reject_runtime_result BEFORE INSERT ON messages WHEN json_extract(NEW.document,'$.origin')='runtime' BEGIN SELECT RAISE(ABORT,'reject-runtime-result'); END`); err != nil {
		t.Fatal(err)
	}
	if err := finishFailedTestRun(s, run.ID, StateFailed, &Failure{"failed", "失败原因"}); err == nil {
		t.Fatal("消息写入失败应回滚整个终态事务")
	}
	got, err := s.get(context.Background(), run.ID)
	if err != nil || got.Status != StateQueued {
		t.Fatalf("状态未回滚：%+v %v", got, err)
	}
	stored, err := readSession(context.Background(), s.db, session.ID)
	if err != nil || stored.ActiveRunID != run.ID || stored.LastSeq != "1" {
		t.Fatalf("会话未回滚：%+v %v", stored, err)
	}
	_, after := readRecordLines(t, s, recordOwner{"session", session.ID})
	if !bytes.Equal(before, after) {
		t.Fatal("失败事务泄露了 JSONL 结果")
	}
}

func TestTerminalResultManualStopAndAutomaticInvalidation(t *testing.T) {
	for _, manual := range []bool{false, true} {
		t.Run(map[bool]string{false: "automatic", true: "manual"}[manual], func(t *testing.T) {
			s, _ := openRuntimeTestStore(t)
			session, task, run := sessionStoreFixture(t, s, "result-stop", runtimeStoreTestTime)
			run = acceptSessionTestRun(t, s, task, run, true)
			_, err := s.change(context.Background(), run.ID, "cancel-result-test", func(tx *sql.Tx, r *Run) error {
				r.CancelRequestedAt = stamp(s.now())
				kind := "wiki/context-invalidated"
				if manual {
					kind = "run/cancel-requested"
				}
				return s.event(context.Background(), tx, r, kind, "", nil, nil)
			})
			if err != nil {
				t.Fatal(err)
			}
			if err := finishFailedTestRun(s, run.ID, StateInterrupted, &Failure{"operation-unresponsive", "模型或工具未确认停止，运行结果未确认"}); err != nil {
				t.Fatal(err)
			}
			page, err := s.messages(context.Background(), session.ID, "", 100)
			want := 2
			if manual {
				want = 1
			}
			if err != nil || len(page.Items) != want {
				t.Fatalf("manual=%t messages=%+v err=%v", manual, page, err)
			}
			got, _ := s.get(context.Background(), run.ID)
			result, err := s.terminalResult(context.Background(), s.db, got)
			if err != nil || (result == nil) != manual {
				t.Fatalf("手动停止投影错误：%+v %v", result, err)
			}
		})
	}
}

func TestTerminalResultRestartRecoveryAndLegacyProjection(t *testing.T) {
	s, _ := openRuntimeTestStore(t)
	session, task, run := sessionStoreFixture(t, s, "result-restart", runtimeStoreTestTime)
	run = acceptSessionTestRun(t, s, task, run, true)
	_, err := s.change(context.Background(), run.ID, "start", func(tx *sql.Tx, r *Run) error {
		r.Status = StateRunning
		return s.event(context.Background(), tx, r, "run/running", "", nil, nil)
	})
	if err != nil {
		t.Fatal(err)
	}
	if err = s.recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err = s.recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	page, err := s.messages(context.Background(), session.ID, "", 100)
	if err != nil || len(page.Items) != 2 || !strings.Contains(page.Items[1].Content, "面板重启中断了运行") {
		t.Fatalf("恢复结果=%+v err=%v", page, err)
	}
	legacy := Run{ID: "old", SessionID: session.ID, Status: StateFailed, Error: &Failure{"old", "历史错误"}}
	before := runtimeStoreCount(t, s, "messages")
	result, err := s.terminalResult(context.Background(), s.db, legacy)
	if err != nil || result == nil || !strings.Contains(result.Content, "历史错误") || runtimeStoreCount(t, s, "messages") != before {
		t.Fatalf("历史投影写入了数据或缺失：%+v %v", result, err)
	}
}

func TestTerminalResultAutomaticCancellationStillHasResult(t *testing.T) {
	s, _ := openRuntimeTestStore(t)
	session, task, run := sessionStoreFixture(t, s, "result-system-stop", runtimeStoreTestTime)
	run = acceptSessionTestRun(t, s, task, run, true)
	_, err := s.change(context.Background(), run.ID, "system-stop", func(tx *sql.Tx, r *Run) error {
		r.CancelRequestedAt = stamp(s.now())
		return s.event(context.Background(), tx, r, "wiki/context-invalidated", "", nil, nil)
	})
	if err != nil {
		t.Fatal(err)
	}
	if err = finishFailedTestRun(s, run.ID, StateCancelled, &Failure{"wiki-context-invalidated", "引用的 Wiki 页面已撤回，运行停止并等待重新构建上下文"}); err != nil {
		t.Fatal(err)
	}
	page, err := s.messages(context.Background(), session.ID, "", 100)
	if err != nil || len(page.Items) != 2 || page.Items[1].Origin != "runtime" || !strings.Contains(page.Items[1].Content, "Wiki 页面已撤回") {
		t.Fatalf("系统取消不应冒充手动停止：%+v %v", page, err)
	}
}

func TestAgentFailurePublishesResultWithoutExtraModelRequest(t *testing.T) {
	requests := 0
	m, session, _ := agentManager(t, func(context.Context, model.Profile, model.Request) (model.Response, error) {
		requests++
		return model.Response{}, &model.Error{Code: "model-unavailable", Message: "模型服务暂时不可用"}
	}, nil)
	run := submitAgentTest(t, m, session, "runtime-result", "检查网站")
	finished := runtimeFinished(t, m, run.ID)
	if finished.Status != StateFailed {
		t.Fatalf("status=%+v", finished)
	}
	page, err := m.Messages(context.Background(), session.ID, "", 100)
	if err != nil || len(page.Items) != 2 || page.Items[1].Origin != "runtime" || requests != 1 {
		t.Fatalf("page=%+v err=%v requests=%d", page, err, requests)
	}
	output, err := m.ChatSnapshot(context.Background(), run.ID)
	if err != nil || output.Timeline.TerminalResult == nil || output.Timeline.TerminalResult.Content != page.Items[1].Content {
		t.Fatalf("快照与公开消息不一致：%+v %v", output, err)
	}
}

func TestAgentFailureRetainsPartialOutputBesideRuntimeResult(t *testing.T) {
	m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, request model.Request) (model.Response, error) {
		request.OnReasoning("正在检查已收到的资料")
		request.OnContent("已经读取到部分内容")
		return model.Response{}, &model.Error{Code: "model-timeout", Message: "模型请求超过时间限制"}
	}, nil)
	run := submitAgentTest(t, m, session, "runtime-partial", "检查网站")
	if finished := runtimeFinished(t, m, run.ID); finished.Status != StateFailed {
		t.Fatalf("status=%+v", finished)
	}
	output, err := m.ChatSnapshot(context.Background(), run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if output.Content != "" || output.Timeline.TerminalResult == nil {
		t.Fatalf("未完成片段不应冒充正式结果：%+v", output)
	}
	var reasoning, content string
	for _, entry := range output.Timeline.Entries {
		if entry.Kind == "reasoning" {
			reasoning += entry.Text
		}
		if entry.Kind == "content" {
			content += entry.Text
		}
	}
	if reasoning != "正在检查已收到的资料" || content != "已经读取到部分内容" {
		t.Fatalf("过程丢失：%+v", output.Timeline)
	}
	page, err := m.Messages(context.Background(), session.ID, "", 100)
	if err != nil || len(page.Items) != 2 || page.Items[1].Origin != "runtime" || strings.Contains(page.Items[1].Content, content) {
		t.Fatalf("结果与过程混淆：%+v %v", page, err)
	}
}
