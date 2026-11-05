package harness

import (
	"encoding/json"
	"strings"
	"testing"

	"elysian/server/internal/agent/tools"
	domaindatabase "elysian/server/internal/database"
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

func databaseCreateLegacyCatalogFixture(t *testing.T) (Operation, tools.PublicSchema) {
	t.Helper()
	bridge := databaseBusinessBridge(t)
	for _, schema := range bridge.Schemas() {
		if schema.Name != "database_create" {
			continue
		}
		var parameters map[string]any
		raw, _ := json.Marshal(schema.Parameters)
		_ = json.Unmarshal(raw, &parameters)
		for _, name := range []string{"id", "expected", "versionTag", "imageId", "containerName", "name"} {
			delete(parameters["properties"].(map[string]any)[name].(map[string]any), "description")
		}
		legacy := schema
		legacy.Parameters = parameters
		frozen, _ := json.Marshal(parameters)
		return Operation{ArgumentsJSON: `{"id":"new:mysql","requestId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","engine":"MySQL","versionTag":"8.0","expected":"missing","name":"app","imageId":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","containerName":"mysql"}`, Capability: Capability{
			Name: schema.Name, Description: schema.Description, Source: "builtin", ReadOnly: false, Metadata: schema.Metadata, Parameters: frozen, CatalogDigest: digestJSON(legacy),
		}}, schema
	}
	t.Fatal("缺少数据库发现工具")
	return Operation{}, tools.PublicSchema{}
}

func TestDatabaseCreateCatalogCompatibilityOnlyAddsDescriptions(t *testing.T) {
	operation, schema := databaseCreateLegacyCatalogFixture(t)
	beforeOperation, beforeSchema := digestJSON(operation), digestJSON(schema)
	if !legacyDatabaseCreateCatalogCompatible(operation, schema) {
		t.Fatal("只补充版本说明不应阻止旧运行恢复")
	}
	if digestJSON(operation) != beforeOperation || digestJSON(schema) != beforeSchema {
		t.Fatal("兼容检查改写了固定快照或注册表")
	}
	for _, kind := range []string{"tool", "source", "read-only", "metadata", "description", "schema", "digest", "arguments"} {
		t.Run(kind, func(t *testing.T) {
			operation, current := databaseCreateLegacyCatalogFixture(t)
			switch kind {
			case "tool":
				current.Name = "other_tool"
			case "source":
				operation.Capability.Source = "mcp-tool"
			case "read-only":
				operation.Capability.ReadOnly = true
			case "metadata":
				current.Metadata.ReadOnly = true
			case "description":
				current.Description += "变化"
			case "schema":
				current.Parameters["additionalProperties"] = true
			case "digest":
				operation.Capability.CatalogDigest = digestJSON(current)
			case "arguments":
				operation.ArgumentsJSON = `{"engine":"MySQL","versionTag":"8.0","unapproved":true}`
			}
			if legacyDatabaseCreateCatalogCompatible(operation, current) {
				t.Fatal("兼容检查放宽了工具或原始参数约束")
			}
		})
	}
}

func TestDatabaseCreateNameParameterStatesFormatRule(t *testing.T) {
	for _, schema := range databaseBusinessBridge(t).Schemas() {
		if schema.Name != "database_create" {
			continue
		}
		var parameters map[string]any
		raw, err := json.Marshal(schema.Parameters)
		if err != nil || json.Unmarshal(raw, &parameters) != nil {
			t.Fatalf("参数模式解析失败：%v", err)
		}
		name, _ := parameters["properties"].(map[string]any)["name"].(map[string]any)
		description, _ := name["description"].(string)
		if !strings.Contains(description, domaindatabase.SqlNameRule) {
			t.Fatalf("name 必须把格式规则写进定义，模型才不至于拿容器名去猜库名，实际 %q", description)
		}
		return
	}
	t.Fatal("缺少 database_create 工具")
}

// 冻结 ADR-0060 补齐五个参数说明之前的目录形状。它不从当前目录推导，
// 所以「新增说明忘了进剥除清单」会真的失败——上面那个 fixture 抓不到这种情况。
const databaseCreateLegacyParametersJSON = `{"additionalProperties":false,"properties":{"charset":{"type":"string"},"containerName":{"type":"string"},"engine":{"enum":["MySQL","MariaDB","Redis"],"type":"string"},"expected":{"type":"string"},"id":{"type":"string"},"imageId":{"type":"string"},"name":{"type":"string"},"requestId":{"description":"稳定的 64 位小写十六进制请求标识；同请求重试必须复用原值与完整参数","type":"string"},"versionTag":{"type":"string"}},"required":["id","engine","versionTag","name","expected","requestId"],"type":"object"}`

func TestDatabaseCreateLegacyGoldenSnapshotStaysCompatible(t *testing.T) {
	var create tools.PublicSchema
	for _, schema := range databaseBusinessBridge(t).Schemas() {
		if schema.Name == "database_create" {
			create = schema
		}
	}
	if create.Name != "database_create" {
		t.Fatal("缺少 database_create 工具")
	}
	// 必须解码到全新映射：直接解进 create.Parameters 这个已存在的 map 是合并语义，
	// 会保留当前目录的 description 键，冻结快照就不再是快照。
	var legacyParameters map[string]any
	if json.Unmarshal([]byte(databaseCreateLegacyParametersJSON), &legacyParameters) != nil {
		t.Fatal("冻结快照解析失败")
	}
	legacy := create
	legacy.Parameters = legacyParameters
	operation := Operation{ArgumentsJSON: `{"id":"new:mysql","requestId":"` + strings.Repeat("a", 64) +
		`","engine":"MySQL","versionTag":"8.0","expected":"missing","name":"app","imageId":"` + strings.Repeat("b", 64) + `","containerName":"mysql"}`,
		Capability: Capability{Name: create.Name, Description: create.Description, Source: "builtin",
			ReadOnly: false, Metadata: create.Metadata, Parameters: []byte(databaseCreateLegacyParametersJSON), CatalogDigest: digestJSON(legacy)}}
	if !legacyDatabaseCreateCatalogCompatible(operation, create) {
		t.Fatal("冻结的历史快照与新目录失配：新增的参数说明必须同步进 legacyDatabaseCreateCatalogCompatible 的剥除清单，否则旧 Run 无法恢复")
	}
}
