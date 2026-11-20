// Package jscompat 复用 JS 兼容原语，保留已有 API 的不同强转口径。
package jscompat

import (
	"math"
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

// ParseNumberUndefined 将缺值和 null 视作 undefined，单元素数组递归强转。
func ParseNumberUndefined(v any) float64 { return parseNumber(v, false) }

// ParseNumberNull 将 nil 视作 JSON null，单元素数组遵循现有 SSH 字符串化口径。
func ParseNumberNull(v any) float64 { return parseNumber(v, true) }

func parseNumber(v any, nullAsZero bool) float64 {
	switch x := v.(type) {
	case nil:
		if nullAsZero {
			return 0
		}
	case bool:
		if x {
			return 1
		}
		return 0
	case float64:
		return x
	case string:
		return parseCoercedText(x, nullAsZero)
	case []any:
		if len(x) == 0 {
			return 0
		}
		if len(x) == 1 {
			if !nullAsZero {
				return parseNumber(x[0], false)
			}
			switch elem := x[0].(type) {
			case nil, []any, map[string]any:
				return 0
			case string:
				return parseCoercedText(elem, true)
			case float64:
				return parseCoercedText(NumberToString(elem), true)
			}
		}
	}
	return math.NaN()
}

var decimal = regexp.MustCompile(`^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$`)

func parseCoercedText(text string, strictDecimal bool) float64 {
	text = strings.TrimFunc(text, func(r rune) bool {
		if !strictDecimal {
			return r == '\ufeff' || unicode.IsSpace(r)
		}
		switch r {
		case ' ', '\t', '\n', '\r', '\v', '\f', 0x85, 0xa0, 0xfeff:
			return true
		}
		return false
	})
	if text == "" {
		return 0
	}
	body, neg := splitSign(text)
	if body == "Infinity" {
		return signed(math.Inf(1), neg)
	}
	if n, prefixed := parseRadix(body); prefixed {
		return signed(n, neg)
	}
	if (strictDecimal && !decimal.MatchString(body)) || strings.ContainsRune(body, '_') {
		return math.NaN()
	}
	n, err := strconv.ParseFloat(body, 64)
	if err != nil || math.IsInf(n, 0) || math.IsNaN(n) {
		return math.NaN()
	}
	return signed(n, neg)
}

// ParseNonEmptyNumberText 解析调用方已裁剪的非空文本，保留日志查询的 ParseFloat 口径。
func ParseNonEmptyNumberText(text string) (float64, bool) {
	if text == "" {
		return 0, false
	}
	body, neg := splitSign(text)
	if n, prefixed := parseRadix(body); prefixed {
		if math.IsNaN(n) {
			return 0, false
		}
		return signed(n, neg), true
	}
	n, err := strconv.ParseFloat(text, 64)
	if err != nil {
		return 0, false
	}
	return n, true
}

func splitSign(text string) (string, bool) {
	switch text[0] {
	case '-':
		return text[1:], true
	case '+':
		return text[1:], false
	default:
		return text, false
	}
}

func parseRadix(body string) (float64, bool) {
	if len(body) < 2 || body[0] != '0' {
		return 0, false
	}
	var base int
	switch body[1] {
	case 'x', 'X':
		base = 16
	case 'b', 'B':
		base = 2
	case 'o', 'O':
		base = 8
	default:
		return 0, false
	}
	n, err := strconv.ParseUint(body[2:], base, 64)
	if err != nil {
		return math.NaN(), true
	}
	return float64(n), true
}

func signed(n float64, neg bool) float64 {
	if neg {
		return -n
	}
	return n
}

var exponentPad = regexp.MustCompile(`e([+-])0(\d)$`)

// NumberToString 输出最短往返十进制数字，使用 JS 的指数阈值及负零口径。
func NumberToString(n float64) string {
	switch {
	case math.IsNaN(n):
		return "NaN"
	case math.IsInf(n, 1):
		return "Infinity"
	case math.IsInf(n, -1):
		return "-Infinity"
	case n == 0:
		return "0"
	}
	if abs := math.Abs(n); abs >= 1e21 || abs < 1e-6 {
		return exponentPad.ReplaceAllString(strconv.FormatFloat(n, 'e', -1, 64), "e${1}${2}")
	}
	return strconv.FormatFloat(n, 'f', -1, 64)
}

func IsInteger(n float64) bool { return !math.IsInf(n, 0) && math.Trunc(n) == n }
