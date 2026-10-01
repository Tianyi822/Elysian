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

func TestSessionConnectionsUnregister(t *testing.T) {
	connections := NewSessionConnections()
	gone := closerCounter{}
	stays := closerCounter{}
	goneFn := func() { gone.calls++ }
	connections.Register("s1", goneFn)
	connections.Register("s1", func() { stays.calls++ })

	connections.Unregister("s1", goneFn)
	connections.Revoke("s1")
	if gone.calls != 0 {
		t.Errorf("unregister 后不应再关闭该 closer（calls=%d）", gone.calls)
	}
	if stays.calls != 1 {
		t.Errorf("同会话其余 closer 照常关闭（calls=%d）", stays.calls)
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
	connections.Unregister("nope", func() {})
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
