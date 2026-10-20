package harness

import (
	"encoding/json"
	"path/filepath"

	"elysian/server/internal/agent/mcp"
	"elysian/server/internal/agent/tools"
)

// legacyFileCatalogCompatible recognizes only the removal of the startup root
// enum from a native file tool. The old enum remains authoritative for this
// operation, and the caller still checks its frozen grants and root identity.
func legacyFileCatalogCompatible(snapshot CapabilitySnapshot, operation Operation, current tools.PublicSchema) bool {
	c := operation.Capability
	if snapshot.AuthorizationMode == AuthorizationOnDemand || c.Source != "builtin" || c.CatalogDigest == "" || c.Name != current.Name || c.Description != current.Description || c.Metadata != current.Metadata || c.Metadata.Domain != "files" || c.Metadata.ResourceType != "filesystem" || c.Metadata.ResourceKeyArgument != "root" {
		return false
	}
	switch c.Name {
	case "file_list", "file_read", "file_write", "file_copy", "file_move", "file_delete":
	default:
		return false
	}
	var parameters map[string]any
	if json.Unmarshal(c.Parameters, &parameters) != nil {
		return false
	}
	frozen := tools.PublicSchema{Name: c.Name, Description: c.Description, Parameters: parameters, Metadata: c.Metadata}
	if digestJSON(frozen) != c.CatalogDigest || mcp.Validate(c.Parameters, json.RawMessage(operation.ArgumentsJSON)) != nil {
		return false
	}
	properties, ok := parameters["properties"].(map[string]any)
	if !ok {
		return false
	}
	root, ok := properties["root"].(map[string]any)
	if !ok || root["type"] != "string" {
		return false
	}
	enum, ok := root["enum"].([]any)
	if !ok || len(enum) == 0 {
		return false
	}
	for _, value := range enum {
		path, ok := value.(string)
		if !ok || !filepath.IsAbs(path) || filepath.Clean(path) != path {
			return false
		}
	}
	delete(root, "enum")
	return digestJSON(frozen) == digestJSON(current)
}
