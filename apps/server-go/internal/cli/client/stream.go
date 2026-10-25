package client

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// 输出流接缝（CLI 方案 §6.3）：GET /api/agent/runs/{id}/output 是 30 秒短连接只读
// SSE（100ms 合并、10s ping、重连只发当前快照、无 id/重放语义）。本客户端逐连接
// 读取：帧事件仅 output（全量快照）与 ping（忽略），Done 为真即返回；连接结束由
// 调用方决定重连（TUI 以 1 秒间隔重连，重连帧即最新快照、天然覆盖渲染）。45 秒
// 连接总预算与 Web 前端 AbortSignal.timeout(45000) 同口径：服务端 30 秒主动断开，
// 预算只兜「连接悬挂」的形态，超时视为本连接结束（nil）交上层重连。

const (
	// streamBudget 单次流连接总预算：45 秒。
	streamBudget = 45 * time.Second
	// maxStreamFrameBytes 单帧体积上限（快照含 timeline，防御异常放大）。
	maxStreamFrameBytes = 8 << 20
)

// StreamChatOutput 建立一次 SSE 连接并逐帧回调全量快照；回调返回非 nil 时停止读取
// 并关闭连接（订阅方主动退订）。返回值：连接自然结束（服务端 Done、30 秒断开或
// 45 秒预算到期）回 nil，由调用方决定重连；调用方 ctx 取消、网络与五态错误原样
// 上抛（401 由上层收敛登录）。
func (c *Client) StreamChatOutput(ctx context.Context, runID string, onOutput func(ChatOutput) error) error {
	endpoint := c.baseURL + "/api/agent/runs/" + url.PathEscape(runID) + "/output"
	// 连接总预算：到期时 ctx 杀连接，本次调用以 nil 收场（上层重连换新连接）。
	connCtx, cancel := context.WithTimeout(ctx, streamBudget)
	defer cancel()
	req, err := http.NewRequestWithContext(connCtx, http.MethodGet, endpoint, nil)
	if err != nil {
		return errClient(KindServer, "请求构造失败："+err.Error())
	}
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("Origin", c.baseURL)
	if cookie := c.SessionCookie(); cookie != "" {
		req.Header.Set("Cookie", "elysian_session="+cookie)
	}
	resp, err := (&http.Client{}).Do(req)
	if err != nil {
		if connCtx.Err() != nil && ctx.Err() == nil {
			// 预算到期（非调用方取消）：本连接结束，交上层重连。
			return nil
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return classifyTransport(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, errorBodyLimit))
		return serverError(resp.StatusCode, raw, 0)
	}
	if !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/event-stream") {
		return &Error{Kind: KindBadResponse, Message: "输出流响应类型异常"}
	}
	reader := bufio.NewReader(resp.Body)
	parser := &sseFrameParser{}
	for {
		chunk, err := reader.ReadBytes('\n')
		if err != nil {
			// 服务端 30 秒主动断开（EOF）、预算到期或网络中断：本连接结束。
			// 调用方主动取消原样上抛，其余交上层决定重连。
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return nil
		}
		for _, frame := range parser.push(chunk) {
			if frame.event != "output" {
				continue // ping 心跳与未知事件忽略。
			}
			if len(frame.data) > maxStreamFrameBytes {
				return &Error{Kind: KindBadResponse, Message: "输出流帧超过体积上限"}
			}
			var output ChatOutput
			if err := json.Unmarshal(frame.data, &output); err != nil {
				return &Error{Kind: KindBadResponse, Message: "输出流帧解析失败：" + err.Error()}
			}
			if output.RunID == "" || output.RunID != runID {
				return &Error{Kind: KindBadResponse, Message: "输出流帧运行编号不匹配"}
			}
			if err := onOutput(output); err != nil {
				return err
			}
			if output.Done {
				return nil
			}
		}
	}
}

// sseFrameParser 增量 SSE 帧解析：event:/data:/注释/空行；data 多行以 \n 合并
// （SSE 规范），事件名缺省为 message（本流恒显式 output/ping）。
type sseFrameParser struct {
	event string
	data  []string
}

type sseFrame struct {
	event string
	data  []byte
}

// push 喂入一段字节（以行为单位推进），返回其间完整解析出的帧。
func (p *sseFrameParser) push(chunk []byte) []sseFrame {
	var frames []sseFrame
	for len(chunk) > 0 {
		line := chunk
		if idx := indexByte(chunk, '\n'); idx >= 0 {
			line, chunk = chunk[:idx], chunk[idx+1:]
		} else {
			chunk = nil
		}
		line = trimCR(line)
		switch {
		case len(line) == 0:
			if p.event != "" || len(p.data) > 0 {
				frames = append(frames, sseFrame{event: p.event, data: []byte(strings.Join(p.data, "\n"))})
			}
			p.event, p.data = "", nil
		case line[0] == ':':
			// 注释帧（: keep-alive）忽略。
		default:
			field, value := cutColon(line)
			value = strings.TrimPrefix(value, " ")
			if field == "event" {
				p.event = value
			} else if field == "data" {
				p.data = append(p.data, value)
			}

		}
	}
	return frames
}

func indexByte(b []byte, c byte) int {
	for i := range b {
		if b[i] == c {
			return i
		}
	}
	return -1
}

// cutColon 按首个冒号切分字段名与值（字节形态，避免整行转字符串）。
func cutColon(line []byte) (string, string) {
	if idx := indexByte(line, ':'); idx >= 0 {
		return string(line[:idx]), string(line[idx+1:])
	}
	return string(line), ""
}

func trimCR(line []byte) []byte {
	if len(line) > 0 && line[len(line)-1] == '\r' {
		return line[:len(line)-1]
	}
	return line
}
