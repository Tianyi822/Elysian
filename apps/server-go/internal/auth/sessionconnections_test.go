package auth

import (
	"errors"
	"testing"

	"elysian/server/internal/seam"
)

// 会话连接撤销表的单测（sessionConnections.test.ts 对等用例）：登记/注销/撤销的内存
// 语义——revoke 系列逐个调 closer 且清空可重入、单个 closer panic 不中断其余、对未登记
// id 幂等。closer 的关闭码与文案由调用方（终端连接胶水）负责，这里只钉撤销表本身的行为。

// closerCounter 计数 closer 的宿主（闭包捕获指针，断言调用次数）。
type closerCounter struct{ calls int }

func TestSessionConnectionsRevokeClearsAndReentrant(t *testing.T) {
	connections := NewSessionConnections()
	first := closerCounter{}
	second := closerCounter{}
	connections.Register("s1", func() { first.calls++ })
	connections.Register("s1", func() { second.calls++ })

	connections.Revoke("s1")
	if first.calls != 1 || second.calls != 1 {
		t.Fatalf("revoke 应各关一次：first=%d second=%d", first.calls, second.calls)
	}
	// 清空可重入：再次 revoke 不重复关闭。
	connections.Revoke("s1")
	if first.calls != 1 || second.calls != 1 {
		t.Errorf("再次 revoke 不应重复关闭：first=%d second=%d", first.calls, second.calls)
	}
}

func TestSessionConnectionsUnregisterIdentifiesClosureInstance(t *testing.T) {
	connections := NewSessionConnections()
	var calls [3]int
	unregister := make([]func(), len(calls))
	for i := range calls {
		unregister[i] = connections.Register("s1", func() { calls[i]++ })
	}
	// 同一闭包代码的第二个实例先结束，不能误删仍在运行的第一个实例。
	unregister[1]()
	unregister[1]()
	connections.Revoke("s1")
	if calls != [3]int{1, 0, 1} {
		t.Fatalf("只应撤销仍登记的连接：%v", calls)
	}
	// 已撤销登记的迟到清理不能碰到同会话后来登记的连接。
	connections.Register("s1", func() { calls[1]++ })
	unregister[0]()
	connections.Revoke("s1")
	if calls != [3]int{1, 1, 1} {
		t.Fatalf("迟到注销误删新连接：%v", calls)
	}
}

func TestSessionConnectionsRevokeOthers(t *testing.T) {
	connections := NewSessionConnections()
	keep := closerCounter{}
	dropB := closerCounter{}
	dropC := closerCounter{}
	connections.Register("a", func() { keep.calls++ })
	connections.Register("b", func() { dropB.calls++ })
	connections.Register("c", func() { dropC.calls++ })

	connections.RevokeOthers("a")
	if keep.calls != 0 {
		t.Error("keep 会话的 closer 不应被关闭")
	}
	if dropB.calls != 1 || dropC.calls != 1 {
		t.Errorf("非 keep 会话的 closer 应被关闭：b=%d c=%d", dropB.calls, dropC.calls)
	}
}

func TestSessionConnectionsRevokeAll(t *testing.T) {
	connections := NewSessionConnections()
	first := closerCounter{}
	second := closerCounter{}
	connections.Register("s1", func() { first.calls++ })
	connections.Register("s2", func() { second.calls++ })

	connections.RevokeAll()
	if first.calls != 1 || second.calls != 1 {
		t.Fatalf("revokeAll 关全部：first=%d second=%d", first.calls, second.calls)
	}
	connections.RevokeAll()
	if first.calls != 1 || second.calls != 1 {
		t.Errorf("revokeAll 可重入：first=%d second=%d", first.calls, second.calls)
	}
}

func TestSessionConnectionsPanickingCloserDoesNotStopOthers(t *testing.T) {
	connections := NewSessionConnections()
	healthy := closerCounter{}
	connections.Register("s1", func() { panic(errors.New("连接已死")) })
	connections.Register("s1", func() { healthy.calls++ })

	connections.Revoke("s1")
	if healthy.calls != 1 {
		t.Errorf("单个 closer 抛错不中断其余关闭（healthy=%d）", healthy.calls)
	}
}

func TestSessionConnectionsIdempotentOnUnknownSession(t *testing.T) {
	connections := NewSessionConnections()
	connections.Revoke("nope")
	connections.RevokeOthers("nope")
	connections.Register("nope", nil)()
	// 未抛错即通过。
}

func TestSessionConnectionsCloseConstants(t *testing.T) {
	if seam.SessionRevokedCloseCode != 1008 {
		t.Errorf("关闭码 = %d，期望 1008", seam.SessionRevokedCloseCode)
	}
	if seam.SessionRevokedCloseReason != "面板会话已失效，连接已关闭" {
		t.Errorf("关闭 reason = %q", seam.SessionRevokedCloseReason)
	}
}
