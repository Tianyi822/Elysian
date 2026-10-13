package terminals

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"elysian/server/internal/seam"
)

// 连接胶水的 fake 直驱测试（盘点 §8.4 对等移植）：fake WsConn 记录发送与关闭、
// fake 会话机记录调用，锚定帧收发、并发拒绝与违规关闭码映射、发送水位背压、
// onClose 清理与异常不外泄。

// openConnection 走一次 OnOpen 生命周期。
func openConnection(events *connEvents) *fakeWsConn {
	conn := newFakeWsConn()
	events.OnOpen(conn)
	return conn
}

func expectCloses(t *testing.T, conn *fakeWsConn, want []closeRecord) {
	t.Helper()
	got := conn.closesSnapshot()
	if len(got) != len(want) {
		t.Fatalf("关闭记录 = %+v，期望 %+v", got, want)
	}
	for i := range got {
		if got[i] != want[i] {
			t.Fatalf("第 %d 条关闭记录 = %+v，期望 %+v", i, got[i], want[i])
		}
	}
}

func TestOnOpen占用会话且帧序列化为JSON文本帧(t *testing.T) {
	fake := &fakeConnService{}
	events := newConnEvents(fake, nil, "")
	conn := openConnection(events)
	opened, _, _ := fake.snapshot()
	if opened != 1 {
		t.Fatalf("tryOpen 调用 %d 次，期望 1", opened)
	}
	// 取出注入的会话事件出口，直驱 sendFrame。
	fake.mu.Lock()
	sink := fake.opened[0]
	fake.mu.Unlock()
	sink.sendFrame(pongFrame)
	sink.sendFrame(frameOutput{Type: "output", Lines: []string{"hi"}})
	sent := conn.sentSnapshot()
	if len(sent) != 2 || sent[0] != `{"type":"pong"}` || sent[1] != `{"type":"output","lines":["hi"]}` {
		t.Fatalf("发送原文 = %v", sent)
	}
	expectCloses(t, conn, nil)
}

func Test并发已达上限1008关闭且不建会话(t *testing.T) {
	fake := &fakeConnService{rejectOpen: true}
	events := newConnEvents(fake, nil, "")
	conn := openConnection(events)
	expectCloses(t, conn, []closeRecord{{code: TERMINAL_VIOLATION_CLOSE_CODE, reason: TERMINAL_LIMIT_REASON}})
	if opened, _, _ := fake.snapshot(); opened != 0 {
		t.Fatalf("不应建会话，tryOpen 成功 %d 次", opened)
	}
	// 被拒连接上的后续消息与关闭是 no-op，不外泄。
	events.OnMessage(conn, []byte(`{"type":"ping"}`))
	events.OnClose()
}

func Test合法帧透传给会话(t *testing.T) {
	fake := &fakeConnService{}
	events := newConnEvents(fake, nil, "")
	conn := openConnection(events)
	events.OnMessage(conn, []byte(`{"type":"input","data":"whoami"}`))
	events.OnMessage(conn, []byte(`{"type":"interrupt"}`))
	events.OnMessage(conn, []byte(`{"type":"ping"}`))
	_, handled, disposals := fake.snapshot()
	if len(handled) != 3 || handled[0].typ != clientFrameInput || handled[0].data != "whoami" ||
		handled[1].typ != clientFrameInterrupt || handled[2].typ != clientFramePing {
		t.Fatalf("透传帧 = %+v", handled)
	}
	if len(disposals) != 0 {
		t.Fatalf("合法帧不应触发 dispose：%v", disposals)
	}
}

func Test违规帧矩阵1008逐字reason并立即清理(t *testing.T) {
	for _, tc := range []struct {
		data   string
		reason string
	}{
		{"not json", "终端消息不是有效 JSON"},
		{`{"type":"resize","cols":80}`, "终端消息类型不允许"},
		{`{"type":"input","data":"a\nb"}`, "终端输入不合法"},
	} {
		fake := &fakeConnService{}
		events := newConnEvents(fake, nil, "")
		conn := openConnection(events)
		events.OnMessage(conn, []byte(tc.data))
		expectCloses(t, conn, []closeRecord{{code: TERMINAL_VIOLATION_CLOSE_CODE, reason: tc.reason}})
		if _, _, disposals := fake.snapshot(); len(disposals) != 1 || disposals[0] != disposeClientClose {
			t.Fatalf("违规应立即 dispose(client-close)：%v", disposals)
		}
	}
}

func Test二进制帧按终端消息过大关闭(t *testing.T) {
	fake := &fakeConnService{}
	events := newConnEvents(fake, nil, "")
	conn := openConnection(events)
	events.OnMessage(conn, nil)
	expectCloses(t, conn, []closeRecord{{code: TERMINAL_VIOLATION_CLOSE_CODE, reason: "终端消息过大"}})
	if _, _, disposals := fake.snapshot(); len(disposals) != 1 || disposals[0] != disposeClientClose {
		t.Fatalf("二进制违规应 dispose(client-close)：%v", disposals)
	}
}

func TestOnClose触发会话清理(t *testing.T) {
	fake := &fakeConnService{}
	events := newConnEvents(fake, nil, "")
	openConnection(events)
	events.OnClose()
	if _, _, disposals := fake.snapshot(); len(disposals) != 1 || disposals[0] != disposeClientClose {
		t.Fatalf("onClose 应触发 client-close 清理：%v", disposals)
	}
}

func Test服务层异常不外泄(t *testing.T) {
	throwing := &fakeConnService{throwOnOpen: true}
	events := newConnEvents(throwing, nil, "")
	conn := openConnection(events)
	closes := conn.closesSnapshot()
	if len(closes) != 1 || closes[0].code != 1011 {
		t.Fatalf("tryOpen 抛错应 1011 关闭：%+v", closes)
	}
	if !strings.HasPrefix(closes[0].reason, "终端会话建立失败") {
		t.Fatalf("reason = %q，应以「终端会话建立失败」开头", closes[0].reason)
	}

	frameThrowing := &fakeConnService{throwOnFrame: true}
	events2 := newConnEvents(frameThrowing, nil, "")
	conn2 := openConnection(events2)
	events2.OnMessage(conn2, []byte(`{"type":"ping"}`)) // 不应 panic
}

func Test连接非OPEN时帧丢弃(t *testing.T) {
	fake := &fakeConnService{}
	events := newConnEvents(fake, nil, "")
	conn := openConnection(events)
	conn.open.Store(false)
	fake.mu.Lock()
	sink := fake.opened[0]
	fake.mu.Unlock()
	sink.sendFrame(pongFrame) // 非 OPEN：静默丢弃
	if sent := conn.sentSnapshot(); len(sent) != 0 {
		t.Fatalf("非 OPEN 帧应丢弃：%v", sent)
	}
}

func Test发送水位超限1008断开会话清理帧不再发送(t *testing.T) {
	fake := &fakeConnService{}
	events := newConnEvents(fake, nil, "")
	conn := openConnection(events)
	conn.buffered.Store(TERMINAL_SEND_BUFFER_LIMIT_BYTES + 1)
	fake.mu.Lock()
	sink := fake.opened[0]
	fake.mu.Unlock()
	sink.sendFrame(pongFrame)
	if sent := conn.sentSnapshot(); len(sent) != 0 {
		t.Fatalf("超限帧不应发送：%v", sent)
	}
	expectCloses(t, conn, []closeRecord{{code: TERMINAL_VIOLATION_CLOSE_CODE, reason: TERMINAL_BACKPRESSURE_REASON}})
	if _, _, disposals := fake.snapshot(); len(disposals) != 1 || disposals[0] != disposeInternal {
		t.Fatalf("水位超限应 dispose(internal)：%v", disposals)
	}
	// 连接已死（水位回落也改变不了）：后续帧静默丢弃，不重复关闭。
	conn.buffered.Store(0)
	sink.sendFrame(pongFrame)
	if sent := conn.sentSnapshot(); len(sent) != 0 {
		t.Fatalf("后续帧应静默丢弃：%v", sent)
	}
	if closes := conn.closesSnapshot(); len(closes) != 1 {
		t.Fatalf("不应重复关闭：%+v", closes)
	}
}

func Test发送水位在限内含恰好等于上限帧正常发送(t *testing.T) {
	fake := &fakeConnService{}
	events := newConnEvents(fake, nil, "")
	conn := openConnection(events)
	conn.buffered.Store(TERMINAL_SEND_BUFFER_LIMIT_BYTES) // 恰等上限不触发
	fake.mu.Lock()
	sink := fake.opened[0]
	fake.mu.Unlock()
	sink.sendFrame(pongFrame)
	if sent := conn.sentSnapshot(); len(sent) != 1 || sent[0] != `{"type":"pong"}` {
		t.Fatalf("限内帧应正常发送：%v", sent)
	}
	expectCloses(t, conn, nil)
	if _, _, disposals := fake.snapshot(); len(disposals) != 0 {
		t.Fatalf("不应触发 dispose：%v", disposals)
	}
}

func Test撤销接线登记与撤销关闭(t *testing.T) {
	fake := &fakeConnService{}
	connections := newTestSessionConnections()
	events := newConnEvents(fake, connections, "abc")
	conn := openConnection(events)

	// 登记进撤销表：revoke 触发 closer，连接以撤销口径关闭（closer 先把自己摘出
	// 撤销表再关闭，撤销是一次性的、不重复关闭）。
	connections.Revoke("abc")
	expectCloses(t, conn, []closeRecord{{
		code:   seam.SessionRevokedCloseCode,
		reason: seam.SessionRevokedCloseReason,
	}})
	// PTY 清理走 close 触发的 onClose 既有路径，不由 closer 代劳。
	if _, _, disposals := fake.snapshot(); len(disposals) != 0 {
		t.Fatalf("closer 不应代劳 PTY 清理：%v", disposals)
	}
}

func TestOnClose注销后revoke不重复关闭(t *testing.T) {
	fake := &fakeConnService{}
	connections := newTestSessionConnections()
	events := newConnEvents(fake, connections, "abc")
	conn := openConnection(events)

	events.OnClose()
	if _, _, disposals := fake.snapshot(); len(disposals) != 1 || disposals[0] != disposeClientClose {
		t.Fatalf("onClose 应触发清理：%v", disposals)
	}
	connections.Revoke("abc")
	if closes := conn.closesSnapshot(); len(closes) != 0 {
		t.Fatalf("已注销的连接不应再被 revoke 关闭：%+v", closes)
	}
}

type delayedConnectionRegistration struct {
	seam.SessionConnections
	registered, resume chan struct{}
}

func (c delayedConnectionRegistration) Register(id string, closer func()) func() {
	unregister := c.SessionConnections.Register(id, closer)
	close(c.registered)
	<-c.resume
	return unregister
}

func TestOnCloseBeforeRegistrationReturnsDoesNotLeakConnection(t *testing.T) {
	connections := newTestSessionConnections()
	delayed := delayedConnectionRegistration{SessionConnections: connections, registered: make(chan struct{}), resume: make(chan struct{})}
	events := newConnEvents(&fakeConnService{}, delayed, "abc")
	conn := newFakeWsConn()
	done := make(chan struct{})
	go func() { defer close(done); events.OnOpen(conn) }()
	select {
	case <-delayed.registered:
	case <-time.After(3 * time.Second):
		t.Fatal("未开始登记连接")
	}
	events.OnClose()
	close(delayed.resume)
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("登记没有结束")
	}
	if connections.count("abc") != 0 {
		t.Fatal("晚到的登记未被清理")
	}
	connections.Revoke("abc")
	expectCloses(t, conn, nil)
}

func Test并发上限拒绝时不登记撤销closer(t *testing.T) {
	fake := &fakeConnService{rejectOpen: true}
	connections := newTestSessionConnections()
	events := newConnEvents(fake, connections, "abc")
	conn := openConnection(events)
	expectCloses(t, conn, []closeRecord{{code: TERMINAL_VIOLATION_CLOSE_CODE, reason: TERMINAL_LIMIT_REASON}})
	if got := connections.count("abc"); got != 0 {
		t.Fatalf("被拒连接不应登记 closer，得 %d", got)
	}
}

func TestKit接口实现锚定(t *testing.T) {
	// NewKit 产出的会话机与连接胶水满足 seam 形状（编译期断言在 connection.go）；
	// 此处锚定 NewService → NewConnEvents 全链路可用。
	k := NewKit()
	svc := k.NewService(seam.TerminalHostDeps{
		SpawnPty: func(context.Context, seam.ShellSessionSpec, seam.TerminalIdentity) (seam.PtyProcess, error) {
			return newFakePty(), nil
		},
		ListCommands: func(context.Context) ([]string, error) { return nil, nil },
		ListDir:      func(string) ([]string, error) { return nil, nil },
	}, HostShellSessionSpec, resolveHostIdentity, 1)
	conn := newFakeWsConn()
	events := k.NewConnEvents(svc, nil, "")
	events.OnOpen(conn)
	events.OnClose()
}

func Test合计上限包装器拒绝超额并透传限内(t *testing.T) {
	k := NewKit()
	release := make(chan struct{})
	defer close(release) // 让阻塞在 SpawnPty 的会话 goroutine 在测试后退出
	svc := k.NewService(seam.TerminalHostDeps{
		// 阻塞式 spawn：会话占位但不产生任何异步帧/关闭，断言不受时序影响。
		SpawnPty: func(context.Context, seam.ShellSessionSpec, seam.TerminalIdentity) (seam.PtyProcess, error) {
			<-release
			return nil, errors.New("测试用阻塞 spawn")
		},
		ListCommands: func(context.Context) ([]string, error) { return nil, nil },
		ListDir:      func(string) ([]string, error) { return nil, nil },
	}, HostShellSessionSpec, resolveHostIdentity, 5)
	active := 0
	wrapped := k.NewTotalLimitedService(svc, func() int { return active }, 5)

	// 限内：连接胶水对包装后的会话机依然成立（类型断言不失效），可建会话。
	events := k.NewConnEvents(wrapped, nil, "s1")
	conn := newFakeWsConn()
	events.OnOpen(conn)
	if closes := conn.closesSnapshot(); len(closes) != 0 {
		t.Fatalf("限内应可建会话，不该有任何关闭：%+v", closes)
	}
	events.OnClose()

	// 超额：tryOpen 直接拒绝（连接层 1008），不触达 inner。
	active = 5
	events2 := k.NewConnEvents(wrapped, nil, "s2")
	conn2 := newFakeWsConn()
	events2.OnOpen(conn2)
	closes := conn2.closesSnapshot()
	if len(closes) != 1 || closes[0].code != TERMINAL_VIOLATION_CLOSE_CODE || closes[0].reason != TERMINAL_LIMIT_REASON {
		t.Fatalf("超额应 1008 拒绝：%+v", closes)
	}
}
