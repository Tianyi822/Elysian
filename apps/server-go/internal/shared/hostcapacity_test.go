package shared

import (
	"strings"
	"testing"
)

func TestSystemReserveIsAtLeast256MiBOrTenPercentOfTotal(t *testing.T) {
	const mib = uint64(1) << 20
	for _, tc := range []struct{ total, want uint64 }{
		{0, 256 * mib},
		{1 * mib, 256 * mib},
		{2048 * mib, 256 * mib}, // 10% 只有 204.8 MiB，取下限
		{4096 * mib, 4096 * mib / 10},
		{8192 * mib, 8192 * mib / 10},
	} {
		if got := SystemReserve(tc.total); got != tc.want {
			t.Errorf("SystemReserve(%d) = %d，want %d", tc.total, got, tc.want)
		}
	}
}

func TestEvaluateCapacityRequiresReservePlusRequestedMemory(t *testing.T) {
	const mib, mibi = uint64(1) << 20, int64(1) << 20
	memory := HostMemory{TotalBytes: 4096 * mib}
	reserve := SystemReserve(memory.TotalBytes)
	memory.AvailableBytes = reserve + 512*mib
	verdict, err := EvaluateCapacity(memory, 512*mibi)
	if err != nil {
		t.Fatal(err)
	}
	if !verdict.Fits || verdict.ReserveBytes != reserve || verdict.UsableBytes != 512*mib || verdict.RequiredBytes != 512*mib {
		t.Fatalf("恰好等于保留量加需求时应放行：%+v", verdict)
	}

	memory.AvailableBytes = reserve + 512*mib - 1
	verdict, err = EvaluateCapacity(memory, 512*mibi)
	if err != nil {
		t.Fatal(err)
	}
	if verdict.Fits {
		t.Fatalf("差 1 字节不应放行：%+v", verdict)
	}
}

func TestEvaluateCapacityNeverCountsSwap(t *testing.T) {
	// 交换空间不是可用内存：可用量低于保留量时可用量为 0，小需求也不放行。
	const mib = uint64(1) << 20
	verdict, err := EvaluateCapacity(HostMemory{TotalBytes: 4096 * mib, AvailableBytes: 100 * mib}, 1)
	if err != nil {
		t.Fatal(err)
	}
	if verdict.Fits || verdict.UsableBytes != 0 {
		t.Fatalf("可用内存低于系统保留量时不应放行：%+v", verdict)
	}
}

func TestEvaluateCapacityRejectsUnknownReading(t *testing.T) {
	for _, memory := range []HostMemory{
		{},
		{TotalBytes: 4096 << 20},
		{TotalBytes: 100, AvailableBytes: 101},
	} {
		if _, err := EvaluateCapacity(memory, 1); err == nil {
			t.Errorf("读数不可得不得视为充足：%+v", memory)
		}
	}
}

func TestEvaluateCapacityRejectsNonPositiveRequirement(t *testing.T) {
	memory := HostMemory{TotalBytes: 4096 << 20, AvailableBytes: 2048 << 20}
	for _, required := range []int64{0, -1} {
		if _, err := EvaluateCapacity(memory, required); err == nil {
			t.Errorf("需求 %d 必须被拒绝", required)
		}
	}
}

func TestResourceTiersAreSharedByDockerAndDatabase(t *testing.T) {
	const mib = int64(1) << 20
	for name, want := range map[string]ResourceTier{
		"small":  {Name: "small", MemoryBytes: 512 * mib, NanoCpus: 500_000_000},
		"medium": {Name: "medium", MemoryBytes: 1024 * mib, NanoCpus: 1_000_000_000},
		"large":  {Name: "large", MemoryBytes: 2048 * mib, NanoCpus: 2_000_000_000},
	} {
		got, ok := ResourceTierByName(name)
		if !ok || got != want {
			t.Errorf("档位 %s = %+v，want %+v", name, got, want)
		}
	}
	if _, ok := ResourceTierByName("huge"); ok {
		t.Error("未知档位不得命中")
	}
	if len(ResourceTiers) != 3 {
		t.Fatalf("档位表应恰好三项：%+v", ResourceTiers)
	}
}

func TestHostMemoryReasonRejectsUnusableReadings(t *testing.T) {
	const mib = uint64(1) << 20
	for name, memory := range map[string]HostMemory{
		"全零":    {},
		"没有可用量": {TotalBytes: 4 * 1024 * mib},
		"可用量越界": {TotalBytes: 100, AvailableBytes: 101},
	} {
		if got := HostMemoryReason(memory); got != HostCapacityInvalid {
			t.Errorf("%s：应判定读数无效，得 %q", name, got)
		}
	}
	if got := HostMemoryReason(HostMemory{TotalBytes: 4 * 1024 * mib, AvailableBytes: 2 * 1024 * mib}); got != "" {
		t.Errorf("有效读数不应带原因：%q", got)
	}
}

func TestBuildHostCapacityReportSummarizesReadingAndEveryTier(t *testing.T) {
	const mib = uint64(1) << 20
	load, free := 0.75, uint64(4096)<<20
	report := BuildHostCapacityReport(HostMemory{TotalBytes: 2560 * mib, AvailableBytes: 256*mib + 1024*mib + 7*mib, Cores: 4, Load1: &load, RootFreeBytes: &free, SampledAt: "2026-11-26T11:00:00Z"}, "")
	if !report.Available || report.SampledAt != "2026-11-26T11:00:00Z" || report.MemoryTotalMiB != 2560 || report.MemoryAvailableMiB != 1287 ||
		report.ReserveMiB != 256 || report.UsableMiB != 1031 || report.Cores != 4 || report.Load1 == nil || *report.Load1 != 0.75 ||
		report.RootFreeMiB == nil || *report.RootFreeMiB != 4096 || report.Note == "" {
		t.Fatalf("容量读数汇总错误：%+v", report)
	}
	if len(report.Tiers) != 3 {
		t.Fatalf("应逐一判定三档：%+v", report.Tiers)
	}
	for i, want := range []bool{true, true, false} {
		if report.Tiers[i].Fits != want {
			t.Errorf("档位 %s 放行判定应为 %v：%+v", report.Tiers[i].Tier, want, report.Tiers[i])
		}
	}
	if first := report.Tiers[0]; first.Tier != "small" || first.MemoryMiB != 512 || first.CpuMillis != 500 {
		t.Errorf("档位换算错误：%+v", first)
	}
	if last := report.Tiers[2]; last.Tier != "large" || last.CpuMillis != 2000 {
		t.Errorf("档位换算错误：%+v", last)
	}
}

func TestBuildHostCapacityReportWithReasonGivesNoTiers(t *testing.T) {
	report := BuildHostCapacityReport(HostMemory{}, HostCapacityUnreadable)
	if report.Available || report.Reason != HostCapacityUnreadable || len(report.Tiers) != 0 || report.Tiers == nil {
		t.Fatalf("读数不可得时不得给出档位判定：%+v", report)
	}
}

func TestCapacityRejectionNamesReadingAndFittingTiers(t *testing.T) {
	const mib, mibi = uint64(1) << 20, int64(1) << 20
	got := CapacityRejection(HostMemory{TotalBytes: 2560 * mib, AvailableBytes: 256*mib + 1024*mib}, "", " large 档", 2048*mibi)
	for _, want := range []string{"可用内存 1280 MiB", "系统保留 256 MiB", "large 档", "2048 MiB", "可容纳的档位：small、medium", "未创建容器", "与用户确认"} {
		if !strings.Contains(got, want) {
			t.Errorf("拒绝文案缺少 %q：%s", want, got)
		}
	}
	if none := CapacityRejection(HostMemory{TotalBytes: 2560 * mib, AvailableBytes: 256*mib + 512*mib - 1}, "", " small 档", 512*mibi); !strings.Contains(none, "可容纳的档位：无") {
		t.Errorf("一档都放不下时应如实说明：%s", none)
	}
	for _, reason := range []string{HostCapacityUnavailable, HostCapacityUnreadable, HostCapacityInvalid} {
		got := CapacityRejection(HostMemory{}, reason, " small 档", 512*mibi)
		if !strings.Contains(got, reason) || !strings.Contains(got, "未创建容器") {
			t.Errorf("读数不可得的拒绝应带原因：%s", got)
		}
	}
}

func TestOfficialDatabaseRepositoryAcceptsThreeOfficialForms(t *testing.T) {
	for name, want := range map[string]string{
		"mysql": "mysql", "library/mariadb": "mariadb", "docker.io/library/redis": "redis", "MySQL": "mysql",
	} {
		if repository, ok := OfficialDatabaseRepository(name); !ok || repository != want {
			t.Errorf("OfficialDatabaseRepository(%q) = %q, %v", name, repository, ok)
		}
	}
	for _, name := range []string{"", "percona/mysql", "mysql/parser", "docker.io/percona/mysql", "library/mysql/x"} {
		if repository, ok := OfficialDatabaseRepository(name); ok {
			t.Errorf("OfficialDatabaseRepository(%q) 不应命中：%q", name, repository)
		}
	}
}
