package mcp

import (
	"encoding/json"
	"testing"
)

func TestSchemaPrecisionAnd2020Constraints(t *testing.T) {
	schema := json.RawMessage(`{"type":"object","properties":{"n":{"type":"integer","const":9007199254740993},"list":{"type":"array","prefixItems":[{"const":"head"}],"items":{"type":"integer"},"contains":{"const":7},"minContains":1}},"required":["n","list"],"unevaluatedProperties":false}`)
	if err := Validate(schema, json.RawMessage(`{"n":9007199254740993,"list":["head",7]}`)); err != nil {
		t.Fatal(err)
	}
	for _, instance := range []string{`{"n":9007199254740992,"list":["head",7]}`, `{"n":9007199254740993,"list":["head",1]}`, `{"n":9007199254740993,"list":["head",7],"extra":true}`} {
		if err := Validate(schema, json.RawMessage(instance)); err == nil {
			t.Fatalf("错误接收 %s", instance)
		}
	}
}
func TestSchemaNeverLoadsExternalOrSilentlyDropsConstraints(t *testing.T) {
	for _, raw := range []string{`{"$ref":"https://example.test/schema"}`, `{"$ref":"file:///etc/passwd"}`, `{"type":"object","unrecognized":true}`, `{"format":"custom-format"}`, `{"$schema":"http://json-schema.org/draft-07/schema#"}`} {
		if err := Validate(json.RawMessage(raw), json.RawMessage(`{}`)); err == nil {
			t.Fatalf("错误接收 %s", raw)
		}
	}
	local := json.RawMessage(`{"$defs":{"n":{"type":"integer","minimum":10}},"type":"object","properties":{"n":{"$ref":"#/$defs/n"}},"required":["n"]}`)
	if err := Validate(local, json.RawMessage(`{"n":11}`)); err != nil {
		t.Fatal(err)
	}
	if err := Validate(local, json.RawMessage(`{"n":1}`)); err == nil {
		t.Fatal("本地引用没有执行")
	}
}
