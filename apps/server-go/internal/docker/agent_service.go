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
	"sort"
	"strconv"
	"strings"

	"elysian/server/internal/contract"
	"elysian/server/internal/shared"
)

const (
	agentNetworkName     = "elysian-agent-net"
	agentServiceTemplate = "service-v1"
	agentVolumePrefix    = "elysian-agent-"
)

// AgentServiceCreateInput 是 service-v1 服务容器的创建输入；凭据只传变量名，值由后端生成。
type AgentServiceCreateInput struct {
	Name         string   `json:"name"`
	Image        string   `json:"image"`
	RequestID    string   `json:"requestId"`
	ResourceTier string   `json:"resourceTier"` // small | medium | large
	NetworkScope string   `json:"networkScope"` // container-net | localhost | any-host
	Port         int      `json:"port"`
	HostPort     int      `json:"hostPort"`
	Credentials  []string `json:"credentials"`
	Env          []string `json:"env"`
	Volumes      []string `json:"volumes"`
}

// ContainerSummary 是服务容器回执的显式容器投影：不含环境变量值、启动命令与挂载内容。
type ContainerSummary struct {
	ID            string                     `json:"id"`
	Name          string                     `json:"name"`
	Status        string                     `json:"status"`
	ImageID       string                     `json:"imageId"`
	ImageRef      string                     `json:"imageRef,omitempty"`
	Ports         []contract.PortBindingView `json:"ports"`
	CreatedAt     string                     `json:"createdAt"`
	StartedAt     string                     `json:"startedAt,omitempty"`
	RestartPolicy string                     `json:"restartPolicy"`
}

func containerSummary(c contract.Container) ContainerSummary {
	return ContainerSummary{ID: c.ID, Name: c.Name, Status: c.Status, ImageID: c.ImageID, ImageRef: c.ImageRef, Ports: append([]contract.PortBindingView{}, c.Ports...), CreatedAt: c.CreatedAt, StartedAt: c.StartedAt, RestartPolicy: c.RestartPolicy}
}

var (
	agentCredentialName = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,63}$`)
	agentEnvEntry       = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,63}=`)
	agentVolumePath     = regexp.MustCompile(`^/[A-Za-z0-9._/-]{0,127}$`)
)

type agentResourceTier struct {
	Memory   int64
	NanoCpus int64
}

func agentServiceTier(tier string) (agentResourceTier, bool) {
	switch tier {
	case "small":
		return agentResourceTier{Memory: 512 << 20, NanoCpus: 500_000_000}, true
	case "medium":
		return agentResourceTier{Memory: 1 << 30, NanoCpus: 1_000_000_000}, true
	case "large":
		return agentResourceTier{Memory: 2 << 30, NanoCpus: 2_000_000_000}, true
	}
	return agentResourceTier{}, false
}

func serviceCreateDigest(input AgentServiceCreateInput) string {
	raw, _ := json.Marshal(input)
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:])
}

// validateServiceInput 收口全部参数校验；错误一律中文。
func (a *AgentFacade) validateServiceInput(input AgentServiceCreateInput) (agentResourceTier, error) {
	if !namePattern.MatchString(input.Name) || !containerIDPattern.MatchString(input.RequestID) || !agentDigestImage.MatchString(input.Image) {
		return agentResourceTier{}, shared.InvalidRequest("服务容器需要固定名称、镜像摘要和请求标识")
	}
	tier, ok := agentServiceTier(input.ResourceTier)
	if !ok {
		return agentResourceTier{}, shared.InvalidRequest("资源档位必须是 small、medium 或 large")
	}
	switch input.NetworkScope {
	case "container-net", "localhost", "any-host":
	default:
		return agentResourceTier{}, shared.InvalidRequest("网络档位必须是 container-net、localhost 或 any-host")
	}
	if input.NetworkScope != "container-net" && (input.Port < 1 || input.Port > 65535) {
		return agentResourceTier{}, shared.InvalidRequest("映射宿主端口的网络档必须声明 1-65535 的容器端口")
	}
	if input.NetworkScope == "any-host" {
		if input.HostPort < 1 || input.HostPort > 65535 {
			return agentResourceTier{}, shared.InvalidRequest("任意主机访问必须指定有效宿主端口")
		}
		for _, reserved := range a.service.deps.reservedPorts {
			if input.HostPort == reserved {
				return agentResourceTier{}, shared.InvalidRequest("宿主端口被面板保留")
			}
		}
	}
	seen := map[string]bool{}
	if len(input.Credentials) > 8 {
		return agentResourceTier{}, shared.InvalidRequest("凭据变量最多 8 项")
	}
	for _, name := range input.Credentials {
		if !agentCredentialName.MatchString(name) || seen[name] {
			return agentResourceTier{}, shared.InvalidRequest("凭据变量名必须是大写字母、数字与下划线且不重复")
		}
		seen[name] = true
	}
	if len(input.Env) > 16 {
		return agentResourceTier{}, shared.InvalidRequest("非凭据环境变量最多 16 项")
	}
	for _, entry := range input.Env {
		if !agentEnvEntry.MatchString(entry) || len(entry) > 512 {
			return agentResourceTier{}, shared.InvalidRequest("环境变量必须是 KEY=VALUE 且每项不超过 512 字节")
		}
		key := strings.SplitN(entry, "=", 2)[0]
		if seen[key] {
			return agentResourceTier{}, shared.InvalidRequest("环境变量键与凭据变量不得重复")
		}
		seen[key] = true
	}
	if len(input.Volumes) > 2 {
		return agentResourceTier{}, shared.InvalidRequest("持久卷挂载点最多 2 个")
	}
	for _, path := range input.Volumes {
		if !agentVolumePath.MatchString(path) || path == "/" {
			return agentResourceTier{}, shared.InvalidRequest("卷挂载点必须是容器内绝对路径")
		}
	}
	return tier, nil
}

// ensureAgentNetwork 幂等确保 Agent 专用共享网存在。
func (a *AgentFacade) ensureAgentNetwork(ctx context.Context) error {
	status, _, err := a.service.engineJSON(ctx, http.MethodGet, "/networks/"+agentNetworkName, nil, nil, actionTimeout)
	if err != nil {
		return err
	}
	if status != http.StatusNotFound {
		if status == http.StatusOK {
			return nil
		}
		return errors.New("查询 Agent 共享网络失败")
	}
	body, _ := json.Marshal(map[string]any{"Name": agentNetworkName, "Labels": map[string]string{"elysian.agent.network": "true"}})
	status, _, err = a.service.engineJSON(ctx, http.MethodPost, "/networks/create", nil, body, actionTimeout)
	if err != nil || (status != http.StatusCreated && status != http.StatusOK) {
		return errors.New("创建 Agent 共享网络失败")
	}
	return nil
}

// resolveAgentImage 按本机镜像清单解析固定摘要引用，返回可安全钉死的镜像 ID。
// Engine 对「名称:标签@sha256:摘要」组合引用按 RepoDigests 名字解析：镜像源拉取
// 后重打标签的镜像，RepoDigests 仍是源站命名，组合引用必然 404；因此核验与钉死
// 都走面板自己的清单投影（与受管数据库同口径），不请求组合引用。
func (a *AgentFacade) resolveAgentImage(ctx context.Context, ref string) (string, error) {
	digestIndex := strings.LastIndex(ref, "@")
	if digestIndex < 0 {
		return "", shared.InvalidRequest("服务容器镜像引用必须带 sha256 摘要")
	}
	digest := strings.TrimSpace(ref[digestIndex+1:])
	const digestPrefix = "sha256:"
	hexPart := strings.TrimPrefix(digest, digestPrefix)
	if !strings.HasPrefix(digest, digestPrefix) || len(hexPart) != 64 {
		return "", shared.InvalidRequest("服务容器镜像摘要必须是 sha256: 加 64 位十六进制")
	}
	if _, err := hex.DecodeString(hexPart); err != nil {
		return "", shared.InvalidRequest("服务容器镜像摘要必须是 sha256: 加 64 位十六进制")
	}
	name, tag := "", ""
	if refPart := strings.TrimSpace(ref[:digestIndex]); refPart != "" {
		parsed, err := parseImageReference(refPart)
		if err != nil {
			return "", shared.InvalidRequest("服务容器镜像引用无效：" + err.Error())
		}
		name, tag = parsed.name, parsed.tag
	}
	images, err := a.service.imagesFromList(ctx)
	if err != nil {
		return "", err
	}
	pinned := ""
	for _, image := range images {
		if !agentDigestMatches(image, hexPart) {
			continue
		}
		if name != "" && !agentRefHasTag(image, name, tag) {
			continue
		}
		if pinned != "" {
			return "", shared.InvalidRequest("本机存在多个匹配该摘要的镜像，无法唯一钉死")
		}
		pinned = "sha256:" + image.ID
	}
	if pinned == "" {
		return "", shared.InvalidRequest("服务容器只使用本机已存在的固定摘要镜像；请先用 docker_image_pull 拉取后重试")
	}
	return pinned, nil
}

// agentDigestMatches 摘要命中：清单投影的 Digest 是 RepoDigests 首项（可带源站
// 命名前缀）或无摘要镜像的短 ID 兜底；镜像 ID 本身亦可作为钉死依据。
func agentDigestMatches(image contract.ContainerImage, hexPart string) bool {
	digest := "sha256:" + hexPart
	return image.Digest == digest || strings.HasSuffix(image.Digest, "@"+digest) || image.ID == hexPart
}

// agentRefHasTag 名称:标签 是否命中镜像的任一 RepoTag（大小写不敏感）。
func agentRefHasTag(image contract.ContainerImage, name, tag string) bool {
	candidates := append([]string{image.Name + ":" + image.Tag}, image.OtherTags...)
	for _, candidate := range candidates {
		if strings.ToLower(candidate) == strings.ToLower(name+":"+tag) {
			return true
		}
	}
	return false
}

// CreateService 审批后用 service-v1 模板创建并启动服务容器；凭据后端生成、专属卷托管。
// 输入预检拒绝转未派发业务错误交回模型纠正；执行中失败原样上抛。
func (a *AgentFacade) CreateService(ctx context.Context, input AgentServiceCreateInput) (map[string]any, error) {
	value, err := a.createService(ctx, input)
	if err != nil {
		return nil, agentRejected(err)
	}
	return value, nil
}

func (a *AgentFacade) createService(ctx context.Context, input AgentServiceCreateInput) (map[string]any, error) {
	if err := a.check(ctx); err != nil {
		return nil, err
	}
	if a.credentials == nil {
		return nil, errors.New("服务容器凭据登记未装配")
	}
	tier, err := a.validateServiceInput(input)
	if err != nil {
		return nil, err
	}
	digest := serviceCreateDigest(input)
	s := a.service
	s.createMu.Lock()
	defer s.createMu.Unlock()
	// 重试只认领完全相同的既有创建。
	status, existing, err := s.engineJSON(ctx, http.MethodGet, "/containers/"+url.PathEscape(input.Name)+"/json", nil, nil, actionTimeout)
	if err != nil {
		return nil, err
	}
	if status == http.StatusOK {
		return a.adoptService(ctx, input, digest, existing)
	}
	if status != http.StatusNotFound {
		return nil, errors.New("查询容器名称占用失败")
	}
	imageID, err := a.resolveAgentImage(ctx, input.Image)
	if err != nil {
		return nil, err
	}
	// 凭据：按变量名逐项沿用同名既有登记（失败重试与 adopt 稳定），缺失的逐名补生成。
	record, err := a.credentials.find(input.Name)
	if err != nil {
		return nil, err
	}
	if record == nil {
		record = &agentServiceCredentialRecord{Name: input.Name, Credentials: map[string]string{}}
	}
	for _, name := range input.Credentials {
		if _, exists := record.Credentials[name]; !exists {
			record.Credentials[name] = generateAgentSecret()
		}
	}
	createdVolumes := []string{}
	for range input.Volumes {
		volumeName := agentVolumePrefix + strconv.Itoa(len(createdVolumes)) + "-" + input.RequestID
		body, _ := json.Marshal(map[string]any{"Name": volumeName, "Labels": map[string]string{labelManaged: labelTrueValue, "elysian.agent": "true"}})
		volumeStatus, _, volumeErr := s.engineJSON(ctx, http.MethodPost, "/volumes/create", nil, body, actionTimeout)
		if volumeErr != nil || (volumeStatus != http.StatusCreated && volumeStatus != http.StatusOK) {
			a.removeCreatedVolumes(ctx, createdVolumes)
			return nil, errors.New("创建服务持久卷失败")
		}
		createdVolumes = append(createdVolumes, volumeName)
	}
	if input.NetworkScope == "container-net" {
		if err := a.ensureAgentNetwork(ctx); err != nil {
			a.removeCreatedVolumes(ctx, createdVolumes)
			return nil, err
		}
	}
	env := append([]string(nil), input.Env...)
	for _, name := range input.Credentials {
		env = append(env, name+"="+record.Credentials[name])
	}
	portKey := strconv.Itoa(input.Port) + "/tcp"
	hostConfig := map[string]any{
		"RestartPolicy": map[string]string{"Name": "unless-stopped"},
		"PidsLimit":     256,
		"Memory":        tier.Memory,
		"NanoCpus":      tier.NanoCpus,
	}
	if len(createdVolumes) > 0 {
		mounts := []map[string]any{}
		for i, path := range input.Volumes {
			mounts = append(mounts, map[string]any{"Type": "volume", "Source": createdVolumes[i], "Target": path})
		}
		hostConfig["Mounts"] = mounts
	}
	spec := map[string]any{
		"Image": imageID,
		"Env":   env,
		"Labels": map[string]string{
			labelManaged:                  labelTrueValue,
			"elysian.agent.template":      agentServiceTemplate,
			"elysian.agent.create-digest": digest,
		},
		"HostConfig": hostConfig,
	}
	if input.NetworkScope != "container-net" {
		hostIP := "127.0.0.1"
		hostPort := ""
		if input.NetworkScope == "any-host" {
			hostIP = "0.0.0.0"
			hostPort = strconv.Itoa(input.HostPort)
		}
		hostConfig["PortBindings"] = map[string]any{portKey: []map[string]any{{"HostIp": hostIP, "HostPort": hostPort}}}
		spec["ExposedPorts"] = map[string]any{portKey: map[string]any{}}
	} else {
		spec["NetworkingConfig"] = map[string]any{"EndpointsConfig": map[string]any{agentNetworkName: map[string]any{}}}
	}
	body, _ := json.Marshal(spec)
	createStatus, value, err := s.engineJSON(ctx, http.MethodPost, "/containers/create", url.Values{"name": {input.Name}}, body, actionTimeout)
	if err != nil || createStatus != http.StatusCreated {
		a.removeCreatedVolumes(ctx, createdVolumes)
		if err != nil {
			return nil, err
		}
		return nil, errors.New("服务容器创建失败")
	}
	containerID, err := requireCreateID(value)
	if err != nil {
		a.removeCreatedVolumes(ctx, createdVolumes)
		return nil, err
	}
	if _, err := s.Action(ctx, containerID, "start"); err != nil {
		a.removeCreatedContainer(ctx, containerID)
		a.removeCreatedVolumes(ctx, createdVolumes)
		return nil, err
	}
	record.ContainerID = containerID
	record.VolumeNames = append([]string(nil), createdVolumes...)
	record.NetworkScope = input.NetworkScope
	record.HostPort = input.HostPort
	record.Port = input.Port
	record.ResourceTier = input.ResourceTier
	record.ContainerPath = append([]string(nil), input.Volumes...)
	record.CreatedAt = s.deps.now().UTC().Format("2006-01-02T15:04:05Z")
	if err := a.credentials.save(*record); err != nil {
		return nil, err
	}
	return a.serviceReceipt(ctx, input, containerID, record)
}

// adoptService 只认领 create-digest 与模板完全匹配的既有容器；凭据从登记回读，不重新生成。
func (a *AgentFacade) adoptService(ctx context.Context, input AgentServiceCreateInput, digest string, existing any) (map[string]any, error) {
	r, _ := asRecord(existing)
	if r == nil {
		return nil, errors.New("容器创建回执格式无效")
	}
	cfg, _ := asRecord(mustGet(r, "Config"))
	if cfg == nil {
		return nil, errors.New("容器创建回执格式无效")
	}
	labels, _ := asRecord(mustGet(cfg, "Labels"))
	if labels == nil || mustGet(labels, "elysian.agent.create-digest") != digest || mustGet(labels, "elysian.agent.template") != agentServiceTemplate {
		return nil, shared.InvalidRequest("容器名称已被其他请求使用")
	}
	id, err := requireID(existing, "容器")
	if err != nil {
		return nil, err
	}
	if _, err := a.safeTarget(ctx, id); err != nil {
		return nil, err
	}
	record, err := a.credentials.find(input.Name)
	if err != nil {
		return nil, err
	}
	if record == nil {
		return nil, errors.New("服务容器登记缺失，无法核对凭据")
	}
	return a.serviceReceipt(ctx, input, id, record)
}

// serviceReceipt 组装显式回执投影：不含凭据值、环境变量与启动命令。
func (a *AgentFacade) serviceReceipt(ctx context.Context, input AgentServiceCreateInput, containerID string, record *agentServiceCredentialRecord) (map[string]any, error) {
	value, err := a.service.inspectContainerByID(ctx, containerID, actionTimeout)
	if err != nil {
		return nil, err
	}
	container, err := mapContainer(value)
	if err != nil {
		return nil, err
	}
	names := append([]string(nil), input.Credentials...)
	sort.Strings(names)
	result := map[string]any{
		"container":    containerSummary(container),
		"credentials":  names,
		"volumes":      append([]string(nil), input.Volumes...),
		"networkScope": input.NetworkScope,
		"port":         input.Port,
		"hostPort":     input.HostPort,
		"resourceTier": input.ResourceTier,
	}
	if input.NetworkScope == "any-host" {
		sync := contract.FirewallPortSync{State: contract.FirewallPortSyncSkipped, Port: input.HostPort}
		if a.portOpener != nil {
			sync = a.portOpener.EnsurePortRule(ctx, input.HostPort, "Agent 服务容器 "+input.Name)
		}
		result["firewallPort"] = sync
	}
	return result, nil
}

// removeCreatedContainer 启动失败回滚：删除本次创建但未启动成功的容器（与
// RemoveContainer 同款 Engine 调用形态、容忍 404）；回滚失败不掩盖原始错误，
// 残留事实由重试路径的名占用检查与人工处理收敛。
func (a *AgentFacade) removeCreatedContainer(ctx context.Context, containerID string) {
	_, _, _ = a.service.engineJSON(ctx, http.MethodDelete, "/containers/"+encodeEngineID(containerID), nil, nil, actionTimeout)
}

// removeCreatedVolumes 失败回滚：仅删除本次创建的卷。
func (a *AgentFacade) removeCreatedVolumes(ctx context.Context, volumes []string) {
	for _, name := range volumes {
		_, _, _ = a.service.engineJSON(ctx, http.MethodDelete, "/volumes/"+url.PathEscape(name), nil, nil, actionTimeout)
	}
}
