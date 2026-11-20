package jscompat

import (
	"math"
	"testing"
)

func TestNumberFormattingAndIntegerBoundaries(t *testing.T) {
	for _, tc := range []struct {
		number  float64
		text    string
		integer bool
	}{
		{math.Copysign(0, -1), "0", true},
		{math.NaN(), "NaN", false},
		{math.Inf(1), "Infinity", false},
		{math.Inf(-1), "-Infinity", false},
		{math.SmallestNonzeroFloat64, "5e-324", false},
		{1e-7, "1e-7", false},
		{1e-6, "0.000001", false},
		{1e20, "100000000000000000000", true},
		{1e21, "1e+21", true},
	} {
		if got := NumberToString(tc.number); got != tc.text {
			t.Errorf("数字 %v 格式为 %q；期望 %q", tc.number, got, tc.text)
		}
		if got := IsInteger(tc.number); got != tc.integer {
			t.Errorf("数字 %v 的整值判据为 %v；期望 %v", tc.number, got, tc.integer)
		}
	}
}

func TestUTF16Length(t *testing.T) {
	for _, tc := range []struct {
		text string
		want int
	}{
		{"", 0}, {"中文", 2}, {"\U0001f600", 2}, {"A\U0001f600e\u0301", 5}, {"\xff", 1},
	} {
		if got := UTF16Length(tc.text); got != tc.want {
			t.Errorf("字符串 %q 含 %d 个码元；期望 %d", tc.text, got, tc.want)
		}
	}
}
