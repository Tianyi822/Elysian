package app

import (
	"fmt"
	"os/exec"
	"strings"
	"testing"
)

// 跨域 import 禁卫（go-plan §4.3）：域包只能 import 标准库、选型库与公共层六包
// （config/paths/seam/contract/shared/middleware），禁止 import 任何其它域包；
// 公共层禁止 import 任何域包。internal/app 是唯一允许 import 全部域包的位置。
// 任何绕过（含 internal/<域>/<域>2 变体目录）都算违规。
func TestNoCrossDomainImports(t *testing.T) {
	domains := map[string]bool{
		"elysian/server/internal/auth":      true,
		"elysian/server/internal/logs":      true,
		"elysian/server/internal/platform":  true,
		"elysian/server/internal/firewall":  true,
		"elysian/server/internal/security":  true,
		"elysian/server/internal/files":     true,
		"elysian/server/internal/terminals": true,
		"elysian/server/internal/docker":    true,
		"elysian/server/internal/database":  true,
		"elysian/server/internal/websites":  true,
	}
	publicLayer := map[string]bool{
		"elysian/server/internal/config":     true,
		"elysian/server/internal/paths":      true,
		"elysian/server/internal/seam":       true,
		"elysian/server/internal/contract":   true,
		"elysian/server/internal/shared":     true,
		"elysian/server/internal/middleware": true,
	}

	pkgs, err := goList("elysian/server/internal/...")
	if err != nil {
		t.Fatalf("go list elysian/server/internal/... 失败：%v", err)
	}
	for _, pkg := range pkgs {
		if !domains[pkg] && !publicLayer[pkg] {
			continue
		}
		deps, err := goList("-deps", pkg)
		if err != nil {
			t.Fatalf("go list -deps %s 失败：%v", pkg, err)
		}
		role := "公共层包"
		if domains[pkg] {
			role = "域包"
		}
		for _, dep := range deps {
			if dep == pkg {
				continue
			}
			if domains[dep] {
				t.Errorf("%s %s 依赖了其它域包 %s（域包只能依赖标准库、选型库与公共层；公共层不得依赖域包）", role, pkg, dep)
			}
		}
	}
}

// goList 执行 go list 并按行取包路径。
func goList(args ...string) ([]string, error) {
	out, err := exec.Command("go", append([]string{"list"}, args...)...).Output()
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			return nil, fmt.Errorf("%w：%s", err, strings.TrimSpace(string(ee.Stderr)))
		}
		return nil, err
	}
	var pkgs []string
	for _, line := range strings.Split(string(out), "\n") {
		if line = strings.TrimSpace(line); line != "" {
			pkgs = append(pkgs, line)
		}
	}
	return pkgs, nil
}
