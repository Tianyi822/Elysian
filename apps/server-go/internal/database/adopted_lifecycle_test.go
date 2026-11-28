package database

import (
	"context"
	"errors"
	"strings"
	"testing"

	"elysian/server/internal/seam"
	"elysian/server/internal/shared"
)

// 接管后的自装容器没有面板的五元标签与专属卷，但仍可经数据库域启停；
// 删除必须先解除接管，容器内任意命令继续拒绝。

func adoptedLifecycleRow() databaseRecord {
	return databaseRecord{ID: "adopted-1", Engine: engineMySQL, Name: "mysql-external", VersionTag: "8.4",
		Source: sourceAdopted, State: stateActive, ContainerID: testContainerID, ContainerName: "mysql-external",
		Admin: databaseSecret{Username: "root", Password: "given-secret"}, CreatedAt: "2026-11-26T00:00:00.000Z"}
}

// adoptedInspect 是自装容器的 inspect 应答：只有官方镜像与状态，没有面板标签与专属卷。
func adoptedInspect(running bool) seam.EngineResponse {
	status := "false"
	if running {
		status = "true"
	}
	body := `{"Id":"` + testContainerID + `","Name":"/mysql-external","State":{"Running":` + status + `},"Image":"sha256:` + hexID("b") + `","Config":{"Image":"mysql:8.4","Labels":{}},"Mounts":[]}`
	return seam.EngineResponse{Status: 200, Body: []byte(body)}
}

func TestAdoptedInstancePowerIsAllowedWithoutPanelLabels(t *testing.T) {
	for _, action := range []string{"start", "stop", "restart"} {
		t.Run(action, func(t *testing.T) {
			running := action != "start" // 除 start 外都从运行中开始
			requests := []string{}
			fixture := newLifecycleFixture([]databaseRecord{adoptedLifecycleRow()}, func(req seam.EngineRequest) seam.EngineResponse {
				switch {
				case req.Method == "GET" && strings.HasSuffix(req.Path, "/json"):
					return adoptedInspect(running)
				case req.Method == "POST" && strings.HasSuffix(req.Path, "/start"):
					running = true
				case req.Method == "POST" && strings.HasSuffix(req.Path, "/stop"):
					running = false
				}
				requests = append(requests, req.Method+" "+req.Path)
				return seam.EngineResponse{Status: 204}
			}, testContainerID)
			handled, err := fixture.bridge.Lifecycle(context.Background(), testContainerID, action)
			if !handled || err != nil {
				t.Fatalf("接管后应允许 %s：handled=%v err=%v requests=%v", action, handled, err, requests)
			}
			want := "POST /containers/" + testContainerID + "/" + action
			if action == "restart" {
				want = "POST /containers/" + testContainerID + "/start"
			}
			found := false
			for _, request := range requests {
				found = found || request == want
			}
			if !found {
				t.Fatalf("%s 应派发 %s：%v", action, want, requests)
			}
		})
	}
}

func TestAdoptedInstanceRemovePointsToReleaseAdoption(t *testing.T) {
	fixture := newLifecycleFixture([]databaseRecord{adoptedLifecycleRow()}, func(req seam.EngineRequest) seam.EngineResponse {
		return adoptedInspect(true)
	}, testContainerID)
	handled, err := fixture.bridge.Lifecycle(context.Background(), testContainerID, "remove")
	var rejected *seam.AgentContainerError
	if !handled || !errors.As(err, &rejected) || !rejected.NotDispatched || !strings.Contains(rejected.Message, "解除接管") {
		t.Fatalf("接管容器删除应提示先解除接管：handled=%v %v", handled, err)
	}
	for _, call := range fixture.transport.calls {
		if call.Method == "DELETE" {
			t.Fatal("拒绝时不得派发删除")
		}
	}
}

// 受管实例的删除与启停语义不变。
func TestManagedLifecycleStillRequiresPanelOwnership(t *testing.T) {
	fixture := newLifecycleFixture([]databaseRecord{managedRow(stoppedManagedVolumeName)}, func(req seam.EngineRequest) seam.EngineResponse {
		return seam.EngineResponse{Status: 200, Body: []byte(`{}`)}
	}, testContainerID)
	rows, _ := fixture.registry.list()
	if rows[0].Source != sourceManaged {
		t.Fatal("夹具应为受管实例")
	}
	// 受管实例缺专属卷标签时，启停仍按五元核验拒绝（身份不完整）。
	fixture.service.operationGuard = func(context.Context, string, string, string) error {
		return shared.InvalidRequest("此容器有进行中或结果未确认的操作，请先核实实际状态")
	}
	_, err := fixture.bridge.Lifecycle(context.Background(), testContainerID, "start")
	var rejected *seam.AgentContainerError
	if !errors.As(err, &rejected) || !rejected.NotDispatched {
		t.Fatalf("受管实例的预检拒绝语义不变：%v", err)
	}
}

// 实例上有进行中或结果未知的部署时，容器级操作与解除接管都要先等部署核实：
// 启停会打断部署，解除接管会让在途部署失去管理员凭据。
func TestLifecycleAndReleaseAdoptionRespectInFlightProvisions(t *testing.T) {
	fixture := newLifecycleFixture([]databaseRecord{adoptedLifecycleRow()}, func(req seam.EngineRequest) seam.EngineResponse {
		return adoptedInspect(true)
	}, testContainerID)
	fixture.service.deps.provisionMutation = func(_ context.Context, containerID, _ string) (func(), error) {
		return nil, shared.Conflict("该实例已有进行中或结果未确认的部署，请先核实部署结果")
	}
	for _, action := range []string{"start", "stop", "remove"} {
		handled, err := fixture.bridge.Lifecycle(context.Background(), testContainerID, action)
		var rejected *seam.AgentContainerError
		if !handled || !errors.As(err, &rejected) || !rejected.NotDispatched || !strings.Contains(rejected.Message, "部署") {
			t.Errorf("%s 应先核实在途部署：handled=%v err=%v", action, handled, err)
		}
	}
	if err := fixture.service.ReleaseAdoption(context.Background(), testContainerID); err == nil || !strings.Contains(err.Error(), "部署") {
		t.Fatalf("解除接管应先核实在途部署：%v", err)
	}
}
