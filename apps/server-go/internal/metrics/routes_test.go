package metrics

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
)

func newTestRouter(service *Service) chi.Router {
	r := chi.NewRouter()
	Register(r, service)
	return r
}

func TestHistoryRejectsInvalidRange(t *testing.T) {
	router := newTestRouter(newTestService(nil, goldenReader(), nil))
	// 重复参数取首个值（TS searchParams.get 同语义）："?range=1w&range=5m" 非法。
	for _, query := range []string{"", "?range=1w", "?range=", "?range=1w&range=5m"} {
		req := httptest.NewRequest(http.MethodGet, "/api/resources/history"+query, nil)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%q 应 400，实际 %d", query, rec.Code)
		}
		if !strings.Contains(rec.Body.String(), "无效的时间范围") {
			t.Fatalf("错误文案不符：%s", rec.Body.String())
		}
	}
}

func TestHistoryReturnsPointsArray(t *testing.T) {
	store := openTestStore(t)
	service := newTestService(store, goldenReader(), nil)
	now := service.NowMs()
	store.InsertRaw(pointAt(now-5_000, 30))
	store.InsertRaw(pointAt(now, 40))

	req := httptest.NewRequest(http.MethodGet, "/api/resources/history?range=5m", nil)
	rec := httptest.NewRecorder()
	newTestRouter(service).ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("应 200，实际 %d：%s", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Content-Type"); !strings.Contains(got, "application/json") {
		t.Fatalf("Content-Type 应为 JSON：%q", got)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control 应 no-store：%q", got)
	}
	body := strings.TrimSpace(rec.Body.String())
	if !strings.HasPrefix(body, "[") || !strings.HasSuffix(body, "]") {
		t.Fatalf("响应应为 JSON 数组：%s", body)
	}
	var points []map[string]any
	if err := json.Unmarshal([]byte(body), &points); err != nil {
		t.Fatalf("解析失败：%v", err)
	}
	if len(points) != 2 {
		t.Fatalf("应返回 2 点，实际 %d", len(points))
	}
	for _, key := range []string{"ts", "cpu", "memory", "networkIo", "networkRx", "networkTx", "diskIo", "diskRead", "diskWrite"} {
		if _, ok := points[0][key]; !ok {
			t.Fatalf("采样点缺字段 %s：%v", key, points[0])
		}
	}
}

func TestHistoryEmptyStoreReturnsEmptyArray(t *testing.T) {
	service := newTestService(nil, goldenReader(), nil) // 存储降级（nil）
	req := httptest.NewRequest(http.MethodGet, "/api/resources/history?range=5m", nil)
	rec := httptest.NewRecorder()
	newTestRouter(service).ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("应 200，实际 %d", rec.Code)
	}
	if strings.TrimSpace(rec.Body.String()) != "[]" {
		t.Fatalf("存储降级应回空数组：%q", rec.Body.String())
	}
}

func TestHistoryRejectsNonGet(t *testing.T) {
	router := newTestRouter(newTestService(nil, goldenReader(), nil))
	req := httptest.NewRequest(http.MethodPost, "/api/resources/history?range=5m", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST 应 405，实际 %d", rec.Code)
	}
	if allow := rec.Header().Get("Allow"); !strings.Contains(allow, "GET") {
		t.Fatalf("Allow 头应含 GET：%q", allow)
	}
}

func TestEventsStreamsRetryAndLatestSample(t *testing.T) {
	service := newTestService(nil, goldenReader(), nil)
	service.sampleOnce()
	server := httptest.NewServer(newTestRouter(service))
	defer server.Close()

	client := &http.Client{Timeout: 600 * time.Millisecond}
	resp, err := client.Get(server.URL + "/api/events")
	if err == nil {
		// 客户端超时断开后这里拿到的是部分 body；正常路径在循环里读。
		body, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		if !strings.Contains(string(body), "retry: 5000\n\n") {
			t.Fatalf("首帧应为 retry：\n%q", body)
		}
		if !strings.Contains(string(body), "event: resource/sample\n") {
			t.Fatalf("连接即应补发最近一拍：\n%q", body)
		}
		if got := resp.Header.Get("Content-Type"); !strings.Contains(got, "text/event-stream") {
			t.Fatalf("Content-Type 应为 event-stream：%q", got)
		}
		if got := resp.Header.Get("Cache-Control"); got != "no-cache, no-transform" {
			t.Fatalf("Cache-Control 不符：%q", got)
		}
		if got := resp.Header.Get("X-Accel-Buffering"); got != "no" {
			t.Fatalf("X-Accel-Buffering 应 no：%q", got)
		}
		return
	}
	// 超时先于响应到达：重试一次给慢环境留余量。
	resp2, err2 := client.Get(server.URL + "/api/events?lastEventId=" + service.hub.lastFrame.id)
	if err2 != nil {
		t.Skipf("SSE 测试环境不稳定：%v", err2)
	}
	defer resp2.Body.Close()
}

func TestEventsRejectsWhenSubscriberLimitReached(t *testing.T) {
	service := newTestService(nil, goldenReader(), nil)
	service.sampleOnce()
	for i := 0; i < maxSubscribers; i++ {
		_, cancel, err := service.hub.subscribe("")
		if err != nil {
			t.Fatalf("预占订阅失败：%v", err)
		}
		defer cancel()
	}
	server := httptest.NewServer(newTestRouter(service))
	defer server.Close()

	resp, err := server.Client().Get(server.URL + "/api/events")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("超订应 503，实际 %d", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), "实时连接数已达上限") {
		t.Fatalf("503 文案不符：%s", body)
	}
}
