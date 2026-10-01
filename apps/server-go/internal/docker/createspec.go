package docker

import (
	"errors"
	"io/fs"
	"math"
	"path/filepath"
	"regexp"
	"strings"

	"elysian/server/internal/shared"
)

// 创建容器的输入校验与 Engine create 体组装（createSpec.ts 逐字移植）。
// create 体是白名单：Image、Labels、HostConfig{RestartPolicy[,PortBindings][,Mounts]}、
// Cmd、Env——绝不含 Privileged/Binds/NetworkMode。

const (
	envKeyMax         = 128
	envValueMaxBytes  = 4096
	maxPorts          = 32
	maxEnv            = 64
	maxMounts         = 16
	portMin           = 1
	portMax           = 65535
	symlinkMountError = "挂载路径经过符号链接，已拒绝"
)

var (
	namePattern   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`)
	envKeyPattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
)

// hasControlChars TS 正则 [\u0000-\u001F\u007F-\u009F] 的等价判定（按 Unicode
// 码点逐 rune 检查；Go regexp 不接受非 UTF-8 字节区间）。
func hasControlChars(s string) bool {
	for _, r := range s {
		if r <= 0x1F || (r >= 0x7F && r <= 0x9F) {
			return true
		}
	}
	return false
}

// imageBrief / containerBrief / portBrief 创建校验的输入事实（列表接口映射后的精简形状）。
type imageBrief struct {
	id   string
	name string
}

type portBrief struct {
	hostPort int
	protocol string
	hostIP   string // 空串表示缺省（生效值 127.0.0.1）
}

type containerBrief struct {
	name  string
	ports []portBrief
}

// buildCreateSpecInput 校验入参。
type buildCreateSpecInput struct {
	body          any
	images        []imageBrief
	containers    []containerBrief
	mountRoot     string
	reservedPorts []int
	realpath      func(path string) (string, error)
}

// buildCreateSpecResult 校验产出：容器名、Engine create 体（确定性键序）、逐级 mkdir 表。
type buildCreateSpecResult struct {
	name       string
	createBody []byte
	mkdirPaths []string
}

// normalizeImageId 校验 64 位 hex（可带 sha256: 前缀）并小写归一。
func normalizeCreateImageID(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	hex := strings.TrimPrefix(trimmed, "sha256:")
	if len(hex) != 64 {
		return "", shared.InvalidRequest("镜像 ID 无效")
	}
	for i := 0; i < len(hex); i++ {
		ch := hex[i]
		if !(ch >= '0' && ch <= '9' || ch >= 'a' && ch <= 'f' || ch >= 'A' && ch <= 'F') {
			return "", shared.InvalidRequest("镜像 ID 无效")
		}
	}
	return strings.ToLower(hex), nil
}

// normalizeAbsolutePath 绝对路径规范化：拒控制字符与 . / .. 段。
func normalizeAbsolutePath(input, label string) (string, error) {
	reject := func() (string, error) {
		return "", shared.InvalidRequest("无效的" + label + "：" + input)
	}
	if !strings.HasPrefix(input, "/") {
		return reject()
	}
	if hasControlChars(input) {
		return reject()
	}
	segments := make([]string, 0)
	for _, segment := range strings.Split(input, "/") {
		if segment == "" {
			continue
		}
		if segment == ".." || segment == "." {
			return reject()
		}
		segments = append(segments, segment)
	}
	if len(segments) == 0 {
		return "/", nil
	}
	return "/" + strings.Join(segments, "/"), nil
}

func normalizeMountRoot(mountRoot string) (string, error) {
	return normalizeAbsolutePath(mountRoot, "挂载根")
}

func parentDirOf(path string) string {
	segments := make([]string, 0)
	for _, segment := range strings.Split(path, "/") {
		if segment != "" {
			segments = append(segments, segment)
		}
	}
	if len(segments) > 0 {
		segments = segments[:len(segments)-1]
	}
	if len(segments) == 0 {
		return "/"
	}
	return "/" + strings.Join(segments, "/")
}

// isENOENT 路径不存在的判定（realpath 上溯时的容错分支）。
func isENOENT(err error) bool {
	return errors.Is(err, fs.ErrNotExist)
}

func effectiveHostIP(hostIP string) string {
	if hostIP == "" {
		return "127.0.0.1"
	}
	return hostIP
}

func hostIPsOverlap(a, b string) bool {
	return a == b || a == "0.0.0.0" || b == "0.0.0.0"
}

func parseRestartPolicy(value any) (string, error) {
	s, ok := asString(value)
	if !ok || !restartPolicyWhitelist[s] {
		return "", shared.InvalidRequest("重启策略无效")
	}
	return s, nil
}

func parsePortProtocol(value any) (string, error) {
	s, _ := asString(value)
	if s == "tcp" || s == "" {
		return "tcp", nil
	}
	if s == "udp" {
		return "udp", nil
	}
	return "", shared.InvalidRequest("端口协议无效")
}

func parsePortNumber(value any, label string) (int, error) {
	f, ok := asNumber(value)
	if !ok || !isFiniteNumber(f) || f != math.Trunc(f) {
		return 0, shared.InvalidRequest(label + "须为整数")
	}
	if f < portMin || f > portMax {
		return 0, shared.InvalidRequest(label + "须为 1-65535 的整数")
	}
	return int(f), nil
}

// portMappingInput 校验后的端口映射（hostIP 空串表示未提供）。
type portMappingInput struct {
	containerPort int
	hostPort      int
	protocol      string
	hostIP        string
}

func parsePorts(raw any) ([]portMappingInput, error) {
	rows, ok := asArray(raw)
	if !ok {
		return nil, shared.InvalidRequest("ports 须为数组")
	}
	if len(rows) > maxPorts {
		return nil, shared.InvalidRequest("端口映射不能超过 32 条")
	}
	result := make([]portMappingInput, 0, len(rows))
	for index, row := range rows {
		record, ok := asRecord(row)
		if !ok {
			return nil, shared.InvalidRequest("ports[" + itoa(index) + "] 无效")
		}
		hostIP := ""
		if rawIP, has := record.get("hostIp"); has {
			ip, ok := asString(rawIP)
			if !ok {
				return nil, shared.InvalidRequest("ports[" + itoa(index) + "].hostIp 无效")
			}
			if ip != "127.0.0.1" && ip != "0.0.0.0" {
				return nil, shared.InvalidRequest("hostIp 只允许 127.0.0.1 或 0.0.0.0")
			}
			hostIP = ip
		}
		containerPort, err := parsePortNumber(mustGet(record, "containerPort"), "容器端口")
		if err != nil {
			return nil, err
		}
		hostPort, err := parsePortNumber(mustGet(record, "hostPort"), "宿主端口")
		if err != nil {
			return nil, err
		}
		protocol, err := parsePortProtocol(mustGet(record, "protocol"))
		if err != nil {
			return nil, err
		}
		result = append(result, portMappingInput{containerPort: containerPort, hostPort: hostPort, protocol: protocol, hostIP: hostIP})
	}
	return result, nil
}

// envPairInput 校验后的环境变量；value nil 表示空值。
type envPairInput struct {
	key   string
	value *string
}

func assertEnvValue(value string) error {
	if len(value) > envValueMaxBytes {
		return shared.InvalidRequest("环境变量值过长")
	}
	if hasControlChars(value) {
		return shared.InvalidRequest("环境变量值不能包含换行或控制字符")
	}
	return nil
}

func parseEnv(raw any) ([]envPairInput, error) {
	rows, ok := asArray(raw)
	if !ok {
		return nil, shared.InvalidRequest("env 须为数组")
	}
	if len(rows) > maxEnv {
		return nil, shared.InvalidRequest("环境变量不能超过 64 个")
	}
	seen := make(map[string]bool)
	env := make([]envPairInput, 0, len(rows))
	for index, row := range rows {
		record, ok := asRecord(row)
		if !ok {
			return nil, shared.InvalidRequest("env[" + itoa(index) + "] 无效")
		}
		key, ok := asString(mustGet(record, "key"))
		if !ok {
			return nil, shared.InvalidRequest("env[" + itoa(index) + "].key 无效")
		}
		if !envKeyPattern.MatchString(key) || len(key) > envKeyMax {
			return nil, shared.InvalidRequest("环境变量名无效")
		}
		if seen[key] {
			return nil, shared.InvalidRequest("环境变量名重复")
		}
		seen[key] = true
		rawValue, hasValue := record.get("value")
		if hasValue && rawValue == nil {
			// value: null 表示空值；缺省 value 键则视为非法（TS typeof undefined !== 'string'）。
			env = append(env, envPairInput{key: key, value: nil})
			continue
		}
		if !hasValue {
			return nil, shared.InvalidRequest("env[" + itoa(index) + "].value 无效")
		}
		value, ok := asString(rawValue)
		if !ok {
			return nil, shared.InvalidRequest("env[" + itoa(index) + "].value 无效")
		}
		if err := assertEnvValue(value); err != nil {
			return nil, err
		}
		env = append(env, envPairInput{key: key, value: &value})
	}
	return env, nil
}

// volumeInput 校验后的挂载（hostPath 保留原始输入，解析发生在 resolveBindSource）。
type volumeInput struct {
	hostPath      string
	containerPath string
}

func parseVolumes(raw any) ([]volumeInput, error) {
	rows, ok := asArray(raw)
	if !ok {
		return nil, shared.InvalidRequest("volumes 须为数组")
	}
	if len(rows) > maxMounts {
		return nil, shared.InvalidRequest("挂载不能超过 16 个")
	}
	volumes := make([]volumeInput, 0, len(rows))
	seenContainerPaths := make(map[string]bool)
	for index, row := range rows {
		record, ok := asRecord(row)
		if !ok {
			return nil, shared.InvalidRequest("volumes[" + itoa(index) + "] 无效")
		}
		hostPath, okHost := asString(mustGet(record, "hostPath"))
		containerPathRaw, okContainer := asString(mustGet(record, "containerPath"))
		if !okHost || !okContainer {
			return nil, shared.InvalidRequest("volumes[" + itoa(index) + "] 无效")
		}
		containerPath, err := normalizeAbsolutePath(containerPathRaw, "容器内挂载路径")
		if err != nil {
			return nil, err
		}
		if containerPath == "/" {
			return nil, shared.InvalidRequest("容器内挂载路径不能为根目录")
		}
		if seenContainerPaths[containerPath] {
			return nil, shared.InvalidRequest("容器内挂载路径重复")
		}
		seenContainerPaths[containerPath] = true
		volumes = append(volumes, volumeInput{hostPath: hostPath, containerPath: containerPath})
	}
	return volumes, nil
}

// createInput 校验后的创建输入。
type createInput struct {
	name          string
	nameProvided  bool
	imageID       string
	ports         []portMappingInput
	env           []envPairInput
	volumes       []volumeInput
	command       string
	commandSet    bool
	restartPolicy string
}

func parseCreateInput(body any) (createInput, error) {
	record, ok := asRecord(body)
	if !ok {
		return createInput{}, shared.InvalidRequest("请求体无效")
	}
	rawImageID, ok := asString(mustGet(record, "imageId"))
	if !ok || strings.TrimSpace(rawImageID) == "" {
		return createInput{}, shared.InvalidRequest("请选择镜像")
	}
	input := createInput{imageID: rawImageID}
	if rawName, has := record.get("name"); has {
		name, ok := asString(rawName)
		if !ok {
			return createInput{}, shared.InvalidRequest("名称无效")
		}
		trimmed := strings.TrimSpace(name)
		if trimmed != "" {
			input.name = trimmed
			input.nameProvided = true
		}
	}
	ports, err := parsePorts(defaultArray(record, "ports"))
	if err != nil {
		return createInput{}, err
	}
	input.ports = ports
	env, err := parseEnv(defaultArray(record, "env"))
	if err != nil {
		return createInput{}, err
	}
	input.env = env
	volumes, err := parseVolumes(defaultArray(record, "volumes"))
	if err != nil {
		return createInput{}, err
	}
	input.volumes = volumes
	if rawCommand, has := record.get("command"); has {
		if command, ok := asString(rawCommand); ok && strings.TrimSpace(command) != "" {
			input.command = command
			input.commandSet = true
		}
	}
	restartPolicy, err := parseRestartPolicy(defaultValue(record, "restartPolicy", "no"))
	if err != nil {
		return createInput{}, err
	}
	input.restartPolicy = restartPolicy
	return input, nil
}

// defaultArray TS `body.x ?? []` 的语义：键缺省或显式 null 都回落空数组。
func defaultArray(record *jsonObject, key string) any {
	if value, has := record.get(key); has && value != nil {
		return value
	}
	return []any{}
}

// defaultValue TS `body.x ?? fallback` 的语义：键缺省或显式 null 都回落缺省值。
func defaultValue(record *jsonObject, key string, fallback string) any {
	if value, has := record.get(key); has && value != nil {
		return value
	}
	return fallback
}

func assertResolvedUnderMountRoot(resolved, mountRoot string) error {
	root, err := normalizeMountRoot(mountRoot)
	if err != nil {
		return err
	}
	normalized, err := normalizeAbsolutePath(resolved, "挂载路径")
	if err != nil {
		return err
	}
	if normalized != root && !strings.HasPrefix(normalized, root+"/") {
		return shared.InvalidRequest("挂载路径超出允许范围")
	}
	return nil
}

// resolveBindSource 解析绑定挂载源：目标不存在时逐级上溯 realpath，解析结果必须
// 仍在挂载根下；目标不存在时产出逐级 mkdir 表。
func resolveBindSource(hostPath, mountRoot string, realpath func(string) (string, error)) (source string, mkdirPaths []string, err error) {
	root, err := normalizeMountRoot(mountRoot)
	if err != nil {
		return "", nil, err
	}
	normalized, err := normalizeAbsolutePath(hostPath, "宿主机挂载路径")
	if err != nil {
		return "", nil, err
	}
	if normalized == root {
		return "", nil, shared.InvalidRequest("不能将挂载根目录挂载进容器")
	}
	if !strings.HasPrefix(normalized, root+"/") {
		return "", nil, shared.InvalidRequest("绑定挂载路径须位于 " + root + " 之下")
	}

	ancestor := normalized
	resolvedAncestor := ""
	for {
		resolved, err := realpath(ancestor)
		if err == nil {
			resolvedAncestor = resolved
			break
		}
		var invalid *shared.InvalidRequestError
		if errors.As(err, &invalid) {
			return "", nil, err
		}
		if isENOENT(err) {
			if ancestor == root {
				resolvedRoot, err := realpath(root)
				if err != nil {
					return "", nil, err
				}
				resolvedAncestor = resolvedRoot
				break
			}
			ancestor = parentDirOf(ancestor)
			continue
		}
		return "", nil, err
	}
	if err := assertResolvedUnderMountRoot(resolvedAncestor, root); err != nil {
		return "", nil, err
	}

	dirs := []string{}
	if ancestor != normalized {
		segments := strings.Split(normalized[len(root)+1:], "/")
		current := root
		for _, segment := range segments {
			current = current + "/" + segment
			dirs = append(dirs, current)
		}
	}
	return normalized, dirs, nil
}

func assertPortAvailable(port portMappingInput, reservedPorts []int, containers []containerBrief, pending []portMappingInput) error {
	for _, reserved := range reservedPorts {
		if reserved == port.hostPort {
			return shared.InvalidRequest("宿主端口为面板保留：" + itoa(port.hostPort))
		}
	}
	hostIP := effectiveHostIP(port.hostIP)
	matches := func(entry portBrief) bool {
		return entry.hostPort == port.hostPort &&
			entry.protocol == port.protocol &&
			hostIPsOverlap(hostIP, effectiveHostIP(entry.hostIP))
	}
	for _, container := range containers {
		for _, entry := range container.ports {
			if matches(entry) {
				return shared.InvalidRequest("宿主端口已被占用：" + itoa(port.hostPort) + "/" + port.protocol)
			}
		}
	}
	for _, other := range pending {
		if other.hostPort == port.hostPort &&
			other.protocol == port.protocol &&
			hostIPsOverlap(hostIP, effectiveHostIP(other.hostIP)) {
			return shared.InvalidRequest("宿主端口已被占用：" + itoa(port.hostPort) + "/" + port.protocol)
		}
	}
	return nil
}

// ---- Engine create 体（白名单，结构体字段序即 JSON 键序） ----

type enginePortBindingEntry struct {
	HostPort string `json:"HostPort"`
	HostIP   string `json:"HostIp"`
}

type engineRestartPolicy struct {
	Name              string `json:"Name"`
	MaximumRetryCount *int   `json:"MaximumRetryCount,omitempty"`
}

type engineMount struct {
	Type   string `json:"Type"`
	Source string `json:"Source"`
	Target string `json:"Target"`
}

type engineHostConfig struct {
	RestartPolicy engineRestartPolicy                 `json:"RestartPolicy"`
	PortBindings  map[string][]enginePortBindingEntry `json:"PortBindings,omitempty"`
	Mounts        []engineMount                       `json:"Mounts,omitempty"`
}

type engineCreateBody struct {
	Image      string            `json:"Image"`
	Labels     map[string]string `json:"Labels"`
	HostConfig engineHostConfig  `json:"HostConfig"`
	Cmd        []string          `json:"Cmd,omitempty"`
	Env        []string          `json:"Env,omitempty"`
}

func buildRestartPolicy(policy string) engineRestartPolicy {
	if policy == "on-failure" {
		zero := 0
		return engineRestartPolicy{Name: "on-failure", MaximumRetryCount: &zero}
	}
	return engineRestartPolicy{Name: policy}
}

// buildCreateSpec 校验输入并组装 create 体；重名 409，其余校验失败 400。
func buildCreateSpec(input buildCreateSpecInput) (buildCreateSpecResult, error) {
	createInputParsed, err := parseCreateInput(input.body)
	if err != nil {
		return buildCreateSpecResult{}, err
	}
	imageHex, err := normalizeCreateImageID(createInputParsed.imageID)
	if err != nil {
		return buildCreateSpecResult{}, err
	}
	var selectedImage *imageBrief
	for i := range input.images {
		normalized, err := normalizeCreateImageID(input.images[i].id)
		if err == nil && normalized == imageHex {
			selectedImage = &input.images[i]
			break
		}
	}
	if selectedImage == nil {
		return buildCreateSpecResult{}, shared.InvalidRequest("镜像不存在，无法创建容器")
	}

	name := createInputParsed.name
	if name != "" {
		if !namePattern.MatchString(name) {
			return buildCreateSpecResult{}, shared.InvalidRequest("名称须以字母或数字开头，仅含字母、数字、下划线、点与连字符")
		}
		for _, container := range input.containers {
			if container.name == name {
				return buildCreateSpecResult{}, &shared.InvalidRequestError{Status: 409, Message: "容器名称已存在：" + name}
			}
		}
	} else {
		existing := make([]string, len(input.containers))
		for i, container := range input.containers {
			existing[i] = container.name
		}
		name = autoContainerName(existing, selectedImage.name)
		for _, container := range input.containers {
			if container.name == name {
				return buildCreateSpecResult{}, &shared.InvalidRequestError{Status: 409, Message: "容器名称已存在：" + name}
			}
		}
	}

	pendingPorts := make([]portMappingInput, 0, len(createInputParsed.ports))
	for _, port := range createInputParsed.ports {
		if err := assertPortAvailable(port, input.reservedPorts, input.containers, pendingPorts); err != nil {
			return buildCreateSpecResult{}, err
		}
		pendingPorts = append(pendingPorts, port)
	}

	var cmd []string
	if createInputParsed.commandSet {
		args, err := parseShellWords(createInputParsed.command)
		if err != nil {
			return buildCreateSpecResult{}, shared.InvalidRequest(err.Error())
		}
		if len(args) > 0 {
			cmd = args
		}
	}

	var envStrings []string
	if len(createInputParsed.env) > 0 {
		envStrings = make([]string, 0, len(createInputParsed.env))
		for _, pair := range createInputParsed.env {
			value := ""
			if pair.value != nil {
				value = *pair.value
			}
			envStrings = append(envStrings, pair.key+"="+value)
		}
	}

	type resolvedMount struct {
		source        string
		containerPath string
	}
	resolvedMounts := make([]resolvedMount, 0, len(createInputParsed.volumes))
	mkdirPaths := []string{}
	for _, volume := range createInputParsed.volumes {
		source, dirs, err := resolveBindSource(volume.hostPath, input.mountRoot, input.realpath)
		if err != nil {
			return buildCreateSpecResult{}, err
		}
		resolvedMounts = append(resolvedMounts, resolvedMount{source: source, containerPath: volume.containerPath})
		for _, dir := range dirs {
			if !containsString(mkdirPaths, dir) {
				mkdirPaths = append(mkdirPaths, dir)
			}
		}
	}

	hostConfig := engineHostConfig{RestartPolicy: buildRestartPolicy(createInputParsed.restartPolicy)}
	if len(createInputParsed.ports) > 0 {
		bindings := make(map[string][]enginePortBindingEntry)
		for _, port := range createInputParsed.ports {
			key := itoa(port.containerPort) + "/" + port.protocol
			bindings[key] = append(bindings[key], enginePortBindingEntry{
				HostPort: itoa(port.hostPort),
				HostIP:   effectiveHostIP(port.hostIP),
			})
		}
		hostConfig.PortBindings = bindings
	}
	if len(createInputParsed.volumes) > 0 {
		mounts := make([]engineMount, 0, len(resolvedMounts))
		for _, mount := range resolvedMounts {
			mounts = append(mounts, engineMount{Type: "bind", Source: mount.source, Target: mount.containerPath})
		}
		hostConfig.Mounts = mounts
	}

	body := engineCreateBody{
		Image:      imageHex,
		Labels:     map[string]string{labelManaged: labelTrueValue},
		HostConfig: hostConfig,
		Cmd:        cmd,
		Env:        envStrings,
	}
	encoded, err := encodeCreateBody(body)
	if err != nil {
		return buildCreateSpecResult{}, err
	}
	return buildCreateSpecResult{name: name, createBody: encoded, mkdirPaths: mkdirPaths}, nil
}

// encodeCreateBody 用共享 JSON 出口编码（SetEscapeHTML(false)，键序即字段声明序）。
func encodeCreateBody(body engineCreateBody) ([]byte, error) {
	return shared.MarshalJSON(body)
}

func containsString(list []string, value string) bool {
	for _, item := range list {
		if item == value {
			return true
		}
	}
	return false
}

// defaultRealpath 真实装配的路径解析注入（符号链接全解析，fs.realpath 等价）。
func defaultRealpath(path string) (string, error) {
	return filepath.EvalSymlinks(path)
}
