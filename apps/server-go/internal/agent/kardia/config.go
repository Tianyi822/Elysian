package kardia

import (
	"math/big"
	"reflect"
)

// ConfigCloner 为包含私有字段的配置提供快照复制；服务实例不属于配置。
type ConfigCloner interface{ CloneConfig() any }

// CloneConfig 复制配置中的映射、切片、数组和接口。普通指针视为不透明值，
// 需要复制私有状态的配置类型应实现 ConfigCloner。输入不得在调用时并发修改。
func CloneConfig(value any) any {
	if value == nil {
		return nil
	}
	if c, ok := value.(ConfigCloner); ok {
		return c.CloneConfig()
	}
	return cloneConfigValue(reflect.ValueOf(value), map[configVisit]reflect.Value{}).Interface()
}

type configVisit struct {
	typ    reflect.Type
	ptr    uintptr
	length int
}

func cloneConfigValue(v reflect.Value, seen map[configVisit]reflect.Value) reflect.Value {
	switch v.Kind() {
	case reflect.Interface:
		if v.IsNil() {
			return reflect.Zero(v.Type())
		}
		out := reflect.New(v.Type()).Elem()
		out.Set(cloneConfigValue(v.Elem(), seen))
		return out
	case reflect.Map:
		if v.IsNil() {
			return reflect.Zero(v.Type())
		}
		key := configVisit{v.Type(), uintptr(v.UnsafePointer()), 0}
		if old, ok := seen[key]; ok {
			return old
		}
		out := reflect.MakeMapWithSize(v.Type(), v.Len())
		seen[key] = out
		iter := v.MapRange()
		for iter.Next() {
			out.SetMapIndex(iter.Key(), cloneConfigValue(iter.Value(), seen))
		}
		return out
	case reflect.Slice:
		if v.IsNil() {
			return reflect.Zero(v.Type())
		}
		key := configVisit{v.Type(), v.Pointer(), v.Len()}
		if old, ok := seen[key]; ok {
			return old
		}
		out := reflect.MakeSlice(v.Type(), v.Len(), v.Len())
		seen[key] = out
		for i := 0; i < v.Len(); i++ {
			out.Index(i).Set(cloneConfigValue(v.Index(i), seen))
		}
		return out
	case reflect.Array:
		out := reflect.New(v.Type()).Elem()
		for i := 0; i < v.Len(); i++ {
			out.Index(i).Set(cloneConfigValue(v.Index(i), seen))
		}
		return out
	default:
		return v
	}
}

// NumbersEqual 精确比较配置数字，避免大整数转换 float64 后丢失精度。
// NaN 永远不相等；同号无穷相等；非数字返回 false。
func NumbersEqual(a, b any) bool {
	if a == nil || b == nil {
		return false
	}
	av, bv := reflect.ValueOf(a), reflect.ValueOf(b)
	isFloat := func(v reflect.Value) bool { return v.Kind() == reflect.Float32 || v.Kind() == reflect.Float64 }
	if isFloat(av) && isFloat(bv) {
		return av.Float() == bv.Float()
	}
	x, y := numericRat(av), numericRat(bv)
	return x != nil && y != nil && x.Cmp(y) == 0
}
func numericRat(v reflect.Value) *big.Rat {
	switch v.Kind() {
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return new(big.Rat).SetInt64(v.Int())
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64, reflect.Uintptr:
		return new(big.Rat).SetUint64(v.Uint())
	case reflect.Float32, reflect.Float64:
		return new(big.Rat).SetFloat64(v.Float())
	default:
		return nil
	}
}
