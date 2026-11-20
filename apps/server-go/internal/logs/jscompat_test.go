package logs

import (
	"math"
	"testing"
)

func TestLogNumberLegacyProfile(t *testing.T) {
	for _, tc := range []struct {
		input string
		want  float64
		ok    bool
	}{
		{"", 0, false}, {"\ufeff", 0, false}, {"\u200322", 22, true},
		{"22\u0085", 0, false}, {"-0x10", -16, true}, {"0x1p2", 0, false},
		{"1_0", 10, true}, {"1e999", 0, false}, {"-Infinity", math.Inf(-1), true},
	} {
		got, ok := parseJSNumber(tc.input)
		if got != tc.want || ok != tc.ok {
			t.Errorf("解析 %q = %v, %v；期望 %v, %v", tc.input, got, ok, tc.want, tc.ok)
		}
	}
}
