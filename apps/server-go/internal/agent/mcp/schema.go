package mcp

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"sync"

	"elysian/server/internal/agent/jsonvalue"
	"github.com/santhosh-tekuri/jsonschema/v6"
	"github.com/santhosh-tekuri/jsonschema/v6/kind"
)

var schemaCache = struct {
	sync.Mutex
	items map[[32]byte]*jsonschema.Schema
	order [][32]byte
}{items: make(map[[32]byte]*jsonschema.Schema)}

type denyLoader struct{}

func (denyLoader) Load(string) (any, error) {
	return nil, errors.New("禁止加载外部 JSON Schema 引用")
}

// ValidationHint projects only frozen schema field names and constraint kinds.
// ValidationError.Error() may contain instance values and must not be exposed.
func ValidationHint(schema, instance json.RawMessage) string {
	fallback := "参数不符合已加载工具定义的字段约束"
	compiled, err := compileSchema(schema)
	if err != nil {
		return fallback
	}
	value, err := jsonvalue.Decode(instance)
	if err != nil {
		return fallback
	}
	var invalid *jsonschema.ValidationError
	if !errors.As(compiled.Validate(value), &invalid) {
		return fallback
	}
	doc, _ := jsonvalue.Decode(schema)
	fields := map[string]bool{}
	var collect func(any)
	collect = func(v any) {
		switch v := v.(type) {
		case map[string]any:
			if properties, ok := v["properties"].(map[string]any); ok {
				for name, child := range properties {
					fields[name] = true
					collect(child)
				}
			}
			for key, child := range v {
				if mapKeywords[key] || schemaKeywords[key] || arrayKeywords[key] {
					collect(child)
				}
			}
		case []any:
			for _, child := range v {
				collect(child)
			}
		}
	}
	collect(doc)
	for len(invalid.Causes) > 0 {
		invalid = invalid.Causes[0]
	}
	if missing, ok := invalid.ErrorKind.(*kind.Required); ok {
		names := []string{}
		for _, name := range missing.Missing {
			if fields[name] && len(name) <= 64 {
				names = append(names, name)
				if len(names) == 3 {
					break
				}
			}
		}
		if len(names) > 0 {
			return "缺少必填字段：" + strings.Join(names, "、")
		}
	}
	path := "参数"
	for _, component := range invalid.InstanceLocation {
		if fields[component] && len(component) <= 64 {
			path += "." + component
		} else if index, err := strconv.Atoi(component); err == nil && index >= 0 {
			path += "[" + strconv.Itoa(index) + "]"
		} else {
			path += ".未声明字段"
			break
		}
	}
	keyword := invalid.ErrorKind.KeywordPath()
	constraint := "字段"
	if len(keyword) > 0 {
		switch keyword[0] {
		case "type", "enum", "const", "required", "additionalProperties", "minimum", "maximum", "minLength", "maxLength", "pattern", "minItems", "maxItems", "oneOf", "anyOf", "format":
			constraint = keyword[0]
		}
	}
	return path + " 不符合 " + constraint + " 约束"
}

// Validate 固定使用 2020-12；数值校验直接使用 json.Number，不经过 float64。
func Validate(schema, instance json.RawMessage) error {
	compiled, err := compileSchema(schema)
	if err != nil {
		return err
	}
	value, err := jsonvalue.Decode(instance)
	if err != nil {
		return problem(400, "invalid-mcp-arguments", "MCP 参数包含无效 JSON 或重复字段")
	}
	if compiled.Validate(value) != nil {
		return problem(400, "mcp-schema-mismatch", "MCP 参数或结构化结果不符合已固定的 JSON Schema")
	}
	return nil
}

// ValidateSchema 复用相同的严格 2020-12 编译边界，仅校验结构而不要求实例。
func ValidateSchema(schema json.RawMessage) error {
	_, err := compileSchema(schema)
	return err
}
func normalizeSchema(raw json.RawMessage) (json.RawMessage, error) {
	canonical, err := jsonvalue.Canonical(raw)
	if err != nil {
		return nil, schemaError()
	}
	obj, err := jsonvalue.Object(canonical)
	if err != nil || obj["type"] != "object" {
		return nil, schemaError()
	}
	if _, err := compileSchema(canonical); err != nil {
		return nil, err
	}
	return canonical, nil
}
func compileSchema(raw json.RawMessage) (*jsonschema.Schema, error) {
	if len(raw) == 0 || len(raw) > 128<<10 {
		return nil, schemaError()
	}
	canonical, err := jsonvalue.Canonical(raw)
	if err != nil {
		return nil, schemaError()
	}
	key := sha256.Sum256(canonical)
	schemaCache.Lock()
	cached := schemaCache.items[key]
	schemaCache.Unlock()
	if cached != nil {
		return cached, nil
	}
	doc, err := jsonvalue.Decode(canonical)
	if err != nil || checkSchema(doc, 0) != nil {
		return nil, schemaError()
	}
	c := jsonschema.NewCompiler()
	c.DefaultDraft(jsonschema.Draft2020)
	c.UseLoader(denyLoader{})
	c.AssertFormat()
	c.AssertContent()
	const location = "urn:elysian:mcp:local-schema"
	if c.AddResource(location, doc) != nil {
		return nil, schemaError()
	}
	compiled, err := c.Compile(location)
	if err != nil {
		return nil, schemaError()
	}
	schemaCache.Lock()
	defer schemaCache.Unlock()
	if cached := schemaCache.items[key]; cached != nil {
		return cached, nil
	}
	if len(schemaCache.order) >= 128 {
		delete(schemaCache.items, schemaCache.order[0])
		schemaCache.order = schemaCache.order[1:]
	}
	schemaCache.items[key] = compiled
	schemaCache.order = append(schemaCache.order, key)
	return compiled, nil
}
func schemaError() *Error {
	return problem(400, "mcp-schema-invalid", "MCP JSON Schema 无效、包含外部引用或不支持的约束")
}

var scalarKeywords = wordSet("$id $anchor $dynamicAnchor $comment title description default examples deprecated readOnly writeOnly type enum const multipleOf maximum exclusiveMaximum minimum exclusiveMinimum maxLength minLength pattern maxItems minItems uniqueItems maxContains minContains maxProperties minProperties required dependentRequired")
var schemaKeywords = wordSet("not if then else items contains additionalProperties propertyNames unevaluatedItems unevaluatedProperties contentSchema")
var mapKeywords = wordSet("$defs properties patternProperties dependentSchemas")
var arrayKeywords = wordSet("allOf anyOf oneOf prefixItems")
var formats = wordSet("date-time date time duration email idn-email hostname idn-hostname ipv4 ipv6 uri uri-reference iri iri-reference uuid uri-template json-pointer relative-json-pointer regex")
var vocabularies = wordSet("core applicator unevaluated validation meta-data format-annotation format-assertion content")

func wordSet(s string) map[string]bool {
	out := make(map[string]bool)
	for _, v := range strings.Fields(s) {
		out[v] = true
	}
	return out
}

// 检查只递归 schema 所在位置，实例中的属性名、enum 与 default 不当作约束。
func checkSchema(value any, depth int) error {
	if depth > 64 {
		return schemaError()
	}
	if _, ok := value.(bool); ok {
		return nil
	}
	obj, ok := value.(map[string]any)
	if !ok {
		return schemaError()
	}
	for k, v := range obj {
		switch {
		case scalarKeywords[k]:
		case schemaKeywords[k]:
			if err := checkSchema(v, depth+1); err != nil {
				return err
			}
		case mapKeywords[k]:
			m, ok := v.(map[string]any)
			if !ok {
				return schemaError()
			}
			for _, item := range m {
				if err := checkSchema(item, depth+1); err != nil {
					return err
				}
			}
		case arrayKeywords[k]:
			arr, ok := v.([]any)
			if !ok {
				return schemaError()
			}
			for _, item := range arr {
				if err := checkSchema(item, depth+1); err != nil {
					return err
				}
			}
		case k == "$schema":
			s, ok := v.(string)
			if !ok || strings.TrimSuffix(s, "#") != "https://json-schema.org/draft/2020-12/schema" {
				return schemaError()
			}
		case k == "$ref" || k == "$dynamicRef":
			s, ok := v.(string)
			if !ok || !strings.HasPrefix(s, "#") {
				return schemaError()
			}
		case k == "$vocabulary":
			m, ok := v.(map[string]any)
			if !ok {
				return schemaError()
			}
			for key, enabled := range m {
				suffix, hasPrefix := strings.CutPrefix(key, "https://json-schema.org/draft/2020-12/vocab/")
				if _, ok := enabled.(bool); !ok || !hasPrefix || !vocabularies[suffix] {
					return schemaError()
				}
			}
		case k == "format":
			s, ok := v.(string)
			if !ok || !formats[s] {
				return schemaError()
			}
		case k == "contentEncoding":
			s, ok := v.(string)
			if !ok || s != "base64" {
				return schemaError()
			}
		case k == "contentMediaType":
			s, ok := v.(string)
			if !ok || s != "application/json" {
				return schemaError()
			}
		default:
			return schemaError()
		}
	}
	return nil
}
