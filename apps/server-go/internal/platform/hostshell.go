package platform

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"elysian/server/internal/seam"
	"elysian/server/internal/shared"
)

// 宿主命令执行器（hostShell.ts 逐字移植）：在宿主上执行一段固定脚本。进程不在容器
// 里时直接 /bin/sh 执行（裸机部署）。进程在容器里时，面板自己没有宿主的包管理器，
// 改经已经挂上的引擎 socket 起一个一次性特权容器：alpine 只提供 nsenter，进去之后
// 跑的是宿主的 /bin/sh。Caddy 不会装进这个容器，用完即删。引擎 socket 本身就是宿主
// 根权限；这里不接受请求里的命令，只跑调用方给的常量脚本。

const (
	// setupImage 一次性宿主执行容器的镜像（只提供 nsenter）。
	setupImage = "alpine:3.20"
	// setupName 一次性容器名（重名残留先强删再重试一次）。
	setupName = "elysian-host-setup"
	// outputTail 输出尾部保留字符数（rune 语义）。
	outputTail = 32000
	// maxOutputBytes 对齐 Node execFile maxBuffer：stdout 或 stderr 任一超限即杀进程。
	maxOutputBytes = 1024 * 1024
	// engineCallMaxBytes 引擎调用响应体上限（hostShell 的 call 恒 1 MiB）。
	engineCallMaxBytes = 1_048_576
	// pullMaxBytes 镜像拉取进度流上限。
	pullMaxBytes = 32 * 1024 * 1024
)

// 引擎调用各步超时。
const (
	timeoutImageInspect = 15 * time.Second
	timeoutImagePull    = 120 * time.Second
	timeoutCreate       = 30 * time.Second
	timeoutDelete       = 15 * time.Second
	timeoutStart        = 30 * time.Second
	timeoutLogs         = 15 * time.Second
)

// containerIDPattern 引擎返回的容器 Id 形状。
var containerIDPattern = regexp.MustCompile(`^[a-f0-9]{12,64}$`)

// engineErrorBodyPattern 拉取进度输出里出现引擎错误帧。
var engineErrorBodyPattern = regexp.MustCompile(`"error"\s*:`)

// hostExecExit 本机命令以数字退出码结束（对齐 Node execFile 拒绝时携带的
// code/stdout/stderr）。
type hostExecExit struct {
	Code   int
	Stdout string
	Stderr string
}

func (e *hostExecExit) Error() string {
	return "命令以退出码 " + strconv.Itoa(e.Code) + " 结束"
}

// hostExecTimeout 本机命令超时被杀（对齐 Node killed === true / code === 'ETIMEDOUT'；
// maxBuffer 溢出的 kill 同形态，故输出溢出同样落进超时文案）。
type hostExecTimeout struct{}

func (e *hostExecTimeout) Error() string { return "命令超时" }

// execCommand 本机执行原语（对齐 TS execFile 注入面）：以给定 env 执行命令；成功返回
// stdout/stderr；失败以 *hostExecExit / *hostExecTimeout / 其他错误（无法启动）报告。
type execCommand func(file string, args []string, env []string, timeout time.Duration) (stdout, stderr string, err error)

// minimalEnv 宿主脚本的最小环境：进程环境不传入（ELYSIAN_* 不泄漏给宿主脚本，
// hostShell.test.ts:13-36 红线）。
func minimalEnv() []string {
	return []string{
		"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		"DEBIAN_FRONTEND=noninteractive",
		"LANG=C.UTF-8",
	}
}

// capTail 输出清洗：剥 NUL，超长取尾部 32000 字符。
func capTail(text string) string {
	cleaned := strings.ReplaceAll(text, "\x00", "")
	return truncateTailRunes(cleaned, outputTail)
}

// hostRunnerOptions 执行器依赖：inContainer 分支判定、引擎传输器工厂与本机执行原语。
type hostRunnerOptions struct {
	inContainer     bool
	createTransport func() seam.DockerTransport
	exec            execCommand // nil 用真实执行
}

type hostRunner struct {
	opts hostRunnerOptions
}

func newHostRunner(opts hostRunnerOptions) *hostRunner { return &hostRunner{opts: opts} }

// run 在宿主上执行一段脚本：裸机分支直接 /bin/sh；容器分支经引擎起一次性特权容器。
func (r *hostRunner) run(script string, timeout time.Duration) (hostCommandResult, error) {
	if !r.opts.inContainer {
		return r.runOnHost(script, timeout)
	}
	result, err := r.runViaEngine(script, timeout)
	if err != nil {
		return hostCommandResult{}, asEngineError(err)
	}
	return result, nil
}

// runOnHost 裸机分支：固定参数与最小环境执行 /bin/sh -c。
func (r *hostRunner) runOnHost(script string, timeout time.Duration) (hostCommandResult, error) {
	execFn := r.opts.exec
	if execFn == nil {
		execFn = realExecCommand
	}
	stdout, stderr, err := execFn("/bin/sh", []string{"-c", script}, minimalEnv(), timeout)
	if err == nil {
		return hostCommandResult{Code: 0, Output: capTail(stdout + "\n" + stderr)}, nil
	}
	var timedOut *hostExecTimeout
	if errors.As(err, &timedOut) {
		return hostCommandResult{}, &hostCommandError{setupFailureTimeout}
	}
	var exited *hostExecExit
	if errors.As(err, &exited) {
		return hostCommandResult{Code: exited.Code, Output: capTail(exited.Stdout + "\n" + exited.Stderr)}, nil
	}
	// 进程根本没跑起来（如 /bin/sh 缺失）。
	return hostCommandResult{}, &hostCommandError{setupFailureHost}
}

// realExecCommand 真实本机执行：复刻 Node execFile 语义——超时杀进程、stdout/stderr
// 任一超 1 MiB 杀进程（归为超时文案）、信号终止按「无法在本机执行」收口。
func realExecCommand(file string, args []string, env []string, timeout time.Duration) (string, string, error) {
	cmd := exec.Command(file, args...)
	cmd.Env = env
	// Start 在返回前即可启动输出复制协程；终止回调必须随缓冲区一起发布，
	// 不能在 Start 后无锁写入。输出复制开始时 Process 已由 os/exec 初始化。
	kill := func() { _ = cmd.Process.Kill() }
	stdout := &cappedBuffer{limit: maxOutputBytes, kill: kill}
	stderr := &cappedBuffer{limit: maxOutputBytes, kill: kill}
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		return "", "", err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-timer.C:
		kill()
		<-done
		return stdout.String(), stderr.String(), &hostExecTimeout{}
	case err := <-done:
		if stdout.overflow || stderr.overflow {
			// 输出超限的进程已被杀：Node 的 killed 形态归为超时文案。
			return stdout.String(), stderr.String(), &hostExecTimeout{}
		}
		if err != nil {
			var exitErr *exec.ExitError
			if errors.As(err, &exitErr) {
				if code := exitErr.ExitCode(); code >= 0 {
					return "", "", &hostExecExit{Code: code, Stdout: stdout.String(), Stderr: stderr.String()}
				}
				// 信号终止：Node 侧 code 为 null（非数字）→ 按无法执行收口。
				return "", "", err
			}
			return "", "", err
		}
		return stdout.String(), stderr.String(), nil
	}
}

// cappedBuffer 限量缓冲：超限即标记溢出并杀进程，之后继续吞字节以排空管道。
type cappedBuffer struct {
	mu       sync.Mutex
	buf      bytes.Buffer
	limit    int
	overflow bool
	kill     func()
}

func (b *cappedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.overflow {
		return len(p), nil
	}
	if b.buf.Len()+len(p) > b.limit {
		b.overflow = true
		if space := b.limit - b.buf.Len(); space > 0 {
			b.buf.Write(p[:space])
		}
		if b.kill != nil {
			b.kill()
		}
		return len(p), nil
	}
	return b.buf.Write(p)
}

func (b *cappedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// asEngineError 引擎连接失败归类：连接类 errno（比探测多一个 ENOTSOCK）→ 引擎文案，
// 其余 → 环境准备失败；hostCommandError 原样返回。socket 路径绝不透传。
func asEngineError(err error) error {
	var hce *hostCommandError
	if errors.As(err, &hce) {
		return hce
	}
	var errno syscall.Errno
	if errors.As(err, &errno) {
		switch errno {
		case syscall.ENOENT, syscall.EACCES, syscall.ECONNREFUSED, syscall.ENOTSOCK:
			return &hostCommandError{setupFailureEngine}
		}
		return &hostCommandError{setupFailureImage}
	}
	return &hostCommandError{setupFailureImage}
}

// engineCall 一次引擎请求；传输层错误一律先过 asEngineError 归类。
func engineCall(transport seam.DockerTransport, method, path string, query url.Values, timeout time.Duration, body []byte) (seam.EngineResponse, error) {
	response, err := transport.Request(context.Background(), seam.EngineRequest{
		Method:   method,
		Path:     path,
		Query:    query,
		Body:     body,
		Timeout:  timeout,
		MaxBytes: engineCallMaxBytes,
	})
	if err != nil {
		return seam.EngineResponse{}, asEngineError(err)
	}
	return response, nil
}

// ensureImage 镜像已在即过；否则经引擎拉取（状态非 200 或进度含错误帧即失败）。
func ensureImage(transport seam.DockerTransport) error {
	response, err := engineCall(transport, http.MethodGet,
		"/images/"+url.QueryEscape(setupImage)+"/json", nil, timeoutImageInspect, nil)
	if err != nil {
		return err
	}
	if response.Status == http.StatusOK {
		return nil
	}
	pulled, err := transport.Stream(context.Background(), seam.EngineRequest{
		Method:   http.MethodPost,
		Path:     "/images/create",
		Query:    url.Values{"fromImage": {"alpine"}, "tag": {"3.20"}},
		Timeout:  timeoutImagePull,
		MaxBytes: pullMaxBytes,
	}, nil)
	if err != nil {
		return asEngineError(err)
	}
	if pulled.Status != http.StatusOK || engineErrorBodyPattern.Match(pulled.Body) {
		return &hostCommandError{setupFailureImage}
	}
	return nil
}

// containerHostConfig 一次性容器的主机配置。
type containerHostConfig struct {
	Privileged  bool   `json:"Privileged"`
	PidMode     string `json:"PidMode"`
	NetworkMode string `json:"NetworkMode"`
	AutoRemove  bool   `json:"AutoRemove"`
}

// containerCreateBody 一次性宿主执行容器的创建体；Tty 让 logs 是纯文本而非带 8 字节
// 头的多路复用流。
type containerCreateBody struct {
	Image      string              `json:"Image"`
	Tty        bool                `json:"Tty"`
	Entrypoint []string            `json:"Entrypoint"`
	Cmd        []string            `json:"Cmd"`
	HostConfig containerHostConfig `json:"HostConfig"`
}

func containerBody(script string) ([]byte, error) {
	return shared.MarshalJSON(containerCreateBody{
		Image:      setupImage,
		Tty:        true,
		Entrypoint: []string{"nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p", "--", "/bin/sh", "-c"},
		Cmd:        []string{script},
		HostConfig: containerHostConfig{
			Privileged:  true,
			PidMode:     "host",
			NetworkMode: "host",
			AutoRemove:  false,
		},
	})
}

// containerIDOf 从创建响应取形状合法的容器 Id。
func containerIDOf(body []byte) string {
	var parsed struct {
		ID string `json:"Id"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return ""
	}
	if containerIDPattern.MatchString(parsed.ID) {
		return parsed.ID
	}
	return ""
}

// createContainer 创建一次性容器；409（重名残留）先强删再重试一次。
func createContainer(transport seam.DockerTransport, script string) (string, error) {
	body, err := containerBody(script)
	if err != nil {
		return "", err
	}
	response, err := engineCall(transport, http.MethodPost, "/containers/create",
		url.Values{"name": {setupName}}, timeoutCreate, body)
	if err != nil {
		return "", err
	}
	if response.Status == http.StatusConflict {
		// 删除失败忽略（对齐 TS .catch(() => undefined)）。
		_, _ = engineCall(transport, http.MethodDelete, "/containers/"+setupName,
			url.Values{"force": {"1"}}, timeoutDelete, nil)
		response, err = engineCall(transport, http.MethodPost, "/containers/create",
			url.Values{"name": {setupName}}, timeoutCreate, body)
		if err != nil {
			return "", err
		}
	}
	id := containerIDOf(response.Body)
	if (response.Status != http.StatusCreated && response.Status != http.StatusOK) || id == "" {
		return "", &hostCommandError{setupFailureImage}
	}
	return id, nil
}

// waitStatusCode 从 wait 响应取退出码（缺字段或非数字同判失败）。
func waitStatusCode(body []byte) (int, bool) {
	var parsed struct {
		StatusCode *float64 `json:"StatusCode"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil || parsed.StatusCode == nil {
		return 0, false
	}
	return int(*parsed.StatusCode), true
}

// runViaEngine 容器分支：inspect →（按需 pull）→ create（409 先强删再重试一次）→
// start → wait（超时即步骤超时）→ logs → finally 恒删容器。
func (r *hostRunner) runViaEngine(script string, timeout time.Duration) (hostCommandResult, error) {
	transport := r.opts.createTransport()
	if err := ensureImage(transport); err != nil {
		return hostCommandResult{}, err
	}
	id, err := createContainer(transport, script)
	if err != nil {
		return hostCommandResult{}, err
	}
	defer func() {
		// 无论成败都删容器。
		_, _ = engineCall(transport, http.MethodDelete, "/containers/"+id,
			url.Values{"force": {"1"}}, timeoutDelete, nil)
	}()
	started, err := engineCall(transport, http.MethodPost, "/containers/"+id+"/start", nil, timeoutStart, nil)
	if err != nil {
		return hostCommandResult{}, err
	}
	if started.Status != http.StatusNoContent && started.Status != http.StatusOK {
		return hostCommandResult{}, &hostCommandError{setupFailureImage}
	}
	waited, err := engineCall(transport, http.MethodPost, "/containers/"+id+"/wait", nil, timeout, nil)
	if err != nil {
		return hostCommandResult{}, err
	}
	statusCode, ok := waitStatusCode(waited.Body)
	if waited.Status != http.StatusOK || !ok {
		return hostCommandResult{}, &hostCommandError{setupFailureImage}
	}
	output := ""
	logs, logsErr := transport.Stream(context.Background(), seam.EngineRequest{
		Method:   http.MethodGet,
		Path:     "/containers/" + id + "/logs",
		Query:    url.Values{"stdout": {"1"}, "stderr": {"1"}},
		Timeout:  timeoutLogs,
		MaxBytes: engineCallMaxBytes,
	}, nil)
	if logsErr == nil && logs.Status == http.StatusOK {
		output = string(logs.Body)
	}
	return hostCommandResult{Code: statusCode, Output: capTail(output)}, nil
}
