package kardia

import (
	"context"
	"math"
	"reflect"
	"testing"
)

func TestConfigSnapshotPreservesDistinctSliceViews(t *testing.T) {
	base := []any{map[string]any{"value": 1}, 2}
	original := []any{base[:1], base[:2]}
	snapshot := CloneConfig(original).([]any)
	if len(snapshot[0].([]any)) != 1 || len(snapshot[1].([]any)) != 2 {
		t.Fatalf("切片视图长度丢失：%v", snapshot)
	}
	snapshot[0].([]any)[0].(map[string]any)["value"] = 9
	if base[0].(map[string]any)["value"] != 1 {
		t.Fatal("配置快照共享原始映射")
	}
}
func TestConfigNumbersCompareWithoutRounding(t *testing.T) {
	cases := []struct {
		a, b  any
		equal bool
	}{
		{int(4), float64(4), true}, {int64(9007199254740993), float64(9007199254740992), false},
		{uint64(math.MaxUint64), int64(-1), false}, {math.Inf(1), math.Inf(1), true},
		{math.NaN(), math.NaN(), false}, {1, "1", false},
	}
	for _, c := range cases {
		if got := NumbersEqual(c.a, c.b); got != c.equal {
			t.Errorf("%v/%v: %v", c.a, c.b, got)
		}
	}
}

type customConfigService struct{ Service }

func (s *customConfigService) MergeConfig(layers ...map[string]any) (map[string]any, error) {
	var values []any
	for _, layer := range layers {
		values = append(values, layer["value"])
	}
	return map[string]any{"values": values}, nil
}
func TestServiceCustomConfigurationMerger(t *testing.T) {
	root := NewContext()
	s := &customConfigService{}
	var err error
	s.Service, err = NewService(root, "custom", s, nil)
	if err != nil {
		t.Fatal(err)
	}
	access := root.Intercept("custom", map[string]any{"value": "outer"}).Intercept("custom", map[string]any{"value": "inner"})
	got, err := s.ResolveConfig(access, map[string]any{"value": "base"}, map[string]any{"value": "head"})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got["values"], []any{"base", "outer", "inner", "head"}) {
		t.Fatalf("顺序不符：%v", got)
	}
	if err := s.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
}
