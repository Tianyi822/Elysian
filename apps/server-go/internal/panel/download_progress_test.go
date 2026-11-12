package panel

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDownloadProgressThrottlesAndPreservesFinalBytes(t *testing.T) {
	var values []DownloadProgress
	p := releaseProgressWriter{writer: io.Discard, value: DownloadProgress{TotalBytes: 10}, started: time.Now(), report: func(value DownloadProgress) error {
		values = append(values, value)
		return nil
	}}
	if err := p.publish("downloading", true); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 5; i++ {
		if _, err := p.Write([]byte("a")); err != nil {
			t.Fatal(err)
		}
	}
	if len(values) != 1 {
		t.Fatal("进度写入未限流")
	}
	p.last = time.Now().Add(-2 * time.Second)
	if _, err := p.Write([]byte("b")); err != nil {
		t.Fatal(err)
	}
	if len(values) != 2 || values[1].CompletedBytes != 6 {
		t.Fatal("限流后未上报累计真实字节")
	}
	if _, err := p.Write([]byte("cccc")); err != nil {
		t.Fatal(err)
	}
	if err := p.publish("verifying", true); err != nil {
		t.Fatal(err)
	}
	if values[len(values)-1].CompletedBytes != 10 || values[len(values)-1].BytesPerSecond != 0 {
		t.Fatal("最终字节或校验阶段速率错误")
	}
	p.report = func(DownloadProgress) error { return errors.New("fixture persistence failure") }
	if err := p.publish("ready", true); err == nil {
		t.Fatal("进度保存失败被忽略")
	}
}

func TestReleaseDownloadTimeoutReportsActualBytes(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "100")
		w.Write([]byte("part"))
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	var last DownloadProgress
	ctx = withDownloadProgress(ctx, func(value DownloadProgress) error { last = value; return nil })
	err := downloadRelease(ctx, server.Client(), "GitHub", releaseAsset{Name: "archive.tar.gz", URL: server.URL, Size: 100}, strings.Repeat("a", 40), filepath.Join(t.TempDir(), "download"))
	if err == nil || !strings.Contains(err.Error(), "下载超时") || !strings.Contains(err.Error(), "4 / 100 字节") || strings.Contains(err.Error(), "SHA256") {
		t.Fatalf("超时被误报为摘要损坏：%v", err)
	}
	if last.CompletedBytes != 4 || last.Status == "ready" {
		t.Fatalf("失败丢失字节或被误报为就绪：%+v", last)
	}
}

func TestReleaseDownloadFailuresRemainDistinct(t *testing.T) {
	for _, item := range []struct {
		cause   error
		message string
	}{
		{errReleaseDownloadIdle, "连续 2 分钟未收到数据"},
		{context.Canceled, "已中止"},
		{io.ErrUnexpectedEOF, "下载中断"},
	} {
		err := releaseDownloadError("Gitee", item.cause, 12, 100)
		if !strings.Contains(err.Error(), item.message) || !strings.Contains(err.Error(), "12 / 100 字节") || strings.Contains(err.Error(), "SHA256") {
			t.Fatal(err)
		}
	}
	// 真实字节会重置空闲期限；空读取不能伪造进展。
	expired := make(chan struct{}, 1)
	timer := time.AfterFunc(20*time.Millisecond, func() { expired <- struct{}{} })
	defer timer.Stop()
	reader := downloadActivityReader{Reader: strings.NewReader("data"), timer: timer}
	if _, err := reader.Read(make([]byte, 4)); err != nil {
		t.Fatal(err)
	}
	select {
	case <-expired:
		t.Fatal("收到数据未延长空闲期限")
	case <-time.After(40 * time.Millisecond):
	}
	if !timer.Stop() {
		t.Fatal("收到数据后空闲计时器已失效")
	}
}

type progressTestSource struct {
	Source
	store Store
	id    string
}

func (s progressTestSource) Download(ctx context.Context, _, _ string) error {
	report, ok := ctx.Value(downloadProgressKey{}).(downloadReporter)
	if !ok {
		return errors.New("下载进度未绑定到任务")
	}
	value := DownloadProgress{FileName: "fixture.tar.gz", Status: "downloading", CompletedBytes: 12, TotalBytes: 100, UpdatedAt: time.Now().UTC()}
	if err := report(value); err != nil {
		return err
	}
	r, err := s.store.read(s.id)
	if err != nil {
		return err
	}
	if r.Download == nil || r.Download.CompletedBytes != 12 {
		return errors.New("下载过程未持久保存")
	}
	return errors.New("fixture interrupted")
}

func TestWorkerPersistsDownloadBeforeCompletion(t *testing.T) {
	w, r, _ := setupWorker(t, "update")
	w.Source = progressTestSource{Source: w.Source, store: w.Store, id: r.ID}
	if err := w.Run(context.Background(), r.ID); err == nil || err.Error() != "fixture interrupted" {
		t.Fatalf("%v", err)
	}
	got, err := w.Store.read(r.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.State != "failed" || got.FailedPhase != "downloading-release" || got.Download == nil || got.Download.CompletedBytes != 12 {
		t.Fatalf("失败后进度不能恢复：%+v", got)
	}
	logs, err := os.ReadFile(w.Store.logPath(r.ID))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(string(logs), "检查部署环境") != 1 || !strings.Contains(string(logs), "下载安装包") {
		t.Fatalf("阶段日志重复或名称缺失：%s", logs)
	}
}
