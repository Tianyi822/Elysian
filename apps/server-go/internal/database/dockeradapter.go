package database

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"elysian/server/internal/contract"
	"elysian/server/internal/seam"
	"elysian/server/internal/shared"
)

// Docker Engine API 适配（databaseDocker.ts 等价物）：inspect/assertEngine/
// address/attach/detach/create/removeManaged/memory。请求经 seam.DockerTransport
// 发出（版本前缀 /v1.41 由传输器统一添加），每请求超时 15s、响应上限 4 MiB。

const (
	dockerRequestTimeout   = 15 * time.Second
	dockerResponseMaxBytes = 4 * 1024 * 1024
	// panelPort 面板端口（契约 PANEL_PORT 同值）。
	panelPort = 48100
	// serverPort 服务端口（后端 API 契约端口，config.ListenPort 同值）。
	serverPort = 48101
)

// 引擎 → 官方仓库名。
var engineRepository = map[string]string{
	engineMySQL:   "mysql",
	engineMariaDB: "mariadb",
	engineRedis:   "redis",
}

// 引擎 → 容器内服务端口。
var enginePort = map[string]int{
	engineMySQL:   3306,
	engineMariaDB: 3306,
	engineRedis:   6379,
}

// databasePort 引擎的服务端口。
func databasePort(engine string) int { return enginePort[engine] }

var (
	validDatabaseVersionPattern = regexp.MustCompile(`^\d+(?:\.\d+){0,2}(?:[-.][A-Za-z0-9]+)*$`)
	latestPattern               = regexp.MustCompile(`(?i)latest`)
	containerIDPattern          = regexp.MustCompile(`^[a-f0-9]{64}$`)
	containerNamePattern        = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$`)
	shaRefPattern               = regexp.MustCompile(`^(?:sha256:)?[a-f0-9]{64}$`)
	managedVolumeNamePattern    = regexp.MustCompile(`^elysian-db-[0-9a-f-]{36}$`)
	ipv4Pattern                 = regexp.MustCompile(`^\d{1,3}(?:\.\d{1,3}){3}$`)
)

// validDatabaseVersion 版本标签判据（拒绝 latest 与嵌入 shell 元字符的形态）。
func validDatabaseVersion(tag string) bool {
	return validDatabaseVersionPattern.MatchString(tag) && !latestPattern.MatchString(tag)
}

// imageMatches 引擎与镜像仓库名的匹配（官方三形态）。
func imageMatches(engine, name string) bool {
	repo := engineRepository[engine]
	return name == repo || name == "library/"+repo || name == "docker.io/library/"+repo
}

// databaseImageHasTag 镜像是否带引擎与版本的明确 tag。
func databaseImageHasTag(image contract.ContainerImage, engine, tag string) bool {
	if imageMatches(engine, image.Name) && image.Tag == tag {
		return true
	}
	for _, ref := range image.OtherTags {
		colon := strings.LastIndex(ref, ":")
		if colon > 0 && ref[colon+1:] == tag && imageMatches(engine, ref[:colon]) {
			return true
		}
	}
	return false
}

func stripSha256Prefix(id string) string { return strings.TrimPrefix(id, "sha256:") }

// dockerAPI 是 Engine 适配器。
type dockerAPI struct {
	transport     seam.DockerTransport
	listImages    func(ctx context.Context) ([]contract.ContainerImage, error)
	reservedPorts []int
}

func newDockerAPI(transport seam.DockerTransport, listImages func(ctx context.Context) ([]contract.ContainerImage, error), ports ...[]int) *dockerAPI {
	reserved := []int{22, panelPort, serverPort}
	if len(ports) > 0 && len(ports[0]) > 0 {
		reserved = ports[0]
	}
	return &dockerAPI{transport: transport, listImages: listImages, reservedPorts: reserved}
}

// request 发一次 Engine 请求并返回响应。
func (d *dockerAPI) request(ctx context.Context, method, path string, query url.Values, body any) (seam.EngineResponse, error) {
	var payload []byte
	if body != nil {
		data, err := shared.MarshalJSON(body)
		if err != nil {
			return seam.EngineResponse{}, err
		}
		payload = data
	}
	return d.transport.Request(ctx, seam.EngineRequest{
		Method:   method,
		Path:     path,
		Query:    query,
		Body:     payload,
		Timeout:  dockerRequestTimeout,
		MaxBytes: dockerResponseMaxBytes,
	})
}

// obj 剖析任意 JSON 值为 map（非对象回空 map），对齐 TS 的 obj() 宽松取值。
func obj(value any) map[string]any {
	if m, ok := value.(map[string]any); ok {
		return m
	}
	return map[string]any{}
}

func field(m map[string]any, key string) any { return m[key] }

// inspect 读取容器完整信息；身份复核失败一律拒绝。
func (d *dockerAPI) inspect(ctx context.Context, id string) (map[string]any, error) {
	if !containerIDPattern.MatchString(strings.ToLower(id)) {
		return nil, shared.InvalidRequest("容器 ID 无效")
	}
	response, err := d.request(ctx, "GET", "/containers/"+url.PathEscape(id)+"/json", nil, nil)
	if err != nil {
		return nil, err
	}
	if response.Status == 404 {
		return nil, &shared.InvalidRequestError{Status: 404, Message: "数据库容器已不存在"}
	}
	if response.Status != 200 {
		return nil, errors.New("读取数据库容器失败")
	}
	var value any
	if err := json.Unmarshal(response.Body, &value); err != nil {
		return nil, errors.New("读取数据库容器失败")
	}
	info := obj(value)
	if s, _ := field(info, "Id").(string); s != id {
		return nil, errors.New("容器身份核对失败")
	}
	return info, nil
}

func inspectRunning(info map[string]any) bool {
	running, _ := field(obj(field(info, "State")), "Running").(bool)
	return running
}

func inspectImageRef(info map[string]any) string {
	ref, _ := field(obj(field(info, "Config")), "Image").(string)
	return ref
}

// assertEngine 容器运行中且镜像与所选引擎、版本一致。
func (d *dockerAPI) assertEngine(ctx context.Context, id, engine, versionTag string) (map[string]any, error) {
	if !validDatabaseVersion(versionTag) {
		return nil, shared.InvalidRequest("必须指定明确数据库版本，不能使用 latest")
	}
	info, err := d.inspect(ctx, id)
	if err != nil {
		return nil, err
	}
	if !inspectRunning(info) {
		return nil, &shared.InvalidRequestError{Status: 409, Message: "数据库容器未运行"}
	}
	ref := inspectImageRef(info)
	index := strings.LastIndex(ref, ":")
	name, tag := ref, ""
	if index >= 0 {
		name, tag = ref[:index], ref[index+1:]
	}
	exactRef := imageMatches(engine, name) && tag == versionTag
	imageID, _ := field(info, "Image").(string)
	imageID = stripSha256Prefix(imageID)
	images, err := d.listImages(ctx)
	if err != nil {
		return nil, err
	}
	matchedImage := false
	for _, image := range images {
		if stripSha256Prefix(image.ID) == imageID && databaseImageHasTag(image, engine, versionTag) {
			matchedImage = true
			break
		}
	}
	if !matchedImage || (ref != "" && !exactRef && !shaRefPattern.MatchString(strings.ToLower(ref))) {
		return nil, &shared.InvalidRequestError{Status: 409, Message: "容器镜像与所选引擎或版本不一致"}
	}
	return info, nil
}

// attach 把容器接入面板数据库网络（幂等）。
func (d *dockerAPI) attach(ctx context.Context, id, network string) error {
	if network != networkDBPrivateName && network != networkDBSharedName {
		return shared.InvalidRequest("数据库网络无效")
	}
	info, err := d.inspect(ctx, id)
	if err != nil {
		return err
	}
	if attached := field(obj(field(obj(field(info, "NetworkSettings")), "Networks")), network); attached != nil {
		return nil
	}
	response, err := d.request(ctx, "POST", "/networks/"+url.PathEscape(network)+"/connect", nil, map[string]any{"Container": id})
	if err != nil {
		return err
	}
	if response.Status != 200 && response.Status != 201 && response.Status != 204 {
		return &shared.InvalidRequestError{Status: 409, Message: "无法将数据库容器接入面板网络"}
	}
	return nil
}

// detach 把容器移出面板数据库网络（幂等；容器已删视为已离网）。
func (d *dockerAPI) detach(ctx context.Context, id, network string) error {
	if network != networkDBPrivateName && network != networkDBSharedName {
		return shared.InvalidRequest("数据库网络无效")
	}
	info, err := d.inspect(ctx, id)
	if err != nil {
		var invalid *shared.InvalidRequestError
		if errors.As(err, &invalid) && invalid.Status == 404 {
			return nil
		}
		return err
	}
	if attached := field(obj(field(obj(field(info, "NetworkSettings")), "Networks")), network); attached == nil {
		return nil
	}
	response, err := d.request(ctx, "POST", "/networks/"+url.PathEscape(network)+"/disconnect", nil, map[string]any{"Container": id})
	if err != nil {
		return err
	}
	if response.Status < 200 || response.Status >= 300 {
		return &shared.InvalidRequestError{Status: 409, Message: "无法将数据库容器移出面板网络"}
	}
	return nil
}

// address 取容器在面板网络（私有优先）上的 IPv4。
func (d *dockerAPI) address(ctx context.Context, id string, network string) (databaseAddress, error) {
	info, err := d.inspect(ctx, id)
	if err != nil {
		return databaseAddress{}, err
	}
	if !inspectRunning(info) {
		return databaseAddress{}, &shared.InvalidRequestError{Status: 409, Message: "数据库容器未运行"}
	}
	networks := obj(field(obj(field(info, "NetworkSettings")), "Networks"))
	selected := network
	if selected == "" {
		if field(networks, networkDBPrivateName) != nil {
			selected = networkDBPrivateName
		} else {
			selected = networkDBSharedName
		}
	}
	ip, _ := field(obj(field(networks, selected)), "IPAddress").(string)
	if !ipv4Pattern.MatchString(ip) {
		return databaseAddress{}, &shared.InvalidRequestError{Status: 409, Message: "数据库容器尚未接入面板网络"}
	}
	return databaseAddress{Host: ip, Port: 0}, nil
}

// createInput 创建数据库容器的全部入参。
type createInput struct {
	engine        string
	versionTag    string
	imageID       string
	containerName string
	accessScope   string
	hostPort      *int
	bootstrapPwd  string
	ordinaryUser  databaseSecret
}

// createResult 容器与专属卷的创建产物。
type createResult struct {
	containerID string
	volumeName  string
	started     bool
}

// mountSpec HostConfig.Mounts 行。
type mountSpec struct {
	Type   string `json:"Type"`
	Source string `json:"Source"`
	Target string `json:"Target"`
}

// portBindingSpec PortBindings 行。
type portBindingSpec struct {
	HostIP   string `json:"HostIp"`
	HostPort string `json:"HostPort"`
}

// restartPolicySpec RestartPolicy。
type restartPolicySpec struct {
	Name string `json:"Name"`
}

// hostConfigSpec HostConfig。
type hostConfigSpec struct {
	Mounts        []mountSpec                  `json:"Mounts"`
	RestartPolicy restartPolicySpec            `json:"RestartPolicy"`
	NetworkMode   string                       `json:"NetworkMode"`
	PortBindings  map[string][]portBindingSpec `json:"PortBindings,omitempty"`
}

// networkEndpointSpec NetworkingConfig.EndpointsConfig 行。
type networkEndpointSpec struct{}

// networkingConfigSpec NetworkingConfig。
type networkingConfigSpec struct {
	EndpointsConfig map[string]networkEndpointSpec `json:"EndpointsConfig"`
}

// containerCreateSpec containers/create 请求体。
type containerCreateSpec struct {
	Image            string                    `json:"Image"`
	Labels           map[string]string         `json:"Labels"`
	HostConfig       hostConfigSpec            `json:"HostConfig"`
	NetworkingConfig networkingConfigSpec      `json:"NetworkingConfig"`
	ExposedPorts     map[string]map[string]any `json:"ExposedPorts"`
	Cmd              []string                  `json:"Cmd,omitempty"`
	Env              []string                  `json:"Env,omitempty"`
}

// create 建卷、建容器并启动；容器创建失败回滚删卷。
func (d *dockerAPI) create(ctx context.Context, input createInput) (createResult, error) {
	engine, versionTag, imageID, containerName, accessScope := input.engine, input.versionTag, input.imageID, input.containerName, input.accessScope
	if !validDatabaseVersion(versionTag) {
		return createResult{}, shared.InvalidRequest("必须指定明确数据库版本")
	}
	if !containerNamePattern.MatchString(containerName) {
		return createResult{}, shared.InvalidRequest("容器名称无效")
	}
	if !containerIDPattern.MatchString(strings.ToLower(stripSha256Prefix(imageID))) {
		return createResult{}, shared.InvalidRequest("镜像 ID 无效")
	}
	hostPort := 0
	if input.hostPort != nil {
		hostPort = *input.hostPort
	}
	if accessScope == scopeAnyHost && (input.hostPort == nil || hostPort < 1 || hostPort > 65535) {
		return createResult{}, shared.InvalidRequest("任意主机访问必须指定有效宿主端口")
	}
	for _, reserved := range d.reservedPorts {
		if hostPort != 0 && hostPort == reserved {
			return createResult{}, shared.InvalidRequest("宿主端口被面板保留")
		}
	}
	images, err := d.listImages(ctx)
	if err != nil {
		return createResult{}, err
	}
	found := false
	for _, image := range images {
		if image.ID == imageID && databaseImageHasTag(image, engine, versionTag) {
			found = true
			break
		}
	}
	if !found {
		return createResult{}, &shared.InvalidRequestError{Status: 409, Message: "指定版本的数据库镜像尚未拉取"}
	}
	volumeName := "elysian-db-" + newUUID()
	network := networkDBSharedName
	if accessScope == scopeLocalhost {
		network = networkDBPrivateName
	}
	volume, err := d.request(ctx, "POST", "/volumes/create", nil, map[string]any{
		"Name": volumeName,
		"Labels": map[string]string{
			"elysian.database":         "true",
			"elysian.database.engine":  engine,
			"elysian.database.version": versionTag,
		},
	})
	if err != nil {
		return createResult{}, err
	}
	if volume.Status != 201 && volume.Status != 200 {
		return createResult{}, errors.New("创建数据库持久卷失败")
	}

	port := databasePort(engine)
	portKey := strconv.Itoa(port) + "/tcp"
	dataTarget := "/var/lib/mysql"
	if engine == engineRedis {
		dataTarget = "/data"
	}
	hostConfig := hostConfigSpec{
		Mounts: []mountSpec{{
			Type:   "volume",
			Source: volumeName,
			Target: dataTarget,
		}},
		RestartPolicy: restartPolicySpec{Name: "unless-stopped"},
		NetworkMode:   network,
	}
	if accessScope != scopeContainerNet {
		hostIP := "0.0.0.0"
		if accessScope == scopeLocalhost {
			hostIP = "127.0.0.1"
		}
		hostPortValue := ""
		if input.hostPort != nil && hostPort > 0 {
			hostPortValue = strconv.Itoa(hostPort)
		}
		hostConfig.PortBindings = map[string][]portBindingSpec{
			portKey: {{HostIP: hostIP, HostPort: hostPortValue}},
		}
	}
	spec := containerCreateSpec{
		Image: engineRepository[engine] + ":" + versionTag,
		Labels: map[string]string{
			"elysian.managed":          "true",
			"elysian.database":         "true",
			"elysian.database.engine":  engine,
			"elysian.database.version": versionTag,
			"elysian.database.volume":  volumeName,
		},
		HostConfig:       hostConfig,
		NetworkingConfig: networkingConfigSpec{EndpointsConfig: map[string]networkEndpointSpec{network: {}}},
		ExposedPorts:     map[string]map[string]any{portKey: {}},
	}
	if engine == engineRedis {
		spec.Cmd = redisACLCommand(input.bootstrapPwd, input.ordinaryUser)
	} else {
		prefix := "MARIADB"
		if engine == engineMySQL {
			prefix = "MYSQL"
		}
		spec.Env = []string{prefix + "_ROOT_PASSWORD=" + input.bootstrapPwd}
	}
	query := url.Values{}
	query.Set("name", containerName)
	created, err := d.request(ctx, "POST", "/containers/create", query, spec)
	if err != nil {
		return createResult{}, err
	}
	var createdBody map[string]any
	containerID := ""
	if created.Status == 201 && json.Unmarshal(created.Body, &createdBody) == nil {
		containerID, _ = field(createdBody, "Id").(string)
	}
	if containerID == "" {
		// 容器创建失败回滚删卷；删卷失败不掩盖原始错误。
		_, _ = d.request(ctx, "DELETE", "/volumes/"+url.PathEscape(volumeName), nil, nil)
		return createResult{}, errors.New("创建数据库容器失败")
	}
	started, err := d.request(ctx, "POST", "/containers/"+url.PathEscape(containerID)+"/start", nil, nil)
	if err != nil {
		return createResult{}, err
	}
	return createResult{
		containerID: containerID,
		volumeName:  volumeName,
		started:     started.Status == 204 || started.Status == 200,
	}, nil
}

// redisACLCommand 生成 Redis 启动命令：ACL 文件先写进持久卷再启动服务。
// ACL 里 default 与普通账号密码均为 sha256 hex（#hash 形态），容器配置不含明文。
func redisACLCommand(bootstrapPassword string, ordinaryUser databaseSecret) []string {
	adminHash := sha256.Sum256([]byte(bootstrapPassword))
	userHash := sha256.Sum256([]byte(ordinaryUser.Password))
	acl := "user default on #" + hex.EncodeToString(adminHash[:]) + " ~* &* +@all\n" +
		"user " + ordinaryUser.Username + " on #" + hex.EncodeToString(userHash[:]) +
		" ~* &* +@all -@dangerous -@scripting -select -move -copy -swapdb -flushdb -flushall" +
		" -eval -evalsha -eval_ro -evalsha_ro -fcall -fcall_ro -function -script -config -acl -module -debug -shutdown -save -bgsave -bgrewriteaof -migrate -restore -replicaof -slaveof -cluster -monitor -sync -psync\n"
	encoded := base64.StdEncoding.EncodeToString([]byte(acl))
	return []string{"sh", "-c", fmt.Sprintf("printf '%%s' '%s' | base64 -d > /data/users.acl && exec redis-server --appendonly yes --aclfile /data/users.acl", encoded)}
}

// removeManaged 停止并删除面板受管容器与专属卷；容器与卷都已消失时幂等返回。
func (d *dockerAPI) removeManaged(ctx context.Context, containerID, volumeName, engine, versionTag string) error {
	var info map[string]any
	info, inspectErr := d.inspect(ctx, containerID)
	if inspectErr != nil {
		var invalid *shared.InvalidRequestError
		if !errors.As(inspectErr, &invalid) || invalid.Status != 404 {
			return inspectErr
		}
		info = nil
	}
	if !managedVolumeNamePattern.MatchString(volumeName) {
		return &shared.InvalidRequestError{Status: 409, Message: "数据库持久卷名称无效"}
	}
	volume, err := d.request(ctx, "GET", "/volumes/"+url.PathEscape(volumeName), nil, nil)
	if err != nil {
		return err
	}
	if info == nil && volume.Status == 404 {
		return nil
	}
	var volumeBody map[string]any
	if json.Unmarshal(volume.Body, &volumeBody) != nil {
		volumeBody = map[string]any{}
	}
	volumeLabels := obj(field(volumeBody, "Labels"))
	engineLabel, _ := volumeLabels["elysian.database.engine"].(string)
	versionLabel, _ := volumeLabels["elysian.database.version"].(string)
	managedLabel, _ := volumeLabels["elysian.database"].(string)
	if volume.Status != 200 || managedLabel != "true" ||
		(engineLabel != "" && engineLabel != engine) ||
		(versionLabel != "" && versionLabel != versionTag) {
		return &shared.InvalidRequestError{Status: 409, Message: "数据库持久卷身份核对失败"}
	}
	if info == nil {
		removedVolume, err := d.request(ctx, "DELETE", "/volumes/"+url.PathEscape(volumeName), nil, nil)
		if err != nil {
			return err
		}
		if removedVolume.Status != 204 {
			return errors.New("数据库容器已不存在，但持久卷删除失败")
		}
		return nil
	}
	labels := obj(field(obj(field(info, "Config")), "Labels"))
	containerImageID := stripSha256Prefix(asString(field(info, "Image")))
	images, err := d.listImages(ctx)
	if err != nil {
		return err
	}
	imageOK := false
	for _, image := range images {
		if stripSha256Prefix(image.ID) == containerImageID && databaseImageHasTag(image, engine, versionTag) {
			imageOK = true
			break
		}
	}
	labelValues := []string{
		asString(labels["elysian.managed"]),
		asString(labels["elysian.database"]),
		asString(labels["elysian.database.engine"]),
		asString(labels["elysian.database.version"]),
		asString(labels["elysian.database.volume"]),
	}
	if labelValues[0] != "true" || labelValues[1] != "true" || labelValues[2] != engine ||
		labelValues[3] != versionTag || labelValues[4] != volumeName || !imageOK {
		return &shared.InvalidRequestError{Status: 409, Message: "容器或持久卷不属于面板管理的数据库"}
	}
	mounted := false
	if mounts, ok := field(info, "Mounts").([]any); ok {
		for _, item := range mounts {
			m := obj(item)
			if t, _ := field(m, "Type").(string); t == "volume" {
				if n, _ := field(m, "Name").(string); n == volumeName {
					mounted = true
					break
				}
			}
		}
	}
	if !mounted {
		return &shared.InvalidRequestError{Status: 409, Message: "容器没有挂载登记的数据库持久卷"}
	}
	if inspectRunning(info) {
		query := url.Values{}
		query.Set("t", "10")
		stopped, err := d.request(ctx, "POST", "/containers/"+url.PathEscape(containerID)+"/stop", query, nil)
		if err != nil {
			return err
		}
		if stopped.Status != 204 && stopped.Status != 304 {
			return errors.New("停止数据库容器失败")
		}
	}
	query := url.Values{}
	query.Set("v", "false")
	removed, err := d.request(ctx, "DELETE", "/containers/"+url.PathEscape(containerID), query, nil)
	if err != nil {
		return err
	}
	if removed.Status != 204 {
		return errors.New("删除数据库容器失败")
	}
	removedVolume, err := d.request(ctx, "DELETE", "/volumes/"+url.PathEscape(volumeName), nil, nil)
	if err != nil {
		return err
	}
	if removedVolume.Status != 204 {
		return errors.New("数据库容器已删除，但持久卷删除失败")
	}
	return nil
}

// memory 读取容器内存用量（GiB）；读不到回 nil。
func (d *dockerAPI) memory(ctx context.Context, id string) (*memoryView, error) {
	query := url.Values{}
	query.Set("stream", "false")
	response, err := d.request(ctx, "GET", "/containers/"+url.PathEscape(id)+"/stats", query, nil)
	if err != nil {
		return nil, err
	}
	if response.Status != 200 {
		return nil, nil
	}
	var body map[string]any
	if json.Unmarshal(response.Body, &body) != nil {
		return nil, nil
	}
	stats := obj(field(body, "memory_stats"))
	usage, usageOK := asFloat(field(stats, "usage"))
	limit, limitOK := asFloat(field(stats, "limit"))
	if !usageOK || !limitOK || limit <= 0 {
		return nil, nil
	}
	return &memoryView{UsedGb: usage / (1024 * 1024 * 1024), TotalGb: limit / (1024 * 1024 * 1024)}, nil
}

// asString 宽松字符串化（TS String(value) 的非严格近似：仅用于 nil 与标量）。
func asString(value any) string {
	if value == nil {
		return ""
	}
	if s, ok := value.(string); ok {
		return s
	}
	return fmt.Sprint(value)
}

// asFloat 解析数值（JSON 数字或数字字符串）。
func asFloat(value any) (float64, bool) {
	switch v := value.(type) {
	case float64:
		return v, true
	case string:
		f, err := strconv.ParseFloat(v, 64)
		return f, err == nil
	case int64:
		return float64(v), true
	case int:
		return float64(v), true
	default:
		return 0, false
	}
}
