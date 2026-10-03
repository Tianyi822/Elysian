package websites

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"elysian/server/internal/contract"
	"elysian/server/internal/seam"
	"elysian/server/internal/shared"
)

/*
 * 网站域的 Engine API 操作层（websitesDocker.ts 逐字移植，经 docker 域
 * seam.DockerTransport，API 前缀 /v1.41 由传输层拼接）：建容器（官方镜像、bind 站点
 * 目录、127.0.0.1 同号端口、标签身份）、启停、inspect、日志读取（帧头剥离）、五重核对
 * 删除与站点目录的 realpath 防护。容器名服务端生成（elysian-site- + 随机 hex，不掺
 * 用户输入——项目名可含中文，不能进容器名）。
 */

const (
	engineRequestTimeout = 15 * time.Second
	engineMaxBytes       = 4 * 1024 * 1024
	logTailLines         = "200"
	logMaxBytes          = 1024 * 1024
	siteAppTarget        = "/app"
	siteHTMLTarget       = "/usr/share/nginx/html"
)

var (
	containerIDPattern       = regexp.MustCompile(`^[a-f0-9]{64}$`)
	siteContainerNamePattern = regexp.MustCompile(`^elysian-site-[0-9a-f]{12}$`)
)

// containerCreateInput 建容器入参。
type containerCreateInput struct {
	ImageRef      string
	Kind          string
	Version       string
	ProjectID     string
	Port          int
	BindSource    string
	AccessMode    string
	Command       *string // nil → 缺省命令
	ContainerName string
}

// containerIdentity 五重核对删除的身份四元组 + 自容器保护。
type containerIdentity struct {
	ContainerID     string
	ContainerName   string
	ProjectID       string
	Kind            string
	Version         string
	ImageRef        string
	RootDir         string
	SelfContainerID string
}

// dockerOps 网站域对引擎操作层的视图（生产实现走 seam.DockerTransport；测试注入假件）。
type dockerOps interface {
	EnsureImage(ctx context.Context, ref string) error
	EnsureSiteDir(name string, mountRoot string) (string, error)
	NewContainerName() string
	Create(ctx context.Context, input containerCreateInput) (string, error)
	Start(ctx context.Context, id string) error
	Stop(ctx context.Context, id string) error
	Inspect(ctx context.Context, id string) (map[string]any, error)
	Logs(ctx context.Context, id string) ([]string, error)
	RemoveManaged(ctx context.Context, identity containerIdentity) (string, error) // "removed"|"missing"
	RemoveCreated(ctx context.Context, containerID string) error
	RemoveSiteDir(rootDir string, mountRoot string) error
}

// NewWebsiteDocker 生产实现：transport 为 docker 域引擎传输器，listImages 为容器片
// 共享的镜像视图；fs 钩子留测试注入位。
func NewWebsiteDocker(transport seam.DockerTransport, listImages func(ctx context.Context) ([]contract.ContainerImage, error)) dockerOps {
	return &websiteDocker{
		transport:  transport,
		listImages: listImages,
	}
}

// websiteDocker Engine 操作层实现。
type websiteDocker struct {
	transport  seam.DockerTransport
	listImages func(ctx context.Context) ([]contract.ContainerImage, error)
	// fs 钩子（测试注入；nil 落真实文件系统）。
	mkdir    func(path string, mode os.FileMode) error
	realpath func(path string) (string, error)
	rm       func(path string) error
}

// isValidSiteContainerName 容器名正则核对（五重核对第一环）。
func isValidSiteContainerName(name string) bool {
	return siteContainerNamePattern.MatchString(name)
}

// WebsiteContainerCmd 站点容器启动命令的 argv 形：由契约的 WebsiteDefaultDeployCommand
// （显示字符串的单一事实来源）推导——node 的脚本参数含空格，不能按空白切分，手写
// shell 风格切词（支持单/双引号与反斜杠转义，单引号内不转义），不经 shell。
func WebsiteContainerCmd(kind string, command *string) ([]string, error) {
	if kind == KindHTML {
		return []string{"nginx", "-g", "daemon off;"}, nil
	}
	if command == nil || strings.TrimSpace(*command) == "" {
		return nil, shared.InvalidRequest("请填写容器启动命令")
	}
	text := *command
	if utf16Length(text) > 2048 || hasControlChars(text) {
		return nil, shared.InvalidRequest("启动命令无效")
	}
	var args []string
	var current strings.Builder
	quote := byte(0)
	escaped := false
	started := false
	for i := 0; i < len(text); i++ {
		char := text[i]
		if escaped {
			current.WriteByte(char)
			escaped = false
			started = true
			continue
		}
		if char == '\\' && quote != '\'' {
			escaped = true
			continue
		}
		if char == '\'' && quote != '"' {
			if quote == '\'' {
				quote = 0
			} else {
				quote = '\''
			}
			started = true
			continue
		}
		if char == '"' && quote != '\'' {
			if quote == '"' {
				quote = 0
			} else {
				quote = '"'
			}
			started = true
			continue
		}
		if isWhitespace(char) && quote == 0 {
			if started {
				args = append(args, current.String())
				current.Reset()
				started = false
			}
			continue
		}
		current.WriteByte(char)
		started = true
	}
	if quote != 0 || escaped {
		return nil, shared.InvalidRequest("启动命令的引号或转义不完整")
	}
	if started {
		args = append(args, current.String())
	}
	if len(args) == 0 || args[0] == "" {
		return nil, shared.InvalidRequest("请填写容器启动命令")
	}
	return args, nil
}

// hasControlChars 判定 C0+DEL 控制字符。
func hasControlChars(text string) bool {
	for i := 0; i < len(text); i++ {
		if text[i] < 0x20 || text[i] == 0x7f {
			return true
		}
	}
	return false
}

// isWhitespace 与 JS \s 同口径的空白集（空格、\t\n\v\f\r、NBSP 及 Unicode 空白里
// 命令切词实际会遇到的 ASCII 部分）。
func isWhitespace(char byte) bool {
	switch char {
	case ' ', '\t', '\n', '\v', '\f', '\r':
		return true
	}
	return false
}

// normalizeMountRoot 挂载根归一化：必须是绝对路径、无结尾斜杠、不含路径穿越段
// （对齐 createSpec 口径）。
func normalizeMountRoot(mountRoot string) (string, error) {
	trimmed := strings.TrimSpace(mountRoot)
	if !strings.HasPrefix(trimmed, "/") || strings.Contains(trimmed, "..") || hasControlChars(trimmed) {
		return "", shared.InvalidRequest(fmt.Sprintf("无效的挂载根：%s", mountRoot))
	}
	segments := strings.Split(trimmed, "/")
	parts := make([]string, 0, len(segments))
	for _, segment := range segments {
		if segment != "" {
			parts = append(parts, segment)
		}
	}
	return "/" + strings.Join(parts, "/"), nil
}

func wwwrootBase(mountRoot string) (string, error) {
	root, err := normalizeMountRoot(mountRoot)
	if err != nil {
		return "", err
	}
	return root + "/wwwroot", nil
}

// request 一次引擎请求：timeout 15s、响应 4 MiB 上限；传输层错误原样上抛。
func (d *websiteDocker) request(ctx context.Context, method, path string, query urlValues, body []byte) (int, any, error) {
	response, err := d.transport.Request(ctx, seam.EngineRequest{
		Method:   method,
		Path:     path,
		Query:    query.values(),
		Body:     body,
		Timeout:  engineRequestTimeout,
		MaxBytes: engineMaxBytes,
	})
	if err != nil {
		return 0, nil, err
	}
	var parsed any
	if len(response.Body) > 0 {
		if err := json.Unmarshal(response.Body, &parsed); err != nil {
			return response.Status, nil, errorsNew("Docker 响应不是有效 JSON")
		}
	}
	return response.Status, parsed, nil
}

// urlValues 查询参数的小包装（nil 安全）。
type urlValues map[string]string

func (v urlValues) values() map[string][]string {
	if len(v) == 0 {
		return nil
	}
	out := make(map[string][]string, len(v))
	for key, value := range v {
		out[key] = []string{value}
	}
	return out
}

func errorsNew(message string) error { return fmt.Errorf("%s", message) }

// Inspect 引擎 inspect：id 形态校验、404 →「站点容器已不存在」、非 200 →
// 「读取站点容器失败」、Id 与请求不一致 →「容器身份核对失败」。
func (d *websiteDocker) Inspect(ctx context.Context, id string) (map[string]any, error) {
	if !containerIDPattern.MatchString(id) {
		return nil, shared.InvalidRequest("容器 ID 无效")
	}
	status, parsed, err := d.request(ctx, http.MethodGet, "/containers/"+id+"/json", nil, nil)
	if err != nil {
		return nil, err
	}
	if status == http.StatusNotFound {
		return nil, &shared.InvalidRequestError{Status: 404, Message: "站点容器已不存在"}
	}
	if status != http.StatusOK {
		return nil, errorsNew("读取站点容器失败")
	}
	info := object(parsed)
	if text, ok := asString(info["Id"]); !ok || text != id {
		return nil, errorsNew("容器身份核对失败")
	}
	return info, nil
}

// EnsureImage 对容器片共享的镜像视图按 name:tag 与 otherTags 精确匹配；
// 面板不代拉镜像，缺失 409。
func (d *websiteDocker) EnsureImage(ctx context.Context, ref string) error {
	if ref == "" {
		return shared.InvalidRequest("镜像引用无效")
	}
	images, err := d.listImages(ctx)
	if err != nil {
		return err
	}
	for _, image := range images {
		if image.Name+":"+image.Tag == ref {
			return nil
		}
		for _, candidate := range image.OtherTags {
			if candidate == ref {
				return nil
			}
		}
	}
	return &shared.InvalidRequestError{Status: 409, Message: fmt.Sprintf("指定版本的运行时镜像尚未拉取：%s", ref)}
}

// EnsureSiteDir mkdir 站点目录并 realpath 复核仍在归一化 `<mountRoot>/wwwroot` 之下
// （防符号链接逃逸）。返回构造路径（非 realpath 结果），登记固化该值。
func (d *websiteDocker) EnsureSiteDir(name string, mountRoot string) (string, error) {
	base, err := wwwrootBase(mountRoot)
	if err != nil {
		return "", err
	}
	dir := base + "/" + name
	if d.mkdir != nil {
		if err := d.mkdir(dir, 0o755); err != nil {
			return "", err
		}
	} else if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	resolved, err := d.realpathOf(dir)
	if err != nil {
		return "", err
	}
	if resolved != base && !strings.HasPrefix(resolved, base+"/") {
		return "", shared.InvalidRequest("站点目录经过符号链接，已拒绝")
	}
	return dir, nil
}

func (d *websiteDocker) realpathOf(path string) (string, error) {
	if d.realpath != nil {
		return d.realpath(path)
	}
	return filepath.EvalSymlinks(path)
}

// NewContainerName 服务端生成容器名：elysian-site- + 12 位随机 hex，不掺用户输入。
func (d *websiteDocker) NewContainerName() string {
	buf := make([]byte, 6)
	if _, err := rand.Read(buf); err != nil {
		panic(fmt.Sprintf("系统随机源不可用：%v", err))
	}
	return "elysian-site-" + hex.EncodeToString(buf)
}

// engineCreateBody 容器创建请求体（键序即 TS 对象插入序）。
type engineCreateBody struct {
	WorkingDir   string              `json:"WorkingDir,omitempty"`
	Image        string              `json:"Image"`
	Cmd          []string            `json:"Cmd"`
	Labels       map[string]string   `json:"Labels"`
	HostConfig   engineHostConfig    `json:"HostConfig"`
	ExposedPorts map[string]struct{} `json:"ExposedPorts"`
}

type engineHostConfig struct {
	Binds         []string                       `json:"Binds"`
	PortBindings  map[string][]enginePortBinding `json:"PortBindings"`
	RestartPolicy engineRestartPolicy            `json:"RestartPolicy"`
}

type enginePortBinding struct {
	HostIp   string `json:"HostIp"`
	HostPort string `json:"HostPort"`
}

type engineRestartPolicy struct {
	Name string `json:"Name"`
}

// Create 建站点容器：HTML 容器内端口 80、bind 目标 /usr/share/nginx/html（只读 :ro），
// 其余容器内端口 = 宿主端口、bind 目标 /app；直连绑 0.0.0.0、域名绑 127.0.0.1。
func (d *websiteDocker) Create(ctx context.Context, input containerCreateInput) (string, error) {
	if !isValidSiteContainerName(input.ContainerName) {
		return "", shared.InvalidRequest("容器名称无效")
	}
	if input.Port < 1 || input.Port > 65535 {
		return "", shared.InvalidRequest("端口需为 1-65535 的整数")
	}
	if !strings.HasPrefix(input.BindSource, "/") {
		return "", shared.InvalidRequest("站点目录无效")
	}
	containerPort := input.Port
	bindTarget := siteAppTarget
	bindMode := ""
	if input.Kind == KindHTML {
		containerPort = 80
		bindTarget = siteHTMLTarget
		bindMode = ":ro"
	}
	portKey := fmt.Sprintf("%d/tcp", containerPort)
	hostIP := "127.0.0.1"
	if input.AccessMode == AccessModeDirect {
		hostIP = "0.0.0.0"
	}
	command := input.Command
	if command == nil {
		command = WebsiteDefaultDeployCommand(input.Kind)
	}
	cmd, err := WebsiteContainerCmd(input.Kind, command)
	if err != nil {
		return "", err
	}
	body, err := marshalJSONCompact(engineCreateBody{
		Image:      input.ImageRef,
		WorkingDir: "/app",
		Cmd:        cmd,
		Labels: map[string]string{
			"elysian.managed":         "true",
			"elysian.website":         "true",
			"elysian.website.project": input.ProjectID,
			"elysian.website.kind":    input.Kind,
			"elysian.website.version": input.Version,
		},
		HostConfig: engineHostConfig{
			Binds:         []string{input.BindSource + ":" + bindTarget + bindMode},
			PortBindings:  map[string][]enginePortBinding{portKey: {{HostIp: hostIP, HostPort: fmt.Sprintf("%d", input.Port)}}},
			RestartPolicy: engineRestartPolicy{Name: contract.RestartPolicyUnlessStopped},
		},
		ExposedPorts: map[string]struct{}{portKey: {}},
	})
	if err != nil {
		return "", err
	}
	status, parsed, err := d.request(ctx, http.MethodPost, "/containers/create", urlValues{"name": input.ContainerName}, body)
	if err != nil {
		return "", err
	}
	if status != http.StatusCreated {
		return "", errorsNew(fmt.Sprintf("创建站点容器失败：%s", engineErrorMessage(parsed, fmt.Sprintf("HTTP %d", status))))
	}
	id, ok := asString(object(parsed)["Id"])
	if !ok {
		return "", errorsNew(fmt.Sprintf("创建站点容器失败：%s", engineErrorMessage(parsed, fmt.Sprintf("HTTP %d", status))))
	}
	return id, nil
}

// Start / Stop 启停：404 →「站点容器已不存在」；204/304/200 视为成功。
func (d *websiteDocker) Start(ctx context.Context, id string) error {
	status, parsed, err := d.request(ctx, http.MethodPost, "/containers/"+id+"/start", nil, nil)
	if err != nil {
		return err
	}
	if status == http.StatusNotFound {
		return &shared.InvalidRequestError{Status: 404, Message: "站点容器已不存在"}
	}
	if status != http.StatusNoContent && status != http.StatusNotModified && status != http.StatusOK {
		return errorsNew(fmt.Sprintf("启动站点容器失败：%s", engineErrorMessage(parsed, fmt.Sprintf("HTTP %d", status))))
	}
	return nil
}

func (d *websiteDocker) Stop(ctx context.Context, id string) error {
	status, parsed, err := d.request(ctx, http.MethodPost, "/containers/"+id+"/stop", urlValues{"t": "10"}, nil)
	if err != nil {
		return err
	}
	if status == http.StatusNotFound {
		return &shared.InvalidRequestError{Status: 404, Message: "站点容器已不存在"}
	}
	if status != http.StatusNoContent && status != http.StatusNotModified && status != http.StatusOK {
		return errorsNew(fmt.Sprintf("停止站点容器失败：%s", engineErrorMessage(parsed, fmt.Sprintf("HTTP %d", status))))
	}
	return nil
}

// Logs 容器日志：GET 流式（tail 200、1 MiB 上限），帧头剥离后按 \n 切分滤空行。
func (d *websiteDocker) Logs(ctx context.Context, id string) ([]string, error) {
	response, err := d.transport.Stream(ctx, seam.EngineRequest{
		Method:   http.MethodGet,
		Path:     "/containers/" + id + "/logs",
		Query:    map[string][]string{"stdout": {"1"}, "stderr": {"1"}, "tail": {logTailLines}},
		Timeout:  engineRequestTimeout,
		MaxBytes: logMaxBytes,
	}, nil)
	if err != nil {
		return nil, err
	}
	if response.Status != http.StatusOK {
		return nil, errorsNew("读取容器日志失败")
	}
	text := StripContainerLogFrames(response.Body)
	lines := strings.Split(text, "\n")
	out := make([]string, 0, len(lines))
	for _, line := range lines {
		if line != "" {
			out = append(out, line)
		}
	}
	return out, nil
}

// StripContainerLogFrames 非 tty 容器日志流的帧头剥离：Docker 以 8 字节复用帧头
// [streamType,0,0,0,sizeBigEndian4] 切分 stdout/stderr 帧，帧内载荷可跨任意字节
// （含换行），必须按长度切分拼接。形状不符时整段按 UTF-8 文本兜底解码（防御性，
// 不让一条畸形日志拖垮整个读取）。
func StripContainerLogFrames(data []byte) string {
	var parts []byte
	offset := 0
	for offset+8 <= len(data) {
		size := int(uint32(data[offset+4])<<24 | uint32(data[offset+5])<<16 | uint32(data[offset+6])<<8 | uint32(data[offset+7]))
		// JS 的位运算是有符号 32 位：最高位为 1 时 size 为负 → 形状不符，跳出兜底。
		if size < 0 || offset+8+size > len(data) {
			break
		}
		parts = append(parts, data[offset+8:offset+8+size]...)
		offset += 8 + size
	}
	if offset != len(data) {
		parts = append(parts, data[offset:]...)
	}
	return string(parts)
}

// RemoveManaged 五重核对删除：容器名正则 → 标签四项（managed/website/project/kind/
// version）→ 镜像引用等于登记值 → Mounts 含该 bind（Source 与登记 rootDir 一致）→
// stop 后 remove（v=false）。任何一环失败抛「站点容器身份核对失败」，不删；容器已被
// 外部删除（inspect 404）返回 missing，调用方跳过容器步骤照常清理目录与登记。
func (d *websiteDocker) RemoveManaged(ctx context.Context, identity containerIdentity) (string, error) {
	info, err := d.Inspect(ctx, identity.ContainerID)
	if err != nil {
		var invalid *shared.InvalidRequestError
		if asInvalidRequest(err, &invalid) && invalid.Status == 404 {
			return "missing", nil
		}
		return "", err
	}
	// 面板自保先于一切核对：网站容器按定义不会是面板自身，双保险对齐 docker 域先例。
	inspectID, _ := asString(info["Id"])
	if seam.IsSelfContainer(identity.SelfContainerID, inspectID) {
		return "", &shared.InvalidRequestError{Status: 403, Message: "不能删除面板自身容器"}
	}
	rawName := ""
	if text, ok := asString(info["Name"]); ok {
		rawName = strings.TrimPrefix(text, "/")
	}
	config := object(info["Config"])
	labels := object(config["Labels"])
	mounts, _ := info["Mounts"].([]any)
	bindTarget := siteAppTarget
	if identity.Kind == KindHTML {
		bindTarget = siteHTMLTarget
	}
	bindMounted := false
	for _, mount := range mounts {
		row := object(mount)
		mountType, _ := asString(row["Type"])
		source, _ := asString(row["Source"])
		destination, _ := asString(row["Destination"])
		if mountType == "bind" && source == identity.RootDir && destination == bindTarget {
			bindMounted = true
			break
		}
	}
	nameOk := rawName == identity.ContainerName && isValidSiteContainerName(rawName)
	managedLabel, _ := asString(labels["elysian.managed"])
	websiteLabel, _ := asString(labels["elysian.website"])
	projectLabel, _ := asString(labels["elysian.website.project"])
	kindLabel, _ := asString(labels["elysian.website.kind"])
	versionLabel, _ := asString(labels["elysian.website.version"])
	labelsOk := managedLabel == "true" && websiteLabel == "true" &&
		projectLabel == identity.ProjectID && kindLabel == identity.Kind && versionLabel == identity.Version
	imageText, _ := asString(config["Image"])
	imageOk := imageText == identity.ImageRef
	if !nameOk || !labelsOk || !imageOk || !bindMounted {
		return "", &shared.InvalidRequestError{Status: 409, Message: "站点容器身份核对失败"}
	}
	state := object(info["State"])
	if running, ok := state["Running"].(bool); ok && running {
		status, parsed, err := d.request(ctx, http.MethodPost, "/containers/"+identity.ContainerID+"/stop", urlValues{"t": "10"}, nil)
		if err != nil {
			return "", err
		}
		if status != http.StatusNoContent && status != http.StatusNotModified && status != http.StatusOK {
			return "", errorsNew(fmt.Sprintf("停止站点容器失败：%s", engineErrorMessage(parsed, fmt.Sprintf("HTTP %d", status))))
		}
	}
	status, parsed, err := d.request(ctx, http.MethodDelete, "/containers/"+identity.ContainerID, urlValues{"v": "false"}, nil)
	if err != nil {
		return "", err
	}
	if status != http.StatusNoContent {
		return "", errorsNew(fmt.Sprintf("删除站点容器失败：%s", engineErrorMessage(parsed, fmt.Sprintf("HTTP %d", status))))
	}
	return "removed", nil
}

// RemoveCreated 撤销刚创建的容器（回滚路径）：按 ID 直删，不做身份核对；204/404 均可。
func (d *websiteDocker) RemoveCreated(ctx context.Context, containerID string) error {
	if !containerIDPattern.MatchString(containerID) {
		return shared.InvalidRequest("容器 ID 无效")
	}
	status, parsed, err := d.request(ctx, http.MethodDelete, "/containers/"+containerID, urlValues{"v": "false"}, nil)
	if err != nil {
		return err
	}
	if status != http.StatusNoContent && status != http.StatusNotFound {
		return errorsNew(fmt.Sprintf("删除站点容器失败：%s", engineErrorMessage(parsed, fmt.Sprintf("HTTP %d", status))))
	}
	return nil
}

// RemoveSiteDir realpath 复核仍在归一化 `<mountRoot>/wwwroot` 之下后递归删除站点目录；
// 目录已被外部删除视为已清理。
func (d *websiteDocker) RemoveSiteDir(rootDir string, mountRoot string) error {
	base, err := wwwrootBase(mountRoot)
	if err != nil {
		return err
	}
	if rootDir == base || !strings.HasPrefix(rootDir, base+"/") {
		return shared.InvalidRequest("站点目录无效")
	}
	resolved, err := d.realpathOf(rootDir)
	if err != nil {
		if isENOENT(err) {
			return nil
		}
		return err
	}
	if resolved != base && !strings.HasPrefix(resolved, base+"/") {
		return shared.InvalidRequest("站点目录经过符号链接，已拒绝")
	}
	if d.rm != nil {
		if err := d.rm(rootDir); err != nil && !isENOENT(err) {
			return err
		}
		return nil
	}
	if err := os.RemoveAll(rootDir); err != nil && !isENOENT(err) {
		return err
	}
	return nil
}

// asInvalidRequest errors.As 的 InvalidRequestError 收窄。
func asInvalidRequest(err error, target **shared.InvalidRequestError) bool {
	return errors.As(err, target)
}
