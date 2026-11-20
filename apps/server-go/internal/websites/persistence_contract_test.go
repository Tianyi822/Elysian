package websites

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

func TestWebsiteWriteDiskContract(t *testing.T) {
	for _, tc := range []struct {
		name  string
		write func(string) error
		want  string
		mkdir bool
	}{
		{"登记", func(path string) error {
			return (&fileWebsiteRegistry{path: path}).write([]WebsiteRecord{{Name: "<>&"}})
		}, `[{"id":"","kind":"","name":"<>&","port":0,"runtimeVersion":null,"rootDir":"","domain":null,"accessMode":"","certificate":null,"containerName":null,"containerId":null,"imageRef":null,"deployCommand":null,"enabled":false,"category":"","expiryAt":null,"note":null,"gitUrl":null,"createdAt":""}]`, true},
		{"部署", func(path string) error {
			return writeDeploymentJSON(path, map[string]string{"name": "<>&"})
		}, `{"name":"\u003c\u003e\u0026"}`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			parent := filepath.Join(t.TempDir(), "state")
			path := filepath.Join(parent, "record.json")
			if !tc.mkdir {
				if err := tc.write(path); !errors.Is(err, os.ErrNotExist) {
					t.Fatalf("缺失的部署目录应返回原错误：%v", err)
				}
				if err := os.Mkdir(parent, 0o700); err != nil {
					t.Fatal(err)
				}
			}
			if err := tc.write(path); err != nil {
				t.Fatal(err)
			}
			if data, err := os.ReadFile(path); err != nil || string(data) != tc.want {
				t.Fatalf("落盘内容 = %q, %v；期望 %q", data, err, tc.want)
			}
			info, err := os.Stat(path)
			if err != nil || info.Mode().Perm() != 0o600 {
				t.Fatalf("登记或部署文件应为 0600：%v, %v", info, err)
			}
		})
	}
}

func TestWebsiteRegistryTrustContract(t *testing.T) {
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
		{"权限过宽", 0o640, nil, "[]", errRegistryUnusable},
		{"体积超限", 0o600, nil, strings.Repeat(" ", registryMaxBytes+1), errRegistryUnusable},
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
			if _, err := (&fileWebsiteRegistry{path: path}).read(); !errors.Is(err, tc.want) {
				t.Fatalf("读取错误 = %v；期望 %v", err, tc.want)
			}
		})
	}
}
