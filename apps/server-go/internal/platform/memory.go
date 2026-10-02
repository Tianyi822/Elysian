package platform

import (
	"errors"
	"fmt"
	"os"
	"runtime/metrics"
	"strconv"
	"strings"
	"time"
)

// 平台内存只采样当前 Go 后端进程。RSS 是系统读数，Go 各项来自同批 runtime/metrics；
// 采样不触发 GC。Mb 字段保留契约名称，数值与界面单位均为 MiB。
type platformMemorySample struct {
	RSSMb          *float64 `json:"rssMb"`
	RSSSource      string   `json:"rssSource"`
	SystemTotalMb  *float64 `json:"systemTotalMb"`
	SampledAt      string   `json:"sampledAt"`
	HeapUsedMb     float64  `json:"heapUsedMb"`
	HeapTotalMb    float64  `json:"heapTotalMb"`
	HeapUnusedMb   float64  `json:"heapUnusedMb"`
	HeapRetainedMb float64  `json:"heapRetainedMb"`
	HeapReleasedMb float64  `json:"heapReleasedMb"`
	RuntimeOtherMb float64  `json:"runtimeOtherMb"`
	HeapLiveMb     float64  `json:"heapLiveMb"`
	GCCount        uint64   `json:"gcCount"`
}

type memoryUsage struct {
	RSS          *float64
	RSSSource    string
	SystemTotal  *float64
	SampledAt    time.Time
	HeapUsed     uint64
	HeapTotal    uint64
	HeapUnused   uint64
	HeapRetained uint64
	HeapReleased uint64
	RuntimeOther uint64
	HeapLive     uint64
	GCCount      uint64
}

const bytesPerMiB = 1024 * 1024

func sampleFromUsage(usage memoryUsage) platformMemorySample {
	var rss *float64
	if usage.RSS != nil {
		value := *usage.RSS / bytesPerMiB
		rss = &value
	}
	var systemTotal *float64
	if usage.SystemTotal != nil {
		value := *usage.SystemTotal / bytesPerMiB
		systemTotal = &value
	}
	return platformMemorySample{
		RSSMb:          rss,
		RSSSource:      usage.RSSSource,
		SystemTotalMb:  systemTotal,
		SampledAt:      usage.SampledAt.UTC().Format(time.RFC3339Nano),
		HeapUsedMb:     float64(usage.HeapUsed) / bytesPerMiB,
		HeapTotalMb:    float64(usage.HeapTotal) / bytesPerMiB,
		HeapUnusedMb:   float64(usage.HeapUnused) / bytesPerMiB,
		HeapRetainedMb: float64(usage.HeapRetained) / bytesPerMiB,
		HeapReleasedMb: float64(usage.HeapReleased) / bytesPerMiB,
		RuntimeOtherMb: float64(usage.RuntimeOther) / bytesPerMiB,
		HeapLiveMb:     float64(usage.HeapLive) / bytesPerMiB,
		GCCount:        usage.GCCount,
	}
}

func processMemoryUsage() memoryUsage {
	samples := []metrics.Sample{
		{Name: "/memory/classes/heap/objects:bytes"},
		{Name: "/memory/classes/heap/unused:bytes"},
		{Name: "/memory/classes/heap/free:bytes"},
		{Name: "/memory/classes/heap/released:bytes"},
		{Name: "/memory/classes/total:bytes"},
		{Name: "/gc/heap/live:bytes"},
		{Name: "/gc/cycles/total:gc-cycles"},
	}
	metrics.Read(samples)
	heapTotal := samples[0].Value.Uint64() + samples[1].Value.Uint64() + samples[2].Value.Uint64() + samples[3].Value.Uint64()
	rss, source := readResidentBytes(os.ReadFile, os.Getpagesize())
	return memoryUsage{
		RSS:          rss,
		RSSSource:    source,
		SystemTotal:  readSystemMemoryBytes(os.ReadFile),
		SampledAt:    time.Now(),
		HeapUsed:     samples[0].Value.Uint64(),
		HeapTotal:    heapTotal,
		HeapUnused:   samples[1].Value.Uint64(),
		HeapRetained: samples[2].Value.Uint64(),
		HeapReleased: samples[3].Value.Uint64(),
		RuntimeOther: samples[4].Value.Uint64() - heapTotal,
		HeapLive:     samples[5].Value.Uint64(),
		GCCount:      samples[6].Value.Uint64(),
	}
}

// 系统总内存作为 RSS 占比的参照。容器内读数属于宿主 Linux 内核，不冒充容器限额。
func readSystemMemoryBytes(readFile func(string) ([]byte, error)) *float64 {
	data, err := readFile("/proc/meminfo")
	if err != nil {
		return nil
	}
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 || fields[0] != "MemTotal:" {
			continue
		}
		if len(fields) != 3 || fields[2] != "kB" {
			return nil
		}
		value, err := strconv.ParseUint(fields[1], 10, 64)
		if err != nil || value == 0 {
			return nil
		}
		bytes := float64(value) * 1024
		return &bytes
	}
	return nil
}

// statm 的常驻页数可能受内核异步记账影响。优先用 smaps_rollup，旧内核用 smaps，
// 两者不可读才采用明确标为近似的 statm；全部失败时返回 null，不用 Go Sys 冒充 RSS。
func readResidentBytes(readFile func(string) ([]byte, error), pageSize int) (*float64, string) {
	for _, source := range []string{"smaps-rollup", "smaps", "statm"} {
		path := "/proc/self/" + strings.ReplaceAll(source, "-", "_")
		data, err := readFile(path)
		if err != nil {
			continue
		}
		var rss float64
		if source == "statm" {
			rss, err = parseResidentPages(data, pageSize)
		} else {
			rss, err = parseSmapsRSS(data)
		}
		if err == nil {
			return &rss, source
		}
	}
	return nil, "unavailable"
}

// smaps 有多段映射，逐项相加；rollup 只有一个 Rss 字段。内核 kB 单位是 1024 字节。
func parseSmapsRSS(data []byte) (float64, error) {
	var total uint64
	found := false
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 || fields[0] != "Rss:" {
			continue
		}
		if len(fields) != 3 || fields[2] != "kB" {
			return 0, errors.New("常驻内存字段格式无效")
		}
		value, err := strconv.ParseUint(fields[1], 10, 64)
		if err != nil {
			return 0, fmt.Errorf("常驻内存字段格式无效：%w", err)
		}
		total += value
		found = true
	}
	if !found {
		return 0, errors.New("常驻内存字段缺失")
	}
	return float64(total) * 1024, nil
}

func parseResidentPages(data []byte, pageSize int) (float64, error) {
	fields := strings.Fields(string(data))
	if len(fields) < 2 || pageSize <= 0 {
		return 0, errors.New("常驻页数字段不足")
	}
	pages, err := strconv.ParseUint(fields[1], 10, 64)
	if err != nil {
		return 0, fmt.Errorf("常驻页数字段格式无效：%w", err)
	}
	return float64(pages) * float64(pageSize), nil
}
