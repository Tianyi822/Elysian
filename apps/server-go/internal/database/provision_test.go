package database

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"elysian/server/internal/contract"
	"elysian/server/internal/seam"
	"elysian/server/internal/shared"
)

const provisionRequest = "1111111111111111111111111111111111111111111111111111111111111111"

// fakeAdmin 是实例内管理操作的假执行面。
type fakeAdmin struct {
	readyFn     func(context.Context, adminTarget) error
	verifyFn    func(context.Context, adminTarget) error
	inspectFn   func(context.Context, adminTarget, logicalPlan) (logicalExistence, error)
	logicalFn   func(context.Context, adminTarget, logicalPlan) error
	readyCalls  int
	verifyCalls int
	logicalPlan []logicalPlan
	targets     []adminTarget
}

func (f *fakeAdmin) waitReady(ctx context.Context, target adminTarget) error {
	f.readyCalls++
	f.targets = append(f.targets, target)
	if f.readyFn != nil {
		return f.readyFn(ctx, target)
	}
	return nil
}

func (f *fakeAdmin) inspectLogical(ctx context.Context, target adminTarget, plan logicalPlan) (logicalExistence, error) {
	if f.inspectFn != nil {
		return f.inspectFn(ctx, target, plan)
	}
	return logicalExistence{}, nil
}

func (f *fakeAdmin) createLogical(ctx context.Context, target adminTarget, plan logicalPlan) error {
	f.logicalPlan = append(f.logicalPlan, plan)
	if f.logicalFn != nil {
		return f.logicalFn(ctx, target, plan)
	}
	return nil
}

type provisionFixture struct {
	facade   *AgentFacade
	docker   *fakeDocker
	registry *memoryDatabaseRegistry
	admin    *fakeAdmin
}

// registryRows 直接改内存登记表的行切片（测试专用）。
func (f *provisionFixture) registryRows() *[]databaseRecord { return &f.registry.rows }

func newProvisionFixture(t *testing.T, specs []instanceSpec, rows []databaseRecord, images []contract.ContainerImage, capacity seam.HostCapacity) *provisionFixture {
	t.Helper()
	service, docker, registry := newInstanceFixture(specs, rows, images, capacity)
	admin := &fakeAdmin{}
	service.deps.admin = admin
	facade := &AgentFacade{service: service, authorize: func(context.Context) error { return nil }, operationRoot: filepath.Join(t.TempDir(), "provisions"), now: time.Now}
	return &provisionFixture{facade: facade, docker: docker, registry: registry, admin: admin}
}

func provisionInput(database string) ProvisionInput {
	return ProvisionInput{Engine: engineMySQL, Version: "8.0", Database: database, RequestID: provisionRequest}
}

var reusableMySQL = []instanceSpec{
	{id: hexID("1"), ref: "mysql:8.0", running: true, labels: map[string]string{"elysian.managed": "true", "elysian.database.engine": "MySQL", "elysian.database.version": "8.0"}},
}

var reusableMySQLRows = []databaseRecord{registeredRow("row-1", engineMySQL, "8.0", hexID("1"))}

func waitProvision(t *testing.T, fixture *provisionFixture, id string) ProvisionTask {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		task, err := fixture.facade.InspectProvision(context.Background(), id)
		if err != nil {
			t.Fatal(err)
		}
		if task.State != "running" {
			return task
		}
		if time.Now().After(deadline) {
			t.Fatalf("部署任务未进入终态：%+v", task)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func assertNoProvisionTask(t *testing.T, fixture *provisionFixture) {
	t.Helper()
	entries, err := os.ReadDir(fixture.facade.operationRoot)
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("提交前拒绝不得建立任务：%v", entries)
	}
}

// 提交前能判定的问题一律不受理：没有任务、没有变更，原因原样交回模型。
func TestSubmitProvisionRejectsBeforeAcceptingWithoutATask(t *testing.T) {
	reserved := 48100
	unadopted := newProvisionFixture(t, []instanceSpec{{id: hexID("2"), ref: "mysql:8.0", running: true}}, nil, mysqlImages("8.0"), ampleMemory())
	taken := newProvisionFixture(t, reusableMySQL, []databaseRecord{{
		ID: "row-1", Engine: engineMySQL, VersionTag: "8.0", ContainerID: hexID("1"), Source: sourceManaged, State: stateActive,
		Admin:   databaseSecret{Username: "root", Password: "admin"},
		Logical: []logicalDatabaseRecord{{ID: "logical-old", Kind: logicalKindDatabase, Name: "shop", Users: []logicalUser{{Username: "shop_user", Password: "x"}}, State: logicalStateActive}},
	}}, mysqlImages("8.0"), ampleMemory())
	stopped := newProvisionFixture(t, []instanceSpec{{id: hexID("1"), ref: "mysql:8.0", running: false, labels: map[string]string{"elysian.managed": "true", "elysian.database.engine": "MySQL"}}}, reusableMySQLRows, mysqlImages("8.0"), ampleMemory())
	missingImage := newProvisionFixture(t, nil, nil, mysqlImages("5.7"), ampleMemory())
	tight := newProvisionFixture(t, nil, nil, mysqlImages("8.0"), fakeHostCapacity{memory: shared.HostMemory{TotalBytes: 2560 << 20, AvailableBytes: 256<<20 + 512<<20 - 1}})
	creating := newProvisionFixture(t, nil, nil, mysqlImages("8.0"), ampleMemory())
	creating.facade.service.deps.reservedPorts = []int{reserved}
	creating.facade.service.deps.docker.(*fakeDocker).containersFn = func(context.Context) ([]contract.Container, error) {
		return []contract.Container{{ID: hexID("e"), Name: "busy", Ports: []contract.PortBindingView{{ContainerPort: 3306, HostPort: 13306, Protocol: "tcp", HostIP: "0.0.0.0"}}}}, nil
	}

	for name, tc := range map[string]struct {
		fixture *provisionFixture
		input   ProvisionInput
		want    string
	}{
		"请求标识":     {unadopted, func() ProvisionInput { in := provisionInput("shop"); in.RequestID = "short"; return in }(), "请求标识"},
		"引擎":       {unadopted, func() ProvisionInput { in := provisionInput("shop"); in.Engine = "Oracle"; return in }(), "引擎"},
		"版本":       {unadopted, func() ProvisionInput { in := provisionInput("shop"); in.Version = "latest"; return in }(), "版本"},
		"库名":       {unadopted, func() ProvisionInput { in := provisionInput("shop-db"); return in }(), "数据库名"},
		"用户名":      {unadopted, func() ProvisionInput { in := provisionInput("shop"); in.Username = "root"; return in }(), "用户名"},
		"实例不存在":    {unadopted, func() ProvisionInput { in := provisionInput("shop"); in.Instance = hexID("9"); return in }(), "不存在"},
		"先接管":      {unadopted, provisionInput("shop"), "接管"},
		"实例已停止":    {stopped, provisionInput("shop"), "已停止"},
		"先拉取镜像":    {missingImage, provisionInput("shop"), "拉取"},
		"容量不足":     {tight, provisionInput("shop"), "放不下"},
		"新建缺档位与网络": {creating, provisionInput("shop"), "resourceTier"},
		"新建缺网络":    {creating, func() ProvisionInput { in := provisionInput("shop"); in.ResourceTier = "small"; return in }(), "networkScope"},
		"新建档位无效": {creating, func() ProvisionInput {
			in := provisionInput("shop")
			in.ResourceTier = "huge"
			in.NetworkScope = scopeLocalhost
			return in
		}(), "档位"},
		"公网访问缺端口": {creating, func() ProvisionInput {
			in := provisionInput("shop")
			in.ResourceTier = "small"
			in.NetworkScope = scopeAnyHost
			return in
		}(), "宿主端口"},
		"公网端口被面板保留": {creating, func() ProvisionInput {
			in := provisionInput("shop")
			in.ResourceTier = "small"
			in.NetworkScope = scopeAnyHost
			in.HostPort = reserved
			return in
		}(), "保留"},
		"公网端口被运行中的容器占用": {creating, func() ProvisionInput {
			in := provisionInput("shop")
			in.ResourceTier = "small"
			in.NetworkScope = scopeAnyHost
			in.HostPort = 13306
			return in
		}(), "已被占用"},
		"库名已登记":  {taken, provisionInput("shop"), "已由面板登记"},
		"系统保留库名": {unadopted, provisionInput("mysql"), "系统保留"},
		"用户名已登记": {taken, func() ProvisionInput { in := provisionInput("orders"); in.Username = "shop_user"; return in }(), "已被该实例上的另一个数据库占用"},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := tc.fixture.facade.SubmitProvision(context.Background(), tc.input)
			var rejected *AgentProvisionError
			if !errors.As(err, &rejected) || !rejected.NotDispatched || !strings.Contains(rejected.Message, tc.want) {
				t.Fatalf("应作为未派发的可纠正拒绝并说明原因：%v", err)
			}
			assertNoProvisionTask(t, tc.fixture)
			if len(tc.fixture.docker.createCalls) != 0 || len(tc.fixture.admin.logicalPlan) != 0 {
				t.Fatal("拒绝前不得有任何变更")
			}
		})
	}
}

// 有版本匹配的运行中实例：直接在其中建库建专属用户，不创建容器，密码只进登记。
func TestSubmitProvisionReusesRunningInstanceAndRegistersLogicalDatabase(t *testing.T) {
	fixture := newProvisionFixture(t, reusableMySQL, reusableMySQLRows, mysqlImages("8.0"), ampleMemory())
	task, err := fixture.facade.SubmitProvision(context.Background(), provisionInput("shop"))
	if err != nil {
		t.Fatal(err)
	}
	done := waitProvision(t, fixture, task.ID)
	if done.State != "succeeded" || done.Stage != "completed" {
		t.Fatalf("复用路径应成功：%+v", done)
	}
	if len(fixture.docker.createCalls) != 0 {
		t.Fatalf("复用路径不得创建容器：%+v", fixture.docker.createCalls)
	}
	if len(fixture.admin.logicalPlan) != 1 || fixture.admin.logicalPlan[0].database != "shop" || fixture.admin.logicalPlan[0].username != "shop_user" || len(fixture.admin.logicalPlan[0].password) != 48 {
		t.Fatalf("应恰好建一次库并生成 48 位十六进制密码：%+v", fixture.admin.logicalPlan)
	}
	if target := fixture.admin.targets[0]; target.containerID != hexID("1") || target.admin.Username != "root" {
		t.Fatalf("应以实例的管理员身份执行：%+v", target)
	}
	rows, _ := fixture.registry.list()
	logical := rows[0].Logical
	if len(logical) != 1 || logical[0].State != logicalStateActive || logical[0].Users[0].Password != fixture.admin.logicalPlan[0].password {
		t.Fatalf("逻辑库应登记为 active 且密码与执行一致：%+v", logical)
	}
	raw, _ := json.Marshal(done)
	if strings.Contains(string(raw), fixture.admin.logicalPlan[0].password) || strings.Contains(string(raw), rows[0].Admin.Password) {
		t.Fatalf("回执不得带出密码：%s", raw)
	}
	for _, want := range []string{`"action":"reuse"`, `"username":"shop_user"`, "数据库页"} {
		if !strings.Contains(string(raw), want) {
			t.Errorf("回执缺少 %s：%s", want, raw)
		}
	}
}

// 没有可复用实例：新建带档位的受管实例，再在其中建库建用户。
func TestSubmitProvisionCreatesTieredInstanceThenLogicalDatabase(t *testing.T) {
	fixture := newProvisionFixture(t, nil, nil, mysqlImages("8.0"), ampleMemory())
	fixture.docker.createResult = createResult{containerID: hexID("7"), volumeName: "elysian-db-11111111-1111-4111-8111-111111111111", started: true}
	input := provisionInput("shop")
	input.ResourceTier, input.NetworkScope = "medium", scopeLocalhost
	task, err := fixture.facade.SubmitProvision(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	done := waitProvision(t, fixture, task.ID)
	if done.State != "succeeded" || !strings.Contains(string(done.Result), `"action":"create"`) {
		t.Fatalf("新建路径应成功：%+v %s", done, done.Result)
	}
	if len(fixture.docker.createCalls) != 1 {
		t.Fatalf("应恰好创建一个实例：%+v", fixture.docker.createCalls)
	}
	created := fixture.docker.createCalls[0]
	if created.tier != "medium" || created.memoryBytes != 1<<30 || created.nanoCpus != 1_000_000_000 || created.accessScope != scopeLocalhost || created.versionTag != "8.0" {
		t.Errorf("实例应按档位与网络范围创建：%+v", created)
	}
	if !validDatabaseVersion(created.versionTag) || len(created.bootstrapPwd) == 0 {
		t.Errorf("实例应生成管理员密码：%+v", created)
	}
	rows, _ := fixture.registry.list()
	if len(rows) != 1 || rows[0].Source != sourceManaged || rows[0].State != stateActive || rows[0].ResourceTier != "medium" || rows[0].ContainerID != hexID("7") || len(rows[0].Logical) != 1 {
		t.Fatalf("实例与逻辑库都应登记：%+v", rows)
	}
	if target := fixture.admin.targets[0]; target.containerID != hexID("7") || target.admin.Username != "root" {
		t.Fatalf("应以新实例的管理员身份执行：%+v", target)
	}
}

// 实例建好了却迟迟不可登录：如实报告部分完成——实例保留，建库未执行。
func TestSubmitProvisionReportsPartialWhenNewInstanceNeverBecomesReady(t *testing.T) {
	fixture := newProvisionFixture(t, nil, nil, mysqlImages("8.0"), ampleMemory())
	fixture.docker.createResult = createResult{containerID: hexID("7"), volumeName: "elysian-db-11111111-1111-4111-8111-111111111111", started: true}
	fixture.admin.readyFn = func(context.Context, adminTarget) error {
		return errors.New("数据库实例在限定时间内未就绪")
	}
	input := provisionInput("shop")
	input.ResourceTier, input.NetworkScope = "small", scopeContainerNet
	task, err := fixture.facade.SubmitProvision(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	done := waitProvision(t, fixture, task.ID)
	if done.State != "failed" || done.Effect != ProvisionEffectPartial || !strings.Contains(done.Message, "未就绪") {
		t.Fatalf("实例已创建而建库未执行应报告部分完成：%+v", done)
	}
	if len(fixture.admin.logicalPlan) != 0 || len(fixture.docker.removeCalls) != 0 {
		t.Fatal("未就绪时不得建库，也不得删除已创建的实例")
	}
}

// 新实例启动失败：回滚删除本次创建的容器与卷，任务落「无业务变更」的 failed。
func TestSubmitProvisionRollsBackWhenNewInstanceFailsToStart(t *testing.T) {
	fixture := newProvisionFixture(t, nil, nil, mysqlImages("8.0"), ampleMemory())
	fixture.docker.createResult = createResult{containerID: hexID("7"), volumeName: "elysian-db-11111111-1111-4111-8111-111111111111", started: false, startFailure: "bind: address already in use"}
	input := provisionInput("shop")
	input.ResourceTier, input.NetworkScope = "small", scopeContainerNet
	task, err := fixture.facade.SubmitProvision(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	done := waitProvision(t, fixture, task.ID)
	if done.State != "failed" || done.Effect != ProvisionEffectNoChange || !strings.Contains(done.Message, "已回滚") {
		t.Fatalf("启动失败并回滚后应是「无业务变更」的失败：%+v", done)
	}
	if len(fixture.docker.removeCalls) != 1 {
		t.Fatalf("应回滚删除本次创建的实例：%v", fixture.docker.removeCalls)
	}
	if rows, _ := fixture.registry.list(); len(rows) != 0 {
		t.Fatalf("回滚后不应留下登记：%+v", rows)
	}
}

// 回滚本身失败：结果未知，登记保留为待处理，由页面提供恢复入口。
func TestSubmitProvisionStaysUnknownWhenRollbackFails(t *testing.T) {
	fixture := newProvisionFixture(t, nil, nil, mysqlImages("8.0"), ampleMemory())
	fixture.docker.createResult = createResult{containerID: hexID("7"), volumeName: "elysian-db-11111111-1111-4111-8111-111111111111", started: false}
	fixture.docker.removeErr = errors.New("engine unreachable")
	input := provisionInput("shop")
	input.ResourceTier, input.NetworkScope = "small", scopeContainerNet
	task, err := fixture.facade.SubmitProvision(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	done := waitProvision(t, fixture, task.ID)
	if done.State != "unknown" {
		t.Fatalf("回滚未确认时必须保持结果未知：%+v", done)
	}
	if rows, _ := fixture.registry.list(); len(rows) != 1 || rows[0].State != stateNeedsAttention {
		t.Fatalf("结果未知时应保留待处理登记：%+v", rows)
	}
}

// 建库命令没有得到确认：可能已有部分变更，登记保持 pending，任务报告部分完成。
func TestSubmitProvisionKeepsUnknownWhenLogicalCreationIsUnconfirmed(t *testing.T) {
	fixture := newProvisionFixture(t, reusableMySQL, reusableMySQLRows, mysqlImages("8.0"), ampleMemory())
	fixture.admin.logicalFn = func(context.Context, adminTarget, logicalPlan) error {
		return errors.New("数据库或专属用户未得到创建确认")
	}
	task, err := fixture.facade.SubmitProvision(context.Background(), provisionInput("shop"))
	if err != nil {
		t.Fatal(err)
	}
	done := waitProvision(t, fixture, task.ID)
	if done.State != ProvisionUnknown || done.Effect != "" {
		t.Fatalf("建库未确认应保持未知：%+v", done)
	}
	if rows, _ := fixture.registry.list(); len(rows[0].Logical) != 1 || rows[0].Logical[0].State != logicalStatePending {
		t.Fatalf("未确认的逻辑库应保持 pending：%+v", rows[0].Logical)
	}
}

// 同一请求重试返回原任务而不重复执行；同一请求编号换了参数则拒绝。
func TestSubmitProvisionIsIdempotentPerRequest(t *testing.T) {
	fixture := newProvisionFixture(t, reusableMySQL, reusableMySQLRows, mysqlImages("8.0"), ampleMemory())
	first, err := fixture.facade.SubmitProvision(context.Background(), provisionInput("shop"))
	if err != nil {
		t.Fatal(err)
	}
	again, err := fixture.facade.SubmitProvision(context.Background(), provisionInput("shop"))
	if err != nil || again.ID != first.ID {
		t.Fatalf("同请求重试应返回原任务：%+v %v", again, err)
	}
	changed := provisionInput("orders")
	if _, err := fixture.facade.SubmitProvision(context.Background(), changed); err == nil {
		t.Fatal("同一请求编号不得用于不同的部署")
	}
	waitProvision(t, fixture, first.ID)
	replayed, err := fixture.facade.SubmitProvision(t.Context(), provisionInput("shop"))
	if err != nil || replayed.ID != first.ID || replayed.State != ProvisionSucceeded {
		t.Fatalf("成功后重试应回原回执：%+v %v", replayed, err)
	}
	if len(fixture.admin.logicalPlan) != 1 {
		t.Fatalf("重试不得重复建库：%+v", fixture.admin.logicalPlan)
	}
	looked, err := fixture.facade.LookupProvision(context.Background(), provisionRequest)
	if err != nil || looked.ID != first.ID {
		t.Fatalf("应能按请求编号找回任务：%+v %v", looked, err)
	}
}

// 面板重启打断了执行中的部署：重新装载后它是结果未知，不会被当成成功或失败。
func TestProvisionLedgerMarksInterruptedTasksUnknownOnReload(t *testing.T) {
	fixture := newProvisionFixture(t, reusableMySQL, reusableMySQLRows, mysqlImages("8.0"), ampleMemory())
	running := ProvisionTask{ID: provisionID(provisionRequest), RequestID: provisionRequest, Target: "MySQL/8.0/shop", Digest: "digest", State: "running", Stage: "waiting-ready", UpdatedAt: "2026-11-26T00:00:00Z"}
	raw, err := json.Marshal(running)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(fixture.facade.operationRoot, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(fixture.facade.operationRoot, running.ID+".json"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	reloaded := &AgentFacade{service: fixture.facade.service, authorize: func(context.Context) error { return nil }, operationRoot: fixture.facade.operationRoot, now: time.Now}
	done, err := reloaded.InspectProvision(context.Background(), running.ID)
	if err != nil || done.State != "unknown" || !strings.Contains(done.Message, "重启") {
		t.Fatalf("被重启打断的部署应落为结果未知：%+v %v", done, err)
	}
	again := &AgentFacade{service: fixture.facade.service, authorize: func(context.Context) error { return nil }, operationRoot: fixture.facade.operationRoot, now: time.Now}
	if persisted, err := again.InspectProvision(context.Background(), running.ID); err != nil || persisted.State != "unknown" {
		t.Fatalf("未知状态应已写回账本：%+v %v", persisted, err)
	}
}

// 同一实例上已有进行中或结果未确认的部署时，不接受第二个。
func TestSubmitProvisionBlocksOverlappingDeploymentsOnSameInstance(t *testing.T) {
	fixture := newProvisionFixture(t, reusableMySQL, reusableMySQLRows, mysqlImages("8.0"), ampleMemory())
	release := make(chan struct{})
	fixture.admin.readyFn = func(context.Context, adminTarget) error { <-release; return nil }
	first, err := fixture.facade.SubmitProvision(context.Background(), provisionInput("shop"))
	if err != nil {
		t.Fatal(err)
	}
	second := provisionInput("orders")
	second.RequestID = strings.Repeat("2", 64)
	_, err = fixture.facade.SubmitProvision(context.Background(), second)
	// 放行并等后台任务进入终态：它仍在写账本目录，提前返回会和 TempDir 清理相撞。
	close(release)
	waitProvision(t, fixture, first.ID)
	var rejected *AgentProvisionError
	if !errors.As(err, &rejected) || !strings.Contains(rejected.Message, "进行中") {
		t.Fatalf("同一实例的并发部署应被拒绝：%v", err)
	}
}

// 核实「原提交未被受理」：账本里确无该请求时落一张失败回执封存原请求，已有的原任务原样返回。
func TestSealUnacceptedProvision(t *testing.T) {
	fixture := newProvisionFixture(t, reusableMySQL, reusableMySQLRows, mysqlImages("8.0"), ampleMemory())
	sealed, err := fixture.facade.SealUnacceptedProvision(context.Background(), provisionInput("shop"))
	if err != nil || sealed.State != "failed" || sealed.Stage != "not-accepted" || sealed.Effect != ProvisionEffectNotDispatched {
		t.Fatalf("未受理的请求应被封存为未派发失败：%+v %v", sealed, err)
	}
	// 封存之后，迟到的同号提交不得再被执行。
	task, err := fixture.facade.SubmitProvision(context.Background(), provisionInput("shop"))
	if err != nil || task.ID != sealed.ID || len(fixture.admin.logicalPlan) != 0 {
		t.Fatalf("已封存的请求不得被重新受理：%+v %v", task, err)
	}

	accepted, err := fixture.facade.SubmitProvision(context.Background(), func() ProvisionInput { in := provisionInput("shop"); in.RequestID = strings.Repeat("3", 64); return in }())
	if err != nil {
		t.Fatal(err)
	}
	waitProvision(t, fixture, accepted.ID)
	if again, err := fixture.facade.SealUnacceptedProvision(context.Background(), func() ProvisionInput { in := provisionInput("shop"); in.RequestID = strings.Repeat("3", 64); return in }()); err != nil || again.ID != accepted.ID || again.State != "succeeded" {
		t.Fatalf("已受理的原任务应原样返回：%+v %v", again, err)
	}
}

func TestSubmitProvisionRequiresAuthorization(t *testing.T) {
	fixture := newProvisionFixture(t, reusableMySQL, reusableMySQLRows, mysqlImages("8.0"), ampleMemory())
	fixture.facade.authorize = func(context.Context) error { return errors.New("未授权") }
	if _, err := fixture.facade.SubmitProvision(context.Background(), provisionInput("shop")); err == nil {
		t.Fatal("未授权时不得受理部署")
	}
	assertNoProvisionTask(t, fixture)
}

// 新建路径在实例产生后把容器 ID 回填到任务：此后针对该实例的部署与进行中或结果未知的
// 任务互斥，不会两个部署同时在一个实例里建库。
func TestSubmitProvisionRecordsCreatedInstanceForOverlapProtection(t *testing.T) {
	fixture := newProvisionFixture(t, nil, nil, mysqlImages("8.0"), ampleMemory())
	fixture.docker.createResult = createResult{containerID: hexID("7"), volumeName: "elysian-db-11111111-1111-4111-8111-111111111111", started: true}
	// 新实例一旦登记就出现在容器清单里，后续请求才能按实例 ID 指向它。
	created := false
	fixture.facade.service.deps.listContainers = func(context.Context) ([]contract.Container, error) {
		if !created {
			return nil, nil
		}
		return []contract.Container{{ID: hexID("7"), Name: "mysql-8-0-111111", ImageRef: "mysql:8.0"}}, nil
	}
	fixture.docker.inspectFn = func(_ context.Context, id string) (map[string]any, error) {
		if id != hexID("7") || !created {
			return nil, shared.NotFound("数据库容器已不存在")
		}
		return containerBody(id, "mysql:8.0", true, map[string]string{"elysian.managed": "true", "elysian.database.engine": "MySQL", "elysian.database.version": "8.0"}, []string{"elysian-db-shared"}, nil, nil), nil
	}
	fixture.docker.createFn = func(createInput) (createResult, error) {
		created = true
		return fixture.docker.createResult, nil
	}
	release := make(chan struct{})
	fixture.admin.readyFn = func(context.Context, adminTarget) error { <-release; return nil }
	input := provisionInput("shop")
	input.ResourceTier, input.NetworkScope = "small", scopeContainerNet
	first, err := fixture.facade.SubmitProvision(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		task, err := fixture.facade.InspectProvision(context.Background(), first.ID)
		if err != nil {
			t.Fatal(err)
		}
		if task.InstanceID == hexID("7") {
			break
		}
		if time.Now().After(deadline) {
			close(release)
			waitProvision(t, fixture, first.ID)
			t.Fatalf("实例产生后应把容器 ID 回填到任务：%+v", task)
		}
		time.Sleep(10 * time.Millisecond)
	}
	second := ProvisionInput{Engine: engineMySQL, Version: "8.0", Database: "orders", Instance: hexID("7"), RequestID: strings.Repeat("2", 64)}
	secondTask, err := fixture.facade.SubmitProvision(context.Background(), second)
	// 无论第二个部署是否被拒，都等在途任务进入终态再结束用例。
	close(release)
	waitProvision(t, fixture, first.ID)
	if err == nil {
		waitProvision(t, fixture, secondTask.ID)
	}
	var rejected *AgentProvisionError
	// 拒绝文案取决于时机：worker 已把实例翻成 active 时是「进行中」，尚未翻转时是
	// 「待核对」。两者都安全地拒绝了同一实例上的第二个部署。
	if !errors.As(err, &rejected) || !(strings.Contains(rejected.Message, "进行中") || strings.Contains(rejected.Message, "待核对")) {
		t.Fatalf("针对同一实例的第二个部署应被拒绝：%v", err)
	}
}

// 复用实例时，实例里已有的同名库或用户如果不是面板自己的待确认登记，不得接管：续做的幂等脚本
// 会改掉那个用户的密码并授出整库权限，现有应用的连接会立即失效。
func TestSubmitProvisionRefusesToTakeOverForeignObjectsInReusedInstance(t *testing.T) {
	for name, existence := range map[string]logicalExistence{
		"库和用户都是别人的": {Database: true, User: true},
		"只有同名的库":    {Database: true},
		"只有同名的用户":   {User: true},
		"用户同名但密码不符": {Database: true, User: true, PasswordMatches: false},
	} {
		fixture := newProvisionFixture(t, reusableMySQL, reusableMySQLRows, mysqlImages("8.0"), ampleMemory())
		fixture.admin.inspectFn = func(context.Context, adminTarget, logicalPlan) (logicalExistence, error) { return existence, nil }
		_, err := fixture.facade.SubmitProvision(context.Background(), provisionInput("shop"))
		var rejected *AgentProvisionError
		if !errors.As(err, &rejected) || !rejected.NotDispatched || !strings.Contains(rejected.Message, "已存在") {
			t.Errorf("%s：应拒绝接管实例里已有的对象：%v", name, err)
		}
		assertNoProvisionTask(t, fixture)
		if len(fixture.admin.logicalPlan) != 0 {
			t.Errorf("%s：拒绝前不得执行任何建库命令", name)
		}
	}
}

// 核对本身失败时也不执行：无法确认实例里有没有同名对象，就不能冒改别人账号的风险。
func TestSubmitProvisionRefusesWhenInstanceCannotBeInspected(t *testing.T) {
	fixture := newProvisionFixture(t, reusableMySQL, reusableMySQLRows, mysqlImages("8.0"), ampleMemory())
	fixture.admin.inspectFn = func(context.Context, adminTarget, logicalPlan) (logicalExistence, error) {
		return logicalExistence{}, errors.New("engine boom")
	}
	_, err := fixture.facade.SubmitProvision(context.Background(), provisionInput("shop"))
	var rejected *AgentProvisionError
	if !errors.As(err, &rejected) || !rejected.NotDispatched || strings.Contains(rejected.Message, "engine boom") {
		t.Fatalf("核对失败应作为未派发拒绝且不透传底层错误：%v", err)
	}
	assertNoProvisionTask(t, fixture)
}

// 面板自己登记过、被打断的部署可以续做：前提是实例里的同名用户确实能用登记密码登录；
// 续做沿用登记里的用户名与密码，而不是这次请求里新给的。
func TestSubmitProvisionResumesOwnPendingRecord(t *testing.T) {
	fixture := newProvisionFixture(t, reusableMySQL, reusableMySQLRows, mysqlImages("8.0"), ampleMemory())
	registry := fixture.registry
	rows, _ := registry.list()
	row := rows[0]
	row.Logical = []logicalDatabaseRecord{{ID: "logical-pending", Kind: logicalKindDatabase, Name: "shop",
		Users: []logicalUser{{Username: "shop_user", Password: "registered-earlier", Host: "%"}}, State: logicalStatePending}}
	if err := registry.put(row); err != nil {
		t.Fatal(err)
	}
	fixture.admin.inspectFn = func(context.Context, adminTarget, logicalPlan) (logicalExistence, error) {
		return logicalExistence{Database: true, User: true, PasswordMatches: true}, nil
	}
	task, err := fixture.facade.SubmitProvision(context.Background(), provisionInput("shop"))
	if err != nil {
		t.Fatalf("面板自己的待确认登记应允许续做：%v", err)
	}
	done := waitProvision(t, fixture, task.ID)
	if done.State != "succeeded" || len(fixture.admin.logicalPlan) != 1 || fixture.admin.logicalPlan[0].password != "registered-earlier" {
		t.Fatalf("续做应沿用登记的密码：%+v %+v", done, fixture.admin.logicalPlan)
	}
	if updated, _ := registry.list(); updated[0].Logical[0].State != logicalStateActive {
		t.Fatalf("续做完成后登记应变为 active：%+v", updated[0].Logical)
	}
}

// 登记里有待确认记录，但实例里的同名用户密码不是面板登记的：那个用户是别人的，同样拒绝。
func TestSubmitProvisionRefusesPendingRecordWhoseUserIsForeign(t *testing.T) {
	fixture := newProvisionFixture(t, reusableMySQL, reusableMySQLRows, mysqlImages("8.0"), ampleMemory())
	rows, _ := fixture.registry.list()
	row := rows[0]
	row.Logical = []logicalDatabaseRecord{{ID: "logical-pending", Kind: logicalKindDatabase, Name: "shop",
		Users: []logicalUser{{Username: "shop_user", Password: "registered-earlier", Host: "%"}}, State: logicalStatePending}}
	if err := fixture.registry.put(row); err != nil {
		t.Fatal(err)
	}
	fixture.admin.inspectFn = func(context.Context, adminTarget, logicalPlan) (logicalExistence, error) {
		return logicalExistence{Database: true, User: true}, nil
	}
	_, err := fixture.facade.SubmitProvision(context.Background(), provisionInput("shop"))
	var rejected *AgentProvisionError
	if !errors.As(err, &rejected) || !rejected.NotDispatched || !strings.Contains(rejected.Message, "已存在") {
		t.Fatalf("同名用户密码与登记不符时应拒绝：%v", err)
	}
	assertNoProvisionTask(t, fixture)
}

// C1：变更请求一旦发出，传输层失败不得声明「未产生任何变更」——请求可能已被 Engine 执行，
// 会留下一个未登记、带随机 root 密码的实例。只有参数类拒绝（任何引擎写入之前）才是未派发。
func TestSubmitProvisionClassifiesPostMutationCreateErrorsAsUnknown(t *testing.T) {
	input := provisionInput("shop")
	input.ResourceTier, input.NetworkScope = "small", scopeContainerNet
	t.Run("执行中传输失败按未知", func(t *testing.T) {
		fixture := newProvisionFixture(t, nil, nil, mysqlImages("8.0"), ampleMemory())
		fixture.docker.createFn = func(createInput) (createResult, error) { return createResult{}, errors.New("engine unreachable") }
		task, err := fixture.facade.SubmitProvision(context.Background(), input)
		if err != nil {
			t.Fatal(err)
		}
		done := waitProvision(t, fixture, task.ID)
		if done.State != "unknown" {
			t.Fatalf("变更请求发出后的失败必须保持结果未知：%+v", done)
		}
	})
	t.Run("参数类拒绝仍是未派发", func(t *testing.T) {
		fixture := newProvisionFixture(t, nil, nil, mysqlImages("8.0"), ampleMemory())
		fixture.docker.createFn = func(createInput) (createResult, error) {
			return createResult{}, shared.InvalidRequest("宿主端口被面板保留")
		}
		task, err := fixture.facade.SubmitProvision(context.Background(), input)
		if err != nil {
			t.Fatal(err)
		}
		done := waitProvision(t, fixture, task.ID)
		if done.State != "failed" || done.Effect != ProvisionEffectNotDispatched {
			t.Fatalf("参数类拒绝应仍是未派发失败：%+v", done)
		}
	})
}

// 回滚必须回读确认：removeManaged 返回成功不代表容器与卷真的消失了，回读不确认就保持未知。
func TestSubmitProvisionStaysUnknownWhenRollbackIsNotVerified(t *testing.T) {
	fixture := newProvisionFixture(t, nil, nil, mysqlImages("8.0"), ampleMemory())
	fixture.docker.createResult = createResult{containerID: hexID("7"), volumeName: "elysian-db-11111111-1111-4111-8111-111111111111", started: false}
	fixture.docker.verifyRemovedErr = errors.New("engine unreachable")
	input := provisionInput("shop")
	input.ResourceTier, input.NetworkScope = "small", scopeContainerNet
	task, err := fixture.facade.SubmitProvision(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	done := waitProvision(t, fixture, task.ID)
	if done.State != "unknown" {
		t.Fatalf("回滚未回读确认时必须保持结果未知：%+v", done)
	}
	if rows, _ := fixture.registry.list(); len(rows) != 1 {
		t.Fatalf("结果未知时应保留待处理登记：%+v", rows)
	}
}

// 回读确认通过（容器与卷都已 404）才算「无业务变更」。
func TestSubmitProvisionDeclaresNoChangeOnlyAfterVerifiedRemoval(t *testing.T) {
	fixture := newProvisionFixture(t, nil, nil, mysqlImages("8.0"), ampleMemory())
	fixture.docker.createResult = createResult{containerID: hexID("7"), volumeName: "elysian-db-11111111-1111-4111-8111-111111111111", started: false}
	input := provisionInput("shop")
	input.ResourceTier, input.NetworkScope = "small", scopeContainerNet
	task, err := fixture.facade.SubmitProvision(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	done := waitProvision(t, fixture, task.ID)
	if done.State != "failed" || done.Effect != ProvisionEffectNoChange {
		t.Fatalf("回读确认的回滚应是无变更失败：%+v", done)
	}
}

// 受理后、任何变更之前的只读失败（登记读不到、清单读不到）是未派发失败：没有变更发生，
// 不应让运行进入结果未知的保护。
func TestSubmitProvisionClassifiesPreMutationReadFailuresAsNotDispatched(t *testing.T) {
	t.Run("复用路径登记读不到", func(t *testing.T) {
		fixture := newProvisionFixture(t, reusableMySQL, reusableMySQLRows, mysqlImages("8.0"), ampleMemory())
		// 受理前的核对一切正常；登记在 worker 取管理员凭据之后才开始失败。
		fixture.admin.inspectFn = func(context.Context, adminTarget, logicalPlan) (logicalExistence, error) {
			return logicalExistence{}, nil
		}
		fixture.admin.readyFn = func(context.Context, adminTarget) error {
			fixture.registry.broken = errors.New("registry unavailable")
			return nil
		}
		task, err := fixture.facade.SubmitProvision(context.Background(), provisionInput("shop"))
		if err != nil {
			t.Fatal(err)
		}
		done := waitProvision(t, fixture, task.ID)
		if done.State != "failed" || done.Effect != ProvisionEffectNotDispatched {
			t.Fatalf("变更前的只读失败应是未派发：%+v", done)
		}
	})
	t.Run("新建路径镜像清单读不到", func(t *testing.T) {
		fixture := newProvisionFixture(t, nil, nil, mysqlImages("8.0"), ampleMemory())
		// 受理前的决策要读一次镜像清单（成功）；worker 建实例时再读（失败）。
		listImages := 0
		fixture.facade.service.deps.listImages = func(context.Context) ([]contract.ContainerImage, error) {
			listImages++
			if listImages > 2 {
				return nil, errors.New("engine unreachable")
			}
			return mysqlImages("8.0"), nil
		}
		input := provisionInput("shop")
		input.ResourceTier, input.NetworkScope = "small", scopeContainerNet
		task, err := fixture.facade.SubmitProvision(context.Background(), input)
		if err != nil {
			t.Fatal(err)
		}
		done := waitProvision(t, fixture, task.ID)
		if done.State != "failed" || done.Effect != ProvisionEffectNotDispatched || len(fixture.docker.createCalls) != 0 {
			t.Fatalf("清单读不到时不得创建实例且应是未派发：%+v", done)
		}
	})
}

func writeUnknownProvision(t *testing.T, fixture *provisionFixture, engine, version string, writes ...provisionWrite) ProvisionTask {
	t.Helper()
	task := ProvisionTask{ID: provisionID(provisionRequest), RequestID: provisionRequest, Target: engine + "/" + version + "/shop",
		InstanceID: hexID("1"), Digest: "digest", State: ProvisionUnknown, ErrorCode: "database-provision-interrupted",
		Message: "原始未知回执", UpdatedAt: "2026-11-26T00:00:00Z", Writes: writes}
	raw, err := json.Marshal(task)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(fixture.facade.operationRoot, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(fixture.facade.operationRoot, task.ID+".json"), raw, 0600); err != nil {
		t.Fatal(err)
	}
	return task
}

func TestProvisionReconciliationIsReplayableWithoutOverwritingReceipt(t *testing.T) {
	for _, engine := range []string{engineMySQL, engineRedis} {
		t.Run(engine, func(t *testing.T) {
			row := registeredRow("row-1", engine, "8.0", hexID("1"))
			row.Logical = []logicalDatabaseRecord{{ID: "shop", Name: "shop", State: logicalStateActive, RequestID: provisionRequest,
				Users: []logicalUser{{Username: "shop_user", Password: "registered-secret"}}}}
			fixture := newProvisionFixture(t, nil, []databaseRecord{row}, nil, ampleMemory())
			task := writeUnknownProvision(t, fixture, engine, "8.0")
			fixture.admin.inspectFn = func(context.Context, adminTarget, logicalPlan) (logicalExistence, error) {
				return logicalExistence{Database: engine != engineRedis, User: true, PasswordMatches: true, PermissionsMatch: true}, nil
			}
			decision := ProvisionResolution{ID: "barrier", TaskID: task.ID, RequestID: task.RequestID, Target: task.Target,
				Digest: task.Digest, Decision: "confirmed-completed", Evidence: "只读回查"}
			if err := fixture.facade.ReconcileProvision(t.Context(), decision); err != nil {
				t.Fatal(err)
			}
			// Re-open only the domain ledger, as after a crash before the Harness commit.
			reopened := &AgentFacade{service: fixture.facade.service, operationRoot: fixture.facade.operationRoot}
			fixture.admin.inspectFn = func(context.Context, adminTarget, logicalPlan) (logicalExistence, error) {
				return logicalExistence{}, errors.New("回查现在不可用")
			}
			if err := reopened.ReconcileProvision(t.Context(), decision); err != nil {
				t.Fatal(err)
			}
			stored, err := reopened.InspectProvision(t.Context(), task.ID)
			if err != nil || stored.State != ProvisionUnknown || stored.Message != task.Message ||
				stored.Resolution == nil || provisionBlocks(stored) || ProvisionAgentReceipt(stored).Resolution != nil {
				t.Fatalf("核实必须保留原回执且解除域保护：%+v %v", stored, err)
			}
			decision.Evidence = "不同证据"
			if err := reopened.ReconcileProvision(t.Context(), decision); err == nil {
				t.Fatal("不同决定必须拒绝")
			}
		})
	}
}

func TestProvisionReconciliationRequiresEndedMutation(t *testing.T) {
	row := registeredRow("row-1", engineMySQL, "8.0", hexID("1"))
	row.Logical = []logicalDatabaseRecord{{ID: "shop", Name: "shop", State: logicalStatePending, RequestID: provisionRequest,
		Users: []logicalUser{{Username: "shop_user", Password: "registered-secret"}}}}
	for _, finished := range []bool{true, false} {
		fixture := newProvisionFixture(t, nil, []databaseRecord{row}, nil, ampleMemory())
		task := writeUnknownProvision(t, fixture, engineMySQL, "8.0", provisionWrite{Stage: "mysql-logical", Finished: finished})
		decision := ProvisionResolution{ID: "barrier", TaskID: task.ID, RequestID: task.RequestID, Target: task.Target,
			Digest: task.Digest, Decision: "confirmed-stopped", Evidence: "只读回查"}
		err := fixture.facade.ReconcileProvision(t.Context(), decision)
		if (err == nil) != finished {
			t.Fatalf("finished=%v: %v", finished, err)
		}
		stored, err := fixture.facade.InspectProvision(t.Context(), task.ID)
		if err != nil || provisionBlocks(stored) == finished || finished && stored.Resolution.Effect != ProvisionEffectNoChange {
			t.Fatalf("finished=%v: %+v %v", finished, stored, err)
		}
	}
}

func TestProvisionReportsPartialOnlyAfterConfirmedLogicalReadback(t *testing.T) {
	fixture := newProvisionFixture(t, reusableMySQL, reusableMySQLRows, mysqlImages("8.0"), ampleMemory())
	fixture.admin.logicalFn = func(context.Context, adminTarget, logicalPlan) error {
		return &logicalWriteEndedError{errors.New("逻辑库最后一步失败")}
	}
	fixture.admin.inspectFn = func(_ context.Context, _ adminTarget, plan logicalPlan) (logicalExistence, error) {
		if plan.password == "" {
			return logicalExistence{}, nil
		}
		return logicalExistence{Database: true, User: true, PasswordMatches: true}, nil
	}
	task, err := fixture.facade.SubmitProvision(t.Context(), provisionInput("shop"))
	if err != nil {
		t.Fatal(err)
	}
	if done := waitProvision(t, fixture, task.ID); done.State != ProvisionFailed || done.Effect != ProvisionEffectPartial {
		t.Fatalf("回读确认专属账号已创建时应返回部分完成：%+v", done)
	}
}

func TestProvisionTargetLeaseProtectsPageDeletionAndConcurrentReplay(t *testing.T) {
	fixture := newProvisionFixture(t, reusableMySQL, reusableMySQLRows, mysqlImages("8.0"), ampleMemory())
	f := fixture.facade
	f.service.deps.provisionMutation = f.BeginContainerMutation
	id := reusableMySQL[0].id
	ready, resume := make(chan struct{}), make(chan struct{})
	fixture.admin.readyFn = func(ctx context.Context, _ adminTarget) error {
		close(ready)
		select {
		case <-resume:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	t.Cleanup(func() { _ = f.Close(context.Background()) })
	pageRelease, err := f.BeginContainerMutation(t.Context(), id, "")
	if err != nil {
		t.Fatal(err)
	}
	preflight := make(chan struct{}, 2)
	fixture.admin.inspectFn = func(context.Context, adminTarget, logicalPlan) (logicalExistence, error) {
		select {
		case preflight <- struct{}{}:
		default:
		}
		return logicalExistence{}, nil
	}
	type result struct {
		task ProvisionTask
		err  error
	}
	submitted := make(chan result, 2)
	for range 2 {
		go func() {
			task, err := f.SubmitProvision(t.Context(), provisionInput("shop"))
			submitted <- result{task, err}
		}()
	}
	<-preflight
	<-preflight
	assertNoProvisionTask(t, fixture)
	pageRelease()
	first, second := <-submitted, <-submitted
	if first.err != nil || second.err != nil || first.task.ID == "" || first.task.ID != second.task.ID {
		t.Fatalf("并发重试应共用任务：%+v %+v", first, second)
	}
	<-ready
	if err := f.service.RemoveContainer(t.Context(), id); err == nil || len(fixture.docker.removeCalls) != 0 {
		t.Fatalf("部署期间页面不得删除容器：%v", err)
	}
	if _, err := f.BeginContainerMutation(t.Context(), "", first.task.InstanceName); err == nil {
		t.Fatal("按规范名请求也必须阻塞")
	}
	close(resume)
	if done := waitProvision(t, fixture, first.task.ID); done.State != ProvisionSucceeded || len(fixture.admin.logicalPlan) != 1 {
		t.Fatalf("只应执行一次部署：%+v", done)
	}
}

func TestProvisionRejectsPinnedVersionMismatch(t *testing.T) {
	fixture := newProvisionFixture(t, reusableMySQL, reusableMySQLRows, mysqlImages("8.0"), ampleMemory())
	input := provisionInput("shop")
	input.Instance, input.Version = reusableMySQL[0].id, "8.4"
	task, err := fixture.facade.SubmitProvision(t.Context(), input)
	if err == nil || task.ID != "" || !strings.Contains(err.Error(), "8.0") || !strings.Contains(err.Error(), "8.4") {
		t.Fatalf("错误版本须在受理前拒绝：%+v %v", task, err)
	}
	assertNoProvisionTask(t, fixture)
}

func TestProvisionCancellationDuringCreatePreservesUnknown(t *testing.T) {
	fixture := newProvisionFixture(t, nil, nil, mysqlImages("8.0"), ampleMemory())
	started, release := make(chan struct{}), make(chan struct{})
	fixture.docker.createFn = func(createInput) (createResult, error) {
		close(started)
		<-release
		return createResult{}, context.Canceled
	}
	input := provisionInput("shop")
	input.ResourceTier, input.NetworkScope = "small", scopeContainerNet
	task, err := fixture.facade.SubmitProvision(t.Context(), input)
	if err != nil {
		t.Fatal(err)
	}
	<-started
	err = fixture.facade.CancelProvision(t.Context(), task.ID, task.RequestID)
	close(release)
	if err != nil {
		t.Fatal(err)
	}
	done := waitProvision(t, fixture, task.ID)
	if done.State != ProvisionUnknown || !provisionBlocks(done) || done.Effect != "" {
		t.Fatalf("创建期间取消必须保留未知状态和保护：%+v", done)
	}
}
