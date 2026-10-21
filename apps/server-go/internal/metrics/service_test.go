package metrics

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

func fixedClock(at time.Time) func() time.Time { return func() time.Time { return at } }

// newTestService 手工构造服务（不启动循环），直接驱动 sampleOnce 做确定性断言。
func newTestService(store *Store, reader hostSampleReader, warn func(string)) *Service {
	now := fixedClock(time.UnixMilli(1_700_000_000_000))
	if warn == nil {
		warn = func(string) {}
	}
	return &Service{
		store:  store,
		reader: reader,
		now:    now,
		warn:   warn,
		hub:    newSampleHub(now),
		stop:   make(chan struct{}),
		done:   make(chan struct{}),
	}
}

func goldenReader() hostSampleReader {
	files := goldenFiles()
	return hostSampleReader{readFile: fakeFiles(files), nowMs: func() int64 { return 1_700_000_000_000 }}
}

func TestSampleOncePersistsAndPublishes(t *testing.T) {
	store := openTestStore(t)
	service := newTestService(store, goldenReader(), nil)
	service.sampleOnce()

	payload := service.hub.lastFrame
	if payload == nil {
		t.Fatal("采样后 hub 应有最近一帧")
	}
	points := store.Query("5m", service.NowMs())
	if len(points) != 1 {
		t.Fatalf("采样应落库 1 点，实际 %d", len(points))
	}
	if points[0].CPU != 0 {
		t.Fatalf("首拍 CPU 应为 0：%+v", points[0])
	}
	if points[0].Memory != 50 {
		t.Fatalf("首拍内存应为 50：%+v", points[0])
	}
}

func TestSampleOnceFailureWarnsOnceAndSkipsStore(t *testing.T) {
	store := openTestStore(t)
	files := goldenFiles()
	delete(files, procStat)
	warnings := []string{}
	service := newTestService(store, hostSampleReader{readFile: fakeFiles(files), nowMs: func() int64 { return 1 }}, func(message string) {
		warnings = append(warnings, message)
	})
	service.sampleOnce()
	service.sampleOnce()
	service.sampleOnce()
	if len(warnings) != 1 {
		t.Fatalf("采样失败应只告警一次，实际 %d 次：%v", len(warnings), warnings)
	}
	if points := store.Query("7d", time.Now().UnixMilli()); len(points) != 0 {
		t.Fatal("失败拍不应落库")
	}
}

func TestHubSubscribeReplaysLatestUnlessAlreadyDelivered(t *testing.T) {
	service := newTestService(nil, goldenReader(), nil)
	frames, cancel, err := service.hub.subscribe("")
	if err != nil {
		t.Fatal(err)
	}
	select {
	case frame := <-frames:
		t.Fatalf("无采样时订阅不应有帧：%q", frame)
	default:
	}
	cancel()

	service.sampleOnce()
	lastID := service.hub.lastFrame.id

	// 新连接（无 Last-Event-ID）：立即补发最近一拍。
	fresh, cancelFresh, _ := service.hub.subscribe("")
	select {
	case frame := <-fresh:
		if !strings.Contains(frame, `"id":"`+lastID+`"`) {
			t.Fatalf("补发帧应带最近一拍 id %s：%q", lastID, frame)
		}
	default:
		t.Fatal("新连接应立即收到最近一拍")
	}
	cancelFresh()

	// 重连且 Last-Event-ID 等于最近一拍：不重发（已投递）。
	caught, cancelCaught, _ := service.hub.subscribe(lastID)
	select {
	case frame := <-caught:
		t.Fatalf("已投递事件不应重发：%q", frame)
	default:
	}
	cancelCaught()
}

func TestHubSubscriberLimit(t *testing.T) {
	service := newTestService(nil, goldenReader(), nil)
	for i := 0; i < maxSubscribers; i++ {
		_, cancel, err := service.hub.subscribe("")
		if err != nil {
			t.Fatalf("第 %d 个订阅者不应被拒：%v", i+1, err)
		}
		defer cancel()
	}
	if _, _, err := service.hub.subscribe(""); !errors.Is(err, errMaxSubscribers) {
		t.Fatalf("超订应拒绝：%v", err)
	}
}

func TestHubFrameShapeMatchesContract(t *testing.T) {
	service := newTestService(nil, goldenReader(), nil)
	service.sampleOnce()
	frame := service.hub.lastFrame.frameText()
	if !strings.HasPrefix(frame, "event: resource/sample\nid: "+service.hub.lastFrame.id+"\ndata: ") {
		t.Fatalf("帧头三行应按 event→id→data 排列：%q", frame)
	}
	if !strings.HasSuffix(frame, "\n\n") {
		t.Fatal("帧应以空行结束")
	}
	var envelope struct {
		ID      string          `json:"id"`
		Name    string          `json:"name"`
		At      string          `json:"at"`
		Payload json.RawMessage `json:"payload"`
	}
	data := strings.TrimSuffix(strings.TrimPrefix(frame, "event: resource/sample\nid: "+service.hub.lastFrame.id+"\ndata: "), "\n\n")
	if err := json.Unmarshal([]byte(data), &envelope); err != nil {
		t.Fatalf("信封 JSON 无效：%v", err)
	}
	if envelope.Name != "resource/sample" || envelope.At == "" {
		t.Fatalf("信封字段不符：%+v", envelope)
	}
	var payload map[string]any
	if err := json.Unmarshal(envelope.Payload, &payload); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"cpu", "memory", "networkIo", "networkRx", "networkTx", "diskIo", "diskRead", "diskWrite", "load"} {
		if _, ok := payload[key]; !ok {
			t.Fatalf("payload 缺字段 %s：%v", key, payload)
		}
	}
	load, ok := payload["load"].(map[string]any)
	if !ok || load["m1"] == nil || load["m5"] == nil || load["m15"] == nil {
		t.Fatalf("load 三元组不符：%v", payload["load"])
	}
}

func TestServiceCloseStopsLoopAndClosesStore(t *testing.T) {
	store := openTestStore(t)
	service := newTestService(store, goldenReader(), nil)
	service.tick = 5 * time.Millisecond
	go service.loop()
	deadline := time.After(2 * time.Second)
	for {
		if len(store.Query("5m", service.NowMs())) > 0 {
			break
		}
		select {
		case <-deadline:
			t.Fatal("未在时限内采到第一拍")
		case <-time.After(time.Millisecond):
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := service.Close(ctx); err != nil {
		t.Fatalf("Close：%v", err)
	}
	select {
	case <-service.done:
	default:
		t.Fatal("Close 后循环应已退出")
	}
}

func TestServiceLoopSamplesAndStops(t *testing.T) {
	store := openTestStore(t)
	service := newTestService(store, goldenReader(), nil)
	service.tick = 5 * time.Millisecond
	go service.loop()

	deadline := time.After(2 * time.Second)
	for {
		service.hub.mu.Lock()
		published := service.hub.lastFrame != nil
		service.hub.mu.Unlock()
		if published {
			break
		}
		select {
		case <-deadline:
			t.Fatal("循环应在时限内采出第一拍")
		case <-time.After(time.Millisecond):
		}
	}
	close(service.stop)
	select {
	case <-service.done:
	case <-time.After(time.Second):
		t.Fatal("stop 后循环应在时限内退出")
	}
	if points := store.Query("5m", service.NowMs()); len(points) == 0 {
		t.Fatal("循环采样应落库")
	}
}
