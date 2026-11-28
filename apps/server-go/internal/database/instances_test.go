package database

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"elysian/server/internal/contract"
	"elysian/server/internal/seam"
	"elysian/server/internal/shared"
)

func hexID(digit string) string { return strings.Repeat(digit, 64) }

type instanceSpec struct {
	id      string
	ref     string
	running bool
	labels  map[string]string
	ports   map[string]any
}

type fakeHostCapacity struct {
	memory shared.HostMemory
	err    error
}

func (f fakeHostCapacity) Sample(context.Context) (shared.HostMemory, error) { return f.memory, f.err }

func ampleMemory() seam.HostCapacity {
	return fakeHostCapacity{memory: shared.HostMemory{TotalBytes: 64 << 30, AvailableBytes: 32 << 30}}
}

// newInstanceService 构造带若干数据库容器、登记与本地镜像的服务。
func newInstanceService(specs []instanceSpec, rows []databaseRecord, images []contract.ContainerImage, capacity seam.HostCapacity) *databaseService {
	service, _, _ := newInstanceFixture(specs, rows, images, capacity)
	return service
}

// newInstanceFixture 与 newInstanceService 相同，但把假件交还给调用方继续编排。
func newInstanceFixture(specs []instanceSpec, rows []databaseRecord, images []contract.ContainerImage, capacity seam.HostCapacity) (*databaseService, *fakeDocker, *memoryDatabaseRegistry) {
	containers := make([]contract.Container, 0, len(specs))
	bodies := map[string]map[string]any{}
	for _, spec := range specs {
		containers = append(containers, contract.Container{ID: spec.id, Name: spec.id[:12], ImageRef: spec.ref})
		bodies[spec.id] = containerBody(spec.id, spec.ref, spec.running, spec.labels, []string{"elysian-db-shared"}, spec.ports, nil)
	}
	docker := &fakeDocker{inspectFn: func(_ context.Context, id string) (map[string]any, error) {
		body, ok := bodies[id]
		if !ok {
			return nil, shared.NotFound("数据库容器已不存在")
		}
		return body, nil
	}}
	registry := newMemoryDatabaseRegistry(rows)
	return newDatabaseService(serviceDeps{
		registry:       registry,
		docker:         docker,
		listContainers: func(context.Context) ([]contract.Container, error) { return containers, nil },
		listImages:     func(context.Context) ([]contract.ContainerImage, error) { return images, nil },
		hostCapacity:   capacity,
	}), docker, registry
}

func registeredRow(id, engine, version string, container string) databaseRecord {
	return databaseRecord{ID: id, Engine: engine, Name: container, VersionTag: version, ContainerID: container, VolumeName: "elysian-db-" + id,
		Source: sourceManaged, AccessScope: scopeContainerNet, Admin: databaseSecret{Username: defaultAdminUsername(engine, nil), Password: "never-project-" + id}, State: stateActive,
		CreatedAt: "2026-11-01T00:00:00.000Z", ContainerName: container, ResourceTier: "small"}
}

func mysqlImages(tags ...string) []contract.ContainerImage {
	images := make([]contract.ContainerImage, 0, len(tags))
	for i, tag := range tags {
		images = append(images, contract.ContainerImage{ID: "sha256:" + strings.Repeat(string(rune('a'+i)), 64), Name: "mysql", Tag: tag, SizeMB: 500})
	}
	return images
}

func TestInstanceViewsClassifyOwnershipReusabilityAndAdoptability(t *testing.T) {
	service := newInstanceService([]instanceSpec{
		{id: hexID("1"), ref: "mysql:8.0", running: true, labels: map[string]string{"elysian.managed": "true", "elysian.database.engine": "MySQL", "elysian.database.version": "8.0"}},
		{id: hexID("2"), ref: "mysql:8.0", running: true},
		{id: hexID("3"), ref: "mysql:8.0", running: false},
		{id: hexID("4"), ref: "mysql:8.0", running: false, labels: map[string]string{"elysian.managed": "true", "elysian.database.engine": "MySQL", "elysian.database.version": "8.0"}},
		{id: hexID("5"), ref: "mysql:8.0", running: true},
	}, []databaseRecord{
		registeredRow("row-1", engineMySQL, "8.0", hexID("1")),
		registeredRow("row-4", engineMySQL, "8.0", hexID("4")),
		adoptedRow("row-5", engineMySQL, "8.0", hexID("5")),
	}, nil, ampleMemory())
	views, err := service.ListInstances(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	byID := map[string]InstanceView{}
	for _, view := range views {
		byID[view.ID] = view
	}
	if len(views) != 5 {
		t.Fatalf("应列出全部 5 个实例：%+v", views)
	}
	if v := byID[hexID("1")]; v.Ownership != instanceManaged || !v.Reusable || v.Adoptable || v.ResourceTier != "small" || v.Reason != "" {
		t.Errorf("面板创建且运行中的实例应可复用：%+v", v)
	}
	if v := byID[hexID("2")]; v.Ownership != instanceUnmanaged || v.Reusable || !v.Adoptable || !strings.Contains(v.Reason, "接管") || !v.Official {
		t.Errorf("未接管的运行中自装实例应可接管、不可复用：%+v", v)
	}
	if v := byID[hexID("3")]; v.Reusable || v.Adoptable {
		t.Errorf("已停止的自装实例既不能复用也不能接管：%+v", v)
	}
	if v := byID[hexID("4")]; v.Ownership != instanceManaged || v.Reusable || !strings.Contains(v.Reason, "未运行") {
		t.Errorf("已停止的受管实例不可复用并说明原因：%+v", v)
	}
	if v := byID[hexID("5")]; v.Ownership != instanceAdopted || !v.Reusable {
		t.Errorf("已接管的运行中实例应可复用：%+v", v)
	}
	raw, err := json.Marshal(views)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "never-project-") {
		t.Fatalf("实例投影不得带出密码：%s", raw)
	}
}

func adoptedRow(id, engine, version, container string) databaseRecord {
	row := registeredRow(id, engine, version, container)
	row.Source, row.VolumeName = sourceAdopted, ""
	return row
}

func TestVersionMatchesAcceptsExactAndDescendantPatches(t *testing.T) {
	for _, tc := range []struct {
		instance, want string
		ok             bool
	}{
		{"8.0", "8.0", true},
		{"8.0.36", "8.0", true},
		{"8.0.36", "8", true},
		{"5.7", "8.0", false},
		{"10.11", "10.1", false},
		{"8.0", "8.0.36", false},
	} {
		if got := versionMatches(tc.instance, tc.want); got != tc.ok {
			t.Errorf("versionMatches(%q, %q) = %v", tc.instance, tc.want, got)
		}
	}
}

func TestPlanProvisionPrefersReusableMatchingInstance(t *testing.T) {
	service := newInstanceService([]instanceSpec{
		{id: hexID("1"), ref: "mysql:8.0", running: true, labels: map[string]string{"elysian.managed": "true", "elysian.database.engine": "MySQL", "elysian.database.version": "8.0"}},
		{id: hexID("2"), ref: "mysql:8.0", running: true},
	}, []databaseRecord{registeredRow("row-1", engineMySQL, "8.0.36", hexID("1"))}, mysqlImages("8.0"), ampleMemory())
	plan, err := service.PlanProvision(context.Background(), engineMySQL, "8.0", "", false)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Action != planReuse || plan.Instance == nil || plan.Instance.ID != hexID("1") {
		t.Fatalf("有可复用的匹配实例时应复用而不是新建：%+v", plan)
	}
	forced, err := service.PlanProvision(context.Background(), engineMySQL, "8.0", "", true)
	if err != nil {
		t.Fatal(err)
	}
	if forced.Action != planCreate || forced.Capacity == nil {
		t.Fatalf("newInstance=true 时应走新建并附容量读数：%+v", forced)
	}
}

func TestPlanProvisionPrefersExactVersionThenNewest(t *testing.T) {
	service := newInstanceService([]instanceSpec{
		{id: hexID("1"), ref: "mysql:8.0", running: true, labels: map[string]string{"elysian.managed": "true", "elysian.database.engine": "MySQL"}},
		{id: hexID("2"), ref: "mysql:8.0", running: true, labels: map[string]string{"elysian.managed": "true", "elysian.database.engine": "MySQL"}},
		{id: hexID("3"), ref: "mysql:8.0", running: true, labels: map[string]string{"elysian.managed": "true", "elysian.database.engine": "MySQL"}},
	}, []databaseRecord{
		registeredRow("row-1", engineMySQL, "8.0.40", hexID("1")),
		registeredRow("row-2", engineMySQL, "8.0", hexID("2")),
		registeredRow("row-3", engineMySQL, "8.0.36", hexID("3")),
	}, nil, ampleMemory())
	plan, err := service.PlanProvision(context.Background(), engineMySQL, "8.0", "", false)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Action != planReuse || plan.Instance.ID != hexID("2") {
		t.Fatalf("应优先复用版本完全一致的实例：%+v", plan)
	}
}

func TestPlanProvisionReportsStoppedAndUnadoptedMatches(t *testing.T) {
	stopped := newInstanceService([]instanceSpec{
		{id: hexID("1"), ref: "mysql:8.0", running: false, labels: map[string]string{"elysian.managed": "true", "elysian.database.engine": "MySQL"}},
	}, []databaseRecord{registeredRow("row-1", engineMySQL, "8.0", hexID("1"))}, mysqlImages("8.0"), ampleMemory())
	plan, err := stopped.PlanProvision(context.Background(), engineMySQL, "8.0", "", false)
	if err != nil || plan.Action != planInstanceStopped || plan.Instance == nil {
		t.Fatalf("匹配实例已停止时应如实报告：%+v %v", plan, err)
	}

	unadopted := newInstanceService([]instanceSpec{{id: hexID("2"), ref: "mysql:8.0", running: true}}, nil, mysqlImages("8.0"), ampleMemory())
	plan, err = unadopted.PlanProvision(context.Background(), engineMySQL, "8.0", "", false)
	if err != nil || plan.Action != planAdoptFirst || plan.Instance == nil || !strings.Contains(plan.Reason, "接管") {
		t.Fatalf("只有未接管的匹配容器时应提示先接管：%+v %v", plan, err)
	}
}

func TestPlanProvisionCreatePathChecksImageAndCapacity(t *testing.T) {
	local := newInstanceService(nil, nil, mysqlImages("8.0", "5.7"), ampleMemory())
	plan, err := local.PlanProvision(context.Background(), engineMySQL, "8.0", "", false)
	if err != nil || plan.Action != planCreate || plan.Capacity == nil || !plan.Capacity.Available {
		t.Fatalf("没有可复用实例且镜像在本地时应新建：%+v %v", plan, err)
	}

	missing := newInstanceService(nil, nil, mysqlImages("5.7"), ampleMemory())
	plan, err = missing.PlanProvision(context.Background(), engineMySQL, "8.0", "", false)
	if err != nil || plan.Action != planPullImageFirst || strings.Join(plan.LocalImageTags, ",") != "5.7" {
		t.Fatalf("本地没有该版本镜像时应提示先拉取并列出已有版本：%+v %v", plan, err)
	}

	tight := newInstanceService(nil, nil, mysqlImages("8.0"), fakeHostCapacity{memory: shared.HostMemory{TotalBytes: 2560 << 20, AvailableBytes: 256<<20 + 512<<20 - 1}})
	plan, err = tight.PlanProvision(context.Background(), engineMySQL, "8.0", "", false)
	if err != nil || plan.Action != planInsufficient || plan.Capacity == nil || !plan.Capacity.Available || plan.Capacity.Tiers[0].Fits {
		t.Fatalf("一档都放不下时应报告容量不足：%+v %v", plan, err)
	}

	unreadable := newInstanceService(nil, nil, mysqlImages("8.0"), nil)
	plan, err = unreadable.PlanProvision(context.Background(), engineMySQL, "8.0", "", false)
	if err != nil || plan.Action != planInsufficient || plan.Capacity == nil || plan.Capacity.Reason != shared.HostCapacityUnavailable {
		t.Fatalf("读数不可得时不得当作容量充足：%+v %v", plan, err)
	}
}

func TestPlanProvisionRequiresAnExplicitVersion(t *testing.T) {
	service := newInstanceService(nil, nil, mysqlImages("8.0", "5.7"), ampleMemory())
	plan, err := service.PlanProvision(context.Background(), engineMySQL, "", "", false)
	if err != nil || plan.Action != planChooseVersion || len(plan.LocalImageTags) != 2 {
		t.Fatalf("没有版本时应让调用方先确定版本并列出本地版本：%+v %v", plan, err)
	}
	if _, err := service.PlanProvision(context.Background(), "Oracle", "8.0", "", false); err == nil {
		t.Fatal("不支持的引擎应报错")
	}
	if _, err := service.PlanProvision(context.Background(), engineMySQL, "latest", "", false); err == nil {
		t.Fatal("latest 不是明确版本")
	}
}

func TestPlanProvisionHonoursAnExplicitInstance(t *testing.T) {
	service := newInstanceService([]instanceSpec{
		{id: hexID("1"), ref: "mysql:8.0", running: true, labels: map[string]string{"elysian.managed": "true", "elysian.database.engine": "MySQL"}},
		{id: hexID("2"), ref: "mysql:8.0", running: true},
	}, []databaseRecord{registeredRow("row-1", engineMySQL, "8.0", hexID("1"))}, nil, ampleMemory())
	plan, err := service.PlanProvision(context.Background(), engineMySQL, "8.0", hexID("1"), false)
	if err != nil || plan.Action != planReuse || plan.Instance.ID != hexID("1") {
		t.Fatalf("指定可复用实例时应直接复用：%+v %v", plan, err)
	}
	plan, err = service.PlanProvision(context.Background(), engineMySQL, "8.0", hexID("2"), false)
	if err != nil || plan.Action != planAdoptFirst {
		t.Fatalf("指定未接管实例时应提示先接管：%+v %v", plan, err)
	}
	if _, err := service.PlanProvision(context.Background(), engineMySQL, "8.0", hexID("9"), false); err == nil {
		t.Fatal("指定不存在的实例应报错")
	}
}

// 待核对的实例（needs-attention）不可复用：它的管理员凭据尚未核对，直接建库可能打到
// 一个从未初始化成功的实例上。
func TestInstanceViewIsNotReusableWhileNeedsAttention(t *testing.T) {
	service := newInstanceService([]instanceSpec{
		{id: hexID("1"), ref: "mysql:8.0", running: true, labels: map[string]string{"elysian.managed": "true", "elysian.database.engine": "MySQL", "elysian.database.version": "8.0"}},
	}, []databaseRecord{registeredRow("row-1", engineMySQL, "8.0", hexID("1"))}, nil, ampleMemory())
	// 待核对状态：登记行 state 非 active。
	rows := service.deps.registry.(*memoryDatabaseRegistry).registryRows()
	(*rows)[0].State = stateNeedsAttention
	views, err := service.ListInstances(context.Background())
	if err != nil || len(views) != 1 {
		t.Fatalf("列表读取失败：%v", err)
	}
	if views[0].Reusable || !strings.Contains(views[0].Reason, "待核对") {
		t.Fatalf("待核对的实例不可复用并应说明原因：%+v", views[0])
	}
}
