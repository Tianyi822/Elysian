package terminals

import (
	"crypto/rand"
	"encoding/hex"
)

// newSessionUUID 会话 id：TS randomUUID()（v4）的等价实现——16 随机字节，版本与
// 变体位定形，8-4-4-4-12 连字符形态。
func newSessionUUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		// crypto/rand 失败属系统级熵源故障：显式暴露，不静默降级。
		panic("会话 id 生成失败：" + err.Error())
	}
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // variant 10
	dst := make([]byte, 36)
	hex.Encode(dst[0:8], b[0:4])
	dst[8] = '-'
	hex.Encode(dst[9:13], b[4:6])
	dst[13] = '-'
	hex.Encode(dst[14:18], b[6:8])
	dst[18] = '-'
	hex.Encode(dst[19:23], b[8:10])
	dst[23] = '-'
	hex.Encode(dst[24:36], b[10:16])
	return string(dst)
}
