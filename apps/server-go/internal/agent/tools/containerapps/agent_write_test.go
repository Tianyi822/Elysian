package containerapps

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"testing"

	"elysian/server/internal/agent/tools"
	domainapps "elysian/server/internal/containerapps"
)

func schemaDigest(value any) string {
	raw, _ := json.Marshal(value)
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

// 历史 v1 公开模式：旧快照冻结的形状，Backend 由注册表缺省补齐为 domain。
func legacyWorkspaceWriteV1Schema() tools.PublicSchema {
	text := tools.Schema{Type: tools.SchemaString}
	return tools.PublicSchema{
		Name:        "app_workspace_write",
		Description: "审批后写入普通配置文本，内容摘要不符时拒绝；不写凭据文件",
		Parameters: tools.Schema{Type: tools.SchemaObject, Required: []string{"slug", "path", "content", "expectedDigest"},
			Properties: map[string]tools.Schema{"slug": text, "path": text, "content": text, "expectedDigest": text}}.JSONSchema(),
		Metadata: tools.Metadata{Domain: "container-app", Backend: "domain", Action: "app_workspace_write", Effect: "write", Exposure: "agent", ResourceType: "container-app", ResourceKeyArgument: "slug", Version: "1"},
	}
}

func TestWorkspaceWriteV2ConvergesRemoveFileWithExactLegacyShape(t *testing.T) {
	facade := domainapps.NewAgentFacade(domainapps.Handler{}, func(context.Context) error { return nil })
	_, toolset := install(t, Deps{Workspace: &domainapps.Registry{MountRoot: t.TempDir()}, Facade: facade}, Config{})
	schemas := map[string]tools.PublicSchema{}
	for _, schema := range toolset.Schemas() {
		schemas[schema.Name] = schema
	}
	write, ok := schemas["app_workspace_write"]
	if !ok {
		t.Fatal("app_workspace_write 未注册")
	}
	if write.Metadata.Version != "2" || write.Metadata.Action != "app_workspace_write" || write.Metadata.ReadOnly {
		t.Fatalf("write v2 元数据不符：%+v", write.Metadata)
	}
	if _, kept := schemas["app_workspace_remove_file"]; !kept {
		t.Fatal("app_workspace_remove_file 必须保留注册供旧快照恢复")
	}
	if remove, ok := schemas["app_workspace_remove_file"]; ok && remove.Metadata.Version != "1" {
		t.Fatalf("remove_file 冻结形状不符：%+v", remove.Metadata)
	}
	// compat 摘要回环：剥除 v2 差异后必须逐字还原历史 v1 形状。
	raw, err := json.Marshal(write.Parameters)
	if err != nil {
		t.Fatal(err)
	}
	var parameters map[string]any
	if json.Unmarshal(raw, &parameters) != nil {
		t.Fatal(err)
	}
	properties, _ := parameters["properties"].(map[string]any)
	if _, has := properties["remove"]; !has {
		t.Fatal("v2 缺少 remove 互斥参数")
	}
	delete(properties, "remove")
	parameters["required"] = []any{"slug", "path", "content", "expectedDigest"}
	previous := tools.PublicSchema{Name: write.Name, Description: "审批后写入普通配置文本，内容摘要不符时拒绝；不写凭据文件", Parameters: parameters, Metadata: write.Metadata}
	previous.Metadata.Version = "1"
	if schemaDigest(previous) != schemaDigest(legacyWorkspaceWriteV1Schema()) {
		t.Fatal("剥除差异后的形状必须与历史 v1 摘要逐字一致")
	}
}

func TestParseWorkspaceWriteArgsMutualExclusion(t *testing.T) {
	content, remove, err := parseWorkspaceWriteArgs(tools.Arguments{"content": "hello"})
	if err != nil || content != "hello" || remove {
		t.Fatalf("仅 content 应走写入：%q %v %v", content, remove, err)
	}
	// v1 形状的空文件写入：content 键存在且为空串。
	content, remove, err = parseWorkspaceWriteArgs(tools.Arguments{"content": ""})
	if err != nil || content != "" || remove {
		t.Fatalf("空串 content 仍是写入：%q %v %v", content, remove, err)
	}
	_, remove, err = parseWorkspaceWriteArgs(tools.Arguments{"remove": true})
	if err != nil || !remove {
		t.Fatalf("仅 remove=true 应走删除：%v %v", remove, err)
	}
	for name, bad := range map[string]tools.Arguments{
		"两者同给":           {"content": "x", "remove": true},
		"两者都缺":           {},
		"remove 为 false": {"remove": false},
	} {
		if _, _, err := parseWorkspaceWriteArgs(bad); err == nil {
			t.Fatalf("互斥违规应拒绝：%s %v", name, bad)
		}
	}
}
