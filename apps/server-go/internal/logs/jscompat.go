package logs

import (
	"math"
	"strconv"
	"strings"
	"time"
)

/*
 * JS 数值与日期字面量的兼容解析（logs 盘点风险 2/3 的落地）：
 * limit 校验在 TS 侧是 Number.isInteger(Number(raw))——"1e2"、"0x10"、" 10 "、"10.0"
 * 都合法；before 校验是 Date.parse（宽口径）。这里照抄 JS 数字字面量解析规则的常用
 * 子集与常见日期形，保证前端已发出的形为在 Go 侧不被意外 400。
 */

// strconvFormatInt 整值 float64 → 十进制整文本（JS String(8080) === "8080"）。
func strconvFormatInt(f float64) string {
	return strconv.FormatInt(int64(f), 10)
}

// strconvFormatGeneral 非整值 float64 → 最短往返文本（'g' 精度 -1）。
func strconvFormatGeneral(f float64) string {
	return strconv.FormatFloat(f, 'g', -1, 64)
}

// parseJSNumber JS Number(raw) 的子集：JS 空白 trim、正负号、十进制（含小数与指数）、
// 0x/0X 十六进制、0b/0o 二八进制、"Infinity"。解析失败返回 (!ok)。
func parseJSNumber(raw string) (float64, bool) {
	s := trimJS(raw)
	if s == "" {
		return 0, false
	}
	neg := false
	body := s
	if body[0] == '+' || body[0] == '-' {
		neg = body[0] == '-'
		body = body[1:]
	}
	if body == "" {
		return 0, false
	}
	// 十六进制 / 二进制 / 八进制前缀（Number() 支持，ParseFloat 不认）。
	if len(body) > 2 && body[0] == '0' {
		switch body[1] {
		case 'x', 'X':
			if n, err := strconv.ParseUint(body[2:], 16, 64); err == nil {
				return signedFloat(float64(n), neg), true
			}
			return 0, false
		case 'b', 'B':
			if n, err := strconv.ParseUint(body[2:], 2, 64); err == nil {
				return signedFloat(float64(n), neg), true
			}
			return 0, false
		case 'o', 'O':
			if n, err := strconv.ParseUint(body[2:], 8, 64); err == nil {
				return signedFloat(float64(n), neg), true
			}
			return 0, false
		}
	}
	// 十进制（含指数）与 Infinity/NaN：交给 ParseFloat；下划线等 JS 不认的形会失败。
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0, false
	}
	return f, true
}

// signedFloat 应用符号（十六进制等分支已手工剥前缀）。
func signedFloat(f float64, neg bool) float64 {
	if neg {
		return -f
	}
	return f
}

// isJSIntegerNumber Number.isInteger 判据。
func isJSIntegerNumber(f float64) bool {
	if math.IsInf(f, 0) || math.IsNaN(f) {
		return false
	}
	return f == math.Trunc(f)
}

// dateParseLayouts Date.parse 常见形：ISO（带/不带时区、日期段）、HTTP 日期、斜杠日期。
// 不带时区的形按 UTC 解释（容器时区为 UTC；本地开发差异登记在盘点风险 3）。
var dateParseLayouts = []string{
	time.RFC3339Nano,
	"2006-01-02T15:04:05.999999999",
	"2006-01-02T15:04",
	"2006-01-02",
	"2006-01-02 15:04:05",
	"2006/01/02 15:04:05",
	"2006/01/02",
	time.RFC1123,
	time.RFC1123Z,
	time.ANSIC,
}

// dateParses JS Date.parse(s) 非NaN 的子集判定；空串与未知形返回 false。
func dateParses(s string) bool {
	if s == "" {
		return false
	}
	for _, layout := range dateParseLayouts {
		if _, err := time.Parse(layout, s); err == nil {
			return true
		}
	}
	return false
}

// beforeIDPattern 游标 id 判据：/^[1-9]\d*$/（前导零与 0 都拒绝）。
func beforeIDValid(raw string) bool {
	if raw == "" || raw[0] < '1' || raw[0] > '9' {
		return false
	}
	for i := 1; i < len(raw); i++ {
		if raw[i] < '0' || raw[i] > '9' {
			return false
		}
	}
	return true
}

// clampQueryLimit limit 钳制：缺省与上限都取 logEntryFetchLimit。
func clampQueryLimit(limit int, has bool) int {
	if !has {
		return logEntryFetchLimit
	}
	if limit > logEntryFetchLimit {
		return logEntryFetchLimit
	}
	return limit
}

// likePatternEscaper 关键字 LIKE 模式：\、%、_ 按字面转义，两侧加通配。
func likePattern(keyword string) string {
	var b strings.Builder
	b.Grow(len(keyword) + 2)
	b.WriteByte('%')
	for i := 0; i < len(keyword); i++ {
		switch keyword[i] {
		case '\\', '%', '_':
			b.WriteByte('\\')
		}
		b.WriteByte(keyword[i])
	}
	b.WriteByte('%')
	return b.String()
}
