package shared

import (
	"encoding/binary"
	"strings"
	"testing"
)

func execFrame(stream byte, value string) []byte {
	header := make([]byte, 8)
	header[0] = stream
	binary.BigEndian.PutUint32(header[4:], uint32(len(value)))
	return append(header, []byte(value)...)
}

func TestExecOutputSeparatesStdoutAndStderrAcrossFragmentedChunks(t *testing.T) {
	wire := append(execFrame(1, "hello "), execFrame(2, "warn")...)
	wire = append(wire, execFrame(1, "world")...)
	output := NewExecOutput(64 << 10)
	for len(wire) > 0 {
		n := 3
		if n > len(wire) {
			n = len(wire)
		}
		output.Consume(wire[:n])
		wire = wire[n:]
	}
	if output.Invalid() || output.Incomplete() || output.Truncated() {
		t.Fatalf("完整流不应报告异常：%+v", output)
	}
	if string(output.Stdout()) != "hello world" || string(output.Stderr()) != "warn" {
		t.Fatalf("输出分流出错：stdout=%q stderr=%q", output.Stdout(), output.Stderr())
	}
}

func TestExecOutputDropsOverflowButKeepsDraining(t *testing.T) {
	wire := execFrame(1, strings.Repeat("x", 100<<10))
	wire = append(wire, execFrame(1, "tail")...)
	output := NewExecOutput(65 << 10)
	for len(wire) > 0 {
		n := 19
		if n > len(wire) {
			n = len(wire)
		}
		output.Consume(wire[:n])
		wire = wire[n:]
	}
	if output.Invalid() || output.Incomplete() || !output.Truncated() || len(output.Stdout()) > 65<<10 {
		t.Fatalf("超限输出应截断并排空：%+v", output)
	}
}

func TestExecOutputRejectsUnknownStreamAndReportsTruncatedFrames(t *testing.T) {
	bad := NewExecOutput(64 << 10)
	bad.Consume(execFrame(3, "x"))
	if !bad.Invalid() {
		t.Fatal("未知流编号应使输出无效")
	}
	partial := NewExecOutput(64 << 10)
	partial.Consume(execFrame(1, "abc")[:10])
	if partial.Invalid() || !partial.Incomplete() {
		t.Fatal("帧体未排空应报告流不完整")
	}
}
