package shared

import (
	"errors"
	"fmt"
	"strings"
)

// ResourceTier 是 Agent 创建容器时可选的内存与 CPU 上限。docker 的服务容器模板与
// database 的受管数据库实例共用同一张表，容量判定与回执都按它换算。
type ResourceTier struct {
	Name        string
	MemoryBytes int64
	NanoCpus    int64
}

// ResourceTiers 档位表，按由小到大排列。
var ResourceTiers = []ResourceTier{
	{Name: "small", MemoryBytes: 512 << 20, NanoCpus: 500_000_000},
	{Name: "medium", MemoryBytes: 1 << 30, NanoCpus: 1_000_000_000},
	{Name: "large", MemoryBytes: 2 << 30, NanoCpus: 2_000_000_000},
}

// ResourceTierByName 按名称取档位；未知名称返回 ok=false。
func ResourceTierByName(name string) (ResourceTier, bool) {
	for _, tier := range ResourceTiers {
		if tier.Name == name {
			return tier, true
		}
	}
	return ResourceTier{}, false
}

// HostMemory 是宿主内存读数。Linux 内核视角，容器内不代表物理宿主；Cores、Load1 与
// RootFreeBytes 是辅助读数，读不到时保持零值，不参与放行判定。
type HostMemory struct {
	TotalBytes     uint64
	AvailableBytes uint64 // MemAvailable；交换空间不计入
	Cores          int
	Load1          *float64
	RootFreeBytes  *uint64
	SampledAt      string
}

var (
	errHostMemoryUnknown          = errors.New("无法读取宿主内存读数")
	errResourceRequirementInvalid = errors.New("资源需求必须大于零")
)

// systemReserveMinBytes 是留给面板与系统的最低内存；总内存的 10% 更大时取 10%。
const systemReserveMinBytes = uint64(256) << 20

// SystemReserve 返回创建容器前必须留在宿主上的内存量。
func SystemReserve(totalBytes uint64) uint64 {
	if reserve := totalBytes / 10; reserve > systemReserveMinBytes {
		return reserve
	}
	return systemReserveMinBytes
}

// CapacityVerdict 是一次容量判定。UsableBytes 是可用内存扣除系统保留后的部分。
type CapacityVerdict struct {
	RequiredBytes  uint64
	ReserveBytes   uint64
	AvailableBytes uint64
	UsableBytes    uint64
	Fits           bool
}

// EvaluateCapacity 判断宿主能否容纳一份内存需求：可用内存扣除系统保留后不小于需求才放行。
// 读数缺失、越界或需求不是正数都报错，调用方必须按「未确认充足」处理。
func EvaluateCapacity(memory HostMemory, requiredBytes int64) (CapacityVerdict, error) {
	if requiredBytes <= 0 {
		return CapacityVerdict{}, errResourceRequirementInvalid
	}
	if memory.TotalBytes == 0 || memory.AvailableBytes == 0 || memory.AvailableBytes > memory.TotalBytes {
		return CapacityVerdict{}, errHostMemoryUnknown
	}
	verdict := CapacityVerdict{RequiredBytes: uint64(requiredBytes), ReserveBytes: SystemReserve(memory.TotalBytes), AvailableBytes: memory.AvailableBytes}
	if memory.AvailableBytes > verdict.ReserveBytes {
		verdict.UsableBytes = memory.AvailableBytes - verdict.ReserveBytes
	}
	verdict.Fits = verdict.UsableBytes >= verdict.RequiredBytes
	return verdict, nil
}

// HostCapacityTier 是一个资源档位的容量判定结果。
type HostCapacityTier struct {
	Tier      string `json:"tier"`
	MemoryMiB int    `json:"memoryMiB"`
	CpuMillis int    `json:"cpuMillis"`
	Fits      bool   `json:"fits"`
}

// HostCapacityReport 是创建容器前的宿主容量读数。Available=false 表示读数不可得，
// 此时 Reason 说明原因且不给档位判定，调用方不得视为充足。
type HostCapacityReport struct {
	SampledAt          string             `json:"sampledAt"`
	Available          bool               `json:"available"`
	Reason             string             `json:"reason,omitempty"`
	MemoryTotalMiB     int                `json:"memoryTotalMiB,omitempty"`
	MemoryAvailableMiB int                `json:"memoryAvailableMiB,omitempty"`
	ReserveMiB         int                `json:"reserveMiB,omitempty"`
	UsableMiB          int                `json:"usableMiB,omitempty"`
	Cores              int                `json:"cores,omitempty"`
	Load1              *float64           `json:"load1,omitempty"`
	RootFreeMiB        *uint64            `json:"rootFreeMiB,omitempty"`
	Tiers              []HostCapacityTier `json:"tiers"`
	Note               string             `json:"note"`
}

// HostCapacityNote 说明容量读数的口径。
const HostCapacityNote = "读数为 Linux 内核视角，容器内不代表物理宿主；可用量不含交换空间；核数、负载与根文件系统余量仅供参考，只有内存参与放行判定"

// 读数不可得的三种原因。
const (
	HostCapacityUnavailable = "当前运行环境不提供宿主容量读数"
	HostCapacityUnreadable  = "无法读取宿主内存读数"
	HostCapacityInvalid     = "宿主内存读数无效"
)

// HostMemoryReason 返回读数不可用的原因；读数可用时返回空串。
func HostMemoryReason(memory HostMemory) string {
	if memory.TotalBytes == 0 || memory.AvailableBytes == 0 || memory.AvailableBytes > memory.TotalBytes {
		return HostCapacityInvalid
	}
	return ""
}

func capacityMiB(bytes uint64) int { return int(bytes >> 20) }

// BuildHostCapacityReport 汇总一次读数并逐一判定各档位；reason 非空表示读数不可得。
func BuildHostCapacityReport(memory HostMemory, reason string) HostCapacityReport {
	if reason == "" {
		reason = HostMemoryReason(memory)
	}
	report := HostCapacityReport{Tiers: []HostCapacityTier{}, Note: HostCapacityNote}
	if reason != "" {
		report.Reason = reason
		return report
	}
	summary, _ := EvaluateCapacity(memory, 1)
	report.Available, report.SampledAt = true, memory.SampledAt
	report.MemoryTotalMiB, report.MemoryAvailableMiB = capacityMiB(memory.TotalBytes), capacityMiB(memory.AvailableBytes)
	report.ReserveMiB, report.UsableMiB = capacityMiB(summary.ReserveBytes), capacityMiB(summary.UsableBytes)
	report.Cores, report.Load1 = memory.Cores, memory.Load1
	if memory.RootFreeBytes != nil {
		free := uint64(capacityMiB(*memory.RootFreeBytes))
		report.RootFreeMiB = &free
	}
	for _, tier := range ResourceTiers {
		verdict, err := EvaluateCapacity(memory, tier.MemoryBytes)
		report.Tiers = append(report.Tiers, HostCapacityTier{Tier: tier.Name, MemoryMiB: capacityMiB(uint64(tier.MemoryBytes)), CpuMillis: int(tier.NanoCpus / 1_000_000), Fits: err == nil && verdict.Fits})
	}
	return report
}

// CapacityRejection 生成创建前的拒绝文案：带回读数与当前可容纳的档位，供模型交回用户
// 选择后重新提交。need 描述被拒的对象（如「 large 档」）；读数可容纳时返回空串。
func CapacityRejection(memory HostMemory, reason, need string, requiredBytes int64) string {
	if reason == "" {
		reason = HostMemoryReason(memory)
	}
	if reason != "" {
		return reason + "，未创建容器；请与用户确认资源情况或稍后重试"
	}
	verdict, err := EvaluateCapacity(memory, requiredBytes)
	if err != nil {
		return HostCapacityInvalid + "，未创建容器；请与用户确认资源情况或稍后重试"
	}
	if verdict.Fits {
		return ""
	}
	fitting := []string{}
	for _, tier := range ResourceTiers {
		if other, err := EvaluateCapacity(memory, tier.MemoryBytes); err == nil && other.Fits {
			fitting = append(fitting, tier.Name)
		}
	}
	list := "无"
	if len(fitting) > 0 {
		list = strings.Join(fitting, "、")
	}
	return fmt.Sprintf("宿主可用内存 %d MiB，扣除系统保留 %d MiB 后不足以容纳%s（需要 %d MiB）；当前可容纳的档位：%s。未创建容器，请与用户确认降低档位、释放内存或取消",
		capacityMiB(memory.AvailableBytes), capacityMiB(verdict.ReserveBytes), need, capacityMiB(uint64(requiredBytes)), list)
}

// OfficialDatabaseRepositories 是面板支持的数据库引擎的官方镜像仓库。
var OfficialDatabaseRepositories = []string{"mysql", "mariadb", "redis"}

// OfficialDatabaseRepository 判断镜像仓库名是否是官方数据库镜像的三种写法
// （mysql、library/mysql、docker.io/library/mysql），命中时返回规范仓库名。
func OfficialDatabaseRepository(name string) (string, bool) {
	name = strings.ToLower(name)
	for _, repository := range OfficialDatabaseRepositories {
		if name == repository || name == "library/"+repository || name == "docker.io/library/"+repository {
			return repository, true
		}
	}
	return "", false
}
