package database

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"elysian/server/internal/contract"
	"elysian/server/internal/shared"
)

// adoptFixture 构造一个运行中的自装 MySQL 容器与假管理员执行面。
func adoptFixture(t *testing.T, running bool, engine string) (*databaseService, *fakeAdmin, *memoryDatabaseRegistry, *fakeDocker) {
	t.Helper()
	ref := engineRepository[engine] + ":8.0"
	if engine == engineRedis {
		ref = "redis:7.4"
	}
	service, docker, registry := newInstanceFixture([]instanceSpec{
		{id: hexID("2"), ref: ref, running: running},
	}, nil, []contract.ContainerImage{{ID: "sha256:" + hexID("a"), Name: engineRepository[engine], Tag: "8.0", SizeMB: 100}}, ampleMemory())
	admin := &fakeAdmin{}
	service.deps.admin = admin
	return service, admin, registry, docker
}

// adoptVerifyCalls 是核验次数（单次尝试，失败即凭据错误）。
func (f *fakeAdmin) verify(ctx context.Context, target adminTarget) error {
	f.verifyCalls++
	f.targets = append(f.targets, target)
	if f.verifyFn != nil {
		return f.verifyFn(ctx, target)
	}
	return nil
}

// 接管：先用给定凭据做一次只读核验，通过才登记；密码只进登记，不进投影。
func TestAdoptVerifiesCredentialsThenRegistersAdoptedInstance(t *testing.T) {
	service, admin, registry, _ := adoptFixture(t, true, engineMySQL)
	if _, err := service.Adopt(context.Background(), hexID("2"), "root", "given-admin-secret"); err != nil {
		t.Fatalf("凭据核验通过后应接管：%v", err)
	}
	if admin.verifyCalls != 1 || admin.targets[0].containerID != hexID("2") || admin.targets[0].engine != engineMySQL {
		t.Fatalf("接管前应以所给凭据核验一次：%+v", admin.targets)
	}
	if admin.targets[0].admin.Username != "root" || admin.targets[0].admin.Password != "given-admin-secret" {
		t.Fatal("核验必须使用用户填写的凭据")
	}
	rows, _ := registry.list()
	if len(rows) != 1 || rows[0].Source != sourceAdopted || rows[0].ContainerID != hexID("2") || rows[0].Admin.Password != "given-admin-secret" || rows[0].State != stateActive {
		t.Fatalf("应按接管来源登记：%+v", rows)
	}
	views, err := service.ListInstances(context.Background())
	if err != nil || len(views) != 1 || views[0].Ownership != instanceAdopted || !views[0].Reusable {
		t.Fatalf("接管后实例应可复用：%+v %v", views, err)
	}
	raw, _ := json.Marshal(views[0])
	if strings.Contains(string(raw), "given-admin-secret") {
		t.Fatalf("投影不得带出密码：%s", raw)
	}
}

// 凭据错误不留下任何登记，错误原因可用于页面提示。
func TestAdoptRejectsWrongCredentialsWithoutRegistering(t *testing.T) {
	service, admin, registry, _ := adoptFixture(t, true, engineMySQL)
	admin.verifyFn = func(context.Context, adminTarget) error {
		return errors.New("数据库实例在限定时间内未就绪")
	}
	_, err := service.Adopt(context.Background(), hexID("2"), "root", "wrong")
	var invalid *shared.InvalidRequestError
	if !errors.As(err, &invalid) || !strings.Contains(invalid.Message, "无法用该凭据登录") {
		t.Fatalf("凭据错误应说明无法登录：%v", err)
	}
	if rows, _ := registry.list(); len(rows) != 0 {
		t.Fatalf("失败不得留下登记：%+v", rows)
	}
}

// 只接受运行中的官方数据库容器：已停止、非官方镜像、已登记都拒绝。
func TestAdoptRejectsUnreachableOrWrongTargets(t *testing.T) {
	stopped, _, _, _ := adoptFixture(t, false, engineMySQL)
	if _, err := stopped.Adopt(context.Background(), hexID("2"), "root", "x"); err == nil || !strings.Contains(err.Error(), "未运行") {
		t.Fatalf("已停止容器不得接管：%v", err)
	}

	// 非官方数据库镜像：镜像仓库名不属于三类官方仓库。
	custom := newInstanceService([]instanceSpec{{id: hexID("3"), ref: "percona/percona-server:8.0", running: true}}, nil, nil, ampleMemory())
	custom.deps.admin = &fakeAdmin{}
	if _, err := custom.Adopt(context.Background(), hexID("3"), "root", "x"); err == nil || !strings.Contains(err.Error(), "官方") {
		t.Fatalf("非官方镜像不得接管：%v", err)
	}

	registered, admin, _, _ := adoptFixture(t, true, engineMySQL)
	registry := registered.deps.registry.(*memoryDatabaseRegistry)
	_ = registry.put(registeredRow("row-1", engineMySQL, "8.0", hexID("2")))
	if _, err := registered.Adopt(context.Background(), hexID("2"), "root", "x"); err == nil || !strings.Contains(err.Error(), "已登记") {
		t.Fatalf("已登记的实例不得重复接管：%v", err)
	}
	if admin.verifyCalls != 0 {
		t.Fatal("已登记的实例不应再核验凭据")
	}

	// 不存在的容器按 404 处理。
	if _, err := registered.Adopt(context.Background(), hexID("9"), "root", "x"); err == nil {
		t.Fatal("不存在的容器不得接管")
	}
}

// 解除接管只删登记，不动容器与数据；受管实例不能解除。
func TestReleaseAdoptionOnlyRemovesRegistration(t *testing.T) {
	service, _, registry, docker := adoptFixture(t, true, engineMySQL)
	if _, err := service.Adopt(context.Background(), hexID("2"), "root", "secret"); err != nil {
		t.Fatal(err)
	}
	if err := service.ReleaseAdoption(context.Background(), hexID("2")); err != nil {
		t.Fatalf("解除接管应成功：%v", err)
	}
	if rows, _ := registry.list(); len(rows) != 0 {
		t.Fatalf("解除接管应删掉登记：%+v", rows)
	}
	if len(docker.removeCalls) != 0 {
		t.Fatalf("解除接管不得删除容器：%v", docker.removeCalls)
	}

	managed := adoptFixture2(t)
	_ = managed.deps.registry.(*memoryDatabaseRegistry).put(registeredRow("row-1", engineMySQL, "8.0", hexID("2")))
	if err := managed.ReleaseAdoption(context.Background(), hexID("2")); err == nil || !strings.Contains(err.Error(), "受管") {
		t.Fatalf("受管实例不能解除接管：%v", err)
	}
}

func adoptFixture2(t *testing.T) *databaseService {
	t.Helper()
	service, _, _, _ := adoptFixture(t, true, engineMySQL)
	return service
}
