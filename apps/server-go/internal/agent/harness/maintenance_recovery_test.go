package harness

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReadWorkflowRecoveryFenceValidatesFile(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "missing.json")
	if got, err := readWorkflowRecoveryFence(missing); got || err != nil {
		t.Fatalf("缺失标记应视为未设置：%v %v", got, err)
	}
	if got, err := readWorkflowRecoveryFence(""); got || err != nil {
		t.Fatalf("空路径应视为未设置：%v %v", got, err)
	}

	valid := `{"version":1,"reason":"panel-rollback","createdAt":"2026-10-10T00:00:00Z"}`
	cases := []struct {
		name    string
		content string
		mode    os.FileMode
		wantErr bool
	}{
		{name: "valid", content: valid, mode: 0600},
		{name: "wrong mode", content: valid, mode: 0644, wantErr: true},
		{name: "oversized", content: strings.Repeat("x", 4097), mode: 0600, wantErr: true},
		{name: "malformed", content: `{"version":`, mode: 0600, wantErr: true},
		{name: "unknown field", content: `{"version":1,"reason":"panel-rollback","createdAt":"2026-10-10T00:00:00Z","extra":true}`, mode: 0600, wantErr: true},
		{name: "wrong version", content: `{"version":2,"reason":"panel-rollback","createdAt":"2026-10-10T00:00:00Z"}`, mode: 0600, wantErr: true},
		{name: "wrong reason", content: `{"version":1,"reason":"other","createdAt":"2026-10-10T00:00:00Z"}`, mode: 0600, wantErr: true},
		{name: "bad time", content: `{"version":1,"reason":"panel-rollback","createdAt":"not-time"}`, mode: 0600, wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "fence.json")
			if err := os.WriteFile(path, []byte(tc.content), tc.mode); err != nil {
				t.Fatal(err)
			}
			if err := os.Chmod(path, tc.mode); err != nil {
				t.Fatal(err)
			}
			got, err := readWorkflowRecoveryFence(path)
			if tc.wantErr {
				if err == nil || got {
					t.Fatalf("非法标记未拒绝：got=%v err=%v", got, err)
				}
				return
			}
			if err != nil || !got {
				t.Fatalf("合法标记未接受：got=%v err=%v", got, err)
			}
		})
	}

	t.Run("directory", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "fence")
		if err := os.Mkdir(path, 0700); err != nil {
			t.Fatal(err)
		}
		if got, err := readWorkflowRecoveryFence(path); err == nil || got {
			t.Fatalf("目录未被拒绝：got=%v err=%v", got, err)
		}
	})

	t.Run("symlink", func(t *testing.T) {
		dir := t.TempDir()
		target := filepath.Join(dir, "target.json")
		if err := os.WriteFile(target, []byte(valid), 0600); err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(dir, "fence.json")
		if err := os.Symlink(target, path); err != nil {
			t.Skipf("环境不支持符号链接：%v", err)
		}
		if got, err := readWorkflowRecoveryFence(path); err == nil || got {
			t.Fatalf("符号链接未被拒绝：got=%v err=%v", got, err)
		}
	})
}
