package docker

import (
	"context"
	"encoding/binary"
	"net/http"
	"strings"
	"testing"
)

// frame 构造 Docker 多路复用帧。
func frame(stream byte, payload string) []byte {
	head := make([]byte, 8)
	head[0] = stream
	binary.BigEndian.PutUint32(head[4:], uint32(len(payload)))
	return append(head, []byte(payload)...)
}

func managedLogInspectBody() string {
	return `{"Id":"` + strings.Repeat("c", 64) + `","Name":"/mysql-main","Created":"2026-11-04T00:00:00Z","State":{"Status":"running"},"Config":{"Labels":{"` + labelManaged + `":"true","elysian.agent.template":"service-v1"}},"HostConfig":{"NetworkMode":"elysian-agent-net"},"Mounts":[]}`
}

func TestLogsReturnsTimestampedLinesAndTruncates(t *testing.T) {
	var body []byte
	for _, line := range []string{
		"2026-11-04T06:51:01.000000000Z [System] initializing\n",
		"2026-11-04T06:51:02.000000000Z [System] ready for connections\n",
	} {
		body = append(body, frame(2, line)...)
	}
	facade := newServiceFacade(t, func(call engineCall) (int, string, bool) {
		switch {
		case call.Method == http.MethodGet && strings.HasSuffix(call.Path, "/json"):
			return http.StatusOK, managedLogInspectBody(), true
		case call.Method == http.MethodGet && strings.HasSuffix(call.Path, "/logs"):
			if call.Query.Get("tail") != "100" || call.Query.Get("timestamps") != "1" {
				t.Fatalf("logs 查询参数不符：%v", call.Query)
			}
			// fakeEngine 的 body 是 string；二进制帧经 []byte(string) 往返无损。
			return http.StatusOK, string(body), true
		}
		return 0, "", false
	}, &recordingPortOpener{})
	result, err := facade.Logs(context.Background(), strings.Repeat("c", 64), 100)
	if err != nil {
		t.Fatal(err)
	}
	lines, _ := result["lines"].([]agentLogFrame)
	if len(lines) != 2 || lines[0].Timestamp != "2026-11-04T06:51:01.000000000Z" || lines[1].Stream != "stderr" {
		t.Fatalf("解帧结果不符：%+v", lines)
	}
	if lines[1].Line != "[System] ready for connections" {
		t.Fatalf("行内容不含换行：%q", lines[1].Line)
	}
}

func TestLogsRejectsUnmanagedAndBadTail(t *testing.T) {
	unmanaged := newServiceFacade(t, func(call engineCall) (int, string, bool) {
		if call.Method == http.MethodGet && strings.HasSuffix(call.Path, "/json") {
			return http.StatusOK, `{"Id":"` + strings.Repeat("c", 64) + `","Config":{"Labels":{}},"HostConfig":{},"Mounts":[]}`, true
		}
		return 0, "", false
	}, &recordingPortOpener{})
	if _, err := unmanaged.Logs(context.Background(), strings.Repeat("c", 64), 100); err == nil {
		t.Fatal("未纳管容器应被拒绝")
	}
	managed := newServiceFacade(t, func(call engineCall) (int, string, bool) {
		if call.Method == http.MethodGet && strings.HasSuffix(call.Path, "/json") {
			return http.StatusOK, managedLogInspectBody(), true
		}
		return 0, "", false
	}, &recordingPortOpener{})
	if _, err := managed.Logs(context.Background(), "short", 100); err == nil {
		t.Fatal("非完整 ID 应被拒绝")
	}
	if _, err := managed.Logs(context.Background(), strings.Repeat("c", 64), 501); err == nil {
		t.Fatal("tail 超 500 应被拒绝")
	}
}
