package harness

import (
	"encoding/json"
	"testing"

	"elysian/server/internal/agent/tools"
)

func databaseLegacyCatalogFixture(t *testing.T) (Operation, tools.PublicSchema) {
	t.Helper()
	bridge := databaseBusinessBridge(t)
	for _, schema := range bridge.Schemas() {
		if schema.Name != "database_discover" {
			continue
		}
		var parameters map[string]any
		raw, _ := json.Marshal(schema.Parameters)
		_ = json.Unmarshal(raw, &parameters)
		version := parameters["properties"].(map[string]any)["versionTag"].(map[string]any)
		delete(version, "description")
		legacy := schema
		legacy.Parameters = parameters
		frozen, _ := json.Marshal(parameters)
		return Operation{ArgumentsJSON: `{"engine":"MySQL","versionTag":"8.0"}`, Capability: Capability{
			Name: schema.Name, Description: schema.Description, Source: "builtin", ReadOnly: true, Metadata: schema.Metadata, Parameters: frozen, CatalogDigest: digestJSON(legacy),
		}}, schema
	}
	t.Fatal("缺少数据库发现工具")
	return Operation{}, tools.PublicSchema{}
}

func TestDatabaseCatalogCompatibilityOnlyAddsVersionDescription(t *testing.T) {
	operation, schema := databaseLegacyCatalogFixture(t)
	beforeOperation, beforeSchema := digestJSON(operation), digestJSON(schema)
	if !legacyDatabaseDiscoverCatalogCompatible(operation, schema) {
		t.Fatal("只补充版本说明不应阻止旧运行恢复")
	}
	if digestJSON(operation) != beforeOperation || digestJSON(schema) != beforeSchema {
		t.Fatal("兼容检查改写了固定快照或注册表")
	}
	for _, kind := range []string{"tool", "source", "read-only", "metadata", "description", "schema", "digest", "arguments"} {
		t.Run(kind, func(t *testing.T) {
			operation, current := databaseLegacyCatalogFixture(t)
			switch kind {
			case "tool":
				current.Name = "other_tool"
			case "source":
				operation.Capability.Source = "mcp-tool"
			case "read-only":
				operation.Capability.ReadOnly = false
			case "metadata":
				current.Metadata.ReadOnly = false
			case "description":
				current.Description += "变化"
			case "schema":
				current.Parameters["additionalProperties"] = true
			case "digest":
				operation.Capability.CatalogDigest = digestJSON(current)
			case "arguments":
				operation.ArgumentsJSON = `{"engine":"MySQL","versionTag":"8.0","unapproved":true}`
			}
			if legacyDatabaseDiscoverCatalogCompatible(operation, current) {
				t.Fatal("兼容检查放宽了工具或原始参数约束")
			}
		})
	}
}
