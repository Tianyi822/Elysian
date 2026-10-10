package docker

import (
	"context"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"elysian/server/internal/seam"
)

// eventsHub 对等测试（dockerEventsHub.test.ts 锚点，手动时钟 + fake 传输注入）。

func newHubWithClock(engine *fakeEngine) (*eventsHub, *manualClock) {
	clock := newManualClock()
	hub := newEventsHub(eventsHubConfig{
		transport: engine,
		now:       func() time.Time { return time.UnixMilli(clock.Now()).UTC() },
		schedule: func(fn func(), ms int) func() {
			return clock.Schedule(fn, int64(ms))
		},
		bootID: "boot-1",
	})
	return hub, clock
}

func TestHubFirstSubscribeStartsStreamAndResampleStopsOnUnsubscribe(t *testing.T) {
	engine := newFakeEngine(func(engineCall) (int, string, bool) { return 200, "[]", true })
	var streamCalls atomic.Int32
	engine.streamFn = func(ctx context.Context, call engineCall, onChunk func([]byte)) (seam.EngineResponse, error) {
		streamCalls.Add(1)
		<-ctx.Done()
		return seam.EngineResponse{}, ctx.Err()
	}
	hub, _ := newHubWithClock(engine)
	subscriber := &captureSubscriber{}
	unsubscribe, err := hub.Subscribe(hubHandlers{onEvent: subscriber.onEvent, onStatus: subscriber.onStatus})
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(30 * time.Millisecond)
	if calls := streamCalls.Load(); calls != 1 {
		t.Fatalf("首订阅开流：%d", calls)
	}
	events := subscriber.snapshot()
	if len(events) < 3 || events[0] != "status:connecting" || !strings.HasPrefix(events[1], "event:container/resync:") || events[2] != "status:live" {
		t.Fatalf("connecting → resync → live 次序：%v", events)
	}
	unsubscribe()
	time.Sleep(30 * time.Millisecond)
	// 重订阅再次开流。
	if _, err := hub.Subscribe(hubHandlers{onEvent: subscriber.onEvent, onStatus: subscriber.onStatus}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(30 * time.Millisecond)
	if calls := streamCalls.Load(); calls != 2 {
		t.Fatalf("重订阅再开流：%d", calls)
	}
}

func TestHubNinthSubscriber503(t *testing.T) {
	engine := newFakeEngine(func(engineCall) (int, string, bool) { return 200, "[]", true })
	hub, _ := newHubWithClock(engine)
	unsubscribes := make([]func(), 0, 8)
	for i := 0; i < 8; i++ {
		unsubscribe, err := hub.Subscribe(hubHandlers{onEvent: func(string, string, string) {}, onStatus: func(string) {}})
		if err != nil {
			t.Fatal(err)
		}
		unsubscribes = append(unsubscribes, unsubscribe)
	}
	if _, err := hub.Subscribe(hubHandlers{onEvent: func(string, string, string) {}, onStatus: func(string) {}}); err != errMaxSubscribers {
		t.Fatalf("第 9 个订阅：%v", err)
	}
	unsubscribes[0]()
	if _, err := hub.Subscribe(hubHandlers{onEvent: func(string, string, string) {}, onStatus: func(string) {}}); err != nil {
		t.Fatalf("释放一个名额后可订阅：%v", err)
	}
}

func TestHubReconnectStatusSequenceWithBackoff(t *testing.T) {
	var streamFailures atomic.Int32
	engine := newFakeEngine(func(engineCall) (int, string, bool) { return 200, "[]", true })
	engine.streamFn = func(ctx context.Context, call engineCall, onChunk func([]byte)) (seam.EngineResponse, error) {
		if streamFailures.Add(1) <= 2 {
			return seam.EngineResponse{}, context.Canceled
		}
		<-ctx.Done()
		return seam.EngineResponse{}, ctx.Err()
	}
	hub, clock := newHubWithClock(engine)
	subscriber := &captureSubscriber{}
	if _, err := hub.Subscribe(hubHandlers{onEvent: subscriber.onEvent, onStatus: subscriber.onStatus}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(50 * time.Millisecond)
	clock.Advance(1_100)
	time.Sleep(30 * time.Millisecond)
	clock.Advance(2_100)
	time.Sleep(30 * time.Millisecond)
	events := subscriber.snapshot()
	// connecting → resync → live → connecting（退避 1s）→ resync → live → connecting（退避 2s）→ resync → live
	connecting := 0
	for _, entry := range events {
		if entry == "status:connecting" {
			connecting++
		}
	}
	if connecting < 3 {
		t.Fatalf("三次 connecting（含断线重连）：%v", events)
	}
}

func TestHubDieDebouncedUpdatedStartedAtNull(t *testing.T) {
	id := strings.Repeat("c", 64)
	engine := newFakeEngine(func(call engineCall) (int, string, bool) {
		if strings.HasSuffix(call.Path, "/json") {
			return 200, containerInspectForStatus("exited"), true
		}
		return 200, "[]", true
	})
	hub, clock := newHubWithClock(engine)
	subscriber := &captureSubscriber{}
	if _, err := hub.Subscribe(hubHandlers{onEvent: subscriber.onEvent, onStatus: subscriber.onStatus}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(30 * time.Millisecond)
	// 订阅期间的开流已发 resync + live；记录基准，再喂 die 事件。
	base := subscriber.frameCount()
	hub.onDockerLine(`{"Type":"container","Action":"die","id":"` + id + `"}`)
	clock.Advance(250)
	time.Sleep(30 * time.Millisecond)
	frames := subscriber.frameSnapshot()
	if len(frames) != base+1 || frames[len(frames)-1].event != "container/updated" {
		t.Fatalf("die 防抖后 updated：%+v", frames)
	}
	frame := frames[len(frames)-1]
	if !strings.Contains(frame.data, `"containerId":"`+strings.Repeat("c", 64)+`"`) || !strings.Contains(frame.data, `"startedAt":null`) {
		t.Fatalf("stopped → startedAt null：%s", frame.data)
	}
}

func TestHubDestroyRemovedRenameResyncImagePullResync(t *testing.T) {
	engine := newFakeEngine(func(engineCall) (int, string, bool) { return 200, "[]", true })
	hub, clock := newHubWithClock(engine)
	subscriber := &captureSubscriber{}
	if _, err := hub.Subscribe(hubHandlers{onEvent: subscriber.onEvent, onStatus: subscriber.onStatus}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(30 * time.Millisecond)
	base := subscriber.frameCount()

	hub.onDockerLine(`{"Type":"container","Action":"destroy","id":"` + strings.Repeat("d", 64) + `"}`)
	clock.Advance(250)
	time.Sleep(20 * time.Millisecond)
	frame := subscriber.frameSnapshot()[base]
	if frame.event != "container/removed" || !strings.Contains(frame.data, `"containerId":"`+strings.Repeat("d", 64)+`"`) {
		t.Fatalf("destroy → removed：%+v", frame)
	}

	base = subscriber.frameCount()
	hub.onDockerLine(`{"Type":"container","Action":"rename","id":"x"}`)
	clock.Advance(250)
	time.Sleep(20 * time.Millisecond)
	frame = subscriber.frameSnapshot()[base]
	if frame.event != "container/resync" {
		t.Fatalf("rename → resync：%+v", frame)
	}

	base = subscriber.frameCount()
	hub.onDockerLine(`{"Type":"image","Action":"pull"}`)
	clock.Advance(250)
	time.Sleep(20 * time.Millisecond)
	frame = subscriber.frameSnapshot()[base]
	if frame.event != "container/resync" {
		t.Fatalf("镜像 pull → resync：%+v", frame)
	}
}

func TestHubSample(t *testing.T) {
	id := strings.Repeat("c", 64)
	engine := newFakeEngine(func(call engineCall) (int, string, bool) {
		if call.Path == "/containers/json" {
			return 200, listOf(`{"Id":"`+id+`","State":"running"}`, `{"Id":"`+strings.Repeat("9", 64)+`","State":"exited"}`), true
		}
		if strings.HasSuffix(call.Path, "/stats") && strings.Contains(call.Path, strings.Repeat("c", 64)) {
			stats := statsJSON(
				cpuBlock("1100", "1000", "2", ""),
				cpuBlock("1000", "0", "2", ""),
				memBlock(tos(4*1024*1024), tos(0), "", ""))
			return 200, stats, true
		}
		return 404, "{}", true
	})
	hub, clock := newHubWithClock(engine)
	subscriber := &captureSubscriber{}
	if _, err := hub.Subscribe(hubHandlers{onEvent: subscriber.onEvent, onStatus: subscriber.onStatus}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(50 * time.Millisecond)
	var sample *hubFrame
	frames := subscriber.frameSnapshot()
	for i := len(frames) - 1; i >= 0; i-- {
		if frames[i].event == "container/sample" {
			sample = &frames[i]
			break
		}
	}
	if sample == nil {
		t.Fatalf("首拍即采样：%v", subscriber.snapshot())
	}
	if !strings.Contains(sample.data, `"containerId":"`+strings.Repeat("c", 64)+`"`) || strings.Contains(sample.data, strings.Repeat("9", 64)) {
		t.Fatalf("只采运行中容器：%s", sample.data)
	}
	if !strings.Contains(sample.data, `"cpuPercent":20`) || !strings.Contains(sample.data, `"memMb":4`) {
		t.Fatalf("样本载荷：%s", sample.data)
	}
	// 上一拍未完成跳过本拍。
	_ = clock
}

func TestHubReplayFromSampleFrameID(t *testing.T) {
	engine := newFakeEngine(func(call engineCall) (int, string, bool) {
		if strings.HasSuffix(call.Path, "/stats") {
			stats := statsJSON(cpuBlock("1100", "1000", "1", ""), cpuBlock("1000", "0", "1", ""), memBlock(tos(1024*1024), tos(0), "", ""))
			return 200, stats, true
		}
		return 200, "[]", true
	})
	hub, _ := newHubWithClock(engine)
	first := &captureSubscriber{}
	unsubscribe, err := hub.Subscribe(hubHandlers{onEvent: first.onEvent, onStatus: first.onStatus})
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(50 * time.Millisecond)
	// 找最新采样帧 id。
	var sampleID string
	frames := first.frameSnapshot()
	for i := len(frames) - 1; i >= 0; i-- {
		if frames[i].event == "container/sample" {
			sampleID = frames[i].id
			break
		}
	}
	if sampleID == "" {
		t.Fatal("无采样帧")
	}
	// 采样之后推一帧非采样事件。
	hub.emitForTest("container/resync", map[string]any{})
	time.Sleep(20 * time.Millisecond)
	unsubscribe()
	time.Sleep(20 * time.Millisecond)

	second := &captureSubscriber{}
	hub2 := hub
	_ = hub2
	if _, err := hub.Subscribe(hubHandlers{lastEventID: sampleID, onEvent: second.onEvent, onStatus: second.onStatus}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(30 * time.Millisecond)
	// 先重放采样帧（原 id），再重放其后非采样帧（emitForTest 的 resync，seq 3）。
	frames = second.frameSnapshot()
	if len(frames) < 2 || frames[0].event != "container/sample" || frames[0].id != sampleID {
		t.Fatalf("采样帧续传：%+v", frames)
	}
	if frames[1].event != "container/resync" || frames[1].id != "boot-1.3" {
		t.Fatalf("其后非采样帧按序重放：%+v", frames[1])
	}
}

func TestHubReplayStaleLastEventIDResync(t *testing.T) {
	engine := newFakeEngine(func(engineCall) (int, string, bool) { return 200, "[]", true })
	hub, _ := newHubWithClock(engine)
	first := &captureSubscriber{}
	unsubscribe, err := hub.Subscribe(hubHandlers{onEvent: first.onEvent, onStatus: first.onStatus})
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(30 * time.Millisecond)
	// 缓冲 257 帧后旧 lastEventId 被挤掉。
	for i := 0; i < 260; i++ {
		hub.emitForTest("container/resync", map[string]any{})
	}
	staleID := first.frameSnapshot()[0].id
	unsubscribe()
	time.Sleep(20 * time.Millisecond)

	second := &captureSubscriber{}
	if _, err := hub.Subscribe(hubHandlers{lastEventID: staleID, onEvent: second.onEvent, onStatus: second.onStatus}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(30 * time.Millisecond)
	frames := second.frameSnapshot()
	if len(frames) == 0 || frames[0].event != "container/resync" {
		t.Fatalf("旧 id 重连先 resync：%+v", frames)
	}
}

func TestHubReplayOtherBootResync(t *testing.T) {
	engine := newFakeEngine(func(engineCall) (int, string, bool) { return 200, "[]", true })
	hub, _ := newHubWithClock(engine)
	first := &captureSubscriber{}
	unsubscribe, err := hub.Subscribe(hubHandlers{onEvent: first.onEvent, onStatus: first.onStatus})
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(30 * time.Millisecond)
	unsubscribe()
	time.Sleep(20 * time.Millisecond)

	second := &captureSubscriber{}
	if _, err := hub.Subscribe(hubHandlers{lastEventID: "other-boot.7", onEvent: second.onEvent, onStatus: second.onStatus}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(30 * time.Millisecond)
	frames := second.frameSnapshot()
	if len(frames) == 0 || frames[0].event != "container/resync" {
		t.Fatalf("异 boot 先 resync：%+v", frames)
	}
}

func TestHubNotifyRestartingUsesCache(t *testing.T) {
	id := strings.Repeat("c", 64)
	inspects := 0
	engine := newFakeEngine(func(call engineCall) (int, string, bool) {
		if strings.HasSuffix(call.Path, "/json") && strings.Contains(call.Path, id) {
			inspects++
			return 200, containerInspectForStatus("running"), true
		}
		return 200, "[]", true
	})
	hub, _ := newHubWithClock(engine)
	subscriber := &captureSubscriber{}
	if _, err := hub.Subscribe(hubHandlers{onEvent: subscriber.onEvent, onStatus: subscriber.onStatus}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(30 * time.Millisecond)
	base := subscriber.frameCount()
	hub.NotifyRestarting(id)
	time.Sleep(50 * time.Millisecond)
	frames := subscriber.frameSnapshot()
	if len(frames) != base+1 || frames[len(frames)-1].event != "container/updated" {
		t.Fatalf("notifyRestarting 一帧 updated：%+v", frames)
	}
	frame := frames[len(frames)-1]
	if !strings.Contains(frame.data, `"status":"restarting"`) || !strings.Contains(frame.data, `"startedAt":"2024-05-02T08:00:00Z"`) {
		t.Fatalf("带缓存 startedAt 字符串：%s", frame.data)
	}
}

// emitForTest 测试注入：直接发一帧非采样事件。
func (h *eventsHub) emitForTest(name string, payload any) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.emitLocked(name, payload, false)
}
