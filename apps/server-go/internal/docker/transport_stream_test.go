package docker

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	"elysian/server/internal/seam"
)

func streamTransportFixture(t *testing.T, handler http.HandlerFunc) *unixTransport {
	t.Helper()
	socket := filepath.Join(t.TempDir(), "engine.sock")
	l, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: handler}
	go func() { _ = server.Serve(l) }()
	t.Cleanup(func() { _ = server.Close() })
	return newUnixTransport(socket)
}
func TestArchiveTransportStreamsWithoutAggregation(t *testing.T) {
	payload := bytes.Repeat([]byte("file-data"), 1<<20)
	transport := streamTransportFixture(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "PUT" {
			if r.Header.Get("Content-Type") != "application/x-tar" {
				t.Error("文件媒体类型丢失")
			}
			n, e := io.Copy(io.Discard, r.Body)
			if e != nil || n != int64(len(payload)) {
				t.Errorf("输入流失败：%d %v", n, e)
			}
			w.WriteHeader(200)
			return
		}
		_, _ = w.Write(payload)
	})
	ctx := context.Background()
	r, e := transport.Request(ctx, seam.EngineRequest{Method: "PUT", Path: "/containers/test/archive", BodyReader: bytes.NewReader(payload), ContentType: "application/x-tar"})
	if e != nil || r.Status != 200 {
		t.Fatal(e)
	}
	var sink bytes.Buffer
	r, e = transport.Stream(ctx, seam.EngineRequest{Method: "GET", Path: "/containers/test/archive", ResponseWriter: &sink, MaxBytes: int64(len(payload))}, nil)
	if e != nil {
		t.Fatal(e)
	}
	if len(r.Body) != 0 || !bytes.Equal(sink.Bytes(), payload) {
		t.Fatal("输出流应只写接收器，不聚合响应")
	}
	r, e = transport.Stream(ctx, seam.EngineRequest{Method: "GET", Path: "/images/create", DiscardBody: true, MaxBytes: int64(len(payload))}, nil)
	if e != nil || len(r.Body) != 0 {
		t.Fatal("进度流不能聚合")
	}
}

type brokenSink struct{}

func (brokenSink) Write([]byte) (int, error) { return 0, errors.New("磁盘不可写") }
func TestStreamingStopsOnLimitAndSinkFailure(t *testing.T) {
	transport := streamTransportFixture(t, func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, strings.Repeat("a", 1024)) })
	if _, e := transport.Stream(context.Background(), seam.EngineRequest{Method: "GET", Path: "/archive", MaxBytes: 512, ResponseWriter: io.Discard}, nil); e == nil {
		t.Fatal("未限制输出流大小")
	}
	if _, e := transport.Stream(context.Background(), seam.EngineRequest{Method: "GET", Path: "/archive", MaxBytes: 2048, ResponseWriter: brokenSink{}}, nil); e == nil || e.Error() != "磁盘不可写" {
		t.Fatal("未传播接收器失败")
	}
	if _, e := transport.Request(context.Background(), seam.EngineRequest{Method: "PUT", Path: "/archive", Body: []byte("{}"), BodyReader: strings.NewReader("file")}); e == nil {
		t.Fatal("JSON 与文件流必须互斥")
	}
}
