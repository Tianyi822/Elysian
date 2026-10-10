// Package jsonvalue 严格解析协议 JSON，保留数字原文并拒绝重复键。
package jsonvalue

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"unicode/utf8"
)

var errInvalid = errors.New("JSON 格式无效、嵌套过深或包含重复字段")

// Decode 仅接收一个完整 JSON 值；所有数字以 json.Number 返回。
func Decode(raw json.RawMessage) (any, error) {
	if !utf8.Valid(raw) {
		return nil, errInvalid
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	v, err := value(d, 0)
	if err != nil {
		return nil, errInvalid
	}
	if _, err = d.Token(); err != io.EOF {
		return nil, errInvalid
	}
	return v, nil
}

func value(d *json.Decoder, depth int) (any, error) {
	if depth > 128 {
		return nil, errInvalid
	}
	t, err := d.Token()
	if err != nil {
		return nil, err
	}
	delim, ok := t.(json.Delim)
	if !ok {
		return t, nil
	}
	switch delim {
	case '{':
		out := make(map[string]any)
		for d.More() {
			key, err := d.Token()
			if err != nil {
				return nil, err
			}
			name, ok := key.(string)
			if !ok {
				return nil, errInvalid
			}
			if _, exists := out[name]; exists {
				return nil, errInvalid
			}
			v, err := value(d, depth+1)
			if err != nil {
				return nil, err
			}
			out[name] = v
		}
		end, err := d.Token()
		if err != nil || end != json.Delim('}') {
			return nil, errInvalid
		}
		return out, nil
	case '[':
		out := make([]any, 0)
		for d.More() {
			v, err := value(d, depth+1)
			if err != nil {
				return nil, err
			}
			out = append(out, v)
		}
		end, err := d.Token()
		if err != nil || end != json.Delim(']') {
			return nil, errInvalid
		}
		return out, nil
	default:
		return nil, errInvalid
	}
}

// Canonical 对象键排序，数字精度及指数形式不经浮点数转换。
func Canonical(raw json.RawMessage) (json.RawMessage, error) {
	v, err := Decode(raw)
	if err != nil {
		return nil, err
	}
	b, err := json.Marshal(v)
	if err != nil {
		return nil, errInvalid
	}
	return b, nil
}

// Object 返回独立对象，拒绝 null、数组和原始值。
func Object(raw json.RawMessage) (map[string]any, error) {
	v, err := Decode(raw)
	if err != nil {
		return nil, err
	}
	obj, ok := v.(map[string]any)
	if !ok {
		return nil, errors.New("JSON 必须是对象")
	}
	return obj, nil
}
