package files

/*
 * 容器硬边界的测试锚定（filesHostDeps.test.ts 对等）：Go 侧的可用性事实经
 * config 产出、装配层以 Deps.Available 注入（go-plan §5），可用性四象限判定由
 * internal/config 的测试承载。本文件钉住 files 侧边界：不可用一律 503 且不触达
 * 文件系统；可用分支挂「真实服务编排 + 注入的只读宿主 fake」——写命令被调用
 * 即抛错（硬边界回归锚：改坏接线时用例立刻红，而不是静默漏到宿主机执行）。
 */

import (
	"fmt"
	"io/fs"
	"net/http"
	"strings"
	"syscall"
	"testing"
	"time"
)

// listOnlyHost 只够读路径走通的最小内存树；任何写命令被调用即抛错。
type listOnlyHost struct {
	tree map[string]string // path -> "dir" | "file"
}

func newListOnlyHost() *listOnlyHost {
	return &listOnlyHost{tree: map[string]string{
		"/var/log":                  "dir",
		"/var/log/syslog":           "file",
		"/var/log/nginx":            "dir",
		"/var/log/nginx/access.log": "file",
		"/etc":                      "dir",
	}}
}

func (h *listOnlyHost) fail(name string) error {
	return fmt.Errorf("测试内不得执行真实命令：%s", name)
}

func (h *listOnlyHost) statsOf(path string) entryStats {
	kind := h.tree[path]
	stats := entryStats{mode: 0o644, size: 0, modTime: fakeMtime, uid: 0, gid: 0}
	if kind == "dir" {
		stats.mode = fs.ModeDir | 0o755
		stats.size = 4096
		return stats
	}
	switch path {
	case "/var/log/syslog":
		stats.size = 219530
	case "/var/log/nginx/access.log":
		stats.size = 8241
	}
	return stats
}

func (h *listOnlyHost) Readdir(path string) ([]dirEntry, error) {
	if _, ok := h.tree[path]; !ok {
		return nil, syscall.ENOENT
	}
	prefix := path
	if path != "/" {
		prefix = path + "/"
	}
	var out []dirEntry
	for candidate := range h.tree {
		if !strings.HasPrefix(candidate, prefix) {
			continue
		}
		name := candidate[len(prefix):]
		if name == "" || strings.Contains(name, "/") {
			continue
		}
		out = append(out, dirEntry{name: name})
	}
	// map 迭代乱序：按名字排序保证断言稳定（真实 readdir 顺序本不保证）。
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j-1].name > out[j].name; j-- {
			out[j-1], out[j] = out[j], out[j-1]
		}
	}
	return out, nil
}

func (h *listOnlyHost) Lstat(path string) (entryStats, error) {
	if _, ok := h.tree[path]; !ok {
		return entryStats{}, syscall.ENOENT
	}
	return h.statsOf(path), nil
}

func (h *listOnlyHost) Stat(path string) (entryStats, error) { return h.Lstat(path) }

func (h *listOnlyHost) Realpath(path string) (string, error) {
	if _, ok := h.tree[path]; !ok {
		return "", syscall.ENOENT
	}
	return path, nil
}

func (h *listOnlyHost) RenamePath(from, to string) error { return h.fail("rename") }
func (h *listOnlyHost) Mkdir(path string, mode fs.FileMode) error {
	return h.fail("mkdir")
}
func (h *listOnlyHost) RmPath(path string) error   { return h.fail("rm") }
func (h *listOnlyHost) RunCp(args []string) error  { return h.fail("cp") }
func (h *listOnlyHost) RunMv(args []string) error  { return h.fail("mv") }
func (h *listOnlyHost) RunTar(args []string) error { return h.fail("tar") }
func (h *listOnlyHost) ChmodNoFollow(path string, mode fs.FileMode) error {
	return h.fail("chmodNoFollow")
}
func (h *listOnlyHost) ChownNoFollow(path string, uid, gid int) error {
	return h.fail("chownNoFollow")
}
func (h *listOnlyHost) HomeDir() string { return "/root" }

// boundaryApp 由注入的装配入参直接建起可请求的路由。
func boundaryApp(available bool) http.Handler {
	return NewRouter(Deps{
		Available: available,
		Accounts:  newFakeSystemAccounts(),
		host:      newListOnlyHost(),
	})
}

func TestFilesHardBoundary(t *testing.T) {
	t.Run("不可用（含声明了 Docker 但进程不在容器内）：一律 503，不触达注入的宿主原语", func(t *testing.T) {
		app := boundaryApp(false)
		shapes := []struct {
			method string
			path   string
			body   *string
		}{
			{"GET", "/entries?path=%2Fvar%2Flog", nil},
			{"GET", "/size?path=%2Fvar%2Flog", nil},
			{"GET", "/search?keyword=log", nil},
			{"POST", "/copy", jsonBody(t, `{"srcPath":"/a","destDirPath":"/b"}`)},
			{"POST", "/chmod", jsonBody(t, `{"path":"/a","mode":"755","owner":"root","recursive":false}`)},
			{"GET", "/nowhere", nil},
		}
		for _, shape := range shapes {
			status, body := doRequest(t, app, newJSONRequest(t, shape.method, shape.path, shape.body, nil))
			if status != http.StatusServiceUnavailable {
				t.Fatalf("%s %s 状态码 %d，期望 503", shape.method, shape.path, status)
			}
			requireJSONError(t, body, "真实文件管理仅在 Docker 容器内可用")
		}
	})

	t.Run("可用时挂真实 service：读请求经守卫到达注入的 fake deps，宿主机零副作用", func(t *testing.T) {
		app := boundaryApp(true)
		status, body := doRequest(t, app, newJSONRequest(t, "GET", "/entries?path=%2Fvar%2Flog", nil, nil))
		if status != http.StatusOK {
			t.Fatalf("状态码 %d，期望 200", status)
		}
		// 目录条目整个省略 sizeBytes 字段（nil 指针经 JSON 序列化自然消失）。
		want := `{"entries":[` +
			`{"name":"nginx","kind":"directory","mode":"755","owner":"root","modifiedAt":"` + fakeMtime.UTC().Format("2006-01-02T15:04:05.000Z") + `"},` +
			`{"name":"syslog","kind":"file","mode":"644","owner":"root","sizeBytes":219530,"modifiedAt":"` + fakeMtime.UTC().Format("2006-01-02T15:04:05.000Z") + `"}]}`
		if body != want {
			t.Fatalf("响应体 %s，期望 %s", body, want)
		}
	})

	t.Run("真实 service 的路径判据经 HTTP 生效：`.` 段路径被 400 拒绝（中文文案带原样入参）", func(t *testing.T) {
		app := boundaryApp(true)
		status, body := doRequest(t, app, newJSONRequest(t, "GET", "/entries?path="+encodePath("/var/./log"), nil, nil))
		if status != http.StatusBadRequest {
			t.Fatalf("状态码 %d，期望 400", status)
		}
		requireJSONError(t, body, "无效的文件路径：/var/./log")
	})

	t.Run("注入的 fake deps 不触碰真实文件系统：写命令被调用即抛错（硬边界回归锚）", func(t *testing.T) {
		app := boundaryApp(true)
		// 走完整真实 service 链路（校验全过）后落到注入的宿主原语：抛错映射 500，
		// 不执行任何真实命令。写链的首个原语是暂存目录 mkdir（cp/tar 只写私有
		// 暂存目录，最后 rename 发布），它同样只在注入的 deps 上执行。
		status, body := doRequest(t, app, newJSONRequest(t, "POST", "/copy", jsonBody(t, `{"srcPath":"/var/log/syslog","destDirPath":"/etc"}`), nil))
		if status != http.StatusInternalServerError {
			t.Fatalf("状态码 %d，期望 500（响应 %s）", status, body)
		}
		if !strings.Contains(body, "测试内不得执行真实命令") || !strings.Contains(body, "mkdir") {
			t.Fatalf("错误应含「测试内不得执行真实命令」与「mkdir」：%s", body)
		}
	})
}

// 附加锚点：Deps 缺账号通道（Accounts 为 nil）时同样整片 503——有可用性没服务也不许答。
func TestFilesDepsWithoutAccounts(t *testing.T) {
	app := NewRouter(Deps{Available: true})
	status, body := doRequest(t, app, newJSONRequest(t, "GET", "/entries?path=%2Fvar%2Flog", nil, nil))
	if status != http.StatusServiceUnavailable {
		t.Fatalf("状态码 %d，期望 503", status)
	}
	requireJSONError(t, body, "真实文件管理仅在 Docker 容器内可用")
}

// 附加锚点：时间格式对齐 TS toISOString（UTC、毫秒三位、Z 结尾）。
func TestEntryTimeFormat(t *testing.T) {
	stamp := time.Date(2026, 9, 16, 7, 35, 0, 0, time.UTC)
	if got := stamp.Format("2006-01-02T15:04:05.000Z"); got != "2026-09-16T07:35:00.000Z" {
		t.Fatalf("时间格式 %q", got)
	}
	// entryOf 与该格式共用同一出口。
	entry := entryOf("x", entryStats{mode: 0o644, size: 1, modTime: stamp}, map[int]string{})
	if entry.ModifiedAt != "2026-09-16T07:35:00.000Z" {
		t.Fatalf("entryOf 时间 = %q", entry.ModifiedAt)
	}
}
