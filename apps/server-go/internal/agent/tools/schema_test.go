package tools

import (
	"math"
	"strings"
	"testing"
)

// intPtr 供 MinLength 用例取值指针。
func intPtr(v int) *int { return &v }

func TestSchemaValidateObject(t *testing.T) {
	schema := Schema{
		Type:     "object",
		Required: []string{"slug"},
		Properties: map[string]Schema{
			"slug":  {Type: "string", MinLength: intPtr(2)},
			"limit": {Type: "integer"},
		},
	}

	if err := schema.Validate(map[string]any{"slug": "web-a", "limit": 3}); err != nil {
		t.Fatalf("合法参数应通过：%v", err)
	}
	if err := schema.Validate(map[string]any{"slug": "web-a"}); err != nil {
		t.Fatalf("可选参数缺省应通过：%v", err)
	}

	err := schema.Validate(map[string]any{})
	if err == nil || !strings.Contains(err.Error(), "缺少必填参数 \"slug\"") {
		t.Fatalf("缺必填项应失败闭合，实际：%v", err)
	}
	err = schema.Validate(map[string]any{"slug": "a"})
	if err == nil || !strings.Contains(err.Error(), "minLength") {
		t.Fatalf("长度不足应失败，实际：%v", err)
	}
	err = schema.Validate(map[string]any{"slug": "web-a", "limit": "3"})
	if err == nil || !strings.Contains(err.Error(), "integer") {
		t.Fatalf("类型不符应失败，实际：%v", err)
	}
	err = schema.Validate(map[string]any{"slug": "web-a", "limit": 3.5})
	if err == nil || !strings.Contains(err.Error(), "integer") {
		t.Fatalf("非整数值应失败，实际：%v", err)
	}
	err = schema.Validate(map[string]any{"slug": "web-a", "who": "x"})
	if err == nil || !strings.Contains(err.Error(), "未在参数模式中声明") {
		t.Fatalf("未声明的参数应拒绝，实际：%v", err)
	}
	err = schema.Validate("web-a")
	if err == nil || !strings.Contains(err.Error(), "object") {
		t.Fatalf("非对象参数应失败，实际：%v", err)
	}
}

func TestSchemaValidateScalars(t *testing.T) {
	cases := []struct {
		name   string
		schema Schema
		value  any
		ok     bool
	}{
		{"字符串", Schema{Type: "string"}, "web-a", true},
		{"字符串收到数字", Schema{Type: "string"}, 1, false},
		{"正则通过", Schema{Type: "string", Pattern: `^[a-z-]+$`}, "web-a", true},
		{"正则不通过", Schema{Type: "string", Pattern: `^[a-z-]+$`}, "Web_A", false},
		{"枚举通过", Schema{Type: "string", Enum: []any{"a", "b"}}, "b", true},
		{"枚举不通过", Schema{Type: "string", Enum: []any{"a", "b"}}, "c", false},
		{"数字通过", Schema{Type: "number"}, 3.5, true},
		{"数字接受整数", Schema{Type: "number"}, 3, true},
		{"布尔通过", Schema{Type: "boolean"}, true, true},
		{"布尔收到字符串", Schema{Type: "boolean"}, "true", false},
		{"数组通过", Schema{Type: "array", Items: &Schema{Type: "string"}}, []any{"a", "b"}, true},
		{"数组元素类型不符", Schema{Type: "array", Items: &Schema{Type: "string"}}, []any{"a", 2}, false},
		{"数组无 items 接受任意元素", Schema{Type: "array"}, []any{"a", 2, nil}, true},
		{"数组枚举命中", Schema{Type: "array", Enum: []any{[]any{"a"}}}, []any{"a"}, true},
		{"数组枚举不命中", Schema{Type: "array", Enum: []any{[]any{"a"}}}, []any{"b"}, false},
		{"整数收到 NaN", Schema{Type: "integer"}, math.NaN(), false},
		{"对象收到 nil", Schema{Type: "object"}, nil, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.schema.Validate(tc.value)
			if tc.ok && err != nil {
				t.Fatalf("应通过：%v", err)
			}
			if !tc.ok && err == nil {
				t.Fatal("应失败闭合")
			}
		})
	}
}

func TestSchemaValidateFailClosed(t *testing.T) {
	cases := []struct {
		name   string
		schema Schema
		needle string
	}{
		{"类型缺失", Schema{}, "未声明参数类型"},
		{"类型未知", Schema{Type: "map"}, "不支持的参数类型 \"map\""},
		{"非对象声明必填", Schema{Type: "string", Required: []string{"a"}}, "只能用于 object"},
		{"非对象声明属性", Schema{Type: "string", Properties: map[string]Schema{"a": {Type: "string"}}}, "只能用于 object"},
		{"非数组声明元素", Schema{Type: "string", Items: &Schema{Type: "string"}}, "只能用于 array"},
		{"非字符串声明长度", Schema{Type: "integer", MinLength: intPtr(1)}, "只能用于 string"},
		{"非字符串声明正则", Schema{Type: "integer", Pattern: "^a$"}, "只能用于 string"},
		{"长度为负", Schema{Type: "string", MinLength: intPtr(-1)}, "minLength 不得为负"},
		{"正则非法", Schema{Type: "string", Pattern: "([a-z"}, "正则表达式非法"},
		{"嵌套属性类型非法", Schema{Type: "object", Properties: map[string]Schema{"a": {Type: "map"}}}, "不支持的参数类型 \"map\""},
		{"枚举值类型不符", Schema{Type: "string", Enum: []any{1}}, "枚举取值必须与参数类型一致"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.schema.Validate(map[string]any{"a": "b"})
			if err == nil {
				t.Fatal("应失败闭合")
			}
			if !strings.Contains(err.Error(), tc.needle) {
				t.Fatalf("期望错误含 %q，实际：%v", tc.needle, err)
			}
		})
	}
}

func TestSchemaJSONSchema(t *testing.T) {
	schema := Schema{
		Type:        "object",
		Description: "工作区标识",
		Required:    []string{"slug"},
		Properties: map[string]Schema{
			"slug": {Type: "string", Description: "短名", MinLength: intPtr(2), Pattern: `^[a-z-]+$`},
			"tags": {Type: "array", Items: &Schema{Type: "string", Enum: []any{"a"}}},
		},
	}

	got := schema.JSONSchema()
	if got["type"] != "object" || got["description"] != "工作区标识" {
		t.Fatalf("顶层导出缺字段：%v", got)
	}
	if _, ok := got["enum"]; ok {
		t.Fatal("未声明的 enum 不应出现在导出里")
	}
	required, ok := got["required"].([]string)
	if !ok || len(required) != 1 || required[0] != "slug" {
		t.Fatalf("required 导出错误：%v", got["required"])
	}
	props, ok := got["properties"].(map[string]any)
	if !ok {
		t.Fatalf("properties 导出错误：%v", got["properties"])
	}
	slug, ok := props["slug"].(map[string]any)
	if !ok {
		t.Fatalf("嵌套 properties 导出错误：%v", props["slug"])
	}
	if slug["minLength"] != 2 || slug["pattern"] != `^[a-z-]+$` {
		t.Fatalf("嵌套字段导出缺项：%v", slug)
	}
	tags, ok := props["tags"].(map[string]any)
	if !ok {
		t.Fatalf("数组属性导出错误：%v", props["tags"])
	}
	items, ok := tags["items"].(map[string]any)
	if !ok || items["type"] != "string" {
		t.Fatalf("items 导出错误：%v", tags)
	}
}
