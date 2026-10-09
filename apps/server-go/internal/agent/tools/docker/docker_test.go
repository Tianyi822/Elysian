// 容器能力的测试：视图是替身，不连 Docker socket、不做 DNS 解析。
package docker

import (
	"context"
	"errors"
	"strings"
	"testing"

	"elysian/server/internal/agent/kardia"
	"elysian/server/internal/agent/tools"
	"elysian/server/internal/contract"
	"elysian/server/internal/seam"
)

// fakeViews 是 seam.DockerViews 的替身。
type fakeViews struct {
	containers     []contract.Container
	images         []contract.ContainerImage
	policy         seam.DockerPolicy
	selfID         string
	containerErr   error
	imageErr       error
	containerCalls int
}

func (f *fakeViews) ListContainers(context.Context) ([]contract.Container, error) {
	f.containerCalls++
	return f.containers, f.containerErr
}

func (f *fakeViews) ListImages(context.Context) ([]contract.ContainerImage, error) {
	return f.images, f.imageErr
}

func (f *fakeViews) Policy() seam.DockerPolicy { return f.policy }

func (f *fakeViews) SelfContainerID() string { return f.selfID }

func containers(count int) []contract.Container {
	out := make([]contract.Container, 0, count)
	for i := 0; i < count; i++ {
		out = append(out, contract.Container{ID: string(rune('a' + i)), Name: "web", Status: "running"})
	}
	return out
}

func install(t *testing.T, deps Deps, cfg Config) (*kardia.Context, *tools.Registry) {
	t.Helper()
	root := kardia.NewContext()
	fibers, err := tools.Install(context.Background(), root, tools.Plugin, Plugin(deps, cfg))
	if err != nil {
		t.Fatalf("装载失败：%v", err)
	}
	t.Cleanup(func() {
		for i := len(fibers) - 1; i >= 0; i-- {
			if err := fibers[i].Dispose(context.Background()); err != nil {
				t.Errorf("销毁失败：%v", err)
			}
		}
	})
	registry, err := tools.RegistryFrom(root)
	if err != nil {
		t.Fatalf("取注册表失败：%v", err)
	}
	return root, registry
}

func TestPluginRegistersFiveDescriptors(t *testing.T) {
	_, registry := install(t, Deps{Views: &fakeViews{}}, Config{})
	names := make([]string, 0)
	for _, schema := range registry.Schemas() {
		names = append(names, schema.Name)
	}
	want := []string{"docker_containers_list", "docker_images_list", "docker_policy_view", "docker_self_container", "registry_host_check"}
	if strings.Join(names, ",") != strings.Join(want, ",") {
		t.Fatalf("描述符不符：%v", names)
	}
}

func TestListContainersHonoursLimit(t *testing.T) {
	views := &fakeViews{containers: containers(3)}
	root, registry := install(t, Deps{Views: views}, Config{ListLimit: 2})

	value, err := registry.Execute(root, "docker_containers_list", nil)
	if err != nil {
		t.Fatalf("执行失败：%v", err)
	}
	list, ok := value.([]contract.Container)
	if !ok || len(list) != 2 {
		t.Fatalf("应按上限截断：%v", value)
	}
}

func TestListContainersDefaultsLimit(t *testing.T) {
	views := &fakeViews{containers: containers(1)}
	root, _ := install(t, Deps{Views: views}, Config{})

	service, err := From(root)
	if err != nil {
		t.Fatalf("取服务失败：%v", err)
	}
	list, err := service.ListContainers(root)
	if err != nil || len(list) != 1 {
		t.Fatalf("列举失败：%v %v", list, err)
	}
}

func TestListImagesAndPolicyAndSelfContainer(t *testing.T) {
	pulled := "2026-10-09T10:00:00Z"
	views := &fakeViews{
		images: []contract.ContainerImage{{ID: "sha256:1", Name: "nginx", Tag: "1.27", PulledAt: &pulled}},
		policy: seam.DockerPolicy{MountRoot: "/srv/elysian", ReservedPorts: []int{22, 48100}},
		selfID: "abc123",
	}
	root, registry := install(t, Deps{Views: views}, Config{})

	images, err := registry.Execute(root, "docker_images_list", nil)
	if err != nil {
		t.Fatalf("执行失败：%v", err)
	}
	if list, ok := images.([]contract.ContainerImage); !ok || len(list) != 1 || list[0].Name != "nginx" {
		t.Fatalf("镜像视图不符：%v", images)
	}

	policy, err := registry.Execute(root, "docker_policy_view", nil)
	if err != nil {
		t.Fatalf("执行失败：%v", err)
	}
	fields, ok := policy.(map[string]any)
	if !ok || fields["mount_root"] != "/srv/elysian" {
		t.Fatalf("策略视图不符：%v", policy)
	}

	self, err := registry.Execute(root, "docker_self_container", nil)
	if err != nil {
		t.Fatalf("执行失败：%v", err)
	}
	if fields, ok := self.(map[string]any); !ok || fields["id"] != "abc123" || fields["identified"] != true {
		t.Fatalf("自容器视图不符：%v", self)
	}
}

func TestSelfContainerReportsUnidentified(t *testing.T) {
	root, registry := install(t, Deps{Views: &fakeViews{}}, Config{})
	self, err := registry.Execute(root, "docker_self_container", nil)
	if err != nil {
		t.Fatalf("执行失败：%v", err)
	}
	fields := self.(map[string]any)
	if fields["identified"] != false || fields["id"] != "" {
		t.Fatalf("未识别时应显式标注：%v", self)
	}
}

func TestDomainErrorsPropagate(t *testing.T) {
	sentinel := errors.New("Docker socket 不可用")
	views := &fakeViews{containerErr: sentinel, imageErr: sentinel}
	root, registry := install(t, Deps{Views: views}, Config{})

	if _, err := registry.Execute(root, "docker_containers_list", nil); !errors.Is(err, sentinel) {
		t.Fatalf("域错误应原样穿透：%v", err)
	}
	if _, err := registry.Execute(root, "docker_images_list", nil); !errors.Is(err, sentinel) {
		t.Fatalf("域错误应原样穿透：%v", err)
	}
}

func TestRegistryHostCheckRejectsMalformedInput(t *testing.T) {
	root, registry := install(t, Deps{Views: &fakeViews{}}, Config{})

	// 两个用例都在语法阶段失败，不触发 DNS 解析。
	for _, host := range []string{"", "http://registry.example.com"} {
		_, err := registry.Execute(root, "registry_host_check", tools.Arguments{"host": host})
		if err == nil {
			t.Fatalf("镜像源 %q 应被拒", host)
		}
	}
	if _, err := registry.Execute(root, "registry_host_check", nil); err == nil ||
		!strings.Contains(err.Error(), "缺少必填参数") {
		t.Fatalf("缺 host 应被参数模式拒绝：%v", err)
	}
}

func TestMissingViewsFailsClosed(t *testing.T) {
	root := kardia.NewContext()
	_, err := tools.Install(context.Background(), root, tools.Plugin, Plugin(Deps{}, Config{}))
	if err == nil || !strings.Contains(err.Error(), "缺少 seam.DockerViews") {
		t.Fatalf("缺少视图时装载应失败：%v", err)
	}
}

func TestNegativeListLimitFailsClosed(t *testing.T) {
	root := kardia.NewContext()
	_, err := tools.Install(context.Background(), root, tools.Plugin, Plugin(Deps{Views: &fakeViews{}}, Config{ListLimit: -1}))
	if err == nil || !strings.Contains(err.Error(), "列举上限不得为负") {
		t.Fatalf("负上限应被拒：%v", err)
	}
}
