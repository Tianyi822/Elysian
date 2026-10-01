package docker

import (
	"context"
	crand "crypto/rand"
	"errors"
	"net/http"
	"net/url"
	"sync"
	"time"

	"elysian/server/internal/contract"
	"elysian/server/internal/seam"
	"elysian/server/internal/shared"
)

// SSE 事件 hub（dockerEventsHub.ts 逐字移植）：Engine events 流 + 3s 采样 + 重放
// 缓冲 + 退避重连。首个订阅者启动全部设施，订阅归零全部停止；开流即乐观 live。

const (
	sampleIntervalMs    = 3000
	debounceMs          = 200
	statsConcurrency    = 8
	nonSampleBufferSize = 256
	maxSubscribers      = 8
	backoffInitialMs    = 1000
	backoffMaxMs        = 30000
	statsTimeout        = 2000
	hubListTimeout      = 10 * time.Second
	hubJSONMaxBytes     = 32 * 1024 * 1024
)

// errMaxSubscribers 第 9 个并发订阅者的拒绝错误（路由层转 503）。
var errMaxSubscribers = errors.New("实时连接数已达上限")

var imageResyncActions = map[string]bool{
	"pull": true, "tag": true, "untag": true, "delete": true,
}

// hubFrame 一帧内部表示；sample 帧只记 lastSampleFrame 不进重放缓冲。
type hubFrame struct {
	event  string
	id     string
	data   string
	seq    int
	sample bool
}

// hubHandlers 订阅回调。
type hubHandlers struct {
	lastEventID string
	onEvent     func(event, id, data string)
	onStatus    func(status string) // "live" | "connecting"
}

// eventsHubConfig hub 依赖注入（now/schedule 可注入供测试驱动假时钟）。
type eventsHubConfig struct {
	transport seam.DockerTransport
	now       func() time.Time
	schedule  func(fn func(), ms int) (cancel func())
	bootID    string
}

// eventsHub Docker 事件中枢。
type eventsHub struct {
	cfg eventsHubConfig

	mu                 sync.Mutex
	seq                int
	subscribers        map[*hubHandlers]struct{}
	streamGen          int
	streamCancel       context.CancelFunc
	sampleCancel       func()
	reconnectCancel    func()
	backoffMs          int
	dockerLive         bool
	statsInFlight      bool
	lastSampleFrame    *hubFrame
	nonSampleBuffer    []hubFrame
	containerDebounce  map[string]func()
	imageResyncCancel  func()
	lastKnownStartedAt map[string]string
}

func newEventsHub(cfg eventsHubConfig) *eventsHub {
	if cfg.now == nil {
		cfg.now = time.Now
	}
	if cfg.schedule == nil {
		cfg.schedule = func(fn func(), ms int) func() {
			timer := time.AfterFunc(time.Duration(ms)*time.Millisecond, fn)
			return func() { timer.Stop() }
		}
	}
	if cfg.bootID == "" {
		cfg.bootID = randomBootID()
	}
	return &eventsHub{
		cfg:                cfg,
		subscribers:        make(map[*hubHandlers]struct{}),
		backoffMs:          backoffInitialMs,
		containerDebounce:  make(map[string]func()),
		lastKnownStartedAt: make(map[string]string),
	}
}

// Subscribe 订阅：超限错误、重放、状态上报、首订阅启动（全部同步完成后返回）。
func (h *eventsHub) Subscribe(handlers hubHandlers) (func(), error) {
	h.mu.Lock()
	if len(h.subscribers) >= maxSubscribers {
		h.mu.Unlock()
		return nil, errMaxSubscribers
	}
	h.subscribers[&handlers] = struct{}{}
	wasZero := len(h.subscribers) == 1

	h.deliverReplayLocked(handlers.lastEventID, handlers.onEvent)

	if h.dockerLive {
		handlers.onStatus("live")
	} else {
		handlers.onStatus("connecting")
	}

	if wasZero {
		h.startHubLocked()
	}
	h.mu.Unlock()

	var once sync.Once
	return func() {
		once.Do(func() {
			h.mu.Lock()
			delete(h.subscribers, &handlers)
			if len(h.subscribers) == 0 {
				h.stopHubLocked()
			}
			h.mu.Unlock()
		})
	}, nil
}

// NotifyRestarting restart 动作前的乐观事件：startedAt 取缓存否则现场 inspect。
func (h *eventsHub) NotifyRestarting(containerID string) {
	go func() {
		h.mu.Lock()
		startedAt, hasCache := h.lastKnownStartedAt[containerID]
		h.mu.Unlock()
		if !hasCache {
			container, ok := h.inspectContainer(containerID)
			if ok && container.StartedAt != "" {
				startedAt = container.StartedAt
				h.mu.Lock()
				h.lastKnownStartedAt[containerID] = startedAt
				h.mu.Unlock()
			}
		}
		payload := containerUpdatedPayload{ContainerID: containerID, Status: "restarting", StartedAt: nil}
		if startedAt != "" {
			payload.StartedAt = &startedAt
		}
		h.mu.Lock()
		h.emitLocked("container/updated", payload, false)
		h.mu.Unlock()
	}()
}

// ---------- 事件载荷形状（键序即 JSON 输出序） ----------

type containerUpdatedPayload struct {
	ContainerID string  `json:"containerId"`
	Status      string  `json:"status"`
	StartedAt   *string `json:"startedAt"`
}

type containerRemovedPayload struct {
	ContainerID string `json:"containerId"`
}

type containerCreatedPayload struct {
	Container contract.Container `json:"container"`
}

type containerSampleItem struct {
	ContainerID string  `json:"containerId"`
	CPUPercent  float64 `json:"cpuPercent"`
	MemMB       float64 `json:"memMb"`
}

type containerSamplePayload struct {
	Samples []containerSampleItem `json:"samples"`
}

type eventEnvelope struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	At      string `json:"at"`
	Payload any    `json:"payload"`
}

func updatedPayloadOf(container contract.Container) containerUpdatedPayload {
	payload := containerUpdatedPayload{
		ContainerID: container.ID,
		Status:      container.Status,
		StartedAt:   nil,
	}
	if container.Status != "stopped" && container.StartedAt != "" {
		startedAt := container.StartedAt
		payload.StartedAt = &startedAt
	}
	return payload
}

// isoNow toISOString 等价（毫秒精度、Z 结尾）。
func (h *eventsHub) isoNow() string {
	return h.cfg.now().UTC().Format("2006-01-02T15:04:05.000") + "Z"
}

func (h *eventsHub) buildFrameLocked(name string, payload any, sample bool) hubFrame {
	h.seq++
	id := h.cfg.bootID + "." + itoa(h.seq)
	envelope := eventEnvelope{ID: id, Name: name, At: h.isoNow(), Payload: payload}
	data, err := shared.MarshalJSON(envelope)
	if err != nil {
		data = []byte("{}")
	}
	return hubFrame{event: name, id: id, data: string(data), seq: h.seq, sample: sample}
}

func (h *eventsHub) emitLocked(name string, payload any, sample bool) hubFrame {
	frame := h.buildFrameLocked(name, payload, sample)
	h.publishLocked(frame)
	return frame
}

func (h *eventsHub) publishLocked(frame hubFrame) {
	if !frame.sample {
		h.nonSampleBuffer = append(h.nonSampleBuffer, frame)
		for len(h.nonSampleBuffer) > nonSampleBufferSize {
			h.nonSampleBuffer = h.nonSampleBuffer[1:]
		}
	}
	if frame.sample {
		sample := frame
		h.lastSampleFrame = &sample
	}
	h.broadcastLocked(frame)
}

func (h *eventsHub) broadcastLocked(frame hubFrame) {
	for sub := range h.subscribers {
		sub.onEvent(frame.event, frame.id, frame.data)
	}
}

func (h *eventsHub) setConnectingLocked() {
	for sub := range h.subscribers {
		sub.onStatus("connecting")
	}
}

func (h *eventsHub) setLiveLocked() {
	for sub := range h.subscribers {
		sub.onStatus("live")
	}
}

// parseSeqFromId 解析 <bootId>.<seq>；非法返回 ok=false。
func parseSeqFromID(eventID, bootID string) (boot string, seq int, ok bool) {
	dot := -1
	for i := len(eventID) - 1; i >= 0; i-- {
		if eventID[i] == '.' {
			dot = i
			break
		}
	}
	if dot <= 0 {
		return "", 0, false
	}
	boot = eventID[:dot]
	seqText := eventID[dot+1:]
	if seqText == "" {
		return "", 0, false
	}
	seq = 0
	for i := 0; i < len(seqText); i++ {
		ch := seqText[i]
		if ch < '0' || ch > '9' {
			return "", 0, false
		}
		seq = seq*10 + int(ch-'0')
	}
	return boot, seq, true
}

// deliverReplay 按 lastEventId 重放（dockerEventsHub.ts deliverReplay 逐字）。
func (h *eventsHub) deliverReplayLocked(lastEventID string, onEvent func(event, id, data string)) {
	if lastEventID != "" {
		boot, seq, parsed := parseSeqFromID(lastEventID, h.cfg.bootID)
		var oldest *int
		if len(h.nonSampleBuffer) > 0 {
			value := h.nonSampleBuffer[0].seq
			oldest = &value
		}

		if h.lastSampleFrame != nil && h.lastSampleFrame.id == lastEventID && parsed && boot == h.cfg.bootID {
			gapLost := oldest != nil && *oldest > seq+1
			if !gapLost {
				frame := *h.lastSampleFrame
				onEvent(frame.event, frame.id, frame.data)
				for i := range h.nonSampleBuffer {
					if h.nonSampleBuffer[i].seq > seq {
						onEvent(h.nonSampleBuffer[i].event, h.nonSampleBuffer[i].id, h.nonSampleBuffer[i].data)
					}
				}
				return
			}
		}

		needResync := false
		if !parsed {
			needResync = true
		} else if boot != h.cfg.bootID {
			needResync = true
		} else if oldest != nil && seq < *oldest {
			needResync = true
		}

		if needResync {
			resync := h.buildFrameLocked("container/resync", struct{}{}, false)
			onEvent(resync.event, resync.id, resync.data)
		} else if parsed && boot == h.cfg.bootID {
			for i := range h.nonSampleBuffer {
				if h.nonSampleBuffer[i].seq > seq {
					onEvent(h.nonSampleBuffer[i].event, h.nonSampleBuffer[i].id, h.nonSampleBuffer[i].data)
				}
			}
		}
	}

	if h.lastSampleFrame != nil && h.lastSampleFrame.id != lastEventID {
		frame := *h.lastSampleFrame
		onEvent(frame.event, frame.id, frame.data)
	}
}

// inspectContainer 容器 inspect（失败静默 undefined）。
func (h *eventsHub) inspectContainer(id string) (contract.Container, bool) {
	response, err := h.cfg.transport.Request(context.Background(), seam.EngineRequest{
		Method:   http.MethodGet,
		Path:     "/containers/" + encodeEngineID(id) + "/json",
		Timeout:  hubListTimeout,
		MaxBytes: hubJSONMaxBytes,
	})
	if err != nil {
		return contract.Container{}, false
	}
	if response.Status < 200 || response.Status >= 300 {
		return contract.Container{}, false
	}
	value, err := decodeOrderedJSON(response.Body)
	if err != nil {
		return contract.Container{}, false
	}
	container, err := mapContainer(value)
	if err != nil {
		return contract.Container{}, false
	}
	return container, true
}

// scheduleContainerRefresh 按容器 id 200ms 防抖。
func (h *eventsHub) scheduleContainerRefreshLocked(containerID string, handler func()) {
	if cancel, ok := h.containerDebounce[containerID]; ok {
		cancel()
	}
	cancel := h.cfg.schedule(func() {
		h.mu.Lock()
		delete(h.containerDebounce, containerID)
		h.mu.Unlock()
		go handler()
	}, debounceMs)
	h.containerDebounce[containerID] = cancel
}

// scheduleImageResync 镜像事件 200ms 防抖 resync。
func (h *eventsHub) scheduleImageResyncLocked() {
	if h.imageResyncCancel != nil {
		h.imageResyncCancel()
	}
	h.imageResyncCancel = h.cfg.schedule(func() {
		h.mu.Lock()
		h.imageResyncCancel = nil
		h.emitLocked("container/resync", struct{}{}, false)
		h.mu.Unlock()
	}, debounceMs)
}

// handleContainerEngineEvent 容器事件分发（destroy/remove/rename/create/状态类/其他）。
func (h *eventsHub) handleContainerEngineEvent(action, containerID string) {
	if action == "destroy" || action == "remove" {
		h.mu.Lock()
		h.emitLocked("container/removed", containerRemovedPayload{ContainerID: stripSha256Prefix(containerID)}, false)
		h.mu.Unlock()
		return
	}
	if action == "rename" {
		h.mu.Lock()
		h.emitLocked("container/resync", struct{}{}, false)
		h.mu.Unlock()
		return
	}
	if action == "create" {
		container, ok := h.inspectContainer(containerID)
		if !ok {
			return
		}
		h.mu.Lock()
		if container.StartedAt != "" {
			h.lastKnownStartedAt[container.ID] = container.StartedAt
		}
		h.emitLocked("container/created", containerCreatedPayload{Container: container}, false)
		h.mu.Unlock()
		return
	}
	switch action {
	case "start", "die", "kill", "pause", "unpause", "restart":
		container, ok := h.inspectContainer(containerID)
		if !ok {
			return
		}
		h.mu.Lock()
		if container.StartedAt != "" {
			h.lastKnownStartedAt[container.ID] = container.StartedAt
		}
		h.emitLocked("container/updated", updatedPayloadOf(container), false)
		h.mu.Unlock()
		return
	default:
		h.mu.Lock()
		h.emitLocked("container/resync", struct{}{}, false)
		h.mu.Unlock()
	}
}

// onDockerLine Engine 事件流单行分发。
func (h *eventsHub) onDockerLine(line string) {
	value, err := decodeOrderedJSON([]byte(line))
	if err != nil {
		return
	}
	record, ok := asRecord(value)
	if !ok {
		return
	}
	eventType, _ := asString(mustGet(record, "Type"))
	action, ok := asString(mustGet(record, "Action"))
	if !ok {
		return
	}

	if eventType == "image" && imageResyncActions[action] {
		h.mu.Lock()
		h.scheduleImageResyncLocked()
		h.mu.Unlock()
		return
	}

	if eventType != "container" {
		return
	}
	containerID, ok := asString(mustGet(record, "id"))
	if !ok {
		return
	}

	h.mu.Lock()
	h.scheduleContainerRefreshLocked(containerID, func() {
		h.handleContainerEngineEvent(action, containerID)
	})
	h.mu.Unlock()
}

// stopDockerStreamLocked 停 Engine events 流。
func (h *eventsHub) stopDockerStreamLocked() {
	if h.streamCancel != nil {
		h.streamCancel()
		h.streamCancel = nil
	}
	h.dockerLive = false
}

// scheduleReconnectLocked connecting + 指数退避重连（1s→30s）。
func (h *eventsHub) scheduleReconnectLocked() {
	if h.reconnectCancel != nil {
		h.reconnectCancel()
	}
	h.setConnectingLocked()
	h.reconnectCancel = h.cfg.schedule(func() {
		h.mu.Lock()
		h.reconnectCancel = nil
		h.startDockerStreamLocked()
		h.mu.Unlock()
	}, h.backoffMs)
	h.backoffMs *= 2
	if h.backoffMs > backoffMaxMs {
		h.backoffMs = backoffMaxMs
	}
}

// startDockerStreamLocked 开流：乐观 live（不等连接确认）+ 一帧 resync。
func (h *eventsHub) startDockerStreamLocked() {
	h.stopDockerStreamLocked()

	h.streamGen++
	gen := h.streamGen
	ctx, cancel := context.WithCancel(context.Background())
	h.streamCancel = cancel

	eventsQuery := url.Values{"filters": {`{"type":["container","image"]}`}}
	splitter := newLineSplitter(func(line string) { h.onDockerLine(line) })
	go func() {
		_, _ = h.cfg.transport.Stream(ctx, seam.EngineRequest{
			Method: http.MethodGet,
			Path:   "/events",
			Query:  eventsQuery,
		}, splitter.feed)
		splitter.flush()
		h.mu.Lock()
		defer h.mu.Unlock()
		if h.streamGen != gen {
			// 已被 stopDockerStream / 新一代流取代：结果按预期取消处理，不重连。
			return
		}
		h.stopDockerStreamLocked()
		h.scheduleReconnectLocked()
	}()

	h.dockerLive = true
	h.backoffMs = backoffInitialMs
	h.emitLocked("container/resync", struct{}{}, false)
	h.setLiveLocked()
}

// stopSampleTimerLocked 停采样定时器。
func (h *eventsHub) stopSampleTimerLocked() {
	if h.sampleCancel != nil {
		h.sampleCancel()
		h.sampleCancel = nil
	}
}

// sampleOnce 拉全部运行中容器 stats 并发采样（上一拍未完成跳过本拍）。
func (h *eventsHub) sampleOnce() {
	h.mu.Lock()
	if h.statsInFlight {
		h.mu.Unlock()
		return
	}
	h.statsInFlight = true
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		h.statsInFlight = false
		h.mu.Unlock()
	}()

	response, err := h.cfg.transport.Request(context.Background(), seam.EngineRequest{
		Method:   http.MethodGet,
		Path:     "/containers/json",
		Query:    url.Values{"all": {"1"}},
		Timeout:  hubListTimeout,
		MaxBytes: hubJSONMaxBytes,
	})
	if err != nil {
		return
	}
	if response.Status < 200 || response.Status >= 300 {
		return
	}
	value, err := decodeOrderedJSON(response.Body)
	if err != nil {
		return
	}
	entries, ok := asArray(value)
	if !ok {
		return
	}
	runningIDs := make([]string, 0, len(entries))
	for _, entry := range entries {
		record, ok := asRecord(entry)
		if !ok {
			continue
		}
		id, ok := asString(mustGet(record, "Id"))
		state, _ := asString(mustGet(record, "State"))
		if ok && state == "running" {
			runningIDs = append(runningIDs, id)
		}
	}

	type sampleOrSkip struct {
		item containerSampleItem
		skip bool
	}
	samples, _ := mapWithConcurrency(runningIDs, statsConcurrency, func(id string, _ int) (sampleOrSkip, error) {
		response, err := h.cfg.transport.Request(context.Background(), seam.EngineRequest{
			Method:   http.MethodGet,
			Path:     "/containers/" + encodeEngineID(id) + "/stats",
			Query:    url.Values{"stream": {"0"}},
			Timeout:  statsTimeout,
			MaxBytes: hubJSONMaxBytes,
		})
		if err != nil {
			return sampleOrSkip{skip: true}, nil
		}
		if response.Status < 200 || response.Status >= 300 {
			return sampleOrSkip{skip: true}, nil
		}
		value, err := decodeOrderedJSON(response.Body)
		if err != nil {
			return sampleOrSkip{skip: true}, nil
		}
		cpu, cpuOK := cpuPercent(value)
		mem, memOK := memoryMb(value)
		if !cpuOK || !memOK {
			return sampleOrSkip{skip: true}, nil
		}
		return sampleOrSkip{item: containerSampleItem{ContainerID: stripSha256Prefix(id), CPUPercent: cpu, MemMB: mem}}, nil
	})
	valid := make([]containerSampleItem, 0, len(samples))
	for _, sample := range samples {
		if sample.skip {
			continue
		}
		valid = append(valid, sample.item)
	}
	h.mu.Lock()
	h.emitLocked("container/sample", containerSamplePayload{Samples: valid}, true)
	h.mu.Unlock()
}

// startSampleTimerLocked 立即采一次，然后每 3s 一拍（自续定时器，可取消）。
func (h *eventsHub) startSampleTimerLocked() {
	h.stopSampleTimerLocked()
	go h.sampleOnce()
	var tick func()
	tick = func() {
		go h.sampleOnce()
		h.mu.Lock()
		if h.sampleCancel != nil {
			h.sampleCancel = h.cfg.schedule(tick, sampleIntervalMs)
		}
		h.mu.Unlock()
	}
	h.sampleCancel = h.cfg.schedule(tick, sampleIntervalMs)
}

// startHubLocked 首订阅启动：events 流 + 采样定时器。
func (h *eventsHub) startHubLocked() {
	h.startDockerStreamLocked()
	h.startSampleTimerLocked()
}

// stopHubLocked 订阅归零停止：流、采样、重连、防抖全部取消。
func (h *eventsHub) stopHubLocked() {
	h.stopDockerStreamLocked()
	h.stopSampleTimerLocked()
	if h.reconnectCancel != nil {
		h.reconnectCancel()
		h.reconnectCancel = nil
	}
	for _, cancel := range h.containerDebounce {
		cancel()
	}
	h.containerDebounce = make(map[string]func())
	if h.imageResyncCancel != nil {
		h.imageResyncCancel()
		h.imageResyncCancel = nil
	}
}

// randomBootID 进程随机 UUID（crypto/rand v4 形态）。
func randomBootID() string {
	return randomUUIDv4()
}

// randomUUIDv4 生成标准 v4 UUID 字符串。
func randomUUIDv4() string {
	var b [16]byte
	if _, err := crand.Read(b[:]); err != nil {
		// crypto/rand 失败极罕见：以时间兜底，保证 bootId 仍有区分度。
		now := time.Now().UnixNano()
		for i := 0; i < 16; i++ {
			b[i] = byte(now >> (uint(i%8) * 8))
		}
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	const hexDigits = "0123456789abcdef"
	out := make([]byte, 0, 36)
	for i, v := range b {
		if i == 4 || i == 6 || i == 8 || i == 10 {
			out = append(out, '-')
		}
		out = append(out, hexDigits[v>>4], hexDigits[v&0x0f])
	}
	return string(out)
}
