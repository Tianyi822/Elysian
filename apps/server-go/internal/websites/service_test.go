package websites

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"

	"elysian/server/internal/contract"
	"elysian/server/internal/seam"
)

// 编排服务（websitesService.test.ts 16 例的 Go 对等，fixture 全 fake docker/caddy/
// registry/certs）。并发互斥两例用门控假件制造真实的进行中窗口。

// ---------- fakes ----------

type fakeDockerOps struct {
	mu         sync.Mutex
	calls      []string
	states     map[string]bool
	sequence   int
	createGate chan struct{}
	stopGate   chan struct{}
	entered    chan struct{}
}

func newFakeDockerOps() *fakeDockerOps {
	return &fakeDockerOps{states: map[string]bool{}}
}

func (d *fakeDockerOps) record(call string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.calls = append(d.calls, call)
}

func (d *fakeDockerOps) snapshotCalls() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]string{}, d.calls...)
}

func (d *fakeDockerOps) EnsureImage(_ context.Context, ref string) error {
	d.record("image:" + ref)
	return nil
}

func (d *fakeDockerOps) EnsureSiteDir(name string, _ string) (string, error) {
	return "/srv/wwwroot/" + name, nil
}

func (d *fakeDockerOps) NewContainerName() string {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.sequence++
	return fmt.Sprintf("elysian-site-%012d", d.sequence)
}

func (d *fakeDockerOps) Create(_ context.Context, input containerCreateInput) (string, error) {
	d.mu.Lock()
	gate := d.createGate
	if gate != nil {
		if d.entered != nil {
			close(d.entered)
			d.entered = nil
		}
	}
	d.mu.Unlock()
	if gate != nil {
		<-gate
	}
	d.mu.Lock()
	d.sequence++
	id := fmt.Sprintf("%064x", d.sequence)
	d.states[id] = false
	d.mu.Unlock()
	d.record(fmt.Sprintf("create:%s:%s:%d", input.Kind, input.AccessMode, input.Port))
	return id, nil
}

func (d *fakeDockerOps) Start(_ context.Context, id string) error {
	d.mu.Lock()
	d.states[id] = true
	d.mu.Unlock()
	d.record("start:" + id)
	return nil
}

func (d *fakeDockerOps) Stop(_ context.Context, id string) error {
	d.mu.Lock()
	gate := d.stopGate
	if gate != nil {
		if d.entered != nil {
			close(d.entered)
			d.entered = nil
		}
	}
	d.mu.Unlock()
	if gate != nil {
		<-gate
	}
	d.mu.Lock()
	d.states[id] = false
	d.mu.Unlock()
	d.record("stop:" + id)
	return nil
}

func (d *fakeDockerOps) Inspect(_ context.Context, id string) (map[string]any, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	running, ok := d.states[id]
	if !ok {
		return nil, errors.New("容器不存在")
	}
	pid := 0
	if running {
		pid = 123
	}
	return map[string]any{"State": map[string]any{"Running": running, "Pid": pid}}, nil
}

func (d *fakeDockerOps) Logs(_ context.Context, id string) ([]string, error) {
	return []string{"容器 " + id + " 日志"}, nil
}

func (d *fakeDockerOps) RemoveManaged(_ context.Context, identity containerIdentity) (string, error) {
	d.mu.Lock()
	delete(d.states, identity.ContainerID)
	d.mu.Unlock()
	d.record("remove:" + identity.ContainerID)
	return "removed", nil
}

func (d *fakeDockerOps) RemoveCreated(_ context.Context, containerID string) error {
	d.mu.Lock()
	delete(d.states, containerID)
	d.mu.Unlock()
	d.record("rollback:" + containerID)
	return nil
}

func (d *fakeDockerOps) RemoveSiteDir(string, string) error {
	d.record("remove-dir")
	return nil
}

type fakeCaddyChannel struct {
	mu       sync.Mutex
	listen   string
	config   any
	failLoad bool
	down     bool
	calls    *[]string
}

func (c *fakeCaddyChannel) AdminListen() string { return c.listen }

func (c *fakeCaddyChannel) CurrentConfig(context.Context) (json.RawMessage, *seam.CaddyChannelError) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.down {
		return nil, &seam.CaddyChannelError{Unavailable: true, Message: seam.CaddyChannelUnavailableDetail}
	}
	data, err := marshalJSONCompact(c.config)
	if err != nil {
		return nil, &seam.CaddyChannelError{Unavailable: false, Message: err.Error()}
	}
	return data, nil
}

func (c *fakeCaddyChannel) Load(_ context.Context, config []byte) *seam.CaddyChannelError {
	c.mu.Lock()
	defer c.mu.Unlock()
	*c.calls = append(*c.calls, "caddy-load")
	if c.failLoad {
		return &seam.CaddyChannelError{Unavailable: false, Message: "模拟下发失败"}
	}
	c.config = parseJSONValue(config)
	return nil
}

func (c *fakeCaddyChannel) getConfig() any {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.config
}

func (c *fakeCaddyChannel) configJSON(t *testing.T) string {
	t.Helper()
	data, err := marshalJSONCompact(c.getConfig())
	if err != nil {
		t.Fatalf("序列化配置失败：%v", err)
	}
	return string(data)
}

func (c *fakeCaddyChannel) setConfig(value any) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.config = value
}

type fakeCatalogSource struct {
	mu     sync.Mutex
	err    error
	report runtimeCatalogReport
}

func (f *fakeCatalogSource) Get(context.Context) (runtimeCatalogReport, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return runtimeCatalogReport{}, f.err
	}
	return f.report, nil
}

// ---------- fixture ----------

type firewallRecord struct {
	port int
	note string
}

type fixtureOut struct {
	service   *websiteService
	docker    *fakeDockerOps
	caddy     *fakeCaddyChannel
	calls     *[]string
	portOpens *[]firewallRecord
	registry  Registry
}

// fixture 组装全 fake 服务；openFirewall 传 useNilOpener{} 表示不注入（检验缺省
// skipped 行为），传 func 表示注入自定义，其余注入记录型 opened。
func fixture(t *testing.T, registry Registry, trustedRoots []*x509.Certificate, openFirewall any, catalog catalogSource) fixtureOut {
	t.Helper()
	if registry == nil {
		registry = NewMemoryWebsiteRegistry()
	}
	docker := newFakeDockerOps()
	calls := []string{}
	caddy := &fakeCaddyChannel{listen: testAdminListen, config: parseJSONValue(BuildCaddyConfig(nil, testAdminListen)), calls: &calls}
	if catalog == nil {
		catalog = &fakeCatalogSource{report: runtimeReportFixture()}
	}
	var portOpens []firewallRecord
	deps := serviceDeps{
		registry:         registry,
		docker:           docker,
		caddy:            caddy,
		certificates:     NewMemoryWebsiteCertificateStore(),
		trustedRoots:     trustedRoots,
		mountRoot:        "/srv",
		runtimeCatalog:   catalog,
		listPortBindings: func(context.Context) ([]contract.PortBindingView, error) { return nil, nil },
	}
	switch value := openFirewall.(type) {
	case useNilOpener:
		// 不注入：走缺省恒 skipped。
	case func(context.Context, int, string) contract.FirewallPortSync:
		deps.openFirewallPort = value
	default:
		deps.openFirewallPort = func(_ context.Context, port int, note string) contract.FirewallPortSync {
			portOpens = append(portOpens, firewallRecord{port: port, note: note})
			return contract.FirewallPortSync{State: contract.FirewallPortSyncOpened, Port: port, Detail: nil}
		}
	}
	service := NewWebsiteService(deps)
	return fixtureOut{service: service, docker: docker, caddy: caddy, calls: &calls, portOpens: &portOpens, registry: registry}
}

// useNilOpener fixture 的哨兵类型：不注入端口开放函数。
type useNilOpener struct{}

// requireError 断言错误包含子串。
func requireError(t *testing.T, err error, substr string) {
	t.Helper()
	if err == nil {
		t.Fatalf("应当失败（期望含 %q）", substr)
	}
	if !strings.Contains(err.Error(), substr) {
		t.Fatalf("错误应含 %q，得到 %q", substr, err.Error())
	}
}

// buildCreate 以 map 请求体过统一校验（先过 JSON 编解码对齐真实请求的数值形态）。
func buildCreate(t *testing.T, body map[string]any) createRequest {
	t.Helper()
	request, err := validateWebsiteCreateRequest(marshalAnyValue(body))
	if err != nil {
		t.Fatalf("构造创建请求失败：%v", err)
	}
	return request
}

// nodeDirectRequest 节点直连项目（与 TS request() 帮助函数同形）。
func nodeDirectRequest(t *testing.T, kind string, port int, name string) createRequest {
	body := map[string]any{
		"kind": kind, "name": name, "port": port,
		"access": map[string]any{"mode": "direct"},
	}
	if kind == KindHTML {
		body["runtimeVersion"] = nil
		body["command"] = nil
	} else {
		body["runtimeVersion"] = "24.21.0"
		body["command"] = "node dist/server.js"
	}
	return buildCreate(t, body)
}

// domainRequest 域名项目。
func domainRequest(t *testing.T, kind string, port int, name, domain string, chain testChain) createRequest {
	body := map[string]any{
		"kind": kind, "name": name, "port": port,
		"runtimeVersion": nil,
		"access": map[string]any{
			"mode": "domain", "domain": domain,
			"certificatePem": chain.CertificatePEM, "privateKeyPem": chain.PrivateKeyPEM,
		},
	}
	if kind != KindHTML {
		body["runtimeVersion"] = "24.21.0"
		body["command"] = "node dist/server.js"
	}
	return buildCreate(t, body)
}

// ---------- 「网站访问与容器编排」12 例 ----------

func TestRuntimeCreateRequiresExplicitCommand(t *testing.T) {
	for _, item := range []struct{ kind, version, command string }{
		{KindNode, "24.21.0", "node app.js"},
		{KindPython, "3.9.7", "python3 app.py"},
	} {
		t.Run(item.kind, func(t *testing.T) {
			body := map[string]any{
				"kind": item.kind, "name": "app", "port": 8080,
				"runtimeVersion": item.version, "access": map[string]any{"mode": "direct"},
			}
			for _, command := range []any{nil, "", "   "} {
				body["command"] = command
				_, err := validateWebsiteCreateRequest(marshalAnyValue(body))
				requireError(t, err, "请填写容器启动命令")
			}
			delete(body, "command")
			_, err := validateWebsiteCreateRequest(marshalAnyValue(body))
			requireError(t, err, "请填写容器启动命令")
			body["command"] = item.command
			request := buildCreate(t, body)
			if request.Command != item.command {
				t.Fatalf("应使用用户填写的命令，得到 %q", request.Command)
			}
		})
	}
}

func TestCreateRejectsVersionOutsideCatalog(t *testing.T) {
	f := fixture(t, nil, nil, nil, nil)
	body := nodeDirectRequest(t, KindNode, 3000, "site")
	body.RuntimeVersion = stringPtr("99.9.9")
	_, err := f.service.Create(context.Background(), body)
	requireError(t, err, "不在正式可选目录")
	if calls := f.docker.snapshotCalls(); len(calls) != 0 {
		t.Fatalf("应零副作用，得到 %v", calls)
	}
	rows, _ := f.registry.List(context.Background())
	if len(rows) != 0 {
		t.Fatalf("不应留下登记")
	}
	_, err = validateWebsiteCreateRequest(marshalAnyValue(map[string]any{
		"kind": KindNode, "name": "site", "port": 3000, "runtimeVersion": "24.22.0-rc.1",
		"access": map[string]any{"mode": "direct"}, "command": "node x",
	}))
	requireError(t, err, "版本")
}

func TestCreateOfflineStillAllowsHTMLAndRunning(t *testing.T) {
	source := &fakeCatalogSource{report: runtimeReportFixture()}
	f := fixture(t, nil, nil, nil, source)
	node, err := f.service.Create(context.Background(), nodeDirectRequest(t, KindNode, 3000, "site"))
	if err != nil {
		t.Fatalf("node 创建应成功：%v", err)
	}
	source.mu.Lock()
	source.err = errors.New("版本目录网络不可用")
	source.mu.Unlock()
	html, err := f.service.Create(context.Background(), nodeDirectRequest(t, KindHTML, 8088, "docs"))
	if err != nil {
		t.Fatalf("离线时 HTML 项目（固定镜像）仍应创建：%v", err)
	}
	if html.Project.Kind != KindHTML {
		t.Fatalf("应为 html 项目")
	}
	running, err := f.service.SetRunning(context.Background(), node.Project.ID, true)
	if err != nil || running.RunState != RunStateRunning {
		t.Fatalf("已登记项目仍可启停：%v", err)
	}
	_, err = f.service.Create(context.Background(), nodeDirectRequest(t, KindNode, 3001, "another"))
	requireError(t, err, "版本目录网络不可用")
}

func TestCreateStoppedContainersAndLogs(t *testing.T) {
	f := fixture(t, nil, nil, nil, nil)
	node, err := f.service.Create(context.Background(), nodeDirectRequest(t, KindNode, 3000, "site"))
	if err != nil {
		t.Fatalf("node 创建失败：%v", err)
	}
	html, err := f.service.Create(context.Background(), nodeDirectRequest(t, KindHTML, 8088, "docs"))
	if err != nil {
		t.Fatalf("html 创建失败：%v", err)
	}
	if node.Project.AccessMode != AccessModeDirect || node.Project.RunState != RunStateStopped {
		t.Fatalf("node 应为直连已停止")
	}
	if len(*html.Project.ContainerID) != 64 || len(*node.Project.ContainerID) != 64 {
		t.Fatalf("containerId 应为 64 位 hex")
	}
	if html.Project.DeployCommand == nil || *html.Project.DeployCommand != "nginx -g daemon off;" {
		t.Fatalf("html 应固化 Nginx 命令")
	}
	foundImage := false
	started := false
	for _, call := range f.docker.snapshotCalls() {
		if call == "image:"+WEBSITE_HTML_IMAGE {
			foundImage = true
		}
		if strings.HasPrefix(call, "start:") {
			started = true
		}
	}
	if !foundImage || started {
		t.Fatalf("应核对镜像且不启动容器：%v", f.docker.snapshotCalls())
	}
	if _, err := f.service.SetRunning(context.Background(), html.Project.ID, true); err != nil {
		t.Fatalf("启停失败：%v", err)
	}
	lines, err := f.service.Logs(context.Background(), html.Project.ID)
	if err != nil || len(lines) != 1 {
		t.Fatalf("logs 应返回行数组：%v", err)
	}
}

func TestDirectProjectsHaveIndependentContainersWithoutCaddy(t *testing.T) {
	f := fixture(t, nil, nil, nil, nil)
	f.caddy.down = true
	cases := []struct {
		kind    string
		version any
		command any
	}{
		{KindHTML, nil, nil},
		{KindHTML, nil, nil},
		{KindJava, "17.0.1+12", "java -jar app.jar"},
		{KindNode, "24.21.0", "node dist/server.js"},
		{KindGo, "1.16.7", "./server"},
		{KindPython, "3.9.7", "python -m http.server 18085"},
	}
	ids := map[string]bool{}
	names := map[string]bool{}
	roots := map[string]bool{}
	var projects []websiteProject
	for i, tc := range cases {
		request := buildCreate(t, map[string]any{
			"kind": tc.kind, "name": fmt.Sprintf("site-%d", i), "port": 18080 + i,
			"runtimeVersion": tc.version, "command": tc.command,
			"access": map[string]any{"mode": AccessModeDirect},
		})
		result, err := f.service.Create(context.Background(), request)
		if err != nil {
			t.Fatalf("Caddy 缺失时 %s 项目应可创建：%v", tc.kind, err)
		}
		project := result.Project
		if project.ContainerID == nil || project.RunState != RunStateStopped {
			t.Fatalf("每个项目应有独立的已停止容器：%+v", project)
		}
		if ids[*project.ContainerID] || roots[project.RootDir] {
			t.Fatalf("项目之间不得共用容器 ID 或站点目录：%+v", project)
		}
		ids[*project.ContainerID] = true
		roots[project.RootDir] = true
		projects = append(projects, project)
	}
	rows, err := f.registry.List(context.Background())
	if err != nil || len(rows) != len(cases) {
		t.Fatalf("每个项目应独立登记：%v", err)
	}
	for _, row := range rows {
		if row.ContainerName == nil || names[*row.ContainerName] {
			t.Fatalf("项目之间不得共用容器名：%+v", row)
		}
		names[*row.ContainerName] = true
	}
	createCount := 0
	for _, call := range f.docker.snapshotCalls() {
		if strings.HasPrefix(call, "create:") {
			createCount++
		}
	}
	if createCount != len(cases) {
		t.Fatalf("每个项目应单独创建容器，得到 %d 次创建", createCount)
	}
	for _, project := range projects[:2] {
		if _, err := f.service.SetRunning(context.Background(), project.ID, true); err != nil {
			t.Fatalf("Caddy 缺失时项目应可启动：%v", err)
		}
	}
	if _, err := f.service.SetRunning(context.Background(), projects[0].ID, false); err != nil {
		t.Fatalf("项目应可单独停止：%v", err)
	}
	report, err := f.service.List(context.Background())
	if err != nil {
		t.Fatalf("Caddy 缺失时项目应可列出：%v", err)
	}
	for _, project := range report.Projects {
		expected := RunStateStopped
		if project.ID == projects[1].ID {
			expected = RunStateRunning
		}
		if project.RunState != expected {
			t.Fatalf("单个项目启停不得影响其他容器：%s 应为 %s，得到 %s", project.Name, expected, project.RunState)
		}
	}
	if len(*f.calls) != 0 {
		t.Fatalf("直连容器生命周期不得下发 Caddy 配置：%v", *f.calls)
	}
}

func TestDomainRequiresCertificateAndNormalizes(t *testing.T) {
	chain := makeTestChain(t)
	f := fixture(t, nil, parseTrustedRoots(t, chain.RootPEM), nil, nil)
	_, err := validateWebsiteCreateRequest(marshalAnyValue(map[string]any{
		"kind": KindHTML, "name": "x", "port": 8080,
		"access": map[string]any{"mode": "domain", "domain": "example.com"},
	}))
	requireError(t, err, "证书链")
	created, err := f.service.Create(context.Background(), domainRequest(t, KindHTML, 8080, "a", "EXAMPLE.COM", chain))
	if err != nil {
		t.Fatalf("域名创建应成功：%v", err)
	}
	if created.Project.Domain == nil || *created.Project.Domain != "example.com" {
		t.Fatalf("域名应归一小写")
	}
	if !created.Project.RouteApplied || created.Project.Certificate == nil || !created.Project.Certificate.Applied {
		t.Fatalf("路由与证书应呈已下发")
	}
	createdJSON, _ := marshalJSONCompact(created)
	if strings.Contains(string(createdJSON), "PRIVATE KEY") {
		t.Fatalf("响应不得含私钥痕迹")
	}
	list, err := f.service.List(context.Background())
	if err != nil {
		t.Fatalf("列表失败：%v", err)
	}
	listJSON, _ := marshalJSONCompact(list)
	if strings.Contains(string(listJSON), "PRIVATE KEY") {
		t.Fatalf("列表不得含私钥痕迹")
	}
	_, err = f.service.Create(context.Background(), domainRequest(t, KindHTML, 8081, "b", "example.com", chain))
	requireError(t, err, "域名已被绑定")
}

func TestAccessSwitchRebuildsContainer(t *testing.T) {
	chain := makeTestChain(t)
	f := fixture(t, nil, parseTrustedRoots(t, chain.RootPEM), nil, nil)
	direct, err := f.service.Create(context.Background(), nodeDirectRequest(t, KindNode, 3000, "site"))
	if err != nil {
		t.Fatalf("创建失败：%v", err)
	}
	if _, err := f.service.SetRunning(context.Background(), direct.Project.ID, true); err != nil {
		t.Fatalf("启动失败：%v", err)
	}
	domain, err := f.service.SetAccess(context.Background(), direct.Project.ID, accessInput{
		Mode: AccessModeDomain, Domain: "example.com",
		CertificatePEM: stringPtr(chain.CertificatePEM), PrivateKeyPEM: stringPtr(chain.PrivateKeyPEM),
	})
	if err != nil {
		t.Fatalf("切域名失败：%v", err)
	}
	if *domain.Project.ContainerID == *direct.Project.ContainerID {
		t.Fatalf("切模式应重建容器")
	}
	if domain.Project.RootDir != direct.Project.RootDir {
		t.Fatalf("站点目录应保留")
	}
	if domain.Project.RunState != RunStateRunning || !domain.Project.RouteApplied {
		t.Fatalf("运行状态应保持且路由应已下发")
	}
	reverted, err := f.service.SetAccess(context.Background(), direct.Project.ID, accessInput{Mode: AccessModeDirect})
	if err != nil {
		t.Fatalf("切回直连失败：%v", err)
	}
	if reverted.Project.Domain != nil || reverted.Project.Certificate != nil {
		t.Fatalf("直连应无域名与证书")
	}
	removes := 0
	for _, call := range f.docker.snapshotCalls() {
		if strings.HasPrefix(call, "remove:") {
			removes++
		}
	}
	if removes != 2 {
		t.Fatalf("两次切换应各删旧容器一次，得到 %d", removes)
	}
}

func TestSameDomainReplacesCertificateOnly(t *testing.T) {
	first := makeTestChain(t)
	second := makeTestChain(t)
	f := fixture(t, nil, parseTrustedRoots(t, first.RootPEM, second.RootPEM), nil, nil)
	created, err := f.service.Create(context.Background(), domainRequest(t, KindHTML, 8088, "docs", "example.com", first))
	if err != nil {
		t.Fatalf("创建失败：%v", err)
	}
	updated, err := f.service.SetAccess(context.Background(), created.Project.ID, accessInput{
		Mode: AccessModeDomain, Domain: "example.com",
		CertificatePEM: stringPtr(second.CertificatePEM), PrivateKeyPEM: stringPtr(second.PrivateKeyPEM),
	})
	if err != nil {
		t.Fatalf("换证书失败：%v", err)
	}
	if *updated.Project.ContainerID != *created.Project.ContainerID {
		t.Fatalf("同域名换证书不应重建容器")
	}
	if updated.Project.Certificate.Fingerprint256 == created.Project.Certificate.Fingerprint256 {
		t.Fatalf("指纹应更新")
	}
	if !updated.Project.Certificate.Applied {
		t.Fatalf("新证书应呈已下发")
	}
	creates := 0
	for _, call := range f.docker.snapshotCalls() {
		if strings.HasPrefix(call, "create:") {
			creates++
		}
	}
	if creates != 1 {
		t.Fatalf("create 应恰一次，得到 %d", creates)
	}
}

func TestAccessLoadFailureRestores(t *testing.T) {
	chain := makeTestChain(t)
	f := fixture(t, nil, parseTrustedRoots(t, chain.RootPEM), nil, nil)
	direct, err := f.service.Create(context.Background(), nodeDirectRequest(t, KindNode, 3000, "site"))
	if err != nil {
		t.Fatalf("创建失败：%v", err)
	}
	if _, err := f.service.SetRunning(context.Background(), direct.Project.ID, true); err != nil {
		t.Fatalf("启动失败：%v", err)
	}
	f.caddy.mu.Lock()
	f.caddy.failLoad = true
	f.caddy.mu.Unlock()
	_, err = f.service.SetAccess(context.Background(), direct.Project.ID, accessInput{
		Mode: AccessModeDomain, Domain: "example.com",
		CertificatePEM: stringPtr(chain.CertificatePEM), PrivateKeyPEM: stringPtr(chain.PrivateKeyPEM),
	})
	requireError(t, err, "原访问配置已恢复")
	rows, _ := f.registry.List(context.Background())
	if rows[0].AccessMode != AccessModeDirect {
		t.Fatalf("登记应回 direct")
	}
	f.docker.mu.Lock()
	running := f.docker.states[*direct.Project.ContainerID]
	f.docker.mu.Unlock()
	if !running {
		t.Fatalf("旧容器应仍运行")
	}
	list, _ := f.service.List(context.Background())
	if list.Projects[0].AccessMode != AccessModeDirect {
		t.Fatalf("列表应呈 direct")
	}
}

func TestCreateRegistryFailureRollsBack(t *testing.T) {
	chain := makeTestChain(t)
	backing := NewMemoryWebsiteRegistry()
	f := fixture(t, &failingRegistry{backing: backing}, parseTrustedRoots(t, chain.RootPEM), nil, nil)
	before := f.caddy.configJSON(t)
	_, err := f.service.Create(context.Background(), domainRequest(t, KindHTML, 8088, "docs", "example.com", chain))
	requireError(t, err, "网站创建失败：模拟登记失败")
	if f.caddy.configJSON(t) != before {
		t.Fatalf("Caddy 配置应恢复原样")
	}
	f.docker.mu.Lock()
	count := len(f.docker.states)
	f.docker.mu.Unlock()
	if count != 0 {
		t.Fatalf("新容器应被回滚")
	}
	rolled := false
	for _, call := range f.docker.snapshotCalls() {
		if strings.HasPrefix(call, "rollback:") {
			rolled = true
		}
	}
	if !rolled {
		t.Fatalf("应记录回滚删除")
	}
}

type failingRegistry struct {
	backing *memoryWebsiteRegistry
}

func (r *failingRegistry) List(ctx context.Context) ([]WebsiteRecord, error) {
	return r.backing.List(ctx)
}

func (r *failingRegistry) Put(context.Context, WebsiteRecord) error {
	return errors.New("模拟登记失败")
}

func (r *failingRegistry) Remove(ctx context.Context, id string) error {
	return r.backing.Remove(ctx, id)
}

func TestCreateMutexBlocksConcurrent(t *testing.T) {
	f := fixture(t, nil, nil, nil, nil)
	existing, err := f.service.Create(context.Background(), nodeDirectRequest(t, KindNode, 3000, "site"))
	if err != nil {
		t.Fatalf("创建失败：%v", err)
	}
	createGate, entered := make(chan struct{}), make(chan struct{})
	releaseCreate := sync.OnceFunc(func() { close(createGate) })
	t.Cleanup(releaseCreate)
	f.docker.mu.Lock()
	f.docker.createGate = createGate
	f.docker.entered = entered
	f.docker.mu.Unlock()
	var creatingErr error
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, creatingErr = f.service.Create(context.Background(), nodeDirectRequest(t, KindHTML, 8088, "docs"))
	}()
	<-entered
	if _, err := f.service.SetAccess(context.Background(), existing.Project.ID, accessInput{Mode: AccessModeDirect}); err == nil || err.Error() != "项目正在执行其他操作" {
		t.Fatalf("创建进行中 setAccess 应拒绝，得到 %v", err)
	}
	if _, err := f.service.Create(context.Background(), nodeDirectRequest(t, KindHTML, 8089, "other")); err == nil || !strings.Contains(err.Error(), "网站项目正在创建") {
		t.Fatalf("创建进行中 create 应拒绝，得到 %v", err)
	}
	releaseCreate()
	<-done
	if creatingErr != nil {
		t.Fatalf("被门控的创建应最终成功：%v", creatingErr)
	}
}

func TestForeignConfigRejected(t *testing.T) {
	chain := makeTestChain(t)
	f := fixture(t, nil, parseTrustedRoots(t, chain.RootPEM), nil, nil)
	f.caddy.setConfig(parseJSONValue(BuildCaddyConfig([]CaddyManagedSite{{Domain: "foreign.example.com", Port: 8089}}, testAdminListen)))
	_, err := f.service.Create(context.Background(), domainRequest(t, KindHTML, 8088, "docs", "example.com", chain))
	requireError(t, err, "面板外的配置")
}

func TestRemoveSerializesAndCleansRoutes(t *testing.T) {
	chain := makeTestChain(t)
	f := fixture(t, nil, parseTrustedRoots(t, chain.RootPEM), nil, nil)
	created, err := f.service.Create(context.Background(), domainRequest(t, KindHTML, 8088, "docs", "example.com", chain))
	if err != nil {
		t.Fatalf("创建失败：%v", err)
	}
	stopGate, entered := make(chan struct{}), make(chan struct{})
	releaseStop := sync.OnceFunc(func() { close(stopGate) })
	t.Cleanup(releaseStop)
	f.docker.mu.Lock()
	f.docker.stopGate = stopGate
	f.docker.entered = entered
	f.docker.mu.Unlock()
	done := make(chan struct{})
	var removeErr error
	go func() {
		defer close(done)
		removeErr = f.service.Remove(context.Background(), created.Project.ID)
	}()
	<-entered
	if _, err := f.service.Create(context.Background(), nodeDirectRequest(t, KindHTML, 8089, "other")); err == nil || !strings.Contains(err.Error(), "网站项目正在创建") {
		t.Fatalf("删除进行中创建应拒绝，得到 %v", err)
	}
	releaseStop()
	<-done
	if removeErr != nil {
		t.Fatalf("删除应成功：%v", removeErr)
	}
	rows, _ := f.registry.List(context.Background())
	if len(rows) != 0 {
		t.Fatalf("删除后登记应为空")
	}
	if hosts := ManagedHosts(f.caddy.getConfig()); len(hosts) != 0 {
		t.Fatalf("旧域名路由应回收，得到 %v", hosts)
	}
}

func TestUpdateCommandRebuildsContainer(t *testing.T) {
	f := fixture(t, nil, nil, nil, nil)
	original, err := f.service.Create(context.Background(), nodeDirectRequest(t, KindNode, 3000, "site"))
	if err != nil {
		t.Fatalf("创建失败：%v", err)
	}
	command := "node \"new server.js\""
	updated, err := f.service.Update(context.Background(), original.Project.ID, updateRequest{
		Command: &optText{present: true, value: stringPtr(command)},
	})
	if err != nil {
		t.Fatalf("更新失败：%v", err)
	}
	if *updated.ContainerID == *original.Project.ContainerID {
		t.Fatalf("命令修改应重建容器")
	}
	if updated.RootDir != original.Project.RootDir {
		t.Fatalf("根目录应保留")
	}
	if updated.DeployCommand == nil || *updated.DeployCommand != command {
		t.Fatalf("deployCommand 应更新")
	}
}

// ---------- 「直连端口的防火墙自动开放」4 例 ----------

func TestFirewallDirectCreateOpensAfterRegistry(t *testing.T) {
	chain := makeTestChain(t)
	f := fixture(t, nil, parseTrustedRoots(t, chain.RootPEM), nil, nil)
	direct, err := f.service.Create(context.Background(), nodeDirectRequest(t, KindNode, 18080, "direct-site"))
	if err != nil {
		t.Fatalf("创建失败：%v", err)
	}
	if direct.FirewallPort == nil || direct.FirewallPort.State != contract.FirewallPortSyncOpened ||
		direct.FirewallPort.Port != 18080 || direct.FirewallPort.Detail != nil {
		t.Fatalf("直连创建应带回 opened 结果，得到 %+v", direct.FirewallPort)
	}
	if len(*f.portOpens) != 1 || (*f.portOpens)[0].port != 18080 || (*f.portOpens)[0].note != "Elysian 网站 direct-site" {
		t.Fatalf("开口参数不符：%+v", *f.portOpens)
	}
	_, err = f.service.Create(context.Background(), domainRequest(t, KindHTML, 8088, "docs", "example.com", chain))
	if err != nil {
		t.Fatalf("域名创建失败：%v", err)
	}
	if direct.FirewallPort == nil || len(*f.portOpens) != 1 {
		t.Fatalf("域名创建不应触发开口")
	}
}

func TestFirewallSwitchToDirectOpens(t *testing.T) {
	chain := makeTestChain(t)
	second := makeTestChain(t)
	f := fixture(t, nil, parseTrustedRoots(t, chain.RootPEM, second.RootPEM), nil, nil)
	created, err := f.service.Create(context.Background(), domainRequest(t, KindHTML, 8088, "docs", "example.com", chain))
	if err != nil {
		t.Fatalf("创建失败：%v", err)
	}
	reverted, err := f.service.SetAccess(context.Background(), created.Project.ID, accessInput{Mode: AccessModeDirect})
	if err != nil {
		t.Fatalf("切直连失败：%v", err)
	}
	if reverted.FirewallPort == nil || reverted.FirewallPort.Port != 8088 || reverted.FirewallPort.State != contract.FirewallPortSyncOpened {
		t.Fatalf("切直连应开口，得到 %+v", reverted.FirewallPort)
	}
	if len(*f.portOpens) != 1 || (*f.portOpens)[0].note != "Elysian 网站 docs" {
		t.Fatalf("开口 note 不符：%+v", *f.portOpens)
	}
	_, err = f.service.SetAccess(context.Background(), created.Project.ID, accessInput{
		Mode: AccessModeDomain, Domain: "example.com",
		CertificatePEM: stringPtr(second.CertificatePEM), PrivateKeyPEM: stringPtr(second.PrivateKeyPEM),
	})
	if err != nil {
		t.Fatalf("域名到域名换证书失败：%v", err)
	}
	if len(*f.portOpens) != 1 {
		t.Fatalf("域名到域名换证书不应触发开口：%+v", *f.portOpens)
	}
}

func TestFirewallFailureDoesNotBreakCreate(t *testing.T) {
	f := fixture(t, nil, nil, func(_ context.Context, port int, _ string) contract.FirewallPortSync {
		detail := "端口规则已达上限（最多 200 条）"
		return contract.FirewallPortSync{State: contract.FirewallPortSyncFailed, Port: port, Detail: &detail}
	}, nil)
	result, err := f.service.Create(context.Background(), nodeDirectRequest(t, KindNode, 18081, "blocked-site"))
	if err != nil {
		t.Fatalf("开口失败不应影响创建：%v", err)
	}
	if result.Project.AccessMode != AccessModeDirect {
		t.Fatalf("应为直连项目")
	}
	if result.FirewallPort == nil || result.FirewallPort.State != contract.FirewallPortSyncFailed ||
		result.FirewallPort.Detail == nil || *result.FirewallPort.Detail != "端口规则已达上限（最多 200 条）" {
		t.Fatalf("failed 结果应如实带回，得到 %+v", result.FirewallPort)
	}
	rows, _ := f.registry.List(context.Background())
	if len(rows) != 1 {
		t.Fatalf("登记应落账")
	}
}

func TestFirewallNilOpenerDefaultsSkipped(t *testing.T) {
	f := fixture(t, nil, nil, useNilOpener{}, nil)
	result, err := f.service.Create(context.Background(), nodeDirectRequest(t, KindNode, 3000, "site"))
	if err != nil {
		t.Fatalf("创建失败：%v", err)
	}
	if result.FirewallPort == nil || result.FirewallPort.State != contract.FirewallPortSyncSkipped ||
		result.FirewallPort.Port != 3000 || result.FirewallPort.Detail == nil ||
		*result.FirewallPort.Detail != "防火墙片不可用，端口未自动开放" {
		t.Fatalf("未注入开口函数应恒 skipped，得到 %+v", result.FirewallPort)
	}
	if len(*f.portOpens) != 0 {
		t.Fatalf("不应有开口记录")
	}
	for _, call := range *f.calls {
		if call == "caddy-load" {
			t.Fatalf("直连项目不应触发 caddy 操作")
		}
	}
}

// ---------- 反向代理对账 ----------

func TestReconcileProxyStates(t *testing.T) {
	chain := makeTestChain(t)
	f := fixture(t, nil, parseTrustedRoots(t, chain.RootPEM), nil, nil)
	// 通道不可用：unavailable + 固定中文，不抛错。
	f.caddy.mu.Lock()
	f.caddy.down = true
	f.caddy.mu.Unlock()
	status, err := f.service.ReconcileProxy(context.Background())
	if err != nil {
		t.Fatalf("通道不可用应对账返回状态：%v", err)
	}
	if status.State != ProxyStateUnavailable || status.Detail == nil || *status.Detail != "宿主未提供 Caddy 管理通道" {
		t.Fatalf("通道不可用应呈 unavailable，得到 %+v", status)
	}
	// 外部配置：拒绝覆盖 409。
	f.caddy.mu.Lock()
	f.caddy.down = false
	f.caddy.mu.Unlock()
	f.caddy.setConfig(parseJSONValue(BuildCaddyConfig([]CaddyManagedSite{{Domain: "foreign.example.com", Port: 9}}, testAdminListen)))
	if _, err := f.service.ReconcileProxy(context.Background()); err == nil || err.Error() != "宿主 Caddy 存在面板外的配置，拒绝覆盖" {
		t.Fatalf("外部配置应拒绝，得到 %v", err)
	}
	// 正常：全量重新推导下发，applied 派生布尔为真（先复位为面板自产空配置）。
	f.caddy.setConfig(parseJSONValue(BuildCaddyConfig(nil, testAdminListen)))
	if _, err := f.service.Create(context.Background(), nodeDirectRequest(t, KindNode, 3000, "site")); err != nil {
		t.Fatalf("创建失败：%v", err)
	}
	status, err = f.service.ReconcileProxy(context.Background())
	if err != nil {
		t.Fatalf("对账失败：%v", err)
	}
	if status.State != ProxyStateActive || status.Detail != nil {
		t.Fatalf("正常对账应为 active 且无缺口，得到 %+v", status)
	}
}
