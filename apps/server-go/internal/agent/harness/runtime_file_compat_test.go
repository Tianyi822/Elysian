package harness

import (
	"encoding/json"
	"testing"

	"elysian/server/internal/agent/tools"
)

func legacyFileCatalogFixture(t *testing.T) (CapabilitySnapshot, Operation, tools.PublicSchema) {
	t.Helper()
	metadata := tools.Metadata{Domain: "files", Action: "read", Effect: "read", Exposure: "agent", ResourceType: "filesystem", ResourceKeyArgument: "root", ReadOnly: true, Backend: "domain", Version: "1"}
	parameters := tools.Schema{Type: tools.SchemaObject, Required: []string{"root", "path"}, Properties: map[string]tools.Schema{
		"root": {Type: tools.SchemaString, Enum: tools.EnumOf("/var/www/project")}, "path": {Type: tools.SchemaString},
	}}
	old := tools.PublicSchema{Name: "file_read", Description: "read a bounded business file", Parameters: parameters.JSONSchema(), Metadata: metadata}
	raw, err := json.Marshal(old.Parameters)
	if err != nil {
		t.Fatal(err)
	}
	operation := Operation{ArgumentsJSON: `{"root":"/var/www/project","path":"text.txt"}`, Capability: Capability{Name: old.Name, Description: old.Description, Parameters: raw, Metadata: metadata, ReadOnly: true, Source: "builtin", CatalogDigest: digestJSON(old)}}
	parameters.Properties["root"] = tools.Schema{Type: tools.SchemaString}
	current := tools.PublicSchema{Name: old.Name, Description: old.Description, Parameters: parameters.JSONSchema(), Metadata: metadata}
	return CapabilitySnapshot{}, operation, current
}

func TestLegacyFileCatalogCompatibilityOnlyRemovesRootEnum(t *testing.T) {
	snapshot, operation, current := legacyFileCatalogFixture(t)
	before := digestJSON(operation)
	if !legacyFileCatalogCompatible(snapshot, operation, current) {
		t.Fatal("legacy file catalog was rejected for the root-enum-only change")
	}
	if digestJSON(operation) != before {
		t.Fatal("compatibility check modified the frozen operation")
	}
	for _, name := range []string{"file_list", "file_read", "file_write", "file_copy", "file_move", "file_delete"} {
		snapshot, operation, current := legacyFileCatalogFixture(t)
		operation.Capability.Name = name
		current.Name = name
		var parameters map[string]any
		_ = json.Unmarshal(operation.Capability.Parameters, &parameters)
		operation.Capability.CatalogDigest = digestJSON(tools.PublicSchema{Name: name, Description: current.Description, Metadata: current.Metadata, Parameters: parameters})
		if !legacyFileCatalogCompatible(snapshot, operation, current) {
			t.Errorf("legacy %s rejected", name)
		}
	}
}

func TestLegacyFileCatalogCompatibilityDoesNotBroadenAuthority(t *testing.T) {
	for _, kind := range []string{"new-mode", "other-root", "extra-argument", "metadata", "description", "schema", "digest", "tool", "source"} {
		t.Run(kind, func(t *testing.T) {
			snapshot, operation, current := legacyFileCatalogFixture(t)
			switch kind {
			case "new-mode":
				snapshot.AuthorizationMode = AuthorizationOnDemand
			case "other-root":
				operation.ArgumentsJSON = `{"root":"/var/www/other","path":"text.txt"}`
			case "extra-argument":
				operation.ArgumentsJSON = `{"root":"/var/www/project","path":"text.txt","allowed":true}`
			case "metadata":
				current.Metadata.Version = "2"
			case "description":
				current.Description += " changed"
			case "schema":
				current.Parameters["additionalProperties"] = true
			case "digest":
				operation.Capability.CatalogDigest = digestJSON(current)
			case "tool":
				current.Name = "other_tool"
			case "source":
				operation.Capability.Source = "mcp-tool"
			}
			if legacyFileCatalogCompatible(snapshot, operation, current) {
				t.Fatal("incompatible catalog or unapproved arguments accepted")
			}
		})
	}
}
