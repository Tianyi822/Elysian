package applog

import (
	"fmt"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// openForTest 在临时目录打开日志并在测试结束时复位进程级状态。
func openForTest(t *testing.T) (*Logger, string) {
	t.Helper()
	dir := t.TempDir()
	logger, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() {
		_ = logger.Close()
		defaultLogger.Store(nil)
		log.SetOutput(os.Stderr)
	})
	return logger, filepath.Join(dir, PanelLogName)
}

func readLog(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读日志文件：%v", err)
	}
	return string(data)
}

func TestOpenRoutesStandardLogToFile(t *testing.T) {
	logger, path := openForTest(t)
	if Default() != logger {
		t.Fatal("Open 后 Default 应返回同一实例")
	}
	log.Print("启动完成测试行")
	content := readLog(t, path)
	if !strings.Contains(content, "启动完成测试行") {
		t.Fatalf("标准 log 输出未落文件：%q", content)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("日志文件权限应为 0600，实际 %o", info.Mode().Perm())
	}
}

func TestOpenAppendsAndCountsExistingSize(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, PanelLogName)
	if err := os.WriteFile(path, []byte("旧内容\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	logger, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() {
		_ = logger.Close()
		defaultLogger.Store(nil)
		log.SetOutput(os.Stderr)
	})
	if logger.size != int64(len("旧内容\n")) {
		t.Fatalf("应从既有大小继续计数，实际 %d", logger.size)
	}
	log.Print("新行")
	content := readLog(t, path)
	if !strings.HasPrefix(content, "旧内容\n") || !strings.Contains(content, "新行") {
		t.Fatalf("应追加而非覆盖：%q", content)
	}
}

func TestRotateKeepsOneBackup(t *testing.T) {
	logger, path := openForTest(t)
	logger.threshold = 64
	line := strings.Repeat("x", 40) + "\n"
	for i := 0; i < 5; i++ {
		if _, err := logger.Write([]byte(line)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := os.Stat(path + ".1"); err != nil {
		t.Fatalf("应存在 panel.log.1：%v", err)
	}
	if _, err := os.Stat(path + ".2"); !os.IsNotExist(err) {
		t.Fatalf("不应保留 panel.log.2：%v", err)
	}
	current := readLog(t, path)
	if int64(len(current)) > logger.threshold {
		t.Fatalf("轮转后当前文件应小于阈值，实际 %d 字节", len(current))
	}
	if _, err := logger.Write([]byte("轮转后仍可写\n")); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(readLog(t, path), "轮转后仍可写") {
		t.Fatal("轮转后新文件应继续接收写入")
	}
}

func TestNilLoggerMethodsAreNoops(t *testing.T) {
	var logger *Logger
	logger.RequestFailure(http.MethodGet, "/api/x", 404, time.Millisecond)
	logger.PanicStack([]byte("stack"))
	if err := logger.Close(); err != nil {
		t.Fatalf("nil Close 应无错误：%v", err)
	}
	if _, err := (&Logger{}).Write([]byte("未打开也不报错")); err != nil {
		t.Fatalf("未打开实例 Write 应吞写：%v", err)
	}
}

func TestRequestFailureLineOmitsRequestID(t *testing.T) {
	_, path := openForTest(t)
	Default().RequestFailure(http.MethodGet, "/api/resources/history", http.StatusNotFound, 3*time.Millisecond)
	content := readLog(t, path)
	if !strings.Contains(content, "HTTP GET /api/resources/history 404 3ms") {
		t.Fatalf("失败请求行格式不符：%q", content)
	}
}

func TestPanicStackWritesMultilineStack(t *testing.T) {
	_, path := openForTest(t)
	Default().PanicStack([]byte("goroutine 1 [running]:\nmain.main()\n"))
	content := readLog(t, path)
	if !strings.Contains(content, "panic 栈：\ngoroutine 1 [running]:\nmain.main()") {
		t.Fatalf("panic 栈应原样多行落盘：%q", content)
	}
}

func TestFailureLogMiddleware(t *testing.T) {
	_, path := openForTest(t)
	handler := FailureLogMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/missing":
			http.Error(w, "404 Not Found", http.StatusNotFound)
		case "/api/ok":
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("ok"))
		case "/api/implicit":
			_, _ = w.Write([]byte("隐式 200"))
		default:
			http.Error(w, "spa 404", http.StatusNotFound)
		}
	}))
	for _, path := range []string{"/api/missing", "/api/ok", "/api/implicit", "/assets/missing.js"} {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	}
	content := readLog(t, path)
	if !strings.Contains(content, "HTTP GET /api/missing 404") {
		t.Fatalf("/api 失败请求应记录：%q", content)
	}
	for _, forbidden := range []string{"/api/ok", "/api/implicit", "/assets/missing.js"} {
		if strings.Contains(content, forbidden) {
			t.Fatalf("%s 不应被记录：%q", forbidden, content)
		}
	}
}

func TestFailureLogMiddlewareForwardsFlush(t *testing.T) {
	flushed := false
	inner := &flushRecorder{ResponseRecorder: httptest.NewRecorder(), onFlush: func() { flushed = true }}
	handler := FailureLogMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		flusher, ok := w.(http.Flusher)
		if !ok {
			t.Fatal("包装后的 ResponseWriter 应实现 Flusher")
		}
		w.WriteHeader(http.StatusOK)
		flusher.Flush()
	}))
	handler.ServeHTTP(inner, httptest.NewRequest(http.MethodGet, "/api/events", nil))
	if !flushed {
		t.Fatal("Flush 应透传到底层写出器")
	}
}

type flushRecorder struct {
	*httptest.ResponseRecorder
	onFlush func()
}

func (f *flushRecorder) Flush() {
	f.onFlush()
	f.ResponseRecorder.Flush()
}

func TestReopenReplacesDefault(t *testing.T) {
	first, firstPath := openForTest(t)
	second, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = second.Close() })
	if Default() != second {
		t.Fatal("重复 Open 应替换 Default")
	}
	if first.file != nil {
		t.Fatal("旧实例应已关闭")
	}
	log.Print("写到新文件")
	if strings.Contains(readLog(t, firstPath), "写到新文件") {
		t.Fatal("旧文件不应再收到写入")
	}
	if fmt.Sprint(Default().path) == firstPath {
		t.Fatal("Default 路径应指向新目录")
	}
}
