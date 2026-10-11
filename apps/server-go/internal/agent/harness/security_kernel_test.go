package harness

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
)

// panicMarker 模拟 panic 值里携带的内部细节（绝对路径与 SQL 状态），用于断言不回显。
const panicMarker = "/var/lib/secret/harness.sqlite"

// panickingRuntimeStub 在读取单个运行时按注入值 panic，模拟 handler 缺陷崩溃。
type panickingRuntimeStub struct {
	routeRuntimeStub
	panicValue any
}

func (s *panickingRuntimeStub) Get(_ context.Context, _ string) (Run, error) {
	panic(s.panicValue)
}

// TestRuntimeRoutesPanicResponseSanitized 断言 /api/agent 处理链的 panic 兜底不把
// panic 原文回显给客户端：writeRuntimeError 对未知错误的固定文案净化不被 panic
// 路径旁路。
func TestRuntimeRoutesPanicResponseSanitized(t *testing.T) {
	cases := []struct {
		name       string
		panicValue any
	}{
		{name: "error 值 panic", panicValue: errors.New("打开 " + panicMarker + " 失败：SQLSTATE=42S02")},
		{name: "字符串 panic", panicValue: "runtime error: index out of range at " + panicMarker},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			handler := newRuntimeRouter(&panickingRuntimeStub{panicValue: tc.panicValue}, "")
			response := runtimeRouteRequest(handler, http.MethodGet, "/runs/run-1", "")
			if response.Code != http.StatusInternalServerError {
				t.Fatalf("状态码 = %d，期望 500；响应体 %s", response.Code, response.Body.String())
			}
			body := response.Body.String()
			if !strings.Contains(body, "任务运行服务发生错误") || !strings.Contains(body, `"code":"internal"`) {
				t.Fatalf("panic 兜底未回运行时固定文案：%s", body)
			}
			if strings.Contains(body, panicMarker) || strings.Contains(body, "SQLSTATE") {
				t.Fatalf("panic 原文泄漏进响应体：%s", body)
			}
		})
	}
}
