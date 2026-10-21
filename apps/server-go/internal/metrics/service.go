package metrics

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"log"
	"os"
	"sync"
	"time"

	"elysian/server/internal/shared"
)

// 采样与事件流节拍常量（mockEventsPlugin.ts 等价物）：5 秒一拍、15 秒心跳、
// 首帧 retry 5 秒；订阅上限与 docker 域事件流一致。
const (
	sampleTick       = 5 * time.Second
	sseHeartbeat     = 15 * time.Second
	sseRetryMs       = 5000
	maxSubscribers   = 8
	subscriberBuffer = 32
)

// errMaxSubscribers 第 9 个并发订阅者的拒绝错误（路由层转 503）。
var errMaxSubscribers = errors.New("实时连接数已达上限")

// Deps 域依赖：Store 可为 nil（指标库打开失败时的降级——只推实时、不持久化）；
// Now 缺省 time.Now；Warn 缺省标准 log（进程文本日志的另一路出口）。
type Deps struct {
	Store *Store
	Now   func() time.Time
	Warn  func(message string)
}

// Service 常驻采样服务：每拍读 /proc、写 Store、向事件流订阅者广播；
// 生命周期由装配层 closeFuncs 回收（stop→等待循环退出→关闭存储）。
type Service struct {
	store  *Store
	reader hostSampleReader
	now    func() time.Time
	warn   func(message string)
	hub    *sampleHub
	tick   time.Duration

	prev      *samplePrev
	warnOnce  sync.Once
	stop      chan struct{}
	done      chan struct{}
	closeOnce sync.Once
}

// NewService 装配并启动采样循环（立即采第一拍，之后每 5 秒一拍）。
func NewService(deps Deps) *Service {
	now := deps.Now
	if now == nil {
		now = time.Now
	}
	warn := deps.Warn
	if warn == nil {
		warn = func(message string) { log.Print(message) }
	}
	service := &Service{
		store: deps.Store,
		reader: hostSampleReader{
			readFile: readFileString,
			nowMs:    func() int64 { return now().UnixMilli() },
		},
		now:  now,
		warn: warn,
		hub:  newSampleHub(now),
		tick: sampleTick,
		stop: make(chan struct{}),
		done: make(chan struct{}),
	}
	go service.loop()
	return service
}

// loop 采样主循环：立即一拍＋定时拍；Close 后退出。
func (s *Service) loop() {
	defer close(s.done)
	s.sampleOnce()
	ticker := time.NewTicker(s.tick)
	defer ticker.Stop()
	for {
		select {
		case <-s.stop:
			return
		case <-ticker.C:
			s.sampleOnce()
		}
	}
}

// sampleOnce 采一拍：读失败整拍作废（首条失败告警一次，不刷屏），成功则落库并广播。
func (s *Service) sampleOnce() {
	sample, err := readHostSample(s.reader, s.prev)
	if err != nil {
		s.warnOnce.Do(func() {
			s.warn(fmt.Sprintf("资源采样失败（后续失败不重复记录，恢复即自愈）：%v", err))
		})
		return
	}
	s.prev = &sample.nextPrev
	if s.store != nil {
		point := pointOf(sample.payload, sample.nextPrev.at)
		s.store.InsertRaw(point)
		s.store.RollupMinuteIfNeeded(sample.nextPrev.at)
		s.store.Prune(sample.nextPrev.at)
	}
	s.hub.publish(sample.payload)
}

// History 历史查询出口（存储降级时恒空数组）。
func (s *Service) History(rangeKey string, nowMs int64) []SamplePoint {
	if s == nil || s.store == nil {
		return []SamplePoint{}
	}
	return s.store.Query(rangeKey, nowMs)
}

// NowMs 当前毫秒时钟（handler 与服务同一时钟）。
func (s *Service) NowMs() int64 {
	return s.now().UnixMilli()
}

// Close 停采样循环并关闭存储；等待循环退出或 ctx 到期。
func (s *Service) Close(ctx context.Context) error {
	if s == nil {
		return nil
	}
	s.closeOnce.Do(func() {
		close(s.stop)
	})
	select {
	case <-s.done:
	case <-ctx.Done():
	}
	return s.store.Close()
}

// readFileString 生产环境文件读取出口（测试经 hostSampleReader 注入假件）。
func readFileString(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// ---------- 事件流 hub ----------

// sseFrame 已序列化的完整 SSE 帧（event/id/data 三行＋空行）。
type sseFrame struct {
	id   string
	data string
}

// frameText 渲染为 wire 帧文本（行序与 docker 域事件流一致：event→id→data）。
func (f sseFrame) frameText() string {
	return "event: resource/sample\nid: " + f.id + "\ndata: " + f.data + "\n\n"
}

// sampleHub resource/sample 广播中枢：只保最近一拍（重连语义=补发最新采样，
// 不重放更旧的历史拍——与 mock 端点 REPLAY_BURST=1 同口径）。
type sampleHub struct {
	mu          sync.Mutex
	now         func() time.Time
	bootID      string
	seq         int
	lastFrame   *sseFrame
	subscribers map[chan string]struct{}
}

func newSampleHub(now func() time.Time) *sampleHub {
	return &sampleHub{
		now:         now,
		bootID:      randomBootID(),
		subscribers: make(map[chan string]struct{}),
	}
}

// eventEnvelope 事件信封（键序即 JSON 输出序，与契约 ElysianEvent 一致）。
type eventEnvelope struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	At      string `json:"at"`
	Payload any    `json:"payload"`
}

// isoNow toISOString 等价（毫秒精度、Z 结尾）。
func (h *sampleHub) isoNow() string {
	return h.now().UTC().Format("2006-01-02T15:04:05.000") + "Z"
}

// publish 构帧并广播：id 为 `<bootUUID>.<seq>`（进程内单调），只保最近一帧。
func (h *sampleHub) publish(payload resourceSamplePayload) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.seq++
	id := h.bootID + "." + fmt.Sprint(h.seq)
	envelope := eventEnvelope{ID: id, Name: "resource/sample", At: h.isoNow(), Payload: payload}
	data, err := shared.MarshalJSON(envelope)
	if err != nil {
		return
	}
	frame := sseFrame{id: id, data: string(data)}
	h.lastFrame = &frame
	for sub := range h.subscribers {
		select {
		case sub <- frame.frameText():
		default:
			// 订阅者积压超限丢本拍：采样每 5 秒再来，宁丢勿阻。
		}
	}
}

// subscribe 订阅事件流：超限拒绝；Last-Event-ID 等于最近一拍时不重发（已投递），
// 否则（新连接或落后）立即补发最近一拍。取消函数幂等。
func (h *sampleHub) subscribe(lastEventID string) (<-chan string, func(), error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.subscribers) >= maxSubscribers {
		return nil, nil, errMaxSubscribers
	}
	sub := make(chan string, subscriberBuffer)
	h.subscribers[sub] = struct{}{}
	if h.lastFrame != nil && h.lastFrame.id != lastEventID {
		sub <- h.lastFrame.frameText()
	}
	var once sync.Once
	return sub, func() {
		once.Do(func() {
			h.mu.Lock()
			defer h.mu.Unlock()
			if _, exists := h.subscribers[sub]; !exists {
				return
			}
			delete(h.subscribers, sub)
			close(sub)
		})
	}, nil
}

// randomBootID 进程随机 UUID（crypto/rand v4 形态；失败以时间兜底保证区分度）。
func randomBootID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
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
