package harness

import (
	"encoding/json"
	"strings"
	"testing"

	"elysian/server/internal/agent/tools"
)

func dockerLegacyOperation(schema tools.PublicSchema) Operation {
	if previous, ok := previousDockerReceiptSchema(schema); ok {
		schema = previous
	}
	legacy := schema
	legacy.Metadata.Version = "1"
	if schema.Name == "docker_container_create_service" {
		legacy.Metadata.Async = false
		legacy.Metadata.TaskDomain = ""
		legacy.Metadata.TaskRequestArgument = ""
	}
	if schema.Name == "docker_container_inspect" {
		raw, _ := json.Marshal(schema.Parameters)
		legacy.Parameters = nil
		_ = json.Unmarshal(raw, &legacy.Parameters)
		delete(legacy.Parameters["properties"].(map[string]any), "database")
	}
	parameters, _ := json.Marshal(legacy.Parameters)
	arguments := `{"id":"` + strings.Repeat("c", 64) + `"}`
	if schema.Name == "docker_container_create_service" {
		arguments = `{"requestId":"` + strings.Repeat("r", 64) + `","image":"nginx:1.27@sha256:` + strings.Repeat("a", 64) + `","name":"web","resourceTier":"small","networkScope":"container-net"}`
	}
	return Operation{ArgumentsJSON: arguments, Capability: Capability{
		Name: legacy.Name, Description: legacy.Description, Source: "builtin", ReadOnly: legacy.Metadata.ReadOnly,
		Metadata: legacy.Metadata, Parameters: parameters, CatalogDigest: digestJSON(legacy),
	}}
}

func TestDockerContainerCatalogCompatibilityOnlyAcceptsFrozenVersionChange(t *testing.T) {
	bridge, _ := dockerCatalogBridge(t)
	checked := 0
	for _, schema := range bridge.Schemas() {
		switch schema.Name {
		case "docker_container_create_service", "docker_container_start", "docker_container_stop", "docker_container_restart", "docker_container_remove", "docker_container_inspect":
		default:
			continue
		}
		t.Run(schema.Name, func(t *testing.T) {
			operation := dockerLegacyOperation(schema)
			beforeOperation, beforeSchema := digestJSON(operation), digestJSON(schema)
			if !legacyDockerContainerCatalogCompatible(operation, schema) {
				t.Fatal("约定的版本元数据升级应允许旧快照恢复")
			}
			if digestJSON(operation) != beforeOperation || digestJSON(schema) != beforeSchema {
				t.Fatal("兼容核验改写了冻结快照或当前目录")
			}
			for _, mutation := range []string{"source", "digest", "description", "metadata", "parameters", "arguments", "readonly"} {
				t.Run(mutation, func(t *testing.T) {
					operation := dockerLegacyOperation(schema)
					var current tools.PublicSchema
					raw, _ := json.Marshal(schema)
					_ = json.Unmarshal(raw, &current)
					switch mutation {
					case "source":
						operation.Capability.Source = "mcp-tool"
					case "digest":
						operation.Capability.CatalogDigest = digestJSON(current)
					case "description":
						current.Description += " changed"
					case "metadata":
						current.Metadata.Domain = "changed-domain"
					case "parameters":
						current.Parameters["additionalProperties"] = true
					case "arguments":
						operation.ArgumentsJSON = `{"unapproved":true}`
					case "readonly":
						operation.Capability.ReadOnly = !operation.Capability.ReadOnly
					}
					if legacyDockerContainerCatalogCompatible(operation, current) {
						t.Fatal("兼容核验放宽了冻结工具约束")
					}
				})
			}
		})
		checked++
	}
	if checked != 6 {
		t.Fatalf("没有覆盖全部升级工具: %d", checked)
	}
}

// This fixture is the published exec v1 definition, independent of current descriptors.
func TestDockerExecFrozenV1SchemaSurvivesReceiptDocumentationUpdate(t *testing.T) {
	text := tools.Schema{Type: tools.SchemaString}
	old := tools.PublicSchema{Name: "docker_container_exec", Description: "在精确受管容器中执行argv命令，或通过databaseChange同步创建/删除受管逻辑库及登记；两者互斥。受管数据库禁止任意argv，先inspect取得revision。密码由后端处理，不传入参数。requestId精确重试复用。Redis remove仅清空DB0并保留登记。异步等待由系统监视器完成。", Parameters: tools.Schema{Type: tools.SchemaObject, Required: []string{"id", "requestId"}, Properties: map[string]tools.Schema{"id": text, "requestId": text, "argv": {Type: tools.SchemaArray, Items: &text}, "workdir": text, "databaseChange": {Type: tools.SchemaObject, Required: []string{"action", "name", "expectedRevision"}, Properties: map[string]tools.Schema{"action": {Type: tools.SchemaString, Enum: tools.EnumOf("create", "remove")}, "name": text, "expectedRevision": text, "charset": text}}}}.JSONSchema(), Metadata: tools.Metadata{Domain: "docker", Backend: "domain", Action: "exec", Effect: "execute", Exposure: "agent", ResourceType: "docker-container", ResourceKeyArgument: "id", Version: "1", Async: true, TaskDomain: "docker-container-operation", TaskRequestArgument: "requestId"}}
	parameters, _ := json.Marshal(old.Parameters)
	op := Operation{ArgumentsJSON: `{"id":"` + strings.Repeat("c", 64) + `","requestId":"` + strings.Repeat("a", 64) + `","argv":["true"]}`, Capability: Capability{Name: old.Name, Description: old.Description, Source: "builtin", Metadata: old.Metadata, Parameters: parameters, CatalogDigest: digestJSON(old)}}
	bridge, _ := dockerCatalogBridge(t)
	for _, schema := range bridge.Schemas() {
		if schema.Name == old.Name {
			if !legacyDockerContainerCatalogCompatible(op, schema) {
				t.Fatal("fixed v1 snapshot rejected")
			}
			changed := op
			changed.Capability.CatalogDigest = "altered"
			if legacyDockerContainerCatalogCompatible(changed, schema) {
				t.Fatal("digest check bypassed")
			}
			return
		}
	}
	t.Fatal("exec missing")
}
