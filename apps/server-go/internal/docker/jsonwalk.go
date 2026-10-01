package docker

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math"
)

// 有序 JSON 对象解析（docker 盘点风险 1）：Engine 的 HostConfig.PortBindings 键序
// 依赖响应原文次序，Go 的 map 无序，故本包解析 Engine JSON 一律走保留键序的
// jsonObject，再以 TS 的动态判型方式（isRecord / typeof string）逐字段读取，
// 保证映射错误路径与 ports 输出顺序和 TS 版一致。
//
// 解析结果 any 的取值域：nil、bool、float64、string、[]any、*jsonObject。

// jsonObject 保留键插入序的 JSON 对象。
type jsonObject struct {
	keys   []string
	values map[string]any
}

func newJSONObject() *jsonObject {
	return &jsonObject{values: make(map[string]any)}
}

func (o *jsonObject) set(key string, value any) {
	if _, exists := o.values[key]; !exists {
		o.keys = append(o.keys, key)
	}
	o.values[key] = value
}

func (o *jsonObject) get(key string) (any, bool) {
	v, ok := o.values[key]
	return v, ok
}

func (o *jsonObject) orderedKeys() []string {
	return append([]string(nil), o.keys...)
}

// decodeOrderedJSON 把 JSON 字节串解析为保留对象键序的 any 树；语法错误与尾随
// 垃圾均返回错误（与 JSON.parse 同口径）。
func decodeOrderedJSON(data []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	value, err := decodeOrderedValue(dec)
	if err != nil {
		return nil, err
	}
	if _, err := dec.Token(); err == nil {
		return nil, errors.New("json: trailing data")
	} else if err != io.EOF {
		return nil, err
	}
	return value, nil
}

func decodeOrderedValue(dec *json.Decoder) (any, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	delim, ok := tok.(json.Delim)
	if !ok {
		// string / float64 / bool / nil
		return tok, nil
	}
	switch delim {
	case '{':
		obj := newJSONObject()
		for dec.More() {
			keyTok, err := dec.Token()
			if err != nil {
				return nil, err
			}
			key, ok := keyTok.(string)
			if !ok {
				return nil, errors.New("json: object key must be string")
			}
			value, err := decodeOrderedValue(dec)
			if err != nil {
				return nil, err
			}
			obj.set(key, value)
		}
		if _, err := dec.Token(); err != nil { // 消费 '}'
			return nil, err
		}
		return obj, nil
	case '[':
		arr := []any{}
		for dec.More() {
			value, err := decodeOrderedValue(dec)
			if err != nil {
				return nil, err
			}
			arr = append(arr, value)
		}
		if _, err := dec.Token(); err != nil { // 消费 ']'
			return nil, err
		}
		return arr, nil
	default:
		return nil, errors.New("json: unexpected delimiter")
	}
}

// asRecord 断言 any 为对象（TS isRecord：非 null、typeof object、非数组）。
func asRecord(value any) (*jsonObject, bool) {
	obj, ok := value.(*jsonObject)
	return obj, ok
}

// asString 断言 any 为字符串（TS typeof x === 'string'）。
func asString(value any) (string, bool) {
	s, ok := value.(string)
	return s, ok
}

// asNumber 断言 any 为数（TS typeof x === 'number'；JSON 解析不含 NaN/Infinity）。
func asNumber(value any) (float64, bool) {
	f, ok := value.(float64)
	return f, ok
}

// asArray 断言 any 为数组。
func asArray(value any) ([]any, bool) {
	a, ok := value.([]any)
	return a, ok
}

// isFiniteNumber TS Number.isFinite 的等价判定（float64 排除 NaN/±Inf）。
func isFiniteNumber(f float64) bool {
	return !math.IsNaN(f) && !math.IsInf(f, 0)
}

// convertJSONValue 把 encoding/json 解析的 map[string]any 树递归转换为保留键序的
// jsonObject 树（请求体经 middleware.ReadJSONBody 进来，域内校验按 jsonObject 判型；
// 请求体校验对键序不敏感，此处仅统一表示）。
func convertJSONValue(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		obj := newJSONObject()
		for key, item := range typed {
			obj.set(key, convertJSONValue(item))
		}
		return obj
	case []any:
		for i, item := range typed {
			typed[i] = convertJSONValue(item)
		}
		return typed
	default:
		return value
	}
}
