package harness

import (
	"encoding/json"

	"elysian/server/internal/agent/mcp"
	"elysian/server/internal/agent/tools"
)

// 只兼容 database_discover 的 versionTag 说明补充；旧参数与授权仍按固定快照核验。
func legacyDatabaseDiscoverCatalogCompatible(operation Operation, current tools.PublicSchema) bool {
	c := operation.Capability
	if c.Name != "database_discover" || current.Name != c.Name || c.Source != "builtin" || !c.ReadOnly || c.Description != current.Description || c.Metadata != current.Metadata || c.Metadata.Domain != "database" || !current.Metadata.ReadOnly || current.Metadata.Async {
		return false
	}
	var frozenParameters, parameters map[string]any
	raw, err := json.Marshal(current.Parameters)
	if err != nil || json.Unmarshal(raw, &parameters) != nil || json.Unmarshal(c.Parameters, &frozenParameters) != nil {
		return false
	}
	frozen := tools.PublicSchema{Name: c.Name, Description: c.Description, Parameters: frozenParameters, Metadata: c.Metadata}
	if digestJSON(frozen) != c.CatalogDigest || mcp.Validate(c.Parameters, json.RawMessage(operation.ArgumentsJSON)) != nil {
		return false
	}
	properties, ok := parameters["properties"].(map[string]any)
	if !ok {
		return false
	}
	version, ok := properties["versionTag"].(map[string]any)
	if !ok {
		return false
	}
	delete(version, "description")
	current.Parameters = parameters
	return digestJSON(frozen) == digestJSON(current)
}
