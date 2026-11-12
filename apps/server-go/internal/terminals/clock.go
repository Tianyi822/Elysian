package terminals

import "time"

// clock makes the 30-minute session idle timeout deterministic in tests.
type clock interface {
	Now() time.Time
	NewTimer(d time.Duration) termTimer
}

// termTimer 可停止的定时器句柄。
type termTimer interface {
	C() <-chan time.Time
	Stop() bool
}

// realClock 生产时钟。
type realClock struct{}

func (realClock) Now() time.Time { return time.Now() }

func (realClock) NewTimer(d time.Duration) termTimer {
	return realTimer{t: time.NewTimer(d)}
}

type realTimer struct{ t *time.Timer }

func (r realTimer) C() <-chan time.Time { return r.t.C }

func (r realTimer) Stop() bool { return r.t.Stop() }
