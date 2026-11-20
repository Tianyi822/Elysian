package security

// JS 语义兼容层：TS 版路由里 Number()/String()/parseInt() 对请求体的强转行为是
// API 契约的一部分（security 盘点 §3.1 #6 与 §9 风险 9：`"2202"`→2202、null→0、
// true→1、undefined→NaN；错误文案里 String(undefined) = "undefined"）。本文件
// 逐条照抄这些强转语义，不做有意识的收紧。

import (
	"math"
	"strconv"
	"strings"

	"elysian/server/internal/jscompat"
)

// jsNumber 保留 SSH 路由的 null 及 NaN 回执口径。
func jsNumber(v any) (float64, bool) {
	n := jscompat.ParseNumberNull(v)
	return n, math.IsNaN(n)
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

func jsNumberToString(f float64) string { return jscompat.NumberToString(f) }

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
