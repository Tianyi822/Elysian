package model

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestKnownContinuationDiagnosticIsBoundedAndSafe(t *testing.T) {
	for _, stream := range []bool{false, true} {
		for _, message := range []string{
			"The `content[].thinking` in the thinking mode must be passed back to the API. (request_id: a59c9d4a-9deb-49fd-9327-62bee81d2a8f)",
			"The `reasoning_content` in the thinking mode must be passed back to the API.",
			"unknown credential-secret",
			strings.Repeat("x", 8192) + "credential-secret",
		} {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(400)
				json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"message": message}})
			}))
			r := testRequest()
			if stream {
				r.OnContent = func(string) { t.Error("错误不应产生增量") }
			}
			_, err := NewClient(nil).Complete(context.Background(), testProfile(server.URL), r)
			server.Close()
			if err == nil || strings.Contains(err.Error(), "credential-secret") {
				t.Fatalf("错误处理失败：%v", err)
			}
			if strings.HasPrefix(message, "The `") {
				requireCode(t, err, "model-thinking-continuation-required")
			} else {
				requireCode(t, err, "model-http-failed")
			}
		}
	}
	// 未识别、截断或非 JSON 正文保持通用错误。
	for _, body := range []string{"<html>secret</html>", `{"error":{"message":"secret"}`, strings.Repeat(" ", 8192) + `{"error":{}}`} {
		err := responseError(&http.Response{StatusCode: 400, Body: io.NopCloser(strings.NewReader(body))})
		requireCode(t, err, "model-http-failed")
	}
}
