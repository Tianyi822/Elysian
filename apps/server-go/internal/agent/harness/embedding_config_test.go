package harness

import (
	"os"
	"path/filepath"
	"testing"
)

func TestEmbeddingConfigurationUsesAgentDirectoryAndIgnoresLegacy(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "config"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "config", "agent-embeddings.json"), []byte("损坏的旧配置应忽略"), 0600); err != nil {
		t.Fatal(err)
	}
	m := &Manager{deps: Deps{Path: filepath.Join(root, "data", "harness.sqlite")}}
	if path := m.embeddingConfigPath(); path != filepath.Join(root, "config", "agent", "embeddings.json") {
		t.Fatalf("Embedding 缺省路径未进入 Agent 目录：%q", path)
	}
	if records, err := m.readEmbeddingProfiles(); err != nil || len(records) != 0 {
		t.Fatalf("读取了旧 Embedding 配置：%+v %v", records, err)
	}
	explicitPath := filepath.Join(t.TempDir(), "config", "agent", "embeddings.json")
	m.deps.EmbeddingConfigPath = explicitPath
	if err := m.writeEmbeddingProfiles(nil); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(explicitPath); err != nil {
		t.Fatalf("Embedding 未写入装配注入路径：%v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "config", "agent", "embeddings.json")); !os.IsNotExist(err) {
		t.Fatalf("显式路径配置仍写入推导路径：%v", err)
	}
}
