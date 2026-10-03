package docker

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"time"

	"elysian/server/internal/contract"
	"elysian/server/internal/seam"
)

// Engine 传输层（dockerTransport.ts 逐字移植）：HTTP over unix socket，固定版本前缀
// /v1.41，不做版本协商。seam.EngineRequest.Path 不含版本前缀，由本层拼接；
// /version 探测传 "/version" 时按 seam 约定同样拼为 /v1.41/version（对 ≥1.41 的
// 引擎与未版本化的 /version 等价，老引擎两侧都以「版本过低」文案收口）。
//
// 超时与上限语义：Request 的 Timeout <=0 取 30s、MaxBytes <=0 取 4 MiB（seam 缺省）；
// Stream 的 Timeout <=0 表示无超时、MaxBytes <=0 表示无总量上限（events 长流必需，
// 拉取路径显式传 15 分钟 / 64 MiB）。错误文案为契约：超时「Docker 请求超时」、
// Request 超限「Docker 响应过大」、Stream 超限「拉取进度过大」、取消「拉取已取消」。

const (
	requestDefaultTimeout = 30 * time.Second
	requestDefaultMax     = 4 * 1024 * 1024
)

// unixTransport seam.DockerTransport 的 HTTP-over-unix 实现。
type unixTransport struct {
	socketPath string
	client     *http.Client
}

// newUnixTransport 按固定 socket 路径构造传输器（每次请求独立拨号）。
func newUnixTransport(socketPath string) *unixTransport {
	transport := &http.Transport{
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			dialer := &net.Dialer{}
			return dialer.DialContext(ctx, "unix", socketPath)
		},
		DisableCompression: true,
		ForceAttemptHTTP2:  false,
	}
	return &unixTransport{socketPath: socketPath, client: &http.Client{Transport: transport}}
}

// Request 执行一次性请求并读全响应（超限即断）。
func (t *unixTransport) Request(ctx context.Context, req seam.EngineRequest) (seam.EngineResponse, error) {
	timeout := req.Timeout
	if timeout <= 0 {
		timeout = requestDefaultTimeout
	}
	maxBytes := req.MaxBytes
	if maxBytes <= 0 {
		maxBytes = requestDefaultMax
	}
	rctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	httpReq, err := t.newHTTPRequest(rctx, req)
	if err != nil {
		return seam.EngineResponse{}, err
	}
	response, err := t.client.Do(httpReq)
	if err != nil {
		return seam.EngineResponse{}, mapEngineTransportError(rctx, err, "Docker 请求超时")
	}
	defer response.Body.Close()
	data, err := readAllLimited(response.Body, maxBytes)
	if err != nil {
		return seam.EngineResponse{}, err
	}
	return seam.EngineResponse{Status: response.StatusCode, Body: data}, nil
}

// Stream 流式请求（events/pull/logs）：原始块同步回调 onChunk（回调返回前不继续
// 读上游，等价 TS 的 pause/resume 背压），聚合体随响应返回；ctx 取消即中止。
func (t *unixTransport) Stream(ctx context.Context, req seam.EngineRequest, onChunk func(chunk []byte)) (seam.EngineResponse, error) {
	rctx := ctx
	if req.Timeout > 0 {
		var cancel context.CancelFunc
		rctx, cancel = context.WithTimeout(ctx, req.Timeout)
		defer cancel()
	}
	httpReq, err := t.newHTTPRequest(rctx, req)
	if err != nil {
		return seam.EngineResponse{}, err
	}
	response, err := t.client.Do(httpReq)
	if err != nil {
		return seam.EngineResponse{}, mapEngineTransportError(rctx, err, "Docker 请求超时")
	}
	defer response.Body.Close()

	buf := make([]byte, 32*1024)
	aggregated := make([]byte, 0, 64*1024)
	total := int64(0)
	for {
		n, readErr := response.Body.Read(buf)
		if n > 0 {
			total += int64(n)
			if req.MaxBytes > 0 && total > req.MaxBytes {
				return seam.EngineResponse{}, errors.New("拉取进度过大")
			}
			chunk := make([]byte, n)
			copy(chunk, buf[:n])
			if req.ResponseWriter != nil && response.StatusCode < 300 {
				if _, err := req.ResponseWriter.Write(chunk); err != nil {
					return seam.EngineResponse{}, err
				}
			} else if !req.DiscardBody {
				if req.ResponseWriter != nil && int64(len(aggregated)+len(chunk)) > requestDefaultMax {
					return seam.EngineResponse{}, errors.New("Docker 错误响应过大")
				}
				aggregated = append(aggregated, chunk...)
			}
			if onChunk != nil {
				onChunk(chunk)
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return seam.EngineResponse{}, mapEngineTransportError(rctx, readErr, "Docker 请求超时")
		}
	}
	return seam.EngineResponse{Status: response.StatusCode, Body: aggregated}, nil
}

// newHTTPRequest 组装 http.Request：URL 主机固定 localhost（实际由 DialContext 落到
// unix socket），Body 非空时带 Content-Type 与 Content-Length。
func (t *unixTransport) newHTTPRequest(ctx context.Context, req seam.EngineRequest) (*http.Request, error) {
	target := "http://localhost" + seam.EngineAPIPrefix + req.Path
	if len(req.Query) > 0 {
		target += "?" + req.Query.Encode()
	}
	var body io.Reader
	if req.Body != nil && req.BodyReader != nil {
		return nil, errors.New("Docker 请求不能同时包含 JSON 与流式正文")
	}
	body = req.BodyReader
	if req.Body != nil {
		body = bytes.NewReader(req.Body)
	}
	httpReq, err := http.NewRequestWithContext(ctx, req.Method, target, body)
	if err != nil {
		return nil, err
	}
	if req.BodyReader != nil {
		contentType := req.ContentType
		if contentType == "" {
			contentType = "application/json"
		}
		httpReq.Header.Set("Content-Type", contentType)
	}
	if req.Body != nil {
		httpReq.Header.Set("Content-Type", "application/json")
		httpReq.ContentLength = int64(len(req.Body))
	}
	return httpReq, nil
}

// mapEngineTransportError 把传输层错误映射为契约文案：取消 →「拉取已取消」，
// 超时 → 指定超时消息，其余原样返回（连接错误原文作为 503 原因透出）。
func mapEngineTransportError(ctx context.Context, err error, timeoutMessage string) error {
	if ctx.Err() == context.Canceled {
		return errors.New("拉取已取消")
	}
	if errors.Is(err, context.DeadlineExceeded) || ctx.Err() == context.DeadlineExceeded {
		return errors.New(timeoutMessage)
	}
	return err
}

// readAllLimited 读全响应体，超限返回「Docker 响应过大」。
func readAllLimited(body io.Reader, maxBytes int64) ([]byte, error) {
	data := make([]byte, 0, 8*1024)
	buf := make([]byte, 32*1024)
	for {
		n, err := body.Read(buf)
		if n > 0 {
			if int64(len(data)+n) > maxBytes {
				return nil, errors.New("Docker 响应过大")
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

// transportFactory seam.DockerTransportFactory 实现：每次产出独立传输器。
type transportFactory struct{}

// New 返回按 socket 路径拨号的新传输器（探测不缓存连接状态）。
func (transportFactory) New(socketPath string) seam.DockerTransport {
	return newUnixTransport(socketPath)
}

// NewTransportFactory platform 探测 / hostShell 共用的传输器工厂出口。
func NewTransportFactory() seam.DockerTransportFactory {
	return transportFactory{}
}

// probeEngineAPI GET /version 并校验 ApiVersion ≥ 1.41（dockerTransport.ts
// assertEngineApi 逐字移植）；失败错误 message 作为 503 原因。
func probeEngineAPI(ctx context.Context, transport seam.DockerTransport) error {
	response, err := transport.Request(ctx, seam.EngineRequest{
		Method:   http.MethodGet,
		Path:     "/version",
		Timeout:  3 * time.Second,
		MaxBytes: 1_048_576,
	})
	if err != nil {
		return err
	}
	value, err := decodeOrderedJSON(response.Body)
	if err != nil && len(response.Body) > 0 {
		// 对齐 TS：transport 层对非 JSON 响应以「Docker 响应不是有效 JSON」收口。
		return errors.New("Docker 响应不是有效 JSON")
	}
	var apiVersion string
	if record, ok := asRecord(value); ok {
		if s, ok := asString(mustGet(record, "ApiVersion")); ok {
			apiVersion = s
		}
	}
	if apiVersion == "" || !checkEngineAPIVersion(apiVersion) {
		return errors.New(contract.EngineAPITooLowMessage)
	}
	return nil
}

// ---- exec 劫持用的裸连接通道（dockerExecRunner.ts 同款手写 HTTP） ----

// dialEngineConn 拨一条 Engine 裸连接并返回带缓冲的读取端。
func dialEngineConn(socketPath string) (net.Conn, *bufio.Reader, error) {
	conn, err := net.Dial("unix", socketPath)
	if err != nil {
		return nil, nil, err
	}
	return conn, bufio.NewReader(conn), nil
}

// writeEngineRequest 手写一次 HTTP/1.1 请求（劫持路径需要自定 Upgrade 头）。
func writeEngineRequest(conn net.Conn, method, pathWithQuery string, headers map[string]string, body []byte) error {
	requestLine := fmt.Sprintf("%s %s HTTP/1.1\r\nHost: localhost\r\n", method, pathWithQuery)
	var writer []byte
	writer = append(writer, requestLine...)
	for key, value := range headers {
		writer = append(writer, key+": "+value+"\r\n"...)
	}
	writer = append(writer, "\r\n"...)
	if body != nil {
		writer = append(writer, body...)
	}
	_, err := conn.Write(writer)
	return err
}

// readEngineResponseHead 读取响应状态行与头（不消费 body）。
func readEngineResponseHead(br *bufio.Reader, method string) (*http.Response, error) {
	return http.ReadResponse(br, &http.Request{Method: method})
}
