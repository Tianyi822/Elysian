package terminals

import "time"

// clock 会话计时注入点：真实实现走 time 包；测试用可控假钟驱动 50ms 合帧节流与
// 30 分钟空闲计时（对齐 TS 版 vitest fake timers 的确定性）。
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
