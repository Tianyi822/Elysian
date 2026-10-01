package docker

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"sync"
	"time"

	"elysian/server/internal/seam"
)

// exec 劫持连接实现（dockerExecRunner.ts 逐字移植）：create → start（Connection:
// Upgrade / Upgrade: tcp）→ 101 劫持裸 socket 或非 101 的 2xx 响应体分支；有界
// 输出队列（8 MiB 上限、半水位停读、四分之一恢复）；流结束后 inspect 补查退出码。

// execStdoutMaxBytes 劫持流未消费输出的驻留上限。
const execStdoutMaxBytes = 8 * 1024 * 1024

// errSessionClosed 消费者读到队列终止但无失败原因时的干净结束（等价 TS 的
// stdoutClosed 无 setupError 分支，由 Read 映射为 io.EOF）。
var errSessionClosed = errors.New("exec session closed")

// boundedChunkQueue 有界 chunk 队列：绝不静默删旧输出，超限显式失败；消费者出队、
// 上游泵（半水位停读/四分之一恢复）共用一把锁与条件变量。
type boundedChunkQueue struct {
	mu       sync.Mutex
	cond     *sync.Cond
	chunks   [][]byte
	buffered int
	maxBytes int
	failed   error
	ended    bool
}

func newBoundedChunkQueue(maxBytes int) *boundedChunkQueue {
	q := &boundedChunkQueue{maxBytes: maxBytes}
	q.cond = sync.NewCond(&q.mu)
	return q
}

// push 入队；超限置失败并返回「容器终端输出缓冲超限」。
func (q *boundedChunkQueue) push(chunk []byte) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.failed != nil {
		return q.failed
	}
	if q.ended {
		return errSessionClosed
	}
	if q.buffered+len(chunk) > q.maxBytes {
		q.failed = errors.New("容器终端输出缓冲超限")
		q.cond.Broadcast()
		return q.failed
	}
	q.buffered += len(chunk)
	q.chunks = append(q.chunks, chunk)
	q.cond.Broadcast()
	return nil
}

// fail 置失败态并唤醒全部等待者。
func (q *boundedChunkQueue) fail(err error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.failed == nil {
		q.failed = err
	}
	q.cond.Broadcast()
}

// end 干净收尾（主动关闭）：先耗尽已入队块再结束。
func (q *boundedChunkQueue) end() {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.ended = true
	q.cond.Broadcast()
}

// shift 阻塞取一块；ok=false 时 err 为失败原因或 nil（干净结束）。
func (q *boundedChunkQueue) shift() (chunk []byte, ok bool, err error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	for len(q.chunks) == 0 && q.failed == nil && !q.ended {
		q.cond.Wait()
	}
	if len(q.chunks) > 0 {
		chunk = q.chunks[0]
		q.chunks = q.chunks[1:]
		q.buffered -= len(chunk)
		q.cond.Broadcast()
		return chunk, true, nil
	}
	if q.failed != nil {
		return nil, false, q.failed
	}
	return nil, false, nil
}

// awaitCapacity 上游泵的背压等待：驻留降到 low 以下（或终止/失败）才返回；
// 返回 false 表示队列已进入终止态，泵应停止读取。
func (q *boundedChunkQueue) awaitCapacity(low int) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	for q.buffered >= low && q.failed == nil && !q.ended {
		q.cond.Wait()
	}
	return q.failed == nil && !q.ended
}

// bufferedAtLeast 驻留水位判定（泵的停读阈值）。
func (q *boundedChunkQueue) bufferedAtLeast(n int) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.buffered >= n
}

// execSession 一次 exec 会话（create → start hijack → 双向流）。
type execSession struct {
	socketPath  string
	containerID string

	mu            sync.Mutex
	queue         *boundedChunkQueue
	setupError    error
	pendingWrites []string
	writeTarget   io.Writer
	execID        string
	conns         []net.Conn
	closeOnce     sync.Once

	// fakeStdout/fake 测试注入：fake 时跳过真实建链，Read 直出该文本（探测/补全替身）。
	fake       bool
	fakeStdout string
}

// newFakeSession 测试构造：直出文本的假会话。
func newFakeSession(text string) *execSession {
	return &execSession{fake: true, fakeStdout: text}
}

// execStartBody / execCreateBody Engine create/start 请求体（键序固定）。
type execStartBody struct {
	Detach bool `json:"Detach"`
	Tty    bool `json:"Tty"`
}

type execCreateBody struct {
	AttachStdin  bool     `json:"AttachStdin"`
	AttachStdout bool     `json:"AttachStdout"`
	AttachStderr bool     `json:"AttachStderr"`
	Tty          bool     `json:"Tty"`
	Cmd          []string `json:"Cmd"`
	Env          []string `json:"Env,omitempty"`
}

// newExecSession 建会话并立即开始 setup（后台 goroutine）。
func newExecSession(socketPath, containerID string, cmd []string, tty bool, env []string) *execSession {
	session := &execSession{
		socketPath:  socketPath,
		containerID: containerID,
		queue:       newBoundedChunkQueue(execStdoutMaxBytes),
	}
	go session.setup(cmd, tty, env)
	return session
}

// Write 写 stdin；attach 前缓冲、attach 后直写（失败吞掉：连接已断开由输出路径收尾）。
func (s *execSession) Write(text string) {
	s.mu.Lock()
	target := s.writeTarget
	if target == nil {
		s.pendingWrites = append(s.pendingWrites, text)
		s.mu.Unlock()
		return
	}
	s.mu.Unlock()
	_, _ = target.Write([]byte(text))
}

// Read 消费 stdout（有界队列出口；fake 模式直出注入文本）。
func (s *execSession) Read(p []byte) (int, error) {
	if s.fake {
		if len(s.fakeStdout) == 0 {
			return 0, io.EOF
		}
		n := copy(p, s.fakeStdout)
		s.fakeStdout = s.fakeStdout[n:]
		return n, nil
	}
	chunk, ok, err := s.queue.shift()
	if err != nil {
		return 0, err
	}
	if !ok {
		return 0, io.EOF
	}
	return copy(p, chunk), nil
}

// Close 断开全部连接并干净结束队列（消费者随后读到 io.EOF）；fake 会话无队列。
func (s *execSession) Close() {
	if s.fake {
		s.closeOnce.Do(func() { s.fakeStdout = "" })
		return
	}
	s.closeOnce.Do(func() {
		s.mu.Lock()
		s.pendingWrites = nil
		conns := append([]net.Conn(nil), s.conns...)
		s.mu.Unlock()
		for _, conn := range conns {
			_ = conn.Close()
		}
		s.queue.end()
	})
}

// ExitCode 流结束后 GET /exec/<id>/json 读 ExitCode；失败按 1。
func (s *execSession) ExitCode() int {
	if s.fake {
		return 0
	}
	s.mu.Lock()
	execID := s.execID
	s.mu.Unlock()
	if execID == "" {
		return 1
	}
	conn, br, err := dialEngineConn(s.socketPath)
	if err != nil {
		return 1
	}
	defer conn.Close()
	path := seam.EngineAPIPrefix + "/exec/" + encodeEngineID(execID) + "/json"
	if err := writeEngineRequest(conn, http.MethodGet, path, nil, nil); err != nil {
		return 1
	}
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	response, err := readEngineResponseHead(br, http.MethodGet)
	if err != nil {
		return 1
	}
	body, err := io.ReadAll(response.Body)
	if err != nil {
		return 1
	}
	var inspect struct {
		ExitCode *int `json:"ExitCode"`
	}
	if json.Unmarshal(body, &inspect) != nil {
		return 1
	}
	if response.StatusCode != http.StatusOK || inspect.ExitCode == nil {
		return 1
	}
	return *inspect.ExitCode
}

// setup create → start → attach 的完整建链流程。
func (s *execSession) setup(cmd []string, tty bool, env []string) {
	createBody := execCreateBody{
		AttachStdin:  true,
		AttachStdout: true,
		AttachStderr: true,
		Tty:          tty,
		Cmd:          append([]string(nil), cmd...),
		Env:          env,
	}
	createPayload, err := json.Marshal(createBody)
	if err != nil {
		s.failSetup(err)
		return
	}

	execID, err := s.createExec(createPayload)
	if err != nil {
		s.failSetup(err)
		return
	}
	s.mu.Lock()
	s.execID = execID
	s.mu.Unlock()

	startPayload, _ := json.Marshal(execStartBody{Detach: false, Tty: tty})
	if err := s.startAndAttach(execID, startPayload, tty); err != nil {
		s.failSetup(err)
	}
}

// createExec POST /containers/<id>/exec 解析 exec Id。
func (s *execSession) createExec(payload []byte) (string, error) {
	conn, br, err := dialEngineConn(s.socketPath)
	if err != nil {
		return "", err
	}
	s.trackConn(conn)
	defer conn.Close()
	path := seam.EngineAPIPrefix + "/containers/" + encodeEngineID(s.containerID) + "/exec"
	headers := map[string]string{
		"Content-Type":   "application/json",
		"Content-Length": itoa(len(payload)),
	}
	if err := writeEngineRequest(conn, http.MethodPost, path, headers, payload); err != nil {
		return "", err
	}
	response, err := readEngineResponseHead(br, http.MethodPost)
	if err != nil {
		return "", err
	}
	body, err := io.ReadAll(br)
	if err != nil {
		return "", err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", fmt.Errorf("创建容器 exec 失败（HTTP %d）", response.StatusCode)
	}
	var result struct {
		ID *string `json:"Id"`
	}
	if json.Unmarshal(body, &result) != nil || result.ID == nil || *result.ID == "" {
		return "", errors.New("创建容器 exec 响应无效")
	}
	return *result.ID, nil
}

// startAndAttach POST /exec/<id>/start：101 走劫持裸 socket，其余 2xx 走响应体分支。
func (s *execSession) startAndAttach(execID string, payload []byte, tty bool) error {
	conn, br, err := dialEngineConn(s.socketPath)
	if err != nil {
		return err
	}
	s.trackConn(conn)
	path := seam.EngineAPIPrefix + "/exec/" + encodeEngineID(execID) + "/start"
	headers := map[string]string{
		"Content-Type":   "application/json",
		"Content-Length": itoa(len(payload)),
		"Connection":     "Upgrade",
		"Upgrade":        "tcp",
	}
	if err := writeEngineRequest(conn, http.MethodPost, path, headers, payload); err != nil {
		conn.Close()
		return err
	}
	response, err := readEngineResponseHead(br, http.MethodPost)
	if err != nil {
		conn.Close()
		return err
	}
	status := response.StatusCode
	if status < 200 || status >= 300 {
		conn.Close()
		return fmt.Errorf("启动容器 exec 失败（HTTP %d）", status)
	}

	var reader io.Reader
	var writer io.Writer
	if status == http.StatusSwitchingProtocols {
		// 101 劫持：bufio 缓冲余量 + 裸 socket 双工。
		reader = br
		writer = conn
	} else {
		// 非 101 的 2xx：帧式响应体分支；请求已 end，写入侧不可达（等价丢弃）。
		reader = response.Body
		writer = discardingWriter{}
	}
	s.attach(reader, writer)
	return nil
}

// attach 建立读写通道（补写 attach 前缓冲）并启动输出泵。
func (s *execSession) attach(reader io.Reader, writer io.Writer) {
	s.mu.Lock()
	s.writeTarget = writer
	pending := append([]string(nil), s.pendingWrites...)
	s.pendingWrites = nil
	s.mu.Unlock()

	for _, text := range pending {
		_, _ = writer.Write([]byte(text))
	}
	go s.pump(reader)
}

// pump 输出泵：读上游 → 有界队列；半水位（4 MiB）停读，降至四分之一（2 MiB）恢复。
func (s *execSession) pump(reader io.Reader) {
	buf := make([]byte, 32*1024)
	for {
		if s.queue.bufferedAtLeast(execStdoutMaxBytes / 2) {
			if !s.queue.awaitCapacity(execStdoutMaxBytes / 4) {
				return
			}
		}
		n, err := reader.Read(buf)
		if n > 0 {
			chunk := make([]byte, n)
			copy(chunk, buf[:n])
			if pushErr := s.queue.push(chunk); pushErr != nil {
				s.failSetup(pushErr)
				return
			}
		}
		if err == io.EOF {
			s.queue.end()
			return
		}
		if err != nil {
			s.failSetup(err)
			return
		}
	}
}

// failSetup 建链/泵失败：记录原因并唤醒消费者（Read 将收到该错误）。
func (s *execSession) failSetup(err error) {
	s.mu.Lock()
	if s.setupError == nil {
		s.setupError = err
	}
	s.mu.Unlock()
	s.queue.fail(err)
}

// Err returns the setup/pump failure, if any（Read 路径之外的诊断出口）。
func (s *execSession) Err() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.setupError
}

func (s *execSession) trackConn(conn net.Conn) {
	s.mu.Lock()
	s.conns = append(s.conns, conn)
	s.mu.Unlock()
}

// discardingWriter 非 101 分支的写入侧（TS 中写入已 end 的请求，等价丢弃）。
type discardingWriter struct{}

func (discardingWriter) Write(p []byte) (int, error) { return len(p), nil }

// readStdoutText 把 exec stdout 读成完整字符串（探测与清理脚本共用）。
func readStdoutText(r io.Reader) (string, error) {
	data, err := io.ReadAll(r)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// execRunner 为指定容器构造 ExecRunner（每次 Run 新建 exec 会话）。
type execRunner interface {
	Run(cmd []string, tty bool, env []string) *execSession
}

// containerExecRunner 真实实现的 runner 工厂。
type containerExecRunner struct {
	socketPath  string
	containerID string
}

func createContainerExecRunner(socketPath, containerID string) execRunner {
	return &containerExecRunner{socketPath: socketPath, containerID: containerID}
}

// Run 新建一次 exec 会话。
func (r *containerExecRunner) Run(cmd []string, tty bool, env []string) *execSession {
	return newExecSession(r.socketPath, r.containerID, cmd, tty, env)
}
