package docker

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"path"
	"reflect"
	"slices"
	"strings"
	"time"

	"elysian/server/internal/contract"
	"elysian/server/internal/seam"
	"elysian/server/internal/shared"
)

type RecreateEnvChange struct {
	Key    string  `json:"key"`
	Value  *string `json:"value,omitempty"`
	Remove bool    `json:"remove,omitempty"`
}

type RecreateMount struct {
	Kind     string `json:"kind"`
	Source   string `json:"source"`
	Target   string `json:"target"`
	ReadOnly bool   `json:"readOnly"`
}

type RecreatePatch struct {
	ImageID string                      `json:"imageId,omitempty"`
	Ports   *[]contract.PortBindingView `json:"ports,omitempty"`
	Env     []RecreateEnvChange         `json:"env,omitempty"`
	Mounts  *[]RecreateMount            `json:"mounts,omitempty"`
}

type RecreateChange struct {
	Field  string `json:"field"`
	Before string `json:"before,omitempty"`
	After  string `json:"after,omitempty"`
}

type RecreatePreview struct {
	PlanID               string           `json:"planId"`
	Revision             string           `json:"revision"`
	ID                   string           `json:"id"`
	ExpiresAt            string           `json:"expiresAt"`
	Changes              []RecreateChange `json:"changes"`
	Running              bool             `json:"running"`
	WritableChanges      *int             `json:"writableChanges"`
	RetainedMountTargets []string         `json:"retainedMountTargets,omitempty"`
	HealthWaitSeconds    int              `json:"healthWaitSeconds,omitempty"`
}

type RecreateInput struct {
	ID        string `json:"id"`
	PlanID    string `json:"planId"`
	Revision  string `json:"revision"`
	RequestID string `json:"requestId"`
}

type recreatePlan struct {
	preview           RecreatePreview
	scope             string
	expires           time.Time
	patch             RecreatePatch
	sourceFingerprint [32]byte
	createFingerprint [32]byte
}

type RecreateConfig struct {
	Container        contract.Container      `json:"container"`
	Argv             []string                `json:"argv"`
	Mounts           []RecreateMount         `json:"mounts"`
	ComposeProject   string                  `json:"composeProject,omitempty"`
	ComposeService   string                  `json:"composeService,omitempty"`
	ComposeManaged   bool                    `json:"composeManaged,omitempty"`
	ComposeWorkspace string                  `json:"composeWorkspace,omitempty"`
	BlockedReason    string                  `json:"blockedReason,omitempty"`
	Latest           *ContainerOperationTask `json:"latest,omitempty"`
}

type recreateSource struct {
	raw                      map[string]json.RawMessage
	config                   map[string]json.RawMessage
	host                     map[string]json.RawMessage
	name, id, image, restart string
	restartBody              json.RawMessage
	running                  bool
	fingerprint              [32]byte
}

func recreateMap(raw json.RawMessage) map[string]json.RawMessage {
	var result map[string]json.RawMessage
	_ = json.Unmarshal(raw, &result)
	return result
}

func recreateString(raw json.RawMessage) string {
	var value string
	_ = json.Unmarshal(raw, &value)
	return value
}

func recreateSourceFrom(raw []byte) (recreateSource, error) {
	s := recreateSource{raw: recreateMap(raw)}
	s.config, s.host = recreateMap(s.raw["Config"]), recreateMap(s.raw["HostConfig"])
	s.id, s.image = recreateString(s.raw["Id"]), recreateString(s.raw["Image"])
	s.name = strings.TrimPrefix(recreateString(s.raw["Name"]), "/")
	state := recreateMap(s.raw["State"])
	s.running = string(state["Running"]) == "true"
	s.restartBody = s.host["RestartPolicy"]
	s.restart = recreateString(recreateMap(s.restartBody)["Name"])
	if s.restart == "" {
		s.restartBody = json.RawMessage(`{"Name":"no","MaximumRetryCount":0}`)
	}
	if s.config == nil || s.host == nil || s.name == "" || state == nil || s.image == "" {
		return s, shared.InvalidRequest("容器配置无法完整读取")
	}
	spec, err := json.Marshal([]any{s.id, s.image, s.name, s.config, s.host, s.raw["Mounts"], s.running, recreateString(state["Status"])})
	if err != nil {
		return s, err
	}
	s.fingerprint = sha256.Sum256(spec)
	return s, nil
}

func (a *AgentFacade) recreateSource(ctx context.Context, id string) (recreateSource, error) {
	if _, err := agentObjectID(id, false); err != nil {
		return recreateSource{}, err
	}
	response, err := a.service.deps.transport.Request(ctx, seam.EngineRequest{Method: http.MethodGet, Path: "/containers/" + id + "/json", Timeout: actionTimeout, MaxBytes: jsonMaxBytes})
	if err != nil || response.Status != http.StatusOK {
		return recreateSource{}, shared.InvalidRequest("无法读取容器配置")
	}
	source, err := recreateSourceFrom(response.Body)
	if err == nil && source.id != id {
		err = shared.InvalidRequest("容器详情与请求 ID 不匹配")
	}
	return source, err
}

func (a *AgentFacade) RecreateConfiguration(ctx context.Context, id string) (RecreateConfig, error) {
	source, err := a.recreateSource(ctx, id)
	if err != nil {
		return RecreateConfig{}, err
	}
	raw, _ := json.Marshal(source.raw)
	value, err := decodeOrderedJSON(raw)
	if err != nil {
		return RecreateConfig{}, err
	}
	container, err := mapContainerForWeb(value, a.service.deps.selfContainerID)
	if err != nil {
		return RecreateConfig{}, err
	}
	argv := []string{}
	if program := recreateString(source.raw["Path"]); program != "" {
		argv = append(argv, program)
		var args []string
		if json.Unmarshal(source.raw["Args"], &args) == nil {
			argv = append(argv, args...)
		}
	}
	labels := recreateMap(source.config["Labels"])
	result := RecreateConfig{
		Container: container, Argv: argv, Mounts: recreateMounts(source),
		ComposeProject: recreateString(labels["com.docker.compose.project"]),
		ComposeService: recreateString(labels["com.docker.compose.service"]),
		ComposeManaged: recreateCompose(labels),
	}
	if result.ComposeManaged {
		root := path.Join(a.service.deps.mountRoot, "elysian", "apps")
		dir := path.Clean(recreateString(labels["com.docker.compose.project.working_dir"]))
		if slug, ok := strings.CutPrefix(dir, root+"/"); ok {
			slug, _, _ = strings.Cut(slug, "/")
			if containerIDPattern.MatchString(slug) {
				result.ComposeWorkspace = slug
			}
		}
	}
	result.BlockedReason = a.recreateBlock(source, value)
	a.operationMu.Lock()
	defer a.operationMu.Unlock()
	if a.loadContainerOperations() == nil {
		for _, task := range a.operations {
			if task.Recreate == nil || (task.Target != id && task.Recreate.CandidateID != id) {
				continue
			}
			if result.Latest == nil || task.UpdatedAt > result.Latest.UpdatedAt {
				summary := RecreateTaskStatus(AgentOperationReceipt(task))
				result.Latest = &summary
			}
		}
	}
	if result.Latest != nil && result.Latest.Recreate.BackupName == source.name {
		result.BlockedReason = "该容器是停用的恢复副本"
	}
	return result, nil
}

func recreateCompose(labels map[string]json.RawMessage) bool {
	// Compose-built images also carry project/service labels. Only runtime
	// membership labels prove that Compose created this container.
	for _, key := range []string{"config-hash", "container-number", "project.working_dir", "project.config_files", "oneoff"} {
		if recreateString(labels["com.docker.compose."+key]) != "" {
			return true
		}
	}
	return false
}

func (a *AgentFacade) recreateBlock(s recreateSource, value any) string {
	if a.PanelRuntime() == "unknown" {
		return "面板自身容器身份未确认"
	}
	labels := recreateMap(s.config["Labels"])
	if recreateCompose(labels) {
		return "该容器由 Compose 管理，请修改所属项目配置后重新部署"
	}
	for key := range labels {
		if strings.HasPrefix(key, "com.docker.swarm.") || strings.HasPrefix(key, "io.kubernetes.") {
			return "该容器由编排系统管理，请在所属系统修改配置"
		}
	}
	switch classifyAgentTarget(value, a.service.deps.selfContainerID) {
	case targetDatabase:
		return "请在数据库管理中维护受管容器"
	case targetWebsite:
		return "请在网站管理中维护受管容器"
	case targetTemplate:
		return "该容器由 Agent 模板维护"
	case targetPanel, targetUser:
	default:
		return "面板自身和内部容器不可重建"
	}
	if string(s.host["AutoRemove"]) == "true" {
		return "自动删除容器无法保留为恢复副本"
	}
	state := recreateString(recreateMap(s.raw["State"])["Status"])
	if state != "running" && state != "created" && state != "exited" {
		return "容器须处于运行或已停止状态"
	}
	if strings.HasPrefix(recreateString(s.host["NetworkMode"]), "container:") {
		return "无法安全复制共享容器网络命名空间"
	}
	for _, field := range []string{"Links", "VolumesFrom", "ContainerIDFile"} {
		if recreateNonzero(s.host[field]) {
			return "无法安全复现容器配置字段 " + field
		}
	}
	for _, raw := range recreateMap(recreateMap(s.raw["NetworkSettings"])["Networks"]) {
		if recreateNonzero(recreateMap(raw)["IPAMConfig"]) {
			return "使用固定网络地址的容器须在原部署入口维护"
		}
	}
	return ""
}

func recreateMounts(source recreateSource) []RecreateMount {
	var rows []map[string]json.RawMessage
	_ = json.Unmarshal(source.raw["Mounts"], &rows)
	mounts := make([]RecreateMount, 0, len(rows))
	for _, row := range rows {
		item := RecreateMount{Kind: recreateString(row["Type"]), Source: recreateString(row["Source"]), Target: recreateString(row["Destination"]), ReadOnly: string(row["RW"]) == "false"}
		if item.Kind == "volume" {
			item.Source = recreateString(row["Name"])
		}
		mounts = append(mounts, item)
	}
	return mounts
}

func recreateNonzero(raw json.RawMessage) bool {
	switch string(raw) {
	case "", "null", "false", "0", `""`, "[]", "{}":
		return false
	}
	return true
}

func (a *AgentFacade) prepareRecreate(ctx context.Context, id string, patch RecreatePatch, allowSensitive bool) (recreateSource, map[string]any, []RecreateChange, error) {
	source, err := a.recreateSource(ctx, id)
	if err != nil {
		return source, nil, nil, err
	}
	raw, _ := json.Marshal(source.raw)
	value, err := decodeOrderedJSON(raw)
	if err != nil {
		return source, nil, nil, err
	}
	if reason := a.recreateBlock(source, value); reason != "" {
		return source, nil, nil, shared.InvalidRequest(reason)
	}
	body, changes, err := a.buildRecreate(ctx, source, patch, allowSensitive)
	return source, body, changes, err
}

func (a *AgentFacade) previewRecreate(ctx context.Context, id string, patch RecreatePatch, scope string, allowSensitive bool) (RecreatePreview, error) {
	source, body, changes, err := a.prepareRecreate(ctx, id, patch, allowSensitive)
	if err != nil {
		return RecreatePreview{}, err
	}
	token, err := randomRecreateToken()
	if err != nil {
		return RecreatePreview{}, err
	}
	revision, err := randomRecreateToken()
	if err != nil {
		return RecreatePreview{}, err
	}
	expires := time.Now().Add(15 * time.Minute)
	preview := RecreatePreview{PlanID: token, Revision: revision, ID: id, ExpiresAt: expires.UTC().Format(time.RFC3339), Changes: changes, Running: source.running}
	for _, m := range recreateMounts(source) {
		if patch.Mounts == nil || slices.Contains(*patch.Mounts, m) {
			preview.RetainedMountTargets = append(preview.RetainedMountTargets, m.Target)
		}
	}
	if source.running && recreateHealthcheckEnabled(source.config["Healthcheck"]) {
		preview.HealthWaitSeconds = int(recreateHealthWait / time.Second)
	}
	if status, data, readErr := a.service.engineJSON(ctx, http.MethodGet, "/containers/"+id+"/changes", nil, nil, actionTimeout); readErr == nil && status == http.StatusOK {
		if changes, ok := asArray(data); ok {
			count := len(changes)
			preview.WritableChanges = &count
		}
	}
	canonical, err := json.Marshal(body)
	if err != nil {
		return RecreatePreview{}, err
	}
	a.recreateMu.Lock()
	defer a.recreateMu.Unlock()
	if a.recreatePlans == nil {
		a.recreatePlans = make(map[string]recreatePlan)
	}
	for key, plan := range a.recreatePlans {
		if time.Now().After(plan.expires) {
			delete(a.recreatePlans, key)
		}
	}
	if len(a.recreatePlans) >= 64 {
		return RecreatePreview{}, shared.Conflict("待确认的重建预览过多，请稍后重试")
	}
	a.recreatePlans[token] = recreatePlan{preview: preview, scope: scope, expires: expires, patch: patch, sourceFingerprint: source.fingerprint, createFingerprint: sha256.Sum256(canonical)}
	time.AfterFunc(time.Until(expires), func() {
		a.recreateMu.Lock()
		delete(a.recreatePlans, token)
		a.recreateMu.Unlock()
	})
	return preview, nil
}

func randomRecreateToken() (string, error) {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

func (a *AgentFacade) RecreatePreviewForApproval(input RecreateInput, scope string) (RecreatePreview, bool) {
	a.recreateMu.Lock()
	defer a.recreateMu.Unlock()
	plan, ok := a.recreatePlans[input.PlanID]
	if !ok || plan.scope != scope || plan.preview.ID != input.ID || plan.preview.Revision != input.Revision || !time.Now().Before(plan.expires) {
		return RecreatePreview{}, false
	}
	return plan.preview, true
}

func (a *AgentFacade) buildRecreate(ctx context.Context, s recreateSource, p RecreatePatch, allowSensitive bool) (map[string]any, []RecreateChange, error) {
	body := make(map[string]any)
	for key, raw := range s.config {
		body[key] = raw
	}
	host := make(map[string]any)
	for key, raw := range s.host {
		host[key] = raw
	}
	delete(host, "ConsoleSize")
	body["HostConfig"] = host
	body["Image"] = s.image
	if recreateString(s.config["Hostname"]) == s.id[:12] {
		delete(body, "Hostname")
	}
	changes := []RecreateChange{}
	var env []string
	if raw := s.config["Env"]; recreateNonzero(raw) && json.Unmarshal(raw, &env) != nil {
		return nil, nil, errors.New("容器环境变量配置无法读取")
	}
	if len(p.Env) > 128 {
		return nil, nil, shared.InvalidRequest("环境变量改动超过上限")
	}
	keys := map[string]bool{}
	for _, change := range p.Env {
		if keys[change.Key] || !envKeyPattern.MatchString(change.Key) || change.Remove == (change.Value != nil) {
			return nil, nil, shared.InvalidRequest("环境变量改动无效或重复")
		}
		if !allowSensitive && isSensitiveEnvKey(change.Key) {
			return nil, nil, shared.InvalidRequest("敏感环境变量请在 Web 修改")
		}
		keys[change.Key] = true
		index := -1
		for i, line := range env {
			if key, _, _ := strings.Cut(line, "="); key == change.Key {
				if index >= 0 {
					return nil, nil, shared.InvalidRequest("原容器存在重复环境变量")
				}
				index = i
			}
		}
		if change.Remove {
			if index >= 0 {
				env[index] = change.Key
				changes = append(changes, RecreateChange{Field: "环境变量 " + change.Key, After: "删除"})
			}
			continue
		}
		if err := assertEnvValue(*change.Value); err != nil {
			return nil, nil, err
		}
		line := change.Key + "=" + *change.Value
		if index < 0 {
			env = append(env, line)
			changes = append(changes, RecreateChange{Field: "环境变量 " + change.Key, After: "新增"})
		} else if env[index] != line {
			env[index] = line
			changes = append(changes, RecreateChange{Field: "环境变量 " + change.Key, After: "修改"})
		}
	}
	if len(p.Env) > 0 {
		body["Env"] = env
	}
	if p.ImageID != "" {
		id, err := agentObjectID(p.ImageID, true)
		if err != nil {
			return nil, nil, err
		}
		image, err := a.service.inspectImageByID(ctx, id)
		if err != nil {
			return nil, nil, shared.InvalidRequest("所选镜像尚未安装，请先拉取")
		}
		identity, err := requireID(image, "镜像")
		if err != nil || stripSha256Prefix(identity) != id {
			return nil, nil, shared.InvalidRequest("镜像身份与选择不匹配")
		}
		if id != stripSha256Prefix(s.image) {
			body["Image"] = identity
			changes = append(changes, RecreateChange{Field: "镜像", Before: s.image, After: identity})
		}
	}
	if p.Ports != nil {
		if recreateString(s.host["NetworkMode"]) == "host" || recreateNonzero(s.host["PublishAllPorts"]) {
			return nil, nil, shared.InvalidRequest("当前网络设置无法修改端口映射")
		}
		portsRaw, _ := json.Marshal(p.Ports)
		v, err := decodeOrderedJSON(portsRaw)
		if err != nil {
			return nil, nil, err
		}
		ports, err := parsePorts(v)
		if err != nil {
			return nil, nil, err
		}
		bindings := map[string][]enginePortBindingEntry{}
		exposed := recreateMap(s.config["ExposedPorts"])
		if exposed == nil {
			exposed = make(map[string]json.RawMessage)
		}
		var old map[string][]enginePortBindingEntry
		_ = json.Unmarshal(s.host["PortBindings"], &old)
		for _, port := range ports {
			key := itoa(port.containerPort) + "/" + port.protocol
			exposed[key] = json.RawMessage(`{}`)
			bindings[key] = append(bindings[key], enginePortBindingEntry{HostPort: itoa(port.hostPort), HostIP: port.hostIP})
		}
		if !(len(old) == 0 && len(bindings) == 0) && !reflect.DeepEqual(old, bindings) {
			if err := a.checkRecreatePorts(ctx, s.id, ports); err != nil {
				return nil, nil, err
			}
			host["PortBindings"] = bindings
			body["ExposedPorts"] = exposed
			before, _ := json.Marshal(old)
			after, _ := json.Marshal(bindings)
			changes = append(changes, RecreateChange{Field: "端口映射", Before: string(before), After: string(after)})
		}
	}
	originalMounts := recreateMounts(s)
	mounts := originalMounts
	if p.Mounts != nil {
		mounts = *p.Mounts
	}
	if !reflect.DeepEqual(originalMounts, mounts) && p.Mounts != nil {
		before, _ := json.Marshal(originalMounts)
		after, _ := json.Marshal(mounts)
		changes = append(changes, RecreateChange{Field: "挂载", Before: string(before), After: string(after)})
	}
	if err := a.setRecreateMounts(ctx, s, host, originalMounts, mounts, p.Mounts != nil); err != nil {
		return nil, nil, err
	}
	endpoints := map[string]any{}
	for key, raw := range recreateMap(recreateMap(s.raw["NetworkSettings"])["Networks"]) {
		if key == "bridge" || key == "host" || key == "none" {
			continue
		}
		old := recreateMap(raw)
		endpoint := map[string]any{}
		for _, field := range []string{"Aliases", "DriverOpts"} {
			if recreateNonzero(old[field]) {
				endpoint[field] = old[field]
			}
		}
		endpoints[key] = endpoint
	}
	if len(endpoints) > 0 {
		body["NetworkingConfig"] = map[string]any{"EndpointsConfig": endpoints}
	}
	if len(changes) == 0 {
		return nil, nil, shared.InvalidRequest("配置没有变更")
	}
	return body, changes, nil
}

func (a *AgentFacade) checkRecreatePorts(ctx context.Context, id string, ports []portMappingInput) error {
	list, err := a.service.ListContainers(ctx)
	if err != nil {
		return shared.InvalidRequest("无法核实宿主机端口占用")
	}
	containers := make([]containerBrief, 0, len(list))
	for _, container := range list {
		if container.ID == id {
			continue
		}
		var brief containerBrief
		for _, entry := range container.Ports {
			brief.ports = append(brief.ports, portBrief{hostPort: entry.HostPort, hostIP: entry.HostIP, protocol: entry.Protocol})
		}
		containers = append(containers, brief)
	}
	for i, port := range ports {
		if err := assertPortAvailable(port, a.service.deps.reservedPorts, containers, ports[:i]); err != nil {
			return err
		}
	}
	return nil
}

func (a *AgentFacade) setRecreateMounts(ctx context.Context, s recreateSource, host map[string]any, original, mounts []RecreateMount, edited bool) error {
	if len(mounts) > 64 {
		return shared.InvalidRequest("挂载不能超过 64 项")
	}
	var configured []map[string]json.RawMessage
	_ = json.Unmarshal(s.host["Mounts"], &configured)
	if !edited {
		// Retain explicit mounts verbatim. Pin image-created anonymous volumes to their existing names.
		explicit := map[string]bool{}
		for _, item := range configured {
			explicit[recreateString(item["Target"])] = true
		}
		var binds []string
		_ = json.Unmarshal(s.host["Binds"], &binds)
		for _, bind := range binds {
			parts := strings.Split(bind, ":")
			if len(parts) > 1 {
				explicit[parts[1]] = true
			}
		}
		for _, m := range original {
			if m.Kind == "volume" && !explicit[m.Target] {
				if m.Source == "" {
					return shared.InvalidRequest("无法核实现有匿名卷身份")
				}
				mode := "rw"
				if m.ReadOnly {
					mode = "ro"
				}
				binds = append(binds, m.Source+":"+m.Target+":"+mode)
			}
		}
		if len(binds) > 0 {
			host["Binds"] = binds
		}
		return nil
	}
	if recreateNonzero(s.host["Tmpfs"]) {
		return shared.InvalidRequest("包含 tmpfs 的容器请在原部署入口修改挂载")
	}
	var binds []string
	_ = json.Unmarshal(s.host["Binds"], &binds)
	for _, bind := range binds {
		parts := strings.Split(bind, ":")
		if len(parts) > 3 || len(parts) == 3 && parts[2] != "ro" && parts[2] != "rw" {
			return shared.InvalidRequest("含特殊绑定选项的容器请在原入口修改挂载")
		}
	}
	for _, item := range configured {
		for _, field := range []string{"BindOptions", "VolumeOptions", "TmpfsOptions", "ClusterOptions", "ImageOptions", "Consistency"} {
			if recreateNonzero(item[field]) {
				return shared.InvalidRequest("含特殊挂载选项的容器请在原入口修改挂载")
			}
		}
	}
	targets := map[string]bool{}
	next := []map[string]any{}
	for _, m := range mounts {
		if !path.IsAbs(m.Target) || path.Clean(m.Target) != m.Target || m.Target == "/" || targets[m.Target] || strings.ContainsRune(m.Target, 0) {
			return shared.InvalidRequest("挂载目标须为不重复的容器绝对路径")
		}
		targets[m.Target] = true
		switch m.Kind {
		case "bind":
			preserved := false
			for _, prior := range original {
				if prior == m {
					preserved = true
					break
				}
			}
			if !preserved {
				resolved, dirs, err := resolveBindSource(m.Source, a.service.deps.mountRoot, a.service.deps.realpath)
				if err != nil || len(dirs) != 0 {
					return shared.InvalidRequest("绑定挂载须指向挂载根内的现有路径")
				}
				m.Source = resolved
			}
		case "volume":
			if !containerIDPattern.MatchString(m.Source) {
				return shared.InvalidRequest("卷名称无效")
			}
			status, _, err := a.service.engineJSON(ctx, http.MethodGet, "/volumes/"+url.PathEscape(m.Source), nil, nil, actionTimeout)
			if err != nil || status != http.StatusOK {
				return shared.InvalidRequest("挂载卷不存在或无法核实")
			}
		default:
			return shared.InvalidRequest("仅支持修改绑定挂载和已有 Docker 卷")
		}
		next = append(next, map[string]any{"Type": m.Kind, "Source": m.Source, "Target": m.Target, "ReadOnly": m.ReadOnly})
	}
	delete(host, "Binds")
	host["Mounts"] = next
	return nil
}
