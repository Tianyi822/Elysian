package worker

import (
	"bufio"
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestReadFrameRejectsUnboundedAndMalformedMessages(t *testing.T) {
	for _, input := range []string{
		strings.Repeat("x", MaxFrameBytes+1) + "\n",
		`{"version":1,"generation":"g","type":"hello"}`,
		`{"version":1,"generation":"g","type":"hello","unexpected":true}` + "\n",
		`{"version":1,"generation":"g","type":"hello"} {}` + "\n",
		"\n",
	} {
		if _, err := readFrame(bufio.NewReader(strings.NewReader(input))); err == nil {
			t.Fatal("非法帧不应被接受")
		}
	}
}

func TestServeRejectsInvalidRunAndResult(t *testing.T) {
	hello := frame{Version: protocolVersion, Generation: "generation", Type: "hello"}
	start := frame{Version: protocolVersion, Generation: "generation", Type: "run/start", Driver: batchDriverName, DriverVersion: batchDriverVersion, RunID: "run", RequestID: "req", Steps: []Step{{Tool: "read", Args: json.RawMessage(`{}`)}}}
	index := 1
	wrongResult := frame{Version: protocolVersion, Generation: "generation", Type: "tool/result", RunID: "run", RequestID: "req", Index: &index, Tool: "read", Value: json.RawMessage(`null`)}
	badStart := start
	badStart.Steps = []Step{{Tool: "arbitrary/route", Args: json.RawMessage(`{}`)}}
	unknownDriver := start
	unknownDriver.Driver = "external-code"
	wrongVersion := start
	wrongVersion.DriverVersion++
	for _, messages := range [][]frame{{hello, badStart}, {hello, unknownDriver}, {hello, wrongVersion}, {hello, start, start}, {hello, start, wrongResult}} {
		var input, output, diagnostics bytes.Buffer
		for _, f := range messages {
			if err := writeFrame(&input, f); err != nil {
				t.Fatal(err)
			}
		}
		if err := Serve(&input, &output, &diagnostics); err == nil {
			t.Fatal("子进程必须拒绝非法任务或越序结果")
		}
		if diagnostics.Len() > 4097 {
			t.Fatal("诊断输出超过固定上限")
		}
	}
}

func TestServeAcceptsLateCancelAndEOF(t *testing.T) {
	var input, output bytes.Buffer
	for _, f := range []frame{
		{Version: protocolVersion, Generation: "g", Type: "hello"},
		{Version: protocolVersion, Generation: "g", Type: "run/start", Driver: batchDriverName, DriverVersion: batchDriverVersion, RunID: "one", RequestID: "req1"},
		{Version: protocolVersion, Generation: "g", Type: "run/cancel", RunID: "one", RequestID: "req1"},
		{Version: protocolVersion, Generation: "g", Type: "run/start", Driver: batchDriverName, DriverVersion: batchDriverVersion, RunID: "two", RequestID: "req2"},
	} {
		if err := writeFrame(&input, f); err != nil {
			t.Fatal(err)
		}
	}
	if err := Serve(&input, &output, nil); err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(&output)
	for _, kind := range []string{"ready", "run/finished", "run/finished"} {
		got, err := readFrame(reader)
		if err != nil || got.Type != kind {
			t.Fatalf("迟到取消破坏后续运行：%+v，%v", got, err)
		}
	}
}
