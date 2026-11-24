package harness

import (
	"encoding/json"

	hstate "elysian/server/internal/agent/harness/state"
	"elysian/server/internal/agent/mcp"
	"elysian/server/internal/agent/tools"
)

// 只接受 Docker 数据库接缝启用前后约定的精确元数据差异。
// 冻结元数据使旧处理器仍执行原路径，不把新语义施加给旧审批。
func legacyDockerContainerCatalogCompatible(operation Operation, current tools.PublicSchema) bool {
	if previous, ok := restoreHostScopeSchema(current); ok {
		frozen := operation.Capability
		var parameters map[string]any
		if frozen.Source == "builtin" && frozen.Name == previous.Name && frozen.ReadOnly == previous.Metadata.ReadOnly &&
			json.Unmarshal(frozen.Parameters, &parameters) == nil && mcp.Validate(frozen.Parameters, json.RawMessage(operation.ArgumentsJSON)) == nil &&
			hstate.DigestJSON(tools.PublicSchema{Name: frozen.Name, Description: frozen.Description, Parameters: parameters, Metadata: frozen.Metadata}) == frozen.CatalogDigest &&
			hstate.DigestJSON(previous) == frozen.CatalogDigest {
			return true
		}
		current = previous
	}
	return legacyDockerContainerCatalogCore(operation, current) || legacyDockerRetiredDatabaseCatalogCompatible(operation, current)
}

// 逻辑库退役前的冻结文案（升 v3／v4 与 env 说明回退之前的目录）。
const retiredExecDescription = "在精确受管容器中执行argv命令，或通过databaseChange同步创建/删除受管逻辑库及登记；两者互斥。受管数据库禁止任意argv，先inspect取得revision。密码由后端处理，不传入参数。requestId精确重试复用。Redis remove仅清空DB0并保留登记。异步等待由系统监视器完成。"

// legacyDockerRetiredDatabaseCatalogCompatible 把当前目录精确还原为逻辑库退役前
// 的冻结形状（exec v2 的 databaseChange 参数、inspect v3 的 database 参数、
// create_service 含初始逻辑库要求的 env 说明），再按既有版本链核对。
// 只还原退役文字与已删除参数，不放宽参数校验、元数据与审批约束。
func legacyDockerRetiredDatabaseCatalogCompatible(operation Operation, current tools.PublicSchema) bool {
	c := operation.Capability
	if c.Source != "builtin" || current.Name != c.Name {
		return false
	}
	restored, ok := restoreRetiredDatabaseSchema(current)
	if !ok {
		return false
	}
	var parameters map[string]any
	if json.Unmarshal(c.Parameters, &parameters) != nil || mcp.Validate(c.Parameters, json.RawMessage(operation.ArgumentsJSON)) != nil {
		return false
	}
	frozen := tools.PublicSchema{Name: c.Name, Description: c.Description, Parameters: parameters, Metadata: c.Metadata}
	if hstate.DigestJSON(frozen) != c.CatalogDigest {
		return false
	}
	if hstate.DigestJSON(restored) == c.CatalogDigest {
		return true
	}
	return legacyDockerContainerCatalogCore(operation, restored)
}

// restoreRetiredDatabaseSchema 当前目录 → 退役前一个版本的精确形状；
// 形状不符（未来再演化）时返回 false，绝不错配历史快照。
func restoreRetiredDatabaseSchema(current tools.PublicSchema) (tools.PublicSchema, bool) {
	raw, err := json.Marshal(current)
	if err != nil {
		return current, false
	}
	var copy tools.PublicSchema
	if json.Unmarshal(raw, &copy) != nil {
		return current, false
	}
	properties, ok := copy.Parameters["properties"].(map[string]any)
	if !ok {
		return current, false
	}
	switch copy.Name {
	case "docker_container_exec":
		if copy.Metadata.Version != "3" || copy.Description != "在精确受管容器中执行argv命令。受管数据库容器禁止任意argv。requestId精确重试复用。异步等待由系统监视器完成。" {
			return current, false
		}
		text := tools.Schema{Type: tools.SchemaString}
		properties["databaseChange"] = tools.Schema{Type: tools.SchemaObject, Required: []string{"action", "name", "expectedRevision"}, Properties: map[string]tools.Schema{
			"action": {Type: tools.SchemaString, Enum: tools.EnumOf("create", "remove")}, "name": text, "expectedRevision": text, "charset": text,
		}}.JSONSchema()
		copy.Description = retiredExecDescription
		copy.Metadata.Version = "2"
	case "docker_container_inspect":
		if copy.Metadata.Version != "4" {
			return current, false
		}
		query := tools.Schema{Type: tools.SchemaObject, Description: "首次检查省略此项，先取得登记摘要和 revision；仅按需读取某个登记的元数据或指标", Required: []string{"id"}, Properties: map[string]tools.Schema{
			"id": {Type: tools.SchemaString, Description: "基础检查结果 database.databases[].id 中的数据库登记 ID，不是容器 ID"}, "metadata": {Type: tools.SchemaBoolean}, "metrics": {Type: tools.SchemaBoolean},
		}}
		properties["database"] = query.JSONSchema()
		copy.Metadata.Version = "3"
	case "docker_container_create_service":
		item, _ := properties["env"].(map[string]any)
		if item == nil || item["description"] != "非凭据环境变量 KEY=VALUE 列表，最多 16 项、每项不超过 512 字节，完整进入审批展示" {
			return current, false
		}
		item["description"] = "非凭据环境变量 KEY=VALUE 列表，最多 16 项、每项不超过 512 字节，完整进入审批展示。MySQL 必须提供 MYSQL_DATABASE=初始逻辑库名，MariaDB 必须提供 MARIADB_DATABASE=初始逻辑库名；库名未知先用 request_user_input 询问，不得编造；密码只用 credentials 声明由后端生成"
	default:
		return current, false
	}
	return copy, true
}
func legacyDockerContainerCatalogCore(operation Operation, current tools.PublicSchema) bool {
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
		if c.Source != "builtin" || c.Name != current.Name || hstate.DigestJSON(frozen) != c.CatalogDigest {
			return false
		}
		if hstate.DigestJSON(normalized) == c.CatalogDigest {
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
		if hstate.DigestJSON(properties["database"]) != hstate.DigestJSON(query.JSONSchema()) {
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
	return hstate.DigestJSON(frozen) == c.CatalogDigest && hstate.DigestJSON(current) == c.CatalogDigest
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
		if hstate.DigestJSON(properties["requestId"]) != hstate.DigestJSON(expected.JSONSchema()) {
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
		if hstate.DigestJSON(properties["database"]) != hstate.DigestJSON(query.JSONSchema()) {
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
