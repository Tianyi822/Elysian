package cli

import (
	"os"
	"path/filepath"
	"testing"
)

// 本地凭据与状态持久化测试（CLI 方案 §3.3）：0600 权限、原子写、不存在按零值、
// 损坏文件不阻断、清除幂等。

func TestCLISessionRoundTripAndPermissions(t *testing.T) {
	// 取 TempDir 下的新子目录，保证权限断言针对 writeLocalFile 的 MkdirAll 建目录。
	dir := filepath.Join(t.TempDir(), "cli")
	store, err := newCLIStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReadSession(); err != nil {
		t.Fatalf("首次读取（文件不存在）应返回零值不报错：%v", err)
	}
	stored := StoredSession{BaseURL: "http://127.0.0.1:48101", Cookie: "cli-cookie"}
	if err := store.WriteSession(stored); err != nil {
		t.Fatal(err)
	}
	got, err := store.ReadSession()
	if err != nil || got != stored {
		t.Fatalf("凭据应原样读回：%+v %v", got, err)
	}
	info, err := os.Stat(filepath.Join(dir, "session.json"))
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("凭据文件应为 0600，得到 %o", perm)
	}
	if dirInfo, err := os.Stat(dir); err != nil || dirInfo.Mode().Perm() != 0o700 {
		t.Fatalf("目录应为 0700：%v", err)
	}
	// 临时文件不残留。
	entries, _ := os.ReadDir(dir)
	for _, entry := range entries {
		if filepath.Ext(entry.Name()) == ".tmp" {
			t.Fatalf("临时文件残留：%s", entry.Name())
		}
	}
}

func TestCLISessionClearIdempotent(t *testing.T) {
	store, err := newCLIStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := store.ClearSession(); err != nil {
		t.Fatalf("清除不存在的凭据应幂等：%v", err)
	}
	if err := store.WriteSession(StoredSession{BaseURL: "http://127.0.0.1:48101", Cookie: "c"}); err != nil {
		t.Fatal(err)
	}
	if err := store.ClearSession(); err != nil {
		t.Fatal(err)
	}
	if stored, err := store.ReadSession(); err != nil || stored.Cookie != "" {
		t.Fatalf("清除后应读到零值：%+v %v", stored, err)
	}
}

func TestCLIStateRoundTripAndCorruptTolerance(t *testing.T) {
	store, err := newCLIStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	state := StoredState{SelectedSessionID: "s-1", ReasoningLevels: map[string]string{"s-1": "max"}, PermissionModes: map[string]string{"s-1": "full"}}
	if err := store.WriteState(state); err != nil {
		t.Fatal(err)
	}
	got, err := store.ReadState()
	if err != nil || got.SelectedSessionID != "s-1" || got.ReasoningLevels["s-1"] != "max" || got.PermissionModes["s-1"] != "full" {
		t.Fatalf("状态应原样读回：%+v %v", got, err)
	}
	// 损坏文件按零值处理，不阻断。
	if err := os.WriteFile(store.statePath(), []byte("{not-json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got, err := store.ReadState(); err != nil || got.SelectedSessionID != "" {
		t.Fatalf("损坏状态应回落零值：%+v %v", got, err)
	}
	// 损坏凭据同样回落零值（进入登录流程）。
	if err := os.WriteFile(store.sessionPath(), []byte("{not-json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if stored, err := store.ReadSession(); err != nil || stored.Cookie != "" {
		t.Fatalf("损坏凭据应回落零值：%+v %v", stored, err)
	}
}
