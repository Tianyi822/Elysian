package database

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"

	"elysian/server/internal/contract"
	"elysian/server/internal/shared"
)

// service_test.go：容器列表筛选投影、创建登记、核对、删容器、reveal 管理员、
// 登记清理与旧格式登记夹具（adopted / stateEmpty / 同容器多行）。

// fakeDocker 实现 dockerBackend 的假件（纯 Docker 事实，无任何协议方法）。
type fakeDocker struct {
	mu               sync.Mutex
	inspectFn        func(ctx context.Context, id string) (map[string]any, error)
	assertEngineFn   func(ctx context.Context, id, engine, versionTag string) (map[string]any, error)
	memoryFn         func(ctx context.Context, id string) (*memoryView, error)
	createCalls      []createInput
	createResult     createResult
	createErr        error
	createFn         func(createInput) (createResult, error)
	removeCalls      []string
	removeErr        error
	verifyRemovedErr error
	containersFn     func(context.Context) ([]contract.Container, error)
	portFreeErr      error
}

func (f *fakeDocker) inspect(ctx context.Context, id string) (map[string]any, error) {
	if f.inspectFn != nil {
		return f.inspectFn(ctx, id)
	}
	return nil, &shared.InvalidRequestError{Status: 404, Message: "数据库容器已不存在"}
}

func (f *fakeDocker) assertEngine(ctx context.Context, id, engine, versionTag string) (map[string]any, error) {
	if f.assertEngineFn != nil {
		return f.assertEngineFn(ctx, id, engine, versionTag)
	}
	if f.inspectFn != nil {
		return f.inspectFn(ctx, id)
	}
	return nil, &shared.InvalidRequestError{Status: 404, Message: "数据库容器已不存在"}
}

func (f *fakeDocker) create(ctx context.Context, input createInput) (createResult, error) {
	f.mu.Lock()
	f.createCalls = append(f.createCalls, input)
	fn := f.createFn
	result, err := f.createResult, f.createErr
	f.mu.Unlock()
	if fn != nil {
		return fn(input)
	}
	if err != nil {
		return createResult{}, err
	}
	_ = ctx
	return result, nil
}

func (f *fakeDocker) removeManaged(_ context.Context, containerID, volumeName, engine, versionTag string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.removeCalls = append(f.removeCalls, containerID+"|"+volumeName+"|"+engine+"|"+versionTag)
	return f.removeErr
}

func (f *fakeDocker) assertHostPortFree(_ context.Context, port int) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.portFreeErr != nil {
		return f.portFreeErr
	}
	if f.containersFn == nil {
		return nil
	}
	rows, err := f.containersFn(context.Background())
	if err != nil {
		return err
	}
	for _, container := range rows {
		for _, binding := range container.Ports {
			if binding.HostPort == port {
				return shared.InvalidRequest("宿主端口已被占用：" + strconv.Itoa(port) + "/tcp，未创建实例")
			}
		}
	}
	return nil
}

func (f *fakeDocker) verifyRemoved(_ context.Context, _, _ string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.verifyRemovedErr
}

func (f *fakeDocker) memory(ctx context.Context, id string) (*memoryView, error) {
	if f.memoryFn != nil {
		return f.memoryFn(ctx, id)
	}
	return nil, nil
}

// fakePortOpener 记录防火墙开放调用。
type fakePortOpener struct {
	mu    sync.Mutex
	ports []int
	notes []string
}

func (f *fakePortOpener) EnsurePortRule(_ context.Context, port int, note string) contract.FirewallPortSync {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.ports = append(f.ports, port)
	f.notes = append(f.notes, note)
	return contract.FirewallPortSync{State: contract.FirewallPortSyncOpened, Port: port}
}

func (f *fakePortOpener) called() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.ports)
}

// serviceFixture 组合服务与假件。
type serviceFixture struct {
	service   *databaseService
	docker    *fakeDocker
	registry  *memoryDatabaseRegistry
	firewall  *fakePortOpener
	container string
}

// newServiceFixture 构造服务；containers 为容器清单，rows 为登记种子。
func newServiceFixture(selfID string, containers []contract.Container, rows []databaseRecord) *serviceFixture {
	docker := &fakeDocker{}
	firewall := &fakePortOpener{}
	registry := newMemoryDatabaseRegistry(rows)
	service := newDatabaseService(serviceDeps{
		registry:        registry,
		docker:          docker,
		listContainers:  func(context.Context) ([]contract.Container, error) { return containers, nil },
		selfContainerID: selfID,
		portOpener:      firewall,
	})
	return &serviceFixture{service: service, docker: docker, registry: registry, firewall: firewall}
}

// containerBody 构造 inspect 应答体。
func containerBody(id string, ref string, running bool, labels map[string]string, networks []string, ports map[string]any, mounts []any) map[string]any {
	labelsAny := map[string]any{}
	for key, value := range labels {
		labelsAny[key] = value
	}
	networksAny := map[string]any{}
	for _, name := range networks {
		networksAny[name] = map[string]any{"IPAddress": "172.28.0.5"}
	}
	body := map[string]any{
		"Id":              id,
		"Name":            "/" + id[:12] + "-db",
		"Created":         "2026-09-28T08:00:00.000000000Z",
		"State":           map[string]any{"Running": running},
		"Image":           "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		"Config":          map[string]any{"Image": ref, "Labels": labelsAny},
		"NetworkSettings": map[string]any{"Networks": networksAny, "Ports": ports},
	}
	if mounts != nil {
		body["Mounts"] = mounts
	}
	return body
}

func testVolumeMount(volume string) []any {
	return []any{map[string]any{"Type": "volume", "Name": volume}}
}

func enginePortBindings(hostIP string, hostPort string) map[string]any {
	return map[string]any{
		"3306/tcp": []any{map[string]any{"HostIp": hostIP, "HostPort": hostPort}},
	}
}

func TestValidateCreateRequestMessages(t *testing.T) {
	valid := func(mutate func(map[string]any)) map[string]any {
		body := map[string]any{"engine": "MySQL", "versionTag": "8.4", "accessScope": "container-network",
			"imageId": testImageIDBare, "containerName": "mysql-main"}
		if mutate != nil {
			mutate(body)
		}
		return body
	}
	if request, err := validateCreateRequest(valid(nil)); err != nil || request.ContainerName != "mysql-main" || request.ImageID != testImageIDBare {
		t.Fatalf("合法请求应通过：%v %+v", err, request)
	}
	for _, testCase := range []struct {
		name   string
		mutate func(map[string]any)
		want   string
	}{
		{"引擎", func(b map[string]any) { b["engine"] = "Oracle" }, "数据库引擎不受支持"},
		{"版本", func(b map[string]any) { b["versionTag"] = "latest" }, "必须指定明确的数据库版本标签"},
		{"参数", func(b map[string]any) { delete(b, "containerName") }, "创建容器参数无效"},
		{"范围", func(b map[string]any) { b["accessScope"] = "everywhere" }, "访问范围无效"},
		{"公网端口", func(b map[string]any) { b["accessScope"] = "any-host" }, "任意主机访问必须指定宿主端口"},
		{"公网确认", func(b map[string]any) { b["accessScope"] = "any-host"; b["hostPort"] = float64(43306) }, "任意主机访问必须再次确认"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			_, err := validateCreateRequest(valid(testCase.mutate))
			var invalid *shared.InvalidRequestError
			if !errors.As(err, &invalid) || invalid.Message != testCase.want {
				t.Fatalf("应拒绝「%s」，实际 %v", testCase.want, err)
			}
		})
	}
}

func TestCreateNewContainerRegistersAdminAndActivates(t *testing.T) {
	hostPort := 43306
	fixture := newServiceFixture("", []contract.Container{}, nil)
	fixture.docker.createResult = createResult{containerID: testContainerID, volumeName: stoppedManagedVolumeName, started: true}
	fixture.docker.inspectFn = func(_ context.Context, id string) (map[string]any, error) {
		return containerBody(id, "mysql:8.4", true, map[string]string{"elysian.database.engine": "MySQL", "elysian.database.version": "8.4"}, []string{"elysian-db-shared"}, enginePortBindings("0.0.0.0", "43306"), testVolumeMount(stoppedManagedVolumeName)), nil
	}
	request := createRequest{Engine: engineMySQL, VersionTag: "8.4", ContainerName: "mysql-main", ImageID: testImageIDBare, AccessScope: scopeAnyHost, HostPort: &hostPort}
	response, err := fixture.service.Create(context.Background(), request)
	if err != nil {
		t.Fatalf("创建失败：%v", err)
	}
	if len(fixture.docker.createCalls) != 1 || fixture.docker.createCalls[0].bootstrapPwd == "" || fixture.docker.createCalls[0].engine != engineMySQL {
		t.Fatalf("create 调用不符：%+v", fixture.docker.createCalls)
	}
	rows, err := fixture.registry.list()
	if err != nil || len(rows) != 1 {
		t.Fatalf("登记行不符：%v %d", err, len(rows))
	}
	row := rows[0]
	if row.Engine != engineMySQL || row.VersionTag != "8.4" || row.ContainerID != testContainerID || row.VolumeName != stoppedManagedVolumeName ||
		row.Source != sourceManaged || row.AccessScope != scopeAnyHost || row.State != stateActive || row.ContainerName != "mysql-main" {
		t.Fatalf("登记行内容不符：%+v", row)
	}
	if row.Admin.Username != "root" || row.Admin.Password == "" {
		t.Fatalf("管理员凭据应由后端生成：%+v", row.Admin)
	}
	if row.User != (databaseSecret{}) {
		t.Fatalf("普通账号不再初始化，应为零值：%+v", row.User)
	}
	instance := response.Instance
	if instance.ID != testContainerID || instance.ContainerID != testContainerID || instance.Source != sourceManaged ||
		instance.CredentialUsername != "root" || !instance.CredentialsVerified || instance.Version != "8.4" {
		t.Fatalf("实例投影不符：%+v", instance)
	}
	if fixture.firewall.called() != 1 || fixture.firewall.ports[0] != 43306 || !strings.Contains(fixture.firewall.notes[0], "mysql-main") {
		t.Fatalf("any-host 应幂等开放宿主端口：%+v", fixture.firewall)
	}
	if response.FirewallPort == nil || response.FirewallPort.Port != 43306 {
		t.Fatalf("回执应携带防火墙事实：%+v", response.FirewallPort)
	}
}

func TestCreateRedisUsesDefaultAdminWithoutOrdinaryUser(t *testing.T) {
	fixture := newServiceFixture("", []contract.Container{}, nil)
	fixture.docker.createResult = createResult{containerID: testContainerID, volumeName: stoppedManagedVolumeName, started: true}
	fixture.docker.inspectFn = func(_ context.Context, id string) (map[string]any, error) {
		return containerBody(id, "redis:7.4", true, map[string]string{"elysian.database.engine": "Redis", "elysian.database.version": "7.4"}, []string{"elysian-db-shared"}, nil, testVolumeMount(stoppedManagedVolumeName)), nil
	}
	request := createRequest{Engine: engineRedis, VersionTag: "7.4", ContainerName: "redis-main", ImageID: testImageIDBare, AccessScope: scopeContainerNet}
	response, err := fixture.service.Create(context.Background(), request)
	if err != nil {
		t.Fatalf("Redis 创建失败：%v", err)
	}
	rows, _ := fixture.registry.list()
	if rows[0].Admin.Username != "default" || rows[0].User != (databaseSecret{}) {
		t.Fatalf("Redis 管理员应为 default 且无普通账号：%+v", rows[0])
	}
	if response.Instance.CredentialUsername != "default" {
		t.Fatalf("投影管理员名不符：%+v", response.Instance)
	}
	if fixture.firewall.called() != 0 {
		t.Fatal("非 any-host 不应开放防火墙端口")
	}
}

func TestCreateStartFailureKeepsPendingRegistration(t *testing.T) {
	fixture := newServiceFixture("", []contract.Container{}, nil)
	fixture.docker.createResult = createResult{containerID: testContainerID, volumeName: stoppedManagedVolumeName, started: false, startFailure: "面板数据库网络 elysian-db-shared 不存在"}
	request := createRequest{Engine: engineMySQL, VersionTag: "8.4", ContainerName: "mysql-main", ImageID: testImageIDBare, AccessScope: scopeContainerNet}
	_, err := fixture.service.Create(context.Background(), request)
	if err == nil || !strings.Contains(err.Error(), "已登记为待处理") || !strings.Contains(err.Error(), "面板数据库网络") {
		t.Fatalf("启动失败应保留待处理登记并说明原因：%v", err)
	}
	rows, _ := fixture.registry.list()
	if len(rows) != 1 || rows[0].State != stateNeedsAttention {
		t.Fatalf("登记应保留待处理状态：%+v", rows)
	}
}

func TestCreateRejectsDuplicateRegisteredContainerName(t *testing.T) {
	fixture := newServiceFixture("", []contract.Container{}, []databaseRecord{{ID: "row-1", Engine: engineMySQL, ContainerID: strings.Repeat("c", 64), ContainerName: "mysql-main"}})
	request := createRequest{Engine: engineMySQL, VersionTag: "8.4", ContainerName: "mysql-main", ImageID: testImageIDBare, AccessScope: scopeContainerNet}
	_, err := fixture.service.Create(context.Background(), request)
	var invalid *shared.InvalidRequestError
	if !errors.As(err, &invalid) || invalid.Status != 409 || invalid.Message != "数据库容器已登记" {
		t.Fatalf("同名容器应 409：%v", err)
	}
}

func TestConcurrentCreateSameKeyRejected(t *testing.T) {
	fixture := newServiceFixture("", []contract.Container{}, nil)
	release := make(chan struct{})
	started := make(chan struct{})
	request := createRequest{Engine: engineMySQL, VersionTag: "8.4", ContainerName: "mysql-main", ImageID: testImageIDBare, AccessScope: scopeContainerNet}
	fixture.docker.createFn = func(createInput) (createResult, error) {
		started <- struct{}{}
		<-release
		return createResult{containerID: testContainerID, volumeName: stoppedManagedVolumeName, started: true}, nil
	}
	fixture.docker.inspectFn = func(_ context.Context, id string) (map[string]any, error) {
		return containerBody(id, "mysql:8.4", true, map[string]string{"elysian.database.engine": "MySQL"}, []string{"elysian-db-shared"}, nil, testVolumeMount(stoppedManagedVolumeName)), nil
	}
	done := make(chan error, 1)
	go func() {
		_, err := fixture.service.Create(context.Background(), request)
		done <- err
	}()
	<-started
	// 第一个创建未结束时，同键创建在去重守卫处 409。
	_, secondErr := fixture.service.Create(context.Background(), request)
	var invalid *shared.InvalidRequestError
	if !errors.As(secondErr, &invalid) || invalid.Status != 409 || invalid.Message != "相同数据库正在创建" {
		close(release)
		t.Fatalf("相同键并发创建应 409：%v", secondErr)
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatalf("首个创建应正常完成：%v", err)
	}
}

func TestListFiltersDatabaseImagesAndAggregatesRegistry(t *testing.T) {
	selfID := strings.Repeat("d", 64)
	mysqlID := testContainerID
	mariadbID := strings.Repeat("1", 64)
	redisID := strings.Repeat("2", 64)
	adoptedID := strings.Repeat("3", 64)
	foreignID := strings.Repeat("4", 64)
	containers := []contract.Container{
		{ID: selfID, ImageRef: "mysql:8.4"},
		{ID: foreignID, ImageRef: "nginx:1.27"},
		{ID: mysqlID, ImageRef: "mysql:8.4"},
		{ID: mariadbID, ImageRef: "library/mariadb:11.4"},
		{ID: redisID, ImageRef: "docker.io/library/redis:7.4"},
		{ID: adoptedID, ImageRef: "mysql@sha256:" + strings.Repeat("e", 64)},
	}
	rows := []databaseRecord{
		{ID: "row-managed", Engine: engineMySQL, Name: "orders", VersionTag: "8.4", ContainerID: mysqlID,
			VolumeName: stoppedManagedVolumeName, Source: sourceManaged, AccessScope: scopeAnyHost,
			Admin: databaseSecret{Username: "root", Password: "admin-secret"}, CreatedAt: "2026-09-28T09:00:00.000Z", State: stateActive, ContainerName: "mysql-main"},
		{ID: "row-adopted", Engine: engineMySQL, Name: "legacy", VersionTag: "8.0", ContainerID: adoptedID,
			Source: sourceAdopted, Admin: databaseSecret{Username: "root", Password: "adopted-secret"},
			CreatedAt: "2026-09-27T09:00:00.000Z", State: stateNeedsAttention, ContainerName: "legacy-db"},
	}
	fixture := newServiceFixture(selfID, containers, rows)
	inspect := func(_ context.Context, id string) (map[string]any, error) {
		switch id {
		case mysqlID:
			return containerBody(mysqlID, "mysql:8.4", true, map[string]string{
				"elysian.managed": "true", "elysian.database": "true", "elysian.database.engine": "MySQL",
				"elysian.database.version": "8.4", "elysian.database.volume": stoppedManagedVolumeName,
			}, []string{"elysian-db-shared"}, enginePortBindings("0.0.0.0", "43306"), testVolumeMount(stoppedManagedVolumeName)), nil
		case mariadbID:
			return containerBody(mariadbID, "library/mariadb:11.4", true, nil, []string{"bridge"}, enginePortBindings("127.0.0.1", "43307"), nil), nil
		case redisID:
			return containerBody(redisID, "docker.io/library/redis:7.4", false, nil, []string{"bridge"}, map[string]any{"6379/tcp": nil}, nil), nil
		case adoptedID:
			return containerBody(adoptedID, "mysql@sha256:"+strings.Repeat("e", 64), true, nil, []string{"bridge"}, nil, nil), nil
		case selfID, foreignID:
			return containerBody(id, "nginx:1.27", true, nil, nil, nil, nil), nil
		}
		return nil, &shared.InvalidRequestError{Status: 404, Message: "数据库容器已不存在"}
	}
	memoryByID := map[string]*memoryView{mysqlID: {UsedGb: 0.5, TotalGb: 2}}
	fixture.docker.inspectFn = inspect
	fixture.docker.memoryFn = func(_ context.Context, id string) (*memoryView, error) { return memoryByID[id], nil }
	instances, err := fixture.service.List(context.Background())
	if err != nil {
		t.Fatalf("列表失败：%v", err)
	}
	if len(instances) != 4 {
		t.Fatalf("应命中 4 个数据库容器（面板自身与 nginx 排除），实际 %d：%+v", len(instances), instances)
	}
	byID := map[string]containerInstance{}
	for _, instance := range instances {
		byID[instance.ID] = instance
	}
	mysql := byID[mysqlID]
	if mysql.Engine != engineMySQL || mysql.Name != mysqlID[:12]+"-db" || mysql.Status != statusRunning || mysql.Version != "8.4" ||
		mysql.Image != "mysql:8.4" || mysql.Source != sourceManaged || mysql.VolumeName != stoppedManagedVolumeName ||
		mysql.CredentialUsername != "root" || !mysql.CredentialsVerified || mysql.NeedsAttention ||
		mysql.UpdatedAt != "2026-09-28T09:00:00.000Z" {
		t.Fatalf("受管容器投影不符：%+v", mysql)
	}
	if mysql.Memory == nil || mysql.Memory.UsedGb != 0.5 || mysql.Memory.TotalGb != 2 {
		t.Fatalf("内存投影不符：%+v", mysql.Memory)
	}
	if mysql.Address == nil || mysql.Address.Host != "0.0.0.0" || mysql.Address.Port != 43306 {
		t.Fatalf("连接地址应取引擎端口绑定：%+v", mysql.Address)
	}
	if len(mysql.Ports) != 1 || mysql.Ports[0].HostPort == nil || *mysql.Ports[0].HostPort != 43306 || mysql.Ports[0].Protocol != "tcp" {
		t.Fatalf("端口投影不符：%+v", mysql.Ports)
	}
	if len(mysql.Networks) != 1 || mysql.Networks[0] != "elysian-db-shared" {
		t.Fatalf("网络投影不符：%+v", mysql.Networks)
	}
	mariadb := byID[mariadbID]
	if mariadb.Engine != engineMariaDB || mariadb.Status != statusRunning || mariadb.Source != "" || mariadb.CredentialsVerified {
		t.Fatalf("未登记 mariadb 容器投影不符：%+v", mariadb)
	}
	if mariadb.Address == nil || mariadb.Address.Host != "127.0.0.1" {
		t.Fatalf("回环绑定地址投影不符：%+v", mariadb.Address)
	}
	redis := byID[redisID]
	if redis.Engine != engineRedis || redis.Status != statusStopped || redis.Address != nil || redis.Memory != nil {
		t.Fatalf("停止态容器投影不符：%+v", redis)
	}
	adopted := byID[adoptedID]
	if adopted.Engine != engineMySQL || adopted.Version != "8.0" || adopted.Source != sourceAdopted ||
		!adopted.NeedsAttention || !adopted.CredentialsVerified || adopted.CredentialUsername != "root" {
		t.Fatalf("旧 adopted 登记投影不符：%+v", adopted)
	}
	// 冻结键序：id → engine → name → version → status → image → containerId → …
	raw, err := json.Marshal(mysql)
	if err != nil {
		t.Fatal(err)
	}
	text := string(raw)
	order := []string{`"id":`, `"engine":`, `"name":`, `"version":`, `"status":`, `"image":`, `"containerId":`, `"source":`, `"versionTag":`, `"ports":`, `"networks":`, `"volumeName":`, `"address":`, `"credentialUsername":`, `"credentialsVerified":`, `"memory":`, `"needsAttention":`, `"updatedAt":`}
	last := -1
	for _, key := range order {
		index := strings.Index(text, key)
		if index < 0 {
			t.Fatalf("键 %s 缺失：%s", key, text)
		}
		if index <= last {
			t.Fatalf("键序违反冻结契约：%s 顺序错误：%s", key, text)
		}
		last = index
	}
}

func TestListSkipsVanishedContainerAndFailsOnOtherInspectErrors(t *testing.T) {
	fixture := newServiceFixture("", []contract.Container{{ID: testContainerID, ImageRef: "mysql:8.4"}}, nil)
	fixture.docker.inspectFn = func(context.Context, string) (map[string]any, error) {
		return nil, &shared.InvalidRequestError{Status: 404, Message: "数据库容器已不存在"}
	}
	instances, err := fixture.service.List(context.Background())
	if err != nil || len(instances) != 0 {
		t.Fatalf("清单与详情之间消失的容器应跳过：%v %d", err, len(instances))
	}
	fixture.docker.inspectFn = func(context.Context, string) (map[string]any, error) {
		return nil, errors.New("引擎传输失败")
	}
	if _, err := fixture.service.List(context.Background()); err == nil {
		t.Fatal("其他 inspect 故障应让整页失败重试")
	}
}

func TestListFindsDatabaseContainersCreatedByImageID(t *testing.T) {
	imageID, otherImageID := strings.Repeat("e", 64), strings.Repeat("f", 64)
	otherContainerID := strings.Repeat("a", 64)
	fixture := newServiceFixture("", []contract.Container{
		{ID: testContainerID, ImageRef: "sha256:" + imageID, ImageID: imageID},
		{ID: otherContainerID, ImageRef: "sha256:" + otherImageID, ImageID: otherImageID},
	}, nil)
	reads := 0
	fixture.service.deps.listImages = func(context.Context) ([]contract.ContainerImage, error) {
		reads++
		return []contract.ContainerImage{
			{ID: imageID, Name: "local/db", Tag: "current", OtherTags: []string{"mysql:latest", "docker.io/library/mysql:8.4"}},
			{ID: otherImageID, Name: "nginx", Tag: "1.27"},
		}, nil
	}
	fixture.docker.inspectFn = func(_ context.Context, id string) (map[string]any, error) {
		if id != testContainerID {
			t.Fatalf("unexpected container inspection: %s", id)
		}
		return containerBody(id, "sha256:"+imageID, true, nil, nil, nil, nil), nil
	}
	rows, err := fixture.service.List(context.Background())
	if err != nil || len(rows) != 1 || reads != 1 || rows[0].Engine != engineMySQL || rows[0].Version != "8.4" || rows[0].Source != "" {
		t.Fatalf("pinned-image container projection: %+v reads=%d %v", rows, reads, err)
	}
}

func TestListRetainsCleanupAfterContainerDeletionPartiallySucceeds(t *testing.T) {
	row := managedRow(stoppedManagedVolumeName)
	containers := []contract.Container{{ID: row.ContainerID, ImageRef: "mysql:8.4"}}
	fixture := newServiceFixture("", containers, []databaseRecord{row})
	fixture.docker.removeErr = errors.New("删除持久卷失败")
	ctx := context.Background()
	if err := fixture.service.RemoveContainer(ctx, row.ContainerID); err == nil {
		t.Fatal("expected volume removal failure")
	}
	// The initial list can race with Docker deleting the container. A later list
	// has no container ID at all; both must retain the same cleanup row.
	for range 2 {
		rows, err := fixture.service.List(ctx)
		if err != nil || len(rows) != 1 || rows[0].ID != row.ContainerID || rows[0].Status != statusMissing || rows[0].VolumeName != row.VolumeName || !rows[0].NeedsAttention || rows[0].CredentialsVerified {
			t.Fatalf("dangling registration projection: %+v %v", rows, err)
		}
		fixture.service.deps.listContainers = func(context.Context) ([]contract.Container, error) { return nil, nil }
	}
	fixture.docker.removeErr = nil
	if err := fixture.service.RemoveContainer(ctx, row.ContainerID); err != nil {
		t.Fatal(err)
	}
	rows, err := fixture.service.List(ctx)
	if err != nil || len(rows) != 0 {
		t.Fatalf("cleanup left a dangling row: %+v %v", rows, err)
	}
}

func TestReconcileChecksDockerFactsAndClearsAttention(t *testing.T) {
	rows := []databaseRecord{{ID: "row-1", Engine: engineMySQL, VersionTag: "8.4", ContainerID: testContainerID,
		VolumeName: stoppedManagedVolumeName, Source: sourceManaged, AccessScope: scopeAnyHost,
		Admin: databaseSecret{Username: "root", Password: "admin-secret"}, CreatedAt: "2026-09-28T09:00:00.000Z", State: stateNeedsAttention, ContainerName: "mysql-main"}}
	fixture := newServiceFixture("", nil, rows)
	fixture.docker.assertEngineFn = func(_ context.Context, id, engine, versionTag string) (map[string]any, error) {
		if engine != engineMySQL || versionTag != "8.4" {
			return nil, &shared.InvalidRequestError{Status: 409, Message: "容器镜像与所选引擎或版本不一致"}
		}
		return containerBody(id, "mysql:8.4", true, nil, nil, nil, testVolumeMount(stoppedManagedVolumeName)), nil
	}
	instance, err := fixture.service.Reconcile(context.Background(), testContainerID)
	if err != nil {
		t.Fatalf("核对失败：%v", err)
	}
	if instance.Status != statusRunning || instance.NeedsAttention {
		t.Fatalf("核对通过应回运行中实例行：%+v", instance)
	}
	current, _ := fixture.registry.list()
	if current[0].State != stateActive {
		t.Fatalf("待处理状态应清除：%+v", current[0])
	}
	// 专属卷未挂载时拒绝。
	fixture.docker.assertEngineFn = func(_ context.Context, id, _, _ string) (map[string]any, error) {
		return containerBody(id, "mysql:8.4", true, nil, nil, nil, nil), nil
	}
	_, err = fixture.service.Reconcile(context.Background(), testContainerID)
	var invalid *shared.InvalidRequestError
	if !errors.As(err, &invalid) || invalid.Status != 409 || invalid.Message != "容器没有挂载登记的数据库持久卷" {
		t.Fatalf("专属卷缺失应 409：%v", err)
	}
}

func TestReconcileOnUnknownContainerReturns404(t *testing.T) {
	fixture := newServiceFixture("", nil, nil)
	_, err := fixture.service.Reconcile(context.Background(), testContainerID)
	var invalid *shared.InvalidRequestError
	if !errors.As(err, &invalid) || invalid.Status != 404 || invalid.Message != "数据库不存在" {
		t.Fatalf("无登记容器应 404：%v", err)
	}
}

func TestRevealReturnsAdminCredentialWithoutProtocol(t *testing.T) {
	rows := []databaseRecord{{ID: "row-1", Engine: engineMySQL, ContainerID: testContainerID,
		Admin: databaseSecret{Username: "root", Password: "admin-secret"}, Source: sourceManaged, State: stateActive, CreatedAt: "2026-09-28T09:00:00.000Z"}}
	fixture := newServiceFixture("", nil, rows)
	secret, err := fixture.service.Reveal(context.Background(), testContainerID)
	if err != nil || secret.Username != "root" || secret.Password != "admin-secret" {
		t.Fatalf("reveal 应直读登记行管理员凭据：%v %+v", err, secret)
	}
	if len(fixture.docker.createCalls) != 0 {
		t.Fatal("reveal 不得发起协议或网络副作用")
	}
	if _, err := fixture.service.Reveal(context.Background(), strings.Repeat("9", 64)); err == nil {
		t.Fatal("未登记容器应 404")
	}
	empty := newServiceFixture("", nil, []databaseRecord{{ID: "row-2", Engine: engineMySQL, ContainerID: testContainerID, State: stateEmpty, CreatedAt: "2026-09-28T09:00:00.000Z"}})
	_, err = empty.service.Reveal(context.Background(), testContainerID)
	var invalid *shared.InvalidRequestError
	if !errors.As(err, &invalid) || invalid.Status != 409 || invalid.Message != "没有已保存的管理员凭据" {
		t.Fatalf("无凭据登记应 409：%v", err)
	}
}

func TestRemoveContainerAggregatesRowsAndKeepsIdentityChecks(t *testing.T) {
	volume := stoppedManagedVolumeName
	rows := []databaseRecord{
		{ID: "row-a", Engine: engineMySQL, VersionTag: "8.4", ContainerID: testContainerID, VolumeName: volume,
			Source: sourceManaged, Admin: databaseSecret{Username: "root", Password: "admin-secret"}, CreatedAt: "2026-09-28T09:00:00.000Z", State: stateActive, ContainerName: "mysql-main"},
		{ID: "row-b", Engine: engineMySQL, VersionTag: "8.4", ContainerID: testContainerID, VolumeName: volume,
			Source: sourceManaged, Admin: databaseSecret{Username: "root", Password: "admin-secret"}, CreatedAt: "2026-09-28T10:00:00.000Z", State: stateEmpty, ContainerName: "mysql-main"},
	}
	fixture := newServiceFixture("", nil, rows)
	fixture.docker.removeErr = &shared.InvalidRequestError{Status: 409, Message: "容器或持久卷不属于面板管理的数据库"}
	if err := fixture.service.RemoveContainer(context.Background(), testContainerID); err == nil {
		t.Fatal("身份核对失败应拒绝删除")
	}
	if len(fixture.docker.removeCalls) != 1 {
		t.Fatalf("removeManaged 应恰好调用一次：%v", fixture.docker.removeCalls)
	}
	if kept, _ := fixture.registry.list(); len(kept) != 2 {
		t.Fatalf("删除失败不得清理登记：%d", len(kept))
	}
	fixture.docker.removeErr = nil
	if err := fixture.service.RemoveContainer(context.Background(), testContainerID); err != nil {
		t.Fatalf("删除失败：%v", err)
	}
	if fixture.docker.removeCalls[0] != testContainerID+"|"+volume+"|"+engineMySQL+"|8.4" {
		t.Fatalf("removeManaged 参数不符：%v", fixture.docker.removeCalls)
	}
	if kept, _ := fixture.registry.list(); len(kept) != 0 {
		t.Fatalf("成功后应移除该容器全部登记行：%+v", kept)
	}
}

func TestRemoveContainerRejectsAdoptedOnlyRows(t *testing.T) {
	rows := []databaseRecord{{ID: "row-adopted", Engine: engineMySQL, VersionTag: "8.0", ContainerID: testContainerID,
		Source: sourceAdopted, Admin: databaseSecret{Username: "root", Password: "adopted-secret"}, CreatedAt: "2026-09-27T09:00:00.000Z", State: stateActive, ContainerName: "legacy-db"}}
	fixture := newServiceFixture("", nil, rows)
	err := fixture.service.RemoveContainer(context.Background(), testContainerID)
	var invalid *shared.InvalidRequestError
	if !errors.As(err, &invalid) || invalid.Status != 403 || invalid.Message != "只能删除面板创建的数据库容器和专属卷" {
		t.Fatalf("非受管容器应 403：%v", err)
	}
	if len(fixture.docker.removeCalls) != 0 {
		t.Fatal("拒绝路径不得派发删除")
	}
}

func TestForgetOnlyWhenContainerGone(t *testing.T) {
	rows := []databaseRecord{{ID: "row-adopted", Engine: engineMySQL, ContainerID: testContainerID,
		Source: sourceAdopted, Admin: databaseSecret{Username: "root", Password: "adopted-secret"}, CreatedAt: "2026-09-27T09:00:00.000Z", State: stateNeedsAttention, ContainerName: "legacy-db"}}
	fixture := newServiceFixture("", nil, rows)
	fixture.docker.inspectFn = func(_ context.Context, id string) (map[string]any, error) {
		return containerBody(id, "mysql:8.0", true, nil, nil, nil, nil), nil
	}
	err := fixture.service.Forget(context.Background(), testContainerID)
	var invalid *shared.InvalidRequestError
	if !errors.As(err, &invalid) || invalid.Status != 409 {
		t.Fatalf("容器仍在时应 409：%v", err)
	}
	if kept, _ := fixture.registry.list(); len(kept) != 1 {
		t.Fatal("容器仍在不得清理登记")
	}
	fixture.docker.inspectFn = nil // 404：容器已不存在
	if err := fixture.service.Forget(context.Background(), testContainerID); err != nil {
		t.Fatalf("容器已不存在应清理整组登记：%v", err)
	}
	if kept, _ := fixture.registry.list(); len(kept) != 0 {
		t.Fatalf("登记应清空：%+v", kept)
	}
}

func TestLegacyRegistryRowsAggregateAcrossOldFormats(t *testing.T) {
	// 旧登记形态：同一容器的 managed 多行（active + stateEmpty 空容器行）。
	rows := []databaseRecord{
		{ID: "empty-row", Engine: engineMySQL, Name: "orders", VersionTag: "8.4", ContainerID: testContainerID,
			VolumeName: stoppedManagedVolumeName, Source: sourceManaged, AccessScope: scopeAnyHost,
			Admin: databaseSecret{Username: "root", Password: "admin-secret"}, CreatedAt: "2026-09-26T09:00:00.000Z", State: stateEmpty, ContainerName: "mysql-main"},
		{ID: "managed-row", Engine: engineMySQL, Name: "crm", VersionTag: "8.4", ContainerID: testContainerID,
			VolumeName: stoppedManagedVolumeName, Source: sourceManaged, AccessScope: scopeAnyHost,
			Admin: databaseSecret{Username: "root", Password: "admin-secret"}, CreatedAt: "2026-09-28T09:00:00.000Z", State: stateActive, ContainerName: "mysql-main"},
	}
	containers := []contract.Container{{ID: testContainerID, ImageRef: "mysql:8.4"}}
	fixture := newServiceFixture("", containers, rows)
	fixture.docker.inspectFn = func(_ context.Context, id string) (map[string]any, error) {
		return containerBody(id, "mysql:8.4", true, map[string]string{
			"elysian.managed": "true", "elysian.database": "true", "elysian.database.engine": "MySQL",
			"elysian.database.version": "8.4", "elysian.database.volume": stoppedManagedVolumeName,
		}, []string{"elysian-db-shared"}, enginePortBindings("0.0.0.0", "43306"), testVolumeMount(stoppedManagedVolumeName)), nil
	}
	instances, err := fixture.service.List(context.Background())
	if err != nil || len(instances) != 1 {
		t.Fatalf("同容器多行应聚合为一行：%v %d", err, len(instances))
	}
	instance := instances[0]
	if instance.Source != sourceManaged || instance.CredentialUsername != "root" || !instance.CredentialsVerified || !instance.NeedsAttention {
		t.Fatalf("多行聚合投影不符：%+v", instance)
	}
	// 删除仍按容器聚合执行：removeManaged 成功后空容器行一并清理。
	if err := fixture.service.RemoveContainer(context.Background(), testContainerID); err != nil {
		t.Fatalf("删除失败：%v", err)
	}
	if kept, _ := fixture.registry.list(); len(kept) != 0 {
		t.Fatalf("空容器行应随容器删除一并清理：%+v", kept)
	}
}

// TestFileRegistryPreservesLegacyRecordShape 旧 databases.json 解析与写回键序不变。
func TestFileRegistryPreservesLegacyRecordShape(t *testing.T) {
	path := filepath.Join(t.TempDir(), "databases.json")
	legacy := `[{"id":"row-1","engine":"MySQL","name":"orders","versionTag":"8.4","containerId":"` + testContainerID + `","volumeName":"` + stoppedManagedVolumeName + `","source":"managed","accessScope":"any-host","admin":{"username":"root","password":"admin-secret"},"user":{"username":"reader","password":"reader-secret"},"createdAt":"2026-09-26T09:00:00.000Z","state":"active","containerName":"mysql-main"}]`
	if err := os.WriteFile(path, []byte(legacy), 0o600); err != nil {
		t.Fatal(err)
	}
	registry := newFileDatabaseRegistry(path)
	rows, err := registry.list()
	if err != nil || len(rows) != 1 || rows[0].User.Username != "reader" || rows[0].Admin.Password != "admin-secret" {
		t.Fatalf("旧格式登记应原样解析：%v %+v", err, rows)
	}
	rows[0].State = stateNeedsAttention
	if err := registry.put(rows[0]); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	for _, key := range []string{`"id":`, `"engine":`, `"name":`, `"versionTag":`, `"containerId":`, `"volumeName":`, `"source":`, `"accessScope":`, `"admin":`, `"user":`, `"createdAt":`, `"state":`, `"containerName":`} {
		if !strings.Contains(text, key) {
			t.Fatalf("写回应保留旧键 %s：%s", key, text)
		}
	}
}

// guardFixture 注入容器操作守卫的假件。
type guardFixture struct {
	calls []string
	err   error
}

func (g *guardFixture) guard(_ context.Context, id, name, own string) error {
	g.calls = append(g.calls, id+"|"+name+"|"+own)
	return g.err
}

func TestContainerMutationGuardReceivesContainerName(t *testing.T) {
	rows := []databaseRecord{{ID: "row-1", Engine: engineMySQL, ContainerID: testContainerID,
		Source: sourceManaged, State: stateActive, CreatedAt: "2026-09-28T09:00:00.000Z", ContainerName: "mysql-main"}}
	fixture := newServiceFixture("", nil, rows)
	guard := &guardFixture{err: errors.New("此容器有进行中或结果未确认的操作")}
	fixture.service.operationGuard = guard.guard
	if _, err := fixture.service.Reconcile(context.Background(), testContainerID); err == nil {
		t.Fatal("守卫拒绝应上抛")
	}
	if len(guard.calls) != 1 || guard.calls[0] != testContainerID+"|mysql-main|" {
		t.Fatalf("守卫应收容器 ID 与名称：%v", guard.calls)
	}
}

// 编译期锚定：memory 消隐与布尔字段恒出现。
func TestMemoryOmittedWhenUnavailable(t *testing.T) {
	containers := []contract.Container{{ID: testContainerID, ImageRef: "mysql:8.4"}}
	fixture := newServiceFixture("", containers, nil)
	fixture.docker.inspectFn = func(_ context.Context, id string) (map[string]any, error) {
		return containerBody(id, "mysql:8.4", true, nil, nil, nil, nil), nil
	}
	fixture.docker.memoryFn = func(context.Context, string) (*memoryView, error) {
		return nil, errors.New("stats 不可用")
	}
	instances, err := fixture.service.List(context.Background())
	if err != nil || len(instances) != 1 {
		t.Fatalf("列表失败：%v", err)
	}
	raw, _ := json.Marshal(instances[0])
	if strings.Contains(string(raw), `"memory"`) {
		t.Fatalf("stats 读不到时应以 omitempty 消隐，不补零：%s", raw)
	}
	if !strings.Contains(string(raw), `"credentialsVerified":false`) || !strings.Contains(string(raw), `"needsAttention":false`) {
		t.Fatalf("布尔字段应恒出现：%s", raw)
	}
}
