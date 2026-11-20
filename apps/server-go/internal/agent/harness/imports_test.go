package harness

import (
	"encoding/json"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

type harnessPackageInfo struct {
	Imports []string
	Deps    []string
}

func harnessPackageDependencies(t *testing.T, name string) harnessPackageInfo {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("无法定位 harness 依赖检查文件")
	}
	command := exec.Command("go", "list", "-json", name)
	command.Dir = filepath.Join(filepath.Dir(file), "..", "..", "..")
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("读取 %s 依赖失败：%v\n%s", name, err, output)
	}
	var info harnessPackageInfo
	if err := json.Unmarshal(output, &info); err != nil {
		t.Fatal(err)
	}
	return info
}

func harnessDomainDependency(name string) bool {
	for _, domain := range []string{"panel", "auth", "logs", "platform", "firewall", "security", "files", "terminals", "docker", "containerapps", "database", "websites", "metrics"} {
		prefix := "elysian/server/internal/" + domain
		if name == prefix || strings.HasPrefix(name, prefix+"/") {
			return true
		}
	}
	return false
}

func harnessAssemblyDependency(name string) bool {
	return name == "elysian/server/internal/app" || strings.HasPrefix(name, "elysian/server/internal/app/") || strings.HasPrefix(name, "elysian/server/cmd/")
}

func TestHarnessCoreHasNoDomainOrAssemblyDependency(t *testing.T) {
	info := harnessPackageDependencies(t, "./internal/agent/harness")
	for _, name := range info.Deps {
		if harnessDomainDependency(name) || harnessAssemblyDependency(name) {
			t.Errorf("harness 内核只能经注入接缝访问域，不能依赖 %s", name)
		}
	}
}

func TestSessionStoreLayerDependencies(t *testing.T) {
	const harness = "elysian/server/internal/agent/harness"
	for _, pkg := range []string{harness, harness + "/state", harness + "/sessionstore"} {
		info := harnessPackageDependencies(t, pkg)
		for _, name := range info.Deps {
			if name == "database/sql" || name == "database/sql/driver" || strings.HasPrefix(name, "modernc.org/sqlite") || name == harness+"/sessionstore/sqlite" {
				t.Errorf("%s 只能依赖持久化契约，不能引用 %s", pkg, name)
			}
		}
	}
	info := harnessPackageDependencies(t, harness+"/sessionstore/sqlite")
	for _, name := range info.Deps {
		if name == harness || harnessDomainDependency(name) || harnessAssemblyDependency(name) {
			t.Errorf("SQLite 实现不得反向调用运行内核、业务域或装配层：%s", name)
		}
	}
}

func TestHarnessToolBridgeUsesOnlyInjectedToolCapabilities(t *testing.T) {
	info := harnessPackageDependencies(t, "./internal/agent/harness/toolbridge")
	allowed := map[string]bool{
		"elysian/server/internal/agent/kardia":       true,
		"elysian/server/internal/agent/tools":        true,
		"elysian/server/internal/agent/tools/docker": true,
		"elysian/server/internal/seam":               true,
	}
	for _, name := range info.Imports {
		if strings.HasPrefix(name, "elysian/server/") && !allowed[name] {
			t.Errorf("toolbridge 不得直接构造域或装配宿主，只允许 kardia、tools/docker 与 seam：%s", name)
		}
	}
	for _, name := range info.Deps {
		if harnessAssemblyDependency(name) || harnessDomainDependency(name) && name != "elysian/server/internal/docker" {
			t.Errorf("toolbridge 出现越界传递依赖：%s", name)
		}
	}
}
