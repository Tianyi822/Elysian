// Package metrics 是仪表盘资源指标域：/proc 五文件差分采样、metrics.sqlite 存储
// 与两个根级端点（GET /api/resources/history 与 GET /api/events SSE）。
//
// 它是 dev/preview 阶段 Vite mock 插件（apps/web/src/adapters/sse/mockEventsPlugin*
// 与 adapters/hostMetrics/*）的服务端真实实现：采样口径、表结构与 SSE 帧语义逐条
// 对齐，生产与开发同一套前端零改动。观测对象与 platform 域 metrics 工具同一口径：
// 容器内 /proc 代表容器命名空间，不冒充物理宿主；裸机直跑时即为宿主本身。
package metrics

import (
	"errors"
	"math"
	"strconv"
	"strings"
)

// /proc 五文件路径常量（readHostSample.ts 等价物）。
const (
	procLoadavg   = "/proc/loadavg"
	procMeminfo   = "/proc/meminfo"
	procStat      = "/proc/stat"
	procNetDev    = "/proc/net/dev"
	procDiskstats = "/proc/diskstats"
)

const (
	bytesPerSector = 512
	bytesPerMB     = 1024 * 1024
)

// SystemLoad 负载三元组（事件流 payload 专用，历史采样点不含负载）。
type SystemLoad struct {
	M1  float64 `json:"m1"`
	M5  float64 `json:"m5"`
	M15 float64 `json:"m15"`
}

// SamplePoint 历史查询的采样点：ts 毫秒时间戳，cpu/memory 为百分比，吞吐为 MB/s；
// 键序即 JSON 输出序，与前端 ResourceSamplePoint 逐字段一致。
type SamplePoint struct {
	TS        int64   `json:"ts"`
	CPU       float64 `json:"cpu"`
	Memory    float64 `json:"memory"`
	NetworkIo float64 `json:"networkIo"`
	NetworkRx float64 `json:"networkRx"`
	NetworkTx float64 `json:"networkTx"`
	DiskIo    float64 `json:"diskIo"`
	DiskRead  float64 `json:"diskRead"`
	DiskWrite float64 `json:"diskWrite"`
}

// resourceSamplePayload resource/sample 事件载荷：九个采样字段＋负载三元组。
type resourceSamplePayload struct {
	CPU       float64    `json:"cpu"`
	Memory    float64    `json:"memory"`
	NetworkIo float64    `json:"networkIo"`
	NetworkRx float64    `json:"networkRx"`
	NetworkTx float64    `json:"networkTx"`
	DiskIo    float64    `json:"diskIo"`
	DiskRead  float64    `json:"diskRead"`
	DiskWrite float64    `json:"diskWrite"`
	Load      SystemLoad `json:"load"`
}

// samplePrev 差分基准：上一拍的 stat/net/disk 原文与时刻（毫秒）。
type samplePrev struct {
	stat string
	net  string
	disk string
	at   int64
}

// hostSampleReader 采样依赖注入：readFile 读 /proc 文件原文，nowMs 给毫秒时钟。
type hostSampleReader struct {
	readFile func(path string) (string, error)
	nowMs    func() int64
}

// hostSample 一次采样的两个产物：事件载荷与下一拍差分基准。
type hostSample struct {
	payload  resourceSamplePayload
	nextPrev samplePrev
}

// parseLoadavg 解析 `0.18 0.11 0.06 1/567 12345` 的前三列。
func parseLoadavg(text string) (SystemLoad, error) {
	parts := strings.Fields(text)
	if len(parts) < 3 {
		return SystemLoad{}, errors.New("loadavg 格式无效")
	}
	m1, err1 := strconv.ParseFloat(parts[0], 64)
	m5, err5 := strconv.ParseFloat(parts[1], 64)
	m15, err15 := strconv.ParseFloat(parts[2], 64)
	if err1 != nil || err5 != nil || err15 != nil {
		return SystemLoad{}, errors.New("loadavg 负载值无法解析")
	}
	return SystemLoad{M1: m1, M5: m5, M15: m15}, nil
}

// parseMeminfo 取 `(MemTotal - MemAvailable) / MemTotal * 100`，四舍五入取整。
func parseMeminfo(text string) (float64, error) {
	var memTotalKb, memAvailableKb int64
	haveTotal, haveAvailable := false, false
	for _, line := range strings.Split(text, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		if strings.EqualFold(fields[0], "MemTotal:") {
			memTotalKb, _ = strconv.ParseInt(fields[1], 10, 64)
			haveTotal = true
			continue
		}
		if strings.EqualFold(fields[0], "MemAvailable:") {
			memAvailableKb, _ = strconv.ParseInt(fields[1], 10, 64)
			haveAvailable = true
		}
	}
	if !haveTotal || memTotalKb <= 0 {
		return 0, errors.New("meminfo 缺少有效的 MemTotal")
	}
	if !haveAvailable {
		return 0, errors.New("meminfo 缺少 MemAvailable")
	}
	usedPct := (float64(memTotalKb-memAvailableKb) / float64(memTotalKb)) * 100
	return math.Round(usedPct), nil
}

// parseCpuAggregateLine 解析 `cpu  user nice system idle iowait …` 聚合行；
// total 为全部列之和，idle 为 idle＋iowait；无聚合行或列数不足返回 ok=false。
func parseCpuAggregateLine(text string) (total, idle float64, ok bool) {
	for _, line := range strings.Split(text, "\n") {
		if !strings.HasPrefix(line, "cpu ") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 5 {
			return 0, 0, false
		}
		values := make([]float64, 0, len(fields)-1)
		for _, field := range fields[1:] {
			value, err := strconv.ParseFloat(field, 64)
			if err != nil {
				return 0, 0, false
			}
			values = append(values, value)
		}
		sum := 0.0
		for _, value := range values {
			sum += value
		}
		iowait := 0.0
		if len(values) >= 5 {
			iowait = values[4]
		}
		return sum, values[3] + iowait, true
	}
	return 0, 0, false
}

// cpuUsagePercent 两拍 stat 差分：`(1 - idleDelta/totalDelta) * 100`，
// 四舍五入并夹取 [0,100]；totalDelta ≤ 0 视为 0。
func cpuUsagePercent(prevStat, nextStat string) (float64, error) {
	prevTotal, prevIdle, prevOK := parseCpuAggregateLine(prevStat)
	nextTotal, nextIdle, nextOK := parseCpuAggregateLine(nextStat)
	if !prevOK || !nextOK {
		return 0, errors.New("stat 缺少 cpu 聚合行")
	}
	totalDelta := nextTotal - prevTotal
	idleDelta := nextIdle - prevIdle
	if totalDelta <= 0 {
		return 0, nil
	}
	usage := (1 - idleDelta/totalDelta) * 100
	return math.Round(math.Min(100, math.Max(0, usage))), nil
}

// sumNetworkBytes 求全部非 lo 接口的累计字节数：第 2 列接收、第 10 列发送。
func sumNetworkBytes(text string) (rx, tx int64) {
	for _, line := range strings.Split(text, "\n") {
		trimmed := strings.TrimSpace(line)
		colon := strings.Index(trimmed, ":")
		if colon <= 0 {
			continue
		}
		iface := trimmed[:colon]
		if iface == "lo" || strings.ContainsAny(iface, " \t|") {
			continue
		}
		fields := strings.Fields(trimmed)
		if len(fields) >= 2 {
			if value, err := strconv.ParseInt(fields[1], 10, 64); err == nil {
				rx += value
			}
		}
		if len(fields) >= 10 {
			if value, err := strconv.ParseInt(fields[9], 10, 64); err == nil {
				tx += value
			}
		}
	}
	return rx, tx
}

// sumDiskSectors 求全部整盘（minor=0，跳过分区）的累计扇区数：第 6 列读、第 10 列写。
func sumDiskSectors(text string) (read, write int64) {
	for _, line := range strings.Split(text, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 11 {
			continue
		}
		minor, err := strconv.ParseInt(fields[1], 10, 64)
		if err != nil || minor != 0 {
			continue
		}
		if value, err := strconv.ParseInt(fields[5], 10, 64); err == nil {
			read += value
		}
		if value, err := strconv.ParseInt(fields[9], 10, 64); err == nil {
			write += value
		}
	}
	return read, write
}

// bytesDeltaToMbps 字节差折算 MB/s：`(delta/elapsedMs*1000)/1MiB`；非正差值为 0。
func bytesDeltaToMbps(deltaBytes, elapsedMs int64) float64 {
	if elapsedMs <= 0 || deltaBytes <= 0 {
		return 0
	}
	return (float64(deltaBytes) / float64(elapsedMs)) * 1000 / float64(bytesPerMB)
}

// networkIoMbps 两拍 net/dev 差分折算 MB/s（rx、tx 与合计）。
func networkIoMbps(prev, next string, elapsedMs int64) (rx, tx, total float64) {
	beforeRx, beforeTx := sumNetworkBytes(prev)
	afterRx, afterTx := sumNetworkBytes(next)
	rx = bytesDeltaToMbps(afterRx-beforeRx, elapsedMs)
	tx = bytesDeltaToMbps(afterTx-beforeTx, elapsedMs)
	return rx, tx, rx + tx
}

// diskIoMbps 两拍 diskstats 差分折算 MB/s（读、写与合计；扇区按 512 字节）。
func diskIoMbps(prev, next string, elapsedMs int64) (read, write, total float64) {
	beforeRead, beforeWrite := sumDiskSectors(prev)
	afterRead, afterWrite := sumDiskSectors(next)
	read = bytesDeltaToMbps((afterRead-beforeRead)*bytesPerSector, elapsedMs)
	write = bytesDeltaToMbps((afterWrite-beforeWrite)*bytesPerSector, elapsedMs)
	return read, write, read + write
}

// readHostSample 采一拍：五文件并发原文读取不可省（任一失败即整拍作废），
// CPU/网络/磁盘吞吐按上一拍基准差分，首拍（无基准）三项为 0。
func readHostSample(reader hostSampleReader, prev *samplePrev) (hostSample, error) {
	loadavgText, err := reader.readFile(procLoadavg)
	if err != nil {
		return hostSample{}, err
	}
	meminfoText, err := reader.readFile(procMeminfo)
	if err != nil {
		return hostSample{}, err
	}
	statText, err := reader.readFile(procStat)
	if err != nil {
		return hostSample{}, err
	}
	netText, err := reader.readFile(procNetDev)
	if err != nil {
		return hostSample{}, err
	}
	diskText, err := reader.readFile(procDiskstats)
	if err != nil {
		return hostSample{}, err
	}

	load, err := parseLoadavg(loadavgText)
	if err != nil {
		return hostSample{}, err
	}
	memory, err := parseMeminfo(meminfoText)
	if err != nil {
		return hostSample{}, err
	}

	now := reader.nowMs()
	elapsedMs := int64(0)
	if prev != nil {
		elapsedMs = now - prev.at
		if elapsedMs < 1 {
			elapsedMs = 1
		}
	}

	cpu := 0.0
	netRx, netTx, netTotal := 0.0, 0.0, 0.0
	diskRead, diskWrite, diskTotal := 0.0, 0.0, 0.0
	if prev != nil {
		cpu, err = cpuUsagePercent(prev.stat, statText)
		if err != nil {
			return hostSample{}, err
		}
		netRx, netTx, netTotal = networkIoMbps(prev.net, netText, elapsedMs)
		diskRead, diskWrite, diskTotal = diskIoMbps(prev.disk, diskText, elapsedMs)
	}

	payload := resourceSamplePayload{
		CPU:       cpu,
		Memory:    memory,
		NetworkIo: netTotal,
		NetworkRx: netRx,
		NetworkTx: netTx,
		DiskIo:    diskTotal,
		DiskRead:  diskRead,
		DiskWrite: diskWrite,
		Load:      load,
	}
	return hostSample{
		payload:  payload,
		nextPrev: samplePrev{stat: statText, net: netText, disk: diskText, at: now},
	}, nil
}

// pointOf 把事件载荷转为历史采样点（丢负载、补 ts）。
func pointOf(payload resourceSamplePayload, ts int64) SamplePoint {
	return SamplePoint{
		TS:        ts,
		CPU:       payload.CPU,
		Memory:    payload.Memory,
		NetworkIo: payload.NetworkIo,
		NetworkRx: payload.NetworkRx,
		NetworkTx: payload.NetworkTx,
		DiskIo:    payload.DiskIo,
		DiskRead:  payload.DiskRead,
		DiskWrite: payload.DiskWrite,
	}
}
