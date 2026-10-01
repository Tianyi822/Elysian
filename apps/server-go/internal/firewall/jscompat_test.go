package firewall

import (
	"math"
	"testing"
)

// jscompat 的契约锚点：encodeURIComponent 的转义集合与存量 sqlite 键、前端回传 id
// 全部相关（盘点 §9.1）；Number 宽进与 String(number) 决定错误消息文本（§9.6）。

func TestJsEncodeURIComponent(t *testing.T) {
	cases := map[string]string{
		"any":                 "any",
		"192.168.1.0/24":      "192.168.1.0%2F24",
		"fd00::/8":            "fd00%3A%3A%2F8",
		"203.0.113.9":         "203.0.113.9",
		"10.0.0.0/8":          "10.0.0.0%2F8",
		"with space":          "with%20space",
		"a-b_c.d!e~f*g'h(i)j": "a-b_c.d!e~f*g'h(i)j",
		"所有IP":                "%E6%89%80%E6%9C%89IP",
		"evil'; rm -rf /":     "evil'%3B%20rm%20-rf%20%2F",
	}
	for input, want := range cases {
		if got := jsEncodeURIComponent(input); got != want {
			t.Errorf("jsEncodeURIComponent(%q) = %q，want %q", input, got, want)
		}
	}
}

func TestJsDecodeURIComponent(t *testing.T) {
	roundTrips := []string{"any", "192.168.1.0/24", "fd00::/8", "203.0.113.9", "所有IP", "evil'; rm -rf /"}
	for _, s := range roundTrips {
		got, err := jsDecodeURIComponent(jsEncodeURIComponent(s))
		if err != nil || got != s {
			t.Errorf("decode(encode(%q)) = %q, err=%v", s, got, err)
		}
	}
	if _, err := jsDecodeURIComponent("ufw-allow-%zz"); err == nil {
		t.Error("非法百分号序列应返回错误")
	}
}

func TestJsNumber(t *testing.T) {
	if got := jsNumber(nil); !math.IsNaN(got) {
		t.Errorf("Number(undefined) 应为 NaN，得到 %v", got)
	}
	if got := jsNumber(float64(8080)); got != 8080 {
		t.Errorf("Number(8080) = %v", got)
	}
	if got := jsNumber("8080"); got != 8080 {
		t.Errorf(`Number("8080") = %v，字符串数字应可转`, got)
	}
	if got := jsNumber("not-a-number"); !math.IsNaN(got) {
		t.Errorf(`Number("垃圾") 应为 NaN，得到 %v`, got)
	}
	if got := jsNumber(""); got != 0 {
		t.Errorf(`Number("") = %v，应为 0`, got)
	}
	if got := jsNumber(true); got != 1 {
		t.Errorf("Number(true) = %v", got)
	}
	if got := jsNumber(false); got != 0 {
		t.Errorf("Number(false) = %v", got)
	}
	if got := jsNumber("0x10"); got != 16 {
		t.Errorf(`Number("0x10") = %v，应为 16`, got)
	}
	if got := jsNumber(map[string]any{}); !math.IsNaN(got) {
		t.Errorf("Number({}) 应为 NaN")
	}
	if got := jsNumber([]any{}); got != 0 {
		t.Errorf("Number([]) = %v，应为 0", got)
	}
}

func TestJsNumberToString(t *testing.T) {
	cases := map[float64]string{
		math.NaN():  "NaN",
		8080:        "8080",
		0:           "0",
		8080.5:      "8080.5",
		70000:       "70000",
		math.Inf(1): "Infinity",
		1e21:        "1e+21",
	}
	for input, want := range cases {
		if got := jsNumberToString(input); got != want {
			t.Errorf("jsNumberToString(%v) = %q，want %q", input, got, want)
		}
	}
}

func TestJsIsInteger(t *testing.T) {
	if !jsIsInteger(8080) {
		t.Error("8080 应为整数")
	}
	if jsIsInteger(8080.5) {
		t.Error("8080.5 不应为整数")
	}
	if jsIsInteger(math.NaN()) {
		t.Error("NaN 不应为整数")
	}
}
