// Package webfetch 提供有界、仅公网的 HTTP 网页读取，不执行网页代码。
package webfetch

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	execconfig "elysian/server/internal/agent/execution/config"
	"golang.org/x/net/idna"
)

const (
	URLBytes      = 4096
	ResponseBytes = 2 << 20
	TextBytes     = 32 << 10
	MaxLinks      = 20
	Timeout       = 20 * time.Second
	MaxRedirects  = 5
	resultBytes   = 256 << 10
)

// Error 只保存允许公开的错误，不持有网络诊断或服务端错误正文。
type Error struct {
	Code    string
	Message string
}

func (e *Error) Error() string            { return e.Message }
func failure(code, message string) *Error { return &Error{Code: code, Message: message} }

type Link struct {
	URL  string `json:"url"`
	Text string `json:"text"`
}

type Result struct {
	URL         string `json:"url"`
	FinalURL    string `json:"finalUrl"`
	StatusCode  int    `json:"statusCode"`
	ContentType string `json:"contentType"`
	Title       string `json:"title"`
	Text        string `json:"text"`
	Links       []Link `json:"links"`
	FetchedAt   string `json:"fetchedAt"`
	Truncated   bool   `json:"truncated"`
}

// Options 的网络接缝只供宿主注入；模型不能提供 Transport、请求头或解析策略。
type Options struct {
	LookupIP    func(context.Context, string) ([]net.IPAddr, error)
	DialContext func(context.Context, string, string) (net.Conn, error)
	Now         func() time.Time
}

type Client struct{ options Options }

func New(options Options) *Client {
	if options.LookupIP == nil {
		options.LookupIP = net.DefaultResolver.LookupIPAddr
	}
	if options.DialContext == nil {
		options.DialContext = (&net.Dialer{Timeout: 10 * time.Second}).DialContext
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	return &Client{options: options}
}

// normalizeURL 不查询网络；所有 DNS 结果在实际连接前复核。
func normalizeURL(raw string) (*url.URL, error) {
	if len(raw) > URLBytes || !utf8.ValidString(raw) {
		return nil, failure("web-invalid-url", "网址无效或超过 4096 字节")
	}
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u == nil || u.Opaque != "" || u.User != nil || u.Host == "" {
		return nil, failure("web-invalid-url", "请输入不含登录凭据的完整 HTTP 或 HTTPS 网址")
	}
	u.Scheme = strings.ToLower(u.Scheme)
	if u.Scheme != "http" && u.Scheme != "https" {
		return nil, failure("web-invalid-url", "只支持 HTTP 或 HTTPS 网址")
	}
	host := strings.TrimSuffix(strings.ToLower(u.Hostname()), ".")
	if host == "" || strings.ContainsAny(host, "%\\") || strings.HasSuffix(u.Host, ":") {
		return nil, failure("web-invalid-url", "网址的主机或端口无效")
	}
	if addr, err := netip.ParseAddr(host); err == nil {
		if execconfig.CheckPublicNetworkAddress(addr) != nil {
			return nil, failure("web-address-denied", "只允许公网网址，禁止访问私网、回环、元数据或特殊地址")
		}
		host = addr.Unmap().String()
	} else {
		host, err = idna.Lookup.ToASCII(host)
		if err != nil || len(host) > 253 || host == "localhost" || strings.HasSuffix(host, ".localhost") || host == "metadata.google.internal" {
			return nil, failure("web-address-denied", "网址主机无效或属于禁止访问的地址")
		}
	}
	port := u.Port()
	if port != "" {
		p, err := strconv.Atoi(port)
		if err != nil || p < 1 || p > 65535 {
			return nil, failure("web-invalid-url", "网址端口必须为 1 到 65535")
		}
		u.Host = net.JoinHostPort(host, strconv.Itoa(p))
	} else if strings.Contains(host, ":") {
		u.Host = "[" + host + "]"
	} else {
		u.Host = host
	}
	u.Fragment, u.RawFragment = "", ""
	if len(u.String()) > URLBytes {
		return nil, failure("web-invalid-url", "规范化后的网址超过 4096 字节")
	}
	return u, nil
}

func (c *Client) dial(ctx context.Context, _, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, failure("web-invalid-url", "网址主机或端口无效")
	}
	var ips []net.IPAddr
	if addr, parseErr := netip.ParseAddr(host); parseErr == nil {
		ips = []net.IPAddr{{IP: net.IP(addr.AsSlice()), Zone: addr.Zone()}}
	} else {
		ips, err = c.options.LookupIP(ctx, host)
	}
	if err != nil || len(ips) == 0 || len(ips) > 32 {
		return nil, failure("web-dns-failed", "网址的 DNS 解析失败或结果超限")
	}
	for _, ip := range ips {
		addr, ok := netip.AddrFromSlice(ip.IP)
		if !ok || ip.Zone != "" || execconfig.CheckPublicNetworkAddress(addr) != nil {
			return nil, failure("web-address-denied", "网址解析到私网、回环、元数据或特殊地址，已拒绝访问")
		}
	}
	conn, err := c.options.DialContext(ctx, "tcp", net.JoinHostPort(ips[0].IP.String(), port))
	if err != nil {
		var timeout net.Error
		if errors.As(err, &timeout) && timeout.Timeout() {
			return nil, failure("web-timeout", "连接网址超时，已停止")
		}
		return nil, failure("web-connect-failed", "无法连接网址，请检查网络或目标服务")
	}
	return conn, nil
}

func (c *Client) Fetch(ctx context.Context, raw string) (Result, error) {
	u, err := normalizeURL(raw)
	if err != nil {
		return Result{}, err
	}
	requestCtx, cancel := context.WithTimeout(ctx, Timeout)
	defer cancel()
	// 每次读取独立连接；不使用系统代理、Cookie、默认 Transport 或连接重试。
	transport := &http.Transport{
		DialContext: c.dial, DisableKeepAlives: true,
		TLSHandshakeTimeout: 10 * time.Second, ResponseHeaderTimeout: 15 * time.Second,
		MaxResponseHeaderBytes: 64 << 10,
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) > MaxRedirects {
			return failure("web-redirect-limit", "网址重定向超过 5 次")
		}
		next, err := normalizeURL(req.URL.String())
		if err != nil {
			return err
		}
		req.URL = next
		return nil
	}}
	req, err := http.NewRequestWithContext(requestCtx, http.MethodGet, u.String(), nil)
	if err != nil {
		return Result{}, failure("web-invalid-url", "网址无法构造为 HTTP 请求")
	}
	req.Header.Set("User-Agent", "Elysian-WebFetch/1.0")
	req.Header.Set("Accept", "text/html, application/xhtml+xml, text/plain, text/markdown, application/json")
	resp, err := client.Do(req)
	if err != nil {
		return Result{}, fetchError(ctx, requestCtx, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return Result{}, failure("web-http-error", "网址返回 HTTP "+strconv.Itoa(resp.StatusCode)+"，未读取错误正文")
	}
	contentType := resp.Header.Get("Content-Type")
	body, err := io.ReadAll(io.LimitReader(resp.Body, ResponseBytes+1))
	if err != nil {
		return Result{}, fetchError(ctx, requestCtx, err)
	}
	if len(body) > ResponseBytes {
		return Result{}, failure("web-response-too-large", "网页解压后的响应超过 2 MiB，已停止读取")
	}
	if contentType == "" {
		contentType = http.DetectContentType(body)
	}
	mediaType, _, err := mime.ParseMediaType(contentType)
	if err != nil {
		return Result{}, failure("web-unsupported-content", "网址返回的内容类型无效")
	}
	result := Result{URL: u.String(), FinalURL: resp.Request.URL.String(), StatusCode: resp.StatusCode, ContentType: mediaType, Links: []Link{}, FetchedAt: c.options.Now().UTC().Format(time.RFC3339Nano)}
	if err = extract(&result, body, contentType); err != nil {
		return Result{}, err
	}
	result.bound()
	if err := ctx.Err(); err != nil {
		return Result{}, err
	}
	if requestCtx.Err() != nil {
		return Result{}, failure("web-timeout", "读取网址超过 20 秒，已停止")
	}
	return result, nil
}

func fetchError(parent, request context.Context, err error) error {
	if parent.Err() != nil {
		return parent.Err()
	}
	if request.Err() != nil {
		return failure("web-timeout", "读取网址超过 20 秒，已停止")
	}
	var safe *Error
	if errors.As(err, &safe) {
		return safe
	}
	var timeout net.Error
	if errors.As(err, &timeout) && timeout.Timeout() {
		return failure("web-timeout", "网址连接、TLS 握手或响应等待超时，已停止")
	}
	return failure("web-request-failed", "读取网址失败，请检查网络、TLS 证书或目标服务")
}

func clip(s string, limit int) (string, bool) {
	if len(s) <= limit {
		return s, false
	}
	for limit > 0 && !utf8.RuneStart(s[limit]) {
		limit--
	}
	return s[:limit], true
}

// JSON 转义同样计入内核结果预算；极端正文先减少链接，再缩短正文。
func (r *Result) bound() {
	r.Title, _ = clip(r.Title, 2048)
	r.Text, r.Truncated = clip(r.Text, TextBytes)
	for {
		raw, _ := json.Marshal(r)
		if len(raw) <= resultBytes {
			return
		}
		if len(r.Links) > 0 {
			r.Links = r.Links[:len(r.Links)-1]
		} else {
			r.Truncated = true
			r.Text, _ = clip(r.Text, len(r.Text)/2)
		}
	}
}
