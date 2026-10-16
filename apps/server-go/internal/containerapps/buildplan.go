package containerapps

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"

	"elysian/server/internal/seam"
	"elysian/server/internal/shared"
)

// 镜像构建的构建计划解析（ADR-0021）：compose build 段的 YAML 解析、Dockerfile FROM
// 静态预检、镜像目标名清洗与 context 的 ./ 两模式展开规则。preview（只读）与提交
// 共用同一套解析——提交时全部校验原样重跑，错误文案逐字相同。
//
// compose 只解析 services.<name>.build 与 image 两块；字段白名单
// {context,dockerfile,args,target}，已知可忽略字段点名忽略并警告，其余一律拒绝。
// 这里的解析与 composecheck.go 的行扫描是两套职责：自检判路径引用存在性，构建
// 解析判 build 段，互不替代。

const (
	// buildModeDockerfile 显式 Dockerfile 构建模式。
	buildModeDockerfile = "dockerfile"
	// buildModeCompose compose build 段批量构建模式。
	buildModeCompose = "compose"
	// defaultDockerfileName dockerfile 模式缺省的 Dockerfile 文件名。
	defaultDockerfileName = "Dockerfile"
	// managedLabelKey 面板构建镜像的管理标签；缺它即视为非面板镜像，绝不覆盖。
	managedLabelKey = "elysian.managed"
	// imageNamespace 面板构建镜像的保留命名空间前缀。
	imageNamespace = "elysian"
)

// BuildPlanInput 构建请求体（preview 与提交共用形状；两模式字段互斥）。
type BuildPlanInput struct {
	ExpectedDigest string   `json:"expectedDigest,omitempty"`
	Mode           string   `json:"mode"`
	RequestID      string   `json:"requestId"`
	Target         string   `json:"target"`
	Dockerfile     string   `json:"dockerfile"`
	Context        string   `json:"context"`
	Compose        string   `json:"compose"`
	Services       []string `json:"services"`
}

// buildInputInvalid 构建请求字段无效（模式取值与两模式互斥字段共用这一句）。
func buildInputInvalid() error { return shared.InvalidRequest("构建请求字段无效") }

// validateBuildInputShape 校验请求体的模式与互斥字段；forSubmit 区分 preview（不带
// requestId）与提交（带 requestId）两种允许的字段面。
func (in BuildPlanInput) validateBuildInputShape(forSubmit bool) error {
	if in.ExpectedDigest != "" && !validWorkspaceDigest(in.ExpectedDigest) {
		return buildInputInvalid()
	}
	switch in.Mode {
	case buildModeDockerfile:
		if in.Compose != "" || len(in.Services) > 0 {
			return buildInputInvalid()
		}
	case buildModeCompose:
		if in.Target != "" || in.Dockerfile != "" || in.Context != "" {
			return buildInputInvalid()
		}
	default:
		return buildInputInvalid()
	}
	if !forSubmit && in.RequestID != "" {
		return buildInputInvalid()
	}
	return nil
}

// buildServicePlan 解析后的单个构建目标（dockerfile 模式也是一条，target 为用户输入）。
type buildServicePlan struct {
	Service          string // compose 服务名；dockerfile 模式为空
	Target           string // 镜像仓库名段（dockerfile 模式=用户输入；compose=服务名清洗）
	Repository       string // elysian/<slug>/<target>
	DockerfileRel    string // 相对工作区根、正斜杠
	ContextRel       string // 相对工作区根、正斜杠；"."=工作区根
	DockerfileAbs    string
	ContextAbs       string
	EngineDockerfile string            // 相对 context 的 Dockerfile 路径（引擎 dockerfile query）
	Args             map[string]string // compose build.args 定值
	BuildTarget      string            // compose build.target（多阶段构建目标）透传
	ImageName        string            // compose 服务的 image: 原样
}

// composeBuildSpec compose build 段的白名单解析结果（值未展开）。
type composeBuildSpec struct {
	context    string
	dockerfile string
	args       map[string]string
	target     string
}

// composeServiceNode compose services 映射里的一个服务（保 YAML 出现顺序）。
type composeServiceNode struct {
	name string
	node *yaml.Node
}

// composeServicePlan compose 模式里一个服务的解析条目（无 build 段的也占位）。
type composeServicePlan struct {
	Service  string
	HasBuild bool
	Image    string            // compose 服务的 image: 原样
	Plan     *buildServicePlan // HasBuild 时非空
	Warnings []string          // 服务级警告（可忽略字段与 FROM 未解析变量）
}

// derefAlias 展开 YAML 别名节点（锚点与合并键由 yaml.v3 原生支持，这里只做指针展开）。
func derefAlias(node *yaml.Node) *yaml.Node {
	for node != nil && node.Kind == yaml.AliasNode {
		node = node.Alias
	}
	return node
}

// parseComposeServices 解析 compose 文本，按 YAML 出现顺序返回 services 映射。
// 解析失败与结构不符都归「compose 文件解析失败：<原因>」。
func parseComposeServices(content string) ([]composeServiceNode, error) {
	var root yaml.Node
	if err := yaml.Unmarshal([]byte(content), &root); err != nil {
		return nil, shared.InvalidRequest(fmt.Sprintf("compose 文件解析失败：%v", err))
	}
	if len(root.Content) == 0 {
		return nil, nil
	}
	doc := derefAlias(root.Content[0])
	if doc == nil || doc.Kind != yaml.MappingNode {
		return nil, shared.InvalidRequest("compose 文件解析失败：根节点必须是映射")
	}
	var servicesNode *yaml.Node
	for i := 0; i+1 < len(doc.Content); i += 2 {
		if doc.Content[i].Value == "services" {
			servicesNode = derefAlias(doc.Content[i+1])
			break
		}
	}
	if servicesNode == nil {
		return nil, nil
	}
	if servicesNode.Kind != yaml.MappingNode {
		return nil, shared.InvalidRequest("compose 文件解析失败：services 必须是映射")
	}
	services := make([]composeServiceNode, 0, len(servicesNode.Content)/2)
	for i := 0; i+1 < len(servicesNode.Content); i += 2 {
		key := servicesNode.Content[i]
		services = append(services, composeServiceNode{name: key.Value, node: derefAlias(servicesNode.Content[i+1])})
	}
	return services, nil
}

// compose 可忽略的 build 字段：点名忽略并警告（不参与构建语义）。
var ignorableBuildKeys = map[string]bool{
	"tags": true, "cache_from": true, "cache_to": true, "labels": true,
	"pull": true, "no_cache": true, "platforms": true, "shm_size": true, "network": true,
}

// hasBuildSection 判服务的 build 段是否存在（null 与缺失都算无）。
func hasBuildSection(serviceNode *yaml.Node) bool {
	if serviceNode == nil || serviceNode.Kind != yaml.MappingNode {
		return false
	}
	for i := 0; i+1 < len(serviceNode.Content); i += 2 {
		if serviceNode.Content[i].Value == "build" {
			value := derefAlias(serviceNode.Content[i+1])
			if value != nil && value.Tag == "!!null" {
				return false
			}
			return true
		}
	}
	return false
}

// composeServiceImage 取服务 image: 的原样值（缺失为空串）。
func composeServiceImage(serviceNode *yaml.Node) string {
	if serviceNode == nil || serviceNode.Kind != yaml.MappingNode {
		return ""
	}
	for i := 0; i+1 < len(serviceNode.Content); i += 2 {
		if serviceNode.Content[i].Value == "image" {
			value := derefAlias(serviceNode.Content[i+1])
			if value != nil && value.Kind == yaml.ScalarNode {
				return value.Value
			}
			return ""
		}
	}
	return ""
}

// parseComposeBuild 解析一个服务的 build 段。返回 spec 与是否存在；可忽略字段的
// 警告随返回值带出，未知/危险字段与结构错误直接报错。
func parseComposeBuild(service string, serviceNode *yaml.Node) (composeBuildSpec, bool, []string, error) {
	if serviceNode == nil || serviceNode.Kind != yaml.MappingNode {
		return composeBuildSpec{}, false, nil, nil
	}
	var buildNode *yaml.Node
	for i := 0; i+1 < len(serviceNode.Content); i += 2 {
		if serviceNode.Content[i].Value == "build" {
			buildNode = serviceNode.Content[i+1]
			break
		}
	}
	if buildNode == nil {
		return composeBuildSpec{}, false, nil, nil
	}
	buildNode = derefAlias(buildNode)
	if buildNode == nil || buildNode.Tag == "!!null" {
		return composeBuildSpec{}, false, nil, nil
	}
	warnings := []string{}
	spec := composeBuildSpec{}
	switch buildNode.Kind {
	case yaml.ScalarNode:
		spec.context = buildNode.Value
		return spec, true, warnings, nil
	case yaml.MappingNode:
	default:
		return composeBuildSpec{}, true, nil, shared.InvalidRequest("compose 文件解析失败：服务 " + service + " 的 build 段必须是字符串或映射")
	}
	for i := 0; i+1 < len(buildNode.Content); i += 2 {
		key := buildNode.Content[i].Value
		value := derefAlias(buildNode.Content[i+1])
		switch key {
		case "context":
			if value == nil || value.Kind != yaml.ScalarNode {
				return composeBuildSpec{}, true, warnings, shared.InvalidRequest("compose 文件解析失败：服务 " + service + " 的 build.context 必须是字符串")
			}
			spec.context = value.Value
		case "dockerfile":
			if value == nil || value.Kind != yaml.ScalarNode {
				return composeBuildSpec{}, true, warnings, shared.InvalidRequest("compose 文件解析失败：服务 " + service + " 的 build.dockerfile 必须是字符串")
			}
			spec.dockerfile = value.Value
		case "target":
			if value == nil || value.Kind != yaml.ScalarNode {
				return composeBuildSpec{}, true, warnings, shared.InvalidRequest("compose 文件解析失败：服务 " + service + " 的 build.target 必须是字符串")
			}
			spec.target = value.Value
		case "args":
			if value == nil || value.Kind != yaml.MappingNode {
				return composeBuildSpec{}, true, warnings, shared.InvalidRequest("compose 文件解析失败：服务 " + service + " 的 build.args 必须是映射")
			}
			args := map[string]string{}
			for j := 0; j+1 < len(value.Content); j += 2 {
				argValue := derefAlias(value.Content[j+1])
				if argValue == nil || argValue.Kind != yaml.ScalarNode {
					return composeBuildSpec{}, true, warnings, shared.InvalidRequest("compose 文件解析失败：服务 " + service + " 的 build.args 值必须是标量")
				}
				args[value.Content[j].Value] = argValue.Value
			}
			spec.args = args
		default:
			if ignorableBuildKeys[key] {
				warnings = append(warnings, fmt.Sprintf("服务 %s 的 build.%s 面板暂不处理，已忽略", service, key))
				continue
			}
			return composeBuildSpec{}, true, warnings, shared.InvalidRequest(fmt.Sprintf("服务 %s 的 build 含不支持的字段：%s（仅支持 context、dockerfile、args、target）", service, key))
		}
	}
	return spec, true, warnings, nil
}

// assertNoBuildVariables 拒绝 build 段里的 ${VAR} 变量替换（含 .env 注入场景）。
func assertNoBuildVariables(service, key, value string) error {
	if strings.Contains(value, "$") {
		return shared.InvalidRequest(fmt.Sprintf("服务 %s 的 build.%s 包含变量替换，请写定值后再构建", service, key))
	}
	return nil
}

// normalizeDockerfileContext 把 dockerfile 模式的 context 归一为「相对工作区根」：
// 允许字面 "."（=工作区根，也是空值的缺省）；"./" 前缀剥掉，剥后为空视同 "."；
// 剥完逐段按 NormalizeRelative 同规则校验（错误文案沿用 paths.go 同句）。
func normalizeDockerfileContext(value string) (string, error) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" || trimmed == "." {
		return ".", nil
	}
	rest := trimmed
	if strings.HasPrefix(rest, "./") {
		rest = rest[2:]
		if rest == "" {
			return ".", nil
		}
	}
	normalized, err := NormalizeRelative(rest)
	if err != nil {
		return "", err
	}
	return normalized, nil
}

// resolveComposeContext 把 compose build.context 相对 compose 文件所在目录展开，
// 返回「相对工作区根」的归一化路径（工作区根用 "."）。与 docker compose 的语义
// 一致；含变量、指向工作区外与符号链接逃逸都拒绝。
func resolveComposeContext(workspaceDir, composeDir, service, value string) (string, error) {
	value = strings.TrimSpace(strings.Trim(strings.TrimSpace(value), `"'`))
	if value == "" {
		return "", shared.InvalidRequest(fmt.Sprintf("服务 %s 的 build 缺少 context", service))
	}
	if strings.Contains(value, "$") {
		return "", shared.InvalidRequest(fmt.Sprintf("服务 %s 的 build.context 包含变量替换，请写定值后再构建", service))
	}
	if strings.HasPrefix(value, "/") || value == ".." || strings.HasPrefix(value, "../") {
		return "", shared.InvalidRequest("构建上下文必须是工作区内的相对路径")
	}
	rest := value
	if strings.HasPrefix(rest, "./") {
		rest = rest[2:]
		if rest == "" {
			rest = "."
		}
	}
	joined := filepath.Clean(filepath.Join(composeDir, rest))
	within, err := withinWorkspace(workspaceDir, joined)
	if err != nil {
		return "", shared.InvalidRequest("构建上下文必须是工作区内的相对路径")
	}
	// 目录实体经符号链接解析后仍必须落在工作区内（与 resolveWithinWorkspace 同法）。
	if resolved, statErr := filepath.EvalSymlinks(joined); statErr == nil {
		if err = AssertWithin(workspaceDir, resolved); err != nil {
			return "", shared.InvalidRequest("构建上下文必须是工作区内的相对路径")
		}
	}
	if within == "." {
		return ".", nil
	}
	return filepath.ToSlash(within), nil
}

// cleanServiceTarget 把 compose 服务名清洗为镜像仓库名段：小写、[^a-z0-9_-] 替换为
// "-"；清洗后为空或不成形（不以字母数字开头）判清洗失败。
func cleanServiceTarget(service string) (string, bool) {
	var builder strings.Builder
	for _, r := range strings.ToLower(service) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '_', r == '-':
			builder.WriteRune(r)
		default:
			builder.WriteRune('-')
		}
	}
	cleaned := builder.String()
	if cleaned == "" || !slugPattern.MatchString(cleaned) {
		return "", false
	}
	return cleaned, true
}

// validateBuildTarget 校验 dockerfile 模式的用户输入目标名。
func validateBuildTarget(target string) error {
	if !slugPattern.MatchString(target) {
		return shared.InvalidRequest("镜像目标名只能由小写字母、数字、下划线和连字符组成，且以字母或数字开头")
	}
	return nil
}

// repositoryOf 拼面板保留命名空间下的镜像仓库。
func repositoryOf(slug, target string) string {
	return fmt.Sprintf("%s/%s/%s", imageNamespace, slug, target)
}

// engineDockerfilePath 计算 Dockerfile 相对 context 的路径（引擎 dockerfile query）。
func engineDockerfilePath(contextAbs, dockerfileAbs string) (string, error) {
	rel, err := filepath.Rel(contextAbs, dockerfileAbs)
	if err != nil {
		return "", err
	}
	return filepath.ToSlash(rel), nil
}

// statContextDir 校验 context 目录存在并返回绝对路径。
func statContextDir(workspaceDir, contextRel string) (string, error) {
	contextAbs := workspaceDir
	if contextRel != "." {
		var err error
		contextAbs, err = JoinWithin(workspaceDir, contextRel)
		if err != nil {
			return "", shared.InvalidRequest("构建上下文必须是工作区内的相对路径")
		}
	}
	info, err := os.Stat(contextAbs)
	if err != nil {
		if os.IsNotExist(err) {
			return "", shared.InvalidRequest(fmt.Sprintf("构建上下文目录不存在：%s", contextRel))
		}
		return "", err
	}
	if !info.IsDir() {
		return "", shared.InvalidRequest(fmt.Sprintf("构建上下文目录不存在：%s", contextRel))
	}
	return contextAbs, nil
}

// locateDockerfile 解析 Dockerfile 路径并断言它位于 context 目录内；返回绝对路径
// 与相对工作区根的归一化路径。
func locateDockerfile(workspaceDir, dockerfileRel, contextAbs string) (string, string, error) {
	normalized, err := NormalizeRelative(dockerfileRel)
	if err != nil {
		return "", "", err
	}
	dockerfileAbs, err := JoinWithin(workspaceDir, normalized)
	if err != nil {
		return "", "", err
	}
	info, err := os.Stat(dockerfileAbs)
	if err != nil {
		if os.IsNotExist(err) {
			return "", "", &FileNotFoundError{Path: filepath.ToSlash(normalized)}
		}
		return "", "", err
	}
	if !info.Mode().IsRegular() {
		return "", "", shared.InvalidRequest("只能读取普通文件")
	}
	// Dockerfile 必须位于构建上下文目录内（daemon 只看得见 tar 里的文件）。
	if dockerfileAbs != contextAbs && !strings.HasPrefix(dockerfileAbs, contextAbs+string(os.PathSeparator)) {
		return "", "", shared.InvalidRequest("Dockerfile 必须位于构建上下文目录内")
	}
	return dockerfileAbs, filepath.ToSlash(normalized), nil
}

// ---------- FROM 静态预检 ----------

var (
	buildArgPattern = regexp.MustCompile(`(?i)^ARG\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s*=\s*(\S+))?`)
	buildVarPattern = regexp.MustCompile(`\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)`)
)

// officialRegistries 官方镜像源（缺省 docker.io 及其端点），跳过校验。
var officialRegistries = map[string]bool{"docker.io": true, "registry-1.docker.io": true, "index.docker.io": true}

// collectBuildArgs 收集 Dockerfile 内 ARG NAME=默认值（无默认值不提供变量）。
func collectBuildArgs(content string) map[string]string {
	vars := map[string]string{}
	for _, rawLine := range strings.Split(content, "\n") {
		line := strings.TrimSpace(rawLine)
		if matches := buildArgPattern.FindStringSubmatch(line); matches != nil {
			if matches[2] != "" {
				vars[matches[1]] = matches[2]
			}
		}
	}
	return vars
}

// expandBuildVars 按 vars 展开 ${NAME} 与 $NAME；未定义的保留原样（视为未解析）。
// 值本身还可引用其它变量，迭代到稳定为止（上限 8 轮防循环引用）。
func expandBuildVars(text string, vars map[string]string) string {
	for round := 0; round < 8; round++ {
		replaced := buildVarPattern.ReplaceAllStringFunc(text, func(match string) string {
			name := match[1:]
			if strings.HasPrefix(match, "${") {
				name = match[2 : len(match)-1]
			}
			if value, ok := vars[name]; ok {
				return value
			}
			return match
		})
		if replaced == text {
			break
		}
		text = replaced
	}
	return text
}

// registryHostOfImage 取镜像引用内嵌的 registry host；无内嵌 host（官方缺省）返回
// false。与 docker 域 embeddedRegistryHost 同一判定。
func registryHostOfImage(image string) (string, bool) {
	segment := image
	if index := strings.IndexByte(image, '/'); index >= 0 {
		segment = image[:index]
	} else {
		return "", false
	}
	if segment == "localhost" || strings.Contains(segment, ".") || strings.Contains(segment, ":") {
		return segment, true
	}
	return "", false
}

// inspectDockerfile 逐行扫描 FROM 做静态镜像源预检：ARG 默认值叠加 compose args
// 定值代入；官方源跳过，解析出 host 的走注入的校验函数，仍含未解析变量的进警告。
func inspectDockerfile(ctx context.Context, content string, args map[string]string, policy func(context.Context, string) error) ([]string, error) {
	vars := collectBuildArgs(content)
	for key, value := range args {
		vars[key] = value
	}
	warnings := []string{}
	for index, rawLine := range strings.Split(content, "\n") {
		lineNumber := index + 1
		fields := strings.Fields(rawLine)
		if len(fields) < 2 || !strings.EqualFold(fields[0], "FROM") {
			continue
		}
		image := ""
		for _, field := range fields[1:] {
			if strings.HasPrefix(field, "--") {
				continue // --platform=… 等构建选项剥掉
			}
			image = field
			break
		}
		if image == "" {
			continue
		}
		resolved := expandBuildVars(image, vars)
		if strings.Contains(resolved, "$") {
			warnings = append(warnings, fmt.Sprintf("第 %d 行 FROM 含未解析变量，面板未校验其镜像源", lineNumber))
			continue
		}
		host, hasHost := registryHostOfImage(resolved)
		if !hasHost || officialRegistries[strings.ToLower(host)] {
			continue
		}
		if policy == nil {
			return nil, shared.InvalidRequest("镜像源校验通道不可用，已中止")
		}
		if err := policy(ctx, host); err != nil {
			return nil, err
		}
	}
	return warnings, nil
}

// ---------- 两模式的计划解析 ----------

// resolveDockerfilePlan 解析 dockerfile 模式的构建计划（单目标）；warnings 为
// FROM 预检的未解析变量提示。
func resolveDockerfilePlan(ctx context.Context, workspaceDir, slug string, input BuildPlanInput, policy func(context.Context, string) error) (buildServicePlan, []string, error) {
	target := input.Target
	if target == "" {
		target = "app"
	}
	if err := validateBuildTarget(target); err != nil {
		return buildServicePlan{}, nil, err
	}
	dockerfileRel := input.Dockerfile
	if dockerfileRel == "" {
		dockerfileRel = defaultDockerfileName
	}
	contextRel, err := normalizeDockerfileContext(input.Context)
	if err != nil {
		return buildServicePlan{}, nil, badRequest(err)
	}
	contextAbs, err := statContextDir(workspaceDir, contextRel)
	if err != nil {
		return buildServicePlan{}, nil, err
	}
	dockerfileAbs, normalizedDockerfile, err := locateDockerfile(workspaceDir, dockerfileRel, contextAbs)
	if err != nil {
		return buildServicePlan{}, nil, badRequest(err)
	}
	engineDockerfile, err := engineDockerfilePath(contextAbs, dockerfileAbs)
	if err != nil {
		return buildServicePlan{}, nil, err
	}
	content, _, err := ReadContent(workspaceDir, normalizedDockerfile)
	if err != nil {
		return buildServicePlan{}, nil, err
	}
	fromWarnings, err := inspectDockerfile(ctx, content, nil, policy)
	if err != nil {
		return buildServicePlan{}, nil, err
	}
	return buildServicePlan{
		Target:           target,
		Repository:       repositoryOf(slug, target),
		DockerfileRel:    normalizedDockerfile,
		ContextRel:       contextRel,
		DockerfileAbs:    dockerfileAbs,
		ContextAbs:       contextAbs,
		EngineDockerfile: engineDockerfile,
	}, fromWarnings, nil
}

// parseComposeServicePlans 统一的 compose 解析：全部服务逐条产出（无 build 段的
// 也占位，preview 需要全量视图）；selected 为空数组或 nil 时表示全部 hasBuild 服务。
// 选择校验次序（重复名 → 不存在 → 无 build 段）在解析之前完成。
func parseComposeServicePlans(ctx context.Context, workspaceDir, slug, composeRel, content string, selected []string, policy func(context.Context, string) error) ([]composeServicePlan, error) {
	services, err := parseComposeServices(content)
	if err != nil {
		return nil, err
	}
	composeNormalized, err := NormalizeRelative(composeRel)
	if err != nil {
		return nil, err
	}
	composeDir := filepath.Dir(filepath.Join(workspaceDir, composeNormalized))
	if composeDir == "." {
		composeDir = workspaceDir
	}
	// 校验次序：重复名 → 不存在 → 无 build 段。空数组视同省略（= 全部 hasBuild 服务）。
	if len(selected) > 0 {
		seen := map[string]bool{}
		for _, name := range selected {
			if seen[name] {
				return nil, shared.InvalidRequest(fmt.Sprintf("服务 %s 重复提交", name))
			}
			seen[name] = true
		}
		byName := map[string]*yaml.Node{}
		for i := range services {
			byName[services[i].name] = services[i].node
		}
		for _, name := range selected {
			if _, ok := byName[name]; !ok {
				return nil, shared.InvalidRequest(fmt.Sprintf("服务不存在：%s", name))
			}
		}
		for _, name := range selected {
			if !hasBuildSection(byName[name]) {
				return nil, shared.InvalidRequest(fmt.Sprintf("服务没有 build 配置：%s", name))
			}
		}
	}
	selectedSet := map[string]bool{}
	for _, name := range selected {
		selectedSet[name] = true
	}
	entries := make([]composeServicePlan, 0, len(services))
	taken := map[string]bool{}
	for i := range services {
		service := services[i]
		entry := composeServicePlan{Service: service.name, Image: composeServiceImage(service.node), Warnings: []string{}}
		spec, hasBuild, serviceWarnings, parseErr := parseComposeBuild(service.name, service.node)
		if parseErr != nil {
			return nil, parseErr
		}
		entry.HasBuild = hasBuild
		entry.Warnings = append(entry.Warnings, serviceWarnings...)
		if !hasBuild {
			entries = append(entries, entry)
			continue
		}
		plan, fromWarnings, planErr := resolveComposeServicePlan(ctx, workspaceDir, slug, composeDir, service.name, spec, policy)
		if planErr != nil {
			return nil, planErr
		}
		entry.Warnings = append(entry.Warnings, fromWarnings...)
		// 提交选中过滤：未选中的服务仍占位（preview 全量视图），但不进构建列表。
		if len(selected) > 0 && !selectedSet[service.name] {
			entries = append(entries, entry)
			continue
		}
		if taken[plan.Target] {
			return nil, shared.InvalidRequest(fmt.Sprintf("服务 %s 无法转换为合法镜像目标名，请改名后重试", service.name))
		}
		taken[plan.Target] = true
		entry.Plan = &plan
		entries = append(entries, entry)
	}
	if len(selected) > 0 {
		planned := 0
		for i := range entries {
			if entries[i].Plan != nil {
				planned++
			}
		}
		if planned != len(selected) {
			return nil, shared.InvalidRequest("服务没有 build 配置")
		}
	}
	return entries, nil
}

// resolveComposeServicePlan 解析单个 hasBuild 服务的构建计划。
func resolveComposeServicePlan(ctx context.Context, workspaceDir, slug, composeDir, service string, spec composeBuildSpec, policy func(context.Context, string) error) (buildServicePlan, []string, error) {
	if err := assertNoBuildVariables(service, "context", spec.context); err != nil {
		return buildServicePlan{}, nil, err
	}
	if spec.dockerfile != "" {
		if err := assertNoBuildVariables(service, "dockerfile", spec.dockerfile); err != nil {
			return buildServicePlan{}, nil, err
		}
	}
	argKeys := make([]string, 0, len(spec.args))
	for key := range spec.args {
		argKeys = append(argKeys, key)
	}
	sort.Strings(argKeys)
	for _, key := range argKeys {
		if err := assertNoBuildVariables(service, "args", key+"="+spec.args[key]); err != nil {
			return buildServicePlan{}, nil, err
		}
	}
	target, ok := cleanServiceTarget(service)
	if !ok {
		return buildServicePlan{}, nil, shared.InvalidRequest(fmt.Sprintf("服务 %s 无法转换为合法镜像目标名，请改名后重试", service))
	}
	contextRel, err := resolveComposeContext(workspaceDir, composeDir, service, spec.context)
	if err != nil {
		return buildServicePlan{}, nil, err
	}
	contextAbs, err := statContextDir(workspaceDir, contextRel)
	if err != nil {
		return buildServicePlan{}, nil, err
	}
	// build.dockerfile 相对 context 展开（compose 语义），缺省 Dockerfile。
	dockerfileRel := spec.dockerfile
	if dockerfileRel == "" {
		dockerfileRel = defaultDockerfileName
	}
	if strings.HasPrefix(dockerfileRel, "./") {
		dockerfileRel = dockerfileRel[2:]
		if dockerfileRel == "" {
			dockerfileRel = defaultDockerfileName
		}
	}
	joinedDockerfile := filepath.Clean(filepath.Join(contextAbs, dockerfileRel))
	dockerfileWithin, err := withinWorkspace(workspaceDir, joinedDockerfile)
	if err != nil {
		return buildServicePlan{}, nil, shared.InvalidRequest("构建上下文必须是工作区内的相对路径")
	}
	dockerfileAbs, dockerfileWithinRel, err := locateDockerfile(workspaceDir, filepath.ToSlash(dockerfileWithin), contextAbs)
	if err != nil {
		return buildServicePlan{}, nil, badRequest(err)
	}
	engineDockerfile, err := engineDockerfilePath(contextAbs, dockerfileAbs)
	if err != nil {
		return buildServicePlan{}, nil, err
	}
	content, _, err := ReadContent(workspaceDir, dockerfileWithinRel)
	if err != nil {
		return buildServicePlan{}, nil, err
	}
	fromWarnings, err := inspectDockerfile(ctx, content, spec.args, policy)
	if err != nil {
		return buildServicePlan{}, nil, err
	}
	return buildServicePlan{
		Service:          service,
		Target:           target,
		Repository:       repositoryOf(slug, target),
		DockerfileRel:    dockerfileWithinRel,
		ContextRel:       contextRel,
		DockerfileAbs:    dockerfileAbs,
		ContextAbs:       contextAbs,
		EngineDockerfile: engineDockerfile,
		Args:             spec.args,
		BuildTarget:      spec.target,
	}, fromWarnings, nil
}

// resolveComposePlan 解析 compose 模式的构建计划：返回选中（或全部）hasBuild 服务
// 的构建计划（按 YAML 出现顺序）与服务级警告（按服务名归组）。
func resolveComposePlan(ctx context.Context, workspaceDir, slug, composeRel, content string, selected []string, policy func(context.Context, string) error) ([]buildServicePlan, map[string][]string, error) {
	entries, err := parseComposeServicePlans(ctx, workspaceDir, slug, composeRel, content, selected, policy)
	if err != nil {
		return nil, nil, err
	}
	plans := []buildServicePlan{}
	warningsByService := map[string][]string{}
	for i := range entries {
		entry := entries[i]
		if len(entry.Warnings) > 0 {
			warningsByService[entry.Service] = append(warningsByService[entry.Service], entry.Warnings...)
		}
		if entry.Plan != nil {
			plans = append(plans, *entry.Plan)
		}
	}
	return plans, warningsByService, nil
}

// ---------- 构建预览组装（端点 1 响应） ----------

// DockerfileBuildPreview dockerfile 模式的预览响应（键序即 JSON 输出序）。
type DockerfileBuildPreview struct {
	Mode               string   `json:"mode"`
	Slug               string   `json:"slug"`
	Target             string   `json:"target"`
	Dockerfile         string   `json:"dockerfile"`
	Context            string   `json:"context"`
	ImageRepository    string   `json:"imageRepository"`
	ContextFiles       int      `json:"contextFiles"`
	ContextBytes       int64    `json:"contextBytes"`
	RepositoryOccupied bool     `json:"repositoryOccupied"`
	Warnings           []string `json:"warnings"`
}

// BuildServicePreview compose 模式里单个服务的预览条目。
type BuildServicePreview struct {
	Service            string   `json:"service"`
	HasBuild           bool     `json:"hasBuild"`
	Target             string   `json:"target"`
	Dockerfile         string   `json:"dockerfile"`
	Context            string   `json:"context"`
	ImageRepository    string   `json:"imageRepository"`
	ContextFiles       int      `json:"contextFiles"`
	ContextBytes       int64    `json:"contextBytes"`
	ImageNameInCompose string   `json:"imageNameInCompose"`
	RepositoryOccupied bool     `json:"repositoryOccupied"`
	Warnings           []string `json:"warnings"`
}

// ComposeBuildPreview compose 模式的预览响应。
type ComposeBuildPreview struct {
	Mode     string                `json:"mode"`
	Slug     string                `json:"slug"`
	Compose  string                `json:"compose"`
	Services []BuildServicePreview `json:"services"`
	Warnings []string              `json:"warnings"`
}

// buildContextOverLimitWarning 上下文超限的预警句（preview 预警，打包阶段才硬失败）。
const buildContextOverLimitWarning = "构建上下文超过上限（≤512 个文件、128 MiB），任务将在打包阶段失败"

// PreviewDockerfileBuild 组装 dockerfile 模式预览：统计上下文、回查占用、汇总警告。
func PreviewDockerfileBuild(ctx context.Context, engine seam.DockerTransport, workspaceDir, slug string, input BuildPlanInput, policy func(context.Context, string) error) (DockerfileBuildPreview, error) {
	plan, warnings, err := resolveDockerfilePlan(ctx, workspaceDir, slug, input, policy)
	if err != nil {
		return DockerfileBuildPreview{}, err
	}
	preview := DockerfileBuildPreview{
		Mode:            buildModeDockerfile,
		Slug:            slug,
		Target:          plan.Target,
		Dockerfile:      plan.DockerfileRel,
		Context:         plan.ContextRel,
		ImageRepository: plan.Repository,
		Warnings:        append([]string{}, warnings...),
	}
	stat, err := statBuildContext(plan.ContextAbs)
	if err != nil {
		return DockerfileBuildPreview{}, err
	}
	preview.ContextFiles = stat.files
	preview.ContextBytes = stat.bytes
	if stat.files > maxContextFiles || stat.bytes > maxContextBytes {
		preview.Warnings = append(preview.Warnings, buildContextOverLimitWarning)
	}
	occupied, err := repositoryOccupiedVia(ctx, engine, plan.Repository)
	if err != nil {
		return DockerfileBuildPreview{}, err
	}
	preview.RepositoryOccupied = occupied
	if occupied {
		preview.Warnings = append(preview.Warnings, fmt.Sprintf("镜像 %s 已被非面板构建的镜像占用，构建将被拒绝", plan.Repository))
	}
	return preview, nil
}

// PreviewComposeBuild 组装 compose 模式预览：全部服务逐条（无 build 段的也占位），
// hasBuild 服务统计上下文并回查占用。
func PreviewComposeBuild(ctx context.Context, engine seam.DockerTransport, workspaceDir, slug, composeRel string, policy func(context.Context, string) error) (ComposeBuildPreview, error) {
	content, _, err := ReadContent(workspaceDir, composeRel)
	if err != nil {
		return ComposeBuildPreview{}, err
	}
	entries, err := parseComposeServicePlans(ctx, workspaceDir, slug, composeRel, content, nil, policy)
	if err != nil {
		return ComposeBuildPreview{}, err
	}
	preview := ComposeBuildPreview{
		Mode:     buildModeCompose,
		Slug:     slug,
		Compose:  composeRel,
		Services: []BuildServicePreview{},
		Warnings: []string{},
	}
	for i := range entries {
		entry := entries[i]
		row := BuildServicePreview{
			Service:            entry.Service,
			HasBuild:           entry.HasBuild,
			ImageNameInCompose: entry.Image,
			Warnings:           append([]string{}, entry.Warnings...),
		}
		if entry.Plan != nil {
			plan := entry.Plan
			row.Target = plan.Target
			row.Dockerfile = plan.DockerfileRel
			row.Context = plan.ContextRel
			row.ImageRepository = plan.Repository
			stat, statErr := statBuildContext(plan.ContextAbs)
			if statErr != nil {
				return ComposeBuildPreview{}, statErr
			}
			row.ContextFiles = stat.files
			row.ContextBytes = stat.bytes
			if stat.files > maxContextFiles || stat.bytes > maxContextBytes {
				row.Warnings = append(row.Warnings, buildContextOverLimitWarning)
			}
			occupied, occErr := repositoryOccupiedVia(ctx, engine, plan.Repository)
			if occErr != nil {
				return ComposeBuildPreview{}, occErr
			}
			row.RepositoryOccupied = occupied
			if occupied {
				row.Warnings = append(row.Warnings, fmt.Sprintf("镜像 %s 已被非面板构建的镜像占用，构建将被拒绝", plan.Repository))
			}
		}
		preview.Services = append(preview.Services, row)
	}
	return preview, nil
}

// repositoryOccupiedVia 回查仓库是否被非面板镜像占用（任一命中缺管理标签即占用）。
func repositoryOccupiedVia(ctx context.Context, engine seam.DockerTransport, repository string) (bool, error) {
	images, err := listRepositoryImagesVia(ctx, engine, repository)
	if err != nil {
		return false, err
	}
	for _, image := range images {
		if image.Labels[managedLabelKey] != "true" {
			return true, nil
		}
	}
	return false, nil
}

// engineImageSummary 镜像列表摘要里本域关心的两个字段。
type engineImageSummary struct {
	RepoTags []string          `json:"RepoTags"`
	Labels   map[string]string `json:"Labels"`
}

// listRepositoryImagesVia 按 reference 过滤列同仓库镜像。
func listRepositoryImagesVia(ctx context.Context, engine seam.DockerTransport, repository string) ([]engineImageSummary, error) {
	filters, _ := json.Marshal(map[string][]string{"reference": {repository}})
	response, err := engine.Request(ctx, seam.EngineRequest{
		Method:   "GET",
		Path:     "/images/json",
		Query:    url.Values{"filters": {string(filters)}},
		MaxBytes: 32 << 20,
	})
	if err != nil {
		return nil, err
	}
	if response.Status != http.StatusOK {
		return nil, fmt.Errorf("查询镜像占用失败（HTTP %d）", response.Status)
	}
	var listed []engineImageSummary
	if err = json.Unmarshal(response.Body, &listed); err != nil {
		return nil, err
	}
	matched := make([]engineImageSummary, 0, len(listed))
	for _, image := range listed {
		for _, ref := range image.RepoTags {
			if ref == repository || strings.HasPrefix(ref, repository+":") {
				matched = append(matched, image)
				break
			}
		}
	}
	return matched, nil
}
