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
	if c.ReadOnly != c.Metadata.ReadOnly || c.ReadOnly != current.Metadata.ReadOnly {
		return false
	}
	if normalized, ok := previousDockerReceiptSchema(current); ok {
		var parameters map[string]any
		if json.Unmarshal(c.Parameters, &parameters) != nil || mcp.Validate(c.Parameters, json.RawMessage(operation.ArgumentsJSON)) != nil {
			return false
		}
		frozen := tools.PublicSchema{Name: c.Name, Description: c.Description, Parameters: parameters, Metadata: c.Metadata}
		if c.Source != "builtin" || c.Name != current.Name || digestJSON(frozen) != c.CatalogDigest {
			return false
		}
		if digestJSON(normalized) == c.CatalogDigest {
			return true
		}
		current = normalized
	}
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

// Only the exact reviewed documentation/validation additions are reversible.
// All other schema, permission and handler metadata still participate in equality.
func previousDockerReceiptSchema(current tools.PublicSchema) (tools.PublicSchema, bool) {
	raw, err := json.Marshal(current)
	var copy tools.PublicSchema
	if err != nil || json.Unmarshal(raw, &copy) != nil {
		return current, false
	}
	properties, ok := copy.Parameters["properties"].(map[string]any)
	if !ok {
		return current, false
	}
	switch copy.Name {
	case "docker_container_exec", "docker_container_create_service":
		previous, description := "1", "64 位小写十六进制稳定请求标识；精确重试复用原值与完整参数"
		if copy.Name == "docker_container_create_service" {
			previous, description = "2", "64 位小写十六进制稳定请求标识；同请求重试必须复用原值与完整参数"
		}
		if copy.Name == "docker_container_exec" && copy.Metadata.Version != "2" || copy.Name == "docker_container_create_service" && copy.Metadata.Version != "3" {
			return current, false
		}
		expected := tools.Schema{Type: tools.SchemaString, Pattern: "^[a-f0-9]{64}$", Description: description}
		if digestJSON(properties["requestId"]) != digestJSON(expected.JSONSchema()) {
			return current, false
		}
		old := tools.Schema{Type: tools.SchemaString}
		if copy.Name == "docker_container_create_service" {
			old.Description = "稳定的请求标识；同请求重试必须复用原值与完整参数"
		}
		properties["requestId"] = old.JSONSchema()
		copy.Metadata.Version = previous
	case "docker_container_inspect":
		if copy.Metadata.Version != "3" {
			return current, false
		}
		query := tools.Schema{Type: tools.SchemaObject, Description: "首次检查省略此项，先取得登记摘要和 revision；仅按需读取某个登记的元数据或指标", Required: []string{"id"}, Properties: map[string]tools.Schema{"id": {Type: tools.SchemaString, Description: "基础检查结果 database.databases[].id 中的数据库登记 ID，不是容器 ID"}, "metadata": {Type: tools.SchemaBoolean}, "metrics": {Type: tools.SchemaBoolean}}}
		if digestJSON(properties["database"]) != digestJSON(query.JSONSchema()) {
			return current, false
		}
		query.Description = ""
		id := query.Properties["id"]
		id.Description = ""
		query.Properties["id"] = id
		properties["database"] = query.JSONSchema()
		copy.Metadata.Version = "2"
	case "docker_container_remove":
		if copy.Metadata.Version != "3" || copy.Description != "审批后对已授权的安全容器执行 remove；支持停止态受管数据库容器及专属卷删除，无需先删除逻辑库；保留登记、兄弟库和容器卷身份核验" {
			return current, false
		}
		copy.Description = "审批后对已授权的安全容器执行 remove"
		copy.Metadata.Version = "2"
	default:
		return current, false
	}
	return copy, true
}
