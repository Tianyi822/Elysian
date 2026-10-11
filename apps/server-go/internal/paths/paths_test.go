package paths

import (
	"path/filepath"
	"testing"
)

func TestAgentConfigurationPathsShareDedicatedDirectory(t *testing.T) {
	wantRoot := filepath.Join(ElysianHome, "config", "agent")
	for name, path := range map[string]string{
		"models.json":      Default.AgentModels,
		"skills.json":      Default.AgentSkills,
		"mcp-servers.json": Default.AgentMCPServers,
		"execution.json":   Default.AgentExecution,
		"embeddings.json":  Default.AgentEmbeddings,
		"runtime.json":     Default.AgentRuntime,
	} {
		if path != filepath.Join(wantRoot, name) {
			t.Errorf("Agent 配置 %s 路径 = %q", name, path)
		}
	}
}
