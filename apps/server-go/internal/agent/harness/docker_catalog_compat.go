package harness

import (
	"encoding/json"

	"elysian/server/internal/agent/mcp"
	"elysian/server/internal/agent/tools"
)

// 只接受 Docker 数据库接缝启用前后约定的精确元数据差异。
// 冻结元数据使旧处理器仍执行原路径，不把新语义施加给旧审批。
func legacyDockerContainerCatalogCompatible(operation Operation, current tools.PublicSchema) bool {
	c := operation.Capability
	if c.Source != "builtin" || current.Name != c.Name || c.Metadata.Version != "1" || current.Metadata.Version != "2" {
		return false
	}
	switch c.Name {
	case "docker_container_create_service":
		if c.Metadata.Async || !current.Metadata.Async || current.Metadata.TaskDomain != "docker-container-operation" || current.Metadata.TaskRequestArgument != "requestId" {
			return false
		}
		current.Metadata.Async = false
		current.Metadata.TaskDomain = ""
		current.Metadata.TaskRequestArgument = ""
	case "docker_container_start", "docker_container_stop", "docker_container_restart", "docker_container_remove":
	case "docker_container_inspect":
		if !c.ReadOnly || !current.Metadata.ReadOnly {
			return false
		}
		raw, err := json.Marshal(current.Parameters)
		var parameters map[string]any
		if err != nil || json.Unmarshal(raw, &parameters) != nil {
			return false
		}
		properties, ok := parameters["properties"].(map[string]any)
		if !ok {
			return false
		}
		query := tools.Schema{Type: tools.SchemaObject, Required: []string{"id"}, Properties: map[string]tools.Schema{
			"id": {Type: tools.SchemaString}, "metadata": {Type: tools.SchemaBoolean}, "metrics": {Type: tools.SchemaBoolean},
		}}
		if digestJSON(properties["database"]) != digestJSON(query.JSONSchema()) {
			return false
		}
		delete(properties, "database")
		current.Parameters = parameters
	default:
		return false
	}
	if c.Name != "docker_container_inspect" && c.ReadOnly {
		return false
	}
	current.Metadata.Version = "1"
	var parameters map[string]any
	if json.Unmarshal(c.Parameters, &parameters) != nil || mcp.Validate(c.Parameters, json.RawMessage(operation.ArgumentsJSON)) != nil {
		return false
	}
	frozen := tools.PublicSchema{Name: c.Name, Description: c.Description, Parameters: parameters, Metadata: c.Metadata}
	return digestJSON(frozen) == c.CatalogDigest && digestJSON(current) == c.CatalogDigest
}
