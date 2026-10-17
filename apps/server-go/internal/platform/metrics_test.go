package platform

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"elysian/server/internal/paths"
)

func metricsTestSource(stat func(string) (diskUsage, error)) hostMetricsSource {
	statReads := 0
	cpuFirst := "cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 50 0 50 400 0 0 0 0 0 0\ncpu1 50 0 50 400 0 0 0 0 0 0\n"
	cpuSecond := "cpu  120 0 120 860 0 0 0 0 0 0\ncpu0 60 0 60 430 0 0 0 0 0 0\ncpu1 60 0 60 430 0 0 0 0 0 0\n"
	files := map[string]string{
		"/proc/meminfo": "MemFree: 100 kB\nMemTotal: 1048576 kB\nMemAvailable: 524288 kB\n",
		"/proc/loadavg": "0.52 0.58 0.59 1/234 5678\n",
	}
	return hostMetricsSource{
		readFile: func(path string) ([]byte, error) {
			if path == "/proc/stat" {
				statReads++
				if statReads == 1 {
					return []byte(cpuFirst), nil
				}
				return []byte(cpuSecond), nil
			}
			if data, ok := files[path]; ok {
				return []byte(data), nil
			}
			return nil, os.ErrNotExist
		},
		statfs: stat,
		wait:   func(time.Duration) {},
		now:    func() time.Time { return time.Date(2026, 10, 17, 2, 0, 0, 0, time.UTC) },
	}
}

func metricsTestStatfs(devices map[string]diskUsage) func(string) (diskUsage, error) {
	return func(path string) (diskUsage, error) {
		if usage, ok := devices[path]; ok {
			return usage, nil
		}
		return diskUsage{}, os.ErrNotExist
	}
}

func TestHostMetricsReadsProcAndMounts(t *testing.T) {
	sample := readHostMetrics(metricsTestSource(metricsTestStatfs(map[string]diskUsage{
		"/":               {TotalBytes: 100 * bytesPerMiB, UsedBytes: 40 * bytesPerMiB, FreeBytes: 50 * bytesPerMiB, Device: "1"},
		paths.ElysianHome: {TotalBytes: 200 * bytesPerMiB, UsedBytes: 50 * bytesPerMiB, FreeBytes: 140 * bytesPerMiB, Device: "2"},
	})))
	if sample.SampledAt != "2026-10-17T02:00:00Z" {
		t.Fatalf("采样时间错误：%+v", sample)
	}
	if sample.Memory == nil || sample.Memory.TotalMb != 1024 || sample.Memory.AvailableMb == nil || *sample.Memory.AvailableMb != 512 ||
		sample.Memory.UsedMb == nil || *sample.Memory.UsedMb != 512 || sample.Memory.UsedPercent == nil || *sample.Memory.UsedPercent != 50 {
		t.Fatalf("内存采样错误：%+v", sample.Memory)
	}
	if sample.CPU == nil || sample.CPU.Cores != 2 || sample.CPU.UsagePercent == nil || *sample.CPU.UsagePercent != 40 ||
		sample.CPU.Load1 == nil || *sample.CPU.Load1 != 0.52 || sample.CPU.Load15 == nil || *sample.CPU.Load15 != 0.59 {
		t.Fatalf("CPU 采样错误：%+v", sample.CPU)
	}
	if len(sample.Disks) != 2 || sample.Disks[0].Mount != "/" || sample.Disks[0].Role != "根文件系统" ||
		sample.Disks[0].TotalMb != 100 || sample.Disks[0].UsedMb != 40 || sample.Disks[0].FreeMb != 50 || sample.Disks[0].UsedPercent != 44.4 {
		t.Fatalf("根挂载采样错误：%+v", sample.Disks)
	}
	if sample.Disks[1].Mount != paths.ElysianHome || sample.Disks[1].Role != "面板数据目录" || sample.Disks[1].UsedPercent != 26.3 {
		t.Fatalf("数据目录采样错误：%+v", sample.Disks)
	}
}

func TestHostMetricsOmitsUnavailableReadings(t *testing.T) {
	src := metricsTestSource(metricsTestStatfs(nil))
	src.readFile = func(string) ([]byte, error) { return nil, os.ErrNotExist }
	sample := readHostMetrics(src)
	if sample.Memory != nil || sample.CPU != nil || len(sample.Disks) != 0 {
		t.Fatalf("/proc 与挂载点都不可读时不得伪造读数：%+v", sample)
	}

	files := map[string]string{
		"/proc/meminfo": "MemTotal: 1048576 kB\n",
		"/proc/stat":    "cpu  1 0 1 8 0 0 0 0\n",
		"/proc/loadavg": "invalid\n",
	}
	src.readFile = func(path string) ([]byte, error) {
		if data, ok := files[path]; ok {
			return []byte(data), nil
		}
		return nil, os.ErrNotExist
	}
	sample = readHostMetrics(src)
	if sample.Memory == nil || sample.Memory.TotalMb != 1024 || sample.Memory.AvailableMb != nil || sample.Memory.UsedMb != nil || sample.Memory.UsedPercent != nil {
		t.Fatalf("可用量缺失或无效时只报总量：%+v", sample.Memory)
	}
	if sample.CPU == nil || sample.CPU.Cores != 0 || sample.CPU.UsagePercent != nil || sample.CPU.Load1 != nil {
		t.Fatalf("负载无效时不得伪造读数：%+v", sample.CPU)
	}
}

func TestHostMetricsSkipsInvalidCounterAndDuplicateMount(t *testing.T) {
	src := metricsTestSource(metricsTestStatfs(map[string]diskUsage{
		"/":               {TotalBytes: 100 * bytesPerMiB, UsedBytes: 40 * bytesPerMiB, FreeBytes: 50 * bytesPerMiB, Device: "1"},
		paths.ElysianHome: {TotalBytes: 200 * bytesPerMiB, UsedBytes: 50 * bytesPerMiB, FreeBytes: 140 * bytesPerMiB, Device: "1"},
	}))
	if sample := readHostMetrics(src); len(sample.Disks) != 1 || sample.Disks[0].Mount != "/" {
		t.Fatalf("数据目录与根同盘时不得重复报：%+v", sample.Disks)
	}

	src.readFile = func(path string) ([]byte, error) {
		switch path {
		case "/proc/stat":
			return []byte("cpu  1 0 1 x\n"), nil
		case "/proc/meminfo":
			return []byte("MemTotal: 1048576 kB\n"), nil
		}
		return nil, os.ErrNotExist
	}
	if sample := readHostMetrics(src); sample.CPU != nil {
		t.Fatalf("计数行无效时必须省略 CPU：%+v", sample.CPU)
	}
}

func TestMetricsDisksDeduplicatesRootAndData(t *testing.T) {
	root := diskUsage{TotalBytes: 100 * bytesPerMiB, UsedBytes: 40 * bytesPerMiB, FreeBytes: 50 * bytesPerMiB, Device: "root"}
	data := root
	data.Device = "data"
	totalDiff, usedDiff, freeDiff := data, data, data
	totalDiff.TotalBytes++
	usedDiff.UsedBytes++
	freeDiff.FreeBytes++
	rootUnknown, dataUnknown := root, data
	rootUnknown.Device, dataUnknown.Device = "", ""
	dataUnknownDiff := totalDiff
	dataUnknownDiff.Device = ""
	zeroRoot := root
	zeroRoot.TotalBytes = 0
	zeroData := data
	zeroData.TotalBytes = 0
	both := []string{"/", paths.ElysianHome}
	for _, test := range []struct {
		name        string
		root, data  diskUsage
		rootMissing bool
		dataMissing bool
		wantMounts  []string
	}{
		{name: "same-device-different-capacity", root: root, data: diskUsage{TotalBytes: 200 * bytesPerMiB, UsedBytes: 50 * bytesPerMiB, FreeBytes: 140 * bytesPerMiB, Device: "root"}, wantMounts: []string{"/"}},
		{name: "different-device-identical-capacity", root: root, data: data, wantMounts: []string{"/"}},
		{name: "unknown-device-identical-capacity", root: rootUnknown, data: dataUnknown, wantMounts: []string{"/"}},
		{name: "unknown-device-different-capacity", root: rootUnknown, data: dataUnknownDiff, wantMounts: both},
		{name: "total-differs-by-one-byte", root: root, data: totalDiff, wantMounts: both},
		{name: "used-differs-by-one-byte", root: root, data: usedDiff, wantMounts: both},
		{name: "free-differs-by-one-byte", root: root, data: freeDiff, wantMounts: both},
		{name: "root-unreadable", rootMissing: true, data: data, wantMounts: []string{paths.ElysianHome}},
		{name: "root-zero-capacity", root: zeroRoot, data: data, wantMounts: []string{paths.ElysianHome}},
		{name: "data-unreadable", root: root, dataMissing: true, wantMounts: []string{"/"}},
		{name: "data-zero-capacity", root: root, data: zeroData, wantMounts: []string{"/"}},
		{name: "both-unreadable", rootMissing: true, dataMissing: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			devices := map[string]diskUsage{}
			if !test.rootMissing {
				devices["/"] = test.root
			}
			if !test.dataMissing {
				devices[paths.ElysianHome] = test.data
			}
			disks := readMetricsDisks(metricsTestStatfs(devices))
			if len(disks) != len(test.wantMounts) {
				t.Fatalf("磁盘条目数错误：得到 %+v，期望挂载 %v", disks, test.wantMounts)
			}
			for i, want := range test.wantMounts {
				if disks[i].Mount != want {
					t.Errorf("磁盘条目 %d 应保留 %s：得到 %+v", i, want, disks[i])
				}
			}
		})
	}
}

func TestAgentFacadeMetricsRequiresAuthorization(t *testing.T) {
	facade := &AgentFacade{metrics: func() platformMetricsSample { return platformMetricsSample{} }}
	if _, err := facade.Metrics(context.Background()); err == nil {
		t.Fatal("未授权时 Metrics 必须拒绝")
	}
	denied := &AgentFacade{metrics: func() platformMetricsSample { return platformMetricsSample{} }, authorize: func(context.Context) error { return errors.New("denied") }}
	if _, err := denied.Metrics(context.Background()); err == nil {
		t.Fatal("授权失败时 Metrics 必须拒绝")
	}
	allowed := &AgentFacade{metrics: func() platformMetricsSample { return platformMetricsSample{SampledAt: "fixed"} }, authorize: func(context.Context) error { return nil }}
	value, err := allowed.Metrics(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if sample, ok := value.(platformMetricsSample); !ok || sample.SampledAt != "fixed" {
		t.Fatalf("已授权时 Metrics 必须返回采样：%+v", value)
	}
}
