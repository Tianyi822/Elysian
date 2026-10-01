package files

/*
 * 文件管理路由的行为测试（filesRoutes.test.ts 对等）：fake service 注入，
 * httptest 驱动，不执行任何真实命令。守卫用例与安全区三片同源（503 整片含未知路径、
 * 跨源 403 先于读体、415/413 双拦、404 兜底剥挂载前缀）；query 编码往返锚定
 * 「整串 encodeURIComponent」的传输契约。
 */

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"elysian/server/internal/middleware"
	"elysian/server/internal/shared"
)

var sampleEntry = fileEntry{
	Name:       "nginx.conf",
	Kind:       "file",
	Mode:       "644",
	Owner:      "root",
	SizeBytes:  int64Ptr(1478),
	ModifiedAt: "2026-09-16T07:35:00.000Z",
}

var sampleResult = fileSearchResult{fileEntry: sampleEntry, Path: "/etc/nginx/nginx.conf"}

// recordingService fake service：方法可逐个覆写，默认回样本数据。
type recordingService struct {
	listCalls    []string
	sizeCalls    []string
	copyCalls    [][2]string
	moveCalls    [][2]string
	renameCalls  [][2]string
	compressCall []string
	chmodCalls   []chmodRecord
	searchCalls  []string
	failList     error
	failCopy     error
}

type chmodRecord struct {
	path  string
	input filePermissionInput
}

func (s *recordingService) List(ctx context.Context, dirPath string) ([]fileEntry, error) {
	s.listCalls = append(s.listCalls, dirPath)
	if s.failList != nil {
		return nil, s.failList
	}
	return []fileEntry{sampleEntry}, nil
}

func (s *recordingService) Size(ctx context.Context, nodePath string) (int64, error) {
	s.sizeCalls = append(s.sizeCalls, nodePath)
	return 4096, nil
}

func (s *recordingService) CopyEntry(ctx context.Context, srcPath, destDirPath string) (fileEntry, error) {
	s.copyCalls = append(s.copyCalls, [2]string{srcPath, destDirPath})
	if s.failCopy != nil {
		return fileEntry{}, s.failCopy
	}
	return sampleEntry, nil
}

func (s *recordingService) MoveEntry(ctx context.Context, srcPath, destDirPath string) (fileEntry, error) {
	s.moveCalls = append(s.moveCalls, [2]string{srcPath, destDirPath})
	return sampleEntry, nil
}

func (s *recordingService) RenameEntry(ctx context.Context, path, newName string) (fileEntry, error) {
	s.renameCalls = append(s.renameCalls, [2]string{path, newName})
	return sampleEntry, nil
}

func (s *recordingService) CompressEntry(ctx context.Context, path string) (fileEntry, error) {
	s.compressCall = append(s.compressCall, path)
	return sampleEntry, nil
}

func (s *recordingService) Chmod(ctx context.Context, path string, input filePermissionInput) error {
	s.chmodCalls = append(s.chmodCalls, chmodRecord{path: path, input: input})
	return nil
}

func (s *recordingService) Search(ctx context.Context, keyword string) ([]fileSearchResult, error) {
	s.searchCalls = append(s.searchCalls, keyword)
	return []fileSearchResult{sampleResult}, nil
}

var _ fileService = (*recordingService)(nil)

// errPlain 构造非 400 语义的普通错误（500 口径断言用）。
func errPlain(message string) error { return errors.New(message) }

// encodePath 按 JS encodeURIComponent 逐字节百分号编码（测试传输契约用）。
func encodePath(s string) string {
	const keep = "-_.!~*'()"
	var b strings.Builder
	for _, r := range s {
		if (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || strings.ContainsRune(keep, r) {
			b.WriteRune(r)
			continue
		}
		for _, byteVal := range []byte(string(r)) {
			const hexDigits = "0123456789ABCDEF"
			b.WriteByte('%')
			b.WriteByte(hexDigits[byteVal>>4])
			b.WriteByte(hexDigits[byteVal&0xF])
		}
	}
	return b.String()
}

// newJSONRequest 构造同源合法头的请求（带体时补 JSON 声明）。
func newJSONRequest(t *testing.T, method, path string, body *string, headerOverride map[string]string) *http.Request {
	t.Helper()
	req, err := http.NewRequest(method, "http://localhost:5173"+path, nil)
	if err != nil {
		t.Fatalf("构造请求失败：%v", err)
	}
	req.Host = "localhost:5173"
	req.Header.Set("Origin", "http://localhost:5173")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
		req.ContentLength = int64(len(*body))
		req.Body = io.NopCloser(strings.NewReader(*body))
	}
	for key, value := range headerOverride {
		if value == "" {
			req.Header.Del(key)
			continue
		}
		if key == "Host" {
			req.Host = value
			continue
		}
		req.Header.Set(key, value)
	}
	return req
}

func jsonBody(t *testing.T, payload string) *string {
	t.Helper()
	return &payload
}

// doRequest 在给定 handler 上发请求并回状态码与响应体。
func doRequest(t *testing.T, handler http.Handler, req *http.Request) (int, string) {
	t.Helper()
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec.Code, rec.Body.String()
}

// mountedFiles 复刻 app.ts 的挂载形态：全局剥尾斜杠中间件 + FilesMount 挂载。
func mountedFiles(deps Deps) http.Handler {
	parent := chi.NewRouter()
	parent.Use(middleware.StripTailSlash)
	parent.Mount(shared.FilesMount, NewRouter(deps))
	return parent
}

func requireJSONError(t *testing.T, body, want string) {
	t.Helper()
	wantBody := `{"error":` + quoteJSON(want) + `}`
	if body != wantBody {
		t.Fatalf("响应体 %s，期望 %s", body, wantBody)
	}
}

func TestFilesRoutesUnavailable(t *testing.T) {
	t.Run("不可用时一律 503（容器边界保护，含未知路径与写方法）", func(t *testing.T) {
		app := NewRouter(Deps{Available: false})
		bodies := []*string{
			nil,
			jsonBody(t, `{"srcPath":"/a","destDirPath":"/b"}`),
			jsonBody(t, `{"path":"/a","mode":"755","owner":"root","recursive":false}`),
		}
		shapes := []struct {
			method string
			path   string
			body   *string
		}{
			{"GET", "/entries?path=%2Fvar%2Flog", nil},
			{"GET", "/size?path=%2Fvar%2Flog", nil},
			{"GET", "/search?keyword=log", nil},
			{"POST", "/copy", bodies[1]},
			{"POST", "/chmod", bodies[2]},
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

	t.Run("可用性先于 service 注入（对齐 TS 判定次序）：Available=false 时注入 service 也整片 503", func(t *testing.T) {
		service := &recordingService{}
		app := NewRouter(Deps{Available: false, service: service})
		status, body := doRequest(t, app, newJSONRequest(t, "GET", "/entries?path=%2Fvar%2Flog", nil, nil))
		if status != http.StatusServiceUnavailable {
			t.Fatalf("状态码 %d，期望 503", status)
		}
		requireJSONError(t, body, "真实文件管理仅在 Docker 容器内可用")
		if len(service.listCalls) != 0 {
			t.Fatalf("service 不应被触达：%v", service.listCalls)
		}
	})

	t.Run("挂载后不可用同样整片 503，未知路径不漏成 404", func(t *testing.T) {
		app := mountedFiles(Deps{Available: false})
		status, body := doRequest(t, app, newJSONRequest(t, "GET", shared.FilesMount+"/entries?path=%2Fvar%2Flog", nil, nil))
		if status != http.StatusServiceUnavailable {
			t.Fatalf("状态码 %d，期望 503", status)
		}
		requireJSONError(t, body, "真实文件管理仅在 Docker 容器内可用")
	})
}

func TestFilesRoutesQueries(t *testing.T) {
	t.Run("GET 三端点透传 query 并按契约形状回包", func(t *testing.T) {
		service := &recordingService{}
		app := NewRouter(Deps{Available: true, service: service})

		status, body := doRequest(t, app, newJSONRequest(t, "GET", "/entries?path=%2Fvar%2Flog", nil, nil))
		if status != http.StatusOK {
			t.Fatalf("entries 状态码 %d", status)
		}
		want := `{"entries":[{"name":"nginx.conf","kind":"file","mode":"644","owner":"root","sizeBytes":1478,"modifiedAt":"2026-09-16T07:35:00.000Z"}]}`
		if body != want {
			t.Fatalf("entries 响应体 %s，期望 %s", body, want)
		}

		status, body = doRequest(t, app, newJSONRequest(t, "GET", "/size?path=%2Fvar%2Flog", nil, nil))
		if status != http.StatusOK || body != `{"totalBytes":4096}` {
			t.Fatalf("size = (%d, %s)", status, body)
		}

		status, body = doRequest(t, app, newJSONRequest(t, "GET", "/search?keyword=log", nil, nil))
		if status != http.StatusOK {
			t.Fatalf("search 状态码 %d", status)
		}
		wantSearch := `{"results":[{"name":"nginx.conf","kind":"file","mode":"644","owner":"root","sizeBytes":1478,"modifiedAt":"2026-09-16T07:35:00.000Z","path":"/etc/nginx/nginx.conf"}]}`
		if body != wantSearch {
			t.Fatalf("search 响应体 %s，期望 %s", body, wantSearch)
		}
	})

	t.Run("query 编码整串往返：`+`、中文、空格、`?`、`&` 解码后原样到达 service", func(t *testing.T) {
		service := &recordingService{}
		app := NewRouter(Deps{Available: true, service: service})
		encoded := encodePath("/var/日志 a+b?c&d")
		status, _ := doRequest(t, app, newJSONRequest(t, "GET", "/entries?path="+encoded, nil, nil))
		if status != http.StatusOK {
			t.Fatalf("状态码 %d", status)
		}
		want := []string{"/var/日志 a+b?c&d"}
		if len(service.listCalls) != 1 || service.listCalls[0] != want[0] {
			t.Fatalf("list 收到 %v，期望 %v", service.listCalls, want)
		}
	})

	t.Run("缺 path 的 GET 是 400；缺省 keyword 当空串透传（空关键词返回空数组）", func(t *testing.T) {
		app := NewRouter(Deps{Available: true, service: &recordingService{}})
		status, body := doRequest(t, app, newJSONRequest(t, "GET", "/entries", nil, nil))
		if status != http.StatusBadRequest {
			t.Fatalf("entries 状态码 %d", status)
		}
		requireJSONError(t, body, "缺少路径参数")

		status, body = doRequest(t, app, newJSONRequest(t, "GET", "/size", nil, nil))
		if status != http.StatusBadRequest {
			t.Fatalf("size 状态码 %d", status)
		}
		requireJSONError(t, body, "缺少路径参数")

		searchService := &recordingService{}
		searchApp := NewRouter(Deps{Available: true, service: searchService})
		if _, body := doRequest(t, searchApp, newJSONRequest(t, "GET", "/search", nil, nil)); body == "" {
			t.Fatal("search 应有响应")
		}
		if _, body := doRequest(t, searchApp, newJSONRequest(t, "GET", "/search?keyword=", nil, nil)); body == "" {
			t.Fatal("search 应有响应")
		}
		if len(searchService.searchCalls) != 2 || searchService.searchCalls[0] != "" || searchService.searchCalls[1] != "" {
			t.Fatalf("keyword 透传 = %v，期望两个空串", searchService.searchCalls)
		}
	})
}

func TestFilesRoutesPosts(t *testing.T) {
	t.Run("POST 五端点透传 body 字段，形状不对以中文错误返回 400", func(t *testing.T) {
		service := &recordingService{}
		app := NewRouter(Deps{Available: true, service: service})

		post := func(path, payload string) (int, string) {
			return doRequest(t, app, newJSONRequest(t, "POST", path, jsonBody(t, payload), nil))
		}
		if status, _ := post("/copy", `{"srcPath":"/var/www/index.html","destDirPath":"/tmp"}`); status != http.StatusOK {
			t.Fatalf("copy 状态码 %d", status)
		}
		if status, _ := post("/move", `{"srcPath":"/var/www","destDirPath":"/tmp"}`); status != http.StatusOK {
			t.Fatalf("move 状态码 %d", status)
		}
		if status, _ := post("/rename", `{"path":"/var/www/index.html","newName":" home.html "}`); status != http.StatusOK {
			t.Fatalf("rename 状态码 %d", status)
		}
		if status, _ := post("/compress", `{"path":"/etc/nginx"}`); status != http.StatusOK {
			t.Fatalf("compress 状态码 %d", status)
		}
		if status, body := post("/chmod", `{"path":"/etc/nginx","mode":"755","owner":"deploy","recursive":true}`); status != http.StatusOK || body != `{"ok":true}` {
			t.Fatalf("chmod = (%d, %s)", status, body)
		}

		if len(service.copyCalls) != 1 || service.copyCalls[0] != [2]string{"/var/www/index.html", "/tmp"} {
			t.Fatalf("copyCalls = %v", service.copyCalls)
		}
		if len(service.moveCalls) != 1 || service.moveCalls[0] != [2]string{"/var/www", "/tmp"} {
			t.Fatalf("moveCalls = %v", service.moveCalls)
		}
		if len(service.renameCalls) != 1 || service.renameCalls[0] != [2]string{"/var/www/index.html", " home.html "} {
			t.Fatalf("renameCalls = %v", service.renameCalls)
		}
		if len(service.compressCall) != 1 || service.compressCall[0] != "/etc/nginx" {
			t.Fatalf("compressCall = %v", service.compressCall)
		}
		if len(service.chmodCalls) != 1 || service.chmodCalls[0].path != "/etc/nginx" ||
			service.chmodCalls[0].input.mode != "755" || service.chmodCalls[0].input.owner != "deploy" || !service.chmodCalls[0].input.recursive {
			t.Fatalf("chmodCalls = %+v", service.chmodCalls)
		}

		cases := []struct {
			payload string
			message string
		}{
			{`{"destDirPath":"/tmp"}`, "源路径请求体无效"},
			{`{"srcPath":"/a"}`, "目标目录请求体无效"},
			{`{"path":"/a"}`, "新名称请求体无效"},
			{`{}`, "路径请求体无效"},
			{`{"path":"/a","owner":"root","recursive":false}`, "权限位请求体无效"},
			{`{"path":"/a","mode":"755","recursive":false}`, "所有者请求体无效"},
			{`{"path":"/a","mode":"755","owner":"root","recursive":"是"}`, "递归标记需为布尔值"},
		}
		paths := []string{"/copy", "/move", "/rename", "/compress", "/chmod", "/chmod", "/chmod"}
		for i, c := range cases {
			status, body := post(paths[i], c.payload)
			if status != http.StatusBadRequest {
				t.Fatalf("%s %s 状态码 %d，期望 400", paths[i], c.payload, status)
			}
			requireJSONError(t, body, c.message)
		}
	})

	t.Run("chmod 成功响应 ok；请求被拒按 400 返回，系统侧失败才是 500", func(t *testing.T) {
		rejected := NewRouter(Deps{Available: true, service: &recordingService{failList: shared.InvalidRequest("目录不存在：/nope")}})
		status, body := doRequest(t, rejected, newJSONRequest(t, "GET", "/entries?path=%2Fnope", nil, nil))
		if status != http.StatusBadRequest {
			t.Fatalf("状态码 %d，期望 400", status)
		}
		requireJSONError(t, body, "目录不存在：/nope")

		broken := NewRouter(Deps{Available: true, service: &recordingService{failCopy: errPlain("cp 执行失败（cp -a /a /b/a）：目标已存在")}})
		status, body = doRequest(t, broken, newJSONRequest(t, "POST", "/copy", jsonBody(t, `{"srcPath":"/a","destDirPath":"/b"}`), nil))
		if status != http.StatusInternalServerError {
			t.Fatalf("状态码 %d，期望 500", status)
		}
		requireJSONError(t, body, "cp 执行失败（cp -a /a /b/a）：目标已存在")
	})
}

func TestFilesRoutesGuards(t *testing.T) {
	t.Run("跨源 POST 在读体之前返回 403", func(t *testing.T) {
		service := &recordingService{}
		app := NewRouter(Deps{Available: true, service: service})
		// 请求体故意不是合法 JSON：若守卫晚于读体，这里会变成 500 的解析错误而非 403。
		status, body := doRequest(t, app, newJSONRequest(t, "POST", "/copy", jsonBody(t, "not-json"), map[string]string{"Origin": "http://evil.example"}))
		if status != http.StatusForbidden {
			t.Fatalf("状态码 %d，期望 403", status)
		}
		requireJSONError(t, body, "请求来源不允许")
		if len(service.copyCalls) != 0 {
			t.Fatalf("service 不应被触达：%v", service.copyCalls)
		}
	})

	t.Run("text/plain 的写请求返回 415；空体与坏 JSON 返回 400", func(t *testing.T) {
		app := NewRouter(Deps{Available: true, service: &recordingService{}})
		status, body := doRequest(t, app, newJSONRequest(t, "POST", "/copy", jsonBody(t, "{}"), map[string]string{"Content-Type": "text/plain"}))
		if status != http.StatusUnsupportedMediaType {
			t.Fatalf("状态码 %d，期望 415", status)
		}
		requireJSONError(t, body, "Content-Type 必须为 application/json")

		status, body = doRequest(t, app, newJSONRequest(t, "POST", "/copy", jsonBody(t, ""), nil))
		if status != http.StatusBadRequest {
			t.Fatalf("空体状态码 %d，期望 400", status)
		}
		requireJSONError(t, body, "请求体不能为空")

		status, body = doRequest(t, app, newJSONRequest(t, "POST", "/copy", jsonBody(t, "not-json"), nil))
		if status != http.StatusBadRequest {
			t.Fatalf("坏 JSON 状态码 %d，期望 400", status)
		}
		requireJSONError(t, body, "请求体不是有效 JSON")
	})

	t.Run("请求体超过 64 KiB 返回 413（申报与实读都拦）", func(t *testing.T) {
		app := NewRouter(Deps{Available: true, service: &recordingService{}})

		// 申报即超限：不看流直接拒。
		declared := newJSONRequest(t, "POST", "/copy", nil, nil)
		declared.Header.Set("Content-Type", "application/json")
		declared.ContentLength = 64*1024 + 1
		status, _ := doRequest(t, app, declared)
		if status != http.StatusRequestEntityTooLarge {
			t.Fatalf("申报超限状态码 %d，期望 413", status)
		}

		// 谎报 content-length：实读累计字节数兜底。体本身是合法 JSON，只有体积守卫能拒。
		oversized := `{"srcPath":"` + strings.Repeat("a", 64*1024) + `","destDirPath":"/tmp"}`
		lied := newJSONRequest(t, "POST", "/copy", jsonBody(t, oversized), nil)
		lied.ContentLength = 2
		status, body := doRequest(t, app, lied)
		if status != http.StatusRequestEntityTooLarge {
			t.Fatalf("实读兜底状态码 %d，期望 413", status)
		}
		requireJSONError(t, body, "请求体过大")
	})

	t.Run("GET 放行同源头缺失的请求（无 Origin 头）", func(t *testing.T) {
		app := NewRouter(Deps{Available: true, service: &recordingService{}})
		status, _ := doRequest(t, app, newJSONRequest(t, "GET", "/entries?path=%2Fvar%2Flog", nil, map[string]string{"Origin": ""}))
		if status != http.StatusOK {
			t.Fatalf("状态码 %d，期望 200", status)
		}
	})

	t.Run("同源 application/json 写请求正常通过守卫；大小写归一放行", func(t *testing.T) {
		app := NewRouter(Deps{Available: true, service: &recordingService{}})
		status, _ := doRequest(t, app, newJSONRequest(t, "POST", "/compress", jsonBody(t, `{"path":"/etc/nginx"}`), nil))
		if status != http.StatusOK {
			t.Fatalf("状态码 %d，期望 200", status)
		}

		relaxed := newJSONRequest(t, "POST", "/compress", jsonBody(t, `{"path":"/etc/nginx"}`), map[string]string{
			"Host":         "LOCALHOST:5173",
			"Origin":       "http://localhost:5173",
			"Content-Type": "application/json; charset=utf-8",
		})
		status, _ = doRequest(t, app, relaxed)
		if status != http.StatusOK {
			t.Fatalf("大小写归一状态码 %d，期望 200", status)
		}
	})
}

func TestFilesRoutesNotFound(t *testing.T) {
	t.Run("未知端点 404 文案剥掉挂载前缀：相对路径与安全区三片格式一致", func(t *testing.T) {
		app := mountedFiles(Deps{Available: true, service: &recordingService{}})
		status, body := doRequest(t, app, newJSONRequest(t, "GET", shared.FilesMount+"/nowhere", nil, nil))
		if status != http.StatusNotFound {
			t.Fatalf("状态码 %d，期望 404", status)
		}
		requireJSONError(t, body, "未知文件管理端点：GET /nowhere")

		status, body = doRequest(t, app, newJSONRequest(t, "POST", shared.FilesMount+"/nope/deeper", jsonBody(t, `{}`), nil))
		if status != http.StatusNotFound {
			t.Fatalf("状态码 %d，期望 404", status)
		}
		requireJSONError(t, body, "未知文件管理端点：POST /nope/deeper")
	})

	t.Run("已知路径的未知方法同样落 404 兜底（对齐 Hono all('*')，不回 405）", func(t *testing.T) {
		app := mountedFiles(Deps{Available: true, service: &recordingService{}})
		status, body := doRequest(t, app, newJSONRequest(t, "DELETE", shared.FilesMount+"/entries?path=%2Fvar", nil, nil))
		if status != http.StatusNotFound {
			t.Fatalf("状态码 %d，期望 404", status)
		}
		requireJSONError(t, body, "未知文件管理端点：DELETE /entries")
	})

	t.Run("尾斜杠经全局剥斜杠中间件与无尾斜杠同路由（strict:false 放宽）", func(t *testing.T) {
		app := mountedFiles(Deps{Available: true, service: &recordingService{}})
		status, _ := doRequest(t, app, newJSONRequest(t, "POST", shared.FilesMount+"/copy/", jsonBody(t, `{"srcPath":"/a","destDirPath":"/b"}`), nil))
		if status != http.StatusOK {
			t.Fatalf("尾斜杠状态码 %d，期望 200", status)
		}
	})
}

// quoteJSON 手工产出 JSON 字符串字面量（错误消息为纯中文与 ASCII，无需完整转义器）。
func quoteJSON(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\n':
			b.WriteString(`\n`)
		case '\t':
			b.WriteString(`\t`)
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
	return b.String()
}
