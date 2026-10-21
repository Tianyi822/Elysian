package panel

import (
	"os"
	"path/filepath"
	"testing"
)

func TestEnsureSshdPrivSepDir(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "run", "sshd")
	if err := ensureSshdPrivSepDir(dir); err != nil {
		t.Fatalf("首次创建：%v", err)
	}
	if err := ensureSshdPrivSepDir(dir); err != nil {
		t.Fatalf("已存在应幂等：%v", err)
	}
	info, err := os.Stat(dir)
	if err != nil || !info.IsDir() {
		t.Fatalf("应为目录：%v", err)
	}
}
