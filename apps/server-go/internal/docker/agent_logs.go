package docker

import (
	"context"
	"encoding/hex"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"elysian/server/internal/seam"
	"elysian/server/internal/shared"
)

const (
	agentLogTailDefault = 100
	agentLogTailMax     = 500
	agentLogBytesMax    = 64 << 10
	agentLogFetchBytes  = 1 << 20
)

// agentLogFrame 是一行容器日志的显式投影：时间戳、来源流与行内容。
type agentLogFrame struct {
	Timestamp string `json:"t"`
	Stream    string `json:"stream"`
	Line      string `json:"line"`
}

// Logs 只读纳管容器最近日志：stdout 与 stderr 合并、带时间戳，缺省 100 行、最多 500 行、
// 结果上限 64 KiB（超出保最新）。非 follow 瞬时读取。
func (a *AgentFacade) Logs(ctx context.Context, id string, tail int) (map[string]any, error) {
	if err := a.check(ctx); err != nil {
		return nil, err
	}
	if len(id) != 64 {
		return nil, shared.InvalidRequest("容器日志必须使用完整 ID")
	}
	if _, err := hex.DecodeString(id); err != nil {
		return nil, shared.InvalidRequest("容器 ID 无效")
	}
	if tail == 0 {
		tail = agentLogTailDefault
	}
	if tail < 1 || tail > agentLogTailMax {
		return nil, shared.InvalidRequest("日志行数必须在 1 至 500 之间")
	}
	value, err := a.service.inspectContainerByID(ctx, id, actionTimeout)
	if err != nil {
		return nil, err
	}
	r, ok := asRecord(value)
	if !ok {
		return nil, errors.New("容器身份无效")
	}
	cfg, _ := asRecord(mustGet(r, "Config"))
	labels, _ := asRecord(mustGet(cfg, "Labels"))
	if labels == nil || mustGet(labels, labelManaged) != labelTrueValue || selfInspectCheck(value, a.service.deps.selfContainerID) {
		return nil, shared.InvalidRequest("Agent 只读取面板纳管容器的日志")
	}
	response, err := a.service.deps.transport.Request(ctx, seam.EngineRequest{
		Method:   http.MethodGet,
		Path:     "/containers/" + id + "/logs",
		Query:    url.Values{"stdout": {"1"}, "stderr": {"1"}, "timestamps": {"1"}, "tail": {strconv.Itoa(tail)}},
		Timeout:  actionTimeout,
		MaxBytes: agentLogFetchBytes,
	})
	if err != nil {
		return nil, err
	}
	if response.Status != http.StatusOK {
		return nil, errors.New("读取容器日志失败")
	}
	frames := demuxDockerStream(response.Body)
	truncated := false
	total := 0
	start := 0
	for i := range frames {
		total += len(frames[i].Line) + len(frames[i].Timestamp) + 8
	}
	if total > agentLogBytesMax {
		truncated = true
		for start < len(frames) {
			head := frames[start]
			total -= len(head.Line) + len(head.Timestamp) + 8
			start++
			if total <= agentLogBytesMax {
				break
			}
		}
	}
	return map[string]any{"lines": frames[start:], "truncated": truncated}, nil
}

// demuxDockerStream 解 Docker 多路复用流（8 字节头 [流类型 ×1、保留 ×3、长度 ×4 大端]）。
// timestamps=1 时每帧 payload 为「RFC3339 时间戳 + 空格 + 行内容」；残包即止。
func demuxDockerStream(body []byte) []agentLogFrame {
	var frames []agentLogFrame
	if len(body) == 0 {
		return frames
	}
	if body[0] != 1 && body[0] != 2 {
		// 非 tty 容器之外的意外形态（如 tty 输出）：按整包纯文本兜底一行。
		return append(frames, agentLogFrame{Stream: "stdout", Line: strings.TrimRight(string(body), "\n")})
	}
	for len(body) >= 8 {
		size := int(uint32(body[4])<<24 | uint32(body[5])<<16 | uint32(body[6])<<8 | uint32(body[7]))
		if size < 0 || len(body) < 8+size {
			break
		}
		stream := "stdout"
		if body[0] == 2 {
			stream = "stderr"
		}
		payload := string(body[8 : 8+size])
		body = body[8+size:]
		timestamp, line := payload, ""
		if index := strings.IndexByte(payload, ' '); index > 0 {
			timestamp, line = payload[:index], payload[index+1:]
		}
		frames = append(frames, agentLogFrame{Timestamp: timestamp, Stream: stream, Line: strings.TrimRight(line, "\n")})
	}
	return frames
}
