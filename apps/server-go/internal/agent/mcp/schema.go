package mcp

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"strings"
	"sync"

	"elysian/server/internal/agent/jsonvalue"
	"github.com/santhosh-tekuri/jsonschema/v6"
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
