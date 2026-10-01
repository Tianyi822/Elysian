package terminals

import (
	"strings"
	"testing"

	"elysian/server/internal/shared"
)

// marshalFrameForTest 与连接胶水同源的序列化出口。
func marshalFrameForTest(frame terminalFrame) ([]byte, error) {
	return shared.MarshalJSON(frame)
}

// 客户端帧解析的合法/违规矩阵（盘点 §8.3 对等移植）：白名单三类、大小上限（边界含
// 等于）、data 形状（字符串/换行/超长）、二进制帧路径与中文 reason 逐字断言。

func parseOK(t *testing.T, raw string) clientFrame {
	t.Helper()
	frame, ok, reason := parseClientFrame([]byte(raw))
	if !ok {
		t.Fatalf("合法帧被拒：%s（reason=%s）", raw, reason)
	}
	return frame
}

func parseReject(t *testing.T, raw []byte, wantReason string) {
	t.Helper()
	_, ok, reason := parseClientFrame(raw)
	if ok {
		t.Fatalf("违规帧被放行：%s", raw)
	}
	if reason != wantReason {
		t.Fatalf("reason = %q，期望 %q", reason, wantReason)
	}
}

func TestParseClientFrame合法帧(t *testing.T) {
	if frame := parseOK(t, `{"type":"input","data":"echo 你好"}`); frame.typ != clientFrameInput || frame.data != "echo 你好" {
		t.Fatalf("input 帧原样取出失败：%+v", frame)
	}
	if frame := parseOK(t, `{"type":"input","data":""}`); frame.typ != clientFrameInput || frame.data != "" {
		t.Fatalf("input 空字符串（空命令行）应合法：%+v", frame)
	}
	if frame := parseOK(t, `{"type":"input","data":"ls","extra":1}`); frame.typ != clientFrameInput || frame.data != "ls" {
		t.Fatalf("input 可携带额外字段（白名单只管已知键）：%+v", frame)
	}
	if frame := parseOK(t, `{"type":"interrupt"}`); frame.typ != clientFrameInterrupt {
		t.Fatalf("interrupt 帧应通过：%+v", frame)
	}
	if frame := parseOK(t, `{"type":"ping"}`); frame.typ != clientFramePing {
		t.Fatalf("ping 帧应通过：%+v", frame)
	}
}

func TestParseClientFrame帧字节恰为上限时通过(t *testing.T) {
	pad := strings.Repeat("x", TERMINAL_FRAME_MAX_BYTES-24)
	raw := `{"type":"ping","pad":"` + pad + `"}`
	if len(raw) != TERMINAL_FRAME_MAX_BYTES {
		t.Fatalf("构造帧长度 %d，期望恰 %d", len(raw), TERMINAL_FRAME_MAX_BYTES)
	}
	parseOK(t, raw)
}

func TestParseClientFrameData恰为上限时通过(t *testing.T) {
	raw := `{"type":"input","data":"` + strings.Repeat("y", TERMINAL_INPUT_MAX_BYTES) + `"}`
	parseOK(t, raw)
}

func TestParseClientFrame终端消息过大(t *testing.T) {
	// 二进制帧一律违规。
	parseReject(t, nil, "终端消息过大")
	// 文本帧超 8192 UTF-8 字节。
	huge := `{"type":"ping","pad":"` + strings.Repeat("z", TERMINAL_FRAME_MAX_BYTES+1) + `"}`
	parseReject(t, []byte(huge), "终端消息过大")
	// 多字节字符按字节数而非字符数计：「中」是 3 字节，2731 个字符 = 8193 字节。
	payload := strings.Repeat("中", 2731)
	if len(payload) != TERMINAL_FRAME_MAX_BYTES+1 {
		t.Fatalf("多字节载荷长度 %d，期望 %d", len(payload), TERMINAL_FRAME_MAX_BYTES+1)
	}
	parseReject(t, []byte(`{"type":"input","data":"`+payload+`"}`), "终端消息过大")
}

func TestParseClientFrame终端消息不是有效JSON(t *testing.T) {
	parseReject(t, []byte("not json"), "终端消息不是有效 JSON")
	parseReject(t, []byte(`{"type":`), "终端消息不是有效 JSON")
}

func TestParseClientFrame终端消息类型不允许(t *testing.T) {
	// JSON 非对象（数字/字符串/null/bool/数组）。
	for _, raw := range []string{"5", `"text"`, "null", "true", "[]"} {
		parseReject(t, []byte(raw), "终端消息类型不允许")
	}
	// type 缺失或不在白名单。
	for _, raw := range []string{"{}", `{"data":"ls"}`, `{"type":"output"}`, `{"type":"resize"}`, `{"type":123}`} {
		parseReject(t, []byte(raw), "终端消息类型不允许")
	}
}

func TestParseClientFrame终端输入不合法(t *testing.T) {
	// data 非字符串（缺失/数字/null）。
	parseReject(t, []byte(`{"type":"input"}`), "终端输入不合法")
	parseReject(t, []byte(`{"type":"input","data":5}`), "终端输入不合法")
	parseReject(t, []byte(`{"type":"input","data":null}`), "终端输入不合法")
	// data 含换行。
	parseReject(t, []byte(`{"type":"input","data":"a\nb"}`), "终端输入不合法")
	// data 超 4096 UTF-8 字节。
	tooLong := strings.Repeat("q", TERMINAL_INPUT_MAX_BYTES+1)
	parseReject(t, []byte(`{"type":"input","data":"`+tooLong+`"}`), "终端输入不合法")
}

func Test服务端帧序列化键序(t *testing.T) {
	// pong 帧原文断言（TS terminalConnection.test 逐字锚点）。
	data, err := marshalFrameForTest(pongFrame)
	if err != nil {
		t.Fatalf("pong 序列化失败：%v", err)
	}
	if string(data) != `{"type":"pong"}` {
		t.Fatalf("pong 帧序列化 = %s，期望 {\"type\":\"pong\"}", data)
	}
	out, _ := marshalFrameForTest(frameOutput{Type: "output", Lines: []string{"hi"}})
	if string(out) != `{"type":"output","lines":["hi"]}` {
		t.Fatalf("output 帧序列化 = %s", out)
	}
	files := []string{"apps", "docs"}
	prompt, _ := marshalFrameForTest(framePrompt{Type: "prompt", Prompt: "p", Cwd: "/tmp", Completion: framePromptCompletion{Files: &files}})
	want := `{"type":"prompt","prompt":"p","cwd":"/tmp","completion":{"files":["apps","docs"]}}`
	if string(prompt) != want {
		t.Fatalf("prompt 帧序列化 = %s，期望 %s", prompt, want)
	}
	nullFiles, _ := marshalFrameForTest(framePrompt{Type: "prompt", Prompt: "p", Cwd: "/", Completion: framePromptCompletion{}})
	if !strings.Contains(string(nullFiles), `"files":null`) {
		t.Fatalf("files 超限应序列化为 null：%s", nullFiles)
	}
}
