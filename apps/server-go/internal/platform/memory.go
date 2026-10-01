package platform

import (
	"errors"
	"os"
	"runtime"
	"strconv"
	"strings"
)

// 平台内存采样（platformMemoryRoutes.ts + contracts/src/platform/memory.ts 等价物）：
// GET /api/platform/memory 回读当前 server 进程的内存账换算成 MB。不依赖 Docker、
// 不碰宿主机接口——本地与容器内都是这份真实进程账；数值不取整（浮点直接序列化），
// 前端契约只要求三键非负有限数（platform 盘点 §11.9）。

// platformMemorySample 内存采样响应体；键序即 JSON 输出序。
type platformMemorySample struct {
	RSSMb       float64 `json:"rssMb"`
	HeapUsedMb  float64 `json:"heapUsedMb"`
	HeapTotalMb float64 `json:"heapTotalMb"`
}

// memoryUsage 进程内存读数（字节）。
type memoryUsage struct {
	RSS       float64
	HeapUsed  float64
	HeapTotal float64
}

const bytesPerMB = 1024 * 1024

// sampleFromUsage 把字节读数换算成 MB 采样（contracts sampleFromUsage 等价物）。
func sampleFromUsage(usage memoryUsage) platformMemorySample {
	return platformMemorySample{
		RSSMb:       usage.RSS / bytesPerMB,
		HeapUsedMb:  usage.HeapUsed / bytesPerMB,
		HeapTotalMb: usage.HeapTotal / bytesPerMB,
	}
}

// processMemoryUsage 进程内存读数（process.memoryUsage 的 Go 等价物）：
// HeapAlloc/HeapSys 取自 runtime.MemStats；RSS 优先取 /proc/self/statm 常驻页，
// 读不到（非 Linux）回落 MemStats.Sys。
func processMemoryUsage() memoryUsage {
	var stats runtime.MemStats
	runtime.ReadMemStats(&stats)
	usage := memoryUsage{
		RSS:       float64(stats.Sys),
		HeapUsed:  float64(stats.HeapAlloc),
		HeapTotal: float64(stats.HeapSys),
	}
	if rss, err := procResidentBytes(); err == nil {
		usage.RSS = rss
	}
	return usage
}

// procResidentBytes 读 /proc/self/statm 第二列（常驻页数）× 页大小。
func procResidentBytes() (float64, error) {
	data, err := os.ReadFile("/proc/self/statm")
	if err != nil {
		return 0, err
	}
	fields := strings.Fields(string(data))
	if len(fields) < 2 {
		return 0, errors.New("/proc/self/statm 字段不足")
	}
	pages, err := strconv.ParseFloat(fields[1], 64)
	if err != nil {
		return 0, err
	}
	return pages * float64(os.Getpagesize()), nil
}
