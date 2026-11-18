package harness

import (
	"encoding/json"
	"strings"
	"testing"

	hstate "elysian/server/internal/agent/harness/state"
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
		Metadata: legacy.Metadata, Parameters: parameters, CatalogDigest: hstate.DigestJSON(legacy),
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
			beforeOperation, beforeSchema := hstate.DigestJSON(operation), hstate.DigestJSON(schema)
			if !legacyDockerContainerCatalogCompatible(operation, schema) {
				t.Fatal("约定的版本元数据升级应允许旧快照恢复")
			}
			if hstate.DigestJSON(operation) != beforeOperation || hstate.DigestJSON(schema) != beforeSchema {
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
						operation.Capability.CatalogDigest = hstate.DigestJSON(current)
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
	op := Operation{ArgumentsJSON: `{"id":"` + strings.Repeat("c", 64) + `","requestId":"` + strings.Repeat("a", 64) + `","argv":["true"]}`, Capability: Capability{Name: old.Name, Description: old.Description, Source: "builtin", Metadata: old.Metadata, Parameters: parameters, CatalogDigest: hstate.DigestJSON(old)}}
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

// 以下三个夹具按 git 历史的退役前描述符逐字重建冻结目录：exec v2（databaseChange
// 参数）、inspect v3/v2（database 参数）、create_service（含初始逻辑库要求的 env
// 说明）。它们不从还原规则推导，「还原形状写错」会真的失败。
func retiredExecV2Schema() tools.PublicSchema {
	text := tools.Schema{Type: tools.SchemaString}
	return tools.PublicSchema{Name: "docker_container_exec", Description: "在精确受管容器中执行argv命令，或通过databaseChange同步创建/删除受管逻辑库及登记；两者互斥。受管数据库禁止任意argv，先inspect取得revision。密码由后端处理，不传入参数。requestId精确重试复用。Redis remove仅清空DB0并保留登记。异步等待由系统监视器完成。", Parameters: tools.Schema{Type: tools.SchemaObject, Required: []string{"id", "requestId"}, Properties: map[string]tools.Schema{"id": text, "requestId": {Type: tools.SchemaString, Pattern: "^[a-f0-9]{64}$", Description: "64 位小写十六进制稳定请求标识；精确重试复用原值与完整参数"}, "argv": {Type: tools.SchemaArray, Items: &text}, "workdir": text, "databaseChange": {Type: tools.SchemaObject, Required: []string{"action", "name", "expectedRevision"}, Properties: map[string]tools.Schema{"action": {Type: tools.SchemaString, Enum: tools.EnumOf("create", "remove")}, "name": text, "expectedRevision": text, "charset": text}}}}.JSONSchema(), Metadata: tools.Metadata{Domain: "docker", Backend: "domain", Action: "exec", Effect: "execute", Exposure: "agent", ResourceType: "docker-container", ResourceKeyArgument: "id", Version: "2", Async: true, TaskDomain: "docker-container-operation", TaskRequestArgument: "requestId"}}
}

func retiredInspectSchema(version string) tools.PublicSchema {
	id := tools.Schema{Type: tools.SchemaString, Description: "本地列表返回的完整对象 ID"}
	database := tools.Schema{Type: tools.SchemaObject, Required: []string{"id"}, Properties: map[string]tools.Schema{"id": {Type: tools.SchemaString}, "metadata": {Type: tools.SchemaBoolean}, "metrics": {Type: tools.SchemaBoolean}}}
	if version == "3" {
		database.Description = "首次检查省略此项，先取得登记摘要和 revision；仅按需读取某个登记的元数据或指标"
		database.Properties["id"] = tools.Schema{Type: tools.SchemaString, Description: "基础检查结果 database.databases[].id 中的数据库登记 ID，不是容器 ID"}
	}
	return tools.PublicSchema{Name: "docker_container_inspect", Description: "只读查看本机指定完整 ID 容器的状态、镜像、端口、启动时间与重启策略；不返回环境变量、启动命令或挂载内容", Parameters: tools.Schema{Type: tools.SchemaObject, Required: []string{"id"}, Properties: map[string]tools.Schema{"id": id, "database": database}}.JSONSchema(), Metadata: tools.Metadata{Domain: "docker", Backend: "domain", Action: "inspect", Effect: "read", Exposure: "agent", ReadOnly: true, Default: true, ResourceType: "docker-container", ResourceKeyArgument: "id", Version: version}}
}

func retiredServiceLongEnvSchema() tools.PublicSchema {
	// 按 git 历史的退役前 create_service 描述符逐字重建（env 说明含初始逻辑库要求）。
	return tools.PublicSchema{Name: "docker_container_create_service", Description: "审批后用 service-v1 模板创建并启动服务容器：本机已存在摘要镜像、可写根、专属卷与声明式凭据（只传变量名，值由后端生成且不出现在参数与回执）。resourceTier(small/medium/large) 与 networkScope(container-net/localhost/any-host) 先经 request_user_input 由用户选定再提交；any-host 必填 hostPort 并联动防火墙，localhost/any-host 必填容器端口 port。相同参数重试复用原 requestId", Parameters: tools.Schema{Type: tools.SchemaObject, Required: []string{"name", "image", "requestId", "resourceTier", "networkScope"}, Properties: map[string]tools.Schema{
		"name":         {Type: tools.SchemaString, Description: "容器名称"},
		"image":        {Type: tools.SchemaString, Description: "本机已存在的镜像完整引用，名称:标签@sha256:64 位摘要"},
		"requestId":    {Type: tools.SchemaString, Pattern: "^[a-f0-9]{64}$", Description: "64 位小写十六进制稳定请求标识；同请求重试必须复用原值与完整参数"},
		"resourceTier": {Type: tools.SchemaString, Enum: tools.EnumOf("small", "medium", "large"), Description: "资源档位：small=512MiB+0.5CPU、medium=1GiB+1CPU、large=2GiB+2CPU"},
		"networkScope": {Type: tools.SchemaString, Enum: tools.EnumOf("container-net", "localhost", "any-host"), Description: "网络档位：仅容器网络/本机回环/任意主机"},
		"port":         {Type: tools.SchemaInteger, Description: "容器侧 TCP 端口；localhost 与 any-host 必填"},
		"hostPort":     {Type: tools.SchemaInteger, Description: "宿主端口；仅 any-host 必填且不得为面板保留端口"},
		"credentials":  {Type: tools.SchemaArray, Items: &tools.Schema{Type: tools.SchemaString, Pattern: "^[A-Z][A-Z0-9_]{0,63}$"}, Description: "凭据环境变量名列表（如 MYSQL_ROOT_PASSWORD），最多 8 项；值由后端生成，不传入明文"},
		"env":          {Type: tools.SchemaArray, Items: &tools.Schema{Type: tools.SchemaString}, Description: "非凭据环境变量 KEY=VALUE 列表，最多 16 项、每项不超过 512 字节，完整进入审批展示。MySQL 必须提供 MYSQL_DATABASE=初始逻辑库名，MariaDB 必须提供 MARIADB_DATABASE=初始逻辑库名；库名未知先用 request_user_input 询问，不得编造；密码只用 credentials 声明由后端生成"},
		"volumes":      {Type: tools.SchemaArray, Items: &tools.Schema{Type: tools.SchemaString, Pattern: "^/[A-Za-z0-9._/-]{0,127}$"}, Description: "容器内持久卷挂载点（如 /var/lib/mysql），最多 2 个；卷由面板托管"},
	}}.JSONSchema(), Metadata: tools.Metadata{Domain: "docker", Backend: "domain", Action: "create_service", Effect: "write", Exposure: "agent", ResourceType: "docker-container", ResourceKeyArgument: "name", Version: "3", Async: true, TaskDomain: "docker-container-operation", TaskRequestArgument: "requestId"}}
}

func frozenOperation(schema tools.PublicSchema, arguments string) Operation {
	parameters, _ := json.Marshal(schema.Parameters)
	return Operation{ArgumentsJSON: arguments, Capability: Capability{
		Name: schema.Name, Description: schema.Description, Source: "builtin", ReadOnly: schema.Metadata.ReadOnly,
		Metadata: schema.Metadata, Parameters: parameters, CatalogDigest: hstate.DigestJSON(schema),
	}}
}

func currentSchemaByName(t *testing.T, name string) tools.PublicSchema {
	t.Helper()
	bridge, _ := dockerCatalogBridge(t)
	for _, schema := range bridge.Schemas() {
		if schema.Name == name {
			return schema
		}
	}
	t.Fatalf("缺少 %s 工具", name)
	return tools.PublicSchema{}
}

func TestRetiredDatabaseEraDockerCatalogsStayCompatible(t *testing.T) {
	// exec v2：databaseChange 参数存在；还原 v3 → v2 后精确对上冻结摘要。
	exec := currentSchemaByName(t, "docker_container_exec")
	frozen := retiredExecV2Schema()
	operation := frozenOperation(frozen, `{"id":"`+strings.Repeat("c", 64)+`","requestId":"`+strings.Repeat("a", 64)+`","argv":["true"],"databaseChange":{"action":"create","name":"orders","expectedRevision":"fixed"}}`)
	if !legacyDockerContainerCatalogCompatible(operation, exec) {
		t.Fatal("exec v2 冻结目录（含 databaseChange）应在退役后仍可派发")
	}
	// inspect v3（database 带说明）与 v2（database 不带说明）。
	inspect := currentSchemaByName(t, "docker_container_inspect")
	for _, version := range []string{"3", "2"} {
		frozen := retiredInspectSchema(version)
		operation := frozenOperation(frozen, `{"id":"`+strings.Repeat("c", 64)+`","database":{"id":"`+strings.Repeat("d", 64)+`"}}`)
		if !legacyDockerContainerCatalogCompatible(operation, inspect) {
			t.Fatalf("inspect v%s 冻结目录应在退役后仍可派发", version)
		}
	}
	// create_service：env 说明含初始逻辑库要求时期的冻结目录。
	service := currentSchemaByName(t, "docker_container_create_service")
	frozenService := retiredServiceLongEnvSchema()
	operation = frozenOperation(frozenService, `{"name":"mysql84","image":"mysql:8.4@sha256:`+strings.Repeat("a", 64)+`","requestId":"`+strings.Repeat("b", 64)+`","resourceTier":"small","networkScope":"any-host","port":3306,"hostPort":3306,"credentials":["MYSQL_ROOT_PASSWORD"],"volumes":["/var/lib/mysql"],"env":["MYSQL_DATABASE=orders"]}`)
	if !legacyDockerContainerCatalogCompatible(operation, service) {
		t.Fatal("create_service 冻结目录（含 MYSQL_DATABASE 要求）应在说明回退后仍可派发")
	}
	// 负例：篡改 digest 或参数后必须拒绝，退役还原不放宽冻结约束。
	altered := frozenOperation(frozen, `{"id":"`+strings.Repeat("c", 64)+`","requestId":"`+strings.Repeat("a", 64)+`","argv":["true"]}`)
	altered.Capability.CatalogDigest = hstate.DigestJSON(exec)
	if legacyDockerContainerCatalogCompatible(altered, exec) {
		t.Fatal("篡改 digest 不得通过退役还原")
	}
	tampered := frozenOperation(retiredInspectSchema("3"), `{"id":"`+strings.Repeat("c", 64)+`","unapproved":true}`)
	if legacyDockerContainerCatalogCompatible(tampered, inspect) {
		t.Fatal("越权参数不得通过退役还原")
	}
}
