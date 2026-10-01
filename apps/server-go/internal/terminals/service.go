package terminals

import (
	"context"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"elysian/server/internal/seam"
)

// 终端会话管理器：一连接一会话的服务端编排。本文件只做会话生命周期（创建/并发
// 上限/空闲计时/清理）、PTY 启动行与哨兵等待、输出泵与合帧节流、补全上下文
// （compgen 命令表 + readdir 文件表）、截断与退出路径；真实进程与文件系统全部经
// seam.TerminalHostDeps 注入（本机与容器 exec 各自提供）。

// disposeCause 关闭路径：客户端断开 / 空闲超时 / 内部失败。
type disposeCause int

const (
	disposeClientClose disposeCause = iota
	disposeIdleTimeout
	disposeInternal
)

// sessionEvents 会话向连接侧输出帧与关闭的出口（胶水层把它绑到 seam.WsConn）。
type sessionEvents interface {
	sendFrame(frame terminalFrame)
	close(code int, reason string)
}

// sessionHandle 对外的会话句柄：连接胶水按客户端帧驱动，关闭路径统一走 dispose。
type sessionHandle interface {
	ID() string
	handleClientFrame(frame clientFrame)
	dispose(cause disposeCause)
}

// serviceApi 连接胶水消费的会话机内部形状。seam.TerminalsService 的既有签名缺会话
// 事件出口（TryOpen 无 events 参数）与帧驱动入口（TerminalSession 只有 ID），无法
// 承载实际协议，已按 gaps 协议登记；本包内部一律走本接口。
type serviceApi interface {
	// tryOpen 尝试建会话；nil = 并发上限（连接层 1008 拒、不建 PTY）。
	tryOpen(events sessionEvents) sessionHandle
	activeCount() int
}

// service 会话管理器：并发上限与活跃会话账本在此，会话结束（退出或清理）即出账。
type service struct {
	host        seam.TerminalHostDeps
	identityFn  func() seam.TerminalIdentity
	shell       seam.ShellSessionSpec
	maxSessions int
	clk         clock

	mu       sync.Mutex
	sessions map[string]*session
}

func newService(host seam.TerminalHostDeps, identityFn func() seam.TerminalIdentity,
	shell seam.ShellSessionSpec, maxSessions int, clk clock) *service {
	return &service{
		host:        host,
		identityFn:  identityFn,
		shell:       shell,
		maxSessions: maxSessions,
		clk:         clk,
		sessions:    make(map[string]*session),
	}
}

// nullEvents seam 形状 TryOpen 的空事件出口（seam.TerminalsService 兼容实现用）。
type nullEvents struct{}

func (nullEvents) sendFrame(terminalFrame) {}
func (nullEvents) close(int, string)       {}

// TryOpen 实现 seam.TerminalsService：seam 签名无事件出口，此处以空出口兜底
// （帧被丢弃）；真实连接路径经本包连接胶水走 tryOpen(events)。
func (s *service) TryOpen() (seam.TerminalSession, bool) {
	h := s.tryOpen(nullEvents{})
	if h == nil {
		return nil, false
	}
	return h, true
}

// ActiveCount 实现 seam.TerminalsService。
func (s *service) ActiveCount() int { return s.activeCount() }

func (s *service) tryOpen(events sessionEvents) sessionHandle {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.sessions) >= s.maxSessions {
		return nil
	}
	id := newSessionUUID()
	sess := newSession(id, s.host, s.identityFn, s.shell, events, s.clk, func(endedID string) {
		s.mu.Lock()
		delete(s.sessions, endedID)
		s.mu.Unlock()
	})
	s.sessions[id] = sess
	go sess.start()
	return sess
}

func (s *service) activeCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.sessions)
}

// buildTerminalPrompt 缺省提示符：HOME 显示为 ~（含 HOME 下子路径），其余路径原样。
func buildTerminalPrompt(identity seam.TerminalIdentity, cwd string) string {
	return identity.User + "@" + identity.HostLabel + ":" + tildePath(cwd, identity.HomeDir) + "$ "
}

func tildePath(path, homeDir string) string {
	if path == homeDir {
		return "~"
	}
	if homeDir != "/" && strings.HasPrefix(path, homeDir+"/") {
		return "~" + path[len(homeDir):]
	}
	return path
}

// clampCommands 命令表截断到上限；nil 归一为空表（JSON [] 而非 null）。
func clampCommands(commands []string) []string {
	if commands == nil {
		return []string{}
	}
	if len(commands) > TERMINAL_COMPLETION_COMMANDS_MAX {
		return commands[:TERMINAL_COMPLETION_COMMANDS_MAX]
	}
	return commands
}

// session 一次终端会话：PTY 泵、哨兵等待、合帧节流、单轮预算与保序发送链。
type session struct {
	id         string
	host       seam.TerminalHostDeps
	identityFn func() seam.TerminalIdentity
	shell      seam.ShellSessionSpec
	events     sessionEvents
	clk        clock
	onEnded    func(string)

	// mu 保护下列全部会话状态；disposed 同时以原子暴露（保序链快路径无锁读）。
	mu            sync.Mutex
	assembler     *streamAssembler
	outputLines   []string
	outputBytes   int
	flushTimer    termTimer
	flushWake     chan struct{} // flush 定时器等待者的退出信号（随 flushTimer 一起换发）
	idleTimer     termTimer
	idleWake      chan struct{} // idle 定时器等待者的退出信号（随 idleTimer 一起换发）
	proc          seam.PtyProcess
	identity      seam.TerminalIdentity
	identitySet   bool
	disposed      atomic.Bool
	cleaned       bool
	streamEnded   bool
	readySent     bool
	readyPending  bool // ready 帧物理发送中：新帧继续扣住，保证 ready 是首帧
	shellPid      string
	shellPidSet   bool
	heldFrames    []terminalFrame
	lastFlushAt   time.Time
	readyGate     chan struct{}
	readyResolved bool

	// chainMu 只保护保序发送链的排队状态（锁序恒为 mu → chainMu，不得反向）。
	chainMu        sync.Mutex
	queued         int
	queue          []func()
	workerRunning  bool
	overflowClosed bool
}

func newSession(id string, host seam.TerminalHostDeps, identityFn func() seam.TerminalIdentity,
	shell seam.ShellSessionSpec, events sessionEvents, clk clock, onEnded func(string)) *session {
	return &session{
		id:          id,
		host:        host,
		identityFn:  identityFn,
		shell:       shell,
		events:      events,
		clk:         clk,
		onEnded:     onEnded,
		assembler:   newStreamAssembler(),
		lastFlushAt: clk.Now(),
		readyGate:   make(chan struct{}),
	}
}

// ID 实现 sessionHandle / seam.TerminalSession。
func (s *session) ID() string { return s.id }

// start 启动：spawn → 写启动行 → 后台输出泵 → 等 READY 哨兵与命令表 → 发 ready 帧。
func (s *session) start() {
	identity := s.identityFn()
	proc, err := s.host.SpawnPty(context.Background(), seam.ShellSessionSpec{
		// 服务层合并白名单与 shell 规格（对齐 TS：merged env 在 spawn 前可见）。
		Env:         buildPtyEnv(identity.HomeDir, s.shell.Env),
		StartupLine: s.shell.StartupLine,
	}, identity)
	if err != nil {
		s.mu.Lock()
		s.events.close(1011, "终端进程启动失败："+err.Error())
		s.resolveReadyLocked()
		s.cleanupLocked()
		s.mu.Unlock()
		return
	}
	s.mu.Lock()
	s.identity = identity
	s.identitySet = true
	s.proc = proc
	s.armIdleLocked()
	if s.shell.StartupLine != "" {
		// 启动行写入失败：吞掉，按退出路径收尾（泵观察到流结束）。io.Writer 的
		// 写入即送达，无独立 flush 步骤。
		_, _ = proc.Write([]byte(s.shell.StartupLine))
	}
	s.mu.Unlock()

	go s.pump(proc)
	<-s.readyGate
	// 流已结束（bash 秒退）或已 dispose：退出路径由泵负责，这里不发 ready。
	s.mu.Lock()
	stop := s.disposed.Load() || s.streamEnded
	s.mu.Unlock()
	if stop {
		return
	}
	commands, cerr := s.host.ListCommands(context.Background())
	if cerr != nil {
		commands = nil // compgen 失败降级为空命令表
	}
	s.mu.Lock()
	stop = s.disposed.Load() || s.streamEnded || !s.identitySet
	ident := s.identity
	s.mu.Unlock()
	if stop {
		return
	}
	prompt := s.promptFor(ident, ident.HomeDir)
	ready := frameReady{
		Type: "ready",
		Session: frameSession{
			ID:        s.id,
			User:      ident.User,
			HostLabel: ident.HostLabel,
			Prompt:    prompt,
		},
		Completion: frameReadyCompletion{Commands: clampCommands(commands)},
	}
	s.runOrdered(func() {
		s.mu.Lock()
		s.readyPending = true
		s.mu.Unlock()
		s.events.sendFrame(ready)
		s.mu.Lock()
		s.readyPending = false
		s.readySent = true
		held := s.heldFrames
		s.heldFrames = nil
		s.mu.Unlock()
		// ready 是升级后的首帧：此前到达的 prompt/output/pong 扣住，ready 后按序补发。
		for _, f := range held {
			s.events.sendFrame(f)
		}
	})
}

// promptFor 提示符构造：deps 注入优先（docker 容器 exec 用固定 "$ "），缺省沿用
// 用户、主机与 cwd。
func (s *session) promptFor(identity seam.TerminalIdentity, cwd string) string {
	if s.host.Prompt != nil {
		return s.host.Prompt(identity, cwd)
	}
	return buildTerminalPrompt(identity, cwd)
}

// handleClientFrame 客户端帧入口：任意帧重置空闲计时；input/interrupt 原样字节落
// PTY 并武装下一个哨兵（只有跟过真实输入的 PWD 哨兵才算命令结束）；ping 回 pong。
func (s *session) handleClientFrame(frame clientFrame) {
	s.mu.Lock()
	s.armIdleLocked()
	proc := s.proc
	if proc == nil || s.disposed.Load() {
		s.mu.Unlock()
		return
	}
	var out string
	var sendPong bool
	switch frame.typ {
	case clientFrameInput:
		s.assembler.noteInput()
		out = frame.data + "\n"
	case clientFrameInterrupt:
		s.assembler.noteInput()
		out = "\x03"
	default:
		if s.emitLocked(pongFrame) {
			sendPong = true
		}
	}
	s.mu.Unlock()
	if out != "" {
		s.writePty(proc, out)
	}
	if sendPong {
		s.events.sendFrame(pongFrame)
	}
}

// writePty PTY 写入：死掉的 stdin 报错时吞掉，会话由退出/关闭路径收尾。
func (s *session) writePty(proc seam.PtyProcess, text string) {
	_, _ = proc.Write([]byte(text))
}

// emitLocked ready 未发出（或正在发送）前扣住帧。返回 true 表示需要立即发送。
func (s *session) emitLocked(frame terminalFrame) bool {
	if !s.readySent && !s.readyPending {
		s.heldFrames = append(s.heldFrames, frame)
		return false
	}
	return true
}

// emitFromWorker 保序链任务里的帧出口（任务不在 mu 下运行，发送在解锁后进行）。
func (s *session) emitFromWorker(frame terminalFrame) {
	s.mu.Lock()
	direct := s.emitLocked(frame)
	s.mu.Unlock()
	if direct {
		s.events.sendFrame(frame)
	}
}

// releaseHeld 放行扣住的帧（ready 发出后或会话收尾：退出/关闭）时调用。
func (s *session) releaseHeld() []terminalFrame {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.readySent = true
	held := s.heldFrames
	s.heldFrames = nil
	return held
}

// dispose 关闭路径（客户端断开/空闲超时/内部失败）：幂等。先同步出账（并发槽位在
// onClose 路径立即释放，不等 kill），再 SIGKILL（幂等）与收尾钩子；仅空闲超时向连
// 接发 4000 关闭帧——客户端关闭路径不向连接发关闭帧。
func (s *session) dispose(cause disposeCause) {
	s.mu.Lock()
	if s.disposed.Load() {
		s.mu.Unlock()
		return
	}
	s.beginDisposeLocked()
	proc := s.proc
	s.mu.Unlock()
	if proc != nil {
		_ = proc.Kill()
	}
	s.runDisposeHook()
	if cause == disposeIdleTimeout {
		for _, f := range s.releaseHeld() {
			s.events.sendFrame(f)
		}
		s.events.close(4000, "终端会话空闲超时")
	}
}

// beginDisposeLocked 置 disposed、清定时器、resolve ready 门闩并出账（mu 下调用）。
func (s *session) beginDisposeLocked() {
	s.disposed.Store(true)
	s.clearTimersLocked()
	s.resolveReadyLocked()
	s.cleanupLocked()
}

// runDisposeHook 会话收尾钩子：容器 exec 的 shell 进程不随劫持流断开退出，按捕获
// 的 pid 追加清理；未见 READY 哨兵（无 pid）不调用。
func (s *session) runDisposeHook() {
	s.mu.Lock()
	hook := s.host.DisposeShell
	pid, pidSet := s.shellPid, s.shellPidSet
	s.mu.Unlock()
	if hook == nil || !pidSet {
		return
	}
	hook(pid)
}

// pumpOutputBuf 输出泵的读缓冲：1 MiB 保证单条最大合法输入（4096B 命令回显远小于
// 此）与测试假件的整块投递语义；真实 PTY 的 Read 只返回当时可读的字节，缓冲大小
// 不改变事件语义（对齐 TS 侧 Bun 管道的 for-await 整块形态）。
const pumpOutputBuf = 1024 * 1024

// pump 输出泵：逐 chunk 喂汇编器并分发事件；流结束冲残尾、flush 余行、补截断帧、
// 等 PTY 退出码后走 exit 路径。
func (s *session) pump(proc seam.PtyProcess) {
	reader := proc.Stdout()
	buf := make([]byte, pumpOutputBuf)
	for {
		n, err := reader.Read(buf)
		if n > 0 {
			chunk := make([]byte, n)
			copy(chunk, buf[:n])
			s.mu.Lock()
			if s.disposed.Load() {
				s.mu.Unlock()
				return
			}
			for _, ev := range s.assembler.push(chunk) {
				s.handleStreamEventLocked(ev)
			}
			s.mu.Unlock()
		}
		if err != nil {
			break
		}
	}
	s.mu.Lock()
	s.streamEnded = true
	s.resolveReadyLocked()
	if !s.disposed.Load() {
		for _, ev := range s.assembler.finish() {
			s.handleStreamEventLocked(ev)
		}
		s.flushOutputLocked()
		// 最后一轮无 prompt 帧收尾：仍有丢弃时补一帧 truncated，让截断标记可见。
		if dropped := s.assembler.droppedBytes(); dropped > 0 {
			s.runOrdered(func() {
				s.emitFromWorker(frameTruncated{Type: "truncated", DroppedBytes: dropped})
			})
		}
	}
	s.mu.Unlock()

	exitCode := <-proc.Exited()
	s.mu.Lock()
	if s.disposed.Load() {
		s.mu.Unlock()
		return
	}
	s.runOrdered(func() {
		// 退出路径放行一切扣住的帧（ready 可能因进程秒退从未发出）。
		for _, f := range s.releaseHeld() {
			s.events.sendFrame(f)
		}
		s.events.sendFrame(frameExit{Type: "exit", ExitCode: exitCode})
		s.events.close(1000, "")
	})
	s.cleanupLocked()
	s.mu.Unlock()
}

// handleStreamEventLocked 分发汇编器事件（mu 下调用）。
func (s *session) handleStreamEventLocked(ev streamEvent) {
	switch ev.kind {
	case eventReady:
		if ev.hasPid {
			s.shellPid = ev.pid
			s.shellPidSet = true
		}
		s.resolveReadyLocked()
	case eventLines:
		for _, line := range ev.lines {
			s.bufferLineLocked(line)
		}
	case eventPrompt:
		// 命令结束：先 flush 余行，再补截断帧（如有）、readdir 后发 prompt 帧。
		s.flushOutputLocked()
		cwd := ev.cwd
		dropped := ev.droppedBytes
		s.runOrdered(func() {
			if dropped > 0 {
				s.emitFromWorker(frameTruncated{Type: "truncated", DroppedBytes: dropped})
			}
			files := s.listFiles(cwd)
			s.mu.Lock()
			if s.disposed.Load() || !s.identitySet {
				s.mu.Unlock()
				return
			}
			frame := framePrompt{
				Type:       "prompt",
				Prompt:     s.promptFor(s.identity, cwd),
				Cwd:        cwd,
				Completion: framePromptCompletion{Files: files},
			}
			s.mu.Unlock()
			s.emitFromWorker(frame)
		})
	}
}

// listFiles readdir 补全文件表：失败或超 512 项返回 nil（JSON null，客户端退回命令表）。
func (s *session) listFiles(cwd string) *[]string {
	names, err := s.host.ListDir(cwd)
	if err != nil {
		return nil
	}
	if len(names) > TERMINAL_COMPLETION_FILES_MAX {
		return nil
	}
	if names == nil {
		names = []string{}
	}
	return &names
}

// bufferLineLocked 行缓冲：累计 4096 字节立即 flush；静默期后到达的首行立即 flush，
// 其余等 50ms 定时器（mu 下调用）。
func (s *session) bufferLineLocked(line string) {
	s.outputLines = append(s.outputLines, line)
	s.outputBytes += len(line)
	if s.outputBytes >= TERMINAL_FLUSH_MAX_BYTES {
		s.flushOutputLocked()
		return
	}
	if s.flushTimer == nil {
		if s.clk.Now().Sub(s.lastFlushAt) >= TERMINAL_FLUSH_INTERVAL {
			s.flushOutputLocked()
		} else {
			// 定时器等待者经 wake 通道退出：Stop 之后的真实时钟定时器永不发火，
			// 只等 C() 会随每次提前 flush 泄漏一个 goroutine。
			t := s.clk.NewTimer(TERMINAL_FLUSH_INTERVAL)
			wake := make(chan struct{})
			s.flushTimer = t
			s.flushWake = wake
			go func() {
				select {
				case <-t.C():
				case <-wake:
					return
				}
				s.mu.Lock()
				defer s.mu.Unlock()
				if s.flushTimer != t {
					return
				}
				s.flushTimer = nil
				s.flushOutputLocked()
			}()
		}
	}
}

// flushOutputLocked 冲刷缓冲行并经保序链发送（mu 下调用）。
func (s *session) flushOutputLocked() {
	if s.flushTimer != nil {
		s.flushTimer.Stop()
		s.flushTimer = nil
		close(s.flushWake)
		s.flushWake = nil
	}
	if len(s.outputLines) == 0 {
		return
	}
	lines := s.outputLines
	s.outputLines = nil
	s.outputBytes = 0
	s.lastFlushAt = s.clk.Now()
	s.runOrdered(func() {
		s.emitFromWorker(frameOutput{Type: "output", Lines: lines})
	})
}

// runOrdered 保序发送链：output/truncated/prompt/exit/ready 帧严格按流内次序到达
// 客户端。排队深度超限（慢消费连接或事件洪水）即 1008 断开并清理会话——断开是
// 终端场景下背压的合理终态，防链条闭包与待发帧无界积累。
//
// 本方法会被持 mu 的泵路径同步调用，溢出分支不得再取 mu：disposed 以原子位同步
// 置起（新任务立即停收），出账、清定时器与 kill 在独立 goroutine 收尾。
func (s *session) runOrdered(task func()) {
	if s.disposed.Load() {
		return
	}
	s.chainMu.Lock()
	if s.disposed.Load() || s.overflowClosed {
		s.chainMu.Unlock()
		return
	}
	if s.queued >= TERMINAL_ORDERED_QUEUE_MAX {
		s.overflowClosed = true
		s.disposed.Store(true)
		s.chainMu.Unlock()
		go s.finishOverflow()
		s.events.close(TERMINAL_VIOLATION_CLOSE_CODE, "终端输出队列超限")
		return
	}
	s.queued++
	s.queue = append(s.queue, task)
	if !s.workerRunning {
		s.workerRunning = true
		go s.chainWorker()
	}
	s.chainMu.Unlock()
}

// finishOverflow 排队超限的异步收尾：清定时器、resolve ready、出账、kill 与钩子
// （不发关闭帧——1008 已由溢出分支发出）。
func (s *session) finishOverflow() {
	s.mu.Lock()
	s.clearTimersLocked()
	s.resolveReadyLocked()
	s.cleanupLocked()
	proc := s.proc
	s.mu.Unlock()
	if proc != nil {
		_ = proc.Kill()
	}
	s.runDisposeHook()
}

// chainWorker 串行执行排队任务的专用 goroutine；队列清空即退出，下次入队重建。
func (s *session) chainWorker() {
	for {
		s.chainMu.Lock()
		if len(s.queue) == 0 {
			s.workerRunning = false
			s.chainMu.Unlock()
			return
		}
		task := s.queue[0]
		s.queue = s.queue[1:]
		s.chainMu.Unlock()
		task()
		s.chainMu.Lock()
		s.queued--
		s.chainMu.Unlock()
	}
}

// armIdleLocked 武装空闲计时：任意客户端帧（含 ping）重置（mu 下调用）。等待者经
// wake 通道退出：Stop 之后的真实时钟定时器永不发火，只等 C() 会随每帧泄漏。
func (s *session) armIdleLocked() {
	if s.idleTimer != nil {
		s.idleTimer.Stop()
		s.idleTimer = nil
		close(s.idleWake)
		s.idleWake = nil
	}
	t := s.clk.NewTimer(TERMINAL_IDLE_TIMEOUT)
	wake := make(chan struct{})
	s.idleTimer = t
	s.idleWake = wake
	go func() {
		select {
		case <-t.C():
		case <-wake:
			return
		}
		s.mu.Lock()
		if s.idleTimer != t {
			s.mu.Unlock()
			return
		}
		s.idleTimer = nil
		s.mu.Unlock()
		s.dispose(disposeIdleTimeout)
	}()
}

// clearTimersLocked 清理合帧与空闲定时器（mu 下调用）。
func (s *session) clearTimersLocked() {
	if s.flushTimer != nil {
		s.flushTimer.Stop()
		s.flushTimer = nil
		close(s.flushWake)
		s.flushWake = nil
	}
	if s.idleTimer != nil {
		s.idleTimer.Stop()
		s.idleTimer = nil
		close(s.idleWake)
		s.idleWake = nil
	}
}

// resolveReadyLocked 放行 ready 门闩（READY 哨兵 / 流结束 / dispose 三处触发）。
func (s *session) resolveReadyLocked() {
	if !s.readyResolved {
		s.readyResolved = true
		close(s.readyGate)
	}
}

// cleanupLocked 会话出账（幂等；mu 下调用）。
func (s *session) cleanupLocked() {
	if s.cleaned {
		return
	}
	s.cleaned = true
	s.clearTimersLocked()
	s.onEnded(s.id)
}
