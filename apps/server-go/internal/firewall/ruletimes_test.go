package firewall

import (
	"path/filepath"
	"testing"
)

// ruleTimesStore.bun.test.ts 的对等测试：modernc.org/sqlite 真 sqlite。

func TestRuleTimesStoreSetGetRemove(t *testing.T) {
	store, err := openRuleTimesStore(":memory:")
	if err != nil {
		t.Fatalf("打开内存库失败：%v", err)
	}
	defer store.Close()

	store.Set("ufw-allow-in-tcp-22-any", "2026-09-19T08:00:00.000Z")
	if got, ok := store.Get("ufw-allow-in-tcp-22-any"); !ok || got != "2026-09-19T08:00:00.000Z" {
		t.Errorf("set 后 get = %q %v", got, ok)
	}
	if _, ok := store.Get("unknown"); ok {
		t.Error("无记录应回未找到")
	}

	store.Remove("ufw-allow-in-tcp-22-any")
	if _, ok := store.Get("ufw-allow-in-tcp-22-any"); ok {
		t.Error("remove 后应消失")
	}
}

func TestRuleTimesStoreOverwrite(t *testing.T) {
	store, err := openRuleTimesStore(":memory:")
	if err != nil {
		t.Fatalf("打开内存库失败：%v", err)
	}
	defer store.Close()

	store.Set("ufwip-deny-from-203.0.113.9", "2026-09-19T08:00:00.000Z")
	store.Set("ufwip-deny-from-203.0.113.9", "2026-09-19T09:30:00.000Z")
	if got, _ := store.Get("ufwip-deny-from-203.0.113.9"); got != "2026-09-19T09:30:00.000Z" {
		t.Errorf("重复 set 应覆盖为最新，got %q", got)
	}
}

func TestRuleTimesStorePersistsAcrossReopen(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "firewall.sqlite")

	store, err := openRuleTimesStore(path)
	if err != nil {
		t.Fatalf("打开文件库失败：%v", err)
	}
	store.Set("fwd-tcp-8080-10.0.0.5-80", "2026-09-19T08:00:00.000Z")
	store.Close()

	reopened, err := openRuleTimesStore(path)
	if err != nil {
		t.Fatalf("重新打开失败：%v", err)
	}
	defer reopened.Close()
	if got, ok := reopened.Get("fwd-tcp-8080-10.0.0.5-80"); !ok || got != "2026-09-19T08:00:00.000Z" {
		t.Errorf("重新打开文件库后数据应在，got %q %v", got, ok)
	}
}
