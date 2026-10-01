package security

// JS 语义兼容层：TS 版路由里 Number()/String()/parseInt() 对请求体的强转行为是
// API 契约的一部分（security 盘点 §3.1 #6 与 §9 风险 9：`"2202"`→2202、null→0、
// true→1、undefined→NaN；错误文案里 String(undefined) = "undefined"）。本文件
// 逐条照抄这些强转语义，不做有意识的收紧。

import (
	"math"
	"regexp"
	"strconv"
	"strings"
)

// jsDecimalRe JS 十进制数字面量：整数、小数、科学计数（不含十六进制与前缀形式）。
var jsDecimalRe = regexp.MustCompile(`^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$`)

// jsHexRe / jsBinaryRe / jsOctalRe 0x/0b/0o 前缀整数字面量（JS Number("0x1A")=26）。
var (
	jsHexRe    = regexp.MustCompile(`^[0-9a-fA-F]+$`)
	jsBinaryRe = regexp.MustCompile(`^[01]+$`)
	jsOctalRe  = regexp.MustCompile(`^[0-7]+$`)
)

// jsNumber 对 JSON 解码值执行 JS Number() 强转；第二个返回值为 true 表示 NaN。
func jsNumber(v any) (float64, bool) {
	switch x := v.(type) {
	case nil: // JSON null → Number(null) = 0
		return 0, false
	case bool:
		if x {
			return 1, false
		}
		return 0, false
	case float64:
		return x, math.IsNaN(x)
	case string:
		return jsStrToNumber(x)
	case []any:
		// JS Number([])：空数组 → 0；单元素 → Number(String(元素))；多元素 → NaN。
		if len(x) == 0 {
			return 0, false
		}
		if len(x) == 1 {
			return jsNumber(jsToPrimitiveString(x[0]))
		}
		return math.NaN(), true
	default: // 对象 → NaN
		return math.NaN(), true
	}
}

// jsToPrimitiveString 数组元素进 Number() 前的原文化：null/undefined → ""，其余同 String()。
func jsToPrimitiveString(v any) string {
	switch v.(type) {
	case nil:
		return ""
	case []any, map[string]any:
		return ""
	default:
		return jsStringOf(v)
	}
}

// jsStrToNumber JS 字符串到数字的强转：去首尾空白后按十进制/十六进制/二进制/
// 八进制/Infinity 解析，解析不出为 NaN。
func jsStrToNumber(s string) (float64, bool) {
	t := strings.TrimFunc(s, func(r rune) bool {
		return r == ' ' || r == '\t' || r == '\n' || r == '\r' || r == '\v' || r == '\f' || r == 0x85 || r == 0xa0 || r == 0xfeff
	})
	if t == "" {
		return 0, false // Number("") === 0
	}
	sign := 1.0
	body := t
	if body[0] == '+' || body[0] == '-' {
		if body[0] == '-' {
			sign = -1
		}
		body = body[1:]
	}
	if body == "" {
		return math.NaN(), true // "+" / "-" 单独不是数字
	}
	if body == "Infinity" {
		return sign * math.Inf(1), false
	}
	switch {
	case strings.HasPrefix(body, "0x") || strings.HasPrefix(body, "0X"):
		if !jsHexRe.MatchString(body[2:]) {
			return math.NaN(), true
		}
		n, err := strconv.ParseUint(body[2:], 16, 64)
		if err != nil {
			return math.NaN(), true
		}
		return sign * float64(n), false
	case strings.HasPrefix(body, "0b") || strings.HasPrefix(body, "0B"):
		if !jsBinaryRe.MatchString(body[2:]) {
			return math.NaN(), true
		}
		n, err := strconv.ParseUint(body[2:], 2, 64)
		if err != nil {
			return math.NaN(), true
		}
		return sign * float64(n), false
	case strings.HasPrefix(body, "0o") || strings.HasPrefix(body, "0O"):
		if !jsOctalRe.MatchString(body[2:]) {
			return math.NaN(), true
		}
		n, err := strconv.ParseUint(body[2:], 8, 64)
		if err != nil {
			return math.NaN(), true
		}
		return sign * float64(n), false
	}
	if !jsDecimalRe.MatchString(body) {
		return math.NaN(), true
	}
	n, err := strconv.ParseFloat(body, 64)
	if err != nil {
		return math.NaN(), true
	}
	return sign * n, false
}

// jsStringOf 对 JSON 解码值执行 JS String() 强转（错误文案逐字对齐用）。
func jsStringOf(v any) string {
	switch x := v.(type) {
	case nil:
		return "null"
	case bool:
		if x {
			return "true"
		}
		return "false"
	case string:
		return x
	case float64:
		return jsNumberToString(x)
	case []any:
		parts := make([]string, 0, len(x))
		for _, elem := range x {
			if elem == nil {
				parts = append(parts, "")
				continue
			}
			parts = append(parts, jsStringOf(elem))
		}
		return strings.Join(parts, ",")
	default:
		return "[object Object]"
	}
}

// jsDisplay 取值进错误文案：缺键（undefined）显示 "undefined"，其余同 String()。
func jsDisplay(v any, present bool) string {
	if !present {
		return "undefined"
	}
	return jsStringOf(v)
}

// jsNumberToString 按 ECMAScript Number::toString 规则输出：最短往返十进制数字，
// 指数阈值（21/-6）与指数零填充规则与 V8 一致（String(1e-7)="1e-7"、
// String(1e21)="1e+21"、String(-0)="0"）。
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
	if f == 0 {
		return "0"
	}
	neg := false
	if f < 0 {
		neg = true
		f = -f
	}
	// 最短往返数字与十进制指数：digits（k 位）× 10^(n-1)。
	scientific := strconv.FormatFloat(f, 'e', -1, 64)
	eIdx := strings.IndexByte(scientific, 'e')
	digits := strings.Replace(scientific[:eIdx], ".", "", 1)
	exp, _ := strconv.Atoi(scientific[eIdx+1:])
	k := len(digits)
	n := exp + 1
	var b strings.Builder
	if neg {
		b.WriteByte('-')
	}
	switch {
	case k <= n && n <= 21:
		b.WriteString(digits)
		for i := 0; i < n-k; i++ {
			b.WriteByte('0')
		}
	case 0 < n && n <= 21:
		b.WriteString(digits[:n])
		b.WriteByte('.')
		b.WriteString(digits[n:])
	case -6 < n && n <= 0:
		b.WriteString("0.")
		for i := 0; i < -n; i++ {
			b.WriteByte('0')
		}
		b.WriteString(digits)
	default:
		b.WriteString(digits[:1])
		if k > 1 {
			b.WriteByte('.')
			b.WriteString(digits[1:])
		}
		b.WriteByte('e')
		if n-1 >= 0 {
			b.WriteByte('+')
		}
		b.WriteString(strconv.Itoa(n - 1))
	}
	return b.String()
}

// jsParseInt JS parseInt(s, 10)：跳过前导空白、可选符号、连续数字，无数字为 NaN。
// pidfile 与 /proc 的取值解析沿用该语义（"12abc" 在 JS 里取 12）。
func jsParseInt(s string) (int, bool) {
	i := 0
	for i < len(s) && isJSWhitespaceByte(s[i]) {
		i++
	}
	start := i
	if i < len(s) && (s[i] == '+' || s[i] == '-') {
		i++
	}
	digits := i
	for i < len(s) && s[i] >= '0' && s[i] <= '9' {
		i++
	}
	if i == digits {
		return 0, false
	}
	n, err := strconv.Atoi(s[start:i])
	if err != nil {
		// 超出 int 的巨大数字：JS 里是合法整数，但对应的 /proc 路径必然读不到，
		// 调用方按「解析失败」处理与 JS 的最终判定一致。
		return 0, false
	}
	return n, true
}

// isJSWhitespaceByte 正则 \s 的 ASCII 子集（配置文件与 pidfile 只有 ASCII 空白）。
func isJSWhitespaceByte(b byte) bool {
	switch b {
	case ' ', '\t', '\n', '\v', '\f', '\r':
		return true
	}
	return false
}

// jsonProp 模拟 JS 对请求体对象的属性访问：null 上取属性抛 TypeError（映射 500，
// 文案与 V8 一致）；非对象（数组/字符串/数字）上取属性得 undefined。
func jsonProp(body any, key string) (value any, present bool, err error) {
	if body == nil {
		return nil, false, &typeErrorOfNull{key: key}
	}
	if m, ok := body.(map[string]any); ok {
		v, p := m[key]
		return v, p, nil
	}
	return nil, false, nil
}

// typeErrorOfNull null 上取属性的错误（V8 文案，仅进 500 路径）。
type typeErrorOfNull struct{ key string }

func (e *typeErrorOfNull) Error() string {
	return "Cannot read properties of null (reading '" + e.key + "')"
}

// typeErrorOfDestructure null 上解构属性的错误（V8 文案，仅进 500 路径）。
type typeErrorOfDestructure struct{ key string }

func (e *typeErrorOfDestructure) Error() string {
	return "Cannot destructure property '" + e.key + "' of 'null' as it is null."
}
