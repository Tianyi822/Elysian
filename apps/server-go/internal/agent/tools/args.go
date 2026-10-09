// args.go 提供参数取值助手。描述符的 Schema 已经在执行前做过校验，这里只负责
// 把 any 收窄成 Go 类型；类型不符一律返回 ok=false，由调用方失败闭合。
package tools

import (
	"math"
	"reflect"
	"strconv"
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
	return integerValue(args[key])
}

func integerValue(value any) (int, bool) {
	if value == nil {
		return 0, false
	}
	v := reflect.ValueOf(value)
	switch v.Kind() {
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		n := v.Int()
		return int(n), int64(int(n)) == n
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		n := v.Uint()
		return int(n), n <= uint64(^uint(0)>>1)
	case reflect.Float32, reflect.Float64:
		return intArgFromFloat(v.Float())
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
	// int 最大值转为 float64 会向上取整，必须使用开区间上界。
	bound := math.Ldexp(1, strconv.IntSize-1)
	if math.IsNaN(value) || math.IsInf(value, 0) || value != math.Trunc(value) || value < -bound || value >= bound {
		return 0, false
	}
	return int(value), true
}
