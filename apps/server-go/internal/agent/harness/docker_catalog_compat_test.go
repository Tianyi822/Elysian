package harness

import (
	"encoding/json"
	"strings"
	"testing"

	"elysian/server/internal/agent/tools"
)

func dockerLegacyOperation(schema tools.PublicSchema) Operation {
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
			for _, mutation := range []string{"source", "digest", "description", "metadata", "parameters", "arguments"} {
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
