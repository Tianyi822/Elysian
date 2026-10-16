package database

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"elysian/server/internal/contract"
	"elysian/server/internal/seam"
	"elysian/server/internal/shared"
)

// 服务型数据库业务服务（databaseService.ts 等价物）：list/discover/create/reveal/
// remove/removeContainer/reconcile/forget/openSession 与创建请求校验。

// createRequest 校验后的创建请求。
type createRequest struct {
	Engine      string
	VersionTag  string
	Name        string
	Charset     *string
	User        databaseSecret
	AccessScope string
	HostPort    *int
	Target      createTarget
}

// createTarget 三种目标形态。
type createTarget struct {
	Kind          string // new | managed | adopt
	ImageID       string
	ContainerName string
	ContainerID   string
	Admin         *databaseSecret
}

// createResponse 创建结果：实例 + 任意主机访问端口的防火墙事实。
type createResponse struct {
	Instance     serviceInstance            `json:"instance"`
	FirewallPort *contract.FirewallPortSync `json:"firewallPort"`
}

// Service 服务型数据库操作集。
type Service interface {
	List(ctx context.Context) ([]serviceInstance, error)
	Discover(ctx context.Context, engine string, versionTag *string) (discoverResult, error)
	Create(ctx context.Context, input createRequest) (createResponse, error)
	Reveal(ctx context.Context, id string) (databaseSecret, error)
	Remove(ctx context.Context, id string) error
	RemoveContainer(ctx context.Context, id string) error
	Reconcile(ctx context.Context, id string) (serviceInstance, error)
	Forget(ctx context.Context, id string) error
	OpenSession(ctx context.Context, id string) (Session, error)
}

// dockerBackend Docker Engine 适配接口（生产实现 dockeradapter.go 的 dockerAPI）。
type dockerBackend interface {
	inspect(ctx context.Context, id string) (map[string]any, error)
	assertEngine(ctx context.Context, id, engine, versionTag string) (map[string]any, error)
	address(ctx context.Context, id, network string) (databaseAddress, error)
	attach(ctx context.Context, id, network string) error
	detach(ctx context.Context, id, network string) error
	create(ctx context.Context, input createInput) (createResult, error)
	removeManaged(ctx context.Context, containerID, volumeName, engine, versionTag string) error
	memory(ctx context.Context, id string) (*memoryView, error)
}

// protocolBackend 数据库协议适配接口（生产实现 protocol.go 的 protocolAPI）。
type protocolBackend interface {
	version(ctx context.Context, engine string, addr databaseAddress, credential databaseSecret) (string, error)
	create(ctx context.Context, record databaseRecord, addr databaseAddress, charset string) error
	verify(ctx context.Context, record databaseRecord, addr databaseAddress) error
	drop(ctx context.Context, record databaseRecord, addr databaseAddress) error
	hasOtherDatabases(ctx context.Context, record databaseRecord, addr databaseAddress) (bool, error)
	metrics(ctx context.Context, record databaseRecord, addr databaseAddress) (databaseMetrics, error)
	session(record databaseRecord, addr databaseAddress) (Session, error)
}

// serviceDeps 服务依赖注入。
type serviceDeps struct {
	registry        databaseRegistry
	docker          dockerBackend
	protocol        protocolBackend
	listImages      func(ctx context.Context) ([]contract.ContainerImage, error)
	listContainers  func(ctx context.Context) ([]contract.Container, error)
	selfContainerID string
	portOpener      seam.PortOpener // 可为 nil：恒 skipped
	now             func() time.Time
}

// databaseService 服务实现。
type databaseService struct {
	mutationMu sync.Mutex
	deps       serviceDeps
	mu         sync.Mutex
	inProgress map[string]bool
}

// newDatabaseService 构造服务。
func newDatabaseService(deps serviceDeps) *databaseService {
	if deps.now == nil {
		deps.now = time.Now
	}
	return &databaseService{deps: deps, inProgress: map[string]bool{}}
}

// isoNow 以 TS toISOString 的毫秒精度形态输出时刻。
func isoNow(now func() time.Time) string {
	return now().UTC().Format("2006-01-02T15:04:05.000Z")
}

// randomAdminPassword 生成 32 字节 base64url 管理员密码。
func randomAdminPassword() string {
	buffer := make([]byte, 32)
	if _, err := rand.Read(buffer); err != nil {
		panic(fmt.Sprintf("无法生成管理员密码：%v", err))
	}
	return base64.RawURLEncoding.EncodeToString(buffer)
}

// validSecret 校验账号形态；密码长度按 TS string.length 的码元数近似（rune 数）。
func validSecret(value any, minimumPasswordLength int) (databaseSecret, bool) {
	secret := obj(value)
	username, ok := secret["username"].(string)
	if !ok || !sqlNamePattern.MatchString(username) {
		return databaseSecret{}, false
	}
	password, ok := secret["password"].(string)
	if !ok {
		return databaseSecret{}, false
	}
	length := utf8.RuneCountInString(password)
	if length < minimumPasswordLength || length > 256 {
		return databaseSecret{}, false
	}
	return databaseSecret{Username: username, Password: password}, true
}

// jsonInteger 取 JSON 数值的整数形态（对齐 TS Number.isInteger）。
func jsonInteger(value any) (int, bool) {
	number, ok := value.(float64)
	if !ok || number != float64(int64(number)) {
		return 0, false
	}
	return int(number), true
}

// validateCreateRequest 创建请求校验（错误次序与文案逐字对齐 TS 版）。
func validateCreateRequest(input any) (createRequest, error) {
	row := obj(input)
	engine, _ := row["engine"].(string)
	if engine != engineMySQL && engine != engineMariaDB && engine != engineRedis {
		return createRequest{}, shared.InvalidRequest("数据库引擎不受支持")
	}
	versionTag, ok := row["versionTag"].(string)
	if !ok || !validDatabaseVersion(versionTag) {
		return createRequest{}, shared.InvalidRequest("必须指定明确的数据库版本标签")
	}
	name, ok := row["name"].(string)
	if !ok || (engine == engineRedis && name != "0") || (engine != engineRedis && !sqlNamePattern.MatchString(name)) {
		return createRequest{}, shared.InvalidRequest("数据库名无效")
	}
	target := obj(row["target"])
	kind, _ := target["kind"].(string)
	minimumPasswordLength := 1
	if kind == "new" {
		minimumPasswordLength = 12
	}
	user, ok := validSecret(row["user"], minimumPasswordLength)
	if !ok {
		return createRequest{}, shared.InvalidRequest("普通账号或密码无效")
	}
	reservedName := "root"
	if engine == engineRedis {
		reservedName = "default"
	}
	if user.Username == reservedName {
		return createRequest{}, shared.InvalidRequest("普通账号不得使用管理员账号名")
	}
	accessScope, _ := row["accessScope"].(string)
	if accessScope != scopeLocalhost && accessScope != scopeContainerNet && accessScope != scopeAnyHost {
		return createRequest{}, shared.InvalidRequest("访问范围无效")
	}
	request := createRequest{Engine: engine, VersionTag: versionTag, Name: name, User: user, AccessScope: accessScope}
	switch kind {
	case "new":
		imageID, imageOK := target["imageId"].(string)
		containerName, nameOK := target["containerName"].(string)
		if !imageOK || !nameOK {
			return createRequest{}, shared.InvalidRequest("创建容器参数无效")
		}
		request.Target = createTarget{Kind: kind, ImageID: imageID, ContainerName: containerName}
		if accessScope == scopeAnyHost {
			hostPort, portOK := jsonInteger(row["hostPort"])
			if !portOK || hostPort < 1 || hostPort > 65535 {
				return createRequest{}, shared.InvalidRequest("任意主机访问必须指定宿主端口")
			}
			request.HostPort = &hostPort
			confirmed, _ := row["confirmPublic"].(bool)
			if !confirmed {
				return createRequest{}, shared.InvalidRequest("任意主机访问必须再次确认")
			}
		}
	case "managed", "adopt":
		containerID, idOK := target["containerId"].(string)
		if !idOK {
			return createRequest{}, shared.InvalidRequest("接管容器参数或管理员账号无效")
		}
		request.Target = createTarget{Kind: kind, ContainerID: containerID}
		if kind == "adopt" {
			admin, adminOK := validSecret(target["admin"], 1)
			if !adminOK {
				return createRequest{}, shared.InvalidRequest("接管容器参数或管理员账号无效")
			}
			request.Target.Admin = &admin
		}
	default:
		return createRequest{}, shared.InvalidRequest("必须指定新建或接管容器")
	}
	if engine != engineRedis {
		if charsetValue, exists := row["charset"]; exists {
			charset := asString(charsetValue)
			if !sqlCharsets[charset] {
				return createRequest{}, shared.InvalidRequest("字符集无效")
			}
			request.Charset = &charset
		}
	}
	return request, nil
}

// actualVersionMatches 实际版本须等于 tag 或以 tag./tag- 前缀延伸。
func actualVersionMatches(tag, version string) bool {
	return version == tag || strings.HasPrefix(version, tag+".") || strings.HasPrefix(version, tag+"-")
}

// accessScopeFromInspect 由 PortBindings 的 HostIp 推导实际访问范围。
func accessScopeFromInspect(info map[string]any, engine string) string {
	bindings := obj(field(obj(field(info, "HostConfig")), "PortBindings"))
	mapping, ok := field(bindings, fmt.Sprintf("%d/tcp", databasePort(engine))).([]any)
	if !ok || len(mapping) == 0 {
		return scopeContainerNet
	}
	hostIP, _ := field(obj(mapping[0]), "HostIp").(string)
	switch hostIP {
	case "0.0.0.0", "::", "":
		return scopeAnyHost
	case "127.0.0.1", "::1":
		return scopeLocalhost
	default:
		return scopeContainerNet
	}
}

// record 取登记行；不存在 404。
func (s *databaseService) record(id string) (databaseRecord, error) {
	rows, err := s.deps.registry.list()
	if err != nil {
		return databaseRecord{}, err
	}
	for _, row := range rows {
		if row.ID == id {
			return row, nil
		}
	}
	return databaseRecord{}, &shared.InvalidRequestError{Status: 404, Message: "数据库不存在"}
}

// address 取连接地址（引擎核对 + 网络地址 + 服务端口）。
func (s *databaseService) address(ctx context.Context, row databaseRecord) (databaseAddress, error) {
	if _, err := s.deps.docker.assertEngine(ctx, row.ContainerID, row.Engine, row.VersionTag); err != nil {
		return databaseAddress{}, err
	}
	result, err := s.deps.docker.address(ctx, row.ContainerID, "")
	if err != nil {
		return databaseAddress{}, err
	}
	result.Port = databasePort(row.Engine)
	return result, nil
}

// checked 完整核对：地址、版本一致性与授权形态。
func (s *databaseService) checked(ctx context.Context, row databaseRecord) (databaseAddress, string, error) {
	endpoint, err := s.address(ctx, row)
	if err != nil {
		return databaseAddress{}, "", err
	}
	version, err := s.deps.protocol.version(ctx, row.Engine, endpoint, row.Admin)
	if err != nil {
		return databaseAddress{}, "", err
	}
	if !actualVersionMatches(row.VersionTag, version) {
		return databaseAddress{}, "", &shared.InvalidRequestError{Status: 409, Message: "数据库实际版本与登记版本不一致"}
	}
	if err := s.deps.protocol.verify(ctx, row, endpoint); err != nil {
		return databaseAddress{}, "", err
	}
	return endpoint, version, nil
}

// projection 登记行 → 视图投影；核对失败降级 stopped + metricsError。
func (s *databaseService) projection(ctx context.Context, row databaseRecord) (serviceInstance, error) {
	if row.State == stateEmpty {
		status := statusWarning
		if _, err := s.deps.docker.assertEngine(ctx, row.ContainerID, row.Engine, row.VersionTag); err != nil {
			status = statusStopped
		}
		hasCredentials := false
		return serviceInstance{
			ID: row.ID, Engine: row.Engine, Name: fmt.Sprintf("空容器（原 %s）", row.Name), Version: row.VersionTag,
			Status: status, ContainerID: row.ContainerID, Source: sourceManaged, VersionTag: row.VersionTag,
			AccessScope: row.AccessScope, VolumeName: row.VolumeName,
			HasCredentials: &hasCredentials, EmptyContainer: true,
			MetricsError: "逻辑库已删除；容器与持久卷仍保留，可在此容器新建库或显式删除容器及数据。",
			UpdatedAt:    row.CreatedAt,
		}, nil
	}
	status := statusRunning
	version := row.VersionTag
	var metricsError string
	var storage *storageView
	var memory *memoryView
	var connections *connectionsView
	endpoint, actual, err := s.checked(ctx, row)
	if err == nil {
		version = actual
		sample, sampleErr := s.deps.protocol.metrics(ctx, row, endpoint)
		if sampleErr != nil {
			err = sampleErr
		} else {
			if sample.SizeGb != nil {
				storage = &storageView{UsedGb: *sample.SizeGb, TotalGb: 0}
			}
			if sample.Connections != nil {
				connections = sample.Connections
			}
			mem, memErr := s.deps.docker.memory(ctx, row.ContainerID)
			if memErr != nil {
				err = memErr
			} else {
				memory = mem
			}
		}
	}
	if err != nil {
		status = statusStopped
		metricsError = err.Error()
	}
	if row.State == stateNeedsAttention {
		status = statusWarning
	}
	needsAttention := row.State == stateNeedsAttention
	return serviceInstance{
		ID: row.ID, Engine: row.Engine, Name: row.Name, Version: version, Status: status,
		ContainerID: row.ContainerID, Source: row.Source, VersionTag: row.VersionTag,
		AccessScope: row.AccessScope, VolumeName: row.VolumeName,
		CredentialUsername: row.User.Username, HasCredentials: boolPtr(true),
		Storage: storage, Memory: memory, Connections: connections,
		MetricsError: metricsError, UpdatedAt: row.CreatedAt, NeedsAttention: &needsAttention,
	}, nil
}

// boolPtr 取布尔指针。
func boolPtr(value bool) *bool { return &value }

// imageTagsOf 镜像在引擎与版本判据下的全部合法 tag。
func imageTagsOf(image contract.ContainerImage, engine string) []string {
	refs := append([]string{image.Name + ":" + image.Tag}, image.OtherTags...)
	var tags []string
	for _, ref := range refs {
		colon := strings.LastIndex(ref, ":")
		if colon <= 0 {
			continue
		}
		name, tag := ref[:colon], ref[colon+1:]
		if imageMatches(engine, name) && validDatabaseVersion(tag) {
			tags = append(tags, tag)
		}
	}
	return tags
}

// Discover 发现可用镜像与候选接管容器。
func (s *databaseService) Discover(ctx context.Context, engine string, versionTag *string) (discoverResult, error) {
	if versionTag != nil && !validDatabaseVersion(*versionTag) {
		return discoverResult{}, shared.InvalidRequest("必须指定明确版本")
	}
	allImages, err := s.deps.listImages(ctx)
	if err != nil {
		return discoverResult{}, err
	}
	var images []contract.ContainerImage
	for _, image := range allImages {
		if versionTag == nil {
			if len(imageTagsOf(image, engine)) > 0 {
				images = append(images, image)
			}
		} else if databaseImageHasTag(image, engine, *versionTag) {
			images = append(images, image)
		}
	}
	containers := []containerCandidate{}
	registered, err := s.deps.registry.list()
	if err != nil {
		return discoverResult{}, err
	}
	listed, err := s.deps.listContainers(ctx)
	if err != nil {
		return discoverResult{}, err
	}
	for _, container := range listed {
		if container.ID == s.deps.selfContainerID {
			continue
		}
		// 其他引擎或停止的容器不作为接管候选：单容器失败静默跳过。
		s.discoverCandidate(ctx, engine, versionTag, container.ID, container.Name, allImages, registered, &containers)
	}
	return discoverResult{Images: images, Containers: containers}, nil
}

// discoverCandidate 单个候选容器的入选判定；任何一步不匹配即返回。
func (s *databaseService) discoverCandidate(ctx context.Context, engine string, versionTag *string, id, name string, allImages []contract.ContainerImage, registered []databaseRecord, out *[]containerCandidate) {
	if engine == engineRedis {
		for _, row := range registered {
			if row.ContainerID == id && row.Engine == engineRedis {
				return
			}
		}
	}
	inspected, err := s.deps.docker.inspect(ctx, id)
	if err != nil {
		return
	}
	if !inspectRunning(inspected) {
		return
	}
	var managedRow *databaseRecord
	for i, row := range registered {
		if row.ContainerID == id && row.Source == sourceManaged && row.Engine == engine {
			managedRow = &registered[i]
			break
		}
	}
	ref := inspectImageRef(inspected)
	var refTag *string
	if colon := strings.LastIndex(ref, ":"); colon > 0 {
		if imageMatches(engine, ref[:colon]) && validDatabaseVersion(ref[colon+1:]) {
			tag := ref[colon+1:]
			refTag = &tag
		}
	}
	inspectImageID := stripSha256Prefix(asString(field(inspected, "Image")))
	unique := map[string]bool{}
	var tags []string
	for _, image := range allImages {
		if stripSha256Prefix(image.ID) != inspectImageID {
			continue
		}
		for _, tag := range imageTagsOf(image, engine) {
			if !unique[tag] {
				unique[tag] = true
				tags = append(tags, tag)
			}
		}
	}
	candidateTag := ""
	switch {
	case versionTag != nil:
		candidateTag = *versionTag
	case managedRow != nil:
		candidateTag = managedRow.VersionTag
	case refTag != nil:
		candidateTag = *refTag
	case len(tags) == 1:
		candidateTag = tags[0]
	}
	if candidateTag == "" || !validDatabaseVersion(candidateTag) {
		return
	}
	info, err := s.deps.docker.assertEngine(ctx, id, engine, candidateTag)
	if err != nil {
		return
	}
	managed := managedRow != nil
	*out = append(*out, containerCandidate{
		ID: id, Name: name, AccessScope: accessScopeFromInspect(info, engine),
		Managed: managed, VersionTag: candidateTag,
	})
}

// Create 创建或接管数据库（时序敏感：先落登记再做协议动作，失败保留待处理登记）。
func (s *databaseService) Create(ctx context.Context, input createRequest) (createResponse, error) {
	targetKey := input.Target.ContainerID
	if input.Target.Kind == "new" {
		targetKey = input.Target.ContainerName
	}
	key := input.Engine + ":" + input.Name + ":" + targetKey
	s.mu.Lock()
	if s.inProgress[key] {
		s.mu.Unlock()
		return createResponse{}, &shared.InvalidRequestError{Status: 409, Message: "相同数据库正在创建"}
	}
	s.inProgress[key] = true
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.inProgress, key)
		s.mu.Unlock()
	}()
	s.mutationMu.Lock()
	defer s.mutationMu.Unlock()

	return s.create(ctx, input)
}

func (s *databaseService) create(ctx context.Context, input createRequest) (createResponse, error) {
	rows, err := s.deps.registry.list()
	if err != nil {
		return createResponse{}, err
	}
	targetContainerID := ""
	if input.Target.Kind != "new" {
		targetContainerID = input.Target.ContainerID
	}
	if targetContainerID != "" {
		for _, row := range rows {
			if row.State != stateEmpty && row.Engine == input.Engine && row.Name == input.Name && row.ContainerID == targetContainerID {
				return createResponse{}, &shared.InvalidRequestError{Status: 409, Message: "数据库已登记"}
			}
		}
	}
	if input.Engine == engineRedis && targetContainerID != "" {
		for _, row := range rows {
			if row.ContainerID == targetContainerID {
				return createResponse{}, &shared.InvalidRequestError{Status: 409, Message: "Redis DB 0 已登记"}
			}
		}
	}
	if input.Target.Kind == "adopt" && input.Target.ContainerID == s.deps.selfContainerID {
		return createResponse{}, &shared.InvalidRequestError{Status: 403, Message: "不能接管面板自身容器"}
	}

	var containerID, volumeName string
	var admin databaseSecret
	started := true
	actualScope := input.AccessScope
	switch input.Target.Kind {
	case "new":
		adminUsername := "root"
		if input.Engine == engineRedis {
			adminUsername = "default"
		}
		admin = databaseSecret{Username: adminUsername, Password: randomAdminPassword()}
		created, err := s.deps.docker.create(ctx, createInput{
			engine: input.Engine, versionTag: input.VersionTag, imageID: input.Target.ImageID,
			containerName: input.Target.ContainerName, accessScope: input.AccessScope,
			hostPort: input.HostPort, bootstrapPwd: admin.Password, ordinaryUser: input.User,
		})
		if err != nil {
			return createResponse{}, err
		}
		containerID, volumeName, started = created.containerID, created.volumeName, created.started
	case "managed":
		var existing *databaseRecord
		for i, row := range rows {
			if row.ContainerID == targetContainerID && row.Source == sourceManaged {
				existing = &rows[i]
				break
			}
		}
		if existing == nil || existing.Engine != input.Engine || existing.VersionTag != input.VersionTag {
			return createResponse{}, &shared.InvalidRequestError{Status: 409, Message: "容器不是同版本的面板受管数据库"}
		}
		containerID = existing.ContainerID
		volumeName = existing.VolumeName
		admin = existing.Admin
		info, err := s.deps.docker.assertEngine(ctx, containerID, input.Engine, input.VersionTag)
		if err != nil {
			return createResponse{}, err
		}
		actualScope = accessScopeFromInspect(info, input.Engine)
	default: // adopt
		containerID = input.Target.ContainerID
		admin = *input.Target.Admin
		info, err := s.deps.docker.assertEngine(ctx, containerID, input.Engine, input.VersionTag)
		if err != nil {
			return createResponse{}, err
		}
		actualScope = accessScopeFromInspect(info, input.Engine)
		if err := s.deps.docker.attach(ctx, containerID, networkDBSharedName); err != nil {
			return createResponse{}, err
		}
	}
	source := sourceManaged
	if input.Target.Kind == "adopt" {
		source = sourceAdopted
	}
	row := databaseRecord{
		ID: newUUID(), Engine: input.Engine, Name: input.Name, VersionTag: input.VersionTag,
		ContainerID: containerID, VolumeName: volumeName, Source: source,
		AccessScope: actualScope, Admin: admin, User: input.User,
		CreatedAt: isoNow(s.deps.now), State: stateNeedsAttention,
	}
	// 容器已产生后先登记待处理状态，后续任何失败都能在页面找到恢复入口。
	if err := s.deps.registry.put(row); err != nil {
		return createResponse{}, err
	}
	instance, firewallPort, err := s.finalizeCreate(ctx, input, row, rows, containerID, started)
	if err != nil {
		return createResponse{}, fmt.Errorf("数据库创建未完成；容器 %s 已登记为待处理：%s", containerIDPrefix(containerID), errorReasonMessage(err))
	}
	return createResponse{Instance: instance, FirewallPort: firewallPort}, nil
}

// finalizeCreate 登记落盘后的建库、核对与收尾；任何失败上抛由调用方包装。
func (s *databaseService) finalizeCreate(ctx context.Context, input createRequest, row databaseRecord, rows []databaseRecord, containerID string, started bool) (serviceInstance, *contract.FirewallPortSync, error) {
	if !started {
		return serviceInstance{}, nil, errors.New("容器启动失败；可在容器页修复后重新核对")
	}
	var endpoint *databaseAddress
	var lastErr error
	for attempt := 0; attempt < 20; attempt++ {
		address, err := s.address(ctx, row)
		if err == nil {
			version, versionErr := s.deps.protocol.version(ctx, row.Engine, address, row.Admin)
			if versionErr != nil {
				err = versionErr
			} else if !actualVersionMatches(row.VersionTag, version) {
				err = &shared.InvalidRequestError{Status: 409, Message: "数据库实际版本与所选版本不一致"}
			} else {
				endpoint = &address
				break
			}
		}
		var invalid *shared.InvalidRequestError
		if errors.As(err, &invalid) && strings.Contains(invalid.Message, "版本") {
			return serviceInstance{}, nil, err
		}
		lastErr = err
		if attempt == 19 {
			break
		}
		select {
		case <-ctx.Done():
			return serviceInstance{}, nil, ctx.Err()
		case <-time.After(time.Second):
		}
	}
	if endpoint == nil {
		if lastErr != nil {
			return serviceInstance{}, nil, lastErr
		}
		return serviceInstance{}, nil, errors.New("数据库连接地址不可用")
	}
	if input.Target.Kind != "adopt" {
		charset := "utf8mb4"
		if input.Charset != nil {
			charset = *input.Charset
		}
		if err := s.deps.protocol.create(ctx, row, *endpoint, charset); err != nil {
			return serviceInstance{}, nil, err
		}
	}
	if err := s.deps.protocol.verify(ctx, row, *endpoint); err != nil {
		return serviceInstance{}, nil, err
	}
	row.State = stateActive
	if err := s.deps.registry.put(row); err != nil {
		return serviceInstance{}, nil, err
	}
	for _, old := range rows {
		if old.State == stateEmpty && old.ContainerID == row.ContainerID {
			if err := s.deps.registry.remove(old.ID); err != nil {
				return serviceInstance{}, nil, err
			}
		}
	}
	instance, err := s.projection(ctx, row)
	if err != nil {
		return serviceInstance{}, nil, err
	}
	var firewallPort *contract.FirewallPortSync
	if input.Target.Kind == "new" && input.AccessScope == scopeAnyHost && input.HostPort != nil {
		sync := s.openFirewallPort(ctx, *input.HostPort, fmt.Sprintf("Elysian 数据库 %s", input.Name))
		firewallPort = &sync
	}
	return instance, firewallPort, nil
}

// openFirewallPort 幂等开放任意主机访问端口；防火墙片不可用恒 skipped。
func (s *databaseService) openFirewallPort(ctx context.Context, port int, note string) contract.FirewallPortSync {
	if s.deps.portOpener == nil {
		detail := contract.FirewallPortSyncDetailSkipped
		return contract.FirewallPortSync{State: contract.FirewallPortSyncSkipped, Port: port, Detail: &detail}
	}
	return s.deps.portOpener.EnsurePortRule(ctx, port, note)
}

// containerIDPrefix 容器 ID 前 12 位。
func containerIDPrefix(id string) string {
	if len(id) > 12 {
		return id[:12]
	}
	return id
}

// errorReasonMessage 非错误抛值归因为「未知错误」。
func errorReasonMessage(err error) string {
	if err == nil {
		return "未知错误"
	}
	return err.Error()
}

// List 全部登记行的投影。
func (s *databaseService) List(ctx context.Context) ([]serviceInstance, error) {
	rows, err := s.deps.registry.list()
	if err != nil {
		return nil, err
	}
	instances := make([]serviceInstance, 0, len(rows))
	for _, row := range rows {
		instance, err := s.projection(ctx, row)
		if err != nil {
			return nil, err
		}
		instances = append(instances, instance)
	}
	return instances, nil
}

// Reveal 按需读取普通账号凭证（核对通过后）。
func (s *databaseService) Reveal(ctx context.Context, id string) (databaseSecret, error) {
	row, err := s.record(id)
	if err != nil {
		return databaseSecret{}, err
	}
	if row.State == stateEmpty {
		return databaseSecret{}, &shared.InvalidRequestError{Status: 409, Message: "空容器没有数据库普通账号"}
	}
	if _, _, err := s.checked(ctx, row); err != nil {
		return databaseSecret{}, err
	}
	return row.User, nil
}

// Remove 删除逻辑库 / 清空 Redis DB 0；容器已被外部删时清理登记。
func (s *databaseService) Remove(ctx context.Context, id string) error {
	s.mutationMu.Lock()
	defer s.mutationMu.Unlock()
	return s.remove(ctx, id)
}
func (s *databaseService) remove(ctx context.Context, id string) error {
	row, err := s.record(id)
	if err != nil {
		return err
	}
	if row.State == stateEmpty {
		return &shared.InvalidRequestError{Status: 409, Message: "逻辑库已删除；请使用容器及数据删除操作"}
	}
	endpoint, err := s.address(ctx, row)
	if err != nil {
		var invalid *shared.InvalidRequestError
		if !errors.As(err, &invalid) || invalid.Status != 404 {
			return err
		}
		// 容器已被外部删除（managed 或 adopted 同理）：逻辑库无从删除，登记只剩
		// 僵尸卡片。跳过 drop，参照 forget 先例保留幂等 detach 后直接清理登记。
		rows, listErr := s.deps.registry.list()
		if listErr != nil {
			return listErr
		}
		if row.Source == sourceAdopted {
			hasSibling := false
			for _, item := range rows {
				if item.ContainerID == row.ContainerID && item.ID != id {
					hasSibling = true
					break
				}
			}
			if !hasSibling {
				if err := s.deps.docker.detach(ctx, row.ContainerID, networkDBSharedName); err != nil {
					return err
				}
			}
		}
		return s.deps.registry.remove(id)
	}
	version, err := s.deps.protocol.version(ctx, row.Engine, endpoint, row.Admin)
	if err != nil {
		return err
	}
	if !actualVersionMatches(row.VersionTag, version) {
		return &shared.InvalidRequestError{Status: 409, Message: "数据库实际版本与登记版本不一致"}
	}
	if err := s.deps.protocol.drop(ctx, row, endpoint); err != nil {
		return err
	}
	if row.Engine == engineRedis {
		return nil
	}
	rows, err := s.deps.registry.list()
	if err != nil {
		return err
	}
	siblings := 0
	sameContainer := 0
	for _, item := range rows {
		if item.ContainerID != row.ContainerID || item.ID == id {
			continue
		}
		sameContainer++
		if item.State != stateEmpty {
			siblings++
		}
	}
	if row.Source == sourceManaged && siblings == 0 {
		row.State = stateEmpty
		return s.deps.registry.put(row)
	}
	// 接管的容器只在其上最后一个登记被移除时才撤出面板网络；
	// 同容器还有任何登记（含空容器登记）都不撤。
	if row.Source == sourceAdopted && sameContainer == 0 {
		if err := s.deps.docker.detach(ctx, row.ContainerID, networkDBSharedName); err != nil {
			return err
		}
	}
	return s.deps.registry.remove(id)
}

// RemoveContainer 删除面板创建的数据库容器与专属卷。
func (s *databaseService) RemoveContainer(ctx context.Context, id string) error {
	s.mutationMu.Lock()
	defer s.mutationMu.Unlock()
	return s.removeContainer(ctx, id)
}
func (s *databaseService) removeContainer(ctx context.Context, id string) error {
	row, err := s.record(id)
	if err != nil {
		return err
	}
	if row.Source != sourceManaged || row.VolumeName == "" {
		return &shared.InvalidRequestError{Status: 403, Message: "只能删除面板创建的数据库容器和专属卷"}
	}
	rows, err := s.deps.registry.list()
	if err != nil {
		return err
	}
	for _, item := range rows {
		if item.ContainerID == row.ContainerID && item.ID != id {
			return &shared.InvalidRequestError{Status: 409, Message: "容器中还有其他已登记数据库"}
		}
	}
	checkErr := func() error {
		endpoint, err := s.address(ctx, row)
		if err != nil {
			return err
		}
		version, err := s.deps.protocol.version(ctx, row.Engine, endpoint, row.Admin)
		if err != nil {
			return err
		}
		if !actualVersionMatches(row.VersionTag, version) {
			return &shared.InvalidRequestError{Status: 409, Message: "数据库实际版本与登记版本不一致"}
		}
		other, err := s.deps.protocol.hasOtherDatabases(ctx, row, endpoint)
		if err != nil {
			return err
		}
		if other {
			return &shared.InvalidRequestError{Status: 409, Message: "容器中还有其他数据库，不能删除容器和持久卷"}
		}
		return nil
	}
	if err := checkErr(); err != nil {
		// 容器已 404 时跳过核对继续，允许清理孤儿卷。
		var invalid *shared.InvalidRequestError
		if !errors.As(err, &invalid) || invalid.Status != 404 {
			return err
		}
	}
	// 外部删除容器或删除卷阶段失败后，允许再次提交以清理登记的专属孤儿卷。
	if err := s.deps.docker.removeManaged(ctx, row.ContainerID, row.VolumeName, row.Engine, row.VersionTag); err != nil {
		return err
	}
	return s.deps.registry.remove(id)
}

// OpenSession 打开数据库协议终端会话。
func (s *databaseService) OpenSession(ctx context.Context, id string) (Session, error) {
	row, err := s.record(id)
	if err != nil {
		return nil, err
	}
	if row.State == stateEmpty {
		return nil, &shared.InvalidRequestError{Status: 409, Message: "空容器没有可连接的逻辑库"}
	}
	endpoint, _, err := s.checked(ctx, row)
	if err != nil {
		return nil, err
	}
	return s.deps.protocol.session(row, endpoint)
}

// Reconcile 重新核对并激活登记。
func (s *databaseService) Reconcile(ctx context.Context, id string) (serviceInstance, error) {
	s.mutationMu.Lock()
	defer s.mutationMu.Unlock()
	return s.reconcile(ctx, id)
}
func (s *databaseService) reconcile(ctx context.Context, id string) (serviceInstance, error) {
	row, err := s.record(id)
	if err != nil {
		return serviceInstance{}, err
	}
	if row.State == stateEmpty {
		return serviceInstance{}, &shared.InvalidRequestError{Status: 409, Message: "空容器没有可核对的逻辑库"}
	}
	if _, _, err := s.checked(ctx, row); err != nil {
		return serviceInstance{}, err
	}
	row.State = stateActive
	if err := s.deps.registry.put(row); err != nil {
		return serviceInstance{}, err
	}
	return s.projection(ctx, row)
}

// Forget 移除接管失败的待处理登记。
func (s *databaseService) Forget(ctx context.Context, id string) error {
	s.mutationMu.Lock()
	defer s.mutationMu.Unlock()
	row, err := s.record(id)
	if err != nil {
		return err
	}
	if row.Source != sourceAdopted || row.State != stateNeedsAttention {
		return &shared.InvalidRequestError{Status: 409, Message: "只允许移除接管失败的待处理登记"}
	}
	// 撤销接管失败留下的网络副作用；容器已被外部删除时 detach 幂等返回，移除登记不被卡死。
	if err := s.deps.docker.detach(ctx, row.ContainerID, networkDBSharedName); err != nil {
		return err
	}
	return s.deps.registry.remove(id)
}
