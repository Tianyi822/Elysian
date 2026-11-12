package terminals

import "encoding/json"

const (
	clientFrameResize = "resize"
	clientFrameAck    = "ack"
	clientFramePing   = "ping"
)

type clientFrame struct {
	typ               string
	cols, rows, bytes int
}

func parseClientFrame(text []byte) (clientFrame, bool, string) {
	if len(text) == 0 || len(text) > TERMINAL_FRAME_MAX_BYTES {
		return clientFrame{}, false, "终端消息过大"
	}
	var frame struct {
		Type  string `json:"type"`
		Cols  int    `json:"cols"`
		Rows  int    `json:"rows"`
		Bytes int    `json:"bytes"`
	}
	if json.Unmarshal(text, &frame) != nil {
		return clientFrame{}, false, "终端消息不是有效 JSON"
	}
	f := clientFrame{typ: frame.Type, cols: frame.Cols, rows: frame.Rows, bytes: frame.Bytes}
	switch f.typ {
	case clientFrameResize:
		if f.cols < 1 || f.cols > 1000 || f.rows < 1 || f.rows > 1000 {
			return clientFrame{}, false, "终端窗口尺寸无效"
		}
	case clientFrameAck:
		if f.bytes < 1 || f.bytes > TERMINAL_CREDIT_BYTES {
			return clientFrame{}, false, "终端输出确认无效"
		}
	case clientFramePing:
	default:
		return clientFrame{}, false, "终端消息类型不允许"
	}
	return f, true, ""
}

type terminalFrame interface{ isTerminalFrame() }
type framePong struct {
	Type string `json:"type"`
}

func (framePong) isTerminalFrame() {}

var pongFrame = framePong{Type: "pong"}

type frameSession struct {
	ID        string `json:"id"`
	User      string `json:"user"`
	HostLabel string `json:"hostLabel"`
}
type frameReady struct {
	Type     string       `json:"type"`
	Protocol int          `json:"protocol"`
	Session  frameSession `json:"session"`
}

func (frameReady) isTerminalFrame() {}

type frameExit struct {
	Type     string `json:"type"`
	ExitCode int    `json:"exitCode"`
}

func (frameExit) isTerminalFrame() {}
