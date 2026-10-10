package jsonvalue

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestCanonicalPreservesNumberTextAndSortsObjects(t *testing.T) {
	got, err := Canonical([]byte(`{"z":[9007199254740993,1.2300e+1000],"a":{"b":-0}}`))
	if err != nil || string(got) != `{"a":{"b":-0},"z":[9007199254740993,1.2300e+1000]}` {
		t.Fatalf("数值精度或键排序错误：%s %v", got, err)
	}
	obj, err := Object([]byte(`{"n":9007199254740993}`))
	if err != nil || obj["n"].(json.Number).String() != "9007199254740993" {
		t.Fatal("数字不应转为浮点数")
	}
}

func TestRejectAmbiguousAndInvalidJSON(t *testing.T) {
	for _, raw := range []string{`{"a":1,"a":2}`, `{"a":{"x":0,"x":1}}`, `{"a":1,"\u0061":2}`, `{} {}`, `[]x`, `{"x":NaN}`, `{"x":01}`, "[" + strings.Repeat("[", 130) + strings.Repeat("]", 131), "\xff"} {
		if _, err := Canonical([]byte(raw)); err == nil {
			t.Fatalf("错误接收：%s", raw)
		}
	}
	for _, raw := range []string{"null", "[]", "1", `"x"`} {
		if _, err := Object([]byte(raw)); err == nil {
			t.Fatalf("错误接收非对象：%s", raw)
		}
	}
}
