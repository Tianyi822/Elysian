package websites

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"syscall"
	"testing"

	"elysian/server/internal/seam"
)

// Caddy admin 客户端（websitesCaddy.test.ts 9 例的 Go 对等）：注入 requestFunc 的
// socket 客户端测试，不起真实 socket，断言请求形状与错误映射。

// capturingCaddy 注入 requestFunc 的通道客户端：记录请求并回放处理器结果。
type capturingCaddy struct {
	calls   []*http.Request
	bodies  []string
	handler func(req *http.Request) (*http.Response, error)
}

func (c *capturingCaddy) client() *caddyClient {
	return &caddyClient{
		socketPath: "/run/caddy/admin.sock",
		requestFunc: func(req *http.Request) (*http.Response, error) {
			body := ""
			if req.Body != nil {
				data, _ := io.ReadAll(req.Body)
				body = string(data)
			}
			c.calls = append(c.calls, req)
			c.bodies = append(c.bodies, body)
			return c.handler(req)
		},
	}
}

func jsonResponse(status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Body:       io.NopCloser(bytes.NewReader([]byte(body))),
		Header:     http.Header{},
	}
}

func connectionErrorOf(code syscall.Errno) error {
	return &net.OpError{Op: "dial", Err: code}
}

func TestCaddyAdminListen(t *testing.T) {
	if CaddyDefaultSocketPath != "/run/caddy/admin.sock" {
		t.Fatalf("缺省 socket 路径应为 /run/caddy/admin.sock")
	}
	if CaddyAdminListen("/run/caddy/admin.sock") != "unix//run/caddy/admin.sock" {
		t.Fatalf("admin listen 应为 unix/<socket 路径>")
	}
	if CaddyAdminListen("/tmp/other.sock") != "unix//tmp/other.sock" {
		t.Fatalf("覆盖路径应同步进 admin listen")
	}
}

func TestCaddyLoadRequestShape(t *testing.T) {
	capture := &capturingCaddy{handler: func(*http.Request) (*http.Response, error) {
		return jsonResponse(200, ""), nil
	}}
	config := BuildCaddyConfig(nil, testAdminListen)
	if err := capture.client().Load(context.Background(), config); err != nil {
		t.Fatalf("load 应成功：%v", err)
	}
	if len(capture.calls) != 1 {
		t.Fatalf("应恰好一次请求")
	}
	request := capture.calls[0]
	if request.Method != http.MethodPost || request.URL.Path != "/load" {
		t.Fatalf("load 应为 POST /load，得到 %s %s", request.Method, request.URL.Path)
	}
	if request.Header.Get("Content-Type") != "application/json" {
		t.Fatalf("load 应带 application/json")
	}
	if capture.bodies[0] != string(config) {
		t.Fatalf("load 请求体应为整配置")
	}
}

func TestCaddyLoadHidesEngineBody(t *testing.T) {
	for _, item := range []struct {
		status int
		body   string
	}{
		{400, `{"message":"invalid config"}`},
		{500, ``},
	} {
		capture := &capturingCaddy{handler: func(*http.Request) (*http.Response, error) {
			return jsonResponse(item.status, item.body), nil
		}}
		err := capture.client().Load(context.Background(), BuildCaddyConfig(nil, testAdminListen))
		if err == nil {
			t.Fatalf("非 2xx 应报错")
		}
		want := fmt.Sprintf("Caddy 拒绝路由或证书配置（HTTP %d）", item.status)
		if err.Error() != want {
			t.Fatalf("非 2xx 应隐去原始响应，得到 %q", err.Error())
		}
		if err.Unavailable {
			t.Fatalf("引擎侧拒绝不应归类 unavailable")
		}
	}
}

func TestCaddyCurrentConfigShape(t *testing.T) {
	capture := &capturingCaddy{handler: func(*http.Request) (*http.Response, error) {
		return jsonResponse(200, `{"apps":{}}`), nil
	}}
	config, err := capture.client().CurrentConfig(context.Background())
	if err != nil {
		t.Fatalf("currentConfig 应成功：%v", err)
	}
	if string(config) != `{"apps":{}}` {
		t.Fatalf("应返回完整配置对象，得到 %s", string(config))
	}
	request := capture.calls[0]
	if request.Method != http.MethodGet || request.URL.Path != "/config/" {
		t.Fatalf("currentConfig 应为 GET /config/，得到 %s %s", request.Method, request.URL.Path)
	}
}

func TestCaddyConnectionErrorsAreUnavailable(t *testing.T) {
	for _, code := range []syscall.Errno{syscall.ENOENT, syscall.EACCES, syscall.ECONNREFUSED} {
		capture := &capturingCaddy{handler: func(*http.Request) (*http.Response, error) {
			return nil, connectionErrorOf(code)
		}}
		_, err := capture.client().CurrentConfig(context.Background())
		if err == nil {
			t.Fatalf("连接类错误应报错")
		}
		if !err.Unavailable {
			t.Fatalf("errno %v 应整体归类 unavailable", code)
		}
		if err.Message != seam.CaddyChannelUnavailableDetail {
			t.Fatalf("连接类失败应给固定中文说明，得到 %q", err.Message)
		}
	}
}

func TestCaddyTimeoutNotUnavailable(t *testing.T) {
	capture := &capturingCaddy{handler: func(*http.Request) (*http.Response, error) {
		return nil, &timeoutError{}
	}}
	_, err := capture.client().CurrentConfig(context.Background())
	if err == nil {
		t.Fatalf("超时应报错")
	}
	if err.Unavailable {
		t.Fatalf("超时不应归类 unavailable")
	}
	if err.Message != "Caddy 请求超时" {
		t.Fatalf("超时应保留固定消息，得到 %q", err.Message)
	}
}

// timeoutError 满足 net.Error 的超时错误。
type timeoutError struct{}

func (e *timeoutError) Error() string   { return "连接超时" }
func (e *timeoutError) Timeout() bool   { return true }
func (e *timeoutError) Temporary() bool { return false }

// net.Error 接口匹配由编译期断言兜底。
var _ net.Error = (*timeoutError)(nil)

func TestCaddyEngineMessageOnCurrentConfig(t *testing.T) {
	capture := &capturingCaddy{handler: func(*http.Request) (*http.Response, error) {
		return jsonResponse(500, `{"message":"boom"}`), nil
	}}
	_, err := capture.client().CurrentConfig(context.Background())
	if err == nil || err.Message != "boom" {
		t.Fatalf("非 200 应带引擎消息，得到 %v", err)
	}
}

func TestCaddyChannelStatusMapping(t *testing.T) {
	status := caddyChannelStatus(&seam.CaddyChannelError{Unavailable: true, Message: "connect ENOENT"})
	if status.State != ProxyStateUnavailable || status.Detail == nil || *status.Detail != "宿主未提供 Caddy 管理通道" {
		t.Fatalf("连接类失败应给固定中文 detail，得到 %+v", status)
	}
	status = caddyChannelStatus(&seam.CaddyChannelError{Unavailable: false, Message: "boom"})
	if status.State != ProxyStateUnavailable || status.Detail == nil || *status.Detail != "boom" {
		t.Fatalf("引擎侧失败应映射 unavailable + 引擎消息，得到 %+v", status)
	}
	status = caddyChannelStatus(errors.New("意外"))
	if status.State != ProxyStateUnavailable || status.Detail == nil || *status.Detail != "意外" {
		t.Fatalf("非通道错误应兜底映射 unavailable + 原始消息，得到 %+v", status)
	}
}

func TestCaddyBadJSONResponse(t *testing.T) {
	capture := &capturingCaddy{handler: func(*http.Request) (*http.Response, error) {
		return jsonResponse(200, "不是 JSON"), nil
	}}
	_, err := capture.client().CurrentConfig(context.Background())
	if err == nil || !strings.Contains(err.Error(), "Caddy 响应不是有效 JSON") {
		t.Fatalf("坏 JSON 应报「Caddy 响应不是有效 JSON」，得到 %v", err)
	}
}
