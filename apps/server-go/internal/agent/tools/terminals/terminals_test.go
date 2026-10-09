// 终端能力的测试：工具箱是替身，不开任何 PTY。
package terminals

import (
	"context"
	"strings"
	"testing"

	"elysian/server/internal/agent/kardia"
	"elysian/server/internal/agent/tools"
	"elysian/server/internal/seam"
)

// fakeKit 是 seam.TerminalKit 的替身：本能力只持有它，不调用它的方法。
type fakeKit struct{}

func (fakeKit) NewService(seam.TerminalHostDeps, seam.ShellSessionSpec, func() seam.TerminalIdentity, int) seam.TerminalsService {
	return nil
}

func (fakeKit) NewTotalLimitedService(inner seam.TerminalsService, _ func() int, _ int) seam.TerminalsService {
	return inner
}

func (fakeKit) NewConnEvents(seam.TerminalsService, seam.SessionConnections, string) seam.TerminalConnEvents {
	return nil
}

func TestPluginProvidesKitAndRegistersNoTool(t *testing.T) {
	root := kardia.NewContext()
	fibers, err := tools.Install(context.Background(), root, tools.Plugin, Plugin(Deps{Kit: fakeKit{}}))
	if err != nil {
		t.Fatalf("装载失败：%v", err)
	}
	t.Cleanup(func() {
		for i := len(fibers) - 1; i >= 0; i-- {
			_ = fibers[i].Dispose(context.Background())
		}
	})

	service, err := From(root)
	if err != nil {
		t.Fatalf("取服务失败：%v", err)
	}
	if service.Kit() == nil {
		t.Fatal("工具箱应可取回")
	}
	registry, err := tools.RegistryFrom(root)
	if err != nil {
		t.Fatalf("取注册表失败：%v", err)
	}
	if size := registry.Size(); size != 0 {
		t.Fatalf("终端能力不应登记工具，实际 %d 条", size)
	}
}

func TestPluginDoesNotDependOnRegistry(t *testing.T) {
	root := kardia.NewContext()
	fibers, err := tools.Install(context.Background(), root, Plugin(Deps{Kit: fakeKit{}}))
	if err != nil {
		t.Fatalf("未装载注册表也应能装载终端能力：%v", err)
	}
	t.Cleanup(func() {
		for i := len(fibers) - 1; i >= 0; i-- {
			_ = fibers[i].Dispose(context.Background())
		}
	})
	if _, err := From(root); err != nil {
		t.Fatalf("取服务失败：%v", err)
	}
}

func TestMissingKitFailsClosed(t *testing.T) {
	root := kardia.NewContext()
	_, err := tools.Install(context.Background(), root, Plugin(Deps{}))
	if err == nil || !strings.Contains(err.Error(), "缺少 seam.TerminalKit") {
		t.Fatalf("缺少工具箱时装载应失败：%v", err)
	}
	if _, err := From(root); err == nil {
		t.Fatal("装载失败后不应留下服务")
	}
}
