package database

import (
	"context"
	"sort"
	"strconv"
	"strings"

	"elysian/server/internal/shared"
)

// 数据库实例发现与部署决策：按引擎与版本找出可复用的实例，否则判断新建之前还缺什么
//（镜像、容量或接管）。决策只读，不创建任何资源。

// InstanceOwnership 是实例相对面板的归属。
const (
	instanceManaged   = "managed"   // 面板创建，持有管理员凭据
	instanceAdopted   = "adopted"   // 自装容器，经数据库页接管并核验凭据
	instanceUnmanaged = "unmanaged" // 自装容器，面板不持有凭据
)

// ProvisionAction 是一次部署的决策结果。
const (
	planReuse           = "reuse"            // 复用现有实例
	planInstanceStopped = "instance-stopped" // 匹配实例已停止
	planAdoptFirst      = "adopt-first"      // 只有未接管的匹配容器，须先在数据库页接管
	planCreate          = "create"           // 新建受管实例
	planPullImageFirst  = "pull-image-first" // 本地没有该版本镜像
	planChooseVersion   = "choose-version"   // 调用方还没给出明确版本
	planInsufficient    = "insufficient"     // 宿主容量放不下最小档位
)

// InstanceView 是给 Agent 与部署决策的实例投影：不含任何凭据值。
type InstanceView struct {
	ID           string                `json:"id"`
	Name         string                `json:"name"`
	Engine       string                `json:"engine"`
	Version      string                `json:"version"`
	Status       string                `json:"status"`
	Ownership    string                `json:"ownership"`
	ResourceTier string                `json:"resourceTier,omitempty"`
	Address      *containerAddressView `json:"address,omitempty"`
	// Official 表示实例运行的是该引擎的官方镜像。
	Official  bool                  `json:"official"`
	Reusable  bool                  `json:"reusable"`
	Adoptable bool                  `json:"adoptable"`
	Reason    string                `json:"reason,omitempty"`
	Databases []logicalDatabaseView `json:"databases"`
}

// ProvisionPlan 是一次部署的决策与依据。
type ProvisionPlan struct {
	Engine         string                     `json:"engine"`
	Version        string                     `json:"version,omitempty"`
	Action         string                     `json:"action"`
	Instance       *InstanceView              `json:"instance,omitempty"`
	Reason         string                     `json:"reason"`
	LocalImageTags []string                   `json:"localImageTags,omitempty"`
	Capacity       *shared.HostCapacityReport `json:"capacity,omitempty"`
}

func instanceView(row containerInstance) InstanceView {
	view := InstanceView{ID: row.ID, Name: row.Name, Engine: row.Engine, Version: row.Version, Status: row.Status,
		ResourceTier: row.ResourceTier, Address: row.Address, Databases: append([]logicalDatabaseView{}, row.Databases...)}
	switch row.Source {
	case sourceManaged:
		view.Ownership = instanceManaged
	case sourceAdopted:
		view.Ownership = instanceAdopted
	default:
		view.Ownership = instanceUnmanaged
	}
	// 官方镜像：引用本身就是官方仓库，或引用是裸摘要但清单解析出了官方标签的版本。
	repo, _ := splitImageRef(row.Image)
	view.Official = row.Engine != "" && (imageMatches(row.Engine, repo) || shaRefPattern.MatchString(strings.ToLower(row.Image)) && row.Version != "")
	switch {
	case row.Status != statusRunning:
		view.Reason = "实例未运行"
	case row.NeedsAttention:
		view.Reason = "实例待核对：管理员凭据尚未核对，请先在数据库页重新核对"
	case view.Ownership == instanceUnmanaged:
		view.Reason = "面板未持有该实例的管理员凭据，须先在数据库页接管"
	}
	view.Reusable = row.Status == statusRunning && !row.NeedsAttention && view.Ownership != instanceUnmanaged && row.CredentialsVerified
	view.Adoptable = row.Status == statusRunning && view.Ownership == instanceUnmanaged && view.Official && row.Version != ""
	if view.Reusable {
		view.Reason = ""
	}
	return view
}

// versionMatches 判断实例版本是否满足请求：完全一致，或是请求版本之下的补丁版本。
func versionMatches(instanceTag, wanted string) bool {
	if wanted == "" || instanceTag == wanted {
		return true
	}
	return strings.HasPrefix(instanceTag, wanted+".")
}

// ListInstances 列出本机全部数据库实例的 Agent 投影。
func (s *databaseService) ListInstances(ctx context.Context) ([]InstanceView, error) {
	rows, err := s.List(ctx)
	if err != nil {
		return nil, err
	}
	views := make([]InstanceView, 0, len(rows))
	for _, row := range rows {
		views = append(views, instanceView(row))
	}
	return views, nil
}

// PlanProvision 决定一次部署怎么做。newInstance 为 true 时跳过复用；instanceID 非空时
// 只考虑该实例。
func (s *databaseService) PlanProvision(ctx context.Context, engine, version, instanceID string, newInstance bool) (ProvisionPlan, error) {
	if engine != engineMySQL && engine != engineMariaDB && engine != engineRedis {
		return ProvisionPlan{}, shared.InvalidRequest("数据库引擎不受支持")
	}
	plan := ProvisionPlan{Engine: engine, Version: version}
	instances, err := s.ListInstances(ctx)
	if err != nil {
		return plan, err
	}
	if instanceID != "" {
		if !validDatabaseVersion(version) {
			return plan, shared.InvalidRequest("必须指定明确的数据库版本，不能使用 latest")
		}
		return planForInstance(instances, engine, instanceID, plan)
	}
	if version == "" {
		plan.Action, plan.Reason = planChooseVersion, "尚未给出明确版本；请与用户确认后使用本地已有的版本，或先拉取镜像"
		if plan.LocalImageTags, err = s.localImageTags(ctx, engine); err != nil {
			return plan, err
		}
		return plan, nil
	}
	if !validDatabaseVersion(version) {
		return plan, shared.InvalidRequest("必须指定明确的数据库版本，不能使用 latest")
	}
	// newInstance 是用户明确选择新建（例如已被告知接管选项之后），不再回到复用或接管。
	if newInstance {
		return s.planCreate(ctx, engine, version, plan)
	}
	var stopped, unadopted *InstanceView
	for i := range instances {
		view := instances[i]
		if view.Engine != engine || !versionMatches(view.Version, version) {
			continue
		}
		switch {
		case view.Reusable:
			if plan.Instance == nil || betterInstance(view, *plan.Instance, version) {
				plan.Instance = &instances[i]
			}
		case view.Ownership != instanceUnmanaged:
			if stopped == nil {
				stopped = &instances[i]
			}
		case view.Adoptable:
			if unadopted == nil {
				unadopted = &instances[i]
			}
		}
	}
	switch {
	case plan.Instance != nil:
		plan.Action, plan.Reason = planReuse, "版本匹配的实例正在运行且面板持有管理凭据，直接在其中建库建用户，不新建容器"
	case stopped != nil:
		plan.Action, plan.Instance = planInstanceStopped, stopped
		plan.Reason = "版本匹配的实例已停止；是否启动由用户决定，面板不会自行启动"
	case unadopted != nil:
		plan.Action, plan.Instance = planAdoptFirst, unadopted
		plan.Reason = "只有未接管的自装容器版本匹配。请用户在数据库页对该容器点「接管」并填写管理员凭据，完成后重新提交；或改用 newInstance 新建独立实例"
	default:
		return s.planCreate(ctx, engine, version, plan)
	}
	return plan, nil
}

func planForInstance(instances []InstanceView, engine, instanceID string, plan ProvisionPlan) (ProvisionPlan, error) {
	for i := range instances {
		if instances[i].ID != instanceID {
			continue
		}
		if instances[i].Engine != engine {
			return plan, shared.InvalidRequest("指定的实例不是该引擎的数据库")
		}
		if !versionMatches(instances[i].Version, plan.Version) {
			return plan, shared.InvalidRequest("请求版本 " + plan.Version + " 与指定实例版本 " + instances[i].Version + " 不匹配")
		}
		plan.Instance = &instances[i]
		switch {
		case instances[i].Reusable:
			plan.Action, plan.Reason = planReuse, "指定的实例正在运行且面板持有管理凭据，直接在其中建库建用户"
		case instances[i].Adoptable:
			plan.Action, plan.Reason = planAdoptFirst, "指定的实例尚未接管；请用户在数据库页对该容器点「接管」并填写管理员凭据，完成后重新提交"
		default:
			plan.Action = planInstanceStopped
			plan.Reason = "指定的实例当前不可用：" + instances[i].Reason
		}
		return plan, nil
	}
	return plan, shared.NotFound("指定的数据库实例不存在")
}

// betterInstance 在多个可复用实例里挑选：版本完全一致的优先，其次版本更新的。
func betterInstance(candidate, current InstanceView, wanted string) bool {
	if (candidate.Version == wanted) != (current.Version == wanted) {
		return candidate.Version == wanted
	}
	return versionLess(current.Version, candidate.Version)
}

// planCreate 判断新建之前还缺什么：镜像必须已在本地，容量必须放得下最小档位。
func (s *databaseService) planCreate(ctx context.Context, engine, version string, plan ProvisionPlan) (ProvisionPlan, error) {
	tags, err := s.localImageTags(ctx, engine)
	if err != nil {
		return plan, err
	}
	plan.LocalImageTags = tags
	present := false
	for _, tag := range tags {
		present = present || tag == version
	}
	if !present {
		plan.Action = planPullImageFirst
		plan.Reason = "本地没有该版本的官方镜像；请先用 docker_image_pull 拉取 " + engineRepository[engine] + ":" + version + " 后重新提交。本地已有版本：" + strings.Join(tags, "、")
		return plan, nil
	}
	memory, reason := s.sampleHostMemory(ctx)
	report := shared.BuildHostCapacityReport(memory, reason)
	plan.Capacity = &report
	if !report.Available {
		plan.Action, plan.Reason = planInsufficient, "无法确认宿主容量（"+report.Reason+"），不能新建实例；请与用户确认资源情况或稍后重试"
		return plan, nil
	}
	if len(report.Tiers) == 0 || !report.Tiers[0].Fits {
		plan.Action = planInsufficient
		plan.Reason = "宿主可用内存 " + strconv.Itoa(report.UsableMiB) + " MiB，连最小档位 " + shared.ResourceTiers[0].Name + "（" + strconv.FormatInt(shared.ResourceTiers[0].MemoryBytes>>20, 10) + " MiB）也放不下，不能新建实例；请与用户确认释放内存或改用现有实例"
		return plan, nil
	}
	plan.Action, plan.Reason = planCreate, "没有可复用的实例，将新建受管实例；新建需要用户选定资源档位与网络范围"
	return plan, nil
}

func (s *databaseService) sampleHostMemory(ctx context.Context) (shared.HostMemory, string) {
	if s.deps.hostCapacity == nil {
		return shared.HostMemory{}, shared.HostCapacityUnavailable
	}
	memory, err := s.deps.hostCapacity.Sample(ctx)
	if err != nil {
		return shared.HostMemory{}, shared.HostCapacityUnreadable
	}
	return memory, shared.HostMemoryReason(memory)
}

// localImageTags 列出本地已有、属于该引擎官方仓库的明确版本标签，按版本从新到旧。
func (s *databaseService) localImageTags(ctx context.Context, engine string) ([]string, error) {
	images, err := s.deps.listImages(ctx)
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	tags := []string{}
	for _, image := range images {
		for _, ref := range append([]string{image.Name + ":" + image.Tag}, image.OtherTags...) {
			name, tag := splitImageRef(ref)
			if imageMatches(engine, name) && validDatabaseVersion(tag) && !seen[tag] {
				seen[tag] = true
				tags = append(tags, tag)
			}
		}
	}
	sort.Slice(tags, func(i, j int) bool { return versionLess(tags[j], tags[i]) })
	return tags, nil
}

// versionLess 按数值段逐段比较版本，a 较小时为真。
func versionLess(a, b string) bool {
	left, right := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < len(left) && i < len(right); i++ {
		x, _ := strconv.Atoi(left[i])
		y, _ := strconv.Atoi(right[i])
		if x != y {
			return x < y
		}
	}
	return len(left) < len(right)
}
