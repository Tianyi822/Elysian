package platform

import (
	"context"
	"errors"
	"math"
	"os"
	"testing"
	"time"

	"elysian/server/internal/seam"
)

func hostCapacityTestSource(files map[string]string) hostCapacity {
	return hostCapacity{
		readFile: func(path string) ([]byte, error) {
			if data, ok := files[path]; ok {
				return []byte(data), nil
			}
			return nil, os.ErrNotExist
		},
		statfs: func(path string) (diskUsage, error) {
			if path == "/" {
				return diskUsage{FreeBytes: 42}, nil
			}
			return diskUsage{}, os.ErrNotExist
		},
		now: func() time.Time { return time.Date(2026, 11, 26, 11, 0, 0, 0, time.UTC) },
	}
}

func TestNewHostCapacityImplementsSeam(t *testing.T) {
	if _, ok := any(NewHostCapacity()).(seam.HostCapacity); !ok {
		t.Fatal("NewHostCapacity 必须实现 seam.HostCapacity")
	}
}

func TestHostCapacitySamplesMemoryCoresLoadAndRootDisk(t *testing.T) {
	h := hostCapacityTestSource(map[string]string{
		"/proc/meminfo": "MemTotal: 4096 kB\nMemFree: 100 kB\nMemAvailable: 1500 kB\nSwapTotal: 2048 kB\nSwapFree: 2048 kB\n",
		"/proc/loadavg": "0.52 0.58 0.59 1/234 5678\n",
		"/proc/stat":    "cpu  1 2 3 4\ncpu0 1 2 3 4\ncpu1 1 2 3 4\nintr 0\n",
	})
	memory, err := h.Sample(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if memory.TotalBytes != 4096*1024 || memory.AvailableBytes != 1500*1024 {
		t.Errorf("内存读数应为精确字节数且不含交换空间：%+v", memory)
	}
	if memory.Cores != 2 || memory.Load1 == nil || math.Abs(*memory.Load1-0.52) > 1e-9 {
		t.Errorf("核数或负载读数错误：%+v", memory)
	}
	if memory.RootFreeBytes == nil || *memory.RootFreeBytes != 42 {
		t.Errorf("根文件系统可用空间读数错误：%+v", memory)
	}
	if memory.SampledAt != "2026-11-26T11:00:00Z" {
		t.Errorf("采样时间错误：%+v", memory)
	}
}

func TestHostCapacityKeepsWorkingWithoutOptionalReadings(t *testing.T) {
	h := hostCapacityTestSource(map[string]string{"/proc/meminfo": "MemTotal: 2048 kB\nMemAvailable: 1024 kB\n"})
	memory, err := h.Sample(context.Background())
	if err != nil {
		t.Fatalf("负载、核数与磁盘读不到时仍应返回内存读数：%v", err)
	}
	if memory.TotalBytes != 2048*1024 || memory.AvailableBytes != 1024*1024 || memory.Cores != 0 || memory.Load1 != nil {
		t.Errorf("负载与核数读不到时应保持零值：%+v", memory)
	}
	if memory.RootFreeBytes == nil || *memory.RootFreeBytes != 42 {
		t.Errorf("根文件系统读数与 /proc 无关，仍应返回：%+v", memory)
	}
}

func TestHostCapacityFailsWhenMemoryIsUnreadable(t *testing.T) {
	for _, files := range []map[string]string{
		nil,
		{"/proc/meminfo": "MemTotal: 0 kB\nMemAvailable: 10 kB\n"},
		{"/proc/meminfo": "MemTotal: 100 kB\nMemAvailable: 101 kB\n"},
	} {
		if _, err := hostCapacityTestSource(files).Sample(context.Background()); err == nil {
			t.Errorf("内存读数缺失或越界时必须报错：%v", files)
		}
	}
}

func TestHostCapacityHonorsCancelledContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := hostCapacityTestSource(map[string]string{"/proc/meminfo": "MemTotal: 1 kB\nMemAvailable: 1 kB\n"}).Sample(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("已取消的上下文不应读数：%v", err)
	}
}
