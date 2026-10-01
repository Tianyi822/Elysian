package logs

import (
	"strings"
	"testing"
)

// normalizeSingleLine 的净化面：剥行分隔符与控制字符、压空白、截断标记语义
// （logRecords.test.ts ① 的对等用例）。
func TestNormalizeSingleLine(t *testing.T) {
	cases := []struct {
		name  string
		input string
		max   int
		want  string
	}{
		{"换行与制表换空格", "bad\nagent", 512, "bad agent"},
		{"回车", "a\rb", 512, "a b"},
		{"C0 控制字符", "a\x00\x1fb", 512, "a b"},
		{"DEL", "a\x7fb", 512, "a b"},
		{"C1（含 U+0085）", "a\u0085b", 512, "a b"},
		{"U+2028/U+2029", "a\u2028b\u2029c", 512, "a b c"},
		{"连续空白压成一个空格", "a \t\n b", 512, "a b"},
		{"NBSP 是 JS 空白", "a\u00A0b", 512, "a b"},
		{"U+FEFF 是 JS 空白", "a\uFEFFb", 512, "a b"},
		{"U+3000 是 JS 空白", "a\u3000b", 512, "a b"},
		{"U+2000 是 JS 空白", "a\u2000b", 512, "a b"},
		{"两侧 trim", "  hello  ", 512, "hello"},
		{"恰好上限不截断", "abcdef", 6, "abcdef"},
		{"超限追加截断标记", "abcdefghijk", 10, "abcd…（已截断）"},
		{"上限装不下标记退化为纯截断", "abcdefghij", 4, "abcd"},
		{"中文按 UTF-16 计长度", "一二三四五六七八九十", 8, "一二…（已截断）"},
	}
	for _, tc := range cases {
		if got := NormalizeSingleLine(tc.input, tc.max); got != tc.want {
			t.Errorf("%s: NormalizeSingleLine(%q, %d) = %q, want %q", tc.name, tc.input, tc.max, got, tc.want)
		}
	}
}

// UTF-16 长度与截断：emoji 代理对算 2；jsSlice 可在代理对中间截断（对齐 JS slice）。
func TestJSLengthAndSlice(t *testing.T) {
	if got := jsLength("😀"); got != 2 {
		t.Errorf("jsLength(emoji) = %d, want 2", got)
	}
	if got := jsLength("中文"); got != 2 {
		t.Errorf("jsLength(中文) = %d, want 2", got)
	}
	if got := jsSlice("a😀b", 2); got != "a\uFFFD" {
		// 截断落在代理对中间：Go 的 utf16.Decode 把孤立代理替换为 U+FFFD（3 字节），
		// 与 JS TextEncoder 对孤立代理的替换字节数一致（记录文本本身与 JS 孤立代理有
		// 微差，仅影响极端截断位置下的存储文本，不影响字节记账口径）。
		t.Errorf("jsSlice mid-surrogate = %q (bytes %v)", got, []byte(got))
	}
	if got := jsSlice("abcd", 10); got != "abcd" {
		t.Errorf("jsSlice beyond = %q", got)
	}
	// 截断标记按 UTF-16 长计（… + （ + 已截断 + ） = 6）。
	if got := jsLength(logTruncationMarker); got != 6 {
		t.Errorf("jsLength(marker) = %d, want 6", got)
	}
}

// UTF-8 字节数与 64 KiB 硬闸判据（logRecords.test.ts ② 的纯函数半边）。
func TestUTF8ByteLengthAndOversize(t *testing.T) {
	if got := UTF8ByteLength("中文"); got != 6 {
		t.Errorf("UTF8ByteLength(中文) = %d, want 6（中文 3 字节）", got)
	}
	if isRecordOversize(strings.Repeat("x", logRecordMaxBytes)) {
		t.Errorf("恰好 64 KiB 不应判超限")
	}
	if !isRecordOversize(strings.Repeat("x", logRecordMaxBytes+1)) {
		t.Errorf("超 1 字节应判超限")
	}
}

// parseRuntimeLogLine 的判据（logRecords.test.ts ③）。
func TestParseRuntimeLogLine(t *testing.T) {
	valid := `{"at":"2026-09-23T00:00:02.000Z","seq":3,"level":"info","source":"server.lifecycle","message":"启动","extra":"drop"}`
	rec := parseRuntimeLogLine(valid)
	if rec == nil {
		t.Fatal("合法行应解析成功")
	}
	if rec.at != "2026-09-23T00:00:02.000Z" || rec.seq != 3 || rec.level != "info" ||
		rec.source != "server.lifecycle" || rec.message != "启动" {
		t.Errorf("字段不符：%+v", rec)
	}
	bad := []string{
		``,
		`not json`,
		`[1,2]`,
		`"string"`,
		`{"at":"2026-09-23T00:00:02.000Z","seq":3,"level":"info","source":"s"}`,                 // 缺 message
		`{"at":"","seq":3,"level":"info","source":"s","message":"m"}`,                           // at 空
		`{"at":"nope","seq":3,"level":"info","source":"s","message":"m"}`,                       // at 不可解析
		`{"at":"2026-09-23T00:00:02.000Z","seq":1.5,"level":"info","source":"s","message":"m"}`, // seq 非整数
		`{"at":"2026-09-23T00:00:02.000Z","seq":"3","level":"info","source":"s","message":"m"}`, // seq 非数字
		`{"at":"2026-09-23T00:00:02.000Z","seq":3,"level":"trace","source":"s","message":"m"}`,  // level 越界
		`{"at":"2026-09-23T00:00:02.000Z","seq":3,"level":"info","source":42,"message":"m"}`,    // source 非字符串
		`{"at":"2026-09-23T00:00:02.000Z","seq":3,"level":"info","source":"s","messa`,           // 半行崩溃残行
	}
	for _, line := range bad {
		if got := parseRuntimeLogLine(line); got != nil {
			t.Errorf("parseRuntimeLogLine(%q) 应为 nil，得 %+v", line, got)
		}
	}
}

// parseLoginLogLine 的判据（§5 行解析判据）。
func TestParseLoginLogLine(t *testing.T) {
	valid := `{"at":"2026-09-23T00:00:02.000Z","seq":9,"ip":"127.0.0.1","location":"本机","userAgent":"UA","status":"success"}`
	rec := parseLoginLogLine(valid)
	if rec == nil || rec.status != "success" || rec.ip != "127.0.0.1" || rec.userAgent != "UA" {
		t.Fatalf("合法行应解析成功：%+v", rec)
	}
	bad := []string{
		`{"at":"2026-09-23T00:00:02.000Z","seq":9,"ip":"1.1.1.1","location":"未知","userAgent":"UA","status":"ok"}`,
		`{"at":"2026-09-23T00:00:02.000Z","seq":9,"ip":1,"location":"未知","userAgent":"UA","status":"success"}`,
		`{"at":"2026-09-23T00:00:02.000Z","seq":9,"ip":"1.1.1.1","location":"未知","userAgent":"UA"}`,
	}
	for _, line := range bad {
		if got := parseLoginLogLine(line); got != nil {
			t.Errorf("parseLoginLogLine(%q) 应为 nil", line)
		}
	}
}

// parseOperationLogLine 的判据（logRecords.test.ts ④：httpStatus 非整数 null 等）。
func TestParseOperationLogLine(t *testing.T) {
	valid := `{"at":"2026-09-23T00:00:02.000Z","seq":5,"category":"security","action":"修改 SSH 监听端口","target":"sshd","result":"success","httpStatus":200,"method":"PUT","path":"/api/security/ssh/port","summary":"端口 2222","actor":"evil"}`
	rec := parseOperationLogLine(valid)
	if rec == nil {
		t.Fatal("合法行应解析成功")
	}
	if rec.target == nil || *rec.target != "sshd" || rec.httpStatus == nil || *rec.httpStatus != 200 {
		t.Errorf("字段不符：%+v", rec)
	}
	bad := []string{
		`{"at":"2026-09-23T00:00:02.000Z","seq":5,"category":"nope","action":"a","result":"success","summary":"s"}`,
		`{"at":"2026-09-23T00:00:02.000Z","seq":5,"category":"security","action":1,"result":"success","summary":"s"}`,
		`{"at":"2026-09-23T00:00:02.000Z","seq":5,"category":"security","action":"a","target":"t","result":"maybe","summary":"s"}`,
		`{"at":"2026-09-23T00:00:02.000Z","seq":5,"category":"security","action":"a","target":"t","result":"success","httpStatus":200.5,"summary":"s"}`,
		`{"at":"2026-09-23T00:00:02.000Z","seq":5,"category":"security","action":"a","target":"t","result":"success","httpStatus":"200","summary":"s"}`,
		`{"at":"2026-09-23T00:00:02.000Z","seq":5,"category":"security","action":"a","target":"t","result":"success","summary":null}`,
		`{"at":"2026-09-23T00:00:02.000Z","seq":5,"category":"security","action":"a","target":42,"result":"success","summary":"s"}`,
	}
	for _, line := range bad {
		if got := parseOperationLogLine(line); got != nil {
			t.Errorf("parseOperationLogLine(%q) 应为 nil", line)
		}
	}
	// httpStatus / target / method / path 显式 null 合法。
	nullable := `{"at":"2026-09-23T00:00:02.000Z","seq":5,"category":"logs","action":"清空运行日志","target":null,"result":"success","httpStatus":null,"method":null,"path":null,"summary":"删除 0 条记录"}`
	rec = parseOperationLogLine(nullable)
	if rec == nil || rec.target != nil || rec.httpStatus != nil || rec.method != nil || rec.path != nil {
		t.Errorf("可空字段判据不符：%+v", rec)
	}
}

// logRecordId：`<at>#<seq>`。
func TestLogRecordId(t *testing.T) {
	if got := logRecordId("2026-09-23T00:00:02.000Z", 3); got != "2026-09-23T00:00:02.000Z#3" {
		t.Errorf("logRecordId = %q", got)
	}
}
