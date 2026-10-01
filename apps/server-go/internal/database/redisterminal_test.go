package database

import (
	"context"
	"net"
	"strings"
	"testing"
	"time"

	"elysian/server/internal/shared"
)

// redisTerminalProtocol.test.ts 对等测试：RESP2 解析完整/分段/数组/错误回复/
// 大 bulk 头 / 大数组头；再加 fake server 的认证与命令透传。

func TestParseRedisReply(t *testing.T) {
	parsed, err := parseRedisReply([]byte("$5\r\nhello\r\n"), 0, 0)
	if err != nil || parsed == nil || parsed.value != "hello" || parsed.next != 11 {
		t.Fatalf("完整 bulk 解析不符：%+v %v", parsed, err)
	}
	parsed, err = parseRedisReply([]byte("$5\r\nhel"), 0, 0)
	if err != nil || parsed != nil {
		t.Fatalf("分段 bulk 应返回未完成，实际 %+v %v", parsed, err)
	}
	parsed, err = parseRedisReply([]byte("*2\r\n:1\r\n$3\r\nfoo\r\n"), 0, 0)
	if err != nil || parsed == nil {
		t.Fatalf("数组解析失败：%v", err)
	}
	items, ok := parsed.value.([]any)
	if !ok || len(items) != 2 {
		t.Fatalf("数组解析结果不符：%#v", parsed.value)
	}
	if number, ok := items[0].(int64); !ok || number != 1 {
		t.Fatalf("整数元素应为 int64(1)，实际 %#v", items[0])
	}
	if items[1] != "foo" {
		t.Fatalf("字符串元素不符：%#v", items[1])
	}
	parsed, err = parseRedisReply([]byte("-ERR denied\r\n"), 0, 0)
	if err != nil || parsed == nil || parsed.replyErr != "ERR denied" {
		t.Fatalf("错误回复应带 replyErr：%+v %v", parsed, err)
	}
	bigBulk := func() {
		defer func() {
			if recoverValue := recover(); recoverValue != nil {
				t.Fatalf("大 bulk 头不应 panic：%v", recoverValue)
			}
		}()
		_, err := parseRedisReply([]byte("$999999999\r\n"), 0, 0)
		if err == nil || !strings.Contains(err.Error(), "1 MiB") {
			t.Fatalf("大 bulk 头应报 1 MiB，实际 %v", err)
		}
	}
	bigBulk()
	bigArray := func() {
		defer func() {
			if recoverValue := recover(); recoverValue != nil {
				t.Fatalf("大数组头不应 panic：%v", recoverValue)
			}
		}()
		_, err := parseRedisReply([]byte("*999999999\r\n"), 0, 0)
		if err == nil || !strings.Contains(err.Error(), "500 项") {
			t.Fatalf("大数组头应报 500 项，实际 %v", err)
		}
	}
	bigArray()
	if _, err = parseRedisReply([]byte("?unknown\r\n"), 0, 0); err == nil || !strings.Contains(err.Error(), "Redis 响应类型不受支持") {
		t.Fatalf("未知前缀应拒绝，实际 %v", err)
	}
	if _, err = parseRedisReply([]byte("$abc\r\n"), 0, 0); err == nil || !strings.Contains(err.Error(), "Redis 字符串长度无效") {
		t.Fatalf("bulk 头非数字应拒绝，实际 %v", err)
	}
	if _, err = parseRedisReply([]byte("$5\r\nhelloXX"), 0, 0); err == nil || !strings.Contains(err.Error(), "Redis 字符串帧无效") {
		t.Fatalf("bulk 尾非 CRLF 应拒绝，实际 %v", err)
	}
}

// fakeRedisServer 一次应答脚本的本地假 Redis。
type fakeRedisServer struct {
	listener net.Listener
	replies  []string // 每收到一条命令依次回复的 RESP2 原文
	received [][]byte
}

func newFakeRedisServer(t *testing.T, replies []string) *fakeRedisServer {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("假 Redis 启动失败：%v", err)
	}
	server := &fakeRedisServer{listener: listener, replies: replies}
	go server.serve()
	t.Cleanup(func() { listener.Close() })
	return server
}

func (s *fakeRedisServer) serve() {
	conn, err := s.listener.Accept()
	if err != nil {
		return
	}
	defer conn.Close()
	buffer := make([]byte, 4096)
	var pending []byte
	index := 0
	for {
		n, readErr := conn.Read(buffer)
		if n > 0 {
			pending = append(pending, buffer[:n]...)
			for {
				frame, complete := parseRESP2Command(pending)
				if !complete {
					break
				}
				s.received = append(s.received, frame)
				pending = pending[resp2FrameLength(frame):]
				if index < len(s.replies) {
					if _, writeErr := conn.Write([]byte(s.replies[index])); writeErr != nil {
						return
					}
				}
				index++
			}
		}
		if readErr != nil {
			return
		}
	}
}

// addr 返回监听地址。
func (s *fakeRedisServer) addr() databaseAddress {
	host, port, _ := net.SplitHostPort(s.listener.Addr().String())
	return databaseAddress{Host: host, Port: atoi(port)}
}

func atoi(text string) int {
	value := 0
	for i := 0; i < len(text); i++ {
		value = value*10 + int(text[i]-'0')
	}
	return value
}

// parseRESP2Command 从缓冲里解析一条完整 RESP2 数组命令。
func parseRESP2Command(buffer []byte) ([]byte, bool) {
	// 找 "*N\r\n" 头，然后按 N 个 bulk 收集。
	if len(buffer) == 0 || buffer[0] != '*' {
		return nil, false
	}
	lineEnd := strings.Index(string(buffer), "\r\n")
	if lineEnd < 0 {
		return nil, false
	}
	count := atoi(string(buffer[1:lineEnd]))
	cursor := lineEnd + 2
	for j := 0; j < count; j++ {
		if cursor >= len(buffer) || buffer[cursor] != '$' {
			return nil, false
		}
		headerEnd := strings.Index(string(buffer[cursor:]), "\r\n")
		if headerEnd < 0 {
			return nil, false
		}
		length := atoi(string(buffer[cursor+1 : cursor+headerEnd]))
		cursor = cursor + headerEnd + 2 + length + 2
		if cursor > len(buffer) {
			return nil, false
		}
	}
	return buffer[:cursor], true
}

// resp2FrameLength 返回帧总长。
func resp2FrameLength(frame []byte) int { return len(frame) }

func TestOpenBoundedRedisTerminalAuthFailure(t *testing.T) {
	server := newFakeRedisServer(t, []string{"-WRONGPASS invalid\r\n"})
	_, err := openBoundedRedisTerminal(server.addr(), databaseSecret{Username: "default", Password: "bad"}, validateRedisTerminalCommand)
	var invalid *shared.InvalidRequestError
	if err == nil || !errorsAsInvalid(err, &invalid) || invalid.Status != 400 || !strings.Contains(invalid.Message, "WRONGPASS") {
		t.Fatalf("AUTH 失败应透传 400 错误回复，实际 %v", err)
	}
}

func TestOpenBoundedRedisTerminalCommandFlow(t *testing.T) {
	server := newFakeRedisServer(t, []string{"+OK\r\n", "$11\r\nhello world\r\n"})
	terminal, err := openBoundedRedisTerminal(server.addr(), databaseSecret{Username: "default", Password: "secret"}, validateRedisTerminalCommand)
	if err != nil {
		t.Fatalf("会话建立失败：%v", err)
	}
	defer terminal.Close()
	lines, err := terminal.Execute(context.Background(), "GET greeting")
	if err != nil {
		t.Fatalf("GET 应成功：%v", err)
	}
	if len(lines) != 1 || lines[0] != `"hello world"` {
		t.Fatalf("GET 输出应为单行 JSON，实际 %#v", lines)
	}
}

func errorsAsInvalid(err error, target **shared.InvalidRequestError) bool {
	if invalid, ok := err.(*shared.InvalidRequestError); ok {
		*target = invalid
		return true
	}
	return false
}

func TestRedisTerminalErrorReplyPassthrough(t *testing.T) {
	server := newFakeRedisServer(t, []string{"+OK\r\n", "-ERR unknown command\r\n"})
	terminal, err := openBoundedRedisTerminal(server.addr(), databaseSecret{Username: "default", Password: "secret"}, validateRedisTerminalCommand)
	if err != nil {
		t.Fatalf("会话建立失败：%v", err)
	}
	defer terminal.Close()
	_, err = terminal.Execute(context.Background(), "GET x")
	var invalid *shared.InvalidRequestError
	if err == nil || !errorsAsInvalid(err, &invalid) || invalid.Status != 400 || invalid.Message != "ERR unknown command" {
		t.Fatalf("服务端错误回复应按 400 原样透传，实际 %v", err)
	}
}

// 编译期锚定：15s 命令超时常量不被误改。
func TestRedisTerminalTimeoutConstants(t *testing.T) {
	if redisCmdTimeout != 15*time.Second || redisAuthTimeout != 5*time.Second {
		t.Fatal("Redis 终端超时常量应保持 5s/15s")
	}
}
