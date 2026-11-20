package firewall

import (
	"math"
	"strconv"
	"strings"

	"elysian/server/internal/jscompat"
)

// JS 语义兼容层（盘点 §9.1/§9.6）：canonical id 与界面行 id 全部经 JS encodeURIComponent
// 生成，存量 firewall.sqlite 的 rule_touches 键与前端回传的 :id 都依赖它。Go 的
// url.QueryEscape 不等价（空格会变 '+'），必须手写 JS 语义转义。路由层「宽进」的
// Number() 强转同理：字符串数字可过、垃圾变 NaN，NaN 由服务层校验拒成 400。

// jsEncodeURIComponent 复刻 JS encodeURIComponent：不转义 A-Za-z0-9 与 -_.!~*'()，
// 其余字节（含 UTF-8 多字节序列的每个字节）百分号大写编码；空格 → %20。
func jsEncodeURIComponent(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if isURIComponentSafe(c) {
			b.WriteByte(c)
			continue
		}
		const hex = "0123456789ABCDEF"
		b.WriteByte('%')
		b.WriteByte(hex[c>>4])
		b.WriteByte(hex[c&0x0f])
	}
	return b.String()
}

func isURIComponentSafe(c byte) bool {
	switch {
	case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9':
		return true
	}
	switch c {
	case '-', '_', '.', '!', '~', '*', '\'', '(', ')':
		return true
	}
	return false
}

// jsDecodeURIComponent 复刻 JS decodeURIComponent：百分号序列还原为字节；非法序列
// （落单 % 或非十六进制）返回错误（JS 抛 URIError，这里以错误值显式带回）。
func jsDecodeURIComponent(s string) (string, error) {
	if !strings.ContainsRune(s, '%') {
		return s, nil
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] != '%' {
			b.WriteByte(s[i])
			continue
		}
		if i+2 >= len(s) || !isHexDigit(s[i+1]) || !isHexDigit(s[i+2]) {
			return "", errMalformedURI
		}
		b.WriteByte(hexVal(s[i+1])<<4 | hexVal(s[i+2]))
		i += 2
	}
	return b.String(), nil
}

type jsURIError struct{}

func (jsURIError) Error() string { return "URI malformed" }

var errMalformedURI = jsURIError{}

func isHexDigit(c byte) bool {
	return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
}

func hexVal(c byte) byte {
	switch {
	case c >= '0' && c <= '9':
		return c - '0'
	case c >= 'a' && c <= 'f':
		return c - 'a' + 10
	default:
		return c - 'A' + 10
	}
}

func jsNumber(v any) float64 { return jscompat.ParseNumberUndefined(v) }

// 防火墙错误文案保留整值的完整十进制形式（含负零）。
func jsNumberToString(f float64) string {
	if math.Abs(f) < 1e21 && jscompat.IsInteger(f) {
		return strconv.FormatFloat(f, 'f', 0, 64)
	}
	return jscompat.NumberToString(f)
}

func jsIsInteger(f float64) bool { return jscompat.IsInteger(f) }
