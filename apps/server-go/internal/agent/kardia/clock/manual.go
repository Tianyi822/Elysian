package clock

import (
	"context"
	"sort"
	"sync"
	"time"
)

// manualTimer 与 Advance、Stop 共用时钟锁，撤销与投递具有唯一确定顺序。
type manualTimer struct {
	clock    *Manual
	deadline time.Time
	seq      uint64
	ch       chan time.Time
	active   bool
}

func (t *manualTimer) Chan() <-chan time.Time { return t.ch }

func (t *manualTimer) Stop() bool {
	m := t.clock
	m.mu.Lock()
	defer m.mu.Unlock()
	if !t.active {
		return false
	}
	t.active = false
	for i, w := range m.waiters {
		if w == t {
			m.waiters = append(m.waiters[:i], m.waiters[i+1:]...)
			break
		}
	}
	m.notifyLocked()
	return true
}

// Manual 的虚拟时间只经 Advance 推进。到期通道同步投递，回调仍由调用方执行。
type Manual struct {
	mu      sync.Mutex
	now     time.Time
	waiters []*manualTimer
	seq     uint64
	changed chan struct{}
}

var _ Clock = (*Manual)(nil)

func NewManual(now time.Time) *Manual { return &Manual{now: now, changed: make(chan struct{})} }

func (m *Manual) Now() time.Time {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.now
}

// NewTimer 同步登记。零和负时长也在下一次 Advance 时触发。
func (m *Manual) NewTimer(d time.Duration) Timer {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.seq++
	t := &manualTimer{clock: m, deadline: m.now.Add(d), seq: m.seq, ch: make(chan time.Time, 1), active: true}
	m.waiters = append(m.waiters, t)
	m.notifyLocked()
	return t
}

func (m *Manual) After(d time.Duration) <-chan time.Time { return m.NewTimer(d).Chan() }

func (m *Manual) Sleep(ctx context.Context, d time.Duration) error { return sleep(ctx, m, d) }

// Advance 推进虚拟时间，并按到期时间、登记顺序投递所有到期通知。
func (m *Manual) Advance(d time.Duration) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.now = m.now.Add(d)
	sort.SliceStable(m.waiters, func(i, j int) bool {
		a, b := m.waiters[i], m.waiters[j]
		if !a.deadline.Equal(b.deadline) {
			return a.deadline.Before(b.deadline)
		}
		return a.seq < b.seq
	})
	remaining := m.waiters[:0]
	for _, w := range m.waiters {
		if !w.deadline.After(m.now) {
			w.active = false
			w.ch <- w.deadline
		} else {
			remaining = append(remaining, w)
		}
	}
	for i := len(remaining); i < len(m.waiters); i++ {
		m.waiters[i] = nil
	}
	m.waiters = remaining
	m.notifyLocked()
}

// Pending 返回尚未到期的计时器数及下一次登记、停止或推进的通知通道。
// 在同一个锁内获取快照与通知，允许测试通过通道同步，不必自旋或真实等待。
func (m *Manual) Pending() (int, <-chan struct{}) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.changed == nil {
		m.changed = make(chan struct{})
	}
	return len(m.waiters), m.changed
}

func (m *Manual) notifyLocked() {
	if m.changed != nil {
		close(m.changed)
	}
	m.changed = make(chan struct{})
}
