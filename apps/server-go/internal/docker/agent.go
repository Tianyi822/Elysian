package docker

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"

	"elysian/server/internal/contract"
	"elysian/server/internal/shared"
)

// AgentFacade exposes a narrow, host-owned capability surface, never Engine.
type AgentFacade struct {
	service    *dockerService
	authorize  func(context.Context) error
	taskMu     sync.Mutex
	pullTasks  map[string]*AgentPullTask
	taskRoot   string
	pullCancel map[string]context.CancelFunc
	taskWG     sync.WaitGroup
	closed     bool
}

func (a *AgentFacade) Authorize(ctx context.Context) error { return a.check(ctx) }

type AgentCreateInput struct {
	Name      string `json:"name"`
	Image     string `json:"image"`
	RequestID string `json:"requestId"`
}

var agentDigestImage = regexp.MustCompile(`^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$`)

func (a *AgentFacade) check(ctx context.Context) error {
	if a == nil || a.service == nil || a.authorize == nil {
		return errors.New("容器 Agent 服务或派发授权不可用")
	}
	return a.authorize(ctx)
}

func (a *AgentFacade) Action(ctx context.Context, id, action string) (contract.Container, error) {
	if err := a.check(ctx); err != nil {
		return contract.Container{}, err
	}
	if action != "start" && action != "stop" && action != "restart" {
		return contract.Container{}, shared.InvalidRequest("容器动作无效")
	}
	target, err := a.safeTarget(ctx, id)
	if err != nil {
		return contract.Container{}, err
	}
	return a.service.Action(ctx, target, action)
}

func (a *AgentFacade) Remove(ctx context.Context, id string) error {
	if err := a.check(ctx); err != nil {
		return err
	}
	target, err := a.safeTarget(ctx, id)
	if err != nil {
		return err
	}
	return a.service.RemoveContainer(ctx, target)
}

func (a *AgentFacade) safeTarget(ctx context.Context, id string) (string, error) {
	if len(id) != 64 {
		return "", shared.InvalidRequest("Agent 容器操作必须使用完整 ID")
	}
	if _, err := hex.DecodeString(id); err != nil {
		return "", shared.InvalidRequest("容器 ID 无效")
	}
	value, err := a.service.inspectContainerByID(ctx, id, actionTimeout)
	if err != nil {
		return "", err
	}
	r, ok := asRecord(value)
	if !ok {
		return "", errors.New("容器身份无效")
	}
	cfg, _ := asRecord(mustGet(r, "Config"))
	if cfg == nil {
		return "", errors.New("容器配置身份无效")
	}
	labels, _ := asRecord(mustGet(cfg, "Labels"))
	host, _ := asRecord(mustGet(r, "HostConfig"))
	if labels == nil || host == nil {
		return "", errors.New("容器权限身份无效")
	}
	user, _ := asString(mustGet(cfg, "User"))
	managed, _ := asString(mustGet(labels, labelManaged))
	if managed != labelTrueValue || user == "" || strings.Split(user, ":")[0] == "0" || strings.Split(user, ":")[0] == "root" || selfInspectCheck(value, a.service.deps.selfContainerID) {
		return "", shared.InvalidRequest("Agent 只操作已纳管的非 root 安全容器")
	}
	if mustGet(labels, "elysian.agent.template") != "restricted-v1" || mustGet(host, "ReadonlyRootfs") != true || mustGet(host, "NetworkMode") != "none" {
		return "", shared.InvalidRequest("Agent 仅操作固定安全模板容器")
	}
	if !hasAgentOption(mustGet(host, "CapDrop"), "ALL") || !hasAgentOption(mustGet(host, "SecurityOpt"), "no-new-privileges:true") {
		return "", shared.InvalidRequest("Agent 容器缺少强制权限隔离")
	}
	for _, key := range []string{"elysian.database", "elysian.website", "elysian.agent.execution"} {
		if mustGet(labels, key) == "true" {
			return "", shared.InvalidRequest("该容器必须通过所属领域操作")
		}
	}
	if mustGet(host, "Privileged") == true {
		return "", shared.InvalidRequest("Agent 不操作特权容器")
	}
	for _, key := range []string{"NetworkMode", "PidMode", "IpcMode", "UTSMode", "CgroupnsMode", "UsernsMode"} {
		if mustGet(host, key) == "host" {
			return "", shared.InvalidRequest("Agent 不操作共享宿主命名空间的容器")
		}
	}
	for _, key := range []string{"Devices", "DeviceRequests", "CapAdd"} {
		if rows, ok := mustGet(host, key).([]any); ok && len(rows) > 0 {
			return "", shared.InvalidRequest("Agent 不操作额外设备或权限容器")
		}
	}
	if mounts, ok := mustGet(r, "Mounts").([]any); ok {
		if len(mounts) != 0 {
			return "", shared.InvalidRequest("通用容器工具不操作任何持久挂载")
		}
	}
	return requireID(value, "容器")
}

// CreateRestricted starts an installed digest image with one fixed safe template.
func (a *AgentFacade) CreateRestricted(ctx context.Context, input AgentCreateInput) (contract.Container, error) {
	if err := a.check(ctx); err != nil {
		return contract.Container{}, err
	}
	if !namePattern.MatchString(input.Name) || !containerIDPattern.MatchString(input.RequestID) || !agentDigestImage.MatchString(input.Image) {
		return contract.Container{}, shared.InvalidRequest("安全模板需要固定名称、镜像摘要和请求标识")
	}
	raw, _ := json.Marshal(input)
	digest := sha256.Sum256(raw)
	want := hex.EncodeToString(digest[:])
	s := a.service
	s.createMu.Lock()
	defer s.createMu.Unlock()
	// A retry can only adopt the exact previously accepted creation.
	status, existing, err := s.engineJSON(ctx, http.MethodGet, "/containers/"+url.PathEscape(input.Name)+"/json", nil, nil, actionTimeout)
	if err != nil {
		return contract.Container{}, err
	}
	if status == http.StatusOK {
		r, _ := asRecord(existing)
		if r == nil {
			return contract.Container{}, errors.New("容器创建回执格式无效")
		}
		cfg, _ := asRecord(mustGet(r, "Config"))
		if cfg == nil {
			return contract.Container{}, errors.New("容器创建回执格式无效")
		}
		labels, _ := asRecord(mustGet(cfg, "Labels"))
		if labels == nil {
			return contract.Container{}, shared.InvalidRequest("容器名称已被其他请求使用")
		}
		if mustGet(labels, "elysian.agent.create-digest") != want {
			return contract.Container{}, shared.InvalidRequest("容器名称已被其他请求使用")
		}
		id, err := requireID(existing, "容器")
		if err != nil {
			return contract.Container{}, err
		}
		if _, err = a.safeTarget(ctx, id); err != nil {
			return contract.Container{}, err
		}
		return mapContainer(existing)
	}
	if status != http.StatusNotFound {
		return contract.Container{}, errors.New("查询容器名称占用失败")
	}
	imageStatus, image, err := s.engineJSON(ctx, http.MethodGet, "/images/"+url.PathEscape(input.Image)+"/json", nil, nil, actionTimeout)
	if err != nil || imageStatus != http.StatusOK {
		return contract.Container{}, shared.InvalidRequest("安全模板只使用本机已存在的固定摘要镜像")
	}
	im, _ := asRecord(image)
	if im == nil {
		return contract.Container{}, errors.New("镜像配置格式无效")
	}
	cfg, _ := asRecord(mustGet(im, "Config"))
	if cfg == nil {
		return contract.Container{}, errors.New("镜像配置格式无效")
	}
	volumes, _ := asRecord(mustGet(cfg, "Volumes"))
	if volumes != nil && len(volumes.orderedKeys()) != 0 {
		return contract.Container{}, shared.InvalidRequest("安全模板不允许镜像声明匿名卷")
	}
	body, _ := json.Marshal(map[string]any{"Image": input.Image, "User": "65532:65532", "Healthcheck": map[string]any{"Test": []string{"NONE"}}, "Labels": map[string]string{labelManaged: labelTrueValue, "elysian.agent.template": "restricted-v1", "elysian.agent.create-digest": want}, "HostConfig": map[string]any{"NetworkMode": "none", "ReadonlyRootfs": true, "CapDrop": []string{"ALL"}, "SecurityOpt": []string{"no-new-privileges:true"}, "PidsLimit": 128, "Memory": 512 << 20, "NanoCpus": 1000000000, "Tmpfs": map[string]string{"/tmp": "rw,nosuid,nodev,noexec,size=64m,mode=1777"}, "RestartPolicy": map[string]string{"Name": "no"}}})
	status, value, err := s.engineJSON(ctx, http.MethodPost, "/containers/create", url.Values{"name": {input.Name}}, body, actionTimeout)
	if err != nil {
		return contract.Container{}, err
	}
	if status != http.StatusCreated {
		return contract.Container{}, errors.New("安全模板创建失败")
	}
	id, err := requireCreateID(value)
	if err != nil {
		return contract.Container{}, err
	}
	return s.Action(ctx, id, "start")
}

func hasAgentOption(value any, want string) bool {
	rows, ok := value.([]any)
	if !ok {
		return false
	}
	for _, row := range rows {
		if row == want {
			return true
		}
	}
	return false
}
