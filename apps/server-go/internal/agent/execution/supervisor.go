package execution

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

type supervisor struct {
	ctx     context.Context
	cancel  context.CancelFunc
	out     io.Writer
	writeMu sync.Mutex
	mu      sync.Mutex
	pending map[string]chan frame
	tunnels map[string]net.Conn
	stdin   io.WriteCloser
	input   chan frame
	cmd     *exec.Cmd
}

func (s *supervisor) send(f frame) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	b, err := json.Marshal(f)
	if err != nil || len(b) > MaxFrameBytes {
		return protocolError()
	}
	_, err = s.out.Write(append(b, '\n'))
	if err != nil {
		s.cancel()
	}
	return err
}

// ServeSupervisor 仅可作为受限 Linux 容器的 PID 1 运行；没有 Docker、数据库或凭据文件。
func ServeSupervisor(ctx context.Context, input io.Reader, output io.Writer) error {
	if runtime.GOOS != "linux" || os.Getpid() != 1 {
		return problem(403, "execution-supervisor-only", "执行监督器仅允许在专属容器中运行")
	}
	return serveSupervisor(ctx, input, output)
}
func serveSupervisor(ctx context.Context, input io.Reader, output io.Writer) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	s := &supervisor{ctx: ctx, cancel: cancel, out: output, pending: make(map[string]chan frame), tunnels: make(map[string]net.Conn), input: make(chan frame, 16)}
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 4096), MaxFrameBytes+1)
	if !scanner.Scan() {
		return protocolError()
	}
	var start frame
	if decodeFrame(scanner.Bytes(), &start) != nil || start.Kind != "start" || (start.Mode != "script" && start.Mode != "stdio") || validateCommand(start.Command, start.Environment) != nil {
		return protocolError()
	}
	if start.Mode == "script" {
		if err := copyInitialWorkspace(ctx, "/bundle/initial-workspace", "/workspace"); err != nil {
			return protocolError()
		}
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return protocolError()
	}
	proxyServer := &http.Server{Handler: http.HandlerFunc(s.handleProxy), ReadHeaderTimeout: 10 * time.Second, MaxHeaderBytes: 32 << 10}
	go func() { _ = proxyServer.Serve(listener) }()
	defer proxyServer.Close()
	cmd := exec.CommandContext(ctx, start.Command[0], start.Command[1:]...)
	cmd.Dir = "/workspace"
	if start.Mode == "stdio" {
		cmd.Dir = "/tmp"
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process != nil {
			return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		}
		return nil
	}
	cmd.WaitDelay = time.Second
	environment := map[string]string{"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "HOME": "/tmp", "TMPDIR": "/tmp"}
	for k, v := range start.Environment {
		environment[k] = v
	}
	proxyURL := "http://" + listener.Addr().String()
	for _, key := range []string{"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"} {
		environment[key] = proxyURL
	}
	for _, key := range []string{"NO_PROXY", "no_proxy"} {
		environment[key] = ""
	}
	keys := make([]string, 0, len(environment))
	for key := range environment {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		cmd.Env = append(cmd.Env, key+"="+environment[key])
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return protocolError()
	}
	stdout, stdoutWrite, err := os.Pipe()
	if err != nil {
		return protocolError()
	}
	defer stdout.Close()
	defer stdoutWrite.Close()
	stderr, stderrWrite, err := os.Pipe()
	if err != nil {
		return protocolError()
	}
	defer stderr.Close()
	defer stderrWrite.Close()
	s.stdin = stdin
	s.cmd = cmd
	cmd.Stdout = stdoutWrite
	cmd.Stderr = stderrWrite
	if err = cmd.Start(); err != nil {
		_ = s.send(frame{Kind: "error"})
		return protocolError()
	}
	stdoutWrite.Close()
	stderrWrite.Close()
	defer func() {
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		s.mu.Lock()
		for _, conn := range s.tunnels {
			conn.Close()
		}
		s.mu.Unlock()
	}()
	go s.inputLoop()
	go func() {
		for scanner.Scan() {
			var f frame
			if decodeFrame(scanner.Bytes(), &f) != nil {
				s.cancel()
				return
			}
			if s.accept(f) != nil {
				s.cancel()
				return
			}
		}
		s.cancel()
	}()
	var copying sync.WaitGroup
	copying.Add(2)
	go func() { defer copying.Done(); _ = s.copyStream("stdout", stdout) }()
	go func() { defer copying.Done(); _ = s.copyStream("stderr", stderr) }()
	waitErr := cmd.Wait()
	_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	// 先杀死并回收逃离进程组的子孙进程，再复制输出，防止归档期间继续写文件。
	if err = stopDescendants(); err != nil {
		stdout.Close()
		stderr.Close()
		_ = s.send(frame{Kind: "error"})
		return err
	}
	copying.Wait()
	if ctx.Err() != nil {
		return ctx.Err()
	}
	exitCode := 0
	if waitErr != nil {
		var exited *exec.ExitError
		if !errors.As(waitErr, &exited) {
			_ = s.send(frame{Kind: "error"})
			return protocolError()
		}
		exitCode = exited.ExitCode()
	}
	if start.Mode == "script" {
		if err = writeWorkspace(ctx, "/workspace", &workspaceFrameWriter{s: s}); err != nil {
			_ = s.send(frame{Kind: "error"})
			return protocolError()
		}
	}
	return s.send(frame{Kind: "exit", ExitCode: exitCode})
}
func stopDescendants() error {
	if os.Getpid() != 1 {
		return problem(403, "execution-supervisor-only", "执行监督器仅允许在专属容器中运行")
	}
	if err := syscall.Kill(-1, syscall.SIGKILL); err != nil && !errors.Is(err, syscall.ESRCH) {
		return protocolError()
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		for {
			var status syscall.WaitStatus
			pid, err := syscall.Wait4(-1, &status, syscall.WNOHANG, nil)
			if pid <= 0 || err != nil {
				break
			}
		}
		entries, err := os.ReadDir("/proc")
		if err != nil {
			return protocolError()
		}
		remaining := false
		for _, entry := range entries {
			pid, err := strconv.Atoi(entry.Name())
			if err == nil && pid > 1 {
				remaining = true
				break
			}
		}
		if !remaining {
			return nil
		}
		if time.Now().After(deadline) {
			return problem(503, "execution-stop-unconfirmed", "执行进程停止未确认")
		}
		time.Sleep(10 * time.Millisecond)
	}
}
func decodeFrame(raw []byte, f *frame) error {
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	if decoder.Decode(f) != nil {
		return protocolError()
	}
	var trailing any
	if !errors.Is(decoder.Decode(&trailing), io.EOF) {
		return protocolError()
	}
	return nil
}
func (s *supervisor) inputLoop() {
	for {
		select {
		case <-s.ctx.Done():
			return
		case f := <-s.input:
			if f.Kind == "stdin-close" {
				_ = s.stdin.Close()
				return
			}
			if _, err := s.stdin.Write(f.Data); err != nil {
				return
			}
		}
	}
}
func (s *supervisor) accept(f frame) error {
	switch f.Kind {
	case "stdin", "stdin-close":
		select {
		case s.input <- f:
			return nil
		default:
			return protocolError()
		}
	case "proxy-opened":
		s.mu.Lock()
		pending := s.pending[f.ID]
		delete(s.pending, f.ID)
		s.mu.Unlock()
		if pending == nil {
			// 已超时的拨号可以晚到，不能重建已关闭的隧道。
			return nil
		}
		pending <- f
		return nil
	case "proxy-data":
		s.mu.Lock()
		conn := s.tunnels[f.ID]
		s.mu.Unlock()
		if conn == nil {
			return nil
		}
		_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
		_, err := conn.Write(f.Data)
		if err != nil {
			s.closeTunnel(f.ID)
		}
		return nil
	case "proxy-close":
		s.closeTunnel(f.ID)
		return nil
	default:
		return protocolError()
	}
}
func (s *supervisor) copyStream(kind string, r io.Reader) error {
	b := make([]byte, 32<<10)
	for {
		n, err := r.Read(b)
		if n > 0 {
			if e := s.send(frame{Kind: kind, Data: b[:n]}); e != nil {
				return e
			}
		}
		if err != nil {
			return err
		}
	}
}

type workspaceFrameWriter struct{ s *supervisor }

func (w *workspaceFrameWriter) Write(b []byte) (int, error) {
	total := 0
	for len(b) > 0 {
		n := len(b)
		if n > 32<<10 {
			n = 32 << 10
		}
		if err := w.s.send(frame{Kind: "workspace", Data: b[:n]}); err != nil {
			return total, err
		}
		b = b[n:]
		total += n
	}
	return total, nil
}

func proxyID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return ""
	}
	return "proxy-" + hex.EncodeToString(b[:])
}
func (s *supervisor) handleProxy(w http.ResponseWriter, r *http.Request) {
	if r.Method == "CONNECT" {
		host, rawPort, err := net.SplitHostPort(r.Host)
		port, e := strconv.Atoi(rawPort)
		if err != nil || e != nil || port < 1 || port > 65535 {
			http.Error(w, "目标无效", http.StatusForbidden)
			return
		}
		h, ok := w.(http.Hijacker)
		if !ok {
			http.Error(w, "代理不可用", http.StatusBadGateway)
			return
		}
		conn, buffer, err := h.Hijack()
		if err != nil {
			return
		}
		id, err := s.openTunnel(conn, "https", strings.ToLower(host), port)
		if err != nil {
			_, _ = io.WriteString(conn, "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
			conn.Close()
			return
		}
		_, _ = io.WriteString(conn, "HTTP/1.1 200 Connection Established\r\n\r\n")
		s.forwardTunnel(id, conn, buffer)
		return
	}
	if r.URL == nil || r.URL.Scheme != "http" || r.URL.User != nil || r.URL.Fragment != "" {
		http.Error(w, "目标无效", http.StatusForbidden)
		return
	}
	host := strings.ToLower(r.URL.Hostname())
	port := 80
	if raw := r.URL.Port(); raw != "" {
		var err error
		port, err = strconv.Atoi(raw)
		if err != nil {
			http.Error(w, "目标无效", http.StatusForbidden)
			return
		}
	}
	if r.Header.Get("Upgrade") != "" {
		http.Error(w, "代理不支持升级", http.StatusForbidden)
		return
	}
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "代理不可用", http.StatusBadGateway)
		return
	}
	conn, buffer, err := hijacker.Hijack()
	if err != nil {
		return
	}
	id, err := s.openTunnel(conn, "http", host, port)
	if err != nil {
		_, _ = io.WriteString(conn, "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
		conn.Close()
		return
	}
	r.RequestURI = ""
	r.Header.Del("Proxy-Authorization")
	r.Header.Del("Proxy-Connection")
	r.Header.Set("Connection", "close")
	r.Close = true
	if err = r.Write(&proxyFrameWriter{s: s, id: id}); err != nil {
		s.closeTunnel(id)
		return
	}
	s.forwardTunnel(id, conn, buffer)
}
func (s *supervisor) openTunnel(conn net.Conn, scheme, host string, port int) (string, error) {
	id := proxyID()
	if id == "" {
		return "", protocolError()
	}
	pending := make(chan frame, 1)
	s.mu.Lock()
	if len(s.tunnels) >= 4 || len(s.pending) >= 4 {
		s.mu.Unlock()
		return "", protocolError()
	}
	s.pending[id] = pending
	s.tunnels[id] = conn
	s.mu.Unlock()
	if err := s.send(frame{Kind: "proxy-open", ID: id, Scheme: scheme, Host: host, Port: port}); err != nil {
		s.forgetTunnel(id)
		return "", err
	}
	select {
	case reply := <-pending:
		if reply.Error != "" {
			s.forgetTunnel(id)
			return "", protocolError()
		}
		return id, nil
	case <-time.After(10 * time.Second):
		s.forgetTunnel(id)
		return "", protocolError()
	case <-s.ctx.Done():
		s.forgetTunnel(id)
		return "", s.ctx.Err()
	}
}
func (s *supervisor) forgetTunnel(id string) {
	s.mu.Lock()
	delete(s.tunnels, id)
	delete(s.pending, id)
	s.mu.Unlock()
}
func (s *supervisor) forwardTunnel(id string, conn net.Conn, r io.Reader) {
	defer s.closeTunnel(id)
	_ = conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	_, _ = io.Copy(&proxyFrameWriter{s: s, id: id}, r)
	_ = s.send(frame{Kind: "proxy-close", ID: id})
}
func (s *supervisor) closeTunnel(id string) {
	s.mu.Lock()
	conn := s.tunnels[id]
	delete(s.tunnels, id)
	delete(s.pending, id)
	s.mu.Unlock()
	if conn != nil {
		_ = conn.Close()
	}
}

type proxyFrameWriter struct {
	s  *supervisor
	id string
}

func (w *proxyFrameWriter) Write(b []byte) (int, error) {
	total := 0
	for len(b) > 0 {
		n := len(b)
		if n > 32<<10 {
			n = 32 << 10
		}
		if err := w.s.send(frame{Kind: "proxy-data", ID: w.id, Data: b[:n]}); err != nil {
			return total, err
		}
		total += n
		b = b[n:]
	}
	return total, nil
}
