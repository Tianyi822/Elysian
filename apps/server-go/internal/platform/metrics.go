package platform

import (
	"context"
	"errors"
	"math"
	"os"
	"strconv"
	"strings"
	"time"

	"elysian/server/internal/paths"
)

// 宿主指标只读采样：内存、CPU 使用率与负载、关键挂载点磁盘占用（memory.go 的同一口径）。
// 读数来自 /proc 与 statfs，属 Linux 内核视角；容器内代表容器命名空间，不冒充物理宿主。
// 磁盘只报根与面板数据目录两个挂载点，不枚举全部分区，也不提供逐容器资源统计。
const (
	cpuSampleInterval = 200 * time.Millisecond
	loadAverageFields = 3
)

type platformMetricsSample struct {
	SampledAt string         `json:"sampledAt"`
	Memory    *metricsMemory `json:"memory,omitempty"`
	CPU       *metricsCPU    `json:"cpu,omitempty"`
	Disks     []metricsDisk  `json:"disks"`
}

type metricsMemory struct {
	TotalMb     float64  `json:"totalMb"`
	AvailableMb *float64 `json:"availableMb,omitempty"`
	UsedMb      *float64 `json:"usedMb,omitempty"`
	UsedPercent *float64 `json:"usedPercent,omitempty"`
}

type metricsCPU struct {
	Cores        int      `json:"cores"`
	UsagePercent *float64 `json:"usagePercent,omitempty"`
	Load1        *float64 `json:"load1,omitempty"`
	Load5        *float64 `json:"load5,omitempty"`
	Load15       *float64 `json:"load15,omitempty"`
}

type metricsDisk struct {
	Mount       string  `json:"mount"`
	Role        string  `json:"role"`
	TotalMb     float64 `json:"totalMb"`
	UsedMb      float64 `json:"usedMb"`
	FreeMb      float64 `json:"freeMb"`
	UsedPercent float64 `json:"usedPercent"`
}

type diskUsage struct {
	TotalBytes uint64
	UsedBytes  uint64
	FreeBytes  uint64
	// Device 用于识别两个挂载点是否同盘；不同平台用各自可比的标识（statfs.Dev / Fsid）。
	Device string
}

// hostMetricsSource 是采样用到的全部外部依赖；测试注入固定 /proc 内容与假 statfs，
// wait 直接跳过两次 CPU 读数之间的间隔。
type hostMetricsSource struct {
	readFile func(string) ([]byte, error)
	statfs   func(string) (diskUsage, error)
	wait     func(time.Duration)
	now      func() time.Time
}

func defaultHostMetricsSource() hostMetricsSource {
	return hostMetricsSource{readFile: os.ReadFile, statfs: statfsUsage, wait: time.Sleep, now: time.Now}
}

func readHostMetrics(src hostMetricsSource) platformMetricsSample {
	sample := platformMetricsSample{SampledAt: src.now().UTC().Format(time.RFC3339Nano), Disks: []metricsDisk{}}
	if memory, ok := readMetricsMemory(src.readFile); ok {
		sample.Memory = &memory
	}
	if cpu, ok := readMetricsCPU(src.readFile, src.wait); ok {
		sample.CPU = &cpu
	}
	sample.Disks = readMetricsDisks(src.statfs)
	return sample
}

// 内存总量必读，可用量缺失或越界时只报总量；不用空闲量冒充可用量（与 memory.go 同源）。
func readMetricsMemory(readFile func(string) ([]byte, error)) (metricsMemory, bool) {
	data, err := readFile("/proc/meminfo")
	if err != nil {
		return metricsMemory{}, false
	}
	values := map[string]uint64{}
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) != 3 || fields[2] != "kB" {
			continue
		}
		value, err := strconv.ParseUint(fields[1], 10, 64)
		if err != nil {
			continue
		}
		values[strings.TrimSuffix(fields[0], ":")] = value * 1024
	}
	total, ok := values["MemTotal"]
	if !ok || total == 0 {
		return metricsMemory{}, false
	}
	out := metricsMemory{TotalMb: roundMb(total)}
	available, ok := values["MemAvailable"]
	if !ok || available > total {
		return out, true
	}
	used := total - available
	out.AvailableMb = valuePtr(roundMb(available))
	out.UsedMb = valuePtr(roundMb(used))
	out.UsedPercent = valuePtr(roundPercent(float64(used) / float64(total) * 100))
	return out, true
}

// CPU 使用率取 /proc/stat 聚合行的两次差值，idle+iowait 视为空闲；差值无效时只报核心数与负载。
func readMetricsCPU(readFile func(string) ([]byte, error), wait func(time.Duration)) (metricsCPU, bool) {
	first, cores, ok := parseCPUStat(readFile)
	if !ok {
		return metricsCPU{}, false
	}
	wait(cpuSampleInterval)
	second, _, ok := parseCPUStat(readFile)
	if !ok {
		return metricsCPU{}, false
	}
	out := metricsCPU{Cores: cores}
	if load1, load5, load15, ok := readLoadAverage(readFile); ok {
		out.Load1, out.Load5, out.Load15 = valuePtr(load1), valuePtr(load5), valuePtr(load15)
	}
	if second.total > first.total {
		idle, total := second.idle-first.idle, second.total-first.total
		if idle <= total {
			out.UsagePercent = valuePtr(roundPercent((1 - float64(idle)/float64(total)) * 100))
		}
	}
	return out, true
}

type cpuCounter struct{ idle, total uint64 }

func parseCPUStat(readFile func(string) ([]byte, error)) (cpuCounter, int, bool) {
	data, err := readFile("/proc/stat")
	if err != nil {
		return cpuCounter{}, 0, false
	}
	var counter cpuCounter
	cores := 0
	found := false
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 || !strings.HasPrefix(fields[0], "cpu") {
			continue
		}
		name := strings.TrimPrefix(fields[0], "cpu")
		if name != "" {
			if allDigits(name) {
				cores++
			}
			continue
		}
		if len(fields) < 5 {
			return cpuCounter{}, 0, false
		}
		var total, idle uint64
		for i := 1; i < len(fields); i++ {
			value, err := strconv.ParseUint(fields[i], 10, 64)
			if err != nil {
				return cpuCounter{}, 0, false
			}
			total += value
			if i == 4 || i == 5 {
				idle += value
			}
		}
		if total == 0 {
			return cpuCounter{}, 0, false
		}
		counter = cpuCounter{idle: idle, total: total}
		found = true
	}
	return counter, cores, found
}

func readLoadAverage(readFile func(string) ([]byte, error)) (float64, float64, float64, bool) {
	data, err := readFile("/proc/loadavg")
	if err != nil {
		return 0, 0, 0, false
	}
	fields := strings.Fields(string(data))
	if len(fields) < loadAverageFields {
		return 0, 0, 0, false
	}
	values := make([]float64, loadAverageFields)
	for i := range values {
		value, err := strconv.ParseFloat(fields[i], 64)
		if err != nil || value < 0 || math.IsInf(value, 0) || math.IsNaN(value) {
			return 0, 0, 0, false
		}
		values[i] = value
	}
	return values[0], values[1], values[2], true
}

// 磁盘只报根与面板数据目录；数据目录与根同盘时不重复报（statfs 跟随符号链接，
// 数据目录指向持久卷时读到的是卷本身）。单项不可读只跳过该项，不伪造读数。
func readMetricsDisks(statfs func(string) (diskUsage, error)) []metricsDisk {
	out := []metricsDisk{}
	rootDevice := ""
	for _, mount := range []struct{ role, path string }{
		{"根文件系统", "/"},
		{"面板数据目录", paths.ElysianHome},
	} {
		usage, err := statfs(mount.path)
		if err != nil || usage.TotalBytes == 0 {
			continue
		}
		if mount.path != "/" && rootDevice != "" && usage.Device == rootDevice {
			continue
		}
		if mount.path == "/" {
			rootDevice = usage.Device
		}
		disk := metricsDisk{
			Mount:   mount.path,
			Role:    mount.role,
			TotalMb: roundMb(usage.TotalBytes),
			UsedMb:  roundMb(usage.UsedBytes),
			FreeMb:  roundMb(usage.FreeBytes),
		}
		if denominator := usage.UsedBytes + usage.FreeBytes; denominator > 0 {
			disk.UsedPercent = roundPercent(float64(usage.UsedBytes) / float64(denominator) * 100)
		}
		out = append(out, disk)
	}
	return out
}

func allDigits(value string) bool {
	if value == "" {
		return false
	}
	for _, r := range value {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func roundMb(bytes uint64) float64 {
	return roundPercent(float64(bytes) / bytesPerMiB)
}

func roundPercent(value float64) float64 {
	return math.Round(value*10) / 10
}

func valuePtr(value float64) *float64 { return &value }

// Metrics 返回宿主内存、CPU 与磁盘的只读采样；只读不写，不执行任何系统变更。
func (f *AgentFacade) Metrics(ctx context.Context) (any, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if f == nil || f.authorize == nil {
		return nil, errors.New("平台只读能力未授权")
	}
	if err := f.authorize(ctx); err != nil {
		return nil, err
	}
	return f.metrics(), ctx.Err()
}
