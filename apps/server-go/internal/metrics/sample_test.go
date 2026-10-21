package metrics

import (
	"errors"
	"testing"

	"elysian/server/internal/shared"
)

func fakeFiles(files map[string]string) func(string) (string, error) {
	return func(path string) (string, error) {
		if content, ok := files[path]; ok {
			return content, nil
		}
		return "", errors.New("文件不存在：" + path)
	}
}

const goldenLoadavg = "0.18 0.11 0.06 1/567 12345"

const goldenMeminfo = `MemTotal:       16384256 kB
MemFree:          1234567 kB
MemAvailable:     8192128 kB
Buffers:           234567 kB`

// statPrev/statNext：total 1000→1100（user +120）、idle+iowait 800→870，差分利用率 30%。
const statPrev = "cpu  100 0 100 700 100 0 0 0 0 0\ncpu0 50 0 50 350 50 0 0 0 0 0"
const statNext = "cpu  120 0 110 760 110 0 0 0 0 0\ncpu0 60 0 55 380 55 0 0 0 0 0"

// netPrev/netNext：eth0 收发各 +1 MiB（1048576 字节），lo 不计。
const netPrev = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 9999999999    9999 0 0 0 0 0 0  9999999999    9999 0 0 0 0 0 0
  eth0: 1048576 100 0 0 0 0 0 0  1048576 50 0 0 0 0 0 0`
const netNext = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 9999999999    9999 0 0 0 0 0 0  9999999999    9999 0 0 0 0 0 0
  eth0: 2097152 200 0 0 0 0 0 0  2097152 100 0 0 0 0 0 0`

// diskPrev/diskNext：sda（major 8 minor 0）读写各 +2048 扇区（1 MiB）；sda1 分区不计。
const diskPrev = `   8       0 sda 500 100 4096 80 100 20 2048 40 0 0 0 0 0 0
   8       1 sda1 400 90 4096 70 90 18 2048 36 0 0 0 0 0 0`
const diskNext = `   8       0 sda 600 150 6144 90 150 30 4096 60 0 0 0 0 0 0
   8       1 sda1 500 140 6144 80 140 28 4096 56 0 0 0 0 0 0`

func goldenFiles() map[string]string {
	return map[string]string{
		procLoadavg:   goldenLoadavg,
		procMeminfo:   goldenMeminfo,
		procStat:      statPrev,
		procNetDev:    netPrev,
		procDiskstats: diskPrev,
	}
}

func TestParseLoadavg(t *testing.T) {
	load, err := parseLoadavg(goldenLoadavg)
	if err != nil {
		t.Fatalf("解析失败：%v", err)
	}
	if load.M1 != 0.18 || load.M5 != 0.11 || load.M15 != 0.06 {
		t.Fatalf("负载值不符：%+v", load)
	}
	if _, err := parseLoadavg("0.18 0.11"); err == nil {
		t.Fatal("列数不足应报错")
	}
	if _, err := parseLoadavg("x y z"); err == nil {
		t.Fatal("非数值应报错")
	}
}

func TestParseMeminfo(t *testing.T) {
	// (16384256-8192128)/16384256*100 = 50.0 → 四舍五入 50。
	memory, err := parseMeminfo(goldenMeminfo)
	if err != nil {
		t.Fatalf("解析失败：%v", err)
	}
	if memory != 50 {
		t.Fatalf("内存占比应为 50，实际 %v", memory)
	}
	if _, err := parseMeminfo("MemFree: 1 kB\n"); err == nil {
		t.Fatal("缺 MemTotal 应报错")
	}
	if _, err := parseMeminfo("MemTotal: 100 kB\n"); err == nil {
		t.Fatal("缺 MemAvailable 应报错")
	}
}

func TestCpuUsagePercent(t *testing.T) {
	usage, err := cpuUsagePercent(statPrev, statNext)
	if err != nil {
		t.Fatalf("差分失败：%v", err)
	}
	if usage != 30 {
		t.Fatalf("CPU 利用率应为 30，实际 %v", usage)
	}
	if usage2, err := cpuUsagePercent(statNext, statNext); err != nil || usage2 != 0 {
		t.Fatalf("totalDelta≤0 应为 0，实际 %v（%v）", usage2, err)
	}
	if _, err := cpuUsagePercent("intr 1\n", statNext); err == nil {
		t.Fatal("缺 cpu 聚合行应报错")
	}
}

func TestSumNetworkBytesSkipsLoopback(t *testing.T) {
	rx, tx := sumNetworkBytes(netPrev)
	if rx != 1048576 || tx != 1048576 {
		t.Fatalf("eth0 累计应为 1048576/1048576，实际 %d/%d", rx, tx)
	}
}

func TestSumDiskSectorsWholeDisksOnly(t *testing.T) {
	read, write := sumDiskSectors(diskPrev)
	if read != 4096 || write != 2048 {
		t.Fatalf("整盘扇区应为 4096/2048，实际 %d/%d", read, write)
	}
}

func TestNetworkAndDiskDeltaMbps(t *testing.T) {
	rx, tx, total := networkIoMbps(netPrev, netNext, 1000)
	if rx != 1 || tx != 1 || total != 2 {
		t.Fatalf("1 秒差 1MiB 应为 1/1/2 MB/s，实际 %v/%v/%v", rx, tx, total)
	}
	if rx2, _, _ := networkIoMbps(netNext, netPrev, 1000); rx2 != 0 {
		t.Fatalf("负差值应为 0，实际 %v", rx2)
	}
	read, write, total := diskIoMbps(diskPrev, diskNext, 1000)
	if read != 1 || write != 1 || total != 2 {
		t.Fatalf("1 秒差 1MiB 应为 1/1/2 MB/s，实际 %v/%v/%v", read, write, total)
	}
}

func TestReadHostSampleFirstTickHasNoDelta(t *testing.T) {
	nowMs := int64(1_700_000_000_000)
	reader := hostSampleReader{readFile: fakeFiles(goldenFiles()), nowMs: func() int64 { return nowMs }}
	sample, err := readHostSample(reader, nil)
	if err != nil {
		t.Fatalf("首拍采样失败：%v", err)
	}
	p := sample.payload
	if p.CPU != 0 || p.NetworkIo != 0 || p.DiskIo != 0 {
		t.Fatalf("首拍无差分基准，CPU/网络/磁盘应为 0：%+v", p)
	}
	if p.Memory != 50 {
		t.Fatalf("首拍内存占比应为 50：%v", p.Memory)
	}
	if p.Load.M1 != 0.18 {
		t.Fatalf("首拍负载应为 0.18：%+v", p.Load)
	}
	if sample.nextPrev.at != nowMs {
		t.Fatalf("基准时刻应取当前时钟")
	}
}

func TestReadHostSampleSecondTickDifferentials(t *testing.T) {
	base := int64(1_700_000_000_000)
	files := goldenFiles()
	reader := hostSampleReader{readFile: fakeFiles(files), nowMs: func() int64 { return base }}
	first, err := readHostSample(reader, nil)
	if err != nil {
		t.Fatal(err)
	}
	// 第二拍：五个文件全部换成 next 快照，时钟 +1000ms。
	files[procStat] = statNext
	files[procNetDev] = netNext
	files[procDiskstats] = diskNext
	reader.nowMs = func() int64 { return base + 1000 }
	second, err := readHostSample(reader, &first.nextPrev)
	if err != nil {
		t.Fatal(err)
	}
	p := second.payload
	if p.CPU != 30 {
		t.Fatalf("第二拍 CPU 应为 30，实际 %v", p.CPU)
	}
	if p.NetworkRx != 1 || p.NetworkTx != 1 || p.NetworkIo != 2 {
		t.Fatalf("第二拍网络应为 1/1/2 MB/s，实际 %v/%v/%v", p.NetworkRx, p.NetworkTx, p.NetworkIo)
	}
	if p.DiskRead != 1 || p.DiskWrite != 1 || p.DiskIo != 2 {
		t.Fatalf("第二拍磁盘应为 1/1/2 MB/s，实际 %v/%v/%v", p.DiskRead, p.DiskWrite, p.DiskIo)
	}
	if p.Memory != 50 || p.Load.M1 != 0.18 {
		t.Fatalf("非差分字段应保持：%+v", p)
	}
}

func TestReadHostSampleFileFailureFailsWholeTick(t *testing.T) {
	files := goldenFiles()
	delete(files, procMeminfo)
	reader := hostSampleReader{readFile: fakeFiles(files), nowMs: func() int64 { return 1 }}
	if _, err := readHostSample(reader, nil); err == nil {
		t.Fatal("任一文件缺失应整拍报错")
	}
}

func TestPointOfDropsLoadAndKeepsFields(t *testing.T) {
	payload := resourceSamplePayload{
		CPU: 30, Memory: 50, NetworkIo: 2, NetworkRx: 1, NetworkTx: 1,
		DiskIo: 2, DiskRead: 1, DiskWrite: 1, Load: SystemLoad{M1: 0.2, M5: 0.1, M15: 0.05},
	}
	point := pointOf(payload, 12345)
	if point.TS != 12345 || point.CPU != 30 || point.NetworkTx != 1 {
		t.Fatalf("采样点字段不符：%+v", point)
	}
}

func TestSamplePointJSONKeyOrderMatchesContract(t *testing.T) {
	// 键序即 JSON 输出序（shared.MarshalJSON 约定）：ts → cpu → memory →
	// networkIo → networkRx → networkTx → diskIo → diskRead → diskWrite。
	data, err := shared.MarshalJSON(SamplePoint{
		TS: 1, CPU: 2, Memory: 3, NetworkIo: 4, NetworkRx: 5, NetworkTx: 6, DiskIo: 7, DiskRead: 8, DiskWrite: 9,
	})
	if err != nil {
		t.Fatal(err)
	}
	want := `{"ts":1,"cpu":2,"memory":3,"networkIo":4,"networkRx":5,"networkTx":6,"diskIo":7,"diskRead":8,"diskWrite":9}`
	if string(data) != want {
		t.Fatalf("采样点 JSON 键序不符：%s", data)
	}
}
