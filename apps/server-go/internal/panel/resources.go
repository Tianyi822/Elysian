package panel

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"time"

	"elysian/server/internal/config"
	"elysian/server/internal/shared"
)

const requiredBuildMemory = uint64(1536 << 20)
const resourcePreflightTTL = 5 * time.Minute

type ResourceMemory struct {
	TotalBytes     uint64 `json:"totalBytes"`
	AvailableBytes uint64 `json:"availableBytes"`
	RequiredBytes  uint64 `json:"requiredBytes"`
	SwapTotalBytes uint64 `json:"swapTotalBytes"`
	SwapFreeBytes  uint64 `json:"swapFreeBytes"`
}
type ResourceCandidate struct {
	ID             string  `json:"id"`
	Kind           string  `json:"kind"`
	Name           string  `json:"name"`
	MemoryBytes    *uint64 `json:"memoryBytes"`
	Recommended    bool    `json:"recommended"`
	DisabledReason string  `json:"disabledReason,omitempty"`
}
type ResourcePreflight struct {
	ID        string         `json:"id"`
	ExpiresAt time.Time      `json:"expiresAt"`
	Memory    ResourceMemory `json:"memory"`
	Disk      struct {
		AvailableBytes uint64 `json:"availableBytes"`
	} `json:"disk"`
	Load                 [3]float64          `json:"load"`
	ActiveAgentRuns      int                 `json:"activeAgentRuns"`
	Candidates           []ResourceCandidate `json:"candidates"`
	NeedsRelease         bool                `json:"needsRelease"`
	StopPanelRecommended bool                `json:"stopPanelRecommended"`
	BlockedReason        string              `json:"blockedReason,omitempty"`
}
type ResourcePlan struct {
	PreflightID string   `json:"preflightId"`
	Targets     []string `json:"targets"`
	StopPanel   bool     `json:"stopPanel"`
}
type resourceTarget struct {
	ResourceCandidate
	Identity   string `json:"identity"`
	Generation string `json:"generation"`
}
type resourceStop struct {
	Target     resourceTarget `json:"target"`
	Stopped    bool           `json:"stopped"`
	Restored   bool           `json:"restored"`
	Generation string         `json:"generation"`
}
type resourceState struct {
	Running              bool
	Identity, Generation string
}
type resourceObservation struct {
	Memory          ResourceMemory
	DiskAvailable   uint64
	Load            [3]float64
	ActiveAgentRuns int
}

// Optional on test hosts; the real system host always enforces resource checks.
type resourceHost interface {
	ObserveResources(context.Context) (resourceObservation, error)
	ResourceCandidates(context.Context) ([]resourceTarget, error)
	InspectResource(context.Context, resourceTarget) (resourceState, error)
	SetResourceRunning(context.Context, resourceTarget, bool) error
	PrepareResourceRecovery(context.Context, string, string) error
}
type resourcePreflightRecord struct {
	ResourcePreflight
	Source       UpdateSource     `json:"source"`
	Channel      UpdateChannel    `json:"channel"`
	TargetCommit string           `json:"targetCommit"`
	ReleaseTag   string           `json:"releaseTag"`
	Targets      []resourceTarget `json:"targets"`
}

func (s Store) resourcePreflightPath(id string) string {
	return filepath.Join(s.tasksDir(), "preflights", id+".json")
}
func sameResourcePlan(a, b *ResourcePlan) bool { return reflect.DeepEqual(a, b) }

func validateResourcePlan(plan *ResourcePlan) error {
	if plan == nil {
		return nil
	}
	if !idPattern.MatchString(plan.PreflightID) || len(plan.Targets) > 256 {
		return shared.InvalidRequest("资源预检或停止清单无效")
	}
	seen := map[string]bool{}
	for _, id := range plan.Targets {
		if id == "" || seen[id] {
			return shared.InvalidRequest("资源停止清单包含空白或重复对象")
		}
		seen[id] = true
	}
	return nil
}
func (m Manager) checkedUpdate(input submitInput) error {
	var u Update
	b, err := os.ReadFile(m.Store.updateCheckPath(input.Channel, input.Source))
	if err != nil || json.Unmarshal(b, &u) != nil || u.Repository != Repository || normalizeChannel(u.Channel) != input.Channel || normalizeSource(u.Source) != input.Source || !u.Available || !commitPattern.MatchString(input.TargetCommit) || u.TargetCommit != input.TargetCommit || u.ReleaseTag != input.ReleaseTag || (input.Channel == ChannelRelease && u.ReleaseTag == "") {
		return shared.InvalidRequest("请先检查更新，再提交已检查的目标版本")
	}
	return nil
}
func (m Manager) PreflightUpdate(ctx context.Context, input submitInput) (ResourcePreflight, error) {
	var out ResourcePreflight
	if !m.Enabled || !m.Host.Available() {
		return out, &shared.InvalidRequestError{Status: 503, Message: "仅支持 systemd 安装版"}
	}
	input.Source, input.Channel = normalizeSource(input.Source), normalizeChannel(input.Channel)
	if !validSource(input.Source) {
		return out, shared.InvalidRequest("面板更新仅支持 GitHub，请重新检查更新")
	}
	if !validChannel(input.Channel) || input.ResourcePlan != nil || input.RequestID != "" {
		return out, shared.InvalidRequest("资源预检参数无效")
	}
	if err := m.checkedUpdate(input); err != nil {
		return out, err
	}
	host, ok := m.Host.(resourceHost)
	if !ok {
		return out, &shared.InvalidRequestError{Status: 503, Message: "资源预检不可用"}
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	observed, err := host.ObserveResources(ctx)
	if err != nil {
		return out, err
	}
	targets, err := host.ResourceCandidates(ctx)
	if err != nil {
		return out, err
	}
	id, err := newID()
	if err != nil {
		return out, err
	}
	out = ResourcePreflight{ID: id, ExpiresAt: time.Now().UTC().Add(resourcePreflightTTL), Memory: observed.Memory, Load: observed.Load, ActiveAgentRuns: observed.ActiveAgentRuns, Candidates: []ResourceCandidate{}, NeedsRelease: observed.Memory.AvailableBytes < requiredBuildMemory}
	out.Disk.AvailableBytes = observed.DiskAvailable
	out.StopPanelRecommended = out.NeedsRelease
	sort.SliceStable(targets, func(i, j int) bool {
		a, b := targets[i].MemoryBytes, targets[j].MemoryBytes
		if a == nil {
			return false
		}
		if b == nil {
			return true
		}
		return *a > *b
	})
	shortfall := uint64(0)
	if out.NeedsRelease {
		shortfall = requiredBuildMemory - out.Memory.AvailableBytes
	}
	for i := range targets {
		if shortfall > 0 && targets[i].DisabledReason == "" && targets[i].MemoryBytes != nil {
			targets[i].Recommended = true
			if *targets[i].MemoryBytes >= shortfall {
				shortfall = 0
			} else {
				shortfall -= *targets[i].MemoryBytes
			}
		}
		out.Candidates = append(out.Candidates, targets[i].ResourceCandidate)
	}
	record := resourcePreflightRecord{ResourcePreflight: out, Source: input.Source, Channel: input.Channel, TargetCommit: input.TargetCommit, ReleaseTag: input.ReleaseTag, Targets: targets}
	if err = os.MkdirAll(filepath.Dir(m.Store.resourcePreflightPath(id)), 0700); err != nil {
		return out, err
	}
	if err = config.AtomicJSON(m.Store.resourcePreflightPath(id), record); err != nil {
		return out, err
	}
	// Only expire preview snapshots; pending tasks already carry the exact selected identities.
	entries, _ := os.ReadDir(filepath.Dir(m.Store.resourcePreflightPath(id)))
	for _, entry := range entries {
		if info, e := entry.Info(); e == nil && info.Mode().IsRegular() && time.Since(info.ModTime()) > resourcePreflightTTL {
			_ = os.Remove(filepath.Join(filepath.Dir(m.Store.resourcePreflightPath(id)), entry.Name()))
		}
	}
	return out, nil
}
func (m Manager) resourceTargets(input submitInput) ([]resourceTarget, error) {
	if input.ResourcePlan == nil {
		return nil, nil
	}
	b, err := os.ReadFile(m.Store.resourcePreflightPath(input.ResourcePlan.PreflightID))
	if err != nil {
		return nil, shared.InvalidRequest("资源预检已失效，请重新检查并确认停止清单")
	}
	var p resourcePreflightRecord
	if json.Unmarshal(b, &p) != nil || p.ID != input.ResourcePlan.PreflightID || !time.Now().Before(p.ExpiresAt) || p.Source != input.Source || p.Channel != input.Channel || p.TargetCommit != input.TargetCommit || p.ReleaseTag != input.ReleaseTag {
		return nil, shared.InvalidRequest("资源预检已失效或更新目标已变化，请重新检查")
	}
	if !p.NeedsRelease && (len(input.ResourcePlan.Targets) > 0 || input.ResourcePlan.StopPanel) {
		return nil, shared.InvalidRequest("本次实测内存充足，无需停止业务资源")
	}
	if p.NeedsRelease && len(input.ResourcePlan.Targets) == 0 && !input.ResourcePlan.StopPanel {
		return nil, shared.InvalidRequest("资源不足，请至少确认一项业务资源或提前停止面板")
	}
	byID := map[string]resourceTarget{}
	for _, target := range p.Targets {
		byID[target.ID] = target
	}
	targets := []resourceTarget{}
	for _, id := range input.ResourcePlan.Targets {
		target, ok := byID[id]
		if !ok || target.DisabledReason != "" || target.Identity == "" {
			return nil, shared.InvalidRequest("停止清单包含不可停止或不属于本次预检的对象")
		}
		targets = append(targets, target)
	}
	return targets, nil
}
func (r taskRecord) resourcesPending() bool {
	if r.PanelStopIntent && !r.PanelRestored {
		return true
	}
	for _, stop := range r.ResourceStops {
		if !stop.Restored {
			return true
		}
	}
	return false
}
func resourceError(available uint64) error {
	return fmt.Errorf("更新构建至少需要 1536 MiB 可用内存，当前 %.0f MiB；请重新预检并确认停止清单，未扩大停机范围", float64(available)/(1<<20))
}
