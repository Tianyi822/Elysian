package docker

import (
	"os"
	"regexp"
	"strings"

	"elysian/server/internal/seam"
)

// 自我容器识别（selfContainer.ts 逐字移植）：cgroup 64 位 hex 通道优先，
// hostname 通道仅在 12 位小写 hex 前缀唯一命中时启用（宁可不保护也不错杀）。

var (
	containerIDHexPattern = regexp.MustCompile(`[0-9a-fA-F]{64}`)
	hostnameShortID       = regexp.MustCompile(`^[0-9a-f]{12}$`)
)

// resolveSelfContainerId 双通道解析面板自身容器 ID；无法唯一判定返回空串。
func resolveSelfContainerId(cgroupText string, ids []string, hostname string) string {
	idByLower := make(map[string]string, len(ids))
	for _, id := range ids {
		if len(id) == 64 {
			idByLower[strings.ToLower(id)] = id
		}
	}

	for _, match := range containerIDHexPattern.FindAllString(cgroupText, -1) {
		if resolved, ok := idByLower[strings.ToLower(match)]; ok {
			return resolved
		}
	}

	if !hostnameShortID.MatchString(hostname) {
		return ""
	}
	prefix := strings.ToLower(hostname)
	uniqueHit := ""
	for lowerID, id := range idByLower {
		if !strings.HasPrefix(lowerID, prefix) {
			continue
		}
		if uniqueHit != "" {
			return ""
		}
		uniqueHit = id
	}
	return uniqueHit
}

// selfInspectCheck 引擎 inspect 解析后的自容器判定（selfContainer.ts
// isSelfContainerInspect：以解析后完整 Id 比对，名/前缀寻址同拦）。
func selfInspectCheck(inspect any, selfContainerID string) bool {
	if selfContainerID == "" {
		return false
	}
	record, ok := asRecord(inspect)
	if !ok {
		return false
	}
	id, ok := asString(mustGet(record, "Id"))
	if !ok || id == "" {
		return false
	}
	return seam.IsSelfContainer(selfContainerID, id)
}

// readCgroupText 读 /proc/1/cgroup 与 /proc/self/cgroup；任一失败整体容错空串
// （TS 单 try 包两条 readFileSync 的语义）。
func readCgroupText() string {
	boot, err1 := os.ReadFile("/proc/1/cgroup")
	self, err2 := os.ReadFile("/proc/self/cgroup")
	if err1 != nil || err2 != nil {
		return ""
	}
	return string(boot) + "\n" + string(self)
}
