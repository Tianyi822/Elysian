package database

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

func TestDatabaseRegistryTrustContract(t *testing.T) {
	for _, tc := range []struct {
		name string
		mode os.FileMode
		link func(string, string) error
		data string
		want error
	}{
		{"普通私有文件", 0o600, nil, "[]", nil},
		{"硬链接登记", 0o600, os.Link, "[]", nil},
		{"符号链接", 0o600, os.Symlink, "[]", syscall.ELOOP},
		{"权限过宽", 0o640, nil, "[]", errors.New("数据库登记文件权限或内容无效")},
		{"体积超限", 0o600, nil, strings.Repeat(" ", registrySizeLimit+1), errors.New("数据库登记文件权限或内容无效")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "registry.json")
			if err := os.WriteFile(path, []byte(tc.data), tc.mode); err != nil {
				t.Fatal(err)
			}
			if tc.link != nil {
				alias := path + ".alias"
				if err := tc.link(path, alias); err != nil {
					t.Fatal(err)
				}
				path = alias
			}
			_, err := newFileDatabaseRegistry(path).list()
			if !errors.Is(err, tc.want) && (err == nil || tc.want == nil || err.Error() != tc.want.Error()) {
				t.Fatalf("读取错误 = %v；期望 %v", err, tc.want)
			}
		})
	}
}

func TestSQLiteDataFileRequiresSingleLink(t *testing.T) {
	s := newTestSqliteService(t, nil)
	const id = "10000000-0000-4000-8000-000000000000"
	path, err := s.pathFor(id)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("SQLite 测试文件"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got, err := s.checkedFile(id); err != nil || got != path {
		t.Fatalf("单链接私有文件应可用：%q %v", got, err)
	}
	if err := os.Link(path, path+".alias"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.checkedFile(id); err == nil || err.Error() != "SQLite 文件权限、类型或位置无效" {
		t.Fatalf("受管数据文件必须拒绝多链接，得到 %v", err)
	}
}
