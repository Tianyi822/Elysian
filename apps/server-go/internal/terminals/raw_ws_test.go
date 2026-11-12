package terminals

import (
	"bytes"
	"elysian/server/internal/seam"
	"encoding/json"
	"github.com/gorilla/websocket"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// The browser-facing protocol is exercised against a real Linux PTY. xterm
// rendering is tested by the web suite; this verifies unmodified transport.
func TestRawWebSocketNativeShellRoundtrip(t *testing.T) {
	home := t.TempDir()
	identity := func() seam.TerminalIdentity {
		return seam.TerminalIdentity{User: "test", HostLabel: "linux", HomeDir: home}
	}
	svc := newService(newHostDeps(), identity, seam.ShellSessionSpec{}, 5, realClock{})
	server := httptest.NewServer(newRouterWithService(Deps{}, svc))
	defer server.Close()
	headers := http.Header{"Origin": []string{server.URL}}
	client, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"/ws?protocol=2", headers)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	_, ready, err := client.ReadMessage()
	if err != nil {
		t.Fatal(err)
	}
	var frame frameReady
	if json.Unmarshal(ready, &frame) != nil || frame.Protocol != 2 {
		t.Fatalf("ready %s", ready)
	}
	var writeMu sync.Mutex
	write := func(typ int, data []byte) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		return client.WriteMessage(typ, data)
	}
	var mu sync.Mutex
	var output bytes.Buffer
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			kind, data, err := client.ReadMessage()
			if err != nil {
				return
			}
			if kind == websocket.BinaryMessage {
				mu.Lock()
				output.Write(data)
				mu.Unlock()
				ack, _ := json.Marshal(map[string]any{"type": "ack", "bytes": len(data)})
				if write(websocket.TextMessage, ack) != nil {
					return
				}
			}
		}
	}()
	if err := write(websocket.TextMessage, []byte(`{"type":"resize","cols":113,"rows":37}`)); err != nil {
		t.Fatal(err)
	}
	if err := write(websocket.BinaryMessage, []byte("printf '__WS:%s__\\n' '中文'; stty size; printf '\\033[31mCOLOR\\033[0m'\r")); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		mu.Lock()
		defer mu.Unlock()
		text := output.String()
		return strings.Contains(text, "__WS:中文__") && strings.Contains(text, "37 113") && strings.Contains(text, "\x1b[31mCOLOR\x1b[0m")
	}, "raw WS byte/resize roundtrip failed")
	if err := write(websocket.BinaryMessage, []byte("exit 0\r")); err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("websocket exit did not close")
	}
	waitFor(t, func() bool { return svc.ActiveCount() == 0 }, "raw websocket left active process")
}
