package websites

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"elysian/server/internal/contract"
	"elysian/server/internal/seam"
	"elysian/server/internal/shared"
)

/*
 * 网站域编排层（websitesService.ts 逐字移植）：校验（手写中文校验，复用契约纯函数）、
 * 查重（名称跨类型全局唯一、域名唯一、端口三重查重）、容器与站点目录的创建/删除编排、
 * Caddy 配置的推导下发与漂移呈现。失败时报「已做到哪一步、还剩什么」，不伪装完成。
 *
 * 并发纪律（盘点 §11.1）：inProgress 集合（'create' 全局键 + 单项目 id 键，setAccess/
 * remove 双占）与 pushTail 下发队列（每次重读 registry）两把锁语义必须精确复刻——
 * 名称与域名的查重都是跨 await 的 check-then-act，整体在锁内才能关死并发窗口。
 */

// 面板与 SSH 保留端口（与容器页 createSpec 同一张表的前三项）；80/443 归宿主 Caddy。
var (
	panelReservedPorts = []int{22, 48100, 48101}
	proxyReservedPorts = []int{80, 443}
)

// createMutexKey 全局创建互斥键：串行化全部创建才能关死并发查重窗口。
const createMutexKey = "create"

// noteMaxLength 备注上限（与创建路径同一上限：登记读侧有 1 MiB 上限，无界备注可把
// 登记撑破到 list/remove 全体失败且面板内无法恢复）。
const noteMaxLength = 1024

// ---------- 请求形状 ----------

// accessInput 访问方式统一入口，密钥只在请求内短暂存在。
type accessInput struct {
	Mode           string
	Domain         string
	CertificatePEM *string
	PrivateKeyPEM  *string
}

// createRequest 创建请求（校验后的定形）。
type createRequest struct {
	Kind           string
	Name           string
	Port           int
	RuntimeVersion *string
	Access         accessInput
	Command        string
	GitURL         *string
	Note           *string
}

// optText 可选文本字段：present 标记字段是否出现在请求体（缺席保留原值），
// value 为 nil 表示 JSON null/空串（清空）。
type optText struct {
	present bool
	value   *string
}

// updateRequest 修改设置请求（全部可选字段）。
type updateRequest struct {
	Note     *optText
	ExpiryAt *optText
	Command  *optText
}

// caddyChannel 服务对 Caddy 通道的视图（生产实现为 caddyClient + AdminListen）。
type caddyChannel interface {
	AdminListen() string
	CurrentConfig(ctx context.Context) (json.RawMessage, *seam.CaddyChannelError)
	Load(ctx context.Context, config []byte) *seam.CaddyChannelError
}

// serviceDeps 编排依赖（全部可注入；装配层按真实接线构造）。
type serviceDeps struct {
	registry         Registry
	docker           dockerOps
	caddy            caddyChannel
	certificates     CertificateStore
	trustedRoots     []*x509.Certificate
	mountRoot        string
	runtimeCatalog   catalogSource
	listPortBindings func(ctx context.Context) ([]contract.PortBindingView, error)
	selfContainerID  string
	openFirewallPort func(ctx context.Context, port int, note string) contract.FirewallPortSync
}

// ---------- 对象校验 ----------

// validateWebsiteAccessRequest 访问方式统一校验：mode/domain/证书材料成对出现；
// domain 模式统一 trim().toLowerCase()。
func validateWebsiteAccessRequest(input any) (accessInput, error) {
	row := object(input)
	mode, _ := row["mode"].(string)
	if mode == AccessModeDirect {
		return accessInput{Mode: AccessModeDirect}, nil
	}
	if mode != AccessModeDomain {
		return accessInput{}, shared.InvalidRequest("请选择访问方式")
	}
	domain, _ := row["domain"].(string)
	if !IsValidWebsiteDomain(domain) {
		return accessInput{}, shared.InvalidRequest("域名无效")
	}
	certificatePem, hasCert := row["certificatePem"]
	privateKeyPem, hasKey := row["privateKeyPem"]
	// TS 以 undefined 判定「只传其一」；JSON null 同样算未传。
	certPresent := hasCert && certificatePem != nil
	keyPresent := hasKey && privateKeyPem != nil
	if certPresent != keyPresent {
		return accessInput{}, shared.InvalidRequest("请同时上传证书链和私钥")
	}
	parsed := accessInput{Mode: AccessModeDomain, Domain: strings.ToLower(strings.TrimSpace(domain))}
	if certPresent {
		certText, certOK := certificatePem.(string)
		keyText, keyOK := privateKeyPem.(string)
		if !certOK || !keyOK {
			return accessInput{}, shared.InvalidRequest("证书文件无效")
		}
		parsed.CertificatePEM = stringPtr(certText)
		parsed.PrivateKeyPEM = stringPtr(keyText)
	}
	return parsed, nil
}

// trimmed 可选文本：absent/null → nil；非字符串或 trim 后超长 → `<label>无效`；
// 空串 → nil。
func trimmed(value any, label string, maxLength int) (*string, error) {
	if value == nil {
		return nil, nil
	}
	text, ok := value.(string)
	if !ok {
		return nil, shared.InvalidRequest(label + "无效")
	}
	cut := strings.TrimSpace(text)
	if utf16Length(cut) > maxLength {
		return nil, shared.InvalidRequest(label + "无效")
	}
	if cut == "" {
		return nil, nil
	}
	return stringPtr(cut), nil
}

// normalizeExpiryAt 到期时间判据：YYYY-MM-DD 且是真实存在的日期（清空传 null 或
// 空串，即长期有效）。
func normalizeExpiryAt(value any) (*string, error) {
	if value == nil {
		return nil, nil
	}
	text, ok := value.(string)
	if !ok || !dateOnly.MatchString(text) {
		return nil, shared.InvalidRequest("到期时间格式无效")
	}
	parsed, err := time.Parse("2006-01-02T15:04:05Z", text+"T00:00:00Z")
	if err != nil || parsed.UTC().Format("2006-01-02") != text {
		return nil, shared.InvalidRequest("到期时间格式无效")
	}
	return stringPtr(text), nil
}

// validateWebsiteCreateRequest 创建请求校验（全部 400 拒绝，错误文案逐字对齐）。
func validateWebsiteCreateRequest(input any) (createRequest, error) {
	row := object(input)
	kind, _ := row["kind"].(string)
	if kind != KindJava && kind != KindNode && kind != KindGo && kind != KindPython && kind != KindHTML {
		return createRequest{}, shared.InvalidRequest("项目类型无效")
	}
	name, _ := row["name"].(string)
	if !IsValidWebsiteProjectName(name) {
		return createRequest{}, shared.InvalidRequest("项目名称需为 1-64 个字符，且不能包含路径分隔符或控制字符")
	}
	portValue, ok := row["port"].(float64)
	if !ok || !IsValidWebsitePort(portValue) {
		return createRequest{}, shared.InvalidRequest("端口需为 1-65535 的整数")
	}
	port := int(portValue)
	request := createRequest{Kind: kind, Name: strings.TrimSpace(name), Port: port}
	if kind != KindHTML {
		runtimeVersion, ok := row["runtimeVersion"].(string)
		if !ok || strings.TrimSpace(runtimeVersion) == "" {
			return createRequest{}, shared.InvalidRequest("请选择运行时版本")
		}
		if !IsWebsiteRuntimeReleaseVersion(kind, runtimeVersion) {
			return createRequest{}, shared.InvalidRequest("请选择正式运行时版本")
		}
		request.RuntimeVersion = stringPtr(runtimeVersion)
	}
	access, err := validateWebsiteAccessRequest(row["access"])
	if err != nil {
		return createRequest{}, err
	}
	if access.Mode == AccessModeDomain &&
		(access.CertificatePEM == nil || *access.CertificatePEM == "" || access.PrivateKeyPEM == nil || *access.PrivateKeyPEM == "") {
		return createRequest{}, shared.InvalidRequest("域名访问需要上传公开 CA 证书链和私钥")
	}
	request.Access = access
	if kind == KindHTML {
		request.Command = *WebsiteDefaultDeployCommand(KindHTML)
	} else {
		command, err := trimmed(row["command"], "启动命令", 2048)
		if err != nil {
			return createRequest{}, err
		}
		if command == nil {
			return createRequest{}, shared.InvalidRequest("请填写容器启动命令")
		}
		request.Command = *command
	}
	gitURL, err := trimmed(row["gitUrl"], "Git 地址", 2048)
	if err != nil {
		return createRequest{}, err
	}
	request.GitURL = gitURL
	note, err := trimmed(row["note"], "备注", noteMaxLength)
	if err != nil {
		return createRequest{}, err
	}
	request.Note = note
	return request, nil
}

// validateWebsiteUpdateRequest 修改设置请求校验：字段缺席保留原值，出现则校验
// （null/空串清空）。
func validateWebsiteUpdateRequest(input any) (updateRequest, error) {
	row := object(input)
	var request updateRequest
	if note, present := row["note"]; present {
		value, err := trimmed(note, "备注", noteMaxLength)
		if err != nil {
			return updateRequest{}, err
		}
		request.Note = &optText{present: true, value: value}
	}
	if expiry, present := row["expiryAt"]; present {
		value, err := normalizeExpiryAt(expiry)
		if err != nil {
			return updateRequest{}, err
		}
		request.ExpiryAt = &optText{present: true, value: value}
	}
	if command, present := row["command"]; present {
		value, err := trimmed(command, "启动命令", 2048)
		if err != nil {
			return updateRequest{}, err
		}
		request.Command = &optText{present: true, value: value}
	}
	return request, nil
}

// effectiveHostIp 缺省/空串折算 127.0.0.1（TS effectiveHostIp 等价物）。
func effectiveHostIp(hostIP string) string {
	if hostIP == "" {
		return "127.0.0.1"
	}
	return hostIP
}

// hostIpsOverlap 相等或任一为 0.0.0.0 即重叠。
func hostIpsOverlap(a string, b string) bool {
	return a == b || a == "0.0.0.0" || b == "0.0.0.0"
}

// caddyManagedSites 期望路由投影：只有域名模式生成反向代理路由。
func caddyManagedSites(rows []WebsiteRecord) []CaddyManagedSite {
	sites := make([]CaddyManagedSite, 0, len(rows))
	for _, row := range rows {
		if row.AccessMode != AccessModeDomain || row.Domain == nil {
			continue
		}
		sites = append(sites, CaddyManagedSite{Domain: *row.Domain, Port: row.Port})
	}
	return sites
}

// expectedProxyHosts 期望域名集合。
func expectedProxyHosts(rows []WebsiteRecord) map[string]struct{} {
	hosts := map[string]struct{}{}
	for _, row := range rows {
		if row.AccessMode == AccessModeDomain && row.Domain != nil {
			hosts[*row.Domain] = struct{}{}
		}
	}
	return hosts
}

// ---------- 并发原语 ----------

// mutexSet inProgress 集合（TS Set 等价物）。
type mutexSet struct {
	mu    sync.Mutex
	items map[string]struct{}
}

func newMutexSet() *mutexSet { return &mutexSet{items: map[string]struct{}{}} }

func (m *mutexSet) has(key string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, ok := m.items[key]
	return ok
}

func (m *mutexSet) add(key string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.items[key] = struct{}{}
}

func (m *mutexSet) remove(key string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.items, key)
}

// pushQueue 下发队列：同进程内的全部下发串行执行，且每次都从 registry 重新读取再
// 推导。没有它，两个并发站点写各自拿着旧快照整配置替换，后发会把先发刚下发的路由
// 回滚掉（TS pushTail promise 链的 goroutine 等价物：任务接链执行，调用方阻塞等待）。
type pushQueue struct {
	mu   sync.Mutex
	prev chan struct{}
}

// run 把任务接到串行队列尾部并阻塞等待其完成。
func (q *pushQueue) run(task func()) {
	q.mu.Lock()
	prev := q.prev
	done := make(chan struct{})
	q.prev = done
	q.mu.Unlock()
	if prev != nil {
		<-prev
	}
	defer close(done)
	task()
}

// ---------- 服务 ----------

// websiteService 编排服务实现。
type websiteService struct {
	deps       serviceDeps
	inProgress *mutexSet
	queue      *pushQueue
}

// NewWebsiteService 组装编排服务。certificates 为 nil 时落内存版（测试/降级）；
// openFirewallPort 为 nil 时恒 skipped（防火墙片不可用，端口未自动开放）。
func NewWebsiteService(deps serviceDeps) *websiteService {
	if deps.certificates == nil {
		deps.certificates = NewMemoryWebsiteCertificateStore()
	}
	if deps.openFirewallPort == nil {
		deps.openFirewallPort = func(_ context.Context, port int, _ string) contract.FirewallPortSync {
			detail := contract.FirewallPortSyncDetailSkipped
			return contract.FirewallPortSync{State: contract.FirewallPortSyncSkipped, Port: port, Detail: &detail}
		}
	}
	return &websiteService{deps: deps, inProgress: newMutexSet(), queue: &pushQueue{}}
}

// record 单项目读取：不存在 → 404「未找到项目 <id>」。
func (s *websiteService) record(ctx context.Context, id string) (WebsiteRecord, error) {
	rows, err := s.deps.registry.List(ctx)
	if err != nil {
		return WebsiteRecord{}, err
	}
	for _, row := range rows {
		if row.ID == id {
			return row, nil
		}
	}
	return WebsiteRecord{}, &shared.InvalidRequestError{Status: 404, Message: fmt.Sprintf("未找到项目 %s", id)}
}

// currentConfigOrNull 当前配置读取，任何失败（含连接类）都折算 null。
func (s *websiteService) currentConfigOrNull(ctx context.Context) any {
	config, err := s.deps.caddy.CurrentConfig(ctx)
	if err != nil {
		return nil
	}
	return parseJSONValue(config)
}

// parseJSONValue 把 RawMessage 解析为判读函数可导航的值；空/坏值回 nil。
func parseJSONValue(raw json.RawMessage) any {
	if len(raw) == 0 {
		return nil
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil
	}
	return value
}

// projectRow 单行投影：containerId 非空时 docker inspect 取运行状态与宿主 PID；
// 容器已被外部删除（404）→ 折算 stopped/pid=null、containerId 保留登记值如实显示，
// 非 404 错误原样上抛。
func (s *websiteService) projectRow(ctx context.Context, row WebsiteRecord, config any) (websiteProject, error) {
	running := false
	var pid *int
	if row.ContainerID != nil {
		info, err := s.deps.docker.Inspect(ctx, *row.ContainerID)
		if err != nil {
			var invalid *shared.InvalidRequestError
			if !errors.As(err, &invalid) || invalid.Status != 404 {
				return websiteProject{}, err
			}
		} else {
			state := object(info["State"])
			if value, ok := state["Running"].(bool); ok && value {
				running = true
			}
			if value, ok := state["Pid"].(float64); ok && value > 0 {
				pidValue := int(value)
				pid = &pidValue
			}
		}
	}
	routeApplied := false
	if row.Domain != nil && config != nil {
		sites := caddyManagedSites([]WebsiteRecord{row})
		_, routeApplied = AppliedManagedHosts(sites, config)[*row.Domain]
	}
	project := websiteProject{
		ID:             row.ID,
		Kind:           row.Kind,
		Name:           row.Name,
		Pid:            pid,
		ContainerID:    row.ContainerID,
		Port:           row.Port,
		RuntimeVersion: row.RuntimeVersion,
		RootDir:        row.RootDir,
		RunState:       RunStateStopped,
		AccessMode:     row.AccessMode,
		Domain:         row.Domain,
		RouteApplied:   routeApplied,
		ExpiryAt:       row.ExpiryAt,
		Note:           row.Note,
		Category:       row.Category,
		DeployCommand:  row.DeployCommand,
		GitURL:         row.GitURL,
		Traffic:        websiteTraffic{TodayMb: 0, TotalGb: 0},
	}
	if running {
		project.RunState = RunStateRunning
	}
	if row.Certificate != nil {
		applied := false
		if config != nil {
			_, applied = AppliedCertificateFingerprints(config)[row.Certificate.Fingerprint256]
		}
		project.Certificate = &websiteCertificate{
			Issuer:         row.Certificate.Issuer,
			NotAfter:       row.Certificate.NotAfter,
			Fingerprint256: row.Certificate.Fingerprint256,
			Applied:        applied,
		}
	}
	return project, nil
}

// caddyPushResult 下发结果：成功给出已下发配置；通道不可用给出中文原因。
type caddyPushResult struct {
	applied bool
	config  any
	detail  *string
}

// sitesWithCertificates 每个域名站点必须能从证书存储读出材料，缺登记抛错误。
func (s *websiteService) sitesWithCertificates(ctx context.Context, rows []WebsiteRecord) ([]CaddyManagedSite, error) {
	sites := caddyManagedSites(rows)
	out := make([]CaddyManagedSite, 0, len(sites))
	for _, site := range sites {
		ref := ""
		found := false
		for _, row := range rows {
			if row.Domain != nil && *row.Domain == site.Domain {
				if row.Certificate == nil {
					return nil, fmt.Errorf("域名 %s 缺少证书登记", site.Domain)
				}
				ref = row.Certificate.Ref
				found = true
				break
			}
		}
		if !found {
			return nil, fmt.Errorf("域名 %s 缺少证书登记", site.Domain)
		}
		material, err := s.deps.certificates.Read(ctx, ref)
		if err != nil {
			return nil, err
		}
		cert := material.CertificatePEM
		key := material.PrivateKeyPEM
		out = append(out, CaddyManagedSite{Domain: site.Domain, Port: site.Port, CertificatePEM: &cert, PrivateKeyPEM: &key})
	}
	return out, nil
}

// pushCaddyConfig 下发核心（站点变更与对账共用一份编排）：读当前配置 → 外部配置
// 防护 → POST /load 整配置原子替换。通道不可用按结果返回（调用方决定跳过还是呈现）；
// 存在面板外配置（409）或下发被拒时抛中文错误。
func (s *websiteService) pushCaddyConfig(ctx context.Context, rows []WebsiteRecord, knownHosts map[string]struct{}) (caddyPushResult, error) {
	if knownHosts == nil {
		knownHosts = expectedProxyHosts(rows)
	}
	sites, err := s.sitesWithCertificates(ctx, rows)
	if err != nil {
		return caddyPushResult{}, err
	}
	config := BuildCaddyConfig(sites, s.deps.caddy.AdminListen())
	currentRaw, cerr := s.deps.caddy.CurrentConfig(ctx)
	if cerr != nil {
		return caddyPushResult{applied: false, detail: caddyChannelStatus(cerr).Detail}, nil
	}
	current := parseJSONValue(currentRaw)
	if HasForeignConfig(current, knownHosts, s.deps.caddy.AdminListen()) {
		return caddyPushResult{}, &shared.InvalidRequestError{Status: 409, Message: "宿主 Caddy 存在面板外的配置，拒绝覆盖"}
	}
	if lerr := s.deps.caddy.Load(ctx, config); lerr != nil {
		return caddyPushResult{}, fmt.Errorf("反向代理配置下发被拒绝：%s", lerr.Error())
	}
	return caddyPushResult{applied: true, config: parseJSONValue(config)}, nil
}

// assertPortAvailable 端口三重查重：保留端口 → 现有容器绑定（含 0.0.0.0 重叠）→
// registry 已登记站点。
func (s *websiteService) assertPortAvailable(ctx context.Context, port int, rows []WebsiteRecord) error {
	for _, reserved := range panelReservedPorts {
		if port == reserved {
			return shared.InvalidRequest(fmt.Sprintf("宿主端口为面板保留：%d", port))
		}
	}
	for _, reserved := range proxyReservedPorts {
		if port == reserved {
			return shared.InvalidRequest(fmt.Sprintf("宿主端口由反向代理保留：%d", port))
		}
	}
	bindings, err := s.deps.listPortBindings(ctx)
	if err != nil {
		return err
	}
	for _, binding := range bindings {
		if binding.Protocol != "udp" &&
			binding.HostPort == port &&
			hostIpsOverlap("127.0.0.1", effectiveHostIp(binding.HostIP)) {
			return &shared.InvalidRequestError{Status: 409, Message: fmt.Sprintf("宿主端口已被占用：%d/tcp", port)}
		}
	}
	for _, row := range rows {
		if row.Port == port {
			return &shared.InvalidRequestError{Status: 409, Message: fmt.Sprintf("宿主端口已被站点占用：%d", port)}
		}
	}
	return nil
}

// List 站点列表：代理状态推导 + 逐行投影。通道失败（含连接类）→ unavailable + 中文
// 原因，config 置 null；期望域名有缺口 → active + 「N 个站点的路由未下发」。
func (s *websiteService) List(ctx context.Context) (websiteListReport, error) {
	rows, err := s.deps.registry.List(ctx)
	if err != nil {
		return websiteListReport{}, err
	}
	expectedHosts := expectedProxyHosts(rows)
	var config any
	var proxy websiteProxyStatus
	if currentRaw, cerr := s.deps.caddy.CurrentConfig(ctx); cerr != nil {
		config = nil
		proxy = caddyChannelStatus(cerr)
	} else {
		config = parseJSONValue(currentRaw)
		applied := AppliedManagedHosts(caddyManagedSites(rows), config)
		missing := 0
		for host := range expectedHosts {
			if _, ok := applied[host]; !ok {
				missing++
			}
		}
		if missing > 0 {
			detail := fmt.Sprintf("%d 个站点的路由未下发", missing)
			proxy = websiteProxyStatus{State: ProxyStateActive, Detail: &detail}
		} else {
			proxy = websiteProxyStatus{State: ProxyStateActive, Detail: nil}
		}
	}
	projects := make([]websiteProject, 0, len(rows))
	for _, row := range rows {
		project, err := s.projectRow(ctx, row, config)
		if err != nil {
			return websiteListReport{}, err
		}
		projects = append(projects, project)
	}
	return websiteListReport{Projects: projects, Proxy: proxy}, nil
}

// RuntimeCatalog 版本目录透传。
func (s *websiteService) RuntimeCatalog(ctx context.Context) (runtimeCatalogReport, error) {
	return s.deps.runtimeCatalog.Get(ctx)
}
