package database

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"net"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"elysian/server/internal/shared"
)

// 裸 TCP RESP2 有界终端（redisTerminalProtocol.ts 等价物）：1 MiB 缓冲 / 500 项 /
// 16 层嵌套上限，认证固定 3 参 AUTH，命令 15s 超时；错误回复按 400 透传给前端。

const (
	redisMaxReplyBytes = 1024 * 1024
	redisMaxArrayItems = 500
	redisMaxDepth      = 16
	redisAuthTimeout   = 5 * time.Second
	redisCmdTimeout    = 15 * time.Second
)

// redisParsed 一次解析结果；replyErr 非空表示服务端错误回复（-前缀）。
type redisParsed struct {
	value    any
	next     int
	replyErr string
}

// parseRedisReply 在有界缓冲内解析 RESP2 帧；数据不完整返回 nil，违规抛中文错误。
func parseRedisReply(buffer []byte, start, depth int) (*redisParsed, error) {
	if depth > redisMaxDepth {
		return nil, errors.New("Redis 结果嵌套过深")
	}
	if start >= len(buffer) {
		return nil, nil
	}
	prefix := buffer[start]
	line, next, ok := lineAt(buffer, start+1)
	if !ok {
		return nil, nil
	}
	switch prefix {
	case '+':
		return &redisParsed{value: line, next: next}, nil
	case '-':
		return &redisParsed{value: line, next: next, replyErr: line}, nil
	case ':':
		if !isIntText(line) {
			return nil, errors.New("Redis 整数结果无效")
		}
		number, err := strconv.ParseInt(line, 10, 64)
		if err != nil {
			return nil, errors.New("Redis 整数结果无效")
		}
		return &redisParsed{value: number, next: next}, nil
	case '$':
		if !isIntText(line) {
			return nil, errors.New("Redis 字符串长度无效")
		}
		length, err := strconv.Atoi(line)
		if err != nil {
			return nil, errors.New("Redis 字符串长度无效")
		}
		if length == -1 {
			return &redisParsed{value: nil, next: next}, nil
		}
		if length < 0 || length > redisMaxReplyBytes {
			return nil, errors.New("Redis 结果超过 1 MiB，已中断")
		}
		end := next + length
		if len(buffer) < end+2 {
			return nil, nil
		}
		if buffer[end] != 13 || buffer[end+1] != 10 {
			return nil, errors.New("Redis 字符串帧无效")
		}
		return &redisParsed{value: string(buffer[next:end]), next: end + 2}, nil
	case '*':
		if !isIntText(line) {
			return nil, errors.New("Redis 数组长度无效")
		}
		count, err := strconv.Atoi(line)
		if err != nil {
			return nil, errors.New("Redis 数组长度无效")
		}
		if count == -1 {
			return &redisParsed{value: nil, next: next}, nil
		}
		if count < 0 || count > redisMaxArrayItems {
			return nil, errors.New("Redis 结果超过 500 项，已中断")
		}
		values := make([]any, 0, count)
		cursor := next
		for index := 0; index < count; index++ {
			item, err := parseRedisReply(buffer, cursor, depth+1)
			if err != nil {
				return nil, err
			}
			if item == nil {
				return nil, nil
			}
			if item.replyErr != "" {
				return nil, errors.New(item.replyErr)
			}
			values = append(values, item.value)
			cursor = item.next
		}
		return &redisParsed{value: values, next: cursor}, nil
	default:
		return nil, errors.New("Redis 响应类型不受支持")
	}
}

// lineAt 取 start 起到 CRLF 的一行；没有完整行返回 ok=false。
func lineAt(buffer []byte, start int) (text string, next int, ok bool) {
	for i := start; i+1 < len(buffer); i++ {
		if buffer[i] == '\r' && buffer[i+1] == '\n' {
			return string(buffer[start:i]), i + 2, true
		}
	}
	return "", 0, false
}

// isIntText 判定 -?\d+ 形态。
func isIntText(text string) bool {
	if text == "" {
		return false
	}
	body := text
	if body[0] == '-' {
		body = body[1:]
	}
	if body == "" {
		return false
	}
	for i := 0; i < len(body); i++ {
		if body[i] < '0' || body[i] > '9' {
			return false
		}
	}
	return true
}

// encodeCommand 编码 RESP2 数组命令。
func encodeCommand(args []string) []byte {
	var out []byte
	out = append(out, []byte("*"+strconv.Itoa(len(args))+"\r\n")...)
	for _, arg := range args {
		out = append(out, []byte("$"+strconv.Itoa(len(arg))+"\r\n")...)
		out = append(out, []byte(arg)...)
		out = append(out, []byte("\r\n")...)
	}
	return out
}

// redisTerminal 一个有界 RESP2 终端会话。
type redisTerminal struct {
	conn     net.Conn
	reader   *bufio.Reader
	validate func(string) ([]string, error)
	closed   bool
	pending  atomic.Bool
	mu       sync.Mutex
}

// openBoundedRedisTerminal 建立连接并完成 3 参 AUTH 认证。
func openBoundedRedisTerminal(addr databaseAddress, credential databaseSecret, validate func(string) ([]string, error)) (*redisTerminal, error) {
	conn, err := net.DialTimeout("tcp", net.JoinHostPort(addr.Host, strconv.Itoa(addr.Port)), redisAuthTimeout)
	if err != nil {
		if isTimeoutError(err) {
			return nil, errors.New("Redis 连接超时")
		}
		return nil, err
	}
	terminal := &redisTerminal{conn: conn, reader: bufio.NewReader(conn), validate: validate}
	if err := terminal.handshake(credential); err != nil {
		terminal.destroy()
		return nil, err
	}
	return terminal, nil
}

// isTimeoutError 判定拨号/读写超时。
func isTimeoutError(err error) bool {
	var netErr net.Error
	if errors.As(err, &netErr) {
		return netErr.Timeout()
	}
	return false
}

// handshake 发送 AUTH <user> <pass> 并校验 OK 回复。
func (t *redisTerminal) handshake(credential databaseSecret) error {
	if err := t.conn.SetDeadline(time.Now().Add(redisAuthTimeout)); err != nil {
		return err
	}
	if _, err := t.conn.Write(encodeCommand([]string{"AUTH", credential.Username, credential.Password})); err != nil {
		return err
	}
	parsed, err := t.readReply()
	if err != nil {
		return err
	}
	if parsed.replyErr != "" {
		return &shared.InvalidRequestError{Status: 400, Message: parsed.replyErr}
	}
	if text, ok := parsed.value.(string); !ok || text != "OK" {
		return errors.New("Redis 普通账号认证失败")
	}
	return t.conn.SetDeadline(time.Time{})
}

// destroy 直接销毁连接（挂起读随即失败）。
func (t *redisTerminal) destroy() {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed {
		return
	}
	t.closed = true
	_ = t.conn.Close()
}

// readReply 在 1 MiB+128 有界缓冲内读出一条完整回复。
func (t *redisTerminal) readReply() (*redisParsed, error) {
	var buffer []byte
	for {
		chunk := make([]byte, 4096)
		n, err := t.reader.Read(chunk)
		if n > 0 {
			buffer = append(buffer, chunk[:n]...)
			if len(buffer) > redisMaxReplyBytes+128 {
				return nil, errors.New("Redis 结果超过 1 MiB，已中断")
			}
			parsed, parseErr := parseRedisReply(buffer, 0, 0)
			if parseErr != nil {
				return nil, parseErr
			}
			if parsed != nil {
				return parsed, nil
			}
		}
		if err != nil {
			if isTimeoutError(err) {
				return nil, errors.New("Redis 命令超时，连接已关闭")
			}
			return nil, errors.New("Redis 连接已断开")
		}
	}
}

// request 发送一条命令并等待回复（deadline 由调用方设置）。
func (t *redisTerminal) request(args []string, timeout time.Duration) (*redisParsed, error) {
	t.mu.Lock()
	closed := t.closed
	t.mu.Unlock()
	if closed {
		return nil, errors.New("Redis 连接已断开")
	}
	if t.pending.Load() {
		return nil, errors.New("上一条 Redis 命令仍在执行")
	}
	t.pending.Store(true)
	defer t.pending.Store(false)
	if err := t.conn.SetDeadline(time.Now().Add(timeout)); err != nil {
		return nil, err
	}
	if _, err := t.conn.Write(encodeCommand(args)); err != nil {
		t.destroy()
		return nil, errors.New("Redis 连接已断开")
	}
	parsed, err := t.readReply()
	if err != nil {
		t.destroy()
		return nil, err
	}
	_ = t.conn.SetDeadline(time.Time{})
	return parsed, nil
}

// Execute 校验、执行并序列化一条 Redis 命令，输出单行 JSON 文本。
func (t *redisTerminal) Execute(ctx context.Context, input string) ([]string, error) {
	args, err := t.validate(input)
	if err != nil {
		return nil, err
	}
	parsed, err := t.request(args, redisCmdTimeout)
	if err != nil {
		return nil, err
	}
	if parsed.replyErr != "" {
		return nil, &shared.InvalidRequestError{Status: 400, Message: parsed.replyErr}
	}
	data, err := shared.MarshalJSON(normalizeRedisJSON(parsed.value))
	if err != nil {
		return nil, err
	}
	if len(data) > redisMaxReplyBytes {
		return nil, errors.New("Redis 结果超过 1 MiB，已中断")
	}
	return []string{string(data)}, nil
}

// Close 销毁会话。
func (t *redisTerminal) Close() error {
	t.destroy()
	return nil
}

// normalizeRedisJSON 把解析树里的 int64 归一为 json.Number（保持整数字面形态）。
func normalizeRedisJSON(value any) any {
	switch v := value.(type) {
	case int64:
		return json.Number(strconv.FormatInt(v, 10))
	case []any:
		out := make([]any, len(v))
		for i, item := range v {
			out[i] = normalizeRedisJSON(item)
		}
		return out
	default:
		return value
	}
}
