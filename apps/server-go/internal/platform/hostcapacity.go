package platform

import (
	"context"
	"errors"
	"fmt"
	"math"
	"os"
	"strconv"
	"strings"
	"time"

	"elysian/server/internal/seam"
	"elysian/server/internal/shared"
)

// hostCapacity 实现 seam.HostCapacity：读 /proc/meminfo、/proc/stat、/proc/loadavg 与根文件
// 系统容量。内存读数缺失或越界时报错，调用方据此按「未确认充足」处理；核数、负载与磁盘
// 只作辅助读数，读不到不影响内存读数。
type hostCapacity struct {
	readFile func(string) ([]byte, error)
	statfs   func(string) (diskUsage, error)
	now      func() time.Time
}

// NewHostCapacity 构造宿主容量读取器，由装配层注入 docker 与 database 域。
func NewHostCapacity() seam.HostCapacity {
	return hostCapacity{readFile: os.ReadFile, statfs: statfsUsage, now: time.Now}
}

func (h hostCapacity) Sample(ctx context.Context) (shared.HostMemory, error) {
	if err := ctx.Err(); err != nil {
		return shared.HostMemory{}, err
	}
	out := shared.HostMemory{SampledAt: h.now().UTC().Format(time.RFC3339Nano)}
	data, err := h.readFile("/proc/meminfo")
	if err != nil {
		return shared.HostMemory{}, fmt.Errorf("无法读取宿主内存状态：%w", err)
	}
	total, available, err := parseMeminfoBytes(data)
	if err != nil {
		return shared.HostMemory{}, err
	}
	out.TotalBytes, out.AvailableBytes = total, available
	if stat, err := h.readFile("/proc/stat"); err == nil {
		out.Cores = countCPUCoreLines(stat)
	}
	if load, err := h.readFile("/proc/loadavg"); err == nil {
		if fields := strings.Fields(string(load)); len(fields) > 0 {
			if value, err := strconv.ParseFloat(fields[0], 64); err == nil && value >= 0 && !math.IsNaN(value) && !math.IsInf(value, 0) {
				out.Load1 = &value
			}
		}
	}
	if usage, err := h.statfs("/"); err == nil {
		free := usage.FreeBytes
		out.RootFreeBytes = &free
	}
	return out, nil
}

// parseMeminfoBytes 取 MemTotal 与 MemAvailable 的精确字节数。任一缺失、为零或可用量大于
// 总量都视为读数不可得，不用 MemFree 冒充可用量。
func parseMeminfoBytes(data []byte) (uint64, uint64, error) {
	values := map[string]uint64{}
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) != 3 || fields[2] != "kB" {
			continue
		}
		value, err := strconv.ParseUint(fields[1], 10, 64)
		if err != nil || value > math.MaxUint64/1024 {
			continue
		}
		values[strings.TrimSuffix(fields[0], ":")] = value * 1024
	}
	total, hasTotal := values["MemTotal"]
	available, hasAvailable := values["MemAvailable"]
	if !hasTotal || !hasAvailable || total == 0 || available == 0 || available > total {
		return 0, 0, errors.New("无法确认 MemTotal／MemAvailable")
	}
	return total, available, nil
}

// countCPUCoreLines 统计 /proc/stat 里逐核的 cpuN 行；没有逐核行时返回 0。
func countCPUCoreLines(data []byte) int {
	cores := 0
	for _, line := range strings.Split(string(data), "\n") {
		if name, _, found := strings.Cut(line, " "); found && strings.HasPrefix(name, "cpu") && len(name) > 3 {
			if _, err := strconv.Atoi(name[3:]); err == nil {
				cores++
			}
		}
	}
	return cores
}
