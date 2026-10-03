package shared_test

import (
	"elysian/server/internal/middleware"
	"elysian/server/internal/shared"
	"fmt"
	"github.com/gorilla/websocket"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

func gatewayServers(t *testing.T, handler http.Handler) (*httptest.Server, *httptest.Server) {
	t.Helper()
	back := httptest.NewUnstartedServer(handler)
	front := httptest.NewUnstartedServer(handler)
	backPort := back.Listener.Addr().(*net.TCPAddr).Port
	frontPort := front.Listener.Addr().(*net.TCPAddr).Port
	public, private, err := shared.NewPanelGateway(handler, frontPort, backPort)
	if err != nil {
		t.Fatal(err)
	}
	back.Config.Handler = private
	front.Config.Handler = public
	back.Start()
	front.Start()
	t.Cleanup(back.Close)
	t.Cleanup(front.Close)
	return front, back
}
func TestGatewayPreservesUploadCookieAndAuthenticatedPeer(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !middleware.SameOrigin(r) {
			w.WriteHeader(403)
			return
		}
		b, _ := io.ReadAll(r.Body)
		_, _ = fmt.Fprintf(w, "%s|%s|%t|%s", b, r.Header.Get("Cookie"), shared.TrustedPanelHost(r), shared.PanelPeerAddress(r))
	})
	front, back := gatewayServers(t, handler)
	req, _ := http.NewRequest("POST", front.URL+"/api/test", strings.NewReader("upload-content"))
	req.Header.Set("Origin", front.URL)
	req.Header.Set("Cookie", "elysian_session=keep")
	req.Header.Set("X-Elysian-Gateway-Peer", "evil")
	req.Header.Set("X-Forwarded-For", "evil")
	response, err := front.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != 200 || !strings.Contains(string(b), "upload-content|elysian_session=keep|true|127.0.0.1:") {
		t.Fatalf("代理丢失请求或来源：%d %s", response.StatusCode, b)
	}
	req, _ = http.NewRequest("POST", front.URL+"/api/test", nil)
	req.Header.Set("Origin", "http://evil.example")
	response, err = front.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 403 {
		t.Fatal("跨源写请求未被阻止")
	}
	req, _ = http.NewRequest("GET", back.URL, nil)
	req.Header.Set("X-Elysian-Gateway-Token", "fake")
	response, err = back.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	b, _ = io.ReadAll(response.Body)
	response.Body.Close()
	if strings.Contains(string(b), "|true|") {
		t.Fatal("伪造内部来源被信任")
	}
}
func TestGatewayWebSocketAndSSE(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/events" {
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = io.WriteString(w, "data: ready\n\n")
			w.(http.Flusher).Flush()
			return
		}
		if !middleware.SameOriginUpgrade(r) {
			w.WriteHeader(403)
			return
		}
		c, err := (&websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer c.Close()
		_, b, err := c.ReadMessage()
		if err == nil {
			_ = c.WriteMessage(websocket.TextMessage, b)
		}
	})
	front, _ := gatewayServers(t, handler)
	response, err := front.Client().Get(front.URL + "/events")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if string(b) != "data: ready\n\n" {
		t.Fatal("SSE 帧被修改")
	}
	c, response, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(front.URL, "http")+"/ws", http.Header{"Origin": []string{front.URL}})
	if err != nil {
		t.Fatalf("WebSocket 代理失败：%v %v", response, err)
	}
	defer c.Close()
	if err = c.WriteMessage(websocket.TextMessage, []byte("terminal-input")); err != nil {
		t.Fatal(err)
	}
	_, b, err = c.ReadMessage()
	if err != nil || string(b) != "terminal-input" {
		t.Fatalf("WebSocket 流失效：%s %v", b, err)
	}
}
func TestGatewayRejectsDomainsAndWrongPorts(t *testing.T) {
	for _, host := range []string{"evil.example:48100", "127.0.0.1:48101", "127.0.0.1:48100@evil.example", "127.0.0.1:48100/path"} {
		if shared.PanelIPHost(host, 48100) {
			t.Fatal("非法 Host 被接受：" + host)
		}
	}
	for _, host := range []string{"127.0.0.1:48100", "198.51.100.20:48100", "[2001:db8::1]:48100", "localhost:" + strconv.Itoa(48100)} {
		if !shared.PanelIPHost(host, 48100) {
			t.Fatal("IP Host 被拒绝：" + host)
		}
	}
}
