// 防火墙能力的测试：放行器是替身，绝不触碰宿主 ufw。
package firewall

import (
	"context"
	"strings"
	"testing"

	"elysian/server/internal/agent/kardia"
	"elysian/server/internal/agent/tools"
	"elysian/server/internal/contract"
)

// fakeOpener 记录放行请求并返回预设结果。
type fakeOpener struct {
	calls    []portCall
	response contract.FirewallPortSync
}

type portCall struct {
	port int
	note string
}

func (f *fakeOpener) EnsurePortRule(_ context.Context, port int, note string) contract.FirewallPortSync {
	f.calls = append(f.calls, portCall{port: port, note: note})
	if f.response.State == "" {
		return contract.FirewallPortSync{State: contract.FirewallPortSyncOpened, Port: port}
	}
	return f.response
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

func TestEnsurePortRuleUsesDefaultNote(t *testing.T) {
	opener := &fakeOpener{}
	root, registry := install(t, Deps{Opener: opener}, Config{})

	value, err := registry.Execute(root, "port_rule_ensure", tools.Arguments{"port": 8080})
	if err != nil {
		t.Fatalf("执行失败：%v", err)
	}
	sync, ok := value.(contract.FirewallPortSync)
	if !ok || sync.State != contract.FirewallPortSyncOpened || sync.Port != 8080 {
		t.Fatalf("放行结果不符：%v", value)
	}
	if len(opener.calls) != 1 || opener.calls[0].port != 8080 || opener.calls[0].note != DefaultNote {
		t.Fatalf("放行请求不符：%v", opener.calls)
	}
}

func TestEnsurePortRuleHonoursConfiguredAndGivenNote(t *testing.T) {
	opener := &fakeOpener{}
	root, registry := install(t, Deps{Opener: opener}, Config{DefaultNote: "网站发布"})

	if _, err := registry.Execute(root, "port_rule_ensure", tools.Arguments{"port": 443}); err != nil {
		t.Fatalf("执行失败：%v", err)
	}
	if _, err := registry.Execute(root, "port_rule_ensure", tools.Arguments{"port": 443, "note": "手工放行"}); err != nil {
		t.Fatalf("执行失败：%v", err)
	}
	if opener.calls[0].note != "网站发布" || opener.calls[1].note != "手工放行" {
		t.Fatalf("备注不符：%v", opener.calls)
	}
}

func TestEnsurePortRuleRejectsOutOfRangePort(t *testing.T) {
	opener := &fakeOpener{}
	root, registry := install(t, Deps{Opener: opener}, Config{})

	for _, port := range []any{0, -1, 65536, 3.5} {
		_, err := registry.Execute(root, "port_rule_ensure", tools.Arguments{"port": port})
		if err == nil {
			t.Fatalf("端口 %v 应被拒", port)
		}
	}
	if len(opener.calls) != 0 {
		t.Fatalf("被拒的调用不得触达放行器：%v", opener.calls)
	}
}

func TestEnsurePortRuleReportsSkippedState(t *testing.T) {
	detail := contract.FirewallPortSyncDetailSkipped
	opener := &fakeOpener{response: contract.FirewallPortSync{
		State:  contract.FirewallPortSyncSkipped,
		Port:   9000,
		Detail: &detail,
	}}
	root, registry := install(t, Deps{Opener: opener}, Config{})

	value, err := registry.Execute(root, "port_rule_ensure", tools.Arguments{"port": 9000})
	if err != nil {
		t.Fatalf("skipped 不是错误：%v", err)
	}
	sync := value.(contract.FirewallPortSync)
	if sync.State != contract.FirewallPortSyncSkipped || sync.Detail == nil || *sync.Detail != detail {
		t.Fatalf("应原样带回 skipped 与中文说明：%v", sync)
	}
}

func TestMissingOpenerFailsClosed(t *testing.T) {
	root := kardia.NewContext()
	_, err := tools.Install(context.Background(), root, tools.Plugin, Plugin(Deps{}, Config{}))
	if err == nil || !strings.Contains(err.Error(), "缺少 seam.PortOpener") {
		t.Fatalf("缺少放行器时装载应失败：%v", err)
	}
}

func TestServiceMethodIsCallableDirectly(t *testing.T) {
	opener := &fakeOpener{}
	root, _ := install(t, Deps{Opener: opener}, Config{})

	service, err := From(root)
	if err != nil {
		t.Fatalf("取服务失败：%v", err)
	}
	sync, err := service.EnsurePortRule(root, 22, "")
	if err != nil {
		t.Fatalf("直接调用失败：%v", err)
	}
	if sync.Port != 22 {
		t.Fatalf("端口不符：%v", sync)
	}
	if _, err := service.EnsurePortRule(root, 0, ""); err == nil {
		t.Fatal("端口越界应被拒")
	}
}
