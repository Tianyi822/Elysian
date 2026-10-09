// schema.go 提供描述符参数的 JSON Schema 子集：Go 侧用结构体声明、校验时
// 失败闭合，导出时才转成 map 形态。kardia 与 Cordis 上游都依赖 Standard
// Schema（schemastery）做参数校验，Go 侧无对应库且 go.mod 对域实现者只读，
// 因此本层自带子集实现（ADR-0023 缺口 1）。
package tools

import (
	"fmt"
	"math"
	"reflect"
	"regexp"
	"sort"
	"unicode/utf8"

	"elysian/server/internal/agent/kardia"
)

// 支持的参数类型（JSON Schema 子集）。
const (
	SchemaObject  = "object"
	SchemaString  = "string"
	SchemaNumber  = "number"
	SchemaInteger = "integer"
	SchemaBoolean = "boolean"
	SchemaArray   = "array"
)

// Schema 声明一个工具参数的形状。Type 必填；除 object/array 外的字段只能
// 出现在对应类型上，放错位置即校验失败（失败闭合优先于静默放行）。
type Schema struct {
	// Type 取 SchemaObject / SchemaString / SchemaNumber / SchemaInteger /
	// SchemaBoolean / SchemaArray。
	Type string
	// Description 是给调用方看的中文说明。
	Description string
	// Required 仅 object 有效：必须存在且非 nil 的键。
	Required []string
	// Properties 仅 object 有效。未声明的键一律拒绝，避免把未预期参数透传给域。
	Properties map[string]Schema
	// Enum 是允许取值，取值类型必须与 Type 一致。
	Enum []any
	// Items 仅 array 有效；为 nil 时数组元素不做类型校验。
	Items *Schema
	// MinLength 仅 string 有效，按 rune 计数。
	MinLength *int
	// Pattern 仅 string 有效，Go regexp 语法。
	Pattern string
}

// Validate 按本模式校验参数值。错误一律中文，路径写进消息便于定位。
func (s Schema) Validate(value any) error {
	if err := s.checkShape(""); err != nil {
		return err
	}
	return s.validate("", value)
}

// JSONSchema 导出为 JSON Schema 形态，只含已声明字段，供未来的模型侧消费。
func (s Schema) JSONSchema() map[string]any {
	out := map[string]any{"type": s.Type}
	if s.Type == SchemaObject {
		out["additionalProperties"] = false
		out["properties"] = map[string]any{}
	}
	if s.Description != "" {
		out["description"] = s.Description
	}
	if len(s.Required) > 0 {
		required := make([]string, len(s.Required))
		copy(required, s.Required)
		out["required"] = required
	}
	if len(s.Properties) > 0 {
		properties := make(map[string]any, len(s.Properties))
		for name, child := range s.Properties {
			properties[name] = child.JSONSchema()
		}
		out["properties"] = properties
	}
	if len(s.Enum) > 0 {
		out["enum"] = kardia.CloneConfig(s.Enum)
	}
	if s.Items != nil {
		out["items"] = s.Items.JSONSchema()
	}
	if s.MinLength != nil {
		out["minLength"] = *s.MinLength
	}
	if s.Pattern != "" {
		out["pattern"] = s.Pattern
	}
	return out
}

// checkShape 校验模式自身（含嵌套），与取值无关：模式写错必须在装载期暴露。
func (s Schema) checkShape(path string) error {
	switch s.Type {
	case SchemaObject, SchemaString, SchemaNumber, SchemaInteger, SchemaBoolean, SchemaArray:
	default:
		if s.Type == "" {
			return fmt.Errorf("%s未声明参数类型", label(path))
		}
		return fmt.Errorf("%s不支持的参数类型 %q", label(path), s.Type)
	}
	if s.Type != SchemaObject {
		if len(s.Required) > 0 {
			return fmt.Errorf("%s的 required 只能用于 object，实际类型为 %s", label(path), s.Type)
		}
		if len(s.Properties) > 0 {
			return fmt.Errorf("%s的 properties 只能用于 object，实际类型为 %s", label(path), s.Type)
		}
	}
	if s.Type != SchemaArray && s.Items != nil {
		return fmt.Errorf("%s的 items 只能用于 array，实际类型为 %s", label(path), s.Type)
	}
	if s.Type != SchemaString {
		if s.MinLength != nil {
			return fmt.Errorf("%s的 minLength 只能用于 string，实际类型为 %s", label(path), s.Type)
		}
		if s.Pattern != "" {
			return fmt.Errorf("%s的 pattern 只能用于 string，实际类型为 %s", label(path), s.Type)
		}
	}
	if s.MinLength != nil && *s.MinLength < 0 {
		return fmt.Errorf("%s的 minLength 不得为负", label(path))
	}
	seen := make(map[string]bool, len(s.Required))
	for _, name := range s.Required {
		if _, ok := s.Properties[name]; !ok {
			return fmt.Errorf("%s的 required 引用了未声明的属性 %q", label(path), name)
		}
		if seen[name] {
			return fmt.Errorf("%s的 required 重复声明了属性 %q", label(path), name)
		}
		seen[name] = true
	}
	if s.Pattern != "" {
		if _, err := regexp.Compile(s.Pattern); err != nil {
			return fmt.Errorf("%s的正则表达式非法：%w", label(path), err)
		}
	}
	for _, item := range s.Enum {
		if !typeMatches(s.Type, item) {
			return fmt.Errorf("%s的枚举取值必须与参数类型一致：期望 %s，收到 %s", label(path), s.Type, typeName(item))
		}
	}
	names := make([]string, 0, len(s.Properties))
	for name := range s.Properties {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if err := s.Properties[name].checkShape(childPath(path, name)); err != nil {
			return err
		}
	}
	if s.Items != nil {
		if err := s.Items.checkShape(indexPath(path, 0)); err != nil {
			return err
		}
	}
	return nil
}

func (s Schema) validate(path string, value any) error {
	if len(s.Enum) > 0 && !enumContains(s.Enum, value) {
		return fmt.Errorf("%s取值不在允许范围内", label(path))
	}
	switch s.Type {
	case SchemaObject:
		return s.validateObject(path, value)
	case SchemaArray:
		return s.validateArray(path, value)
	}
	if !typeMatches(s.Type, value) {
		return fmt.Errorf("%s必须是 %s，实际为 %s", label(path), s.Type, typeName(value))
	}
	if s.Type == SchemaString {
		text, _ := value.(string)
		if s.MinLength != nil && utf8.RuneCountInString(text) < *s.MinLength {
			return fmt.Errorf("%s长度不足：minLength 要求至少 %d，实际 %d", label(path), *s.MinLength, utf8.RuneCountInString(text))
		}
		if s.Pattern != "" {
			matched, err := regexp.MatchString(s.Pattern, text)
			if err != nil {
				return fmt.Errorf("%s的正则表达式非法：%w", label(path), err)
			}
			if !matched {
				return fmt.Errorf("%s不匹配 %s", label(path), s.Pattern)
			}
		}
	}
	return nil
}

func (s Schema) validateObject(path string, value any) error {
	object, ok := value.(map[string]any)
	if !ok {
		return fmt.Errorf("%s必须是 object，实际为 %s", label(path), typeName(value))
	}
	keys := make([]string, 0, len(object))
	for key := range object {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		if _, declared := s.Properties[key]; !declared {
			return fmt.Errorf("%s未在参数模式中声明，拒绝执行", label(childPath(path, key)))
		}
	}
	for _, name := range s.Required {
		got, exists := object[name]
		if !exists || got == nil {
			return fmt.Errorf("%s缺少必填参数 %q", label(path), name)
		}
	}
	for _, name := range keys {
		if err := s.Properties[name].validate(childPath(path, name), object[name]); err != nil {
			return err
		}
	}
	return nil
}

func (s Schema) validateArray(path string, value any) error {
	items, ok := value.([]any)
	if !ok {
		return fmt.Errorf("%s必须是 array，实际为 %s", label(path), typeName(value))
	}
	if len(s.Enum) > 0 && !enumContains(s.Enum, value) {
		return fmt.Errorf("%s取值不在允许范围内", label(path))
	}
	if s.Items == nil {
		return nil
	}
	for i, item := range items {
		if err := s.Items.validate(indexPath(path, i), item); err != nil {
			return err
		}
	}
	return nil
}

// typeMatches 报告值是否符合声明类型。数字一律按 JSON 解码后的形态接受
// （float64），同时接受 Go 调用方直接给的整数。
func typeMatches(schemaType string, value any) bool {
	switch schemaType {
	case SchemaString:
		_, ok := value.(string)
		return ok
	case SchemaBoolean:
		_, ok := value.(bool)
		return ok
	case SchemaNumber:
		f, ok := numberValue(value)
		return ok && !math.IsNaN(f) && !math.IsInf(f, 0)
	case SchemaInteger:
		_, ok := integerValue(value)
		return ok
	case SchemaObject:
		_, ok := value.(map[string]any)
		return ok
	case SchemaArray:
		_, ok := value.([]any)
		return ok
	}
	return false
}

func numberValue(value any) (float64, bool) {
	switch v := value.(type) {
	case float64:
		return v, true
	case float32:
		return float64(v), true
	case int:
		return float64(v), true
	case int8:
		return float64(v), true
	case int16:
		return float64(v), true
	case int32:
		return float64(v), true
	case int64:
		return float64(v), true
	case uint:
		return float64(v), true
	case uint8:
		return float64(v), true
	case uint16:
		return float64(v), true
	case uint32:
		return float64(v), true
	case uint64:
		return float64(v), true
	}
	return 0, false
}

// enumContains 精确比较数字，其余按 JSON 对象与数组的形状递归比较。
func enumContains(enum []any, value any) bool {
	for _, item := range enum {
		if jsonEqual(item, value) {
			return true
		}
	}
	return false
}

func jsonEqual(a, b any) bool {
	if _, ok := numberValue(a); ok {
		return kardia.NumbersEqual(a, b)
	}
	switch a := a.(type) {
	case map[string]any:
		other, ok := b.(map[string]any)
		if !ok || len(a) != len(other) {
			return false
		}
		for key, value := range a {
			got, exists := other[key]
			if !exists || !jsonEqual(value, got) {
				return false
			}
		}
		return true
	case []any:
		other, ok := b.([]any)
		if !ok || len(a) != len(other) {
			return false
		}
		for i, value := range a {
			if !jsonEqual(value, other[i]) {
				return false
			}
		}
		return true
	}
	return reflect.DeepEqual(a, b)
}

// clone 冻结模式中的全部可变字段，不与注册输入和对外快照共享引用。
func (s Schema) clone() Schema {
	s.Required = append([]string(nil), s.Required...)
	if s.Properties != nil {
		properties := make(map[string]Schema, len(s.Properties))
		for key, child := range s.Properties {
			properties[key] = child.clone()
		}
		s.Properties = properties
	}
	if s.Enum != nil {
		s.Enum = kardia.CloneConfig(s.Enum).([]any)
	}
	if s.Items != nil {
		child := s.Items.clone()
		s.Items = &child
	}
	if s.MinLength != nil {
		n := *s.MinLength
		s.MinLength = &n
	}
	return s
}

func typeName(value any) string {
	if value == nil {
		return "nil"
	}
	if _, ok := numberValue(value); ok {
		return SchemaNumber
	}
	switch value.(type) {
	case string:
		return SchemaString
	case bool:
		return SchemaBoolean
	case map[string]any:
		return SchemaObject
	case []any:
		return SchemaArray
	}
	return fmt.Sprintf("%T", value)
}

func label(path string) string {
	if path == "" {
		return "参数值"
	}
	return fmt.Sprintf("参数 %q", path)
}

func childPath(path, key string) string {
	if path == "" {
		return key
	}
	return path + "." + key
}

func indexPath(path string, index int) string {
	if path == "" {
		return fmt.Sprintf("[%d]", index)
	}
	return fmt.Sprintf("%s[%d]", path, index)
}
