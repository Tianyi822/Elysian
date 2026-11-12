package middleware

import (
	"bytes"
	"elysian/server/internal/seam"
	"github.com/gorilla/websocket"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestBinaryWebSocketCapability(t *testing.T) {
	done := make(chan bool, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := Upgrade(w, r)
		if err != nil {
			return
		}
		defer conn.Close(1000, "")
		binary, ok := conn.(seam.BinaryWsConn)
		done <- ok && binary.SendBinary([]byte{0, 255, 27, 91, 109})
	}))
	defer server.Close()
	client, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	typ, data, err := client.ReadMessage()
	if err != nil || typ != websocket.BinaryMessage || !bytes.Equal(data, []byte{0, 255, 27, 91, 109}) || !<-done {
		t.Fatalf("binary roundtrip %d %v %v", typ, data, err)
	}
}
func TestCloseInterruptsBlockedWebSocketWriter(t *testing.T) {
	connections := make(chan seam.WsConn, 1)
	ended := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := Upgrade(w, r)
		if err != nil {
			return
		}
		connections <- conn
		conn.(seam.BinaryWsConn).SendBinary(make([]byte, 16*1024*1024))
		close(ended)
	}))
	defer server.Close()
	client, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	conn := <-connections
	// The peer intentionally never reads, filling the TCP send buffer.
	time.Sleep(50 * time.Millisecond)
	closed := make(chan struct{})
	go func() { conn.Close(1008, "revoked"); close(closed) }()
	select {
	case <-closed:
	case <-time.After(3 * time.Second):
		t.Fatal("close blocked behind a network writer")
	}
	select {
	case <-ended:
	case <-time.After(time.Second):
		t.Fatal("network writer was not interrupted")
	}
}
