// 依赖面自查：根包不得依赖任何域包，能力子包至多依赖自己那一个域。
package tools

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// domains 与 internal/app/guards_test.go:15-28 的十二域映射保持一致。
var domains = []string{
	"elysian/server/internal/panel",
	"elysian/server/internal/auth",
	"elysian/server/internal/logs",
	"elysian/server/internal/platform",
	"elysian/server/internal/firewall",
	"elysian/server/internal/security",
	"elysian/server/internal/files",
	"elysian/server/internal/terminals",
	"elysian/server/internal/docker",
	"elysian/server/internal/containerapps",
	"elysian/server/internal/database",
	"elysian/server/internal/websites",
}

// moduleRoot 由本文件位置回溯到 apps/server-go。
func moduleRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("无法定位测试文件路径")
	}
	return filepath.Join(filepath.Dir(file), "..", "..", "..")
}

// depsOf 返回包的传递依赖列表。
func depsOf(t *testing.T, pkg string) []string {
	t.Helper()
	cmd := exec.Command("go", "list", "-deps", pkg)
	cmd.Dir = moduleRoot(t)
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("go list -deps %s 失败：%v", pkg, err)
	}
	var deps []string
	for _, line := range strings.Split(string(out), "\n") {
		if line = strings.TrimSpace(line); line != "" {
			deps = append(deps, line)
		}
	}
	return deps
}

func TestRootPackageHasNoDomainOrAssemblyDependency(t *testing.T) {
	for _, dep := range depsOf(t, "./internal/agent/tools") {
		for _, domain := range domains {
			if dep == domain {
				t.Errorf("根包 tools 依赖了域包 %s（根包只允许 kardia 与公共层）", domain)
			}
		}
		if strings.HasPrefix(dep, "elysian/server/cmd") || dep == "elysian/server/internal/app" {
			t.Errorf("库层不得依赖装配层或入口：%s", dep)
		}
	}
}

// capabilityDomains 是每个能力子包唯一允许依赖的域包，空串表示只依赖公共层。
var capabilityDomains = map[string]string{
	"./internal/agent/tools/accounts":      "elysian/server/internal/security",
	"./internal/agent/tools/auth":          "elysian/server/internal/auth",
	"./internal/agent/tools/containerapps": "elysian/server/internal/containerapps",
	"./internal/agent/tools/docker":        "elysian/server/internal/docker",
	"./internal/agent/tools/firewall":      "elysian/server/internal/firewall",
	"./internal/agent/tools/logs":          "elysian/server/internal/logs",
	"./internal/agent/tools/panel":         "elysian/server/internal/panel",
	"./internal/agent/tools/terminals":     "",
	"./internal/agent/tools/websites":      "elysian/server/internal/websites",
	"./internal/agent/tools/files":         "elysian/server/internal/files",
	"./internal/agent/tools/security":      "elysian/server/internal/security",
	"./internal/agent/tools/database":      "elysian/server/internal/database",
	"./internal/agent/tools/platform":      "elysian/server/internal/platform",
}

// unwrappedDomains 是本轮刻意不封装的三个域：能力面全部未导出，任何子包都不该
// 悄悄依赖它们（ADR-0023 后续项）。
var unwrappedDomains = map[string]bool{}

func TestCapabilityPackagesImportAtMostOneDomain(t *testing.T) {
	for pkg, allowed := range capabilityDomains {
		for _, dep := range depsOf(t, pkg) {
			if unwrappedDomains[dep] {
				t.Errorf("%s 依赖了本轮不封装的域包 %s", pkg, dep)
			}
			if dep == "elysian/server/internal/app" || strings.HasPrefix(dep, "elysian/server/cmd") {
				t.Errorf("%s 不得依赖装配层或入口：%s", pkg, dep)
			}
			for _, domain := range domains {
				if dep != domain || domain == allowed {
					continue
				}
				want := "只依赖公共层"
				if allowed != "" {
					want = "只允许 " + allowed
				}
				t.Errorf("%s 依赖了越界的域包 %s（%s）", pkg, domain, want)
			}
		}
	}
}

func TestCapabilityPackageTableCoversTree(t *testing.T) {
	root := moduleRoot(t)
	entries, err := os.ReadDir(filepath.Join(root, "internal", "agent", "tools"))
	if err != nil {
		t.Fatalf("读能力目录失败：%v", err)
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		pkg := "./internal/agent/tools/" + entry.Name()
		if _, ok := capabilityDomains[pkg]; !ok {
			t.Errorf("新增能力子包 %s 未登记进依赖自查表", pkg)
		}
	}
}
