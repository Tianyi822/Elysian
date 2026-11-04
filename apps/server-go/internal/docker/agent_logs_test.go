package docker

import (
	"context"
	"encoding/binary"
	"fmt"
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
			if call.Query.Get("tail") != "100" || call.Query.Get("timestamps") != "1" ||
				call.Query.Get("stdout") != "1" || call.Query.Get("stderr") != "1" {
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

// newManagedLogsFacade 返回纳管容器 inspect + 固定 logs 应答的 AgentFacade。
func newManagedLogsFacade(t *testing.T, logBody []byte) *AgentFacade {
	t.Helper()
	return newServiceFacade(t, func(call engineCall) (int, string, bool) {
		switch {
		case call.Method == http.MethodGet && strings.HasSuffix(call.Path, "/json"):
			return http.StatusOK, managedLogInspectBody(), true
		case call.Method == http.MethodGet && strings.HasSuffix(call.Path, "/logs"):
			return http.StatusOK, string(logBody), true
		}
		return 0, "", false
	}, &recordingPortOpener{})
}

// buildLogBody 构造 count 行 stderr 多路复用帧，每行内容定长（前缀标序号 + 填充到 lineLen）。
// 帧字节预算 = len(Timestamp)（30）+ lineLen + 8 = lineLen + 38。
func buildLogBody(count, lineLen int) []byte {
	var body []byte
	for i := 0; i < count; i++ {
		prefix := fmt.Sprintf("line-%03d|", i)
		content := prefix + strings.Repeat("x", lineLen-len(prefix))
		body = append(body, frame(2, "2026-11-04T06:51:01.000000000Z "+content+"\n")...)
	}
	return body
}

// framesBudget 按实现口径求帧字节预算（行 + 时间戳 + 8）。
func framesBudget(frames []agentLogFrame) int {
	total := 0
	for _, f := range frames {
		total += len(f.Line) + len(f.Timestamp) + 8
	}
	return total
}

func TestLogsTruncatesToNewestUnder64KiB(t *testing.T) {
	// 200 行 × 600 字节内容 → 每帧预算 638、总量 127600，明显超 64 KiB。
	// 从头丢弃 98 帧（127600 − 98×638 = 65076 ≤ 65536）后保留最新 102 帧。
	facade := newManagedLogsFacade(t, buildLogBody(200, 600))
	result, err := facade.Logs(context.Background(), strings.Repeat("c", 64), 500)
	if err != nil {
		t.Fatal(err)
	}
	if result["truncated"] != true {
		t.Fatalf("超 64 KiB 应标记截断：%v", result["truncated"])
	}
	lines, _ := result["lines"].([]agentLogFrame)
	if len(lines) != 102 {
		t.Fatalf("应从头丢弃保最新 102 行，实际 %d 行", len(lines))
	}
	if !strings.HasPrefix(lines[0].Line, "line-098|") || !strings.HasPrefix(lines[len(lines)-1].Line, "line-199|") {
		t.Fatalf("保留段应是最新的第 98–199 行：%q…%q", lines[0].Line, lines[len(lines)-1].Line)
	}
	if budget := framesBudget(lines); budget > agentLogBytesMax {
		t.Fatalf("截断后预算应 ≤ 64 KiB：%d", budget)
	}
}

func TestLogsExactBudgetNotTruncated(t *testing.T) {
	t.Run("恰好等于预算不截断", func(t *testing.T) {
		// 128 行 × 474 字节内容 → 每帧预算 512、总量恰为 128×512 = 65536 = agentLogBytesMax。
		facade := newManagedLogsFacade(t, buildLogBody(128, 474))
		result, err := facade.Logs(context.Background(), strings.Repeat("c", 64), 500)
		if err != nil {
			t.Fatal(err)
		}
		if result["truncated"] != false {
			t.Fatalf("恰好等于预算不应标记截断：%v", result["truncated"])
		}
		lines, _ := result["lines"].([]agentLogFrame)
		if len(lines) != 128 || !strings.HasPrefix(lines[0].Line, "line-000|") {
			t.Fatalf("恰好等于预算应全量保留：%d 行，首行 %q", len(lines), lines[0].Line)
		}
		if budget := framesBudget(lines); budget != agentLogBytesMax {
			t.Fatalf("预算应恰为 64 KiB：%d", budget)
		}
	})
	t.Run("超一帧从头丢弃一帧", func(t *testing.T) {
		// 129 帧 × 512 = 66048，仅超 512：丢 1 帧即回到 65536。
		facade := newManagedLogsFacade(t, buildLogBody(129, 474))
		result, err := facade.Logs(context.Background(), strings.Repeat("c", 64), 500)
		if err != nil {
			t.Fatal(err)
		}
		if result["truncated"] != true {
			t.Fatalf("超预算一帧应标记截断：%v", result["truncated"])
		}
		lines, _ := result["lines"].([]agentLogFrame)
		if len(lines) != 128 || !strings.HasPrefix(lines[0].Line, "line-001|") {
			t.Fatalf("应只丢弃首帧保留后 128 行：%d 行，首行 %q", len(lines), lines[0].Line)
		}
		if budget := framesBudget(lines); budget > agentLogBytesMax {
			t.Fatalf("截断后预算应 ≤ 64 KiB：%d", budget)
		}
	})
}

func TestDemuxDockerStreamBoundaries(t *testing.T) {
	if frames := demuxDockerStream(nil); len(frames) != 0 {
		t.Fatalf("空 body 应返回空：%+v", frames)
	}
	if frames := demuxDockerStream([]byte{1, 0, 0, 0}); len(frames) != 0 {
		t.Fatalf("半帧头应即止不 panic：%+v", frames)
	}
	// 前两帧完整、第三帧头声明 9 字节但载荷只有 2 字节：保留已解帧并即止。
	var body []byte
	body = append(body, frame(1, "2026-01-01T00:00:00Z a\n")...)
	body = append(body, frame(2, "2026-01-01T00:00:01Z b\n")...)
	body = append(body, 2, 0, 0, 0, 0, 0, 0, 9, 'x', 'x')
	if frames := demuxDockerStream(body); len(frames) != 2 || frames[1].Stream != "stderr" {
		t.Fatalf("残包载荷不足应即止且保留已解帧：%+v", frames)
	}
	// tty 整包纯文本（首字节非 1/2）：兜底为单行 stdout，去尾部换行、无时间戳。
	tty := demuxDockerStream([]byte("hello tty output\nsecond\n"))
	if len(tty) != 1 || tty[0].Stream != "stdout" || tty[0].Timestamp != "" || tty[0].Line != "hello tty output\nsecond" {
		t.Fatalf("tty 兜底不符：%+v", tty)
	}
}
