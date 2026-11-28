package database

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"elysian/server/internal/contract"
	"elysian/server/internal/seam"
	"elysian/server/internal/shared"
)

// agent_containers_test.go：容器接缝收缩为 Registered + Lifecycle 后的语义。
// Lifecycle 保留受管数据库容器 start/stop/restart 路由与 remove→removeContainer
// 的五元核验；Registered 供 exec 拦截。

// lifecycleFixture 组合真实 dockerAPI（脚本引擎）与共享服务。
type lifecycleFixture struct {
	service   *databaseService
	registry  *memoryDatabaseRegistry
	bridge    seam.AgentDatabaseContainers
	transport *scriptedTransport
}

func newLifecycleFixture(rows []databaseRecord, responder func(req seam.EngineRequest) seam.EngineResponse, containerID string) *lifecycleFixture {
	transport := &scriptedTransport{responder: responder}
	registry := newMemoryDatabaseRegistry(rows)
	service := newDatabaseService(serviceDeps{
		registry: registry,
		docker:   newDockerAPI(transport, func(context.Context) ([]contract.ContainerImage, error) { return testImageList(), nil }),
	})
	facade := &AgentFacade{service: service}
	return &lifecycleFixture{service: service, registry: registry, bridge: facade.ContainerBridge(func(context.Context) error { return nil }), transport: transport}
}

func managedRow(volume string) databaseRecord {
	return databaseRecord{ID: "db", Engine: engineMySQL, Name: "orders", VersionTag: "8.4", Source: sourceManaged,
		State: stateActive, ContainerID: testContainerID, VolumeName: volume, ContainerName: "mysql-main",
		Admin: databaseSecret{Username: "root", Password: "admin-secret"}, CreatedAt: "2026-09-28T09:00:00.000Z"}
}

// failingListRegistry 登记读取故障假件（其余方法委托原登记表）。
type failingListRegistry struct{ databaseRegistry }

func (r failingListRegistry) list() ([]databaseRecord, error) {
	return nil, errors.New("PRIVATE_REGISTRY_FAILURE")
}

func TestRegisteredReportsManagedContainers(t *testing.T) {
	rows := []databaseRecord{managedRow(stoppedManagedVolumeName)}
	fixture := newLifecycleFixture(rows, func(seam.EngineRequest) seam.EngineResponse { return seam.EngineResponse{Status: 200} }, testContainerID)
	registered, err := fixture.bridge.Registered(context.Background(), testContainerID)
	if err != nil || !registered {
		t.Fatalf("登记容器应报告 registered：%v %v", registered, err)
	}
	registered, err = fixture.bridge.Registered(context.Background(), strings.Repeat("9", 64))
	if err != nil || registered {
		t.Fatalf("未登记容器应报告 false：%v %v", registered, err)
	}
	broken := newLifecycleFixture(rows, func(seam.EngineRequest) seam.EngineResponse { return seam.EngineResponse{Status: 200} }, testContainerID)
	broken.service.deps.registry = failingListRegistry{broken.registry}
	if _, err := broken.bridge.Registered(context.Background(), testContainerID); err == nil {
		t.Fatal("登记读取失败应上抛")
	}
	facade := &AgentFacade{}
	if _, err := facade.ContainerBridge(nil).Registered(context.Background(), testContainerID); err == nil {
		t.Fatal("能力不可用应上抛")
	}
}

func TestLifecycleRoutesManagedDatabaseContainerActions(t *testing.T) {
	volume := stoppedManagedVolumeName
	// stop：运行中容器 → POST /stop → 复核为已停止。
	running := true
	stops, starts := 0, 0
	fixture := newLifecycleFixture([]databaseRecord{managedRow(volume)}, func(req seam.EngineRequest) seam.EngineResponse {
		switch {
		case req.Method == "GET" && strings.HasSuffix(req.Path, "/json"):
			body := baseInspectBody()
			body["State"] = map[string]any{"Running": running}
			obj(body["Config"])["Labels"] = map[string]any{"elysian.managed": "true", "elysian.database": "true", "elysian.database.engine": "MySQL", "elysian.database.version": "8.4", "elysian.database.volume": volume}
			raw, _ := json.Marshal(body)
			return seam.EngineResponse{Status: 200, Body: raw}
		case req.Method == "GET" && strings.Contains(req.Path, "/volumes/"):
			raw, _ := json.Marshal(map[string]any{"Labels": map[string]any{"elysian.database": "true", "elysian.database.engine": "MySQL", "elysian.database.version": "8.4"}})
			return seam.EngineResponse{Status: 200, Body: raw}
		case req.Method == "POST" && strings.HasSuffix(req.Path, "/stop"):
			stops++
			running = false
			return seam.EngineResponse{Status: 204}
		case req.Method == "POST" && strings.HasSuffix(req.Path, "/start"):
			starts++
			running = true
			return seam.EngineResponse{Status: 204}
		}
		return seam.EngineResponse{Status: 404}
	}, testContainerID)
	handled, err := fixture.bridge.Lifecycle(context.Background(), testContainerID, "stop")
	if err != nil || !handled {
		t.Fatalf("stop 路由失败：%v %v", handled, err)
	}
	if stops != 1 || starts != 0 {
		t.Fatalf("stop 应恰好发起一次 /stop：%d %d", stops, starts)
	}
	// start：已停止容器 → POST /start → 复核为运行中。
	running = false
	handled, err = fixture.bridge.Lifecycle(context.Background(), testContainerID, "start")
	if err != nil || !handled {
		t.Fatalf("start 路由失败：%v %v", handled, err)
	}
	if starts != 1 || stops != 1 {
		t.Fatalf("start 应恰好发起一次 /start：%d %d", starts, stops)
	}
}

func TestLifecycleRemoveRoutesThroughRemoveContainerWithVolumeChecks(t *testing.T) {
	volume := stoppedManagedVolumeName
	// 停止态受管容器与匹配卷：remove 走 removeManaged 全量五元核验。
	inspect := baseInspectBody()
	inspect["State"] = map[string]any{"Running": false}
	obj(inspect["Config"])["Labels"] = map[string]any{"elysian.managed": "true", "elysian.database": "true", "elysian.database.engine": "MySQL", "elysian.database.version": "8.4", "elysian.database.volume": volume}
	inspectRaw, _ := json.Marshal(inspect)
	volumeRaw, _ := json.Marshal(map[string]any{"Labels": map[string]any{"elysian.database": "true", "elysian.database.engine": "MySQL", "elysian.database.version": "8.4"}})
	fixture := newLifecycleFixture([]databaseRecord{managedRow(volume)}, func(req seam.EngineRequest) seam.EngineResponse {
		switch {
		case req.Method == "GET" && req.Path == "/containers/"+testContainerID+"/json":
			return seam.EngineResponse{Status: 200, Body: inspectRaw}
		case req.Method == "GET" && req.Path == "/volumes/"+volume:
			return seam.EngineResponse{Status: 200, Body: volumeRaw}
		case req.Method == "DELETE" && req.Path == "/containers/"+testContainerID:
			return seam.EngineResponse{Status: 204}
		case req.Method == "DELETE" && req.Path == "/volumes/"+volume:
			return seam.EngineResponse{Status: 204}
		}
		return seam.EngineResponse{Status: 404}
	}, testContainerID)
	handled, err := fixture.bridge.Lifecycle(context.Background(), testContainerID, "remove")
	if err != nil || !handled {
		t.Fatalf("remove 路由失败：%v %v", handled, err)
	}
	if kept, _ := fixture.registry.list(); len(kept) != 0 {
		t.Fatalf("容器删除后登记应清空：%+v", kept)
	}
	deletes := 0
	for _, call := range fixture.transport.calls {
		if call.Method == "DELETE" {
			deletes++
		}
	}
	if deletes != 2 {
		t.Fatalf("容器与专属卷应各删一次：%v", callPaths(fixture.transport.calls))
	}
}

func TestLifecycleForeignVolumeIdentityStillVerified(t *testing.T) {
	volume := stoppedManagedVolumeName
	// 卷标签不符：即使走容器接缝，五元核验失败仍拒绝删除，登记保留。
	inspect := baseInspectBody()
	inspect["State"] = map[string]any{"Running": false}
	obj(inspect["Config"])["Labels"] = map[string]any{"elysian.managed": "true", "elysian.database": "true", "elysian.database.engine": "MySQL", "elysian.database.version": "8.4", "elysian.database.volume": volume}
	inspectRaw, _ := json.Marshal(inspect)
	volumeRaw, _ := json.Marshal(map[string]any{"Labels": map[string]any{"elysian.database.engine": "MySQL"}})
	fixture := newLifecycleFixture([]databaseRecord{managedRow(volume)}, func(req seam.EngineRequest) seam.EngineResponse {
		switch {
		case req.Method == "GET" && req.Path == "/containers/"+testContainerID+"/json":
			return seam.EngineResponse{Status: 200, Body: inspectRaw}
		case req.Method == "GET" && req.Path == "/volumes/"+volume:
			return seam.EngineResponse{Status: 200, Body: volumeRaw}
		}
		return seam.EngineResponse{Status: 404}
	}, testContainerID)
	_, err := fixture.bridge.Lifecycle(context.Background(), testContainerID, "remove")
	var receipt *seam.AgentContainerError
	if !errors.As(err, &receipt) || receipt.NotDispatched || receipt.NoBusinessEffect || receipt.Code != "database-container-operation-failed" || receipt.Message != "数据库持久卷身份核对失败" {
		t.Fatalf("卷身份不符应保留固定失败原因：%+v %v", receipt, err)
	}
	if kept, _ := fixture.registry.list(); len(kept) != 1 {
		t.Fatal("失败路径不得清理登记")
	}
	for _, call := range fixture.transport.calls {
		if call.Method == "DELETE" {
			t.Fatalf("身份核对失败不得派发删除：%v", callPaths(fixture.transport.calls))
		}
	}
}

func TestLifecyclePreflightRefusalsAreNotDispatched(t *testing.T) {
	managed := managedRow(stoppedManagedVolumeName)
	sibling := managed
	sibling.ID, sibling.Name = "sibling", "archive"
	for _, tc := range []struct {
		name    string
		rows    []databaseRecord
		guard   error
		message string
		actions []string
	}{
		{"sibling", []databaseRecord{managed, sibling}, nil, "容器中还有其他已登记数据库，不能执行容器级操作", []string{"start", "stop", "restart", "remove"}},
		{"pending-operation", []databaseRecord{managed}, shared.InvalidRequest("此容器有进行中或结果未确认的操作，请先核实实际状态"), "此容器有进行中或结果未确认的操作，请先核实实际状态", []string{"start", "stop", "restart", "remove"}},
	} {
		for _, action := range tc.actions {
			t.Run(tc.name+"/"+action, func(t *testing.T) {
				fixture := newLifecycleFixture(tc.rows, func(req seam.EngineRequest) seam.EngineResponse {
					return seam.EngineResponse{Status: 200, Body: []byte(`{}`)}
				}, testContainerID)
				fixture.service.operationGuard = func(context.Context, string, string, string) error { return tc.guard }
				before, _ := fixture.registry.list()
				handled, err := fixture.bridge.Lifecycle(context.Background(), managed.ContainerID, action)
				var rejected *seam.AgentContainerError
				if !handled || !errors.As(err, &rejected) || !rejected.NotDispatched || rejected.NoBusinessEffect || rejected.Code != "database-container-operation-failed" || rejected.Message != tc.message+"，数据库变更未执行" {
					t.Fatalf("预检拒绝失去执行事实：handled=%v receipt=%+v err=%v", handled, rejected, err)
				}
				after, err := fixture.registry.list()
				if err != nil || len(after) != len(before) || len(fixture.transport.calls) > 0 {
					t.Fatal("预检拒绝不得改动数据库")
				}
			})
		}
	}
}

func TestLifecycleGuardFailureDoesNotClaimPreflightRejection(t *testing.T) {
	fixture := newLifecycleFixture([]databaseRecord{managedRow(stoppedManagedVolumeName)}, func(req seam.EngineRequest) seam.EngineResponse {
		return seam.EngineResponse{Status: 200, Body: []byte(`{}`)}
	}, testContainerID)
	fixture.service.operationGuard = func(context.Context, string, string, string) error { return errors.New("PRIVATE_TASK_STORAGE_FAILURE") }
	handled, err := fixture.bridge.Lifecycle(context.Background(), testContainerID, "stop")
	var failure *seam.AgentContainerError
	if !handled || !errors.As(err, &failure) || failure.NotDispatched || failure.NoBusinessEffect || strings.Contains(failure.Message, "PRIVATE") {
		t.Fatalf("存储故障不得伪装成可纠正拒绝：handled=%v receipt=%+v err=%v", handled, failure, err)
	}
}

func TestLifecycleUnregisteredContainerFallsThrough(t *testing.T) {
	fixture := newLifecycleFixture(nil, func(req seam.EngineRequest) seam.EngineResponse { return seam.EngineResponse{Status: 200} }, testContainerID)
	handled, err := fixture.bridge.Lifecycle(context.Background(), testContainerID, "start")
	if handled || err != nil {
		t.Fatalf("非数据库容器应交回 docker 域：handled=%v err=%v", handled, err)
	}
	if len(fixture.transport.calls) != 0 {
		t.Fatal("落空路由不得发起引擎请求")
	}
}
