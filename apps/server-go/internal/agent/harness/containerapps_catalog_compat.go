package harness

import (
	"encoding/json"

	"elysian/server/internal/agent/mcp"
	"elysian/server/internal/agent/tools"
)

// 只接受 app_workspace_write 升 v2 的精确差异：新增 remove 布尔、content 转可选、
// 描述更新为互斥语义。其余 Schema、元数据与审批参数逐项相等，旧摘要按剥除差异后
// 的形状核对，绝不把删除语义施加给旧审批。
func legacyContainerAppsWriteCatalogCompatible(operation Operation, current tools.PublicSchema) bool {
	c := operation.Capability
	if c.Name != "app_workspace_write" || current.Name != c.Name || c.Source != "builtin" ||
		c.Metadata.Domain != "container-app" || c.Metadata.Version != "1" || current.Metadata.Version != "2" ||
		current.Description != "审批后写入普通配置文本或删除工作区内普通文件：content 与 remove 必须且只能提供一项，内容摘要不符时拒绝；不写凭据文件" {
		return false
	}
	raw, err := json.Marshal(current.Parameters)
	if err != nil {
		return false
	}
	var parameters map[string]any
	if json.Unmarshal(raw, &parameters) != nil {
		return false
	}
	properties, ok := parameters["properties"].(map[string]any)
	if !ok {
		return false
	}
	remove, ok := properties["remove"].(map[string]any)
	if !ok {
		return false
	}
	expectedRemove := tools.Schema{Type: tools.SchemaBoolean, Description: "true 表示删除该普通文件；与 content 互斥，必须且只能提供一项"}
	if digestJSON(remove) != digestJSON(expectedRemove.JSONSchema()) {
		return false
	}
	required, ok := parameters["required"].([]any)
	if !ok || len(required) != 3 || required[0] != "slug" || required[1] != "path" || required[2] != "expectedDigest" {
		return false
	}
	// 重建 v1 形状：去掉 remove、content 回必填、描述与版本回退，旧摘要必须逐字命中。
	delete(properties, "remove")
	parameters["required"] = []any{"slug", "path", "content", "expectedDigest"}
	previous := tools.PublicSchema{Name: current.Name, Description: "审批后写入普通配置文本，内容摘要不符时拒绝；不写凭据文件", Parameters: parameters, Metadata: current.Metadata}
	previous.Metadata.Version = "1"
	if digestJSON(previous) != c.CatalogDigest {
		return false
	}
	var frozenParameters map[string]any
	if json.Unmarshal(c.Parameters, &frozenParameters) != nil || mcp.Validate(c.Parameters, json.RawMessage(operation.ArgumentsJSON)) != nil {
		return false
	}
	frozen := tools.PublicSchema{Name: c.Name, Description: c.Description, Parameters: frozenParameters, Metadata: c.Metadata}
	return digestJSON(frozen) == c.CatalogDigest
}
