package terminals

import (
	"encoding/json"
	"strings"
)

// 终端 WebSocket 客户端帧的解析与校验（纯函数，无 IO）：白名单三类
// （input/interrupt/ping）、单帧与单条输入的字节上限、data 形状（字符串、不含换行）。
// 违规一律由调用方以关闭码 1008 配中文 reason 关闭连接，本模块只产出判定结果。

// 客户端帧三类白名单取值。
const (
	clientFrameInput     = "input"
	clientFrameInterrupt = "interrupt"
	clientFramePing      = "ping"
)

// clientFrame 解析成功的客户端帧：typ 取白名单三类；data 仅 input 有意义。
type clientFrame struct {
	typ  string
	data string
}

// parseClientFrame 解析一条客户端帧。text 为 nil 表示二进制帧（一律按「终端消息过大」
// 违规）；校验次序：二进制/超限 → 过大；非 JSON → 不是有效 JSON；非对象或 type 不在
// 白名单 → 类型不允许；input 的 data 非字符串/含换行/超长 → 输入不合法。
func parseClientFrame(text []byte) (frame clientFrame, ok bool, reason string) {
	if text == nil {
		return clientFrame{}, false, "终端消息过大"
	}
	if len(text) > TERMINAL_FRAME_MAX_BYTES {
		return clientFrame{}, false, "终端消息过大"
	}
	var parsed any
	if err := json.Unmarshal(text, &parsed); err != nil {
		return clientFrame{}, false, "终端消息不是有效 JSON"
	}
	obj, isObj := parsed.(map[string]any)
	if !isObj {
		return clientFrame{}, false, "终端消息类型不允许"
	}
	typ, isStr := obj["type"].(string)
	if !isStr || (typ != clientFrameInput && typ != clientFrameInterrupt && typ != clientFramePing) {
		return clientFrame{}, false, "终端消息类型不允许"
	}
	if typ == clientFrameInput {
		data, isData := obj["data"].(string)
		if !isData {
			return clientFrame{}, false, "终端输入不合法"
		}
		if strings.Contains(data, "\n") {
			return clientFrame{}, false, "终端输入不合法"
		}
		if len(data) > TERMINAL_INPUT_MAX_BYTES {
			return clientFrame{}, false, "终端输入不合法"
		}
		return clientFrame{typ: clientFrameInput, data: data}, true, ""
	}
	return clientFrame{typ: typ}, true, ""
}

// terminalFrame 服务端 → 客户端六类帧的标记接口；结构体字段声明序即 JSON 键序
// （对齐 TS JSON.stringify 的插入序，pong 帧的原文断言依赖此约定）。
type terminalFrame interface{ isTerminalFrame() }

// pongFrame 单例：pong 帧无参数，序列化恒为 {"type":"pong"}。
var pongFrame = framePong{Type: "pong"}

type framePong struct {
	Type string `json:"type"`
}

func (framePong) isTerminalFrame() {}

type frameOutput struct {
	Type  string   `json:"type"`
	Lines []string `json:"lines"`
}

func (frameOutput) isTerminalFrame() {}

type frameTruncated struct {
	Type         string `json:"type"`
	DroppedBytes int    `json:"droppedBytes"`
}

func (frameTruncated) isTerminalFrame() {}

type frameExit struct {
	Type     string `json:"type"`
	ExitCode int    `json:"exitCode"`
}

func (frameExit) isTerminalFrame() {}

type frameSession struct {
	ID        string `json:"id"`
	User      string `json:"user"`
	HostLabel string `json:"hostLabel"`
	Prompt    string `json:"prompt"`
}

type frameReadyCompletion struct {
	Commands []string `json:"commands"`
}

type frameReady struct {
	Type       string               `json:"type"`
	Session    frameSession         `json:"session"`
	Completion frameReadyCompletion `json:"completion"`
}

func (frameReady) isTerminalFrame() {}

type framePromptCompletion struct {
	// Files 为 nil 时序列化为 null（文件表超限或读失败，客户端退回命令表）。
	Files *[]string `json:"files"`
}

type framePrompt struct {
	Type       string                `json:"type"`
	Prompt     string                `json:"prompt"`
	Cwd        string                `json:"cwd"`
	Completion framePromptCompletion `json:"completion"`
}

func (framePrompt) isTerminalFrame() {}
