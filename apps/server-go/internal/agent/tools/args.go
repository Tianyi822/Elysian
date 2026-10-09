// args.go 提供参数取值助手。描述符的 Schema 已经在执行前做过校验，这里只负责
// 把 any 收窄成 Go 类型；类型不符一律返回 ok=false，由调用方失败闭合。
package tools

import (
	"math"
)

// StringArg 取字符串参数。
func StringArg(args Arguments, key string) (string, bool) {
	value, ok := args[key].(string)
	return value, ok
}

// BoolArg 取布尔参数。
func BoolArg(args Arguments, key string) (bool, bool) {
	value, ok := args[key].(bool)
	return value, ok
}

// IntArg 取整数参数。JSON 解码得到的浮点只有在无小数部分时才接受。
func IntArg(args Arguments, key string) (int, bool) {
	switch value := args[key].(type) {
	case int:
		return value, true
	case int64:
		return int(value), true
	case float32:
		return intArgFromFloat(float64(value))
	case float64:
		return intArgFromFloat(value)
	}
	return 0, false
}

// EnumOf 把字符串枚举转成 Schema.Enum 需要的形态。
func EnumOf(values ...string) []any {
	out := make([]any, 0, len(values))
	for _, value := range values {
		out = append(out, value)
	}
	return out
}

func intArgFromFloat(value float64) (int, bool) {
	if math.IsNaN(value) || math.IsInf(value, 0) || value != math.Trunc(value) {
		return 0, false
	}
	return int(value), true
}
