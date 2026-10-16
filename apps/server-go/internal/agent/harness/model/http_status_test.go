package model

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
)

func TestHTTPFailuresPreserveSafeStatusDiagnosticsInBothPaths(t *testing.T) {
	for _, test := range []struct {
		status   int
		code     string
		guidance string
	}{
		{400, "model-http-failed", "请求参数"},
		{404, "model-http-failed", "接口或模型不存在"},
		{408, "model-http-failed", "超时"},
		{413, "model-http-failed", "过大的请求"},
		{422, "model-http-failed", "请求参数"},
		{500, "model-http-failed", "服务或其网关"},
		{503, "model-http-failed", "服务或其网关"},
		{418, "model-http-failed", "请求配置"},
		{401, "model-auth-failed", "鉴权失败"},
		{403, "model-auth-failed", "鉴权失败"},
		{429, "model-rate-limited", "限流"},
		{307, "model-redirect-refused", "跳转"},
	} {
		for _, stream := range []bool{false, true} {
			name := strconv.Itoa(test.status) + "/json"
			if stream {
				name = strconv.Itoa(test.status) + "/stream"
			}
			t.Run(name, func(t *testing.T) {
				var calls atomic.Int32
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					calls.Add(1)
					w.WriteHeader(test.status)
					io.WriteString(w, `{"error":"response-secret prompt-secret credential-secret"}`)
				}))
				defer server.Close()
				profile, request := testProfile(server.URL), testRequest()
				profile.Credential = "credential-secret"
				if stream {
					request.OnContent = func(string) { t.Error("失败响应不应输出增量") }
				}
				_, err := NewClient(nil).Complete(context.Background(), profile, request)
				requireCode(t, err, test.code)
				if calls.Load() != 1 || !strings.Contains(err.Error(), test.guidance) {
					t.Fatalf("请求重试或排查提示丢失：%v", err)
				}
				if test.code == "model-http-failed" && !strings.Contains(err.Error(), "HTTP "+strconv.Itoa(test.status)) {
					t.Fatalf("上游 HTTP 状态丢失：%v", err)
				}
				encoded, marshalErr := json.Marshal(err)
				if marshalErr != nil || strings.Contains(err.Error(), "secret") || strings.Contains(string(encoded), "secret") || strings.Contains(string(encoded), server.URL) {
					t.Fatal("错误泄露上游正文、凭据或服务地址")
				}
			})
		}
	}
}
