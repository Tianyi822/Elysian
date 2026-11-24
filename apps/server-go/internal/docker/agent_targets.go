package docker

import (
	"context"
	"errors"
	"path"
	"strings"

	"elysian/server/internal/shared"
)

// Agent 容器目标分类。判据只有 inspect 的标签与面板自身容器身份：面板自有容器继续
// 走各自的域路由与模板核验；没有任何面板归属标签的容器（用户自装），或只带
// elysian.managed 的面板网页创建容器，进入通用范围。未知的 elysian.* 标签一律按
// 面板内部容器拒绝，不因标签演化落到最宽松的一类。

type agentTargetClass string

const (
	targetUser      agentTargetClass = "user"
	targetPanel     agentTargetClass = "panel"
	targetTemplate  agentTargetClass = "agent-template"
	targetDatabase  agentTargetClass = "database"
	targetWebsite   agentTargetClass = "website"
	targetExecution agentTargetClass = "execution"
	targetInternal  agentTargetClass = "internal"
	targetSelf      agentTargetClass = "panel-self"
)

// ownershipOf 把目标类别映射为回执里的归属值；执行环境与内部容器对外同为面板内部容器。
func ownershipOf(class agentTargetClass) string {
	if class == targetExecution || class == targetInternal {
		return "panel-internal"
	}
	return string(class)
}

// agentScope 是一次容器操作的目标范围，按工具冻结版本选定；旧快照不因升级扩权。
type agentScope int

const (
	// scopeTemplates 只认 Agent 模板容器，不路由网站域（已退役 start/stop/restart 与 remove 的 v1）。
	scopeTemplates agentScope = iota + 1
	// scopeManaged 再加按登记路由的数据库与网站容器（power v1、remove v2/v3、exec 与 logs 的旧版本）。
	scopeManaged
	// scopeHost 再加非面板容器与面板网页创建的容器。
	scopeHost
)

func classifyAgentTarget(inspect any, selfID string) agentTargetClass {
	if selfInspectCheck(inspect, selfID) {
		return targetSelf
	}
	r, ok := asRecord(inspect)
	if !ok {
		return targetInternal
	}
	cfg, ok := asRecord(mustGet(r, "Config"))
	if !ok {
		return targetInternal
	}
	raw := mustGet(cfg, "Labels")
	labels, ok := asRecord(raw)
	if raw != nil && !ok {
		return targetInternal
	}
	return classifyAgentLabels(labels)
}

func classifyAgentLabels(labels *jsonObject) agentTargetClass {
	var managed, template, database, website, execution, internal bool
	if labels != nil {
		for _, key := range labels.orderedKeys() {
			if !strings.HasPrefix(key, "elysian.") {
				continue
			}
			switch {
			case key == labelManaged:
				managed = mustGet(labels, key) == labelTrueValue
				internal = internal || !managed
			case strings.HasPrefix(key, "elysian.agent.execution"):
				execution = true
			case key == "elysian.website.probe", key == "elysian.website.build", key == "elysian.website.deployment-owner",
				strings.HasPrefix(key, "elysian.build."), key == "elysian.panel":
				internal = true
			case key == labelDatabase, key == "elysian.database.engine", key == "elysian.database.version", key == "elysian.database.volume":
				database = true
			case key == "elysian.website", key == "elysian.website.project", key == "elysian.website.kind", key == "elysian.website.version":
				website = true
			case key == "elysian.agent.template", key == "elysian.agent.create-digest":
				template = true
			default:
				internal = true
			}
		}
	}
	switch {
	case execution:
		return targetExecution
	case internal || (database && website) || ((database || website) && template):
		return targetInternal
	case database:
		return targetDatabase
	case website:
		return targetWebsite
	case template:
		return targetTemplate
	case managed:
		return targetPanel
	}
	return targetUser
}

// agentTargetExposure 列出容器相对宿主的暴露面，供回执与审批标注；顺序固定。
func agentTargetExposure(r *jsonObject) []string {
	exposure := []string{}
	flag := func(name string) {
		for _, item := range exposure {
			if item == name {
				return
			}
		}
		exposure = append(exposure, name)
	}
	host, _ := asRecord(mustGet(r, "HostConfig"))
	if host != nil {
		if mustGet(host, "Privileged") == true {
			flag("privileged")
		}
		for _, item := range []struct{ key, name string }{
			{"NetworkMode", "host-network"}, {"PidMode", "host-pid"}, {"IpcMode", "host-ipc"}, {"UTSMode", "host-uts"}, {"UsernsMode", "host-user"},
		} {
			if mustGet(host, item.key) == "host" {
				flag(item.name)
			}
		}
		for _, item := range []struct{ key, name string }{{"CapAdd", "cap-add"}, {"Devices", "devices"}, {"DeviceRequests", "devices"}} {
			if rows, ok := mustGet(host, item.key).([]any); ok && len(rows) > 0 {
				flag(item.name)
			}
		}
	}
	if mounts, ok := mustGet(r, "Mounts").([]any); ok {
		for _, mount := range mounts {
			record, ok := asRecord(mount)
			if !ok {
				continue
			}
			for _, key := range []string{"Source", "Destination"} {
				location, _ := asString(mustGet(record, key))
				if base := path.Base(location); base == "docker.sock" || base == "podman.sock" {
					flag("docker-socket")
				}
			}
		}
	}
	if cfg, ok := asRecord(mustGet(r, "Config")); ok {
		user, _ := asString(mustGet(cfg, "User"))
		if user == "" || strings.Split(user, ":")[0] == "0" || strings.Split(user, ":")[0] == "root" {
			flag("root-user")
		}
	}
	return exposure
}

// AgentTargetNotes 是操作回执里的归属与风险标注。
type AgentTargetNotes struct {
	Ownership string   `json:"ownership"`
	Exposure  []string `json:"exposure"`
}

var agentOwnershipLabels = map[string]string{
	"user":           "非面板创建的用户容器",
	"panel":          "面板创建的容器",
	"agent-template": "Agent 模板容器",
	"database":       "面板受管数据库容器",
	"website":        "面板网站容器",
	"panel-internal": "面板内部容器",
	"panel-self":     "面板自身容器",
}

var agentExposureLabels = []struct{ flag, label string }{
	{"privileged", "特权"}, {"host-network", "共享宿主网络命名空间"}, {"host-pid", "共享宿主进程命名空间"},
	{"host-ipc", "共享宿主 IPC 命名空间"}, {"host-uts", "共享宿主 UTS 命名空间"}, {"host-user", "共享宿主用户命名空间"},
	{"docker-socket", "挂载 Docker socket"}, {"cap-add", "额外 Linux 权限"}, {"devices", "挂载宿主设备"}, {"root-user", "容器内以 root 运行"},
}

func describeAgentTarget(inspect any, selfID string) AgentTargetNotes {
	notes := AgentTargetNotes{Ownership: ownershipOf(classifyAgentTarget(inspect, selfID)), Exposure: []string{}}
	if r, ok := asRecord(inspect); ok {
		notes.Exposure = agentTargetExposure(r)
	}
	return notes
}

// Notes 给出回执标注对应的中文说明：归属在前，暴露面按固定顺序在后。
func (n AgentTargetNotes) Notes() []string {
	notes := []string{agentOwnershipLabels[n.Ownership]}
	if notes[0] == "" {
		notes[0] = "归属未知的容器"
	}
	for _, item := range agentExposureLabels {
		for _, flag := range n.Exposure {
			if flag == item.flag {
				notes = append(notes, item.label)
				break
			}
		}
	}
	return notes
}

// AgentTargetDescription 供审批展示：容器名、归属、暴露面与中文说明。
type AgentTargetDescription struct {
	Name      string   `json:"name"`
	Ownership string   `json:"ownership"`
	Exposure  []string `json:"exposure"`
	Notes     []string `json:"notes"`
}

// DescribeContainer 是宿主代码的只读展示读取（审批卡目标标注），不经模型调用，
// 不消耗单次派发票据，也不改变任何授权。
func (a *AgentFacade) DescribeContainer(ctx context.Context, id string) (AgentTargetDescription, error) {
	if a == nil || a.service == nil {
		return AgentTargetDescription{}, errors.New("容器 Agent 服务不可用")
	}
	value, err := a.inspectHostTarget(ctx, id)
	if err != nil {
		return AgentTargetDescription{}, err
	}
	record, ok := asRecord(value)
	if !ok {
		return AgentTargetDescription{}, errors.New("容器身份无效")
	}
	if err := readableAgentTarget(value, a.service.deps.selfContainerID); err != nil {
		return AgentTargetDescription{}, err
	}
	name, _ := asString(mustGet(record, "Name"))
	if name == "" {
		return AgentTargetDescription{}, errors.New("容器名称不可核验")
	}
	notes := describeAgentTarget(value, a.service.deps.selfContainerID)
	return AgentTargetDescription{
		Name: strings.TrimPrefix(name, "/"), Ownership: notes.Ownership, Exposure: notes.Exposure, Notes: notes.Notes(),
	}, nil
}

// targetForScope 按冻结范围核验变更目标。
func (a *AgentFacade) targetForScope(ctx context.Context, id string, scope agentScope) (string, error) {
	if scope != scopeHost {
		return a.safeTarget(ctx, id)
	}
	value, err := a.inspectHostTarget(ctx, id)
	if err != nil {
		return "", err
	}
	return a.operableTargetInspect(value)
}

// operableTargetInspect 是通用范围的变更核验：面板自身、执行环境与内部容器硬拒绝，
// 通用容器放行，其余沿用既有模板与域归属核验及其文案。
func (a *AgentFacade) operableTargetInspect(value any) (string, error) {
	switch classifyAgentTarget(value, a.service.deps.selfContainerID) {
	case targetSelf:
		return "", shared.InvalidRequest("面板自身容器不可经 Agent 操作")
	case targetExecution:
		return "", shared.InvalidRequest("Agent 执行环境容器由运行时管理，不可经 Agent 操作")
	case targetInternal:
		return "", shared.InvalidRequest("面板内部容器不可经 Agent 操作")
	case targetPanel, targetUser:
		row, _ := asRecord(value)
		if agentRecord(row, "HostConfig") == nil {
			return "", shared.InvalidRequest("容器宿主配置无法核实")
		}
		return requireID(value, "容器")
	}
	return a.safeTargetInspect(value)
}

// readableAgentTarget 是通用范围的只读核验：面板纳管的各类容器都可读，只有面板
// 自身、执行环境与内部容器拒绝。
func readableAgentTarget(value any, selfID string) error {
	switch classifyAgentTarget(value, selfID) {
	case targetSelf:
		return shared.InvalidRequest("面板自身容器不可经 Agent 读取")
	case targetExecution:
		return shared.InvalidRequest("Agent 执行环境容器由运行时管理，不可经 Agent 读取")
	case targetInternal:
		return shared.InvalidRequest("面板内部容器不可经 Agent 读取")
	}
	return nil
}

func (a *AgentFacade) inspectHostTarget(ctx context.Context, raw string) (any, error) {
	id, err := agentObjectID(raw, false)
	if err != nil {
		return nil, err
	}
	if a.PanelRuntime() == "unknown" {
		return nil, shared.InvalidRequest("面板自身容器身份未确认，暂不能访问此容器")
	}
	value, err := a.service.inspectContainerByID(ctx, id, actionTimeout)
	if err != nil {
		return nil, err
	}
	actual, err := requireID(value, "容器")
	if err != nil || actual != id {
		return nil, shared.InvalidRequest("容器详情与请求 ID 不匹配")
	}
	return value, nil
}
