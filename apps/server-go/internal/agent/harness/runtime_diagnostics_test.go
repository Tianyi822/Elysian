package harness

import (
	"errors"
	"path/filepath"
	"testing"

	"elysian/server/internal/agent/harness/model"
)

func TestRuntimeDiagnosticsKeepOptionalFailuresSeparateAndExposeDispatchFreeze(t *testing.T) {
	s, _ := openRuntimeTestStore(t)
	profiles, err := model.Open(filepath.Join(t.TempDir(), "agent-models.json"))
	if err != nil {
		t.Fatal(err)
	}
	secret := "测试凭据"
	if _, err := profiles.Create(model.Input{Provider: model.ProviderOpenAICompatible, APIFormat: model.FormatChatCompletions, Name: "测试模型", BaseURL: "http://127.0.0.1:1/v1", Model: "test", ContextTokens: 8192, OutputTokens: 1024, Capabilities: model.Capabilities{Text: true, Tools: true, Source: "manual"}, Credential: &secret, Active: true}); err != nil {
		t.Fatal(err)
	}
	extensions := &Extensions{SkillsReason: "技能配置损坏", MCPReason: "MCP 配置损坏", ExecutionReason: "执行配置损坏"}
	m := &Manager{store: s, workerState: "ready", deps: Deps{Tools: &runtimeTestTools{}, Profiles: profiles, Catalog: extensions}}
	info := m.Info()
	if !info.Batch.Available || !info.Agent.Available {
		t.Fatalf("可选配置损坏不应影响基础能力：%+v", info)
	}
	if info.Skills.Available || info.MCP.Available || info.Execution.Available || info.Skills.Reason != extensions.SkillsReason || info.MCP.Reason != extensions.MCPReason || info.Execution.Reason != extensions.ExecutionReason {
		t.Fatalf("扩展诊断错误：%+v", info)
	}
	m.deps.DispatchGuard = func() error { return errors.New("受管执行容器恢复尚未确认，派发已暂停") }
	info = m.Info()
	if info.Available || info.Batch.Available || info.Agent.Available || info.Approvals.Available || info.Reason == "" || info.Agent.Reason != info.Reason || info.Batch.Reason != info.Reason || info.Approvals.Reason != info.Reason {
		t.Fatalf("冻结状态必须在所有可派发入口明确说明：%+v", info)
	}
}
