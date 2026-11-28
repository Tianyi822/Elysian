package docker

import (
	"strings"
	"testing"

	"elysian/server/internal/agent/tools"
	domaindocker "elysian/server/internal/docker"
)

// 容量预检是只读工具：新聊天可见、免审批读取、无参数，调用它不创建任何资源。
func TestHostCapacityDescriptorIsReadOnlyAndNeedsNoArguments(t *testing.T) {
	root, _ := install(t, Deps{Views: &fakeViews{}, Agent: &domaindocker.AgentFacade{}}, Config{})
	service, err := From(root)
	if err != nil {
		t.Fatal(err)
	}
	var capacity *tools.Descriptor
	descriptors := service.descriptors()
	for i := range descriptors {
		if descriptors[i].Name == "docker_host_capacity" {
			capacity = &descriptors[i]
		}
	}
	if capacity == nil {
		t.Fatal("未登记 docker_host_capacity")
	}
	meta := capacity.Metadata
	if !meta.ReadOnly || !meta.Default || meta.Effect != "read" || meta.Domain != "docker" || meta.Exposure != "agent" || meta.Version != "1" {
		t.Fatalf("容量预检应为只读、默认可见的 docker 工具：%+v", meta)
	}
	if len(capacity.Parameters.Properties) != 0 || len(capacity.Parameters.Required) != 0 {
		t.Fatalf("容量预检不应要求参数：%+v", capacity.Parameters)
	}
	for _, want := range []string{"只读", "不创建", "档位"} {
		if !strings.Contains(capacity.Description, want) {
			t.Errorf("容量预检描述缺少 %q：%s", want, capacity.Description)
		}
	}
	searched := strings.Join(capacity.SearchNames, " ")
	for _, want := range []string{"容量", "内存"} {
		if !strings.Contains(searched, want) {
			t.Errorf("容量预检应能按 %q 搜到：%s", want, searched)
		}
	}
	// 未装配域对象时调用失败而不 panic；错误由调用方按授权缺失处理。
	if _, err := capacity.Handler(nil, tools.Arguments{}); err == nil {
		t.Fatal("缺少域对象时不得给出容量读数")
	}
}

// create_service 升 v4：描述要求先核对容量再向用户确认档位，并把数据库引导到 database_provision。
func TestServiceCreateV4RequiresCapacityCheckAndRedirectsDatabases(t *testing.T) {
	root, _ := install(t, Deps{Views: &fakeViews{}, Agent: &domaindocker.AgentFacade{}}, Config{})
	service, err := From(root)
	if err != nil {
		t.Fatal(err)
	}
	for _, descriptor := range service.descriptors() {
		if descriptor.Name != "docker_container_create_service" {
			continue
		}
		if descriptor.Metadata.Version != "4" {
			t.Fatalf("create_service 版本应为 v4：%s", descriptor.Metadata.Version)
		}
		for _, want := range []string{"docker_host_capacity", "request_user_input", "database_provision", "凭据"} {
			if !strings.Contains(descriptor.Description, want) {
				t.Errorf("create_service 描述缺少 %q：%s", want, descriptor.Description)
			}
		}
		return
	}
	t.Fatal("未登记 docker_container_create_service")
}
