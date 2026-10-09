package clock

import (
	"context"
	"testing"
	"time"
)

func TestManualNowAndAdvance(t *testing.T) {
	base := time.Unix(1700000000, 0)
	m := NewManual(base)
	if !m.Now().Equal(base) {
		t.Fatalf("初始 Now 应等于构造时刻：%v", m.Now())
	}
	m.Advance(5 * time.Second)
	if got := m.Now().Sub(base); got != 5*time.Second {
		t.Fatalf("Advance 后虚拟时间应推进 5s，实际 %v", got)
	}
}

func TestManualAfterFiresOnAdvance(t *testing.T) {
	m := NewManual(time.Unix(0, 0))
	c1 := m.After(10 * time.Millisecond)
	c2 := m.After(20 * time.Millisecond)
	// 未推进时不得触发。
	select {
	case v := <-c1:
		t.Fatalf("未 Advance 时 After 不应触发：%v", v)
	default:
	}
	m.Advance(15 * time.Millisecond)
	// c1 到期（10ms <= 15ms），c2 未到期。
	select {
	case v := <-c1:
		if want := time.Unix(0, int64(10*time.Millisecond)); !v.Equal(want) {
			t.Fatalf("c1 应在预定时刻到期：%v want %v", v, want)
		}
	default:
		t.Fatal("Advance(15ms) 后 c1 应已触发")
	}
	select {
	case <-c2:
		t.Fatal("Advance(15ms) 后 c2（20ms）不应触发")
	default:
	}
	m.Advance(5 * time.Millisecond)
	select {
	case v := <-c2:
		if want := time.Unix(0, int64(20*time.Millisecond)); !v.Equal(want) {
			t.Fatalf("c2 应在预定时刻到期：%v want %v", v, want)
		}
	default:
		t.Fatal("Advance(20ms) 后 c2 应已触发")
	}
}

func TestManualAfterZeroFiresOnNextAdvance(t *testing.T) {
	m := NewManual(time.Unix(0, 0))
	c := m.After(0)
	select {
	case <-c:
		t.Fatal("零时长在 Advance 前不得触发")
	default:
	}
	m.Advance(0)
	select {
	case <-c:
	default:
		t.Fatal("Advance(0) 应触发已到期的零时长等待者")
	}
}

func TestManualSleep(t *testing.T) {
	m := NewManual(time.Unix(0, 0))
	done := make(chan error, 1)
	go func() {
		done <- m.Sleep(context.Background(), 100*time.Millisecond)
	}()
	// 通过登记通知确认 Sleep 已开始等待，再推进虚拟时间。
	for {
		count, changed := m.Pending()
		if count > 0 {
			break
		}
		select {
		case <-changed:
		case <-time.After(time.Second):
			t.Fatal("等待 Sleep 登记超时")
		}
	}
	// 推进不足不解除（非阻塞检查：此时无任何到期）。
	m.Advance(50 * time.Millisecond)
	select {
	case err := <-done:
		t.Fatalf("推进不足时 Sleep 不应返回：%v", err)
	default:
	}
	m.Advance(50 * time.Millisecond)
	if err := <-done; err != nil {
		t.Fatalf("Sleep 应正常结束：%v", err)
	}
}

func TestManualSleepCancel(t *testing.T) {
	m := NewManual(time.Unix(0, 0))
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- m.Sleep(ctx, time.Hour)
	}()
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("取消后 Sleep 应返回错误")
		}
	case <-time.After(time.Second):
		t.Fatal("取消后 Sleep 应立即返回")
	}
	// 取消的等待者应已移除：推进不再触发其通道。
	m.Advance(2 * time.Hour)
}

func TestManualMultipleWaitersFIFO(t *testing.T) {
	m := NewManual(time.Unix(0, 0))
	a := m.After(30 * time.Millisecond)
	b := m.After(10 * time.Millisecond)
	c := m.After(30 * time.Millisecond)
	m.Advance(30 * time.Millisecond)
	var got []time.Time
	for _, ch := range []<-chan time.Time{b, a, c} {
		select {
		case v := <-ch:
			got = append(got, v)
		default:
			t.Fatal("全部等待者应已触发")
		}
	}
	// 到期时刻保持预定值：b(10ms) 早于 a/c(30ms)，a、c 同刻。
	if !got[0].Equal(time.Unix(0, int64(10*time.Millisecond))) {
		t.Fatalf("最早到期的应是 b：%v", got)
	}
	if !got[1].Equal(got[2]) || !got[1].Equal(time.Unix(0, int64(30*time.Millisecond))) {
		t.Fatalf("同刻等待者应保持预定时刻：%v", got)
	}
}

func TestManualTimerStop(t *testing.T) {
	m := NewManual(time.Unix(0, 0))
	timer := m.NewTimer(time.Hour)
	if !timer.Stop() || timer.Stop() {
		t.Fatal("Stop 只能成功一次")
	}
	if count, _ := m.Pending(); count != 0 {
		t.Fatalf("停止后仍保留 %d 个计时器", count)
	}
	m.Advance(time.Hour)
	select {
	case <-timer.Chan():
		t.Fatal("已停止计时器不得投递")
	default:
	}
	fired := m.NewTimer(0)
	m.Advance(0)
	if fired.Stop() {
		t.Fatal("已到期计时器不能再次停止")
	}
	select {
	case <-fired.Chan():
	default:
		t.Fatal("已到期通知必须保留")
	}
}

func TestManualStopConcurrentAdvance(t *testing.T) {
	for i := 0; i < 100; i++ {
		m := NewManual(time.Unix(0, 0))
		timer := m.NewTimer(time.Nanosecond)
		start := make(chan struct{})
		advanced := make(chan struct{})
		go func() { <-start; m.Advance(time.Nanosecond); close(advanced) }()
		close(start)
		stopped := timer.Stop()
		<-advanced
		select {
		case <-timer.Chan():
			if stopped {
				t.Fatal("Stop 成功之后仍发生投递")
			}
		default:
			if !stopped {
				t.Fatal("Advance 已提交到期却没有投递")
			}
		}
		if count, _ := m.Pending(); count != 0 {
			t.Fatalf("计时器泄漏：%d", count)
		}
	}
}
