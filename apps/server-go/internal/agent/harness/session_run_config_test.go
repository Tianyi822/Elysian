package harness

import (
	"context"
	"testing"

	"elysian/server/internal/agent/harness/model"
)

// 公开消息携带所属 Run 固定的模型与思考等级，轮次边界上的切换由前端据此展示。
func TestMessagesExposeRunModelAndReasoningConfig(t *testing.T) {
	m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, request model.Request) (model.Response, error) {
		if request.ToolChoice == "store_working_memory" {
			return memoryReply(request), nil
		}
		return finalReply("已完成"), nil
	}, nil)
	first := submitAgentTest(t, m, session, "run-config-first", "第一轮")
	if got := runtimeFinished(t, m, first.ID); got.Status != StateSucceeded {
		t.Fatalf("第一轮失败：%+v", got)
	}
	secret := "run-config-secret"
	second, err := m.CreateModelProfile(model.Input{Provider: model.ProviderOpenAICompatible, APIFormat: model.FormatChatCompletions,
		BaseURL: "http://127.0.0.1:9/v1", Model: "second-model", ContextTokens: 65536, OutputTokens: 4096,
		Capabilities: model.Capabilities{Text: true, Tools: true, ReasoningLevels: []string{"low", "high"}, Source: "test"},
		Active:       true, Credential: &secret})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = m.SwitchSessionModel(context.Background(), session.ID, SwitchModelInput{ModelProfileID: second.ID, ModelRevision: second.Revision}); err != nil {
		t.Fatal(err)
	}
	next, _, err := m.ContinueTask(context.Background(), first.TaskID, AgentInput{RequestID: "run-config-second", Content: "第二轮", ReasoningLevel: "high"})
	if err != nil {
		t.Fatal(err)
	}
	if got := runtimeFinished(t, m, next.ID); got.Status != StateSucceeded {
		t.Fatalf("第二轮失败：%+v", got)
	}
	history, err := m.Messages(context.Background(), session.ID, "", 50)
	if err != nil {
		t.Fatal(err)
	}
	var users []Message
	for _, message := range history.Items {
		if message.Role == "user" {
			users = append(users, message)
		}
	}
	if len(users) != 2 {
		t.Fatalf("用户消息数量错误：%+v", users)
	}
	firstConfig := users[0].RunConfig
	if firstConfig == nil || firstConfig.ModelName != "test" || firstConfig.ModelProfileID != session.ModelProfileID || firstConfig.ReasoningLevel != "" {
		t.Fatalf("首轮模型快照错误：%+v", firstConfig)
	}
	nextConfig := users[1].RunConfig
	if nextConfig == nil || nextConfig.ModelName != "second-model" || nextConfig.ModelProfileID != second.ID || nextConfig.ModelRevision != second.Revision || nextConfig.ReasoningLevel != "high" {
		t.Fatalf("续轮模型快照错误：%+v", nextConfig)
	}
	var assistants []Message
	for _, message := range history.Items {
		if message.Role == "assistant" {
			assistants = append(assistants, message)
		}
	}
	if len(assistants) != 2 || assistants[0].RunConfig == nil || assistants[0].RunConfig.ModelProfileID != session.ModelProfileID ||
		assistants[1].RunConfig == nil || assistants[1].RunConfig.ModelProfileID != second.ID {
		t.Fatalf("助手消息未回填所属 Run 模型：%+v", assistants)
	}
}
