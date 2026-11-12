package docker

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestExecSessionShortReadsPreserveRemainder(t *testing.T) {
	raw := []byte("\x1b[31m中文🙂\x1b[0m\r\n")
	s := &execSession{queue: newBoundedChunkQueue(1024)}
	_ = s.queue.push(raw[:7])
	_ = s.queue.push(raw[7:])
	s.queue.end()
	var output bytes.Buffer
	buf := make([]byte, 2)
	for {
		n, err := s.Read(buf)
		output.Write(buf[:n])
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	if !bytes.Equal(output.Bytes(), raw) {
		t.Fatalf("短读丢失原始字节: %q", output.Bytes())
	}
}

func TestExecSessionPendingInputIsBoundedAndOrdered(t *testing.T) {
	s := &execSession{queue: newBoundedChunkQueue(1024)}
	pending := strings.Repeat("x", execPendingInputMaxBytes)
	if n, err := s.Write(pending); err != nil || n != len(pending) {
		t.Fatalf("pending %d %v", n, err)
	}
	if _, err := s.Write("overflow"); err == nil {
		t.Fatal("建链前输入无界")
	}
	var output bytes.Buffer
	s.attach(strings.NewReader(""), &output)
	if _, err := s.Write("tail\r"); err != nil {
		t.Fatal(err)
	}
	if output.String() != pending+"tail\r" {
		t.Fatal("attach 输入顺序丢失")
	}
	s.Close()
	if _, err := s.Write("late"); !errors.Is(err, io.ErrClosedPipe) {
		t.Fatalf("关闭后写未失败: %v", err)
	}
}

type failingExecWriter struct{}

func (failingExecWriter) Write([]byte) (int, error) { return 0, errors.New("socket write failed") }
func TestExecSessionPropagatesInputFailure(t *testing.T) {
	s := &execSession{queue: newBoundedChunkQueue(1024), writeTarget: failingExecWriter{}}
	if _, err := s.Write("data"); err == nil || err.Error() != "socket write failed" {
		t.Fatalf("写失败被吞: %v", err)
	}
	if _, err := s.Read(make([]byte, 1)); err == nil {
		t.Fatal("写失败未通知输出消费者")
	}
}

func TestExecSession101DuplexAndPendingResize(t *testing.T) {
	resized := make(chan [2]string, 1)
	received := make(chan string, 1)
	transport := streamTransportFixture(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/exec"):
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(201)
			_, _ = io.WriteString(w, `{"Id":"raw-exec"}`)
		case strings.HasSuffix(r.URL.Path, "/resize"):
			resized <- [2]string{r.URL.Query().Get("w"), r.URL.Query().Get("h")}
			w.WriteHeader(201)
		case strings.HasSuffix(r.URL.Path, "/start"):
			_, _ = io.Copy(io.Discard, r.Body)
			conn, rw, err := w.(http.Hijacker).Hijack()
			if err != nil {
				t.Error(err)
				return
			}
			defer conn.Close()
			_, _ = rw.WriteString("HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n\x1b[31m中文")
			_ = rw.Flush()
			_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
			input := make([]byte, 4)
			_, err = io.ReadFull(rw, input)
			if err != nil {
				t.Error(err)
				return
			}
			received <- string(input)
			_, _ = rw.WriteString("\x1b[0m\r\n")
			_ = rw.Flush()
		default:
			t.Errorf("未知请求 %s", r.URL)
			w.WriteHeader(404)
		}
	})
	s := newExecSession(transport.socketPath, "container", []string{"/bin/sh", "-i"}, true, []string{"TERM=xterm-256color"})
	defer s.Close()
	if err := s.Resize(132, 44); err != nil {
		t.Fatal(err)
	}
	select {
	case size := <-resized:
		if size != [2]string{"132", "44"} {
			t.Fatalf("resize=%v", size)
		}
	case <-time.After(4 * time.Second):
		t.Fatal("未应用启动前 resize")
	}
	if _, err := s.Write("x\t\x03\r"); err != nil {
		t.Fatal(err)
	}
	select {
	case input := <-received:
		if input != "x\t\x03\r" {
			t.Fatalf("input=%q", input)
		}
	case <-time.After(4 * time.Second):
		t.Fatal("101 双向写入失败")
	}
	output, err := io.ReadAll(s)
	if err != nil {
		t.Fatal(err)
	}
	if string(output) != "\x1b[31m中文\x1b[0m\r\n" {
		t.Fatalf("原始流被改写: %q", output)
	}
}

func TestExecSessionCloseRejectsLateAttach(t *testing.T) {
	s := &execSession{queue: newBoundedChunkQueue(1024)}
	s.Close()
	var target bytes.Buffer
	s.attach(strings.NewReader("late"), &target)
	if _, err := s.Write("bad"); !errors.Is(err, io.ErrClosedPipe) {
		t.Fatalf("迟到 attach 复活会话: %v", err)
	}
}
