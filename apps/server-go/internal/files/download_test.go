package files

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func testTransferManager(t *testing.T) *TransferManager {
	t.Helper()
	m := NewTransferManager(filepath.Join(t.TempDir(), "downloads"), nil)
	t.Cleanup(func() {
		if err := m.Close(context.Background()); err != nil {
			t.Error(err)
		}
	})
	return m
}

func writeDownloadFixture(t *testing.T, root, name string, data []byte) string {
	t.Helper()
	path := filepath.Join(root, name)
	if err := os.WriteFile(path, data, 0644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestDownloadOriginalBytesAndSingleClaim(t *testing.T) {
	m := testTransferManager(t)
	root := t.TempDir()
	data := []byte{'P', 'K', 0, 1, 255, '\n'}
	path := writeDownloadFixture(t, root, "压缩 包+%.zip", data)
	result, err := m.Prepare(context.Background(), "session", path)
	if err != nil {
		t.Fatal(err)
	}
	if result.Name != filepath.Base(path) || result.SizeBytes != int64(len(data)) {
		t.Fatalf("wrong result: %+v", result)
	}
	if _, err := m.claim(result.ID, "other-session"); err == nil {
		t.Fatal("跨会话领取成功")
	}
	download, err := m.claim(result.ID, "session")
	if err != nil {
		t.Fatal(err)
	}
	defer m.release(download)
	actual, err := io.ReadAll(download.file)
	if err != nil || !bytes.Equal(actual, data) {
		t.Fatalf("文件字节改变：%v %v", actual, err)
	}
	if _, err := m.claim(result.ID, "session"); err == nil {
		t.Fatal("重复领取成功")
	}
}

func TestDownloadDirectoryArchiveAndLinks(t *testing.T) {
	m := testTransferManager(t)
	root := filepath.Join(t.TempDir(), "目录")
	if err := os.MkdirAll(filepath.Join(root, "空目录"), 0755); err != nil {
		t.Fatal(err)
	}
	writeDownloadFixture(t, root, "内容.txt", []byte("hello\n"))
	if err := os.Symlink("/proc/self", filepath.Join(root, "仅链接")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(".", filepath.Join(root, "环")); err != nil {
		t.Fatal(err)
	}
	result, err := m.Prepare(context.Background(), "session", root)
	if err != nil {
		t.Fatal(err)
	}
	if result.Name != "目录.tar.gz" {
		t.Fatalf("错误文件名 %s", result.Name)
	}
	d, err := m.claim(result.ID, "session")
	if err != nil {
		t.Fatal(err)
	}
	defer m.release(d)
	gz, err := gzip.NewReader(d.file)
	if err != nil {
		t.Fatal(err)
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	seen := map[string]byte{}
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		seen[h.Name] = h.Typeflag
		if strings.HasPrefix(h.Name, "/") {
			t.Fatal("归档包含绝对路径")
		}
		if h.Name == "目录/内容.txt" {
			b, _ := io.ReadAll(tr)
			if string(b) != "hello\n" {
				t.Fatal("归档内容改变")
			}
		}
	}
	if len(seen) != 5 || seen["目录/空目录/"] != tar.TypeDir || seen["目录/仅链接"] != tar.TypeSymlink || seen["目录/环"] != tar.TypeSymlink {
		t.Fatalf("错误归档: %v", seen)
	}
	entries, err := os.ReadDir(m.root)
	if err != nil || len(entries) != 0 {
		t.Fatalf("临时归档不应保留目录项：%v %v", entries, err)
	}
	if _, err := os.Stat(root + ".tar.gz"); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("源目录旁出现归档")
	}
}

func TestDownloadRejectsUnsafeAndSpecialSources(t *testing.T) {
	m := testTransferManager(t)
	root := t.TempDir()
	fifo := filepath.Join(root, "pipe")
	if err := unix.Mkfifo(fifo, 0600); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(t.TempDir(), "virtual")
	if err := os.Symlink("/proc", alias); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/", "/proc/self/status", "/tmp/../etc", alias, fifo, root} {
		t.Run(path, func(t *testing.T) {
			if _, err := m.Prepare(context.Background(), "session", path); err == nil {
				t.Fatal("不安全路径可下载")
			}
		})
	}
}

func TestDownloadLimitsCancellationAndExpiry(t *testing.T) {
	m := testTransferManager(t)
	root := t.TempDir()
	writeDownloadFixture(t, root, "data.bin", bytes.Repeat([]byte("abcdefgh"), 512))
	m.archiveLimit = 8
	if _, err := m.Prepare(context.Background(), "session", root); err == nil {
		t.Fatal("单归档上限未生效")
	}
	m.archiveLimit = maxDownloadArchiveBytes
	m.totalLimit = 8
	if _, err := m.Prepare(context.Background(), "session", root); err == nil {
		t.Fatal("总暂存上限未生效")
	}
	m.totalLimit = maxDownloadTotalBytes
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := m.Prepare(ctx, "session", root); err == nil {
		t.Fatal("取消后仍生成归档")
	}
	result, err := m.Prepare(context.Background(), "session", filepath.Join(root, "data.bin"))
	if err != nil {
		t.Fatal(err)
	}
	d := m.ready[result.ID]
	m.mu.Lock()
	d.expires = time.Now().Add(-time.Second)
	m.mu.Unlock()
	m.expire()
	if _, err := d.file.Stat(); err == nil {
		t.Fatal("到期文件句柄未关闭")
	}
	if _, err := m.claim(result.ID, "session"); err == nil {
		t.Fatal("过期链接可领取")
	}
}

func TestDownloadCloseAndCapacity(t *testing.T) {
	m := testTransferManager(t)
	path := writeDownloadFixture(t, t.TempDir(), "a", []byte("a"))
	for i := 0; i < 8; i++ {
		if _, err := m.Prepare(context.Background(), "s", path); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := m.Prepare(context.Background(), "s", path); err == nil {
		t.Fatal("待领取容量未生效")
	}
	release1, _ := m.acquireTransfer()
	defer release1()
	release2, _ := m.acquireTransfer()
	defer release2()
	if _, err := m.acquireTransfer(); err == nil {
		t.Fatal("传输并发上限未生效")
	}
	var d *preparedDownload
	for _, value := range m.ready {
		d = value
		break
	}
	if err := m.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := d.file.Stat(); err == nil {
		t.Fatal("关闭未释放句柄")
	}
	if _, err := m.Prepare(context.Background(), "s", path); err == nil {
		t.Fatal("关闭后仍可准备下载")
	}
}

func TestDownloadHTTPHeadersAndErrors(t *testing.T) {
	m := testTransferManager(t)
	path := writeDownloadFixture(t, t.TempDir(), "中 文+%\".gz", []byte{0, 255, 3})
	router := NewRouter(Deps{Available: true, service: &recordingService{}, Transfers: m})
	request := func(method, url, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "http://localhost"+url, strings.NewReader(body))
		r.Header.Set("Cookie", "elysian_session=test-session")
		r.Header.Set("Origin", "http://localhost")
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w
	}
	body, _ := json.Marshal(map[string]string{"path": path})
	w := request("POST", "/downloads", string(body))
	if w.Code != 200 {
		t.Fatalf("prepare: %d %s", w.Code, w.Body.String())
	}
	var result downloadResult
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	w = request("GET", "/downloads/"+result.ID, "")
	media, params, err := mime.ParseMediaType(w.Header().Get("Content-Disposition"))
	if err != nil || media != "attachment" || params["filename"] != filepath.Base(path) || w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("Content-Length") != "3" || !bytes.Equal(w.Body.Bytes(), []byte{0, 255, 3}) {
		t.Fatalf("download response: %v %s %v", w.Header(), w.Body.Bytes(), err)
	}
	w = request(http.MethodGet, "/downloads/"+result.ID, "")
	if w.Code != 404 || w.Header().Get("Content-Disposition") != "" {
		t.Fatalf("错误响应不能触发附件：%d %v", w.Code, w.Header())
	}
}

func TestDownloadPreparationChangeHasNoAttachment(t *testing.T) {
	m := testTransferManager(t)
	path := writeDownloadFixture(t, t.TempDir(), "file", []byte("before"))
	result, err := m.Prepare(context.Background(), "s", path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("changed content"), 0644); err != nil {
		t.Fatal(err)
	}
	router := NewRouter(Deps{Available: true, service: &recordingService{}, Transfers: m})
	r := httptest.NewRequest(http.MethodGet, "/downloads/"+result.ID, nil)
	r.Header.Set("Cookie", "elysian_session=s")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, r)
	if w.Code != 409 || w.Header().Get("Content-Disposition") != "" {
		t.Fatalf("修改后的文件不应作为成功附件：%d %v", w.Code, w.Header())
	}
}

func TestDownloadStartupCleanupAndUnsafeTempDirectory(t *testing.T) {
	root := filepath.Join(t.TempDir(), "downloads")
	if err := os.Mkdir(root, 0777); err != nil {
		t.Fatal(err)
	}
	writeDownloadFixture(t, root, "download-stale.tar.gz", []byte("stale"))
	writeDownloadFixture(t, root, "keep", []byte("keep"))
	m := NewTransferManager(root, nil)
	defer m.Close(context.Background())
	info, err := os.Stat(root)
	if err != nil || info.Mode().Perm() != 0700 {
		t.Fatalf("临时目录权限错误: %v %v", info, err)
	}
	entries, _ := os.ReadDir(root)
	if len(entries) != 1 || entries[0].Name() != "keep" {
		t.Fatalf("启动清理错误: %v", entries)
	}
	alias := filepath.Join(t.TempDir(), "alias")
	if err := os.Symlink(root, alias); err != nil {
		t.Fatal(err)
	}
	unsafe := NewTransferManager(alias, nil)
	defer unsafe.Close(context.Background())
	if unsafe.initErr == nil {
		t.Fatal("临时目录符号链接被接受")
	}
}

type failedDownloadWriter struct{ *httptest.ResponseRecorder }

func (w failedDownloadWriter) Write([]byte) (int, error) { return 0, errors.New("connection closed") }

func TestDownloadInterruptedResponseReleasesArchive(t *testing.T) {
	m := testTransferManager(t)
	root := t.TempDir()
	writeDownloadFixture(t, root, "file", []byte("data"))
	result, err := m.Prepare(context.Background(), "s", root)
	if err != nil {
		t.Fatal(err)
	}
	d := m.ready[result.ID]
	router := NewRouter(Deps{Available: true, service: &recordingService{}, Transfers: m})
	r := httptest.NewRequest(http.MethodGet, "/downloads/"+result.ID, nil)
	r.Header.Set("Cookie", "elysian_session=s")
	defer func() {
		if value := recover(); value != http.ErrAbortHandler {
			t.Errorf("下载失败未中断：%v", value)
		}
		if _, err := d.file.Stat(); err == nil {
			t.Error("下载失败后未关闭临时文件")
		}
		if m.archiveBytes != 0 {
			t.Error("下载失败后未释放归档配额")
		}
	}()
	router.ServeHTTP(failedDownloadWriter{httptest.NewRecorder()}, r)
}

type blockedUploadBody struct {
	started chan struct{}
	done    chan struct{}
	once    sync.Once
}

func (b *blockedUploadBody) Read([]byte) (int, error) {
	b.once.Do(func() { close(b.started) })
	<-b.done
	return 0, errors.New("closed")
}
func (b *blockedUploadBody) Close() error {
	select {
	case <-b.done:
	default:
		close(b.done)
	}
	return nil
}

func TestTransferCloseCancelsBlockedUpload(t *testing.T) {
	m := testTransferManager(t)
	root := t.TempDir()
	checked, err := m.uploads.Check(context.Background(), "s", root, "new-file", 1)
	if err != nil {
		t.Fatal(err)
	}
	body := &blockedUploadBody{started: make(chan struct{}), done: make(chan struct{})}
	router := NewRouter(Deps{Available: true, service: &recordingService{}, Transfers: m})
	r := httptest.NewRequest(http.MethodPut, "http://localhost/upload?dirPath="+root+"&name=new-file", body)
	r.ContentLength = 1
	r.Header.Set("Cookie", "elysian_session=s")
	r.Header.Set("Origin", "http://localhost")
	r.Header.Set("Content-Type", "application/octet-stream")
	r.Header.Set("X-Elysian-Upload-Token", checked.Token)
	done := make(chan struct{})
	go func() { defer close(done); router.ServeHTTP(httptest.NewRecorder(), r) }()
	select {
	case <-body.started:
	case <-time.After(time.Second):
		t.Fatal("上传没有开始")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := m.Close(ctx); err != nil {
		t.Fatalf("取消未解除上传阻塞：%v", err)
	}
	<-done
	if _, err := os.Stat(filepath.Join(root, "new-file")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("取消上传仍发布目标")
	}
	entries, _ := os.ReadDir(root)
	if len(entries) != 0 {
		t.Fatalf("取消上传未清理暂存：%v", entries)
	}
}

type changingArchiveWriter struct {
	bytes.Buffer
	change func()
	once   sync.Once
}

func (w *changingArchiveWriter) Write(p []byte) (int, error) {
	w.once.Do(w.change)
	return w.Buffer.Write(p)
}

func TestDownloadArchiveRejectsFileGrowth(t *testing.T) {
	path := writeDownloadFixture(t, t.TempDir(), "file", []byte("before"))
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	w := &changingArchiveWriter{change: func() {
		if err := os.WriteFile(path, []byte("after and larger"), 0644); err != nil {
			t.Fatal(err)
		}
	}}
	err = writeDownloadMember(context.Background(), tar.NewWriter(w), f, "file", path, 0, new(int), false)
	if err == nil || !strings.Contains(err.Error(), "发生变化") {
		t.Fatalf("打包时增长的文件应拒绝：%v", err)
	}
}

func TestDownloadLargeStreaming(t *testing.T) {
	if os.Getenv("ELYSIAN_FILES_LARGE_DOWNLOAD_TEST") != "1" {
		t.Skip("设置 ELYSIAN_FILES_LARGE_DOWNLOAD_TEST=1 执行 3 GiB HTTP 流式下载验收")
	}
	const size = int64(3 << 30)
	m := testTransferManager(t)
	path := filepath.Join(t.TempDir(), "large.bin")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	if err = f.Truncate(size); err != nil {
		f.Close()
		t.Fatal(err)
	}
	f.Close()
	result, err := m.Prepare(context.Background(), "s", path)
	if err != nil {
		t.Fatal(err)
	}
	router := NewRouter(Deps{Available: true, service: &recordingService{}, Transfers: m})
	server := httptest.NewServer(router)
	defer server.Close()
	request, err := http.NewRequest(http.MethodGet, server.URL+"/downloads/"+result.ID, nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Cookie", "elysian_session=s")
	runtime.GC()
	var before runtime.MemStats
	runtime.ReadMemStats(&before)
	started := time.Now()
	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || response.ContentLength != size {
		t.Fatalf("下载响应错误：%d %d", response.StatusCode, response.ContentLength)
	}
	buffer := make([]byte, 64*1024)
	var received int64
	peak := before.Alloc
	for {
		n, err := response.Body.Read(buffer)
		received += int64(n)
		if received%(64<<20) < int64(len(buffer)) {
			var state runtime.MemStats
			runtime.ReadMemStats(&state)
			if state.Alloc > peak {
				peak = state.Alloc
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	if received != size {
		t.Fatalf("只下载了 %d 字节", received)
	}
	if peak-before.Alloc > 32<<20 {
		t.Fatalf("下载堆增长过大：%d", peak-before.Alloc)
	}
	t.Logf("3 GiB HTTP 下载完成；耗时=%s，采样堆内存峰值增长=%d 字节", time.Since(started).Round(time.Millisecond), peak-before.Alloc)
}
