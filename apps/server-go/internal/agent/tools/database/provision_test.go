package database

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"testing"

	"elysian/server/internal/agent/tools"
	domain "elysian/server/internal/database"
)

func schemaByName(t *testing.T, schemas []tools.PublicSchema, name string) tools.PublicSchema {
	t.Helper()
	for _, schema := range schemas {
		if schema.Name == name {
			return schema
		}
	}
	t.Fatalf("未登记 %s", name)
	return tools.PublicSchema{}
}

// 注入了域入口时，新聊天获得两个数据库工具：只读的实例发现与写效应的部署。
func TestAgentDatabaseToolsRegisterOnlyWithAFacade(t *testing.T) {
	bare, err := tools.NewRuntime(context.Background(), Plugin(Deps{}, Config{}))
	if err != nil {
		t.Fatal(err)
	}
	defer bare.Close(context.Background())
	for _, schema := range bare.Schemas() {
		if schema.Name == "database_instances" || schema.Name == "database_provision" {
			t.Fatalf("没有域入口时不得登记 %s", schema.Name)
		}
	}

	runtime, err := tools.NewRuntime(context.Background(), Plugin(Deps{Facade: &domain.AgentFacade{}}, Config{}))
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Close(context.Background())
	schemas := runtime.Schemas()

	instances := schemaByName(t, schemas, "database_instances")
	if !instances.Metadata.ReadOnly || !instances.Metadata.Default || instances.Metadata.Effect != "read" ||
		instances.Metadata.Domain != "database" || instances.Metadata.Exposure != "agent" || instances.Metadata.Version != "1" {
		t.Fatalf("实例发现应为只读、默认可见的 database 工具：%+v", instances.Metadata)
	}
	for _, want := range []string{"不含密码", "接管", "plan"} {
		if !strings.Contains(instances.Description, want) {
			t.Errorf("实例发现描述缺少 %q：%s", want, instances.Description)
		}
	}

	provision := schemaByName(t, schemas, "database_provision")
	meta := provision.Metadata
	if meta.ReadOnly || meta.Effect != "write" || !meta.Async || meta.TaskDomain != domain.ProvisionTaskDomain ||
		meta.TaskRequestArgument != "requestId" || meta.Version != "1" || meta.Domain != "database" ||
		meta.Exposure != "agent" || meta.ResourceType != "database" || meta.ResourceKeyArgument != "database" {
		t.Fatalf("部署应为 database 域的异步写工具：%+v", meta)
	}
	for _, want := range []string{"不新建容器", "数据库页", "request_user_input", "docker_host_capacity", "8.0"} {
		if !strings.Contains(provision.Description, want) {
			t.Errorf("部署描述缺少 %q：%s", want, provision.Description)
		}
	}
	raw, err := json.Marshal(provision.Parameters)
	if err != nil {
		t.Fatal(err)
	}
	var shape struct {
		Required []string `json:"required"`
	}
	if err := json.Unmarshal(raw, &shape); err != nil {
		t.Fatal(err)
	}
	for _, need := range []string{"engine", "version", "database", "requestId"} {
		if !slices.Contains(shape.Required, need) {
			t.Errorf("部署必须要求 %s：%s", need, raw)
		}
	}
	for name, wants := range map[string][]string{"database_provision": {"部署数据库", "建库"}, "database_instances": {"数据库实例"}} {
		schema := schemaByName(t, schemas, name)
		joined := strings.Join(schema.SearchNames, " ")
		for _, want := range wants {
			if !strings.Contains(joined, want) {
				t.Errorf("%s 应能按 %q 搜到：%s", name, want, joined)
			}
		}
	}
}

// 没有装配域对象时调用失败而不 panic，也不会返回任务引用。
func TestAgentDatabaseToolsFailClosedWithoutDomain(t *testing.T) {
	runtime, err := tools.NewRuntime(context.Background(), Plugin(Deps{Facade: &domain.AgentFacade{}}, Config{}))
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Close(context.Background())
	if _, err := runtime.Execute(context.Background(), "database_instances", map[string]any{"engine": "MySQL"}); err == nil {
		t.Fatal("未装配时不得返回实例列表")
	}
	args := map[string]any{"engine": "MySQL", "version": "8.0", "database": "shop", "requestId": strings.Repeat("a", 64)}
	if _, err := runtime.Execute(context.Background(), "database_provision", args); err == nil {
		t.Fatal("未装配时不得受理部署")
	}
	// 缺少必填参数在进入域之前就被拒绝。
	if _, err := runtime.Execute(context.Background(), "database_provision", map[string]any{"engine": "MySQL"}); err == nil {
		t.Fatal("缺少必填参数应被拒绝")
	}
}
