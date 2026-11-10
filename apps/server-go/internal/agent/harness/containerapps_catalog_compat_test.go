package harness

import (
	"encoding/json"
	"testing"

	"elysian/server/internal/agent/tools"
)

// 历史 v1 快照（旧公开模式逐字重建，Backend 为注册表缺省补齐后的值）。
func containerAppsWriteLegacyOperation() Operation {
	text := tools.Schema{Type: tools.SchemaString}
	legacy := tools.PublicSchema{
		Name:        "app_workspace_write",
		Description: "审批后写入普通配置文本，内容摘要不符时拒绝；不写凭据文件",
		Parameters: tools.Schema{Type: tools.SchemaObject, Required: []string{"slug", "path", "content", "expectedDigest"},
			Properties: map[string]tools.Schema{"slug": text, "path": text, "content": text, "expectedDigest": text}}.JSONSchema(),
		Metadata: tools.Metadata{Domain: "container-app", Backend: "domain", Action: "app_workspace_write", Effect: "write", Exposure: "agent", ResourceType: "container-app", ResourceKeyArgument: "slug", Version: "1"},
	}
	parameters, _ := json.Marshal(legacy.Parameters)
	return Operation{ArgumentsJSON: `{"slug":"demo","path":"a.txt","content":"hello","expectedDigest":"abc"}`, Capability: Capability{
		Name: legacy.Name, Description: legacy.Description, Source: "builtin", ReadOnly: legacy.Metadata.ReadOnly,
		Metadata: legacy.Metadata, Parameters: parameters, CatalogDigest: digestJSON(legacy),
	}}
}

// 与 tools/containerapps 描述符同形的 v2 当前模式（tools 侧测试钉住两者摘要一致）。
func containerAppsWriteCurrentSchema() tools.PublicSchema {
	text := tools.Schema{Type: tools.SchemaString}
	return tools.PublicSchema{
		Name:        "app_workspace_write",
		Description: "审批后写入普通配置文本或删除工作区内普通文件：content 与 remove 必须且只能提供一项，内容摘要不符时拒绝；不写凭据文件",
		Parameters: tools.Schema{Type: tools.SchemaObject, Required: []string{"slug", "path", "expectedDigest"},
			Properties: map[string]tools.Schema{"slug": text, "path": text, "content": text, "expectedDigest": text,
				"remove": {Type: tools.SchemaBoolean, Description: "true 表示删除该普通文件；与 content 互斥，必须且只能提供一项"}}}.JSONSchema(),
		Metadata: tools.Metadata{Domain: "container-app", Backend: "domain", Action: "app_workspace_write", Effect: "write", Exposure: "agent", ResourceType: "container-app", ResourceKeyArgument: "slug", Version: "2"},
	}
}

func TestContainerAppsWriteCatalogCompatibilityOnlyAcceptsFrozenUpgrade(t *testing.T) {
	operation := containerAppsWriteLegacyOperation()
	current := containerAppsWriteCurrentSchema()
	if !legacyContainerAppsWriteCatalogCompatible(operation, current) {
		t.Fatal("约定的 v1→v2 升级应允许旧快照恢复")
	}
	for _, mutation := range []struct {
		name  string
		apply func(Operation, tools.PublicSchema) (Operation, tools.PublicSchema)
	}{
		{"source", func(o Operation, c tools.PublicSchema) (Operation, tools.PublicSchema) {
			o.Capability.Source = "mcp-tool"
			return o, c
		}},
		{"digest", func(o Operation, c tools.PublicSchema) (Operation, tools.PublicSchema) {
			o.Capability.CatalogDigest = digestJSON(c)
			return o, c
		}},
		{"description", func(o Operation, c tools.PublicSchema) (Operation, tools.PublicSchema) {
			c.Description += " changed"
			return o, c
		}},
		{"metadata", func(o Operation, c tools.PublicSchema) (Operation, tools.PublicSchema) {
			c.Metadata.Domain = "changed"
			return o, c
		}},
		{"parameters", func(o Operation, c tools.PublicSchema) (Operation, tools.PublicSchema) {
			c.Parameters["additionalProperties"] = true
			return o, c
		}},
		{"arguments", func(o Operation, c tools.PublicSchema) (Operation, tools.PublicSchema) {
			o.ArgumentsJSON = `{"unapproved":true}`
			return o, c
		}},
	} {
		t.Run(mutation.name, func(t *testing.T) {
			o, c := mutation.apply(containerAppsWriteLegacyOperation(), containerAppsWriteCurrentSchema())
			if legacyContainerAppsWriteCatalogCompatible(o, c) {
				t.Fatal("兼容核验放宽了冻结工具约束")
			}
		})
	}
}
