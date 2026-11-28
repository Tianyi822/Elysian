package database

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"elysian/server/internal/contract"
	"elysian/server/internal/seam"
)

const legacyRegistryRow = `{"id":"row-1","engine":"MySQL","name":"db","versionTag":"8.0","containerId":"` + testContainerID + `","source":"managed","accessScope":"container-network","admin":{"username":"root","password":"admin"},"user":{"username":"","password":""},"createdAt":"2026-11-01T00:00:00.000Z","state":"active","containerName":"db"}`

func writeLegacyRegistry(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "databases.json")
	if err := os.WriteFile(path, []byte("["+legacyRegistryRow+"]"), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// 逻辑库与资源档位只在登记行末尾追加：旧文件照常读取，没有这两项的行写回时不出现对应的键。
func TestRegistryReadsLegacyRowsAndRoundTripsLogicalRecords(t *testing.T) {
	path := writeLegacyRegistry(t)
	registry := newFileDatabaseRegistry(path)
	rows, err := registry.list()
	if err != nil || len(rows) != 1 {
		t.Fatalf("旧登记应照常读取：%v %+v", err, rows)
	}
	if rows[0].Logical != nil || rows[0].ResourceTier != "" {
		t.Fatalf("旧登记不应带逻辑库或档位：%+v", rows[0])
	}
	if err := registry.put(rows[0]); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "logical") || strings.Contains(string(raw), "resourceTier") {
		t.Fatalf("没有逻辑库与档位的行写回时不得多出键：%s", raw)
	}

	logical := []logicalDatabaseRecord{{
		ID: "logical-1", Kind: logicalKindDatabase, Name: "shop",
		Users: []logicalUser{{Username: "shop_user", Password: "generated-secret", Host: "%"}},
		State: logicalStateActive, RequestID: strings.Repeat("a", 64), CreatedBy: logicalCreatedByAgent, CreatedAt: "2026-11-26T00:00:00.000Z",
	}}
	rows[0].Logical, rows[0].ResourceTier = logical, "small"
	if err := registry.put(rows[0]); err != nil {
		t.Fatal(err)
	}
	reloaded, err := registry.list()
	if err != nil || len(reloaded) != 1 {
		t.Fatalf("重新读取登记失败：%v", err)
	}
	if !reflect.DeepEqual(reloaded[0].Logical, logical) || reloaded[0].ResourceTier != "small" {
		t.Fatalf("逻辑库与档位应原样往返：%+v", reloaded[0])
	}
	// 旧字段保持原样：新字段不影响既有登记的读取。
	if reloaded[0].ID != "row-1" || reloaded[0].Admin.Username != "root" || reloaded[0].VolumeName != "" {
		t.Fatalf("旧字段被改写：%+v", reloaded[0])
	}
}

// 列表投影带出逻辑库（只有用户名，不含密码）与资源档位。
func TestListProjectsLogicalDatabasesWithoutPasswords(t *testing.T) {
	fixture := newServiceFixture(strings.Repeat("f", 64), []contract.Container{{ID: testContainerID, Name: "db", ImageRef: "mysql:8.0"}}, []databaseRecord{{
		ID: "row-1", Engine: engineMySQL, Name: "db", VersionTag: "8.0", ContainerID: testContainerID, Source: sourceManaged,
		AccessScope: scopeContainerNet, Admin: databaseSecret{Username: "root", Password: "admin"}, State: stateActive,
		CreatedAt: "2026-11-01T00:00:00.000Z", ContainerName: "db", ResourceTier: "small",
		Logical: []logicalDatabaseRecord{{
			ID: "logical-1", Kind: logicalKindDatabase, Name: "shop", Users: []logicalUser{{Username: "shop_user", Password: "never-projected", Host: "%"}},
			State: logicalStateActive, CreatedAt: "2026-11-26T00:00:00.000Z",
		}},
	}})
	fixture.docker.inspectFn = func(_ context.Context, id string) (map[string]any, error) {
		return containerBody(id, "mysql:8.0", true, map[string]string{"elysian.managed": "true"}, []string{"elysian-db-shared"}, nil, nil), nil
	}
	rows, err := fixture.service.List(context.Background())
	if err != nil || len(rows) != 1 {
		t.Fatalf("列表读取失败：%v", err)
	}
	raw, err := json.Marshal(rows[0])
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"resourceTier":"small"`, `"name":"shop"`, `"users":["shop_user"]`, `"kind":"database"`} {
		if !strings.Contains(string(raw), want) {
			t.Errorf("投影缺少 %s：%s", want, raw)
		}
	}
	if strings.Contains(string(raw), "never-projected") || strings.Contains(string(raw), "admin\"") && strings.Count(string(raw), `"password"`) != 1 {
		t.Fatalf("逻辑库用户的密码不得进入投影：%s", raw)
	}
}

func createScriptedDocker(t *testing.T, engine, version string) (*scriptedTransport, *dockerAPI) {
	t.Helper()
	transport := &scriptedTransport{responder: func(req seam.EngineRequest) seam.EngineResponse {
		if response, ok := existingDatabaseNetwork(req); ok {
			return response
		}
		if strings.HasSuffix(req.Path, "/volumes/create") {
			return seam.EngineResponse{Status: 201}
		}
		if strings.Contains(req.Path, "/containers/create") {
			return seam.EngineResponse{Status: 201, Body: []byte(`{"Id":"` + testContainerID + `"}`)}
		}
		return seam.EngineResponse{Status: 204}
	}}
	docker := newDockerAPI(transport, func(context.Context) ([]contract.ContainerImage, error) {
		return []contract.ContainerImage{{ID: testImageID, Name: engineRepository[engine], Tag: version, SizeMB: 100}}, nil
	})
	return transport, docker
}

func createBodyOf(t *testing.T, transport *scriptedTransport) map[string]any {
	t.Helper()
	for _, call := range transport.calls {
		if strings.Contains(call.Path, "/containers/create") {
			var body map[string]any
			if err := json.Unmarshal(call.Body, &body); err != nil {
				t.Fatal(err)
			}
			return body
		}
	}
	t.Fatal("未发起 containers/create 请求")
	return nil
}

// Agent 部署的受管实例带资源档位：上限写进 HostConfig，档位落到标签，供页面与发现工具回显。
func TestCreateAppliesResourceTierLimitsAndLabel(t *testing.T) {
	transport, docker := createScriptedDocker(t, engineMySQL, "8.0")
	if _, err := docker.create(context.Background(), createInput{
		engine: engineMySQL, versionTag: "8.0", imageID: testImageID, containerName: "mysql-db",
		accessScope: scopeContainerNet, bootstrapPwd: "admin-secret",
		tier: "small", memoryBytes: 512 << 20, nanoCpus: 500_000_000, pidsLimit: 256,
	}); err != nil {
		t.Fatalf("create 失败：%v", err)
	}
	body := createBodyOf(t, transport)
	host, _ := body["HostConfig"].(map[string]any)
	labels, _ := body["Labels"].(map[string]any)
	if memory, ok := host["Memory"].(float64); !ok || memory != 512<<20 {
		t.Errorf("内存上限未写入：%+v", host)
	}
	if cpus, ok := host["NanoCpus"].(float64); !ok || cpus != 500_000_000 {
		t.Errorf("CPU 上限未写入：%+v", host)
	}
	if pids, ok := host["PidsLimit"].(float64); !ok || pids != 256 {
		t.Errorf("进程数上限未写入：%+v", host)
	}
	if labels["elysian.database.tier"] != "small" {
		t.Errorf("档位标签缺失：%+v", labels)
	}
}

// 页面创建路径不带档位：HostConfig 保持原样，不出现上限字段与档位标签。
func TestCreateWithoutTierKeepsHostConfigUnlimited(t *testing.T) {
	transport, docker := createScriptedDocker(t, engineMySQL, "8.0")
	if _, err := docker.create(context.Background(), createInput{
		engine: engineMySQL, versionTag: "8.0", imageID: testImageID, containerName: "mysql-db",
		accessScope: scopeContainerNet, bootstrapPwd: "admin-secret",
	}); err != nil {
		t.Fatalf("create 失败：%v", err)
	}
	body := createBodyOf(t, transport)
	host, _ := body["HostConfig"].(map[string]any)
	labels, _ := body["Labels"].(map[string]any)
	for _, key := range []string{"Memory", "NanoCpus", "PidsLimit"} {
		if _, exists := host[key]; exists {
			t.Errorf("不带档位时不应出现 %s：%+v", key, host)
		}
	}
	if _, exists := labels["elysian.database.tier"]; exists {
		t.Errorf("不带档位时不应有档位标签：%+v", labels)
	}
}

// 按库与用户读取凭据只返回该逻辑库用户的密码；创建未确认的登记与不存在的名字都拒绝。
func TestRevealUserReturnsOnlyTheRequestedConfirmedLogicalUser(t *testing.T) {
	fixture := newServiceFixture("", nil, []databaseRecord{{
		ID: "row-1", Engine: engineMySQL, VersionTag: "8.0", ContainerID: testContainerID, Source: sourceManaged, State: stateActive,
		Admin:     databaseSecret{Username: "root", Password: "admin-secret"},
		CreatedAt: "2026-11-01T00:00:00.000Z",
		Logical: []logicalDatabaseRecord{
			{ID: "logical-shop", Kind: logicalKindDatabase, Name: "shop", Users: []logicalUser{{Username: "shop_user", Password: "shop-secret", Host: "%"}}, State: logicalStateActive},
			{ID: "logical-orders", Kind: logicalKindDatabase, Name: "orders", Users: []logicalUser{{Username: "orders_user", Password: "orders-secret", Host: "%"}}, State: logicalStatePending},
		},
	}})
	service := fixture.service
	secret, err := service.RevealUser(context.Background(), testContainerID, "shop", "shop_user")
	if err != nil || secret.Username != "shop_user" || secret.Password != "shop-secret" {
		t.Fatalf("应返回所请求的逻辑库用户凭据：%+v %v", secret, err)
	}
	if _, err := service.RevealUser(context.Background(), testContainerID, "orders", "orders_user"); err == nil || !strings.Contains(err.Error(), "尚未确认") {
		t.Fatalf("创建未确认的登记不得读取凭据：%v", err)
	}
	for _, target := range [][2]string{{"shop", "orders_user"}, {"reporting", "shop_user"}} {
		if _, err := service.RevealUser(context.Background(), testContainerID, target[0], target[1]); err == nil {
			t.Errorf("不存在的库或用户 %v 不得读取凭据", target)
		}
	}
	// 管理员凭据不能经逻辑库入口取得。
	if secret.Password == "admin-secret" {
		t.Fatal("逻辑库入口不得返回管理员密码")
	}
}
