package harness

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestEmbeddingWriteDiskContract(t *testing.T) {
	for _, tc := range []struct {
		name    string
		prepare func(*testing.T, string) string
		message string
	}{
		{"正常写入并创建父目录", func(_ *testing.T, root string) string {
			return filepath.Join(root, "config", "embeddings.json")
		}, ""},
		{"父路径是文件", func(t *testing.T, root string) string {
			parent := filepath.Join(root, "not-a-directory")
			if err := os.WriteFile(parent, nil, 0o600); err != nil {
				t.Fatal(err)
			}
			return filepath.Join(parent, "embeddings.json")
		}, "Embedding 配置目录不可写"},
		{"目标是目录", func(_ *testing.T, root string) string { return root }, "Embedding 配置路径无效"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := tc.prepare(t, t.TempDir())
			m := Manager{deps: Deps{EmbeddingConfigPath: path}}
			err := m.writeEmbeddingProfiles(nil)
			if tc.message != "" {
				var failure *Error
				if !errors.As(err, &failure) || failure.Code != "embedding-profile-storage" || failure.Message != tc.message {
					t.Fatalf("写入结果 = %v；期望 %q", err, tc.message)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if data, err := os.ReadFile(path); err != nil || string(data) != `{"version":1,"profiles":[]}` {
				t.Fatalf("Embedding 落盘内容 = %q, %v", data, err)
			}
		})
	}
}
