package docker

import (
	"testing"

	"elysian/server/internal/agent/tools"
	domaindocker "elysian/server/internal/docker"
)

// docker_container_power 是生命周期收敛后的唯一新增入口；三个旧名仅为旧快照恢复保留注册。
func TestPowerDescriptorConvergesLifecycleActions(t *testing.T) {
	_, registry := install(t, Deps{Views: &fakeViews{}, Agent: &domaindocker.AgentFacade{}}, Config{})
	schemas := map[string]tools.PublicSchema{}
	for _, schema := range registry.Schemas() {
		schemas[schema.Name] = schema
	}
	power, ok := schemas["docker_container_power"]
	if !ok {
		t.Fatal("docker_container_power 未注册")
	}
	if power.Metadata != (tools.Metadata{Domain: "docker", Backend: "domain", Action: "power", Effect: "write", Exposure: "agent", ResourceType: "docker-container", ResourceKeyArgument: "id", Version: "1"}) {
		t.Fatalf("power 元数据不符：%+v", power.Metadata)
	}
	properties, _ := power.Parameters["properties"].(map[string]any)
	action, _ := properties["action"].(map[string]any)
	values, _ := action["enum"].([]any)
	if len(values) != 3 || values[0] != "start" || values[1] != "stop" || values[2] != "restart" {
		t.Fatalf("action 枚举不符：%v", values)
	}
	for _, legacy := range []string{"docker_container_start", "docker_container_stop", "docker_container_restart"} {
		if _, kept := schemas[legacy]; !kept {
			t.Fatalf("旧工具 %s 必须保留注册供旧快照恢复", legacy)
		}
	}
}
