package docker

import (
	"testing"
)

// stats 对等测试（dockerStats.test.ts 锚点）。

func statsJSON(cpu, precpu string, mem string) string {
	return `{"cpu_stats":` + cpu + `,"precpu_stats":` + precpu + `,"memory_stats":` + mem + `}`
}

func cpuBlock(total, system, online, percpu string) string {
	block := `{"cpu_usage":{"total_usage":` + total
	if percpu != "" {
		block += `,"percpu_usage":[` + percpu + `]`
	}
	block += `},"system_cpu_usage":` + system
	if online != "" {
		block += `,"online_cpus":` + online
	}
	return block + `}`
}

func memBlock(usage string, stats, totalInactive, cache string) string {
	block := `{"usage":` + usage
	inner := ""
	if stats != "" {
		inner += `"inactive_file":` + stats
	}
	if totalInactive != "" {
		if inner != "" {
			inner += ","
		}
		inner += `"total_inactive_file":` + totalInactive
	}
	if cache != "" {
		if inner != "" {
			inner += ","
		}
		inner += `"cache":` + cache
	}
	if inner != "" {
		block += `,"stats":{` + inner + `}`
	}
	if totalInactive != "" {
		block += `,"total_inactive_file":` + totalInactive
	}
	if cache != "" {
		block += `,"cache":` + cache
	}
	return block + `}`
}

func TestCpuPercentRequiresPrecpu(t *testing.T) {
	current := statsJSON(cpuBlock("1000", "10000", "2", ""), `{}`, `{}`)
	value, ok := cpuPercent(mustDecode(t, current))
	if ok || value != 0 {
		t.Fatalf("缺 precpu 应不入样：%v %v", value, ok)
	}
}

func TestCpuPercentSystemDeltaNonPositive(t *testing.T) {
	current := statsJSON(
		cpuBlock("2000", "10000", "2", ""),
		cpuBlock("1000", "10000", "2", ""),
		`{}`)
	if _, ok := cpuPercent(mustDecode(t, current)); ok {
		t.Fatalf("systemDelta ≤ 0 应不入样")
	}
}

func TestCpuPercentDeltaTimesOnlineClamped(t *testing.T) {
	// cpuDelta=500 systemDelta=1000 online=4 → 200% → 钳 100。
	current := statsJSON(
		cpuBlock("1500", "1000", "4", ""),
		cpuBlock("1000", "0", "4", ""),
		`{}`)
	value, ok := cpuPercent(mustDecode(t, current))
	if !ok || value != 100 {
		t.Fatalf("钳 0-100：%v %v", value, ok)
	}
}

func TestCpuPercentOneDecimal(t *testing.T) {
	// 33/100 * 1 * 100 = 33 → 33.0。
	current := statsJSON(
		cpuBlock("133", "100", "1", ""),
		cpuBlock("100", "0", "1", ""),
		`{}`)
	value, ok := cpuPercent(mustDecode(t, current))
	if !ok || value != 33 {
		t.Fatalf("一位小数：%v", value)
	}
	// 33.33… → 33.3。
	current = statsJSON(
		cpuBlock("1333", "1000", "1", ""),
		cpuBlock("1000", "0", "1", ""),
		`{}`)
	value, ok = cpuPercent(mustDecode(t, current))
	if !ok || value != 33.3 {
		t.Fatalf("一位小数四舍五入：%v", value)
	}
}

func TestCpuPercentOnlineFromPercpuLength(t *testing.T) {
	current := statsJSON(
		cpuBlock("1100", "1000", "", "100,100,100,100"),
		cpuBlock("1000", "0", "", "100,100,100,100"),
		`{}`)
	value, ok := cpuPercent(mustDecode(t, current))
	if !ok || value != 40 {
		t.Fatalf("online 缺失用 percpu 长度（100/1000 × 4 核 × 100 = 40）：%v", value)
	}
}

func TestCpuPercentInvalidShapes(t *testing.T) {
	cases := []string{
		`{}`,
		`{"cpu_stats":{},"precpu_stats":{}}`,
		`{"cpu_stats":{"cpu_usage":{"total_usage":1}},"precpu_stats":{}}`,
		`{"cpu_stats":{"cpu_usage":{"total_usage":1},"system_cpu_usage":1},"precpu_stats":{"cpu_usage":{"total_usage":0},"system_cpu_usage":0}}`,
		`[]`,
	}
	for _, raw := range cases {
		if _, ok := cpuPercent(mustDecode(t, raw)); ok {
			t.Fatalf("形状无效应不入样：%s", raw)
		}
	}
}

func TestMemoryMbCacheFallbacks(t *testing.T) {
	// usage 10 MiB；三级缓存回退：inactive_file → total_inactive_file → cache。
	cases := []struct {
		mem  string
		want float64
	}{
		{memBlock(tos(10*1024*1024+512*1024), tos(512*1024), "", ""), 10},
		{memBlock(tos(10*1024*1024+512*1024), "", tos(512*1024), ""), 10},
		{memBlock(tos(10*1024*1024+512*1024), "", "", tos(512*1024)), 10},
		{memBlock(tos(3*1024*1024), tos(10*1024*1024), "", ""), 0},
	}
	for _, tc := range cases {
		value, ok := memoryMb(mustDecode(t, statsJSON(`{}`, `{}`, tc.mem)))
		if !ok || value != tc.want {
			t.Fatalf("got %v want %v（%s）", value, tc.want, tc.mem)
		}
	}
}

func TestMemoryMbInvalidShapes(t *testing.T) {
	cases := []string{`{}`, `{"memory_stats":{}}`, `{"memory_stats":{"usage":"x"}}`, `[]`}
	for _, raw := range cases {
		if _, ok := memoryMb(mustDecode(t, raw)); ok {
			t.Fatalf("形状无效应不入样：%s", raw)
		}
	}
}

func tos(n int) string {
	return itoa(n)
}
