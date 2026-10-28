package docker

import (
	"bufio"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"elysian/server/internal/seam"
)

func TestPullStreamClientDisconnectCancelsEngine(t *testing.T) {
	engineCancelled := make(chan struct{})
	handlerDone := make(chan struct{})
	engine := newFakeEngine(func(call engineCall) (int, string, bool) {
		if call.Method == "GET" && call.Path == "/images/json" {
			return 200, "[]", true
		}
		return 0, "", false
	})
	engine.streamFn = func(ctx context.Context, call engineCall, onChunk func([]byte)) (seam.EngineResponse, error) {
		if call.Method != "POST" || call.Path != "/images/create" {
			t.Errorf("意外的 Engine 请求：%s %s", call.Method, call.Path)
		}
		onChunk([]byte("{\"status\":\"Downloading\",\"id\":\"layer\",\"progressDetail\":{\"current\":1,\"total\":10}}\n"))
		<-ctx.Done()
		close(engineCancelled)
		return seam.EngineResponse{}, ctx.Err()
	}
	service := newService(engine, nil)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		defer close(handlerDone)
		pullStreamHandler(service).ServeHTTP(w, req)
	}))
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, server.URL, strings.NewReader(`{"name":"redis","tag":"latest"}`))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	client := server.Client()
	client.Timeout = 3 * time.Second
	response, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK {
		t.Fatalf("拉取流状态：%d", response.StatusCode)
	}
	reader := bufio.NewReader(response.Body)
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(line, `"phase":"downloading"`) {
			break
		}
	}
	cancel()
	_ = response.Body.Close()
	select {
	case <-engineCancelled:
	case <-time.After(2 * time.Second):
		t.Fatal("客户端取消后 Engine 拉取未收到取消")
	}
	select {
	case <-handlerDone:
	case <-time.After(2 * time.Second):
		t.Fatal("客户端取消后拉取处理未结束")
	}
	if service.pullInFlight.Load() {
		t.Fatal("取消后仍占用全局镜像拉取槽位")
	}
}

type failingPullWriter struct{ *httptest.ResponseRecorder }

func (w failingPullWriter) Write(data []byte) (int, error) {
	if strings.Contains(string(data), `"phase":"downloading"`) {
		return 0, errors.New("客户端已无法接收数据")
	}
	return w.ResponseRecorder.Write(data)
}

func (w failingPullWriter) WriteString(data string) (int, error) { return w.Write([]byte(data)) }

func TestPullStreamWriteFailureCancelsEngine(t *testing.T) {
	engine := newFakeEngine(func(call engineCall) (int, string, bool) { return 200, "[]", true })
	engine.streamFn = func(ctx context.Context, _ engineCall, onChunk func([]byte)) (seam.EngineResponse, error) {
		onChunk([]byte("{\"status\":\"Downloading\"}\n"))
		select {
		case <-ctx.Done():
			return seam.EngineResponse{}, ctx.Err()
		case <-time.After(time.Second):
			t.Error("写出失败后仍在等待 Engine")
			return seam.EngineResponse{}, errors.New("等待取消超时")
		}
	}
	service := newService(engine, nil)
	req := httptest.NewRequest(http.MethodPost, "/images/pull/stream", strings.NewReader(`{"name":"redis","tag":"latest"}`))
	req.Header.Set("Content-Type", "application/json")
	pullStreamHandler(service).ServeHTTP(failingPullWriter{httptest.NewRecorder()}, req)
	if service.pullInFlight.Load() {
		t.Fatal("写出失败后仍占用拉取槽位")
	}
}
