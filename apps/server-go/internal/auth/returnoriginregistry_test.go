package auth

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 白名单文件测试（returnOriginRegistry.test.ts 对等用例）：注入临时目录与诊断
// buffer。锚定「不可用退化为空表、单项坏只丢该项、直读不缓存」，以及诊断文案经
// 诊断出口落 stderr。缺文件与坏内容都不得让面板登录或探测受影响。

func newTestRegistry(t *testing.T, path string) (ReturnOriginRegistry, *bytes.Buffer) {
	t.Helper()
	diag := &bytes.Buffer{}
	return NewFileReturnOriginRegistry(path, diag), diag
}

func writeOrigins(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("建目录失败：%v", err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("写文件失败：%v", err)
	}
}

func listEqual(t *testing.T, got []string, want ...string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("list = %v，期望 %v", got, want)
	}
	for i := range got {
		if got[i] != want[i] {
			t.Fatalf("list = %v，期望 %v", got, want)
		}
	}
}

func TestReturnOriginRegistryValidFile(t *testing.T) {
	dir := tempDir(t)
	path := filepath.Join(dir, "config", "sso-return-origins.json")
	writeOrigins(t, path, `{"version":1,"origins":["http://127.0.0.1:5173","http://127.0.0.1:48100"]}`)
	registry, _ := newTestRegistry(t, path)
	got, err := registry.List()
	if err != nil {
		t.Fatalf("List 报错：%v", err)
	}
	listEqual(t, got, "http://127.0.0.1:5173", "http://127.0.0.1:48100")
}

func TestReturnOriginRegistryMissingFileDiagnostics(t *testing.T) {
	dir := tempDir(t)
	registry, diag := newTestRegistry(t, filepath.Join(dir, "config", "sso-return-origins.json"))
	got, err := registry.List()
	if err != nil {
		t.Fatalf("缺文件不应抛错：%v", err)
	}
	listEqual(t, got)
	lines := strings.Split(strings.TrimRight(diag.String(), "\n"), "\n")
	if len(lines) != 1 || !strings.HasPrefix(lines[0], SSOOriginsUnavailable) {
		t.Errorf("期望一行以 %q 开头的诊断，得 %q", SSOOriginsUnavailable, diag.String())
	}
}

func TestReturnOriginRegistryUnavailableShapes(t *testing.T) {
	dir := tempDir(t)
	cases := []struct {
		name    string
		content string
	}{
		{"坏 JSON", "not json"},
		{"顶层是数组", `["http://127.0.0.1:5173"]`},
		{"缺 origins", `{"version":1}`},
		{"origins 非数组", `{"version":1,"origins":"http://127.0.0.1:5173"}`},
		{"version 不为 1", `{"version":2,"origins":["http://127.0.0.1:5173"]}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(dir, "bad-"+tc.name+".json")
			writeOrigins(t, path, tc.content)
			registry, diag := newTestRegistry(t, path)
			got, err := registry.List()
			if err != nil {
				t.Fatalf("%s 不应抛错：%v", tc.name, err)
			}
			listEqual(t, got)
			lines := strings.Split(strings.TrimRight(diag.String(), "\n"), "\n")
			if len(lines) != 1 || !strings.HasPrefix(lines[0], SSOOriginsUnavailable) {
				t.Errorf("%s 期望一行诊断，得 %q", tc.name, diag.String())
			}
		})
	}
}

func TestReturnOriginRegistryDropsInvalidEntries(t *testing.T) {
	dir := tempDir(t)
	path := filepath.Join(dir, "mixed.json")
	writeOrigins(t, path, `{"version":1,"origins":["http://127.0.0.1:5173/","http://127.0.0.1:5173/app","http://evil.example",42,"http://127.0.0.1:5173","http://localhost:3000"]}`)
	registry, diag := newTestRegistry(t, path)
	got, err := registry.List()
	if err != nil {
		t.Fatalf("List 报错：%v", err)
	}
	listEqual(t, got, "http://127.0.0.1:5173", "http://localhost:3000")
	var ignored []string
	for _, line := range strings.Split(strings.TrimRight(diag.String(), "\n"), "\n") {
		if strings.HasPrefix(line, SSOOriginIgnored) {
			ignored = append(ignored, line)
		}
	}
	if len(ignored) != 4 {
		t.Fatalf("期望 4 行忽略诊断，得 %d：%v", len(ignored), ignored)
	}
	if !strings.Contains(ignored[3], "42") {
		t.Errorf("非字符串项的忽略诊断应含原值：%v", ignored[3])
	}
}

func TestReturnOriginRegistryDefaultPortDropped(t *testing.T) {
	dir := tempDir(t)
	path := filepath.Join(dir, "default-port.json")
	writeOrigins(t, path, `{"version":1,"origins":["http://127.0.0.1:80","https://127.0.0.1:443","http://127.0.0.1:5173"]}`)
	registry, diag := newTestRegistry(t, path)
	got, err := registry.List()
	if err != nil {
		t.Fatalf("List 报错：%v", err)
	}
	// 只有显式非默认端口的 5173 留下；两条默认端口被归一吞并后与自身不等而丢弃。
	listEqual(t, got, "http://127.0.0.1:5173")
	var ignored []string
	for _, line := range strings.Split(strings.TrimRight(diag.String(), "\n"), "\n") {
		if strings.HasPrefix(line, SSOOriginIgnored) {
			ignored = append(ignored, line)
		}
	}
	if len(ignored) != 2 {
		t.Fatalf("期望 2 行忽略诊断，得 %v", ignored)
	}
	if !strings.Contains(ignored[0], "http://127.0.0.1:80") || !strings.Contains(ignored[1], "https://127.0.0.1:443") {
		t.Errorf("默认端口忽略诊断应含原条目：%v", ignored)
	}
}

func TestReturnOriginRegistryIPv6LoopbackValid(t *testing.T) {
	dir := tempDir(t)
	path := filepath.Join(dir, "v6.json")
	writeOrigins(t, path, `{"version":1,"origins":["http://[::1]:5173"]}`)
	registry, _ := newTestRegistry(t, path)
	got, err := registry.List()
	if err != nil {
		t.Fatalf("List 报错：%v", err)
	}
	listEqual(t, got, "http://[::1]:5173")
}

func TestReturnOriginRegistryOverSizeLimit(t *testing.T) {
	dir := tempDir(t)
	path := filepath.Join(dir, "huge.json")
	padding := strings.Repeat("x", ReturnOriginsMaxBytes)
	writeOrigins(t, path, `{"version":1,"origins":["http://127.0.0.1:5173"],"padding":"`+padding+`"}`)
	registry, diag := newTestRegistry(t, path)
	got, err := registry.List()
	if err != nil {
		t.Fatalf("超限不应抛错：%v", err)
	}
	listEqual(t, got)
	if !strings.HasPrefix(diag.String(), SSOOriginsUnavailable) {
		t.Errorf("超限期望不可用诊断，得 %q", diag.String())
	}
}

func TestReturnOriginRegistryDirectReadNoCache(t *testing.T) {
	dir := tempDir(t)
	path := filepath.Join(dir, "live.json")
	writeOrigins(t, path, `{"version":1,"origins":["http://127.0.0.1:5173"]}`)
	registry, _ := newTestRegistry(t, path)
	got, err := registry.List()
	if err != nil {
		t.Fatalf("List 报错：%v", err)
	}
	listEqual(t, got, "http://127.0.0.1:5173")
	writeOrigins(t, path, `{"version":1,"origins":["http://127.0.0.1:8080"]}`)
	got, err = registry.List()
	if err != nil {
		t.Fatalf("再次 List 报错：%v", err)
	}
	listEqual(t, got, "http://127.0.0.1:8080")
}

func TestReturnOriginRegistrySymlinkFinalComponent(t *testing.T) {
	dir := tempDir(t)
	target := filepath.Join(dir, "target.json")
	writeOrigins(t, target, `{"version":1,"origins":["http://127.0.0.1:5173"]}`)
	link := filepath.Join(dir, "link.json")
	if err := os.Symlink(target, link); err != nil {
		t.Fatalf("建符号链接失败：%v", err)
	}
	registry, diag := newTestRegistry(t, link)
	got, err := registry.List()
	if err != nil {
		t.Fatalf("符号链接不应抛错：%v", err)
	}
	listEqual(t, got)
	if !strings.HasPrefix(diag.String(), SSOOriginsUnavailable) {
		t.Errorf("最终组件是符号链接按不可用处理，得 %q", diag.String())
	}
}

func TestMemoryReturnOriginRegistry(t *testing.T) {
	registry := NewMemoryReturnOriginRegistry(nil)
	got, err := registry.List()
	if err != nil {
		t.Fatalf("List 报错：%v", err)
	}
	listEqual(t, got)
	registry = NewMemoryReturnOriginRegistry([]string{"http://127.0.0.1:5173"})
	got, err = registry.List()
	if err != nil {
		t.Fatalf("List 报错：%v", err)
	}
	listEqual(t, got, "http://127.0.0.1:5173")
}
