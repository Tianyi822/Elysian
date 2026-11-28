package shared

import "encoding/binary"

// ExecOutput 解码 Docker 的非 TTY 多路复用流：每帧 8 字节帧头（流编号 1=stdout、
// 2=stderr，3 字节保留，4 字节大端帧体长度），不保留无界帧。超过上限的输出只丢弃，
// 仍然排空到执行结束，调用方据此判断流是否完整。
type ExecOutput struct {
	limit     int
	header    []byte
	remaining uint32
	stream    byte
	stdout    []byte
	stderr    []byte
	truncated bool
	invalid   bool
}

// NewExecOutput 构造解码器；limit 是 stdout 与 stderr 合计保留的上限字节数。
func NewExecOutput(limit int) *ExecOutput { return &ExecOutput{limit: limit} }

// Consume 吸收一块原始字节，帧可以跨块拆分。
func (o *ExecOutput) Consume(chunk []byte) {
	if o.invalid {
		return
	}
	for len(chunk) > 0 {
		if o.remaining == 0 {
			n := 8 - len(o.header)
			if n > len(chunk) {
				n = len(chunk)
			}
			o.header = append(o.header, chunk[:n]...)
			chunk = chunk[n:]
			if len(o.header) < 8 {
				return
			}
			o.stream = o.header[0]
			if (o.stream != 1 && o.stream != 2) || o.header[1] != 0 || o.header[2] != 0 || o.header[3] != 0 {
				o.invalid = true
				return
			}
			o.remaining = binary.BigEndian.Uint32(o.header[4:])
			o.header = nil
			if o.remaining == 0 {
				continue
			}
		}
		n := len(chunk)
		if uint32(n) > o.remaining {
			n = int(o.remaining)
		}
		keep := n
		room := o.limit - len(o.stdout) - len(o.stderr)
		if keep > room {
			keep = room
			o.truncated = true
		}
		if o.stream == 1 {
			o.stdout = append(o.stdout, chunk[:keep]...)
		} else {
			o.stderr = append(o.stderr, chunk[:keep]...)
		}
		o.remaining -= uint32(n)
		chunk = chunk[n:]
	}
}

func (o *ExecOutput) Stdout() []byte  { return o.stdout }
func (o *ExecOutput) Stderr() []byte  { return o.stderr }
func (o *ExecOutput) Truncated() bool { return o.truncated }

// Invalid 表示读到了无法解析的帧头，输出不可信。
func (o *ExecOutput) Invalid() bool { return o.invalid }

// Incomplete 表示流结束时仍有未排空的帧头或帧体。
func (o *ExecOutput) Incomplete() bool { return o.remaining != 0 || len(o.header) != 0 }
