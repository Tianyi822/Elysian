package harness

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"

	"elysian/server/internal/agent/harness/model"
)

func TestAgentReasoningLevelPinnedToRunAndIdempotentInput(t *testing.T) {
	levels := make(chan string, 8)
	var calls atomic.Int32
	m, s, _ := agentManager(t, func(_ context.Context, _ model.Profile, r model.Request) (model.Response, error) {
		if r.ToolChoice == "store_working_memory" {
			if r.ReasoningLevel != "" {
				t.Error("整理不应继承聊天思考等级")
			}
			return memoryReply(r), nil
		}
		levels <- r.ReasoningLevel
		if calls.Add(1) == 1 {
			return toolReply("docker_containers_list"), nil
		}
		return finalReply("完成"), nil
	}, nil)
	ctx := context.Background()
	credential := "test-only-key"
	profile, err := m.CreateModelProfile(model.Input{Provider: model.ProviderDeepSeek, APIFormat: model.FormatChatCompletions, Name: "思考测试", BaseURL: "http://127.0.0.1:9", Model: "test", ContextTokens: 65536, OutputTokens: 4096, Capabilities: model.Capabilities{Text: true, Tools: true, ReasoningLevels: []string{"disabled", "low", "high"}, Source: "test"}, Active: true, Credential: &credential})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = m.SwitchSessionModel(ctx, s.ID, SwitchModelInput{ModelProfileID: profile.ID, ModelRevision: profile.Revision}); err != nil {
		t.Fatal(err)
	}
	input := AgentInput{RequestID: "reasoning-choice", Content: "检查状态", ReasoningLevel: "high"}
	run, _, err := m.CreateTask(ctx, s.ID, input)
	if err != nil {
		t.Fatal(err)
	}
	finished := runtimeFinished(t, m, run.ID)
	if finished.Status != StateSucceeded || finished.Selection == nil || finished.Selection.ReasoningLevel != "high" {
		t.Fatalf("等级未固定保存：%+v", finished)
	}
	if len(levels) != 2 || <-levels != "high" || <-levels != "high" {
		t.Fatal("工具续轮未继承本轮等级")
	}
	repeated, duplicate, err := m.CreateTask(ctx, s.ID, input)
	if err != nil || !duplicate || repeated.ID != run.ID {
		t.Fatal("同一输入未幂等返回", err)
	}
	input.ReasoningLevel = "low"
	_, _, err = m.CreateTask(ctx, s.ID, input)
	var conflict *Error
	if !errors.As(err, &conflict) || conflict.Code != "request-conflict" {
		t.Fatal("改变等级未触发幂等冲突", err)
	}
	input.RequestID, input.ReasoningLevel = "unsupported-choice", "max"
	if _, _, err = m.ContinueTask(ctx, run.TaskID, input); err == nil {
		t.Fatal("接受了未声明的等级")
	}
	input.RequestID, input.ReasoningLevel = "default-choice", ""
	next, _, err := m.ContinueTask(ctx, run.TaskID, input)
	if err != nil {
		t.Fatal(err)
	}
	if runtimeFinished(t, m, next.ID).Status != StateSucceeded || len(levels) != 1 || <-levels != "" {
		t.Fatal("下一轮默认错误沿用了之前的等级")
	}
}
