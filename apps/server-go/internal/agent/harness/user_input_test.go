package harness

import (
	"context"
	"database/sql"
	"encoding/json"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"elysian/server/internal/agent/harness/model"
)

const questionFixture = `{"questions":[{"id":"scope","header":"查询范围","question":"需要查看哪个范围？","recommendedOptionId":"panel","options":[{"id":"panel","label":"面板","description":"面板自身内存"},{"id":"system","label":"系统","description":"系统资源概览"}]},{"id":"period","header":"时间","question":"查看什么时间？","options":[{"id":"now","label":"现在","description":"实时采样"},{"id":"old","label":"历史","description":"已有历史采样"}]}]}`

func userInputReply(raw string) model.Response {
	return model.Response{FinishReason: "tool_calls", ToolCalls: []model.ToolCall{{ID: "question", Name: userInputTool, Arguments: json.RawMessage(raw)}}}
}
func waitUserInput(t *testing.T, m *Manager, runID string) UserInputRequest {
	t.Helper()
	var result UserInputRequest
	runtimeEventually(t, func() bool {
		output, err := m.ChatSnapshot(context.Background(), runID)
		if err != nil {
			t.Fatal(err)
		}
		for _, entry := range output.Timeline.Entries {
			if entry.UserInput != nil && entry.UserInput.Status == "pending" {
				result = *entry.UserInput
				return true
			}
		}
		return false
	})
	return result
}
func userAnswers() AnswerUserInput {
	return AnswerUserInput{RequestID: "answer-one", Answers: map[string]UserInputAnswer{"scope": {OptionID: "panel"}, "period": {Text: "最近一次采样，标出时间"}}}
}

func TestUserInputSuspendsRestoresAndResumesExactlyOnce(t *testing.T) {
	for _, restart := range []bool{false, true} {
		t.Run(map[bool]string{false: "直接回答", true: "重启后回答"}[restart], func(t *testing.T) {
			var requests atomic.Int32
			var clockOffset atomic.Int64
			client := func(_ context.Context, _ model.Profile, r model.Request) (model.Response, error) {
				if r.ToolChoice == "store_working_memory" {
					return memoryReply(r), nil
				}
				if requests.Add(1) == 1 {
					found := false
					for _, tool := range r.Tools {
						found = found || tool.Name == userInputTool
					}
					if !found {
						t.Error("缺少始终可见的澄清工具")
					}
					return userInputReply(questionFixture), nil
				}
				found := false
				for _, message := range r.Messages {
					if message.Role == "tool" && strings.Contains(message.Content, "最近一次采样") {
						found = true
					}
				}
				if !found {
					t.Error("回答未进入原工具结果")
				}
				return finalReply("已按面板范围回答"), nil
			}
			m, session, _ := agentManager(t, client, func(d *Deps) {
				d.Now = func() time.Time { return time.Now().Add(time.Duration(clockOffset.Load())) }
			})
			run := submitAgentTest(t, m, session, "question-run", "需要确认范围")
			q := waitUserInput(t, m, run.ID)
			runtimeEventually(t, func() bool { m.mu.Lock(); defer m.mu.Unlock(); return len(m.executions) == 0 })
			if err := m.DeleteSession(context.Background(), session.ID); err == nil {
				t.Fatal("待答会话被删除")
			}
			if restart {
				m = reopenOperationManager(t, m)
				if got := waitUserInput(t, m, run.ID); got.ID != q.ID {
					t.Fatal("重启后问题改变")
				}
			}
			answer := userAnswers()
			clockOffset.Store(int64(24 * time.Hour))
			receipt, err := m.AnswerUserInput(context.Background(), run.ID, q.ID, answer)
			if err != nil || receipt.UserInput.Status != "answered" {
				t.Fatalf("回答失败：%+v %v", receipt, err)
			}
			if got := runtimeFinished(t, m, run.ID); got.Status != StateSucceeded || got.ActiveMilliseconds > 60000 {
				t.Fatalf("未续接成功：%+v", got)
			}
			if _, err := m.AnswerUserInput(context.Background(), run.ID, q.ID, answer); err != nil {
				t.Fatalf("幂等重试失败：%v", err)
			}
			answer.Answers["scope"] = UserInputAnswer{OptionID: "system"}
			if _, err := m.AnswerUserInput(context.Background(), run.ID, q.ID, answer); err == nil {
				t.Fatal("冲突回答被接受")
			}
			if requests.Load() != 2 {
				t.Fatalf("重复续接：%d", requests.Load())
			}
			readRecordLines(t, m.store, recordOwner{"session", session.ID})
			var facts int
			if err := m.store.db.QueryRow("SELECT COUNT(*) FROM agent_record_outbox WHERE fact_type='user_inputs' AND fact_key=?", q.ID).Scan(&facts); err != nil || facts < 2 {
				t.Fatalf("缺少 JSONL 同事务事实：%d %v", facts, err)
			}
			messages, err := m.Messages(context.Background(), session.ID, "0", 50)
			if err != nil || len(messages.Items) != 2 {
				t.Fatalf("回答生成了额外用户轮次：%+v %v", messages, err)
			}
		})
	}
}

func TestUserInputQuestionCardinality(t *testing.T) {
	questions, err := parseUserInput(json.RawMessage(questionFixture))
	if err != nil {
		t.Fatal(err)
	}
	third := questions[0]
	third.ID = "third"
	questions = append(questions, third)
	for _, count := range []int{1, 2, 3} {
		raw, _ := json.Marshal(map[string]any{"questions": questions[:count]})
		if _, err := parseUserInput(raw); err != nil {
			t.Fatalf("%d 题被拒绝: %v", count, err)
		}
	}
	questions = append(questions, third)
	raw, _ := json.Marshal(map[string]any{"questions": questions})
	if _, err := parseUserInput(raw); err == nil {
		t.Fatal("接受超过 3 题")
	}
	questions[1].ID = questions[0].ID
	raw, _ = json.Marshal(map[string]any{"questions": questions[:2]})
	if _, err := parseUserInput(raw); err == nil {
		t.Fatal("接受重复问题编号")
	}
}

func TestUserInputRestoresConfirmedDeepSeekReasoning(t *testing.T) {
	for _, format := range []string{model.FormatChatCompletions, model.FormatAnthropicMessages} {
		for _, reasoning := range []string{"", "本轮已确认思考原文"} {
			t.Run(format+"/"+reasoning, func(t *testing.T) {
				var requests atomic.Int32
				m, _, _ := agentManager(t, func(_ context.Context, _ model.Profile, r model.Request) (model.Response, error) {
					if r.ToolChoice == "store_working_memory" {
						return memoryReply(r), nil
					}
					if requests.Add(1) == 1 {
						response := userInputReply(questionFixture)
						response.Reasoning = reasoning
						return response, nil
					}
					found := false
					for _, message := range r.Messages {
						if message.Role == "assistant" && len(message.ToolCalls) > 0 {
							found = true
							if message.Reasoning != reasoning {
								t.Error("恢复后改写了已确认思考")
							}
						}
					}
					if !found {
						t.Error("恢复后丢失原工具调用")
					}
					return finalReply("已恢复"), nil
				}, nil)
				credential := "test-only"
				profile, err := m.CreateModelProfile(model.Input{Provider: model.ProviderDeepSeek, APIFormat: format, BaseURL: "http://127.0.0.1:9", Model: "test", ContextTokens: 65536, OutputTokens: 4096, Capabilities: model.Capabilities{Text: true, Tools: true, Source: "test"}, Active: true, Credential: &credential})
				if err != nil {
					t.Fatal(err)
				}
				session, err := m.CreateSession(context.Background(), CreateSessionInput{ModelProfileID: profile.ID, ModelRevision: profile.Revision})
				if err != nil {
					t.Fatal(err)
				}
				run := submitAgentTest(t, m, session, "reasoning-resume", "请澄清")
				q := waitUserInput(t, m, run.ID)
				runtimeEventually(t, func() bool { m.mu.Lock(); defer m.mu.Unlock(); return len(m.executions) == 0 })
				m = reopenOperationManager(t, m)
				if _, err := m.AnswerUserInput(context.Background(), run.ID, q.ID, userAnswers()); err != nil {
					t.Fatal(err)
				}
				if done := runtimeFinished(t, m, run.ID); done.Status != StateSucceeded {
					t.Fatal(done.Error)
				}
			})
		}
	}
}

func TestUserInputQueueFullPreservesQuestionAndReleasesSlot(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	defer close(release)
	var calls atomic.Int32
	m, session, _ := agentManager(t, func(ctx context.Context, _ model.Profile, r model.Request) (model.Response, error) {
		if r.ToolChoice == "store_working_memory" {
			return memoryReply(r), nil
		}
		switch calls.Add(1) {
		case 1:
			return userInputReply(questionFixture), nil
		case 2:
			close(started)
			select {
			case <-release:
				return finalReply("完成"), nil
			case <-ctx.Done():
				return model.Response{}, ctx.Err()
			}
		default:
			return finalReply("完成"), nil
		}
	}, func(d *Deps) { d.Limits.QueueCapacity = 1; d.AgentLimits.QueueCapacity = 1 })
	run := submitAgentTest(t, m, session, "queue-question", "请澄清")
	q := waitUserInput(t, m, run.ID)
	newSession := func() Session {
		s, err := m.CreateSession(context.Background(), CreateSessionInput{ModelProfileID: session.ModelProfileID, ModelRevision: session.ModelRevision})
		if err != nil {
			t.Fatal(err)
		}
		return s
	}
	submitAgentTest(t, m, newSession(), "occupy-worker", "独立任务")
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("等待回答未释放执行槽")
	}
	submitAgentTest(t, m, newSession(), "occupy-queue", "排队任务")
	if _, err := m.AnswerUserInput(context.Background(), run.ID, q.ID, userAnswers()); err == nil {
		t.Fatal("队列满时接受了回答")
	} else if e, ok := err.(*Error); !ok || e.Code != "queue-full" {
		t.Fatal(err)
	}
	if got := waitUserInput(t, m, run.ID); got.AnswerRequestID != "" || len(got.Answers) != 0 {
		t.Fatal("队列满改变了问题")
	}
}

func TestUserInputSchemaMigrationAndRoutes(t *testing.T) {
	m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, r model.Request) (model.Response, error) {
		if r.ToolChoice == "store_working_memory" {
			return memoryReply(r), nil
		}
		for _, message := range r.Messages {
			if message.Role == "tool" {
				return finalReply("完成"), nil
			}
		}
		return userInputReply(questionFixture), nil
	}, nil)
	// 将空数据库恢复为真实 schema7 的结构，再执行升级，验证新表与记录触发器一起安装。
	m.mu.Lock()
	_, err := m.store.db.Exec("DROP TABLE user_inputs; PRAGMA user_version=7")
	if err == nil {
		err = migrateStore(m.store.db)
	}
	m.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	var version int
	if err := m.store.db.QueryRow("PRAGMA user_version").Scan(&version); err != nil || version != 8 {
		t.Fatalf("版本 %d: %v", version, err)
	}
	run := submitAgentTest(t, m, session, "route-question", "请澄清")
	q := waitUserInput(t, m, run.ID)
	body, _ := json.Marshal(userAnswers())
	path := "/runs/" + run.ID + "/user-inputs/" + q.ID + "/answer"
	result := runtimeRouteRequest(m.Router(), "POST", path, string(body))
	if result.Code != 200 {
		t.Fatalf("%d: %s", result.Code, result.Body.String())
	}
	if done := runtimeFinished(t, m, run.ID); done.Status != StateSucceeded {
		t.Fatal(done.Error)
	}
	if result = runtimeRouteRequest(m.Router(), "POST", path, string(body)); result.Code != 200 {
		t.Fatal("重复提交不是幂等回执")
	}
	readRecordLines(t, m.store, recordOwner{"session", session.ID})
}

func TestUserInputAnswerCancelRaceIsAtomic(t *testing.T) {
	m, session, _ := agentManager(t, func(ctx context.Context, _ model.Profile, r model.Request) (model.Response, error) {
		for _, message := range r.Messages {
			if message.Role == "tool" {
				<-ctx.Done()
				return model.Response{}, ctx.Err()
			}
		}
		return userInputReply(questionFixture), nil
	}, nil)
	run := submitAgentTest(t, m, session, "cancel-race", "请澄清")
	q := waitUserInput(t, m, run.ID)
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); _, _ = m.AnswerUserInput(context.Background(), run.ID, q.ID, userAnswers()) }()
	go func() { defer wg.Done(); _, _ = m.Cancel(context.Background(), run.ID) }()
	wg.Wait()
	runtimeFinished(t, m, run.ID)
	var pending int
	if err := m.store.db.QueryRow("SELECT COUNT(*) FROM user_inputs WHERE run_id=? AND state='pending'", run.ID).Scan(&pending); err != nil || pending != 0 {
		t.Fatal("取消留下待答问题", err)
	}
	// 终态清理同样适用于 Wiki 撤回等旁路。
	if err := m.store.write(context.Background(), "check-question", func(tx *sql.Tx) error {
		var raw string
		if err := tx.QueryRow("SELECT document FROM user_inputs WHERE id=?", q.ID).Scan(&raw); err != nil {
			return err
		}
		var stored UserInputRequest
		if err := json.Unmarshal([]byte(raw), &stored); err != nil {
			return err
		}
		if stored.Status != "answered" && stored.Status != "cancelled" {
			t.Error(stored.Status)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestUserInputInvalidAndMixedCallsAreCorrectable(t *testing.T) {
	for _, mixed := range []bool{false, true} {
		var requests atomic.Int32
		m, session, invoker := agentManager(t, func(_ context.Context, _ model.Profile, r model.Request) (model.Response, error) {
			if r.ToolChoice == "store_working_memory" {
				return memoryReply(r), nil
			}
			switch requests.Add(1) {
			case 1:
				if !mixed {
					return userInputReply(`{"questions":[]}`), nil
				}
				response := userInputReply(questionFixture)
				response.ToolCalls = append([]model.ToolCall{{ID: "write", Name: "docker_containers_list", Arguments: json.RawMessage(`{}`)}}, response.ToolCalls...)
				return response, nil
			case 2:
				found := false
				for _, message := range r.Messages {
					found = found || strings.Contains(message.Content, "invalid-user-input")
				}
				if !found {
					t.Error("缺少可纠正错误")
				}
				return userInputReply(questionFixture), nil
			default:
				return finalReply("已处理"), nil
			}
		}, nil)
		run := submitAgentTest(t, m, session, "invalid-question", "请澄清")
		q := waitUserInput(t, m, run.ID)
		if invoker.count.Load() != 0 {
			t.Fatal("混批执行了其他工具")
		}
		if _, err := m.AnswerUserInput(context.Background(), run.ID, q.ID, userAnswers()); err != nil {
			t.Fatal(err)
		}
		if got := runtimeFinished(t, m, run.ID); got.Status != StateSucceeded {
			t.Fatalf("纠正未成功：%+v", got.Error)
		}
	}
}

func TestUserInputValidationAndCancellation(t *testing.T) {
	m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, r model.Request) (model.Response, error) {
		return userInputReply(questionFixture), nil
	}, nil)
	run := submitAgentTest(t, m, session, "cancel-question", "请澄清")
	q := waitUserInput(t, m, run.ID)
	for _, answers := range []map[string]UserInputAnswer{{}, {"scope": {OptionID: "other"}, "period": {Text: "现在"}}, {"scope": {OptionID: "panel", Text: "额外"}, "period": {Text: "现在"}}, {"scope": {OptionID: "panel"}, "period": {Text: " "}}} {
		if _, err := m.AnswerUserInput(context.Background(), run.ID, q.ID, AnswerUserInput{RequestID: "invalid", Answers: answers}); err == nil {
			t.Fatal("接受了无效回答")
		}
	}
	if _, err := m.Cancel(context.Background(), run.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := m.AnswerUserInput(context.Background(), run.ID, q.ID, userAnswers()); err == nil {
		t.Fatal("取消后接受了回答")
	}
	output, err := m.ChatSnapshot(context.Background(), run.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range output.Timeline.Entries {
		if entry.UserInput != nil && entry.UserInput.Status != "cancelled" {
			t.Fatal("问题未取消")
		}
	}
}

func TestUserInputConcurrentAnswersCommitOnce(t *testing.T) {
	var requests atomic.Int32
	m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, r model.Request) (model.Response, error) {
		if r.ToolChoice == "store_working_memory" {
			return memoryReply(r), nil
		}
		if requests.Add(1) == 1 {
			return userInputReply(questionFixture), nil
		}
		return finalReply("已回答"), nil
	}, nil)
	run := submitAgentTest(t, m, session, "race-question", "请澄清")
	q := waitUserInput(t, m, run.ID)
	var accepted atomic.Int32
	var wg sync.WaitGroup
	for _, id := range []string{"tab-one", "tab-two"} {
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			a := userAnswers()
			a.RequestID = id
			if _, err := m.AnswerUserInput(context.Background(), run.ID, q.ID, a); err == nil {
				accepted.Add(1)
			}
		}(id)
	}
	wg.Wait()
	if accepted.Load() != 1 {
		t.Fatal("多标签页重复提交")
	}
	if got := runtimeFinished(t, m, run.ID); got.Status != StateSucceeded {
		t.Fatal(got.Error)
	}
}
