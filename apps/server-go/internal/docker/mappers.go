package docker

import (
	"errors"
	"math"
	"sort"
	"strings"
	"time"

	"elysian/server/internal/contract"
)

// Engine inspect JSON → 契约视图的映射（dockerMappers.ts 逐字移植）。
// 错误消息（「容器详情格式无效：…」/「镜像详情格式无效：…」）是 API 契约。

var pulledAtEpoch = time.Date(1980, 1, 1, 0, 0, 0, 0, time.UTC)

func requireString(value any, message string) (string, error) {
	s, ok := asString(value)
	if !ok {
		return "", errors.New(message)
	}
	return s, nil
}

func stripSha256Prefix(id string) string {
	return strings.TrimPrefix(id, "sha256:")
}

// mapEngineStatus running/restarting/paused 原样，其余一律 stopped。
func mapEngineStatus(status string) string {
	switch status {
	case "running", "restarting", "paused":
		return status
	default:
		return "stopped"
	}
}

func isZeroDockerTime(value string) bool {
	return strings.HasPrefix(value, "0001-01-01")
}

func shellQuoteToken(token string) string {
	needsQuote := strings.ContainsAny(token, " \t\n\r'\"")
	if !needsQuote {
		return token
	}
	// 内部每个 ' 转为 引-反斜杠-引-引 四字符序列（TS `'\\''`）。
	escaped := "'" + "\\" + "''"
	return "'" + strings.ReplaceAll(token, "'", escaped) + "'"
}

func buildCommand(path string, args []string) string {
	parts := make([]string, 0, len(args)+1)
	if path != "" {
		parts = append(parts, path)
	}
	for _, arg := range args {
		if arg != "" {
			parts = append(parts, arg)
		}
	}
	if len(parts) == 0 {
		return ""
	}
	quoted := make([]string, len(parts))
	for i, part := range parts {
		quoted[i] = shellQuoteToken(part)
	}
	return strings.Join(quoted, " ")
}

func parseEnvLine(line string) (key, value string, err error) {
	eq := strings.IndexByte(line, '=')
	if eq <= 0 {
		return "", "", errors.New("容器详情格式无效：环境变量行格式错误")
	}
	return line[:eq], line[eq+1:], nil
}

func parsePortKey(key string) (containerPort int, protocol string, err error) {
	slash := strings.LastIndexByte(key, '/')
	if slash <= 0 {
		return 0, "", errors.New("容器详情格式无效：端口绑定键格式错误")
	}
	portPart := key[:slash]
	protocolPart := key[slash+1:]
	if protocolPart != "tcp" && protocolPart != "udp" {
		return 0, "", errors.New("容器详情格式无效：端口协议无效")
	}
	port, ok := parseJSONNumber(portPart)
	if !ok || !isFiniteNumber(port) || math.Floor(port) != port || port < 1 || port > 65535 {
		return 0, "", errors.New("容器详情格式无效：容器端口无效")
	}
	return int(port), protocolPart, nil
}

type rawPortBind struct {
	hostIP        string
	hostPort      int
	containerPort int
	protocol      string
}

// mapPortBindings 按 Engine 原文键序遍历 PortBindings；同组同时有 0.0.0.0 与 ::
// 绑定时合并为一条 hostIp 0.0.0.0，空 HostPort 跳过，hostIp 为空串时省略该字段。
func mapPortBindings(bindings *jsonObject) ([]contract.PortBindingView, error) {
	raw := make([]rawPortBind, 0)
	for _, key := range bindings.orderedKeys() {
		containerPort, protocol, err := parsePortKey(key)
		if err != nil {
			return nil, err
		}
		entries, ok := asArray(mustGet(bindings, key))
		if !ok {
			continue
		}
		for _, entry := range entries {
			record, ok := asRecord(entry)
			if !ok {
				continue
			}
			hostPortStr, ok := asString(mustGet(record, "HostPort"))
			if !ok || hostPortStr == "" {
				continue
			}
			hostPortF, ok := parseJSONNumber(hostPortStr)
			if !ok || !isFiniteNumber(hostPortF) || math.Floor(hostPortF) != hostPortF {
				return nil, errors.New("容器详情格式无效：宿主端口无效")
			}
			hostIP, _ := asString(mustGet(record, "HostIp"))
			raw = append(raw, rawPortBind{hostIP: hostIP, hostPort: int(hostPortF), containerPort: containerPort, protocol: protocol})
		}
	}

	type groupKey struct {
		port     int
		protocol string
	}
	groups := make([]groupKey, 0)
	groupMap := make(map[groupKey][]rawPortBind)
	for _, bind := range raw {
		key := groupKey{port: bind.containerPort, protocol: bind.protocol}
		if _, seen := groupMap[key]; !seen {
			groups = append(groups, key)
		}
		groupMap[key] = append(groupMap[key], bind)
	}

	result := make([]contract.PortBindingView, 0)
	for _, key := range groups {
		group := groupMap[key]
		hasV4, hasV6 := false, false
		for _, b := range group {
			if b.hostIP == "0.0.0.0" {
				hasV4 = true
			}
			if b.hostIP == "::" {
				hasV6 = true
			}
		}
		if hasV4 && hasV6 {
			sample := rawPortBind{}
			for _, b := range group {
				if b.hostIP == "0.0.0.0" {
					sample = b
					break
				}
			}
			if sample.hostIP == "" {
				sample = group[0]
			}
			result = append(result, contract.PortBindingView{
				ContainerPort: sample.containerPort,
				HostPort:      sample.hostPort,
				Protocol:      sample.protocol,
				HostIP:        "0.0.0.0",
			})
			continue
		}
		for _, bind := range group {
			mapping := contract.PortBindingView{
				ContainerPort: bind.containerPort,
				HostPort:      bind.hostPort,
				Protocol:      bind.protocol,
			}
			if bind.hostIP != "" {
				mapping.HostIP = bind.hostIP
			}
			result = append(result, mapping)
		}
	}
	return result, nil
}

func mustGet(o *jsonObject, key string) any {
	v, _ := o.get(key)
	return v
}

// parseJSONNumber JS Number(s) 的近似：接受十进制整数字符串（端口键的取值域），
// 非法回 false。十六进制/前导空白等 JS 宽容形态不在 Engine 端口键取值域内。
func parseJSONNumber(s string) (float64, bool) {
	if s == "" {
		return 0, false
	}
	n := 0.0
	seenDigit := false
	for i := 0; i < len(s); i++ {
		ch := s[i]
		if ch < '0' || ch > '9' {
			return 0, false
		}
		n = n*10 + float64(ch-'0')
		seenDigit = true
	}
	return n, seenDigit
}

func mapMounts(mounts any) ([]contract.VolumeMount, error) {
	entries, ok := asArray(mounts)
	if !ok {
		return nil, errors.New("容器详情格式无效：Mounts 必须是数组")
	}
	result := make([]contract.VolumeMount, 0, len(entries))
	for _, entry := range entries {
		record, ok := asRecord(entry)
		if !ok {
			return nil, errors.New("容器详情格式无效：挂载项格式错误")
		}
		mountType, err := requireString(mustGet(record, "Type"), "容器详情格式无效：挂载类型无效")
		if err != nil {
			return nil, err
		}
		destination, err := requireString(mustGet(record, "Destination"), "容器详情格式无效：挂载目标路径无效")
		if err != nil {
			return nil, err
		}
		switch mountType {
		case "bind":
			source, err := requireString(mustGet(record, "Source"), "容器详情格式无效：bind 挂载源无效")
			if err != nil {
				return nil, err
			}
			result = append(result, contract.VolumeMount{HostPath: source, ContainerPath: destination, Kind: "bind"})
		case "volume":
			name, err := requireString(mustGet(record, "Name"), "容器详情格式无效：卷名无效")
			if err != nil {
				return nil, err
			}
			result = append(result, contract.VolumeMount{HostPath: name, ContainerPath: destination, Kind: "volume"})
		case "tmpfs":
			result = append(result, contract.VolumeMount{HostPath: "", ContainerPath: destination, Kind: "tmpfs"})
		default:
			return nil, errors.New("容器详情格式无效：未知挂载类型")
		}
	}
	return result, nil
}

func mapRestartPolicy(name any) string {
	s, ok := asString(name)
	if !ok {
		return "no"
	}
	if restartPolicyWhitelist[s] {
		return s
	}
	return "no"
}

func resolveStartedAt(status string, startedAt any) (string, bool) {
	switch status {
	case "running", "restarting", "paused":
	default:
		return "", false
	}
	s, ok := asString(startedAt)
	if !ok || isZeroDockerTime(s) {
		return "", false
	}
	return s, true
}

// mapContainer Engine inspect → contract.Container；形状无效返回「容器详情格式无效…」。
func mapContainer(inspect any) (contract.Container, error) {
	record, ok := asRecord(inspect)
	if !ok {
		return contract.Container{}, errors.New("容器详情格式无效：根对象必须是对象")
	}

	rawID, err := requireString(mustGet(record, "Id"), "容器详情格式无效：缺少 Id")
	if err != nil {
		return contract.Container{}, err
	}
	id := stripSha256Prefix(rawID)
	nameRaw, err := requireString(mustGet(record, "Name"), "容器详情格式无效：缺少 Name")
	if err != nil {
		return contract.Container{}, err
	}
	name := strings.TrimPrefix(nameRaw, "/")

	state, ok := asRecord(mustGet(record, "State"))
	if !ok {
		return contract.Container{}, errors.New("容器详情格式无效：缺少 State")
	}
	engineStatus, err := requireString(mustGet(state, "Status"), "容器详情格式无效：缺少 State.Status")
	if err != nil {
		return contract.Container{}, err
	}
	status := mapEngineStatus(engineStatus)
	startedAt, hasStartedAt := resolveStartedAt(status, mustGet(state, "StartedAt"))

	createdAt, err := requireString(mustGet(record, "Created"), "容器详情格式无效：缺少 Created")
	if err != nil {
		return contract.Container{}, err
	}

	config, ok := asRecord(mustGet(record, "Config"))
	if !ok {
		return contract.Container{}, errors.New("容器详情格式无效：缺少 Config")
	}
	imageRef, hasImageRef := asString(mustGet(config, "Image"))

	var env []contract.EnvPair
	envLines, hasEnv := config.get("Env")
	if hasEnv {
		lines, ok := asArray(envLines)
		if !ok {
			return contract.Container{}, errors.New("容器详情格式无效：Config.Env 必须是数组")
		}
		env = make([]contract.EnvPair, 0, len(lines))
		for _, line := range lines {
			lineStr, ok := asString(line)
			if !ok {
				return contract.Container{}, errors.New("容器详情格式无效：环境变量行必须是字符串")
			}
			key, value, err := parseEnvLine(lineStr)
			if err != nil {
				return contract.Container{}, err
			}
			pair := contract.EnvPair{Key: key, Value: &value}
			if isSensitiveEnvKey(key) {
				pair.Value = nil
			}
			env = append(env, pair)
		}
	} else {
		env = []contract.EnvPair{}
	}

	hostConfig, ok := asRecord(mustGet(record, "HostConfig"))
	if !ok {
		return contract.Container{}, errors.New("容器详情格式无效：缺少 HostConfig")
	}
	portBindings, ok := asRecord(mustGet(hostConfig, "PortBindings"))
	if !ok {
		portBindings = newJSONObject()
	}
	ports, err := mapPortBindings(portBindings)
	if err != nil {
		return contract.Container{}, err
	}
	if ports == nil {
		ports = []contract.PortBindingView{}
	}

	var restartName any
	if policy, ok := asRecord(mustGet(hostConfig, "RestartPolicy")); ok {
		restartName = mustGet(policy, "Name")
	}
	restartPolicy := mapRestartPolicy(restartName)

	path, _ := asString(mustGet(record, "Path"))
	var args []string
	if rawArgs, ok := asArray(mustGet(record, "Args")); ok {
		for _, arg := range rawArgs {
			if s, ok := asString(arg); ok {
				args = append(args, s)
			}
		}
	}
	command := buildCommand(path, args)

	volumes, err := mapMounts(mustGet(record, "Mounts"))
	if err != nil {
		return contract.Container{}, err
	}
	if volumes == nil {
		volumes = []contract.VolumeMount{}
	}

	rawImage, err := requireString(mustGet(record, "Image"), "容器详情格式无效：缺少 Image")
	if err != nil {
		return contract.Container{}, err
	}
	imageID := stripSha256Prefix(rawImage)

	container := contract.Container{
		ID:            id,
		Name:          name,
		Status:        status,
		ImageID:       imageID,
		Ports:         ports,
		CreatedAt:     createdAt,
		Command:       command,
		Env:           env,
		Volumes:       volumes,
		RestartPolicy: restartPolicy,
	}
	if hasImageRef {
		container.ImageRef = imageRef
	}
	if hasStartedAt {
		container.StartedAt = startedAt
	}
	return container, nil
}

func parseRepoTag(repoTag string) (name, tag string) {
	colon := strings.LastIndexByte(repoTag, ':')
	if colon <= 0 {
		return repoTag, "<none>"
	}
	name = repoTag[:colon]
	tag = repoTag[colon+1:]
	if tag == "" {
		return repoTag, "<none>"
	}
	return name, tag
}

func resolveDigest(inspect *jsonObject, idWithoutPrefix string) string {
	if digests, ok := asArray(mustGet(inspect, "RepoDigests")); ok && len(digests) > 0 {
		if first, ok := asString(digests[0]); ok && first != "" {
			return first
		}
	}
	shortID := idWithoutPrefix
	if len(shortID) > 12 {
		shortID = shortID[:12]
	}
	return "sha256:" + shortID
}

func resolvePulledAt(created any) *string {
	s, ok := asString(created)
	if !ok || isZeroDockerTime(s) {
		return nil
	}
	parsed, err := time.Parse(time.RFC3339, s)
	if err != nil || parsed.Before(pulledAtEpoch) {
		return nil
	}
	return &s
}

// repoTagCompare localeCompare 的 ASCII 近似（盘点风险 2）：先按小写折叠序比较、
// 平手再按原串字节序。仓库标签取值域（小写字母、数字、: / . _ -）内与 ICU 结果一致。
func repoTagCompare(a, b string) bool {
	la, lb := strings.ToLower(a), strings.ToLower(b)
	if la != lb {
		return la < lb
	}
	return a < b
}

// mapImage 镜像摘要 + 详情 → contract.ContainerImage。
func mapImage(summary, inspect any) (contract.ContainerImage, error) {
	summaryRecord, ok := asRecord(summary)
	if !ok {
		return contract.ContainerImage{}, errors.New("镜像详情格式无效：摘要必须是对象")
	}
	inspectRecord, ok := asRecord(inspect)
	if !ok {
		return contract.ContainerImage{}, errors.New("镜像详情格式无效：详情必须是对象")
	}

	rawID, hasID := asString(mustGet(inspectRecord, "Id"))
	if !hasID {
		rawID, hasID = asString(mustGet(summaryRecord, "Id"))
	}
	if !hasID {
		return contract.ContainerImage{}, errors.New("镜像详情格式无效：缺少 Id")
	}
	id := stripSha256Prefix(rawID)

	sizeRaw, ok := asNumber(mustGet(inspectRecord, "Size"))
	if !ok || !isFiniteNumber(sizeRaw) {
		return contract.ContainerImage{}, errors.New("镜像详情格式无效：Size 无效")
	}
	sizeMB := int(math.Round(sizeRaw / 1_000_000))

	pulledAt := resolvePulledAt(mustGet(inspectRecord, "Created"))

	repoTags := []string{}
	if repoTagsRaw, has := inspectRecord.get("RepoTags"); has {
		rawTags, ok := asArray(repoTagsRaw)
		if !ok {
			return contract.ContainerImage{}, errors.New("镜像详情格式无效：RepoTags 必须是数组")
		}
		for _, tag := range rawTags {
			tagStr, ok := asString(tag)
			if !ok {
				return contract.ContainerImage{}, errors.New("镜像详情格式无效：RepoTags 项必须是字符串")
			}
			repoTags = append(repoTags, tagStr)
		}
	}

	digest := resolveDigest(inspectRecord, id)

	if len(repoTags) == 0 {
		return contract.ContainerImage{
			ID:       id,
			Name:     "<none>",
			Tag:      "<none>",
			Digest:   digest,
			SizeMB:   sizeMB,
			PulledAt: pulledAt,
		}, nil
	}

	sorted := append([]string(nil), repoTags...)
	sort.SliceStable(sorted, func(i, j int) bool { return repoTagCompare(sorted[i], sorted[j]) })
	primaryName, primaryTag := parseRepoTag(sorted[0])
	otherTags := sorted[1:]

	image := contract.ContainerImage{
		ID:       id,
		Name:     primaryName,
		Tag:      primaryTag,
		Digest:   digest,
		SizeMB:   sizeMB,
		PulledAt: pulledAt,
	}
	if len(otherTags) > 0 {
		image.OtherTags = otherTags
	}
	return image, nil
}
