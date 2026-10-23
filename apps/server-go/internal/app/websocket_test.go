package app

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"elysian/server/internal/auth"
	"elysian/server/internal/config"
	"elysian/server/internal/middleware"
	"elysian/server/internal/seam"
	"elysian/server/internal/shared"
)

// 在完整装配链路中验证升级，避免仅测试域路由而漏掉全局响应包装器。
func TestAssemblyPreservesAuthenticatedWebSocket(t *testing.T) {
	store := auth.NewMemorySessionStore(nil)
	session, _, err := store.Create("none")
	if err != nil {
		t.Fatal(err)
	}
	factory := func(*config.Config, seam.DockerViews) (http.Handler, func(context.Context) error, error) {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !middleware.SameOriginUpgrade(r) {
				shared.SendError(w, http.StatusForbidden, "请求来源不允许")
				return
			}
			conn, err := middleware.Upgrade(w, r)
			if err != nil {
				return
			}
			defer conn.Close(1000, "")
			_, data, err := conn.ReadMessage()
			if err == nil {
				conn.SendText(string(data))
			}
		}), nil, nil
	}
	runtime, err := newAssembly(&config.Config{}, &fakeLogsService{}, auth.Deps{
		Enabled: true, Credentials: fakeCredentialsStore{}, Sessions: store,
	}, factory)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = runtime.Close(context.Background()) })

	back := httptest.NewUnstartedServer(runtime)
	front := httptest.NewUnstartedServer(runtime)
	public, private, err := shared.NewPanelGateway(runtime, front.Listener.Addr().(*net.TCPAddr).Port, back.Listener.Addr().(*net.TCPAddr).Port)
	if err != nil {
		t.Fatal(err)
	}
	back.Config.Handler, front.Config.Handler = private, public
	back.Start()
	front.Start()
	t.Cleanup(back.Close)
	t.Cleanup(front.Close)

	for _, server := range []*httptest.Server{back, front} {
		t.Run(server.URL, func(t *testing.T) {
			url := "ws" + strings.TrimPrefix(server.URL, "http") + "/api/agent/ws"
			for _, test := range []struct {
				name, origin, cookie string
				status               int
			}{
				{"未登录", server.URL, "", http.StatusUnauthorized},
				{"跨源", "http://evil.example", "elysian_session=" + session.ID, http.StatusForbidden},
				{"已登录同源", server.URL, "elysian_session=" + session.ID, http.StatusSwitchingProtocols},
			} {
				t.Run(test.name, func(t *testing.T) {
					header := http.Header{"Origin": {test.origin}, "Cookie": {test.cookie}}
					dialer := websocket.Dialer{HandshakeTimeout: 3 * time.Second}
					conn, response, err := dialer.Dial(url, header)
					if response == nil {
						t.Fatalf("没有握手响应：%v", err)
					}
					defer response.Body.Close()
					if response.StatusCode != test.status {
						body, _ := io.ReadAll(response.Body)
						t.Fatalf("握手状态 = %d，期望 %d：%s（%v）", response.StatusCode, test.status, body, err)
					}
					if test.status != http.StatusSwitchingProtocols {
						if conn != nil {
							conn.Close()
							t.Fatal("被拒绝请求不应建立连接")
						}
						return
					}
					if err != nil {
						t.Fatal(err)
					}
					defer conn.Close()
					_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
					if err := conn.WriteMessage(websocket.TextMessage, []byte("terminal-input")); err != nil {
						t.Fatal(err)
					}
					_, data, err := conn.ReadMessage()
					if err != nil || string(data) != "terminal-input" {
						t.Fatalf("双向消息传输失败：%s（%v）", data, err)
					}
				})
			}
		})
	}
}
