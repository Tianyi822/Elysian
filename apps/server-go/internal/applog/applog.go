// Package applog 是面板进程文本诊断日志的唯一出口：~/.Elysian/logs/panel.log 与
// stdout（systemd 下即 journal）双写、带大小轮转。它记录生命周期事件、失败请求
// 与 panic 栈——面板自身故障（例如 Web 界面不可用、SQLite 打不开）时，运维仍能
// 在文件系统上查到诊断线索，不依赖面板页面与 journalctl。
//
// 与 logs 域（data/logs.sqlite 的运行/操作/登录三表）职责不重叠：那是业务事件
// 记录，面向页面查询；本包是进程级诊断文本，面向 tail/grep。写入经标准 log 包
// （Open 时 log.SetOutput 双写），既有 log.Printf 生命周期输出自动落文件。
package applog

import (
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	// PanelLogName 文本日志文件名（位于 paths.LogsDir 下）。
	PanelLogName = "panel.log"
	// rotateThreshold 单文件轮转阈值：超过即改名备份并新开文件。
	rotateThreshold = 10 * 1024 * 1024
	// rotateBackups 保留的历史备份个数（panel.log.1；约 2×10 MiB 磁盘上限）。
	rotateBackups = 1
)

// Logger 文本日志写出器：作为 io.Writer 挂进标准 log 的多路输出，自带计数轮转。
// 零值与 nil 都安全（方法 no-op），未 Open 时全进程写 stdout 不受影响。
type Logger struct {
	mu        sync.Mutex
	path      string
	file      *os.File
	size      int64
	threshold int64
}

// defaultLogger Open 写入的进程级实例；方法全部 nil 安全。
var defaultLogger atomic.Pointer[Logger]

// Default 取进程级文本日志实例；未 Open 过时返回 nil（调用侧无需判空）。
func Default() *Logger {
	return defaultLogger.Load()
}

// Open 打开（必要时创建）dir/panel.log 并接管标准 log 输出为
// stdout＋文件双写；失败返回错误，调用方仅告警、不得阻断启动。
// 重复调用时先关闭旧实例再接管，幂等。
func Open(dir string) (*Logger, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("创建日志目录失败：%w", err)
	}
	path := filepath.Join(dir, PanelLogName)
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return nil, fmt.Errorf("打开日志文件失败：%w", err)
	}
	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return nil, fmt.Errorf("读取日志文件状态失败：%w", err)
	}
	logger := &Logger{path: path, file: file, size: info.Size(), threshold: rotateThreshold}
	if old := defaultLogger.Swap(logger); old != nil {
		_ = old.Close()
	}
	log.SetOutput(io.MultiWriter(os.Stdout, logger))
	return logger, nil
}

// Close 关闭文件并复位标准 log 输出；幂等。
func (l *Logger) Close() error {
	if l == nil {
		return nil
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.file == nil {
		return nil
	}
	err := l.file.Close()
	l.file = nil
	if current := defaultLogger.Load(); current == l {
		log.SetOutput(os.Stdout)
	}
	return err
}

// Write 实现 io.Writer：写文件并计数，超阈值轮转；未打开时吞写（stdout 由
// MultiWriter 另一路负责，不丢日志）。
func (l *Logger) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.file == nil {
		return len(p), nil
	}
	n, err := l.file.Write(p)
	l.size += int64(n)
	if l.threshold <= 0 {
		l.threshold = rotateThreshold
	}
	if l.size > l.threshold {
		l.rotateLocked()
	}
	if err != nil {
		return n, err
	}
	return len(p), nil
}

// rotateLocked 超阈值轮转：panel.log → panel.log.1（os.Rename 在 POSIX 上原子覆盖
// 旧备份，磁盘上限约 threshold×(1+rotateBackups)）；新开当前文件，新开失败时置空
// 文件句柄（后续写吞掉，stdout 一路仍在）。
func (l *Logger) rotateLocked() {
	_ = l.file.Close()
	l.file = nil
	for i := rotateBackups; i >= 2; i-- {
		_ = os.Rename(fmt.Sprintf("%s.%d", l.path, i-1), fmt.Sprintf("%s.%d", l.path, i))
	}
	if err := os.Rename(l.path, l.path+".1"); err != nil {
		return
	}
	file, err := os.OpenFile(l.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return
	}
	l.file = file
	l.size = 0
}

// Printf 记一条任意格式化文本（经标准 log 双写 stdout＋文件）；nil 安全。
func (l *Logger) Printf(format string, args ...any) {
	if l == nil {
		return
	}
	log.Printf(format, args...)
}

// RequestFailure 记一条失败请求行（状态 ≥400）。请求 ID 不进任何持久化日志
// （middleware.RequestID 的既定红线），只有方法、路径、状态与耗时。
func (l *Logger) RequestFailure(method, path string, status int, duration time.Duration) {
	if l == nil {
		return
	}
	log.Printf("HTTP %s %s %d %s", method, path, status, duration.Round(time.Millisecond))
}

// PanicStack 把 panic 栈写入文本日志（多行原样保留）。
func (l *Logger) PanicStack(stack []byte) {
	if l == nil || len(stack) == 0 {
		return
	}
	log.Printf("panic 栈：\n%s", stack)
}

// FailureLogMiddleware 失败请求中间件：/api/* 且最终状态 ≥400 时记一行文本日志。
// 挂在装配层最外层组（RequestID/StripTailSlash 之后、域挂载之外），覆盖未匹配
// /api 的 404 兜底与登录端点。成功请求不记（GET 审计本就不记、写方法已有操作
// 日志），日志量以「排障够用、不刷屏」为准。
func FailureLogMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/api/") {
			next.ServeHTTP(w, r)
			return
		}
		start := time.Now()
		recorder := &failureStatusRecorder{ResponseWriter: w}
		next.ServeHTTP(recorder, r)
		if recorder.status >= http.StatusBadRequest {
			Default().RequestFailure(r.Method, r.URL.Path, recorder.status, time.Since(start))
		}
	})
}

// failureStatusRecorder 记录最终状态码的响应写出器；Flush/Unwrap 透传，
// SSE 等流式端点不受包装影响（与 logs.statusRecorder 同形）。
type failureStatusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *failureStatusRecorder) Unwrap() http.ResponseWriter { return r.ResponseWriter }

func (r *failureStatusRecorder) WriteHeader(code int) {
	if r.status == 0 {
		r.status = code
	}
	r.ResponseWriter.WriteHeader(code)
}

func (r *failureStatusRecorder) Flush() {
	if f, ok := r.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}
