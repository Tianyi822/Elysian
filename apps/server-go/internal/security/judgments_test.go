package security

// 契约判据与 JS 兼容强转的对等测试（对齐 contracts 的 ssh.ts/users.ts 与路由层
// Number()/String() 强转语义——security 盘点 §3.1 与风险 9）。

import (
	"math"
	"testing"
)

func TestIsValidSshPort(t *testing.T) {
	cases := []struct {
		port float64
		want bool
	}{
		{0, false},
		{1, true},
		{22, true},
		{65535, true},
		{65536, false},
		{22.5, false},
		{-1, false},
		{math.NaN(), false},
		{math.Inf(1), false},
	}
	for _, c := range cases {
		if got := IsValidSshPort(c.port); got != c.want {
			t.Errorf("IsValidSshPort(%v) = %v，want %v", c.port, got, c.want)
		}
	}
}

func TestIsValidSshKeyName(t *testing.T) {
	cases := []struct {
		name string
		want bool
	}{
		{"部署机", true},
		{"  ", false},
		{"a", true},
		{"", false},
		{"012345678901234567890123456789012", false}, // 33 字符
		{"a1234567890123456789012345678901", true},   // 32 字符且字母开头
		{"  去空白后有效  ", true},                         // trim 后 6 字符
	}
	for _, c := range cases {
		if got := IsValidSshKeyName(c.name); got != c.want {
			t.Errorf("IsValidSshKeyName(%q) = %v，want %v", c.name, got, c.want)
		}
	}
}

func TestEvaluateSshPasswordStrength(t *testing.T) {
	cases := []struct {
		password string
		want     string
	}{
		{"short", "weak"},
		{"abcdefgh", "weak"},        // 8 位但只有小写一类
		{"Abcdefg1", "medium"},      // 8 位两类
		{"Abcdefg12345", "strong"},  // 12 位三类
		{"Abcdefg12345!", "strong"}, // 13 位四类
		{"12345678", "weak"},        // 8 位一类（数字）
		{"A1!", "weak"},             // 三类但长度不足
		{"Ab1!Ab1!Ab1!", "strong"},  // 12 位四类
	}
	for _, c := range cases {
		if got := EvaluateSshPasswordStrength(c.password); got != c.want {
			t.Errorf("EvaluateSshPasswordStrength(%q) = %q，want %q", c.password, got, c.want)
		}
	}
}

func TestIsValidHostUserName(t *testing.T) {
	cases := []struct {
		name string
		want bool
	}{
		{"newops", true},
		{"_daemon", true},
		{"a-b_c2", true},
		{"2start", false},
		{"-start", false},
		{"HasUpper", false},
		{"has.dot", false},
		{"", false},
		{"012345678901234567890123456789012", false}, // 33 字符
		{"a1234567890123456789012345678901", true},   // 32 字符且字母开头
	}
	for _, c := range cases {
		if got := IsValidHostUserName(c.name); got != c.want {
			t.Errorf("IsValidHostUserName(%q) = %v，want %v", c.name, got, c.want)
		}
	}
}

func TestHasUnsafeControlChars(t *testing.T) {
	unsafe := []string{"a\nb", "a\rb", "a\x00b", "a\x1fb", "a\x7fb", "a\u2028b", "a\u2029b"}
	for _, text := range unsafe {
		if !hasUnsafeControlChars(text) {
			t.Errorf("hasUnsafeControlChars(%q) 应为 true", text)
		}
	}
	safe := []string{"正常备注", "ok note!"}
	for _, text := range safe {
		if hasUnsafeControlChars(text) {
			t.Errorf("hasUnsafeControlChars(%q) 应为 false", text)
		}
	}
}

func TestSshRootLoginPolicies枚举(t *testing.T) {
	want := []string{"no", "prohibit-password", "forced-commands-only", "yes"}
	if len(SSHRootLoginPolicies) != len(want) {
		t.Fatalf("SSH_ROOT_LOGIN_POLICIES 取值数不对")
	}
	for i, v := range want {
		if SSHRootLoginPolicies[i] != v {
			t.Errorf("SSHRootLoginPolicies[%d] = %q，want %q", i, SSHRootLoginPolicies[i], v)
		}
	}
}

func TestJsNumber强转语义(t *testing.T) {
	cases := []struct {
		name  string
		value any
		want  float64
		isNaN bool
	}{
		{"数字字符串", any("2202"), 2202, false},
		{"null", any(nil), 0, false},
		{"true", any(true), 1, false},
		{"false", any(false), 0, false},
		{"数字", any(22.5), 22.5, false},
		{"空串", any(""), 0, false},
		{"十六进制", any("0x10"), 16, false},
		{"科学计数", any("1e3"), 1000, false},
		{"Infinity", any("Infinity"), math.Inf(1), false},
		{"负Infinity", any("-Infinity"), math.Inf(-1), false},
		{"乱串", any("abc"), 0, true},
		{"对象", any(map[string]any{"a": 1.0}), 0, true},
		{"空数组", any([]any{}), 0, false},
		{"单元素数组数字串", any([]any{"2202"}), 2202, false},
		{"单元素数组数字", any([]any{5.0}), 5, false},
		{"单元素数组null", any([]any{nil}), 0, false},
		{"多元素数组", any([]any{1.0, 2.0}), 0, true},
		{"带空白的串", any("  22 \n"), 22, false},
		{"加号串", any("+22"), 22, false},
		{"加号", any("+"), 0, true},
	}
	for _, c := range cases {
		got, isNaN := jsNumber(c.value)
		if isNaN != c.isNaN {
			t.Errorf("jsNumber(%s) isNaN = %v，want %v", c.name, isNaN, c.isNaN)
			continue
		}
		if !isNaN && got != c.want {
			t.Errorf("jsNumber(%s) = %v，want %v", c.name, got, c.want)
		}
	}
}

func TestJsNumberToString按ECMAScript规则(t *testing.T) {
	cases := []struct {
		f    float64
		want string
	}{
		{22, "22"},
		{22.5, "22.5"},
		{0, "0"},
		{math.Copysign(0, -1), "0"},
		{100000000000000000000, "100000000000000000000"}, // 1e20 固定记法
		{1e21, "1e+21"},    // 1e21 起指数记法
		{1e-6, "0.000001"}, // -6 < n 固定记法
		{1e-7, "1e-7"},     // n=-6 指数记法且指数无零填充
		{1.5e-7, "1.5e-7"},
		{123.456, "123.456"},
		{0.5, "0.5"},
		{math.NaN(), "NaN"},
		{math.Inf(1), "Infinity"},
		{math.Inf(-1), "-Infinity"},
		{-22, "-22"},
	}
	for _, c := range cases {
		if got := jsNumberToString(c.f); got != c.want {
			t.Errorf("jsNumberToString(%v) = %q，want %q", c.f, got, c.want)
		}
	}
}

func TestJsStringOf强转语义(t *testing.T) {
	cases := []struct {
		value any
		want  string
	}{
		{nil, "null"},
		{true, "true"},
		{false, "false"},
		{"随便", "随便"},
		{12.0, "12"},
		{22.5, "22.5"},
		{[]any{1.0, 2.0}, "1,2"},
		{[]any{nil}, ""},
		{map[string]any{}, "[object Object]"},
	}
	for _, c := range cases {
		if got := jsStringOf(c.value); got != c.want {
			t.Errorf("jsStringOf(%v) = %q，want %q", c.value, got, c.want)
		}
	}
	if got := jsDisplay(nil, false); got != "undefined" {
		t.Errorf("jsDisplay(缺键) = %q，want \"undefined\"", got)
	}
}

func TestJsParseInt语义(t *testing.T) {
	cases := []struct {
		text  string
		want  int
		valid bool
	}{
		{"123", 123, true},
		{" 123\n", 123, true},
		{"12abc", 12, true},
		{"abc", 0, false},
		{"-5", -5, true},
		{"+7", 7, true},
		{"", 0, false},
	}
	for _, c := range cases {
		got, valid := jsParseInt(c.text)
		if valid != c.valid || (valid && got != c.want) {
			t.Errorf("jsParseInt(%q) = (%d, %v)，want (%d, %v)", c.text, got, valid, c.want, c.valid)
		}
	}
}

func TestJsonProp属性访问语义(t *testing.T) {
	body := any(map[string]any{"name": "x"})
	v, present, err := jsonProp(body, "name")
	if err != nil || !present || v != "x" {
		t.Errorf("jsonProp 对象取属性失败：%v %v %v", v, present, err)
	}
	v, present, err = jsonProp(body, "missing")
	if err != nil || present || v != nil {
		t.Errorf("jsonProp 缺键应得 (nil,false,nil)：(%v,%v,%v)", v, present, err)
	}
	v, present, err = jsonProp(any([]any{1.0}), "name")
	if err != nil || present || v != nil {
		t.Errorf("jsonProp 非对象取属性应得 undefined：(%v,%v,%v)", v, present, err)
	}
	_, _, err = jsonProp(nil, "enabled")
	if err == nil || err.Error() != "Cannot read properties of null (reading 'enabled')" {
		t.Errorf("jsonProp null 取属性应抛 V8 文案，得 %v", err)
	}
}
