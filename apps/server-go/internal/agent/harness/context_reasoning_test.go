package harness

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"

	"elysian/server/internal/agent/harness/model"
)

func TestToolContinuationReasoningStaysWithinCurrentDeepSeekRun(t *testing.T) {
	for _, test := range []struct {
		provider string
		format   string
		replay   bool
	}{
		{model.ProviderDeepSeek, model.FormatChatCompletions, true},
		{model.ProviderDeepSeek, model.FormatAnthropicMessages, true},
		{model.ProviderOpenAICompatible, model.FormatAnthropicMessages, false},
	} {
		t.Run(test.provider+"/"+test.format, func(t *testing.T) {
			var inferences atomic.Int32
			m, _, _ := agentManager(t, func(_ context.Context, _ model.Profile, request model.Request) (model.Response, error) {
				if request.ToolChoice == "store_working_memory" {
					return model.Response{}, errors.New("保留未整理事实以验证跨 Run 边界")
				}
				switch inferences.Add(1) {
				case 1:
					response := toolReply("docker_containers_list")
					response.Reasoning = "当前 Run 的工具思考"
					return response, nil
				case 2:
					found := false
					for _, message := range request.Messages {
						if message.Role == "assistant" && len(message.ToolCalls) > 0 {
							found = true
							if (message.Reasoning == "当前 Run 的工具思考") != test.replay {
								t.Errorf("当前 Run 思考回传与供应商协议不符：%q", message.Reasoning)
							}
						}
					}
					if !found {
						t.Error("续轮上下文缺少工具提议")
					}
					response := finalReply("上一 Run 的最终答复")
					response.Reasoning = "上一 Run 的最终思考"
					return response, nil
				default:
					found := false
					for _, message := range request.Messages {
						if message.Reasoning != "" {
							t.Error("上一 Run 的思考进入新 Run")
						}
						if message.Role == "assistant" && message.Content == "上一 Run 的最终答复" {
							found = true
						}
					}
					if !found {
						t.Error("测试未覆盖上一 Run 的完整事实")
					}
					return finalReply("已验证新 Run"), nil
				}
			}, nil)
			credential := "test-key"
			profile, err := m.CreateModelProfile(model.Input{Provider: test.provider, APIFormat: test.format, BaseURL: "http://127.0.0.1:9", Model: "test", ContextTokens: 65536, OutputTokens: 4096, Capabilities: model.Capabilities{Text: true, Tools: true, Source: "test"}, Active: true, Credential: &credential})
			if err != nil {
				t.Fatal(err)
			}
			session, err := m.CreateSession(context.Background(), CreateSessionInput{Title: "工具续轮", ModelProfileID: profile.ID, ModelRevision: profile.Revision})
			if err != nil {
				t.Fatal(err)
			}
			first := submitAgentTest(t, m, session, "first", "检查容器")
			if run := runtimeFinished(t, m, first.ID); run.Status != StateSucceeded {
				t.Fatalf("第一轮未完成：%+v", run.Error)
			}
			second, duplicate, err := m.ContinueTask(context.Background(), first.TaskID, AgentInput{RequestID: "second", Content: "继续分析"})
			if err != nil || duplicate {
				t.Fatalf("续轮提交失败：duplicate=%v, %v", duplicate, err)
			}
			if run := runtimeFinished(t, m, second.ID); run.Status != StateSucceeded || inferences.Load() != 3 {
				t.Fatalf("第二轮未完成或请求次数错误：%+v, %d", run.Error, inferences.Load())
			}
		})
	}
}
