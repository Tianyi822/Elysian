package docker

import "math"

// stats JSON 的 CPU% 与内存 MB 计算（dockerStats.ts 逐字移植）。
// 语义要点：缺 precpu 不入样；systemDelta ≤ 0 不入样；差值 × 在线核数 × 100 后
// 钳 0–100 留一位小数；online_cpus 缺失时用 percpu_usage 长度；内存缓存按
// inactive_file → total_inactive_file → cache 三级回退，下限 0，四舍五入 MiB。

const mib = 1024 * 1024

type cpuStatsBlock struct {
	totalUsage  float64
	systemUsage float64
	online      float64
}

func readCpuBlock(block any) (cpuStatsBlock, bool) {
	record, ok := asRecord(block)
	if !ok {
		return cpuStatsBlock{}, false
	}
	cpuUsage, ok := asRecord(mustGet(record, "cpu_usage"))
	if !ok {
		return cpuStatsBlock{}, false
	}
	totalUsage, ok1 := asNumber(mustGet(cpuUsage, "total_usage"))
	systemUsage, ok2 := asNumber(mustGet(record, "system_cpu_usage"))
	if !ok1 || !ok2 || !isFiniteNumber(totalUsage) || !isFiniteNumber(systemUsage) {
		return cpuStatsBlock{}, false
	}

	online, hasOnline := asNumber(mustGet(record, "online_cpus"))
	hasOnline = hasOnline && isFiniteNumber(online)
	if !hasOnline {
		if percpu, ok := asArray(mustGet(cpuUsage, "percpu_usage")); ok {
			online, hasOnline = float64(len(percpu)), true
		}
	}
	if !hasOnline || online <= 0 {
		return cpuStatsBlock{}, false
	}
	return cpuStatsBlock{totalUsage: totalUsage, systemUsage: systemUsage, online: online}, true
}

func roundOneDecimal(value float64) float64 {
	return math.Round(value*10) / 10
}

// cpuPercent 计算一次采样的 CPU 百分比；形状或缺前置数据无效时返回 false。
func cpuPercent(current any) (float64, bool) {
	record, ok := asRecord(current)
	if !ok {
		return 0, false
	}
	currentCpu, ok1 := readCpuBlock(mustGet(record, "cpu_stats"))
	preCpu, ok2 := readCpuBlock(mustGet(record, "precpu_stats"))
	if !ok1 || !ok2 {
		return 0, false
	}

	cpuDelta := currentCpu.totalUsage - preCpu.totalUsage
	systemDelta := currentCpu.systemUsage - preCpu.systemUsage
	if systemDelta <= 0 {
		return 0, false
	}

	percent := (cpuDelta / systemDelta) * currentCpu.online * 100
	if !isFiniteNumber(percent) {
		return 0, false
	}
	clamped := math.Min(100, math.Max(0, percent))
	return roundOneDecimal(clamped), true
}

func readCacheBytes(memoryStats *jsonObject) float64 {
	if nested, ok := asRecord(mustGet(memoryStats, "stats")); ok {
		if v, ok := asNumber(mustGet(nested, "inactive_file")); ok && isFiniteNumber(v) {
			return v
		}
	}
	if v, ok := asNumber(mustGet(memoryStats, "total_inactive_file")); ok && isFiniteNumber(v) {
		return v
	}
	if v, ok := asNumber(mustGet(memoryStats, "cache")); ok && isFiniteNumber(v) {
		return v
	}
	return 0
}

// memoryMb 计算一次采样的内存 MiB；形状无效时返回 false。
func memoryMb(stats any) (float64, bool) {
	record, ok := asRecord(stats)
	if !ok {
		return 0, false
	}
	memoryStats, ok := asRecord(mustGet(record, "memory_stats"))
	if !ok {
		return 0, false
	}
	usage, ok := asNumber(mustGet(memoryStats, "usage"))
	if !ok || !isFiniteNumber(usage) {
		return 0, false
	}
	cache := readCacheBytes(memoryStats)
	bytes := math.Max(0, usage-cache)
	return math.Round(bytes / mib), true
}
