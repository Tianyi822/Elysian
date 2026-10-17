package harness

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"elysian/server/internal/agent/harness/model"
	"elysian/server/internal/agent/harness/worker"
)

const planFixture = `{"steps":[{"id":"inspect","title":"检查配置","status":"in_progress"},{"id":"verify","title":"验证结果","status":"pending"}]}`
const planUpdated = `{"steps":[{"id":"inspect","title":"检查配置","status":"completed"},{"id":"verify","title":"验证结果","status":"in_progress"}]}`

func planReply(raw string) model.Response {
	return model.Response{FinishReason: "tool_calls", ToolCalls: []model.ToolCall{{ID: "plan", Name: planTool, Arguments: json.RawMessage(raw)}}}
}

func TestPlanValidation(t *testing.T) {
	if _, err := parsePlan(json.RawMessage(planFixture)); err != nil {
		t.Fatal(err)
	}
	for _, raw := range []string{`{}`, `{"steps":[]}`, `{"steps":null}`, `{"steps":[],"steps":[]}`,
		strings.Replace(planFixture, `"verify"`, `"inspect"`, 1), strings.Replace(planFixture, `"pending"`, `"in_progress"`, 1),
		strings.Replace(planFixture, `"pending"`, `"failed"`, 1), strings.Replace(planFixture, `检查配置`, `  `, 1),
		strings.Replace(planFixture, `检查配置`, strings.Repeat("字", 201), 1), strings.Replace(planFixture, `"inspect"`, `"_invalid"`, 1),
		strings.Replace(planFixture, `"inspect"`, `"`+strings.Repeat("a", 65)+`"`, 1)} {
		if _, err := parsePlan(json.RawMessage(raw)); err == nil {
			t.Fatalf("接受无效计划：%s", raw)
		}
	}
	steps := make([]PlanStep, 21)
	for i := range steps {
		steps[i] = PlanStep{ID: string(rune('a' + i)), Title: strings.Repeat("字", 200), Status: "pending"}
	}
	for _, count := range []int{20, 21} {
		raw, _ := json.Marshal(map[string]any{"steps": steps[:count]})
		_, err := parsePlan(raw)
		if (err == nil) != (count == 20) {
			t.Fatalf("步骤上限校验失败：%d %v", count, err)
		}
	}
}

func TestPlanAtomicReplayCheckpointAndRoundIsolation(t *testing.T) {
	var inferences atomic.Int32
	m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, r model.Request) (model.Response, error) {
		if r.ToolChoice == "store_working_memory" {
			return memoryReply(r), nil
		}
		switch inferences.Add(1) {
		case 1:
			if !contains(toolNames(r), planTool) {
				t.Error("缺少常驻计划工具")
			}
			return planReply(planFixture), nil
		case 2:
			if !strings.Contains(r.Messages[1].Content, `本轮最新任务计划`) || !strings.Contains(r.Messages[1].Content, `"revision":1`) {
				t.Error("整理后最新计划丢失")
			}
			return planReply(planUpdated), nil
		default:
			return finalReply("已检查，验证尚未完成"), nil
		}
	}, func(d *Deps) {
		d.Spawn = func(context.Context) (worker.Process, error) {
			return &agentTestProcess{runAgent: func(ctx context.Context, _ string, b worker.AgentBroker) error {
				for {
					response, err := b.NextModel(ctx)
					if err != nil {
						return err
					}
					if response.Final {
						return b.Finalize(ctx, response.ID)
					}
					for i, c := range response.ToolCalls {
						if i < response.StartIndex {
							continue
						}
						if err = b.ExecuteAgent(ctx, response.ID, i, c.ID, c.Name, c.Args); err != nil {
							return err
						}
						if c.Name == planTool {
							a := b.(*agentExecution)
							if err = a.executePlan(ctx, i, a.pending.Response.ToolCalls[i]); err != nil {
								return err
							}
							if _, err = a.consolidate(ctx, false); err != nil {
								return err
							}
						}
					}
				}
			}}, nil
		}
	})
	run := submitAgentTest(t, m, session, "plan-replay", "检查并验证")
	got := runtimeFinished(t, m, run.ID)
	if got.Status != StateSucceeded || got.Plan == nil || got.Plan.Revision != 2 || got.Usage.Calls != 2 || got.Plan.Steps[1].Status != "in_progress" {
		t.Fatalf("计划被重放或自动完成：%+v plan=%+v", got, got.Plan)
	}
	output, err := m.ChatSnapshot(context.Background(), run.ID)
	if err != nil || !reflect.DeepEqual(output.Timeline.Plan, got.Plan) {
		t.Fatalf("时间线未携带同一计划：%+v %v", output, err)
	}
	lines, _ := readRecordLines(t, m.store, recordOwner{"session", session.ID})
	found := false
	for _, line := range lines {
		if line.Type == "runs" && line.Key == run.ID {
			var row Run
			_ = json.Unmarshal(line.Document, &row)
			found = found || reflect.DeepEqual(row.Plan, got.Plan)
		}
	}
	if !found {
		t.Fatal("JSONL 未保存确认的计划")
	}
	next, _, err := m.ContinueTask(context.Background(), run.TaskID, AgentInput{RequestID: "new-round", Content: "你好"})
	if err != nil {
		t.Fatal(err)
	}
	if next := runtimeFinished(t, m, next.ID); next.Plan != nil {
		t.Fatal("计划跨轮继承")
	}
	m = reopenOperationManager(t, m)
	restored, err := m.ChatSnapshot(context.Background(), run.ID)
	if err != nil || !reflect.DeepEqual(restored.Timeline.Plan, got.Plan) {
		t.Fatal("重启未恢复历史计划")
	}
}

func TestPlanCorrectableErrorAndWaitingInputRestart(t *testing.T) {
	var count atomic.Int32
	m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, r model.Request) (model.Response, error) {
		if r.ToolChoice == "store_working_memory" {
			return memoryReply(r), nil
		}
		switch count.Add(1) {
		case 1:
			return planReply(`{"steps":[]}`), nil
		case 2:
			encoded, _ := json.Marshal(r.Messages)
			if !strings.Contains(string(encoded), "invalid-plan") {
				t.Error("未回传可纠正错误")
			}
			return planReply(planFixture), nil
		case 3:
			return userInputReply(questionFixture), nil
		case 4:
			if !strings.Contains(r.Messages[1].Content, `"revision":1`) {
				t.Error("等待恢复丢失计划")
			}
			return planReply(strings.ReplaceAll(planUpdated, `"in_progress"`, `"completed"`)), nil
		default:
			return finalReply("已完成"), nil
		}
	}, nil)
	run := submitAgentTest(t, m, session, "plan-input", "检查配置后确认范围")
	q := waitUserInput(t, m, run.ID)
	output, _ := m.ChatSnapshot(context.Background(), run.ID)
	if output.Timeline.Plan == nil || output.Timeline.Plan.Revision != 1 {
		t.Fatal("无效参数修改了计划")
	}
	m = reopenOperationManager(t, m)
	if _, err := m.AnswerUserInput(context.Background(), run.ID, q.ID, userAnswers()); err != nil {
		t.Fatal(err)
	}
	got := runtimeFinished(t, m, run.ID)
	if got.Status != StateSucceeded || got.Plan.Revision != 2 || got.Usage.Calls != 4 {
		t.Fatalf("等待后更新错误：%+v", got)
	}
}

func TestPlanMixedUserInputDoesNotUpdate(t *testing.T) {
	var count atomic.Int32
	m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, r model.Request) (model.Response, error) {
		if r.ToolChoice == "store_working_memory" {
			return memoryReply(r), nil
		}
		if count.Add(1) == 1 {
			reply := planReply(planFixture)
			reply.ToolCalls = append(reply.ToolCalls, userInputReply(questionFixture).ToolCalls...)
			return reply, nil
		}
		return finalReply("未执行混批"), nil
	}, nil)
	got := runtimeFinished(t, m, submitAgentTest(t, m, session, "mixed-plan", "规划并提问").ID)
	if got.Status != StateSucceeded || got.Plan != nil {
		t.Fatalf("混批改变了计划：%+v", got)
	}
}

func TestPlanPreservesProgressOnFailureAndCancellation(t *testing.T) {
	for _, cancel := range []bool{false, true} {
		t.Run(map[bool]string{false: "失败", true: "取消"}[cancel], func(t *testing.T) {
			var count atomic.Int32
			reached := make(chan struct{})
			m, session, _ := agentManager(t, func(ctx context.Context, _ model.Profile, r model.Request) (model.Response, error) {
				if count.Add(1) == 1 {
					return planReply(planFixture), nil
				}
				close(reached)
				if cancel {
					<-ctx.Done()
					return model.Response{}, ctx.Err()
				}
				return model.Response{}, errors.New("上游不可用")
			}, nil)
			run := submitAgentTest(t, m, session, "plan-stop", "检查配置")
			<-reached
			if cancel {
				if _, err := m.Cancel(context.Background(), run.ID); err != nil {
					t.Fatal(err)
				}
			}
			got := runtimeFinished(t, m, run.ID)
			if got.Plan == nil || got.Plan.Revision != 1 || got.Plan.Steps[0].Status != "in_progress" || got.Status == StateSucceeded {
				t.Fatalf("终态篡改进度：%+v", got)
			}
		})
	}
}

func TestPlanRejectsLegacyWorkflowAndMissingSnapshot(t *testing.T) {
	for _, run := range []Run{{DriverVersion: "v1"}, {DriverVersion: "v2"}, {DriverVersion: "v2", WorkflowID: "workflow", Snapshot: &CapabilitySnapshot{Tools: []Capability{planCapability()}}}} {
		a := &agentExecution{run: run}
		if err := a.validatePlanAccess(ModelRequestRecord{}); err == nil {
			t.Fatal("旧运行或工作流获准规划")
		}
	}
}

// 验证已确认的取消、终态、存储故障与预算限制都在同一写入边界挡住新计划。
func TestPlanWriteGuardsAndAtomicRollback(t *testing.T) {
	for _, mode := range []string{"cancel", "terminal", "records", "transaction", "result-budget", "call-budget", "dispatch"} {
		t.Run(mode, func(t *testing.T) {
			s, _ := openRuntimeTestStore(t)
			run := createRuntimeTestRun(t, s, "plan-guard", runtimeStoreTestTime)
			_, err := s.change(context.Background(), run.ID, "setup", func(tx *sql.Tx, r *Run) error {
				r.Status = StateRunning
				if mode == "cancel" {
					r.CancelRequestedAt = stamp(runtimeStoreTestTime)
				}
				if mode == "terminal" {
					r.Status = StateFailed
				}
				if mode == "result-budget" {
					r.Limits.ResultBytes = 1
				}
				if mode == "call-budget" {
					r.Usage.Calls = r.Limits.MaxSteps
				}
				return saveRun(context.Background(), tx, r)
			})
			if err != nil {
				t.Fatal(err)
			}
			before, _ := s.get(context.Background(), run.ID)
			m := &Manager{store: s, deps: Deps{Now: func() time.Time { return runtimeStoreTestTime }, NewID: func() string { return "new-plan-call" }}}
			if mode == "dispatch" {
				m.deps.DispatchGuard = func() error { return errors.New("拒绝派发") }
			}
			if mode == "records" {
				s.failRecords(errors.New("副本故障"))
			}
			if mode == "transaction" {
				s.beforeWrite = func(op string) error {
					if op == "update-plan" {
						return errors.New("测试事务故障")
					}
					return nil
				}
			}
			run.DriverVersion = "v2"
			run.Snapshot = &CapabilitySnapshot{Tools: []Capability{planCapability()}}
			a := &agentExecution{manager: m, run: run, pending: &ModelRequestRecord{ID: "request"}}
			if err := a.executePlan(context.Background(), 0, planReply(planFixture).ToolCalls[0]); err == nil {
				t.Fatal("接受了被禁止的更新")
			}
			after, _ := s.get(context.Background(), run.ID)
			if after.Plan != nil || after.Usage != before.Usage || runtimeStoreCount(t, s, "calls") != 0 {
				t.Fatal("失败写入留下了部分计划或回执")
			}
			s.beforeWrite = nil
		})
	}
}
