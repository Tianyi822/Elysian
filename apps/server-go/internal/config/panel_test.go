package config

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestAtomicJSONDiskContract(t *testing.T) {
	for _, tc := range []struct {
		name  string
		value any
		want  string
	}{
		{"缩进和转义", map[string]string{"text": "<>&"}, "{\n  \"text\": \"\\u003c\\u003e\\u0026\"\n}\n"},
		{"空值", nil, "null\n"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			parent := filepath.Join(t.TempDir(), "config")
			path := filepath.Join(parent, "state.json")
			if err := AtomicJSON(path, tc.value); err != nil {
				t.Fatal(err)
			}
			if data, err := os.ReadFile(path); err != nil || string(data) != tc.want {
				t.Fatalf("落盘内容 = %q, %v；期望 %q", data, err, tc.want)
			}
			for name, want := range map[string]os.FileMode{parent: 0o700, path: 0o600} {
				info, err := os.Stat(name)
				if err != nil {
					t.Fatal(err)
				}
				if info.Mode().Perm() != want {
					t.Fatalf("%s 权限为 %o；期望 %o", name, info.Mode().Perm(), want)
				}
			}
		})
	}
	parent := filepath.Join(t.TempDir(), "missing")
	if err := AtomicJSON(filepath.Join(parent, "state.json"), make(chan int)); err == nil {
		t.Fatal("不能编码的值应返回错误")
	}
	if _, err := os.Stat(parent); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("编码失败不应创建目录，得到 %v", err)
	}
}

func TestPanelNetworkStrictConfiguration(t *testing.T) {
	filename := filepath.Join(t.TempDir(), "network.json")
	if p, err := ReadPanelNetwork(filename); err != nil || p != DefaultPanelNetwork() {
		t.Fatalf("默认值错误：%v %v", p, err)
	}
	for _, text := range []string{`{`, `{"frontendPort":1}`, `{"frontendPort":48100.5,"backendPort":48101}`, `{"frontendPort":1,"backendPort":1}`, `{"frontendPort":1,"backendPort":65536}`, `{"frontendPort":1,"backendPort":2,"unknown":true}`, `{"frontendPort":1,"backendPort":2} {}`} {
		if err := os.WriteFile(filename, []byte(text), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := ReadPanelNetwork(filename); err == nil {
			t.Fatalf("损坏配置被默默接受：%s", text)
		}
	}
	p := PanelNetwork{49000, 49001}
	if err := AtomicJSON(filename, p); err != nil {
		t.Fatal(err)
	}
	if got, err := ReadPanelNetwork(filename); err != nil || got != p {
		t.Fatalf("配置无法持久化：%v %v", got, err)
	}
}
