package docker

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"elysian/server/internal/contract"
	"elysian/server/internal/seam"
	"elysian/server/internal/shared"
)

// 只读 service（dockerService.ts 逐字移植）：列表/动作/创建/拉取/删除；全局 create
// 串行与 pull 单飞锁；动作按请求 id 记账（同 id 在途 409）。错误消息逐字对齐盘点。

const (
	listMax              = 500
	inspectConcurrency   = 8
	listTimeout          = 10 * time.Second
	jsonMaxBytes         = 32 * 1024 * 1024
	listTimeoutMessage   = "Docker 列表请求超时"
	actionTimeout        = 30 * time.Second
	pullTimeout          = 15 * 60 * time.Second
	pullProgressMaxBytes = 64 * 1024 * 1024
	registryResolveDelay = 3 * time.Second
	searchTimeout        = 4 * time.Second
	searchMaxBytes       = 128 * 1024

	actionBusyMessage             = "该容器正在执行其他操作"
	pullBusyMessage               = "已有镜像正在拉取"
	pullAuthMessage               = "不支持私有仓库认证"
	registryReferenceConflictMsg  = "镜像源与引用中的仓库地址请只填一处"
	imageInUseMessage             = "镜像仍被容器引用，删除失败"
	imageNotFoundMessage          = "镜像不存在，删除失败"
	actionPausedMessage           = "容器已暂停，面板暂不支持恢复"
	actionSelfMessage             = "不能对面板所在的容器执行该操作"
	containerNotFoundMessage      = "容器不存在"
	containerRunningRemoveMessage = "容器正在运行，请先停止再删除"
	officialRegistry              = "https://registry-1.docker.io"
	engineJSONInvalidMessage      = "Docker 响应不是有效 JSON"
)

var (
	searchTermPattern     = regexp.MustCompile(`^[a-z0-9][a-z0-9._/-]*$`)
	repoNameSegmentRegexp = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]*$`)
)

// serviceDeps service 的注入依赖（真实装配与测试替身共用一套形状）。
type serviceDeps struct {
	transport       seam.DockerTransport
	mountRoot       string
	reservedPorts   []int
	selfContainerID string
	onRestarting    func(containerID string)
	mkdir           func(path string, mode os.FileMode) error
	realpath        func(path string) (string, error)
	// resolveRegistry 返回 hostname 的全部解析地址；真实实现带 3s 超时包裹。
	resolveRegistry func(ctx context.Context, hostname string) ([]string, error)
	fetchCatalog    catalogFetcher
	fetchTags       tagsFetcher
	fetchHubToken   func(ctx context.Context, repository string) (string, error)
	fetchProbe      probeFetcher
	probeSample     probeSampler
	now             func() time.Time
}

func (d *serviceDeps) fillDefaults() {
	if d.mkdir == nil {
		d.mkdir = func(path string, mode os.FileMode) error {
			return os.Mkdir(path, mode)
		}
	}
	if d.realpath == nil {
		d.realpath = defaultRealpath
	}
	if d.resolveRegistry == nil {
		d.resolveRegistry = defaultRegistryResolver
	}
	if d.fetchCatalog == nil {
		d.fetchCatalog = requestRegistryCatalog
	}
	if d.fetchTags == nil {
		d.fetchTags = requestRegistryTags
	}
	if d.fetchHubToken == nil {
		d.fetchHubToken = requestDockerHubToken
	}
	if d.fetchProbe == nil {
		d.fetchProbe = requestProbe
	}
	if d.probeSample == nil {
		d.probeSample = downloadProbeSample
	}
	if d.now == nil {
		d.now = time.Now
	}
}

// defaultRegistryResolver DNS 解析（lookup all+verbatim 等价）＋ 3s 超时包裹，
// 失败与空结果统一报「镜像源无法解析为公网地址」。
func defaultRegistryResolver(ctx context.Context, hostname string) ([]string, error) {
	resolveCtx, cancel := context.WithTimeout(ctx, registryResolveDelay)
	defer cancel()
	addrs, err := net.DefaultResolver.LookupIPAddr(resolveCtx, hostname)
	if err != nil || len(addrs) == 0 {
		return nil, errors.New("镜像源无法解析为公网地址")
	}
	addresses := make([]string, 0, len(addrs))
	for _, addr := range addrs {
		addresses = append(addresses, addr.String())
	}
	return addresses, nil
}

// dockerService 容器管理只读服务；实现 seam.DockerViews。
type dockerService struct {
	deps serviceDeps

	actionMu    sync.Mutex
	actionLocks map[string]struct{}

	createMu sync.Mutex

	pullInFlight atomic.Bool
}

func newDockerService(deps serviceDeps) *dockerService {
	deps.fillDefaults()
	return &dockerService{deps: deps, actionLocks: make(map[string]struct{})}
}

// requireID 从列表摘要取非空 Id。
func requireID(summary any, label string) (string, error) {
	record, ok := asRecord(summary)
	if !ok {
		return "", fmt.Errorf("%s摘要缺少 Id", label)
	}
	id, ok := asString(mustGet(record, "Id"))
	if !ok || id == "" {
		return "", fmt.Errorf("%s摘要缺少 Id", label)
	}
	return id, nil
}

func assertListLimit(count int, label string) error {
	if count > listMax {
		return fmt.Errorf("%s数量超过上限 %d", label, listMax)
	}
	return nil
}

// encodeEngineID TS encodeURIComponent 的等价实现：保留 A-Za-z0-9 与 -_.!~*'()，
// 其余字节按大写十六进制百分号编码（镜像引用中的 : / 等都转义）。
func encodeEngineID(id string) string {
	var out strings.Builder
	for i := 0; i < len(id); i++ {
		ch := id[i]
		switch {
		case ch >= 'A' && ch <= 'Z', ch >= 'a' && ch <= 'z', ch >= '0' && ch <= '9':
			out.WriteByte(ch)
		default:
			switch ch {
			case '-', '_', '.', '!', '~', '*', '\'', '(', ')':
				out.WriteByte(ch)
			default:
				const hexDigits = "0123456789ABCDEF"
				out.WriteByte('%')
				out.WriteByte(hexDigits[ch>>4])
				out.WriteByte(hexDigits[ch&0x0f])
			}
		}
	}
	return out.String()
}

// engineJSON 一次性 Engine 请求并解析 JSON（对齐 TS dockerRequest：32 MiB 上限、
// 非 JSON 响应以「Docker 响应不是有效 JSON」收口）。
func (s *dockerService) engineJSON(ctx context.Context, method, path string, query url.Values, body []byte, timeout time.Duration) (int, any, error) {
	response, err := s.deps.transport.Request(ctx, seam.EngineRequest{
		Method:   method,
		Path:     path,
		Query:    query,
		Body:     body,
		Timeout:  timeout,
		MaxBytes: jsonMaxBytes,
	})
	if err != nil {
		return 0, nil, err
	}
	var value any
	if len(response.Body) > 0 {
		value, err = decodeOrderedJSON(response.Body)
		if err != nil {
			return response.Status, nil, errors.New(engineJSONInvalidMessage)
		}
	}
	return response.Status, value, nil
}

// isPausedInspect paused 状态判定。
func isPausedInspect(inspect any) bool {
	record, ok := asRecord(inspect)
	if !ok {
		return false
	}
	state, ok := asRecord(mustGet(record, "State"))
	if !ok {
		return false
	}
	status, ok := asString(mustGet(state, "Status"))
	return ok && status == "paused"
}

// inspectContainerById 单容器 inspect：404 →「容器不存在」，其余非 2xx →
// 「获取容器详情失败（HTTP N）」，传输错误原样上抛。
func (s *dockerService) inspectContainerByID(ctx context.Context, id string, timeout time.Duration) (any, error) {
	status, value, err := s.engineJSON(ctx, http.MethodGet, "/containers/"+encodeEngineID(id)+"/json", nil, nil, timeout)
	if err != nil {
		return nil, err
	}
	if status == http.StatusNotFound {
		return nil, &shared.InvalidRequestError{Status: http.StatusNotFound, Message: containerNotFoundMessage}
	}
	if status < 200 || status >= 300 {
		return nil, fmt.Errorf("获取容器详情失败（HTTP %d）", status)
	}
	return value, nil
}

// listDeadline 整次列表 + 全部 inspect 共享的 10s 预算（now 可注入）。
type listDeadline struct {
	deadlineAt time.Time
	now        func() time.Time
}

func (d *listDeadline) remaining() time.Duration {
	left := d.deadlineAt.Sub(d.now())
	if left < 0 {
		return 0
	}
	return left
}

func (d *listDeadline) expired() bool {
	return d.remaining() <= 0
}

// mapWithConcurrency 并发上限的映射（结果保序；首个错误胜出）。
func mapWithConcurrency[T, R any](items []T, concurrency int, fn func(item T, index int) (R, error)) ([]R, error) {
	if len(items) == 0 {
		return []R{}, nil
	}
	if concurrency > len(items) {
		concurrency = len(items)
	}
	results := make([]R, len(items))
	next := make(chan int, len(items))
	for i := range items {
		next <- i
	}
	close(next)
	var mu sync.Mutex
	var firstErr error
	var wg sync.WaitGroup
	for w := 0; w < concurrency; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for index := range next {
				result, err := fn(items[index], index)
				if err != nil {
					mu.Lock()
					if firstErr == nil {
						firstErr = err
					}
					mu.Unlock()
					continue
				}
				results[index] = result
			}
		}()
	}
	wg.Wait()
	if firstErr != nil {
		return nil, firstErr
	}
	return results, nil
}

// listEntry 列表项（摘要 + 解析出的 Id）。
type listEntry struct {
	id      string
	summary any
}

// listWithInspect 列表 + 逐项 inspect 映射（容器/镜像共用；列表与全部 inspect 共享
// 10s 预算，超时报「Docker 列表请求超时」）。
func (s *dockerService) listWithInspect(
	ctx context.Context,
	listPath string,
	listQuery url.Values,
	inspectPath func(id string) string,
	label string,
	mapItem func(summary, inspect any) (any, error),
) ([]any, error) {
	deadline := &listDeadline{deadlineAt: s.deps.now().Add(listTimeout), now: s.deps.now}

	if deadline.expired() {
		return nil, errors.New(listTimeoutMessage)
	}
	status, value, err := s.engineJSON(ctx, http.MethodGet, listPath, listQuery, nil, deadline.remaining())
	if err != nil {
		return nil, err
	}
	if status < 200 || status >= 300 {
		return nil, fmt.Errorf("获取%s列表失败（HTTP %d）", label, status)
	}
	summaries, ok := asArray(value)
	if !ok {
		return nil, fmt.Errorf("%s列表格式无效", label)
	}
	if err := assertListLimit(len(summaries), label); err != nil {
		return nil, err
	}

	entries := make([]listEntry, len(summaries))
	for i, summary := range summaries {
		id, err := requireID(summary, label)
		if err != nil {
			return nil, err
		}
		entries[i] = listEntry{id: id, summary: summary}
	}
	if deadline.expired() {
		return nil, errors.New(listTimeoutMessage)
	}

	return mapWithConcurrency(entries, inspectConcurrency, func(entry listEntry, _ int) (any, error) {
		if deadline.expired() {
			return nil, errors.New(listTimeoutMessage)
		}
		status, inspect, err := s.engineJSON(ctx, http.MethodGet, inspectPath(entry.id), nil, nil, deadline.remaining())
		if err != nil {
			return nil, err
		}
		if deadline.expired() {
			return nil, errors.New(listTimeoutMessage)
		}
		if status < 200 || status >= 300 {
			return nil, fmt.Errorf("获取%s详情失败（HTTP %d）", label, status)
		}
		return mapItem(entry.summary, inspect)
	})
}

func engineErrorMessage(value any, fallback string) string {
	if record, ok := asRecord(value); ok {
		if message, ok := asString(mustGet(record, "message")); ok && message != "" {
			return message
		}
	}
	return fallback
}

func requireCreateID(value any) (string, error) {
	record, ok := asRecord(value)
	if !ok {
		return "", errors.New("创建容器响应缺少 Id")
	}
	id, ok := asString(mustGet(record, "Id"))
	if !ok || id == "" {
		return "", errors.New("创建容器响应缺少 Id")
	}
	return id, nil
}

func normalizeImageID(id string) string {
	return strings.TrimPrefix(id, "sha256:")
}

// embeddedRegistryHost name 首段内嵌 registry（localhost / 含点 / 含冒号）。
func embeddedRegistryHost(imageName string) (string, bool) {
	firstSegment := imageName
	if idx := strings.IndexByte(imageName, '/'); idx >= 0 {
		firstSegment = imageName[:idx]
	}
	if firstSegment == "localhost" || strings.Contains(firstSegment, ".") || strings.Contains(firstSegment, ":") {
		return firstSegment, true
	}
	return "", false
}

func buildRegistryFromImage(registryHost, name, tag string) string {
	imagePath := name
	if !strings.Contains(name, "/") {
		imagePath = "library/" + name
	}
	return registryHost + "/" + imagePath + ":" + tag
}

// assertRegistryAllowed 校验镜像源并返回 host；失败 400（校验错误或回落文案）。
func (s *dockerService) assertRegistryAllowed(ctx context.Context, raw string) (string, error) {
	host, err := validateRegistry(raw, func(hostname string) ([]string, error) {
		return s.deps.resolveRegistry(ctx, hostname)
	})
	if err != nil {
		return "", shared.InvalidRequest(err.Error())
	}
	return host, nil
}

// imageExistsByTag 全量列表后按 name:tag 判存在。
func (s *dockerService) imageExistsByTag(ctx context.Context, name, tag string) (bool, error) {
	values, err := s.listWithInspect(ctx, "/images/json", nil,
		func(id string) string { return "/images/" + encodeEngineID(id) + "/json" },
		"镜像",
		func(summary, inspect any) (any, error) { return mapImage(summary, inspect) })
	if err != nil {
		return false, err
	}
	for _, value := range values {
		if image, ok := value.(contract.ContainerImage); ok && image.Name == name && image.Tag == tag {
			return true, nil
		}
	}
	return false, nil
}

// imagesFromList 全量镜像列表（拉取后回查共用）。
func (s *dockerService) imagesFromList(ctx context.Context) ([]contract.ContainerImage, error) {
	values, err := s.listWithInspect(ctx, "/images/json", nil,
		func(id string) string { return "/images/" + encodeEngineID(id) + "/json" },
		"镜像",
		func(summary, inspect any) (any, error) { return mapImage(summary, inspect) })
	if err != nil {
		return nil, err
	}
	images := make([]contract.ContainerImage, 0, len(values))
	for _, value := range values {
		image, ok := value.(contract.ContainerImage)
		if !ok {
			return nil, errors.New("镜像详情格式无效：摘要必须是对象")
		}
		images = append(images, image)
	}
	return images, nil
}

// pullInput 解析后的拉取请求体。
type pullInput struct {
	name        string
	tag         string
	registry    string
	hasRegistry bool
}

// parsePullBody 校验拉取请求体（dockerService.ts parsePullBody 逐字）。
func parsePullBody(body any) (pullInput, error) {
	record, ok := asRecord(body)
	if !ok {
		return pullInput{}, shared.InvalidRequest("请求体必须是 JSON 对象")
	}
	if _, has := record.get("auth"); has {
		return pullInput{}, shared.InvalidRequest(pullAuthMessage)
	}
	if _, has := record.get("password"); has {
		return pullInput{}, shared.InvalidRequest(pullAuthMessage)
	}
	nameRaw, nameOK := asString(mustGet(record, "name"))
	tagRaw, tagOK := asString(mustGet(record, "tag"))
	if !nameOK || !tagOK {
		return pullInput{}, shared.InvalidRequest("请提供镜像名称与标签")
	}
	parsed, err := parseImageReference(strings.TrimSpace(nameRaw) + ":" + strings.TrimSpace(tagRaw))
	if err != nil {
		return pullInput{}, shared.InvalidRequest(err.Error())
	}
	input := pullInput{name: parsed.name, tag: parsed.tag}
	rawRegistry, hasRegistry := record.get("registry")
	if hasRegistry {
		registry, ok := asString(rawRegistry)
		if !ok {
			return pullInput{}, shared.InvalidRequest("镜像源格式无效")
		}
		trimmed := strings.TrimSpace(registry)
		if trimmed == "" {
			return pullInput{}, shared.InvalidRequest("镜像源不能为空")
		}
		input.registry = trimmed
		input.hasRegistry = true
	}
	return input, nil
}

// inspectImageById 镜像详情：404 →「镜像不存在，删除失败」。
func (s *dockerService) inspectImageByID(ctx context.Context, id string) (any, error) {
	engineID := id
	if !strings.Contains(id, ":") {
		engineID = normalizeImageID(id)
	}
	status, value, err := s.engineJSON(ctx, http.MethodGet, "/images/"+encodeEngineID(engineID)+"/json", nil, nil, actionTimeout)
	if err != nil {
		return nil, err
	}
	if status == http.StatusNotFound {
		return nil, &shared.InvalidRequestError{Status: http.StatusNotFound, Message: imageNotFoundMessage}
	}
	if status < 200 || status >= 300 {
		return nil, fmt.Errorf("获取镜像详情失败（HTTP %d）", status)
	}
	return value, nil
}

// deleteImageRefResult 删除引用结果：空 message 表示成功。
type deleteImageRefResult struct {
	message string
}

// deleteImageRef 按 force=false 删除一个镜像引用；失败带回引擎消息（或 HTTP N）。
func (s *dockerService) deleteImageRef(ctx context.Context, ref string) (deleteImageRefResult, error) {
	status, value, err := s.engineJSON(ctx, http.MethodDelete, "/images/"+encodeEngineID(ref), url.Values{"force": {"false"}}, nil, actionTimeout)
	if err != nil {
		return deleteImageRefResult{}, err
	}
	if status == http.StatusOK || status == http.StatusNoContent {
		return deleteImageRefResult{}, nil
	}
	return deleteImageRefResult{message: engineErrorMessage(value, fmt.Sprintf("HTTP %d", status))}, nil
}

// tagImageRef 打标签。
func (s *dockerService) tagImageRef(ctx context.Context, sourceRef, repo, tag string) error {
	query := url.Values{"repo": {repo}, "tag": {tag}}
	status, value, err := s.engineJSON(ctx, http.MethodPost, "/images/"+encodeEngineID(sourceRef)+"/tag", query, nil, actionTimeout)
	if err != nil {
		return err
	}
	if status < 200 || status >= 300 {
		return fmt.Errorf("镜像打标签失败（HTTP %d）：%s", status, engineErrorMessage(value, "未知错误"))
	}
	return nil
}

// countContainerImageReferences 逐容器 inspect 统计引用目标镜像的容器数
// （摘要 Image 是引用名，必须看详情里的完整 ID 才不漏判）。
func (s *dockerService) countContainerImageReferences(ctx context.Context, imageID string) (int, error) {
	status, value, err := s.engineJSON(ctx, http.MethodGet, "/containers/json", url.Values{"all": {"1"}}, nil, actionTimeout)
	if err != nil {
		return 0, err
	}
	if status < 200 || status >= 300 {
		return 0, fmt.Errorf("获取容器列表失败（HTTP %d）", status)
	}
	entries, ok := asArray(value)
	if !ok {
		return 0, errors.New("容器列表格式无效")
	}
	ids := make([]string, 0, len(entries))
	for _, entry := range entries {
		id, err := requireID(entry, "容器")
		if err != nil {
			return 0, err
		}
		ids = append(ids, id)
	}
	target := normalizeImageID(imageID)
	inspects, err := mapWithConcurrency(ids, inspectConcurrency, func(id string, _ int) (any, error) {
		inspect, err := s.inspectContainerByID(ctx, id, actionTimeout)
		if err != nil {
			var invalid *shared.InvalidRequestError
			if errors.As(err, &invalid) && invalid.Status == http.StatusNotFound {
				// 列表与详情之间容器被移除：它不可能再引用镜像，跳过。
				return nil, nil
			}
			return nil, err
		}
		return inspect, nil
	})
	if err != nil {
		return 0, err
	}
	count := 0
	for _, inspect := range inspects {
		record, ok := asRecord(inspect)
		if !ok {
			continue
		}
		image, ok := asString(mustGet(record, "Image"))
		if !ok {
			continue
		}
		if normalizeImageID(image) == target {
			count++
		}
	}
	return count, nil
}

// ---- seam.DockerViews ----

// ListContainers 列出全部容器（inspect 映射）。
func (s *dockerService) ListContainers(ctx context.Context) ([]contract.Container, error) {
	values, err := s.listWithInspect(ctx, "/containers/json", url.Values{"all": {"1"}},
		func(id string) string { return "/containers/" + encodeEngineID(id) + "/json" },
		"容器",
		func(_, inspect any) (any, error) { return mapContainer(inspect) })
	if err != nil {
		return nil, err
	}
	containers := make([]contract.Container, 0, len(values))
	for _, value := range values {
		container, ok := value.(contract.Container)
		if !ok {
			return nil, errors.New("容器详情格式无效：根对象必须是对象")
		}
		containers = append(containers, container)
	}
	return containers, nil
}

// ListImages 列出全部镜像。
func (s *dockerService) ListImages(ctx context.Context) ([]contract.ContainerImage, error) {
	return s.imagesFromList(ctx)
}

// Policy 挂载根与保留端口回显。
func (s *dockerService) Policy() seam.DockerPolicy {
	return seam.DockerPolicy{MountRoot: s.deps.mountRoot, ReservedPorts: s.deps.reservedPorts}
}

// SelfContainerID 空串 = 未识别。
func (s *dockerService) SelfContainerID() string {
	return s.deps.selfContainerID
}

// namesResult / tagsResult 搜索端点响应形状（键序即 JSON 输出序）。
type namesResult struct {
	Names      []string `json:"names"`
	Searchable bool     `json:"searchable"`
}

type tagsResult struct {
	Tags       []string `json:"tags"`
	Searchable bool     `json:"searchable"`
}

// SearchImages 镜像搜索：官方源走 Engine（limit=10、4s、128 KiB），自定义源走目录接口。
func (s *dockerService) SearchImages(ctx context.Context, rawTerm, registry string) (namesResult, error) {
	term := strings.ToLower(strings.TrimSpace(rawTerm))
	if len(term) < 2 || len(term) > 64 || !searchTermPattern.MatchString(term) {
		return namesResult{}, shared.InvalidRequest("镜像搜索词格式无效")
	}
	if !isOfficialImageRegistry(registry) {
		target, err := validateRegistryTarget(registry, func(hostname string) ([]string, error) {
			return s.deps.resolveRegistry(ctx, hostname)
		})
		if err != nil {
			return namesResult{}, shared.InvalidRequest(err.Error())
		}
		result := searchCatalog(ctx, target, term, s.deps.fetchCatalog)
		return namesResult{Names: result.names, Searchable: result.searchable}, nil
	}
	query := url.Values{"term": {term}, "limit": {itoa(imageSearchLimit)}}
	response, err := s.deps.transport.Request(ctx, seam.EngineRequest{
		Method:   http.MethodGet,
		Path:     "/images/search",
		Query:    query,
		Timeout:  searchTimeout,
		MaxBytes: searchMaxBytes,
	})
	if err != nil {
		return namesResult{}, err
	}
	var value any
	if len(response.Body) > 0 {
		value, _ = decodeOrderedJSON(response.Body)
	}
	entries, entriesOK := asArray(value)
	if response.Status < 200 || response.Status >= 300 || !entriesOK {
		return namesResult{}, fmt.Errorf("搜索官方镜像失败（HTTP %d）", response.Status)
	}
	seen := make(map[string]bool)
	names := make([]string, 0, imageSearchLimit)
	for _, entry := range entries {
		record, ok := asRecord(entry)
		if !ok {
			continue
		}
		name, ok := asString(mustGet(record, "name"))
		if !ok || !searchTermPattern.MatchString(name) {
			continue
		}
		if seen[name] {
			continue
		}
		seen[name] = true
		names = append(names, name)
		if len(names) >= imageSearchLimit {
			break
		}
	}
	return namesResult{Names: names, Searchable: true}, nil
}

// repoNameSegmentsValid 每段（按 / 切）须匹配 ^[a-z0-9][a-z0-9._-]*$。
func repoNameSegmentsValid(name string) bool {
	for _, segment := range strings.Split(name, "/") {
		if !repoNameSegmentRegexp.MatchString(segment) {
			return false
		}
	}
	return true
}

// ImageTags 镜像标签：官方源匿名令牌（失败 500 上抛），自定义源不带令牌。
func (s *dockerService) ImageTags(ctx context.Context, rawName, registry string) (tagsResult, error) {
	name := strings.ToLower(strings.TrimSpace(rawName))
	if len(name) == 0 || len(name) > 128 || !repoNameSegmentsValid(name) {
		return tagsResult{}, shared.InvalidRequest("镜像仓库名格式无效")
	}
	if !isOfficialImageRegistry(registry) {
		target, err := validateRegistryTarget(registry, func(hostname string) ([]string, error) {
			return s.deps.resolveRegistry(ctx, hostname)
		})
		if err != nil {
			return tagsResult{}, shared.InvalidRequest(err.Error())
		}
		result := listRegistryTags(ctx, registryRequestTarget{host: target.host, addresses: target.addresses}, name, s.deps.fetchTags, "")
		return tagsResult{Tags: result.tags, Searchable: result.searchable}, nil
	}
	repository := name
	if !strings.Contains(name, "/") {
		repository = "library/" + name
	}
	token, err := s.deps.fetchHubToken(ctx, repository)
	if err != nil {
		return tagsResult{}, err
	}
	result := listRegistryTags(ctx, registryRequestTarget{host: "registry-1.docker.io"}, repository, s.deps.fetchTags, token)
	return tagsResult{Tags: result.tags, Searchable: result.searchable}, nil
}
