package firewall

import (
	"math"
	"regexp"
	"strconv"
	"strings"
	"unicode"
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

// jsNumber 复刻 JS 的 Number() 强转：JSON 值（nil/bool/float64/string/array/object）
// 按 ECMAScript ToNumber 规则取数。undefined（缺失或 null）→ NaN、字符串数字可转、
// 垃圾字符串 → NaN、空数组 → 0、单元素数组取其元素、对象 → NaN。
func jsNumber(v any) float64 {
	switch x := v.(type) {
	case nil:
		return math.NaN()
	case bool:
		if x {
			return 1
		}
		return 0
	case float64:
		return x
	case string:
		return jsStringToNumber(x)
	case []any:
		if len(x) == 0 {
			return 0
		}
		if len(x) == 1 {
			return jsNumber(x[0])
		}
		return math.NaN()
	default:
		// map[string]any 及其余一切对象：Number({}) → NaN。
		return math.NaN()
	}
}

// jsStringToNumber 复刻 JS 对字符串的 Number() 解析：先剥空白（含 \u00a0/\ufeff），
// 空串 → 0，十进制/十六进制(0x)/二进制(0b)/八进制(0o)/科学计数可转，Infinity 字面量
// 可转，其余（含 inf/nan 拼写、下滑线、多余字符）→ NaN。
func jsStringToNumber(s string) float64 {
	t := strings.TrimFunc(s, func(r rune) bool {
		return r == '\u00a0' || r == '\ufeff' || unicode.IsSpace(r)
	})
	if t == "" {
		return 0
	}
	neg := false
	body := t
	switch {
	case strings.HasPrefix(body, "+"):
		body = body[1:]
	case strings.HasPrefix(body, "-"):
		neg = true
		body = body[1:]
	}
	if body == "Infinity" {
		if neg {
			return math.Inf(-1)
		}
		return math.Inf(1)
	}
	if body == "" {
		return math.NaN()
	}
	apply := func(f float64) float64 {
		if neg {
			return -f
		}
		return f
	}
	lower := strings.ToLower(body)
	for prefix, base := range map[string]int{"0x": 16, "0b": 2, "0o": 8} {
		if strings.HasPrefix(lower, prefix) {
			digits := body[2:]
			if digits == "" || strings.ContainsAny(digits, "_") {
				return math.NaN()
			}
			u, err := strconv.ParseUint(digits, base, 64)
			if err != nil {
				return math.NaN()
			}
			return apply(float64(u))
		}
	}
	if strings.ContainsRune(body, '_') {
		return math.NaN()
	}
	f, err := strconv.ParseFloat(body, 64)
	if err != nil {
		return math.NaN()
	}
	// Go 接受 "inf"/"nan" 等拼写，JS 只认 Infinity（上面已处理）。
	if math.IsInf(f, 0) || math.IsNaN(f) {
		return math.NaN()
	}
	return apply(f)
}

var jsExponentPad = regexp.MustCompile(`e([+-])0(\d)$`)

// jsNumberToString 复刻 JS String(number)：NaN/Infinity 原样、整数不带小数点、
// 1e21 起与 1e-6 以下用科学计数（Go 的指数位补零要剥掉，如 1e-07 → 1e-7）。
// 错误消息里的数字全部经它格式化（`端口无效：NaN（…）` 逐字契约）。
func jsNumberToString(f float64) string {
	if math.IsNaN(f) {
		return "NaN"
	}
	if math.IsInf(f, 1) {
		return "Infinity"
	}
	if math.IsInf(f, -1) {
		return "-Infinity"
	}
	abs := math.Abs(f)
	if f == math.Trunc(f) && abs < 1e21 {
		return strconv.FormatFloat(f, 'f', 0, 64)
	}
	if abs >= 1e21 || (f != 0 && abs < 1e-6) {
		return jsExponentPad.ReplaceAllString(strconv.FormatFloat(f, 'g', -1, 64), "e${1}${2}")
	}
	return strconv.FormatFloat(f, 'f', -1, 64)
}

// jsIsInteger 复刻 Number.isInteger：有限且无小数部分。
func jsIsInteger(f float64) bool {
	return !math.IsNaN(f) && !math.IsInf(f, 0) && math.Trunc(f) == f
}
