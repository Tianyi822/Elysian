package containerapps

import (
	"bytes"
	"encoding/json"
	"strings"
)

// ---------- classic 构建流的 NDJSON 解码 ----------

// buildStreamDecoder /build 的 NDJSON 流解码：只认 stream 行（写日志）与 error 行
// （取 errorDetail.message 作失败原因），未知/无法解析的行截 128 KiB 原样入日志；
// 另保留末 128 KiB 原始尾，非 200 时从中提取错误。
type buildStreamDecoder struct {
	onLine    func(line string)
	buffer    []byte
	tail      []byte
	streamErr string
}

// newBuildStreamDecoder 构造解码器；onLine 是日志出口。
func newBuildStreamDecoder(onLine func(line string)) *buildStreamDecoder {
	return &buildStreamDecoder{onLine: onLine}
}

// onChunk 喂入一个原始块：切行、逐行消费、维护原始尾。
func (d *buildStreamDecoder) onChunk(chunk []byte) {
	d.tail = append(d.tail, chunk...)
	if excess := len(d.tail) - 128*1024; excess > 0 {
		d.tail = d.tail[excess:]
	}
	d.buffer = append(d.buffer, chunk...)
	for {
		newline := bytes.IndexByte(d.buffer, '\n')
		if newline == -1 {
			break
		}
		line := string(d.buffer[:newline])
		d.buffer = d.buffer[newline+1:]
		d.consume(line)
	}
	// 单行超 128 KiB 还没等到换行：强制切一段，避免缓冲无限增长。
	if len(d.buffer) > 128*1024 {
		line := string(d.buffer[:128*1024])
		d.buffer = d.buffer[128*1024:]
		d.consume(line)
	}
}

// consume 消费一行 NDJSON。
func (d *buildStreamDecoder) consume(line string) {
	if len(line) > 0 && line[len(line)-1] == '\r' {
		line = line[:len(line)-1]
	}
	var frame struct {
		Stream      string `json:"stream"`
		Error       string `json:"error"`
		ErrorDetail *struct {
			Message string `json:"message"`
		} `json:"errorDetail"`
	}
	if err := json.Unmarshal([]byte(line), &frame); err == nil {
		if frame.ErrorDetail != nil && frame.ErrorDetail.Message != "" {
			if d.streamErr == "" {
				d.streamErr = frame.ErrorDetail.Message
			}
			return
		}
		if frame.Error != "" {
			if d.streamErr == "" {
				d.streamErr = frame.Error
			}
			return
		}
		if frame.Stream != "" {
			d.onLine(strings.TrimRight(frame.Stream, "\n"))
			return
		}
		// 无已知字段（classic 不出 aux；空行也在此）——原样入日志。
	}
	d.onLine(line)
}

// errorMessage 流内 error 行提取的失败原因（首个）。
func (d *buildStreamDecoder) errorMessage() string { return d.streamErr }

// tailError 从末 128 KiB 原始尾提取 errorDetail.message（非 200 时用）。
func (d *buildStreamDecoder) tailError() string {
	text := d.tail
	for {
		newline := bytes.IndexByte(text, '\n')
		var line []byte
		if newline == -1 {
			line = text
			text = nil
		} else {
			line = text[:newline]
			text = text[newline+1:]
		}
		if message := buildLineErrorMessage(line); message != "" {
			return message
		}
		if newline == -1 {
			return ""
		}
	}
}

// buildLineErrorMessage 从单行原始字节提取 errorDetail.message / error。
func buildLineErrorMessage(line []byte) string {
	var frame struct {
		Error       string `json:"error"`
		ErrorDetail *struct {
			Message string `json:"message"`
		} `json:"errorDetail"`
	}
	if json.Unmarshal(line, &frame) != nil {
		return ""
	}
	if frame.ErrorDetail != nil && frame.ErrorDetail.Message != "" {
		return frame.ErrorDetail.Message
	}
	return frame.Error
}
