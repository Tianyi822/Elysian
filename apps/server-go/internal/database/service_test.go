package database

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"

	"elysian/server/internal/contract"
	"elysian/server/internal/shared"
)

// databaseService.test.ts 对等测试：创建次序、adopt/managed/remove 语义、
// forget、防火墙开口与版本漂移。

// fakeDocker 可编程的 Docker 后端假件。
type fakeDocker struct {
	mu               sync.Mutex
	inspectInfos     map[string]map[string]any
	assertEngineErrs map[string]error // engine|versionTag → err
	createCalls      []createInput
	createResult     createResult
	createErr        error
	attachCalls      []string
	detachCalls      []string
	removeCalls      [][2]string
	removeErr        error
	memoryValue      *memoryView
}

func newFakeDocker() *fakeDocker {
	return &fakeDocker{
		inspectInfos: map[string]map[string]any{},
		createResult: createResult{containerID: strings.Repeat("c", 64), volumeName: "elysian-db-" + strings.Repeat("0", 36), started: true},
	}
}

func (f *fakeDocker) addContainer(id, image string, running bool, networks map[string]any) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if networks == nil {
		networks = map[string]any{"elysian-db-local": map[string]any{"IPAddress": "172.28.0.5"}}
	}
	f.inspectInfos[id] = map[string]any{
		"Id":              id,
		"State":           map[string]any{"Running": running},
		"Config":          map[string]any{"Image": image, "Labels": map[string]any{}},
		"NetworkSettings": map[string]any{"Networks": networks},
		"Image":           testImageID,
		"Mounts":          []any{},
	}
}

func (f *fakeDocker) inspect(_ context.Context, id string) (map[string]any, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if info, ok := f.inspectInfos[id]; ok {
		return info, nil
	}
	return nil, &shared.InvalidRequestError{Status: 404, Message: "数据库容器已不存在"}
}

func (f *fakeDocker) assertEngine(_ context.Context, id, engine, versionTag string) (map[string]any, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err, ok := f.assertEngineErrs[engine+"|"+versionTag]; ok {
		return nil, err
	}
	if info, ok := f.inspectInfos[id]; ok {
		return info, nil
	}
	return nil, &shared.InvalidRequestError{Status: 404, Message: "数据库容器已不存在"}
}

func (f *fakeDocker) address(_ context.Context, id, _ string) (databaseAddress, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, ok := f.inspectInfos[id]; !ok {
		return databaseAddress{}, &shared.InvalidRequestError{Status: 404, Message: "数据库容器已不存在"}
	}
	return databaseAddress{Host: "172.28.0.5", Port: 0}, nil
}

func (f *fakeDocker) attach(_ context.Context, id, network string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.attachCalls = append(f.attachCalls, id+"|"+network)
	return nil
}

func (f *fakeDocker) detach(_ context.Context, id, network string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.detachCalls = append(f.detachCalls, id+"|"+network)
	return nil
}

func (f *fakeDocker) create(_ context.Context, input createInput) (createResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.createCalls = append(f.createCalls, input)
	if f.createErr != nil {
		return createResult{}, f.createErr
	}
	// 模拟真实 Docker：容器创建后即可 inspect（running）。
	image := engineRepository[input.engine] + ":" + input.versionTag
	f.inspectInfos[f.createResult.containerID] = map[string]any{
		"Id":     f.createResult.containerID,
		"State":  map[string]any{"Running": f.createResult.started},
		"Config": map[string]any{"Image": image, "Labels": map[string]any{}},
		"NetworkSettings": map[string]any{"Networks": map[string]any{
			"elysian-db-local": map[string]any{"IPAddress": "172.28.0.5"},
		}},
		"Image":  testImageID,
		"Mounts": []any{},
	}
	return f.createResult, nil
}

func (f *fakeDocker) removeManaged(_ context.Context, containerID, volumeName, _, _ string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.removeCalls = append(f.removeCalls, [2]string{containerID, volumeName})
	return f.removeErr
}

func (f *fakeDocker) memory(_ context.Context, _ string) (*memoryView, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.memoryValue, nil
}

// callTrace 记录 protocol 调用次序。
type callTrace struct {
	mu    sync.Mutex
	items []string
}

func (t *callTrace) add(step string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.items = append(t.items, step)
}

// fakeProtocol 可编程的协议后端假件。
type fakeProtocol struct {
	trace       *callTrace
	versionText string
	verifyErr   error
	createErr   error
	versionErr  error
}

func (p *fakeProtocol) version(_ context.Context, _ string, _ databaseAddress, _ databaseSecret) (string, error) {
	p.trace.add("version")
	if p.versionErr != nil {
		return "", p.versionErr
	}
	return p.versionText, nil
}

func (p *fakeProtocol) create(_ context.Context, _ databaseRecord, _ databaseAddress, _ string) error {
	p.trace.add("create")
	return p.createErr
}

func (p *fakeProtocol) verify(_ context.Context, _ databaseRecord, _ databaseAddress) error {
	p.trace.add("verify")
	return p.verifyErr
}

func (p *fakeProtocol) drop(_ context.Context, _ databaseRecord, _ databaseAddress) error {
	p.trace.add("drop")
	return nil
}

func (p *fakeProtocol) hasOtherDatabases(_ context.Context, _ databaseRecord, _ databaseAddress) (bool, error) {
	return false, nil
}

func (p *fakeProtocol) metrics(_ context.Context, _ databaseRecord, _ databaseAddress) (databaseMetrics, error) {
	sizeGb := 0.5
	return databaseMetrics{SizeGb: &sizeGb}, nil
}

func (p *fakeProtocol) session(_ databaseRecord, _ databaseAddress) (Session, error) {
	return nil, errors.New("session 由终端测试覆盖")
}

// fakePortOpener 记录 note 的端口开放假件。
type fakePortOpener struct {
	calls   []string
	outcome contract.FirewallPortSync
}

func (f *fakePortOpener) EnsurePortRule(_ context.Context, port int, note string) contract.FirewallPortSync {
	f.calls = append(f.calls, note)
	outcome := f.outcome
	outcome.Port = port
	return outcome
}

// serviceFixture 组装被测服务。
type serviceFixture struct {
	service    *databaseService
	docker     *fakeDocker
	protocol   *fakeProtocol
	portOpener *fakePortOpener
	registry   *memoryDatabaseRegistry
}

func newServiceFixture(versionText string) *serviceFixture {
	docker := newFakeDocker()
	trace := &callTrace{}
	protocol := &fakeProtocol{trace: trace, versionText: versionText}
	portOpener := &fakePortOpener{outcome: contract.FirewallPortSync{State: contract.FirewallPortSyncOpened}}
	registry := newMemoryDatabaseRegistry(nil)
	service := newDatabaseService(serviceDeps{
		registry: registry,
		docker:   docker,
		protocol: protocol,
		listImages: func(context.Context) ([]contract.ContainerImage, error) {
			return testImageList(), nil
		},
		listContainers: func(context.Context) ([]contract.Container, error) { return nil, nil },
		portOpener:     portOpener,
	})
	return &serviceFixture{service: service, docker: docker, protocol: protocol, portOpener: portOpener, registry: registry}
}

func newCreateRequest(target createTarget, scope string, hostPort *int) createRequest {
	return createRequest{
		Engine: engineMySQL, VersionTag: "8.4", Name: "orders",
		User:        databaseSecret{Username: "reader", Password: "strong-password-123"},
		AccessScope: scope, HostPort: hostPort, Target: target,
	}
}

func TestCreateOrderAndProjection(t *testing.T) {
	fixture := newServiceFixture("8.4.7")
	request := newCreateRequest(createTarget{Kind: "new", ImageID: testImageID, ContainerName: "mysql-db"}, scopeLocalhost, nil)
	response, err := fixture.service.Create(context.Background(), request)
	if err != nil {
		t.Fatalf("创建失败：%v", err)
	}
	fixture.protocol.trace.mu.Lock()
	sequence := strings.Join(fixture.protocol.trace.items, ",")
	fixture.protocol.trace.mu.Unlock()
	// 次序：重试环 version → 建库 create → verify → 投影再核对（version,verify）。
	if sequence != "version,create,verify,version,verify" {
		t.Fatalf("创建次序应为 version→create→verify→投影核对，实际 %s", sequence)
	}
	if response.Instance.HasCredentials == nil || !*response.Instance.HasCredentials {
		t.Fatal("实例应带 hasCredentials")
	}
	if response.Instance.CredentialUsername != "reader" {
		t.Fatalf("credentialUsername 应为 reader，实际 %s", response.Instance.CredentialUsername)
	}
	if response.FirewallPort != nil {
		t.Fatal("localhost 创建不应触发防火墙开口")
	}
	// 列表投影不含密码（registry 文件本身存明文凭证，是 TS 版同构行为）。
	instances, listErr := fixture.service.List(context.Background())
	if listErr != nil {
		t.Fatal(listErr)
	}
	data, _ := jsonMarshal(instances)
	if strings.Contains(string(data), "strong-password-123") {
		t.Fatalf("列表投影不得含密码明文：%s", data)
	}
	rows, err := fixture.registry.list()
	if err != nil {
		t.Fatal(err)
	}
	secret, err := fixture.service.Reveal(context.Background(), rows[0].ID)
	if err != nil {
		t.Fatalf("reveal 失败：%v", err)
	}
	if secret.Username != "reader" || secret.Password != "strong-password-123" {
		t.Fatalf("reveal 应回普通账号：%+v", secret)
	}
}

func TestCreateAnyHostOpensFirewallPort(t *testing.T) {
	fixture := newServiceFixture("8.4")
	port := 43306
	request := newCreateRequest(createTarget{Kind: "new", ImageID: testImageID, ContainerName: "mysql-db"}, scopeAnyHost, &port)
	response, err := fixture.service.Create(context.Background(), request)
	if err != nil {
		t.Fatalf("创建失败：%v", err)
	}
	if response.FirewallPort == nil || response.FirewallPort.State != contract.FirewallPortSyncOpened {
		t.Fatalf("any-host 创建应带回防火墙开口结果：%+v", response.FirewallPort)
	}
	if len(fixture.portOpener.calls) != 1 || fixture.portOpener.calls[0] != "Elysian 数据库 orders" {
		t.Fatalf("开口 note 应为「Elysian 数据库 orders」：%v", fixture.portOpener.calls)
	}
}

func TestCreateLocalhostAndAdoptDoNotOpenPort(t *testing.T) {
	// localhost new。
	fixture := newServiceFixture("8.4")
	if _, err := fixture.service.Create(context.Background(), newCreateRequest(createTarget{Kind: "new", ImageID: testImageID, ContainerName: "mysql-db"}, scopeLocalhost, nil)); err != nil {
		t.Fatalf("localhost 创建失败：%v", err)
	}
	if len(fixture.portOpener.calls) != 0 {
		t.Fatal("localhost 不应触发开口")
	}
	// adopt。
	fixture = newServiceFixture("8.4")
	containerID := strings.Repeat("d", 64)
	fixture.docker.addContainer(containerID, "mysql:8.4", true, nil)
	admin := databaseSecret{Username: "root", Password: "admin-password"}
	request := newCreateRequest(createTarget{Kind: "adopt", ContainerID: containerID, Admin: &admin}, scopeContainerNet, nil)
	if _, err := fixture.service.Create(context.Background(), request); err != nil {
		t.Fatalf("adopt 创建失败：%v", err)
	}
	if len(fixture.portOpener.calls) != 0 {
		t.Fatal("adopt 不应触发开口")
	}
	if len(fixture.docker.attachCalls) != 1 || !strings.HasSuffix(fixture.docker.attachCalls[0], networkDBSharedName) {
		t.Fatalf("adopt 应接入共享网络：%v", fixture.docker.attachCalls)
	}
	fixture.protocol.trace.mu.Lock()
	trace := strings.Join(fixture.protocol.trace.items, ",")
	fixture.protocol.trace.mu.Unlock()
	for _, step := range fixture.protocol.trace.items {
		if step == "create" {
			t.Fatal("adopt 路径不应执行 protocol.create")
		}
	}
	if !strings.Contains(trace, "verify") {
		t.Fatal("adopt 仍应 verify")
	}
	_ = trace
}

func TestVersionDriftKeepsNeedsAttention(t *testing.T) {
	fixture := newServiceFixture("9.0")
	request := newCreateRequest(createTarget{Kind: "new", ImageID: testImageID, ContainerName: "mysql-db"}, scopeLocalhost, nil)
	_, err := fixture.service.Create(context.Background(), request)
	if err == nil {
		t.Fatal("版本漂移应失败")
	}
	if !strings.Contains(err.Error(), "数据库创建未完成；容器 cccccccccccc 已登记为待处理：数据库实际版本与所选版本不一致") {
		t.Fatalf("错误应带待处理包装文案，实际 %v", err)
	}
	rows, _ := fixture.registry.list()
	if len(rows) != 1 || rows[0].State != stateNeedsAttention {
		t.Fatalf("登记应保留在 needs-attention：%+v", rows)
	}
}

func TestRemoveManagedLastDatabaseMarksEmpty(t *testing.T) {
	fixture := newServiceFixture("8.4")
	if _, err := fixture.service.Create(context.Background(), newCreateRequest(createTarget{Kind: "new", ImageID: testImageID, ContainerName: "mysql-db"}, scopeLocalhost, nil)); err != nil {
		t.Fatal(err)
	}
	rows, _ := fixture.registry.list()
	if err := fixture.service.Remove(context.Background(), rows[0].ID); err != nil {
		t.Fatalf("remove 失败：%v", err)
	}
	rows, _ = fixture.registry.list()
	if len(rows) != 1 || rows[0].State != stateEmpty {
		t.Fatalf("managed 最后一个库删除后应标记 empty：%+v", rows)
	}
	instance, err := fixture.service.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !instance[0].EmptyContainer || instance[0].MetricsError != "逻辑库已删除；容器与持久卷仍保留，可在此容器新建库或显式删除容器及数据。" {
		t.Fatalf("空容器投影不符：%+v", instance[0])
	}
	// 空容器可再建新库（managed target）。
	request := newCreateRequest(createTarget{Kind: "managed", ContainerID: rows[0].ContainerID}, scopeLocalhost, nil)
	request.Name = "orders2"
	if _, err := fixture.service.Create(context.Background(), request); err != nil {
		t.Fatalf("空容器上再建库失败：%v", err)
	}
}

func TestRemoveContainerRequiresManagedAndNoSiblings(t *testing.T) {
	fixture := newServiceFixture("8.4")
	response, err := fixture.service.Create(context.Background(), newCreateRequest(createTarget{Kind: "new", ImageID: testImageID, ContainerName: "mysql-db"}, scopeLocalhost, nil))
	if err != nil {
		t.Fatal(err)
	}
	id := response.Instance.ID
	if err := fixture.service.RemoveContainer(context.Background(), id); err != nil {
		t.Fatalf("removeContainer 失败：%v", err)
	}
	if len(fixture.docker.removeCalls) != 1 || fixture.docker.removeCalls[0][0] != strings.Repeat("c", 64) {
		t.Fatalf("应调用 removeManaged 删容器与卷：%v", fixture.docker.removeCalls)
	}
	rows, _ := fixture.registry.list()
	if len(rows) != 0 {
		t.Fatalf("登记应被删除：%+v", rows)
	}
	// adopt 的登记不能删容器。
	fixture = newServiceFixture("8.4")
	containerID := strings.Repeat("d", 64)
	fixture.docker.addContainer(containerID, "mysql:8.4", true, nil)
	admin := databaseSecret{Username: "root", Password: "admin-password"}
	adoptResponse, err := fixture.service.Create(context.Background(), newCreateRequest(createTarget{Kind: "adopt", ContainerID: containerID, Admin: &admin}, scopeContainerNet, nil))
	if err != nil {
		t.Fatal(err)
	}
	err = fixture.service.RemoveContainer(context.Background(), adoptResponse.Instance.ID)
	var invalid *shared.InvalidRequestError
	if !errors.As(err, &invalid) || invalid.Status != 403 || invalid.Message != "只能删除面板创建的数据库容器和专属卷" {
		t.Fatalf("adopt 删容器应 403，实际 %v", err)
	}
}

func TestRemoveContainerSkipsCheckWhenContainerGone(t *testing.T) {
	fixture := newServiceFixture("8.4")
	response, err := fixture.service.Create(context.Background(), newCreateRequest(createTarget{Kind: "new", ImageID: testImageID, ContainerName: "mysql-db"}, scopeLocalhost, nil))
	if err != nil {
		t.Fatal(err)
	}
	// 外部删容器：inspect 404。
	delete(fixture.docker.inspectInfos, strings.Repeat("c", 64))
	if err := fixture.service.RemoveContainer(context.Background(), response.Instance.ID); err != nil {
		t.Fatalf("外部删容器后 removeContainer 应继续清孤儿卷：%v", err)
	}
	if len(fixture.docker.removeCalls) != 1 {
		t.Fatal("仍应调用 removeManaged 清孤儿卷")
	}
}

func TestRemoveAdoptedDetachesOnlyOnLastRegistration(t *testing.T) {
	fixture := newServiceFixture("8.4")
	containerID := strings.Repeat("d", 64)
	fixture.docker.addContainer(containerID, "mysql:8.4", true, nil)
	admin := databaseSecret{Username: "root", Password: "admin-password"}
	first, err := fixture.service.Create(context.Background(), createRequest{
		Engine: engineMySQL, VersionTag: "8.4", Name: "first",
		User:        databaseSecret{Username: "reader", Password: "strong-password-123"},
		AccessScope: scopeContainerNet, Target: createTarget{Kind: "adopt", ContainerID: containerID, Admin: &admin},
	})
	if err != nil {
		t.Fatal(err)
	}
	second, err := fixture.service.Create(context.Background(), createRequest{
		Engine: engineMySQL, VersionTag: "8.4", Name: "second",
		User:        databaseSecret{Username: "reader", Password: "strong-password-123"},
		AccessScope: scopeContainerNet, Target: createTarget{Kind: "adopt", ContainerID: containerID, Admin: &admin},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := fixture.service.Remove(context.Background(), first.Instance.ID); err != nil {
		t.Fatal(err)
	}
	if len(fixture.docker.detachCalls) != 0 {
		t.Fatalf("同容器还有登记时不应 detach：%v", fixture.docker.detachCalls)
	}
	if err := fixture.service.Remove(context.Background(), second.Instance.ID); err != nil {
		t.Fatal(err)
	}
	if len(fixture.docker.detachCalls) != 1 || !strings.HasSuffix(fixture.docker.detachCalls[0], networkDBSharedName) {
		t.Fatalf("最后一个登记移除时才 detach：%v", fixture.docker.detachCalls)
	}
	// managed 全程不 detach。
	fixture = newServiceFixture("8.4")
	if _, err := fixture.service.Create(context.Background(), newCreateRequest(createTarget{Kind: "new", ImageID: testImageID, ContainerName: "mysql-db"}, scopeLocalhost, nil)); err != nil {
		t.Fatal(err)
	}
	rows, _ := fixture.registry.list()
	if err := fixture.service.Remove(context.Background(), rows[0].ID); err != nil {
		t.Fatal(err)
	}
	if len(fixture.docker.detachCalls) != 0 {
		t.Fatal("managed 不应 detach")
	}
}

func TestRemoveAfterExternalContainerDeletion(t *testing.T) {
	fixture := newServiceFixture("8.4")
	containerID := strings.Repeat("d", 64)
	fixture.docker.addContainer(containerID, "mysql:8.4", true, nil)
	admin := databaseSecret{Username: "root", Password: "admin-password"}
	response, err := fixture.service.Create(context.Background(), newCreateRequest(createTarget{Kind: "adopt", ContainerID: containerID, Admin: &admin}, scopeContainerNet, nil))
	if err != nil {
		t.Fatal(err)
	}
	delete(fixture.docker.inspectInfos, containerID)
	if err := fixture.service.Remove(context.Background(), response.Instance.ID); err != nil {
		t.Fatalf("容器被外部删除后 remove 应幂等清登记：%v", err)
	}
	rows, _ := fixture.registry.list()
	if len(rows) != 0 {
		t.Fatalf("登记应被删除：%+v", rows)
	}
	if len(fixture.docker.detachCalls) != 1 {
		t.Fatal("仍应尝试 detach")
	}
}

func TestForgetRemovesPendingAdoptedRegistration(t *testing.T) {
	fixture := newServiceFixture("8.4")
	containerID := strings.Repeat("d", 64)
	registry := newMemoryDatabaseRegistry([]databaseRecord{{
		ID: "reg-1", Engine: engineMySQL, Name: "orders", VersionTag: "8.4",
		ContainerID: containerID, Source: sourceAdopted, AccessScope: scopeContainerNet,
		Admin: databaseSecret{Username: "root", Password: "admin"}, User: databaseSecret{Username: "reader", Password: "strong-password-123"},
		CreatedAt: "2026-09-28T00:00:00.000Z", State: stateNeedsAttention,
	}})
	fixture.registry = registry
	fixture.service = newDatabaseService(serviceDeps{
		registry: registry, docker: fixture.docker, protocol: fixture.protocol,
		listImages:     func(context.Context) ([]contract.ContainerImage, error) { return nil, nil },
		listContainers: func(context.Context) ([]contract.Container, error) { return nil, nil },
	})
	if err := fixture.service.Forget(context.Background(), "reg-1"); err != nil {
		t.Fatalf("forget 失败：%v", err)
	}
	if len(fixture.docker.detachCalls) != 1 {
		t.Fatal("forget 应 detach 共享网络")
	}
	rows, _ := registry.list()
	if len(rows) != 0 {
		t.Fatal("登记应被移除")
	}
	// 非 adopted 的登记不允许 forget。
	registry = newMemoryDatabaseRegistry([]databaseRecord{{
		ID: "reg-2", Engine: engineMySQL, Name: "orders", VersionTag: "8.4",
		ContainerID: containerID, Source: sourceManaged, AccessScope: scopeLocalhost,
		Admin: databaseSecret{Username: "root", Password: "admin"}, User: databaseSecret{Username: "reader", Password: "strong-password-123"},
		CreatedAt: "2026-09-28T00:00:00.000Z", State: stateNeedsAttention,
	}})
	fixture.service = newDatabaseService(serviceDeps{
		registry: registry, docker: fixture.docker, protocol: fixture.protocol,
		listImages:     func(context.Context) ([]contract.ContainerImage, error) { return nil, nil },
		listContainers: func(context.Context) ([]contract.Container, error) { return nil, nil },
	})
	err := fixture.service.Forget(context.Background(), "reg-2")
	var invalid *shared.InvalidRequestError
	if !errors.As(err, &invalid) || invalid.Status != 409 || invalid.Message != "只允许移除接管失败的待处理登记" {
		t.Fatalf("非 adopted forget 应 409，实际 %v", err)
	}
}

func TestConcurrentCreateSameKeyRejected(t *testing.T) {
	fixture := newServiceFixture("8.4")
	// 直接占用进程内并发去重键，等价于另一笔同键创建在途。
	fixture.service.mu.Lock()
	fixture.service.inProgress["MySQL:orders:mysql-db"] = true
	fixture.service.mu.Unlock()
	request := newCreateRequest(createTarget{Kind: "new", ImageID: testImageID, ContainerName: "mysql-db"}, scopeLocalhost, nil)
	_, err := fixture.service.Create(context.Background(), request)
	var invalid *shared.InvalidRequestError
	if !errors.As(err, &invalid) || invalid.Status != 409 || invalid.Message != "相同数据库正在创建" {
		t.Fatalf("并发同键应 409「相同数据库正在创建」，实际 %v", err)
	}
}

func TestValidateCreateRequestMessages(t *testing.T) {
	cases := []struct {
		body    map[string]any
		message string
	}{
		{map[string]any{"engine": "Oracle"}, "数据库引擎不受支持"},
		{map[string]any{"engine": "MySQL", "versionTag": "latest", "name": "a", "user": map[string]any{"username": "reader", "password": "p"}, "accessScope": "localhost", "target": map[string]any{"kind": "new"}}, "必须指定明确的数据库版本标签"},
		{map[string]any{"engine": "Redis", "versionTag": "7.4", "name": "x", "user": map[string]any{"username": "reader", "password": "p"}, "accessScope": "localhost", "target": map[string]any{"kind": "new"}}, "数据库名无效"},
		{map[string]any{"engine": "MySQL", "versionTag": "8.4", "name": "orders", "user": map[string]any{"username": "root", "password": "p"}, "accessScope": "localhost", "target": map[string]any{"kind": "adopt", "containerId": strings.Repeat("d", 64)}}, "普通账号不得使用管理员账号名"},
		{map[string]any{"engine": "MySQL", "versionTag": "8.4", "name": "orders", "user": map[string]any{"username": "reader", "password": "p"}, "accessScope": "localhost", "target": map[string]any{"kind": "new"}}, "普通账号或密码无效"},
		{map[string]any{"engine": "MySQL", "versionTag": "8.4", "name": "orders", "user": map[string]any{"username": "reader", "password": "long-enough-password"}, "accessScope": "bogus", "target": map[string]any{"kind": "new"}}, "访问范围无效"},
		{map[string]any{"engine": "MySQL", "versionTag": "8.4", "name": "orders", "user": map[string]any{"username": "reader", "password": "long-enough-password"}, "accessScope": "any-host", "target": map[string]any{"kind": "new", "imageId": testImageID, "containerName": "db"}}, "任意主机访问必须指定宿主端口"},
		{map[string]any{"engine": "MySQL", "versionTag": "8.4", "name": "orders", "user": map[string]any{"username": "reader", "password": "long-enough-password"}, "accessScope": "any-host", "hostPort": float64(43306), "target": map[string]any{"kind": "new", "imageId": testImageID, "containerName": "db"}}, "任意主机访问必须再次确认"},
		{map[string]any{"engine": "MySQL", "versionTag": "8.4", "name": "orders", "user": map[string]any{"username": "reader", "password": "long-enough-password"}, "accessScope": "localhost", "target": map[string]any{"kind": "other"}}, "必须指定新建或接管容器"},
		{map[string]any{"engine": "MySQL", "versionTag": "8.4", "name": "orders", "charset": "gbk", "user": map[string]any{"username": "reader", "password": "long-enough-password"}, "accessScope": "localhost", "target": map[string]any{"kind": "new", "imageId": testImageID, "containerName": "db"}}, "字符集无效"},
	}
	for _, testCase := range cases {
		_, err := validateCreateRequest(testCase.body)
		var invalid *shared.InvalidRequestError
		if !errors.As(err, &invalid) || invalid.Status != 400 || invalid.Message != testCase.message {
			t.Fatalf("校验消息应为 %q，实际 %v", testCase.message, err)
		}
	}
}

// jsonMarshal 共享编码出口（与 shared.MarshalJSON 一致）。
func jsonMarshal(value any) ([]byte, error) {
	return shared.MarshalJSON(value)
}
