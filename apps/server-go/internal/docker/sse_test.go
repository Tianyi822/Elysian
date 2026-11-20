package docker

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/synctest"
	"time"
)

type dockerEventsWriter struct {
	*httptest.ResponseRecorder
	beforeWrite func(string)
	flushErr    error
	deadline    time.Time
}

func (w *dockerEventsWriter) WriteString(frame string) (int, error) {
	if w.beforeWrite != nil {
		w.beforeWrite(frame)
	}
	return w.ResponseRecorder.WriteString(frame)
}

func (w *dockerEventsWriter) FlushError() error { return w.flushErr }

func (w *dockerEventsWriter) SetWriteDeadline(deadline time.Time) error {
	w.deadline = deadline
	return nil
}

func quietSSEHub() *eventsHub {
	engine := newFakeEngine(func(call engineCall) (int, string, bool) {
		if call.Path == "/containers/json" {
			return 503, "", true
		}
		return 0, "", false
	})
	hub, _ := newHubWithClock(engine)
	return hub
}

func TestDockerSSESlowStreamClosesAndReconnectsFromReceivedID(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		hub := quietSSEHub()
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		blocked, release, done := make(chan struct{}), make(chan struct{}), make(chan struct{})
		w := &dockerEventsWriter{ResponseRecorder: httptest.NewRecorder(), beforeWrite: func(frame string) {
			if frame == sseStatusLive {
				close(blocked)
				<-release
			}
		}}
		go func() {
			defer close(done)
			sseHandler(hub)(w, httptest.NewRequest(http.MethodGet, "/events", nil).WithContext(ctx))
		}()
		<-blocked
		lastReceived := "boot-1.1"
		if !strings.Contains(w.Body.String(), "id: "+lastReceived+"\n") {
			close(release)
			t.Fatalf("慢写前未收到首个状态游标：%s", w.Body)
		}

		fast := &captureSubscriber{}
		unsubscribe, err := hub.Subscribe(hubHandlers{lastEventID: lastReceived, onEvent: fast.onEvent, onStatus: fast.onStatus})
		if err != nil {
			close(release)
			t.Fatal(err)
		}
		defer unsubscribe()
		const emitted = nonSampleBufferSize + 8
		for i := 0; i < emitted; i++ {
			hub.emitForTest("container/removed", containerRemovedPayload{ContainerID: "removed"})
		}
		close(release)
		synctest.Wait()
		select {
		case <-done:
		default:
			t.Fatal("积压超过重放窗口后，慢写连接仍未结束")
		}
		if strings.Contains(w.Body.String(), "event: container/removed") {
			t.Fatal("结束前仍向慢连接发送了已舍弃的待发帧")
		}
		if fast.frameCount() != emitted {
			t.Fatalf("健康订阅漏帧：%d", fast.frameCount())
		}

		resumeCtx, stopResume := context.WithTimeout(ctx, time.Second)
		defer stopResume()
		recovered := &dockerEventsWriter{ResponseRecorder: httptest.NewRecorder(), beforeWrite: func(frame string) {
			if strings.HasPrefix(frame, "event: container/resync\n") {
				stopResume()
			}
		}}
		req := httptest.NewRequest(http.MethodGet, "/events", nil).WithContext(resumeCtx)
		req.Header.Set("Last-Event-ID", lastReceived)
		sseHandler(hub)(recovered, req)
		if !strings.Contains(recovered.Body.String(), "event: container/resync\n") {
			t.Fatalf("过期游标未触发 resync：%s", recovered.Body)
		}
	})
}

func TestDockerSSEInitialReplayFitsFullWindow(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		hub := quietSSEHub()
		sample := hub.emitLocked("container/sample", containerSamplePayload{}, true)
		for i := 0; i < nonSampleBufferSize; i++ {
			hub.emitForTest("container/removed", containerRemovedPayload{ContainerID: "removed"})
		}
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		w := &dockerEventsWriter{ResponseRecorder: httptest.NewRecorder(), beforeWrite: func(frame string) {
			if frame == sseStatusLive {
				cancel()
			}
		}}
		req := httptest.NewRequest(http.MethodGet, "/events", nil).WithContext(ctx)
		req.Header.Set("Last-Event-ID", sample.id)
		sseHandler(hub)(w, req)
		body := w.Body.String()
		if !strings.HasPrefix(body, sseRetryFrame+"event: container/sample\n") ||
			strings.Count(body, "event: container/removed\n") != nonSampleBufferSize ||
			!strings.HasSuffix(body, sseStatusLive) {
			t.Fatalf("完整同步重放不应被视为慢连接：%d 条状态帧", strings.Count(body, "event: container/removed\n"))
		}
	})
}

func TestDockerSSEActiveHubResyncsWithoutCursor(t *testing.T) {
	hub := quietSSEHub()
	first, err := hub.Subscribe(hubHandlers{onEvent: func(string, string, string) {}, onStatus: func(string) {}})
	if err != nil {
		t.Fatal(err)
	}
	defer first()
	resumed := &captureSubscriber{}
	second, err := hub.Subscribe(hubHandlers{onEvent: resumed.onEvent, onStatus: resumed.onStatus})
	if err != nil {
		t.Fatal(err)
	}
	defer second()
	frames := resumed.frameSnapshot()
	if len(frames) != 1 || frames[0].event != "container/resync" {
		t.Fatalf("空游标连接未取得状态基线：%+v", frames)
	}
}

func TestDockerSSEStopsOnFlushFailure(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		hub := quietSSEHub()
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		w := &dockerEventsWriter{ResponseRecorder: httptest.NewRecorder(), flushErr: io.ErrClosedPipe}
		var duringWrite time.Time
		w.beforeWrite = func(string) { duringWrite = w.deadline }
		done := make(chan struct{})
		go func() {
			defer close(done)
			sseHandler(hub)(w, httptest.NewRequest(http.MethodGet, "/events", nil).WithContext(ctx))
		}()
		synctest.Wait()
		select {
		case <-done:
		default:
			t.Fatal("Flush 失败后仍等待事件")
		}
		if duringWrite.IsZero() || !w.deadline.IsZero() {
			t.Fatalf("单帧写出应设置并复原截止时间：写时 %s，之后 %s", duringWrite, w.deadline)
		}
	})
}
