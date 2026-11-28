package database

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"elysian/server/internal/contract"
	"elysian/server/internal/seam"
	"elysian/server/internal/shared"
)

// 数据库容器业务服务：列表投影、创建、核对、删容器与登记清理。
// 容器实例以 Docker 容器清单为事实源；databases.json 登记行按 containerId 聚合，
// 用于恢复容器归属、专属卷、管理员凭据和待清理登记。

// createRequest 校验后的创建请求（仅接受新建容器目标）。
type createRequest struct {
	Engine        string
	VersionTag    string
	ContainerName string
	ImageID       string
	AccessScope   string
	HostPort      *int
}

// createResponse 创建结果：实例 + 任意主机访问端口的防火墙事实。
type createResponse struct {
	Instance     containerInstance          `json:"instance"`
	FirewallPort *contract.FirewallPortSync `json:"firewallPort"`
}

// Service 数据库容器操作集。
type Service interface {
	List(ctx context.Context) ([]containerInstance, error)
	Create(ctx context.Context, input createRequest) (createResponse, error)
	Reveal(ctx context.Context, id string) (databaseSecret, error)
	RevealUser(ctx context.Context, id, database, username string) (databaseSecret, error)
	Adopt(ctx context.Context, containerID, username, password string) (containerInstance, error)
	ReleaseAdoption(ctx context.Context, containerID string) error
	RemoveContainer(ctx context.Context, id string) error
	Reconcile(ctx context.Context, id string) (containerInstance, error)
	Forget(ctx context.Context, id string) error
}

// dockerBackend Docker Engine 适配接口（生产实现 dockeradapter.go 的 dockerAPI）。
type dockerBackend interface {
	inspect(ctx context.Context, id string) (map[string]any, error)
	assertEngine(ctx context.Context, id, engine, versionTag string) (map[string]any, error)
	create(ctx context.Context, input createInput) (createResult, error)
	removeManaged(ctx context.Context, containerID, volumeName, engine, versionTag string) error
	// verifyRemoved 回读确认容器与卷都已消失；已消失返回 nil。
	verifyRemoved(ctx context.Context, containerID, volumeName string) error
	// assertHostPortFree 核对宿主 TCP 端口没有被运行中的容器占用。
	assertHostPortFree(ctx context.Context, port int) error
	memory(ctx context.Context, id string) (*memoryView, error)
}

// serviceDeps 服务依赖注入。
type serviceDeps struct {
	registry        databaseRegistry
	docker          dockerBackend
	listContainers  func(ctx context.Context) ([]contract.Container, error)
	listImages      func(ctx context.Context) ([]contract.ContainerImage, error)
	selfContainerID string
	portOpener      seam.PortOpener // 可为 nil：恒 skipped
	now             func() time.Time
	// hostCapacity 读取宿主容量（Agent 部署新建实例前核对）；nil 表示读数不可得。
	hostCapacity seam.HostCapacity
	// admin 是实例内管理操作的执行面（就绪等待、建库建用户）；nil 表示未装配。
	admin adminBackend
	// reservedPorts 是面板保留的宿主端口，Agent 部署 any-host 实例时在受理前核对。
	reservedPorts []int
	// provisionMutation keeps the target reserved until the change and its readback finish.
	provisionMutation seam.ContainerMutationLease
}

// databaseService 服务实现。
type databaseService struct {
	mutationMu     sync.Mutex
	deps           serviceDeps
	mu             sync.Mutex
	inProgress     map[string]bool
	operationGuard seam.ContainerOperationGuard
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

// jsonInteger 取 JSON 数值的整数形态（对齐 TS Number.isInteger）。
func jsonInteger(value any) (int, bool) {
	number, ok := value.(float64)
	if !ok || number != float64(int64(number)) {
		return 0, false
	}
	return int(number), true
}

// validateCreateRequest 创建请求校验（仅新建容器目标，扁平形状；错误文案为逐字契约）。
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
	imageID, imageOK := row["imageId"].(string)
	containerName, nameOK := row["containerName"].(string)
	if !imageOK || !nameOK {
		return createRequest{}, shared.InvalidRequest("创建容器参数无效")
	}
	accessScope, _ := row["accessScope"].(string)
	if accessScope != scopeLocalhost && accessScope != scopeContainerNet && accessScope != scopeAnyHost {
		return createRequest{}, shared.InvalidRequest("访问范围无效")
	}
	request := createRequest{Engine: engine, VersionTag: versionTag, ContainerName: containerName, ImageID: imageID, AccessScope: accessScope}
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
	return request, nil
}

// rowsByContainer 取某容器的全部登记行（按登记 ID 稳定排序）；无登记行按 404 处理。
func (s *databaseService) rowsByContainer(id string) ([]databaseRecord, error) {
	rows, err := s.deps.registry.list()
	if err != nil {
		return nil, err
	}
	var result []databaseRecord
	for _, row := range rows {
		if row.ContainerID == id {
			result = append(result, row)
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].ID < result[j].ID })
	if len(result) == 0 {
		return nil, shared.NotFound("数据库不存在")
	}
	return result, nil
}

// splitImageRef 拆镜像引用为仓库名与标签；摘要引用不再取标签。
func splitImageRef(ref string) (name, tag string) {
	if at := strings.Index(ref, "@"); at > 0 {
		return ref[:at], ""
	}
	colon := strings.LastIndex(ref, ":")
	if colon <= 0 || strings.Contains(ref[colon+1:], "/") {
		return ref, ""
	}
	return ref[:colon], ref[colon+1:]
}

// imageMatchesAny 镜像仓库名是否命中三类数据库官方仓库。
func imageMatchesAny(name string) bool {
	for _, engine := range []string{engineMySQL, engineMariaDB, engineRedis} {
		if imageMatches(engine, name) {
			return true
		}
	}
	return false
}

func databaseRefsByImageID(images []contract.ContainerImage) map[string]string {
	refs := make(map[string]string)
	for _, image := range images {
		for _, ref := range append([]string{image.Name + ":" + image.Tag}, image.OtherTags...) {
			name, tag := splitImageRef(ref)
			if imageMatchesAny(name) {
				id := stripSha256Prefix(image.ID)
				refs[id] = ref
				if validDatabaseVersion(tag) {
					break
				}
			}
		}
	}
	return refs
}

// engineFromImage 容器引擎判据：受管标签优先，其次镜像仓库名三形态。
func engineFromImage(labels map[string]any, refName string) string {
	if labeled, _ := labels["elysian.database.engine"].(string); engineRepository[labeled] != "" {
		return labeled
	}
	for _, engine := range []string{engineMySQL, engineMariaDB, engineRedis} {
		if imageMatches(engine, refName) {
			return engine
		}
	}
	return ""
}

// containerPorts NetworkSettings.Ports → 端口投影（按容器端口与协议稳定排序）。
func containerPorts(info map[string]any) []containerPortView {
	bindings := obj(field(obj(field(info, "NetworkSettings")), "Ports"))
	ports := []containerPortView{}
	for key, value := range bindings {
		slash := strings.LastIndex(key, "/")
		if slash <= 0 {
			continue
		}
		containerPort, err := strconv.Atoi(key[:slash])
		protocol := key[slash+1:]
		if err != nil || (protocol != "tcp" && protocol != "udp") {
			continue
		}
		view := containerPortView{ContainerPort: containerPort, Protocol: protocol}
		if mapping, ok := value.([]any); ok && len(mapping) > 0 {
			first := obj(mapping[0])
			view.HostIP = asString(first["HostIp"])
			if port, err := strconv.Atoi(asString(first["HostPort"])); err == nil && port > 0 {
				view.HostPort = &port
			}
		}
		ports = append(ports, view)
	}
	sort.Slice(ports, func(i, j int) bool {
		if ports[i].ContainerPort != ports[j].ContainerPort {
			return ports[i].ContainerPort < ports[j].ContainerPort
		}
		return ports[i].Protocol < ports[j].Protocol
	})
	return ports
}

// networkNames 容器接入的全部网络名（稳定排序）。
func networkNames(info map[string]any) []string {
	networks := obj(field(obj(field(info, "NetworkSettings")), "Networks"))
	names := make([]string, 0, len(networks))
	for name := range networks {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// inspectVolumeMounted 容器是否以 volume 形态挂载指定专属卷。
func inspectVolumeMounted(info map[string]any, volumeName string) bool {
	if volumeName == "" {
		return false
	}
	mounts, ok := field(info, "Mounts").([]any)
	if !ok {
		return false
	}
	for _, item := range mounts {
		m := obj(item)
		if t, _ := field(m, "Type").(string); t == "volume" {
			if n, _ := field(m, "Name").(string); n == volumeName {
				return true
			}
		}
	}
	return false
}

// containerCreatedAt 容器创建时刻投影为 isoNow 形态；解析失败回落当前时刻。
func containerCreatedAt(info map[string]any, now func() time.Time) string {
	if stamped, err := time.Parse(time.RFC3339Nano, asString(field(info, "Created"))); err == nil {
		return stamped.UTC().Format("2006-01-02T15:04:05.000Z")
	}
	return isoNow(now)
}

// projectContainer 容器 inspect 事实 + 聚合登记行 → 容器实例行。
// 引擎无法判定时返回 ok=false（调用方跳过该容器）；其余事实均尽力投影，
// memory 读不到时以 omitempty 消隐，不补零、不失败。
func (s *databaseService) projectContainer(ctx context.Context, info map[string]any, rows []databaseRecord, taggedRef string) (containerInstance, bool) {
	id := asString(field(info, "Id"))
	labels := obj(field(obj(field(info, "Config")), "Labels"))
	ref := inspectImageRef(info)
	refName, refTag := splitImageRef(ref)
	if taggedRef != "" {
		refName, refTag = splitImageRef(taggedRef)
	}
	engine := engineFromImage(labels, refName)
	if engine == "" && len(rows) > 0 && engineRepository[rows[0].Engine] != "" {
		engine = rows[0].Engine
	}
	if engine == "" {
		return containerInstance{}, false
	}
	versionTag := ""
	for _, row := range rows {
		if row.VersionTag != "" && validDatabaseVersion(row.VersionTag) {
			versionTag = row.VersionTag
			break
		}
	}
	if versionTag == "" {
		if labelVersion, _ := labels["elysian.database.version"].(string); labelVersion != "" && validDatabaseVersion(labelVersion) {
			versionTag = labelVersion
		} else if refTag != "" && imageMatches(engine, refName) && validDatabaseVersion(refTag) {
			versionTag = refTag
		}
	}
	instance := containerInstance{
		ID:          id,
		Engine:      engine,
		Name:        strings.TrimPrefix(asString(field(info, "Name")), "/"),
		Version:     versionTag,
		Status:      statusStopped,
		Image:       ref,
		ContainerID: id,
		VersionTag:  versionTag,
		Ports:       containerPorts(info),
		Networks:    networkNames(info),
		UpdatedAt:   containerCreatedAt(info, s.deps.now),
	}
	if inspectRunning(info) {
		instance.Status = statusRunning
	}
	for _, row := range rows {
		if row.VolumeName != "" && instance.VolumeName == "" {
			instance.VolumeName = row.VolumeName
		}
		if row.Source == sourceManaged {
			instance.Source = sourceManaged
		} else if instance.Source == "" {
			instance.Source = row.Source
		}
		if row.Admin.Password != "" && instance.CredentialUsername == "" {
			instance.CredentialUsername = row.Admin.Username
			instance.CredentialsVerified = true
		}
		if row.State != stateActive {
			instance.NeedsAttention = true
		}
		if row.CreatedAt > instance.UpdatedAt {
			instance.UpdatedAt = row.CreatedAt
		}
		if instance.ResourceTier == "" {
			instance.ResourceTier = row.ResourceTier
		}
		for _, logical := range row.Logical {
			view := logicalDatabaseView{ID: logical.ID, Kind: logical.Kind, Name: logical.Name, Users: []string{}, KeyPrefix: logical.KeyPrefix, State: logical.State, CreatedAt: logical.CreatedAt}
			for _, user := range logical.Users {
				view.Users = append(view.Users, user.Username)
			}
			instance.Databases = append(instance.Databases, view)
		}
	}
	if instance.VolumeName == "" {
		if labeled, _ := labels["elysian.database.volume"].(string); labeled != "" {
			instance.VolumeName = labeled
		}
	}
	for _, port := range instance.Ports {
		if port.ContainerPort == databasePort(engine) && port.Protocol == "tcp" && port.HostPort != nil {
			host := port.HostIP
			if host == "" {
				host = "0.0.0.0"
			}
			instance.Address = &containerAddressView{Host: host, Port: *port.HostPort}
			break
		}
	}
	if memory, err := s.deps.docker.memory(ctx, id); err == nil {
		instance.Memory = memory
	}
	return instance, true
}

func managedContainerRegistration(rows []databaseRecord) *databaseRecord {
	for i := range rows {
		if rows[i].Source == sourceManaged && rows[i].VolumeName != "" {
			return &rows[i]
		}
	}
	return nil
}

func missingContainer(rows []databaseRecord) containerInstance {
	row := &rows[0]
	if managed := managedContainerRegistration(rows); managed != nil {
		row = managed
	}
	name := row.ContainerName
	if name == "" {
		name = containerIDPrefix(row.ContainerID)
	}
	return containerInstance{
		ID: row.ContainerID, ContainerID: row.ContainerID, Name: name,
		Engine: row.Engine, Version: row.VersionTag, VersionTag: row.VersionTag,
		Status: statusMissing, Source: row.Source, VolumeName: row.VolumeName,
		Ports: []containerPortView{}, Networks: []string{}, NeedsAttention: true, UpdatedAt: row.CreatedAt,
	}
}

// List 全部数据库容器实例（Docker 清单筛选 + 登记行聚合注入）。
func (s *databaseService) List(ctx context.Context) ([]containerInstance, error) {
	rows, err := s.deps.registry.list()
	if err != nil {
		return nil, err
	}
	registered := map[string][]databaseRecord{}
	sort.Slice(rows, func(i, j int) bool { return rows[i].ID < rows[j].ID })
	for _, row := range rows {
		if row.ContainerID != "" && row.ContainerID != s.deps.selfContainerID {
			registered[row.ContainerID] = append(registered[row.ContainerID], row)
		}
	}
	listed, err := s.deps.listContainers(ctx)
	if err != nil {
		return nil, err
	}
	instances := []containerInstance{}
	var imageRefs map[string]string
	for _, container := range listed {
		if container.ID == s.deps.selfContainerID {
			continue
		}
		refName, _ := splitImageRef(container.ImageRef)
		group := registered[container.ID]
		var taggedRef string
		if !imageMatchesAny(refName) && len(group) == 0 {
			if !shaRefPattern.MatchString(container.ImageRef) {
				continue
			}
			if imageRefs == nil {
				images, err := s.deps.listImages(ctx)
				if err != nil {
					return nil, err
				}
				imageRefs = databaseRefsByImageID(images)
			}
			taggedRef = imageRefs[stripSha256Prefix(container.ImageID)]
			if taggedRef == "" {
				continue
			}
		}
		info, err := s.deps.docker.inspect(ctx, container.ID)
		if err != nil {
			var invalid *shared.InvalidRequestError
			// 容器在清单与详情之间消失：有登记的留给下面的清理列表。
			if errors.As(err, &invalid) && invalid.Status == 404 {
				continue
			}
			return nil, err
		}
		delete(registered, container.ID)
		instance, ok := s.projectContainer(ctx, info, group, taggedRef)
		if !ok {
			continue
		}
		instances = append(instances, instance)
	}
	for _, row := range rows {
		if group := registered[row.ContainerID]; len(group) > 0 {
			instances = append(instances, missingContainer(group))
			delete(registered, row.ContainerID)
		}
	}
	return instances, nil
}

// Create 创建数据库容器（时序敏感：先落登记再做收尾，失败保留待处理登记）。
func (s *databaseService) Create(ctx context.Context, input createRequest) (createResponse, error) {
	key := input.Engine + ":" + input.ContainerName
	s.mu.Lock()
	if s.inProgress[key] {
		s.mu.Unlock()
		return createResponse{}, shared.Conflict("相同数据库正在创建")
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
	for _, row := range rows {
		if row.ContainerName == input.ContainerName {
			return createResponse{}, shared.Conflict("数据库容器已登记")
		}
	}
	release, err := s.beginProvisionMutation(ctx, "", input.ContainerName)
	if err != nil {
		return createResponse{}, err
	}
	defer release()
	if err := s.checkContainerMutation(ctx, "", input.ContainerName); err != nil {
		return createResponse{}, err
	}
	adminUsername := "root"
	if input.Engine == engineRedis {
		adminUsername = "default"
	}
	admin := databaseSecret{Username: adminUsername, Password: randomAdminPassword()}
	created, err := s.deps.docker.create(ctx, createInput{
		engine: input.Engine, versionTag: input.VersionTag, imageID: input.ImageID,
		containerName: input.ContainerName, accessScope: input.AccessScope,
		hostPort: input.HostPort, bootstrapPwd: admin.Password,
	})
	if err != nil {
		return createResponse{}, err
	}
	row := databaseRecord{
		ID: newUUID(), Engine: input.Engine, Name: input.ContainerName, VersionTag: input.VersionTag,
		ContainerID: created.containerID, VolumeName: created.volumeName, Source: sourceManaged,
		AccessScope: input.AccessScope, Admin: admin, User: databaseSecret{},
		CreatedAt: isoNow(s.deps.now), State: stateNeedsAttention, ContainerName: input.ContainerName,
	}
	// 容器已产生后先登记待处理状态，后续任何失败都能在页面找到恢复入口。
	if err := s.deps.registry.put(row); err != nil {
		return createResponse{}, err
	}
	if !created.started {
		reason := "容器启动失败；可在容器页修复后重新核对"
		if created.startFailure != "" {
			reason = "容器启动失败（" + created.startFailure + "）；可在容器页修复后重新核对"
		}
		return createResponse{}, fmt.Errorf("数据库创建未完成；容器 %s 已登记为待处理：%s", containerIDPrefix(created.containerID), reason)
	}
	row.State = stateActive
	if err := s.deps.registry.put(row); err != nil {
		return createResponse{}, err
	}
	info, err := s.deps.docker.inspect(ctx, created.containerID)
	if err != nil {
		return createResponse{}, err
	}
	instance, ok := s.projectContainer(ctx, info, []databaseRecord{row}, "")
	if !ok {
		return createResponse{}, errors.New("数据库容器投影失败")
	}
	var firewallPort *contract.FirewallPortSync
	if input.AccessScope == scopeAnyHost && input.HostPort != nil {
		sync := s.openFirewallPort(ctx, *input.HostPort, fmt.Sprintf("Elysian 数据库 %s", input.ContainerName))
		firewallPort = &sync
	}
	return createResponse{Instance: instance, FirewallPort: firewallPort}, nil
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

// Reveal 按需读取容器管理员凭据（直读登记行，不做协议核对）。
func (s *databaseService) Reveal(ctx context.Context, id string) (databaseSecret, error) {
	rows, err := s.rowsByContainer(id)
	if err != nil {
		return databaseSecret{}, err
	}
	for _, row := range rows {
		if row.Admin.Password != "" {
			return row.Admin, nil
		}
	}
	return databaseSecret{}, shared.Conflict("没有已保存的管理员凭据")
}

// RevealUser 读取面板在实例内登记的某个逻辑库用户的凭据。创建尚未确认的登记不返回密码，
// 已确认的登记也只返回所请求的那一个用户；管理员凭据不能经这个入口取得。
func (s *databaseService) RevealUser(ctx context.Context, id, database, username string) (databaseSecret, error) {
	rows, err := s.rowsByContainer(id)
	if err != nil {
		return databaseSecret{}, err
	}
	for _, row := range rows {
		for _, logical := range row.Logical {
			if logical.Name != database {
				continue
			}
			for _, user := range logical.Users {
				if user.Username != username {
					continue
				}
				if logical.State != logicalStateActive {
					return databaseSecret{}, shared.Conflict("该数据库的创建尚未确认，凭据暂不可读取；请核实对应部署任务的结果")
				}
				return databaseSecret{Username: user.Username, Password: user.Password}, nil
			}
		}
	}
	return databaseSecret{}, shared.NotFound("该数据库用户不存在于面板登记")
}

// Reconcile 重新核对容器事实：存在、运行中、镜像与引擎/版本匹配、专属卷挂载；
// 通过后清除待处理状态并回容器实例行。
func (s *databaseService) Reconcile(ctx context.Context, id string) (containerInstance, error) {
	s.mutationMu.Lock()
	defer s.mutationMu.Unlock()
	rows, err := s.rowsByContainer(id)
	if err != nil {
		return containerInstance{}, err
	}
	anchor := rows[0]
	if err := s.checkContainerMutation(ctx, anchor.ContainerID, anchor.ContainerName); err != nil {
		return containerInstance{}, err
	}
	info, err := s.deps.docker.assertEngine(ctx, anchor.ContainerID, anchor.Engine, anchor.VersionTag)
	if err != nil {
		return containerInstance{}, err
	}
	if anchor.VolumeName != "" && !inspectVolumeMounted(info, anchor.VolumeName) {
		return containerInstance{}, shared.Conflict("容器没有挂载登记的数据库持久卷")
	}
	for _, row := range rows {
		if row.State != stateActive {
			row.State = stateActive
			if err := s.deps.registry.put(row); err != nil {
				return containerInstance{}, err
			}
		}
	}
	refreshed, err := s.rowsByContainer(id)
	if err != nil {
		return containerInstance{}, err
	}
	instance, ok := s.projectContainer(ctx, info, refreshed, "")
	if !ok {
		return containerInstance{}, errors.New("数据库容器投影失败")
	}
	return instance, nil
}

// Forget 仅在容器已不存在时移除该容器全部登记行（不删容器与卷）。
func (s *databaseService) Forget(ctx context.Context, id string) error {
	s.mutationMu.Lock()
	defer s.mutationMu.Unlock()
	rows, err := s.rowsByContainer(id)
	if err != nil {
		return err
	}
	release, err := s.beginProvisionMutation(ctx, rows[0].ContainerID, rows[0].ContainerName)
	if err != nil {
		return err
	}
	defer release()
	if err := s.checkContainerMutation(ctx, rows[0].ContainerID, rows[0].ContainerName); err != nil {
		return err
	}
	if _, err := s.deps.docker.inspect(ctx, id); err == nil {
		return shared.Conflict("数据库容器仍然存在，请先删除容器及数据")
	} else {
		var invalid *shared.InvalidRequestError
		if !errors.As(err, &invalid) || invalid.Status != 404 {
			return err
		}
	}
	for _, row := range rows {
		if err := s.deps.registry.remove(row.ID); err != nil {
			return err
		}
	}
	return nil
}

func (s *databaseService) beginProvisionMutation(ctx context.Context, id, name string) (func(), error) {
	if s.deps.provisionMutation == nil {
		return func() {}, nil
	}
	return s.deps.provisionMutation(ctx, id, name)
}

// RemoveContainer 删除面板创建的数据库容器与专属卷；成功后移除该容器全部登记行。
func (s *databaseService) RemoveContainer(ctx context.Context, id string) error {
	s.mutationMu.Lock()
	defer s.mutationMu.Unlock()
	return s.removeContainer(ctx, id)
}

// removeContainer 删容器主体；调用方必须已持有 mutationMu（容器接缝 Lifecycle 复用）。
func (s *databaseService) removeContainer(ctx context.Context, id string) error {
	rows, err := s.rowsByContainer(id)
	if err != nil {
		return err
	}
	release, err := s.beginProvisionMutation(ctx, rows[0].ContainerID, rows[0].ContainerName)
	if err != nil {
		return err
	}
	defer release()
	if err := s.checkContainerMutation(ctx, rows[0].ContainerID, rows[0].ContainerName); err != nil {
		return err
	}
	managed := managedContainerRegistration(rows)
	if managed == nil {
		return &shared.InvalidRequestError{Status: 403, Message: "只能删除面板创建的数据库容器和专属卷"}
	}
	// 容器与卷的身份由 removeManaged 硬核对（五元标签 + 镜像身份 + 挂载）；
	// 容器已被外部删除时允许清理登记的专属孤儿卷。
	if err := s.deps.docker.removeManaged(ctx, managed.ContainerID, managed.VolumeName, managed.Engine, managed.VersionTag); err != nil {
		return err
	}
	for _, row := range rows {
		if err := s.deps.registry.remove(row.ID); err != nil {
			return err
		}
	}
	return nil
}
