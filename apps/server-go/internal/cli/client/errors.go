package client

import (
	"context"
	"errors"
	"fmt"
	"net"
	"syscall"
)

// Kind 连接与服务错误分类（CLI 方案 §3.1 的五态口径）：未启动／连接异常／无权限／
// Agent 服务不可用与一般服务端错误；「运行失败」态由 RunOutcome 从 Run 终态判定，
// 不是传输层错误。TUI 按 Kind 给出可操作中文提示，不崩溃。
type Kind int

const (
	// KindNotRunning 连接拒绝（端口无人监听）：面板未启动。
	KindNotRunning Kind = iota + 1
	// KindUnreachable 超时、非 HTTP 响应或端口配置损坏：连接异常。
	KindUnreachable
	// KindUnauthorized 401：未登录或会话已失效（被顶／过期／改密）。
	KindUnauthorized
	// KindForbidden 403：同源守卫拒绝，CLI 与面板版本可能错位。
	KindForbidden
	// KindUnavailable 503：Agent 服务不可用（装配失败或存储冻结）。
	KindUnavailable
	// KindServer 其余服务端拒绝（4xx/5xx），消息取服务端中文原文。
	KindServer
	// KindBadResponse 响应体不符合契约（2xx 但解析失败）。
	KindBadResponse
)

// Error 是 client 层唯一错误类型：Kind 驱动界面提示，Message 为中文归因（有服务端
// 响应时取其原文），Hint 是可操作提示（如启动指引）。Error() 只回 Message，Hint 由
// 视图层单独呈现。
type Error struct {
	Kind       Kind
	Status     int
	Code       string
	Message    string
	Hint       string
	RetryAfter int // 登录限流 429 的建议等待秒数（服务端 Retry-After 头）
}

func (e *Error) Error() string { return e.Message }

// HintFor 五态提示映射（CLI 方案 §3.1）：给运维下一步动作，不替用户执行。
func HintFor(kind Kind) string {
	switch kind {
	case KindNotRunning:
		return "面板未启动：sudo systemctl status elysian / sudo systemctl start elysian"
	case KindUnreachable:
		return "连接异常：检查 panel-network.json 端口与占用（sudo ss -ltnp）"
	case KindUnauthorized:
		return "未登录或会话已过期，请重新登录"
	case KindForbidden:
		return "请求来源校验失败：CLI 与面板版本可能错位，请升级：bash scripts/install.sh"
	case KindUnavailable:
		return "Agent 服务不可用"
	default:
		return ""
	}
}

// classifyTransport 把网络层错误归入五态：连接拒绝判未启动（唯一可断定端口无人
// 监听的形态），超时与其余网络错误判连接异常（不掩盖真实故障形态）。
func classifyTransport(err error) *Error {
	classified := &Error{Kind: KindUnreachable, Message: "无法连接面板后端", Hint: HintFor(KindUnreachable)}
	if errors.Is(err, syscall.ECONNREFUSED) {
		classified.Kind = KindNotRunning
		classified.Message = "面板后端连接被拒绝"
		classified.Hint = HintFor(KindNotRunning)
		return classified
	}
	if errors.Is(err, context.DeadlineExceeded) {
		classified.Message = "连接面板后端超时"
		return classified
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		classified.Message = "连接面板后端超时"
		return classified
	}
	if reason := err.Error(); reason != "" {
		classified.Message = "连接面板后端失败：" + reason
	}
	return classified
}

// serverError 按状态码归类服务端拒绝并解析 {error,code} 正文；正文缺失时以状态行
// 归因，不静默吞错。
func serverError(status int, body []byte, retryAfter int) *Error {
	e := &Error{Status: status, RetryAfter: retryAfter}
	switch {
	case status == 401:
		e.Kind = KindUnauthorized
	case status == 403:
		e.Kind = KindForbidden
	case status == 503:
		e.Kind = KindUnavailable
	default:
		e.Kind = KindServer
	}
	var parsed struct {
		Error string `json:"error"`
		Code  string `json:"code"`
	}
	_ = decodeJSON(body, &parsed)
	e.Code = parsed.Code
	switch {
	case parsed.Error != "":
		e.Message = parsed.Error
	case status == 404:
		e.Message = fmt.Sprintf("请求的对象不存在（HTTP %d）", status)
	default:
		e.Message = fmt.Sprintf("面板返回 HTTP %d", status)
	}
	e.Hint = HintFor(e.Kind)
	if e.Kind == KindUnavailable && parsed.Error != "" {
		// 503 的服务端正文即不可用原因（如装配失败 reason），提示保留正文。
		e.Hint = "Agent 服务不可用：" + parsed.Error
	}
	return e
}
