package platform

import (
	"os"
	"reflect"
	"testing"
	"time"
)

func testMemoryUsage() memoryUsage {
	rss := float64(80 * bytesPerMiB)
	systemTotal := float64(1024 * bytesPerMiB)
	return memoryUsage{
		RSS: &rss, RSSSource: "smaps-rollup", SampledAt: time.Date(2026, 10, 2, 6, 0, 0, 0, time.UTC),
		SystemTotal: &systemTotal,
		HeapUsed:    40 * bytesPerMiB, HeapTotal: 50 * bytesPerMiB,
		HeapUnused: bytesPerMiB, HeapRetained: 3 * bytesPerMiB, HeapReleased: 6 * bytesPerMiB,
		RuntimeOther: 5 * bytesPerMiB, HeapLive: 35 * bytesPerMiB, GCCount: 8,
	}
}

func TestMemorySampleUnitsAndUnavailableRSS(t *testing.T) {
	usage := testMemoryUsage()
	sample := sampleFromUsage(usage)
	if *sample.RSSMb != 80 || *sample.SystemTotalMb != 1024 || sample.HeapUsedMb != 40 || sample.HeapReleasedMb != 6 || sample.RuntimeOtherMb != 5 {
		t.Fatalf("MiB 换算错误：%+v", sample)
	}
	if sample.SampledAt != "2026-10-02T06:00:00Z" || sample.HeapLiveMb != 35 || sample.GCCount != 8 {
		t.Fatalf("采样元数据错误：%+v", sample)
	}
	usage.RSS = nil
	usage.RSSSource = "unavailable"
	sample = sampleFromUsage(usage)
	if sample.RSSMb != nil || sample.HeapUsedMb != 40 {
		t.Fatalf("RSS 不可用时不应伪造读数或丢失 Go 分项：%+v", sample)
	}
}

func TestSystemMemoryCapacity(t *testing.T) {
	for _, tt := range []struct {
		name      string
		data      string
		wantBytes float64
	}{
		{"系统总量按内核 kB 换算", "MemFree: 100 kB\nMemTotal: 1048576 kB\n", 1024 * bytesPerMiB},
		{"不以空闲量替代总量", "MemFree: 100 kB\n", 0},
		{"零总量不可用", "MemTotal: 0 kB\n", 0},
		{"负数不可用", "MemTotal: -1 kB\n", 0},
		{"错误单位不可用", "MemTotal: 1 MB\n", 0},
	} {
		t.Run(tt.name, func(t *testing.T) {
			value := readSystemMemoryBytes(func(path string) ([]byte, error) {
				if path != "/proc/meminfo" {
					t.Fatalf("总量读取路径错误：%s", path)
				}
				return []byte(tt.data), nil
			})
			if tt.wantBytes == 0 {
				if value != nil {
					t.Fatal("无有效参照总量时必须返回 null")
				}
			} else if value == nil || *value != tt.wantBytes {
				t.Fatalf("系统总内存换算错误：%v", value)
			}
		})
	}
	if readSystemMemoryBytes(func(string) ([]byte, error) { return nil, os.ErrPermission }) != nil {
		t.Fatal("系统总内存不可读时不能推断容量")
	}
}

func TestResidentMemorySourceFallback(t *testing.T) {
	tests := []struct {
		name       string
		files      map[string]string
		pageSize   int
		wantSource string
		wantBytes  float64
		wantReads  []string
	}{
		{"精确聚合优先", map[string]string{"smaps_rollup": "Rss: 1024 kB\nPss: 512 kB\n", "statm": "900 800"}, 4096, "smaps-rollup", 1024 * 1024, []string{"smaps_rollup"}},
		{"聚合无效时累加映射", map[string]string{"smaps_rollup": "Rss: 错误 kB", "smaps": "Size: 8192 kB\nRss: 1024 kB\nPss: 800 kB\nRss: 512 kB\n"}, 4096, "smaps", 1536 * 1024, []string{"smaps_rollup", "smaps"}},
		{"页大小按系统换算并标近似", map[string]string{"statm": "10 2 0"}, 65536, "statm", 2 * 65536, []string{"smaps_rollup", "smaps", "statm"}},
		{"实际常驻为零", map[string]string{"smaps_rollup": "Rss: 0 kB"}, 4096, "smaps-rollup", 0, []string{"smaps_rollup"}},
		{"全部不可读", nil, 4096, "unavailable", 0, []string{"smaps_rollup", "smaps", "statm"}},
		{"无效近似读数也不可用", map[string]string{"statm": "10 NaN"}, 4096, "unavailable", 0, []string{"smaps_rollup", "smaps", "statm"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var reads []string
			readFile := func(path string) ([]byte, error) {
				const prefix = "/proc/self/"
				name := path[len(prefix):]
				reads = append(reads, name)
				data, ok := tt.files[name]
				if !ok {
					return nil, os.ErrPermission
				}
				return []byte(data), nil
			}
			rss, source := readResidentBytes(readFile, tt.pageSize)
			if source != tt.wantSource || !reflect.DeepEqual(reads, tt.wantReads) {
				t.Fatalf("采样来源或回落次序错误：%s %v", source, reads)
			}
			if source == "unavailable" {
				if rss != nil {
					t.Fatal("无法读取实际常驻内存时必须返回 null")
				}
			} else if rss == nil || *rss != tt.wantBytes {
				t.Fatalf("常驻内存换算错误：%v", rss)
			}
		})
	}
}

func TestResidentMemoryRejectsMalformedFields(t *testing.T) {
	for _, data := range []string{"Pss: 10 kB", "Rss: -1 kB", "Rss: 1 MB", "Rss: NaN kB", "Rss: 1.5 kB", "Rss: 1"} {
		if _, err := parseSmapsRSS([]byte(data)); err == nil {
			t.Fatalf("应拒绝无效的映射读数：%q", data)
		}
	}
	for _, data := range []string{"1", "1 -2", "1 NaN", "1 1.5"} {
		if _, err := parseResidentPages([]byte(data), 4096); err == nil {
			t.Fatalf("应拒绝无效的常驻页数：%q", data)
		}
	}
}

func TestRuntimeMemoryMetricsPartition(t *testing.T) {
	usage := processMemoryUsage()
	if usage.HeapTotal != usage.HeapUsed+usage.HeapUnused+usage.HeapRetained+usage.HeapReleased {
		t.Fatalf("Go 堆分项不守恒：%+v", usage)
	}
	if usage.RuntimeOther == 0 || usage.SampledAt.IsZero() {
		t.Fatalf("Go 运行时或采样元数据缺失：%+v", usage)
	}
	if usage.RSSSource == "unavailable" && usage.RSS != nil {
		t.Fatal("不可用来源不能带伪造常驻数值")
	}
}
