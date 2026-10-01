package websites

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"syscall"
	"time"

	"elysian/server/internal/seam"
)

/*
 * Caddy admin 客户端（websitesCaddy.ts 逐字移植）：HTTP-over-unix-socket，模式照
 * dockerTransport 的 requestOverSocket（零新依赖）。宿主 Caddy 的 admin 端点绑在
 * 专属目录下的 unix socket（缺省 /run/caddy/admin.sock，ELYSIAN_CADDY_SOCKET 可
 * 覆盖——本域不读 env，路径由装配层经 config.CaddySocket 注入），compose 以目录级
 * bind 把 /run/caddy 挂进面板容器——caddy 重启会以新 inode 重建 socket 文件，目录级
 * bind 下文件替换对容器立即可见。
 */

// CaddyDefaultSocketPath Caddy admin socket 缺省路径（config.CaddySocket 的缺省同值）。
const CaddyDefaultSocketPath = "/run/caddy/admin.sock"

// caddyTimeoutMs 请求超时：5 秒。
const caddyTimeout = 5 * time.Second

// caddyMaxBytes 响应上限：4 MiB。
const caddyMaxBytes = 4 * 1024 * 1024

// CaddyAdminListen admin 监听地址（Caddy 配置 JSON 的 admin.listen 取值）：
// `unix/<socket 路径>`。
func CaddyAdminListen(socketPath string) string {
	return "unix/" + socketPath
}

// caddyClient seam.CaddyAdmin 的 HTTP-over-unix 实现（本域实现、platform 探测消费）。
type caddyClient struct {
	socketPath string
	client     *http.Client
	// requestFunc 测试注入：替换 socket 上的 HTTP 实现；nil 用真实拨号。
	requestFunc func(req *http.Request) (*http.Response, error)
}

// NewCaddyAdmin 按固定 socket 路径构造通道客户端。
func NewCaddyAdmin(socketPath string) seam.CaddyAdmin {
	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			dialer := &net.Dialer{}
			return dialer.DialContext(ctx, "unix", socketPath)
		},
		DisableCompression: true,
		ForceAttemptHTTP2:  false,
	}
	return &caddyClient{
		socketPath: socketPath,
		client:     &http.Client{Transport: transport, Timeout: caddyTimeout},
	}
}

// caddyAdminFactory seam.CaddyAdminFactory 实现：每次调用产出独立通道客户端
// （platform 探测不缓存连接状态）。
type caddyAdminFactory struct{}

// New 返回按 socket 路径拨号的新客户端。
func (caddyAdminFactory) New(socketPath string) seam.CaddyAdmin {
	return NewCaddyAdmin(socketPath)
}

// NewCaddyAdminFactory platform 依赖探测共用的工厂出口（go-plan §3.8）。
func NewCaddyAdminFactory() seam.CaddyAdminFactory { return caddyAdminFactory{} }

// classifyChannelError 通道侧错误归一：连接类 errno（ENOENT/EACCES/ECONNREFUSED）
// 整体归类 unavailable（不逐码对外区分，中文 detail 只有一种）；超时给固定文案；
// 其余带 errno 的保留原始原因（非连接类，如 ENOTSOCK）。
func classifyChannelError(err error) *seam.CaddyChannelError {
	if err == nil {
		return nil
	}
	if channel, ok := err.(*seam.CaddyChannelError); ok {
		return channel
	}
	for _, code := range []syscall.Errno{syscall.ENOENT, syscall.EACCES, syscall.ECONNREFUSED} {
		if errors.Is(err, code) {
			return &seam.CaddyChannelError{Unavailable: true, Code: errnoName(code), Message: seam.CaddyChannelUnavailableDetail}
		}
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return &seam.CaddyChannelError{Unavailable: false, Message: "Caddy 请求超时"}
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return &seam.CaddyChannelError{Unavailable: false, Message: "Caddy 请求超时"}
	}
	var errno syscall.Errno
	if errors.As(err, &errno) {
		return &seam.CaddyChannelError{Unavailable: false, Code: errnoName(errno), Message: err.Error()}
	}
	return &seam.CaddyChannelError{Unavailable: false, Message: err.Error()}
}

// errnoName 常见 errno 的符号名（诊断归因）；未列出的回 "errno"。
func errnoName(code syscall.Errno) string {
	switch code {
	case syscall.ENOENT:
		return "ENOENT"
	case syscall.EACCES:
		return "EACCES"
	case syscall.ECONNREFUSED:
		return "ECONNREFUSED"
	default:
		return code.Error()
	}
}

// guardedRequest 执行一次 socket 请求并读全响应：超限「Caddy 响应过大」、坏 JSON
// 「Caddy 响应不是有效 JSON」、空体回 nil。
func (c *caddyClient) guardedRequest(ctx context.Context, method, path string, body []byte) (int, any, error) {
	var payload io.Reader
	if body != nil {
		payload = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, "http://localhost"+path, payload)
	if err != nil {
		return 0, nil, classifyChannelError(err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
		req.ContentLength = int64(len(body))
	}
	var response *http.Response
	if c.requestFunc != nil {
		response, err = c.requestFunc(req)
	} else {
		response, err = c.client.Do(req)
	}
	if err != nil {
		return 0, nil, classifyChannelError(err)
	}
	defer response.Body.Close()
	data, err := readLimited(response.Body, caddyMaxBytes)
	if err != nil {
		return 0, nil, classifyChannelError(err)
	}
	if len(data) == 0 {
		return response.StatusCode, nil, nil
	}
	var parsed any
	if err := json.Unmarshal(data, &parsed); err != nil {
		return 0, nil, classifyChannelError(errors.New("Caddy 响应不是有效 JSON"))
	}
	return response.StatusCode, parsed, nil
}

// readLimited 读全响应体，超限报「Caddy 响应过大」。
func readLimited(body io.Reader, maxBytes int64) ([]byte, error) {
	data := make([]byte, 0, 8*1024)
	buf := make([]byte, 32*1024)
	for {
		n, err := body.Read(buf)
		if n > 0 {
			if int64(len(data)+n) > maxBytes {
				return nil, errors.New("Caddy 响应过大")
			}
			data = append(data, buf[:n]...)
		}
		if err == io.EOF {
			return data, nil
		}
		if err != nil {
			return nil, err
		}
	}
}

// Load 整配置原子替换（POST /load，失败由 Caddy 自动回滚不停机）。非 2xx 抛通道错误，
// 只回状态码不透传响应体——隐去 Caddy 原始响应避免回显 PEM 私钥。
func (c *caddyClient) Load(ctx context.Context, config []byte) *seam.CaddyChannelError {
	if ctx == nil {
		ctx = context.Background()
	}
	status, _, err := c.guardedRequest(ctx, http.MethodPost, "/load", config)
	if err != nil {
		return classifyChannelError(err)
	}
	if status < 200 || status >= 300 {
		return &seam.CaddyChannelError{
			Unavailable: false,
			Message:     fmt.Sprintf("Caddy 拒绝路由或证书配置（HTTP %d）", status),
		}
	}
	return nil
}

// CurrentConfig 读取当前完整配置（GET /config/），兼作通道探测；连接类失败
// unavailable 为真。
func (c *caddyClient) CurrentConfig(ctx context.Context) (json.RawMessage, *seam.CaddyChannelError) {
	if ctx == nil {
		ctx = context.Background()
	}
	status, parsed, err := c.guardedRequest(ctx, http.MethodGet, "/config/", nil)
	if err != nil {
		return nil, classifyChannelError(err)
	}
	if status != http.StatusOK {
		return nil, &seam.CaddyChannelError{
			Unavailable: false,
			Message:     engineErrorMessage(parsed, fmt.Sprintf("HTTP %d", status)),
		}
	}
	if parsed == nil {
		return json.RawMessage("null"), nil
	}
	data, err := marshalJSONCompact(parsed)
	if err != nil {
		return nil, &seam.CaddyChannelError{Unavailable: false, Message: err.Error()}
	}
	return json.RawMessage(data), nil
}

// proxyStatusFromAnyError 非通道错误兜底映射：unavailable + 原始消息。
func proxyStatusFromAnyError(err error) websiteProxyStatus {
	detail := err.Error()
	return websiteProxyStatus{State: ProxyStateUnavailable, Detail: &detail}
}

// caddyChannelStatus 通道侧错误 → 代理状态报告的唯一映射：连接类失败给固定中文
// detail，引擎侧失败带引擎消息。服务层（列表探测、对账返回）消费本函数，映射与
// 文案不落第二份。
func caddyChannelStatus(err error) websiteProxyStatus {
	if err == nil {
		return websiteProxyStatus{State: ProxyStateUnavailable}
	}
	var channel *seam.CaddyChannelError
	if errors.As(err, &channel) {
		if channel.Unavailable {
			detail := seam.CaddyChannelUnavailableDetail
			return websiteProxyStatus{State: ProxyStateUnavailable, Detail: &detail}
		}
		detail := channel.Message
		return websiteProxyStatus{State: ProxyStateUnavailable, Detail: &detail}
	}
	return proxyStatusFromAnyError(err)
}
