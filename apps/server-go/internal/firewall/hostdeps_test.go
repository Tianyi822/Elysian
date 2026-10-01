package firewall

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"elysian/server/internal/contract"
)

// 生产接线的降级行为：账本打开失败不拖垮装配，退回会话账本（nil）。
func TestNewExecHostDepsDegradesWithoutSqlite(t *testing.T) {
	blocked := filepath.Join(t.TempDir(), "not-a-dir")
	if err := os.WriteFile(blocked, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	// dbPath 落在一个普通文件下面：建目录失败 → 降级为会话账本。
	deps := newExecHostDeps(filepath.Join(blocked, "firewall.sqlite"), nil)
	if deps.RuleTimes() != nil {
		t.Error("账本打开失败应退回会话账本（nil）")
	}
	if deps.Paths() != defaultFirewallPaths {
		t.Error("缺省路径表应为 DEFAULT_FIREWALL_PATHS")
	}

	// dbPath 为空（PortOpener 用）：不开 sqlite。
	if got := newExecHostDeps("", nil).RuleTimes(); got != nil {
		t.Errorf("空 dbPath 不应打开账本：%v", got)
	}
}

// NewPortOpener 不可用时与装配层注入 NoopPortOpener 同行为（恒 skipped + 固定文案）。
func TestNewPortOpenerUnavailableNoop(t *testing.T) {
	opener := NewPortOpener(Deps{Available: false})
	result := opener.EnsurePortRule(context.Background(), 8080, "Elysian 网站 demo")
	if result.State != contract.FirewallPortSyncSkipped || result.Port != 8080 ||
		result.Detail == nil || *result.Detail != contract.FirewallPortSyncDetailSkipped {
		t.Errorf("不可用应恒 skipped + 固定中文说明：%+v", result)
	}
}
