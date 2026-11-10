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

// databaseDocker.test.ts 对等测试：Redis ACL 命令不含明文、detach 幂等矩阵、
// 三种 accessScope 的真实 Docker 配置。

const (
	testContainerID  = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	testImageID      = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	testImageIDBare  = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	testVolumePrefix = "/v1.41/volumes/create"
)

// scriptedTransport 按路径脚本应答并记录调用的假传输器。
type scriptedTransport struct {
	calls     []seam.EngineRequest
	responder func(req seam.EngineRequest) seam.EngineResponse
}

func (t *scriptedTransport) Request(ctx context.Context, req seam.EngineRequest) (seam.EngineResponse, error) {
	t.calls = append(t.calls, req)
	return t.responder(req), nil
}

func (t *scriptedTransport) Stream(context.Context, seam.EngineRequest, func([]byte)) (seam.EngineResponse, error) {
	return seam.EngineResponse{}, errors.New("本测试不使用流式请求")
}

// existingDatabaseNetwork 让不关心建网的测试把两张面板数据库网络应答为已存在。
func existingDatabaseNetwork(req seam.EngineRequest) (seam.EngineResponse, bool) {
	if req.Method == "GET" && (req.Path == "/networks/"+networkDBSharedName || req.Path == "/networks/"+networkDBPrivateName) {
		return seam.EngineResponse{Status: 200, Body: []byte(`{"Name":"` + strings.TrimPrefix(req.Path, "/networks/") + `"}`)}, true
	}
	return seam.EngineResponse{}, false
}

// baseInspectInspect 构造运行中 MySQL 容器的 inspect 应答体。
func baseInspectBody() map[string]any {
	return map[string]any{
		"Id":    testContainerID,
		"State": map[string]any{"Running": true},
		"Config": map[string]any{
			"Image":  "mysql:8.4",
			"Labels": map[string]any{},
		},
		"NetworkSettings": map[string]any{
			"Networks": map[string]any{
				"elysian-db-local": map[string]any{"IPAddress": "172.28.0.5"},
			},
		},
		"Image": testImageID,
		"Mounts": []any{
			map[string]any{"Type": "volume", "Name": "elysian-db-00000000-0000-0000-0000-000000000000"},
		},
	}
}

func testImageList() []contract.ContainerImage {
	return []contract.ContainerImage{{
		// id 与 TS listImages 投影同形（带 sha256: 前缀）；assertEngine 侧按裸 hex 宽松比对。
		ID: testImageID, Name: "mysql", Tag: "8.4", Digest: testImageIDBare, SizeMB: 100, PulledAt: nil,
	}}
}

func TestValidDatabaseVersionAndImageMatches(t *testing.T) {
	if !validDatabaseVersion("8.4") {
		t.Fatal("validDatabaseVersion('8.4') 应为 true")
	}
	if validDatabaseVersion("latest") {
		t.Fatal("validDatabaseVersion('latest') 应为 false")
	}
	if validDatabaseVersion("8.4;rm") {
		t.Fatal("validDatabaseVersion('8.4;rm') 应为 false")
	}
	if !imageMatches("MySQL", "mysql") {
		t.Fatal("imageMatches(MySQL, mysql) 应为 true")
	}
	if imageMatches("MySQL", "attacker/mysql") {
		t.Fatal("imageMatches(MySQL, attacker/mysql) 应为 false")
	}
}

func TestRedisCreateWritesACLFileWithoutPlaintextPasswords(t *testing.T) {
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
		return []contract.ContainerImage{{ID: testImageID, Name: "redis", Tag: "7.4", SizeMB: 100}}, nil
	})
	result, err := docker.create(context.Background(), createInput{
		engine: engineRedis, versionTag: "7.4", imageID: testImageID, containerName: "redis-db",
		accessScope: scopeContainerNet, bootstrapPwd: "admin-secret",
		ordinaryUser: databaseSecret{Username: "reader", Password: "reader-secret-123"},
	})
	if err != nil {
		t.Fatalf("create 失败：%v", err)
	}
	if !result.started {
		t.Fatal("Redis 容器应视为已启动")
	}
	var createBody map[string]any
	for _, call := range transport.calls {
		if strings.Contains(call.Path, "/containers/create") {
			if json.Unmarshal(call.Body, &createBody) != nil {
				t.Fatal("containers/create 请求体解析失败")
			}
		}
	}
	if createBody == nil {
		t.Fatal("未发起 containers/create 请求")
	}
	cmd, _ := createBody["Cmd"].([]any)
	var joined strings.Builder
	for _, item := range cmd {
		text, _ := item.(string)
		joined.WriteString(text)
		joined.WriteString(" ")
	}
	if !strings.Contains(joined.String(), "/data/users.acl") {
		t.Fatalf("Cmd 应写 /data/users.acl，实际：%s", joined.String())
	}
	hostConfig, _ := createBody["HostConfig"].(map[string]any)
	mounts, _ := hostConfig["Mounts"].([]any)
	firstMount, _ := mounts[0].(map[string]any)
	if target, _ := firstMount["Target"].(string); target != "/data" {
		t.Fatalf("Redis 挂载目标应为 /data，实际 %s", target)
	}
	if strings.Contains(string(createBodyText(createBody)), "reader-secret-123") ||
		strings.Contains(string(createBodyText(createBody)), "admin-secret") {
		t.Fatal("容器配置不得含明文密码")
	}
}

func createBodyText(body map[string]any) []byte {
	data, _ := json.Marshal(body)
	return data
}

func TestDetachIdempotenceMatrix(t *testing.T) {
	newFixture := func(networks map[string]any, inspectStatus, disconnectStatus int) (*dockerAPI, *scriptedTransport) {
		transport := &scriptedTransport{responder: func(req seam.EngineRequest) seam.EngineResponse {
			if strings.HasSuffix(req.Path, "/json") {
				body := baseInspectBody()
				if inspectStatus != 0 && inspectStatus != 200 {
					return seam.EngineResponse{Status: inspectStatus}
				}
				if networks != nil {
					body["NetworkSettings"] = map[string]any{"Networks": networks}
				}
				data, _ := json.Marshal(body)
				return seam.EngineResponse{Status: 200, Body: data}
			}
			if strings.HasSuffix(req.Path, "/disconnect") {
				return seam.EngineResponse{Status: disconnectStatus}
			}
			return seam.EngineResponse{Status: 204}
		}}
		return newDockerAPI(transport, func(context.Context) ([]contract.ContainerImage, error) { return nil, nil }), transport
	}

	t.Run("容器不在该网络上时不发起 disconnect", func(t *testing.T) {
		docker, transport := newFixture(nil, 0, 0)
		if err := docker.detach(context.Background(), testContainerID, networkDBSharedName); err != nil {
			t.Fatalf("detach 应幂等成功：%v", err)
		}
		for _, call := range transport.calls {
			if strings.HasSuffix(call.Path, "/disconnect") {
				t.Fatal("不应发起 disconnect")
			}
		}
	})

	t.Run("容器在该网络上时 POST 断开且 body 只含容器 ID", func(t *testing.T) {
		docker, transport := newFixture(map[string]any{
			"elysian-db-shared": map[string]any{"IPAddress": "172.28.0.9"},
		}, 0, 204)
		if err := docker.detach(context.Background(), testContainerID, networkDBSharedName); err != nil {
			t.Fatalf("detach 失败：%v", err)
		}
		found := false
		for _, call := range transport.calls {
			if strings.HasSuffix(call.Path, "/disconnect") {
				found = true
				// seam.EngineRequest.Path 不含版本前缀（seam.go 契约）。
				if call.Method != "POST" || call.Path != "/networks/elysian-db-shared/disconnect" {
					t.Fatalf("disconnect 请求形态不符：%s %s", call.Method, call.Path)
				}
				var body map[string]any
				if json.Unmarshal(call.Body, &body) != nil || len(body) != 1 || body["Container"] != testContainerID {
					t.Fatalf("disconnect body 应只含 Container=%s，实际 %s", testContainerID, call.Body)
				}
			}
		}
		if !found {
			t.Fatal("未发起 disconnect")
		}
	})

	t.Run("容器已被外部删除视为已离网", func(t *testing.T) {
		docker, transport := newFixture(nil, 404, 0)
		if err := docker.detach(context.Background(), testContainerID, networkDBSharedName); err != nil {
			t.Fatalf("inspect 404 应幂等返回：%v", err)
		}
		for _, call := range transport.calls {
			if strings.HasSuffix(call.Path, "/disconnect") {
				t.Fatal("不应发起 disconnect")
			}
		}
	})

	t.Run("disconnect 非 2xx 时抛 409", func(t *testing.T) {
		docker, _ := newFixture(map[string]any{
			"elysian-db-shared": map[string]any{"IPAddress": "172.28.0.9"},
		}, 0, 500)
		err := docker.detach(context.Background(), testContainerID, networkDBSharedName)
		var invalid *shared.InvalidRequestError
		if !errors.As(err, &invalid) || invalid.Status != 409 || invalid.Message != "无法将数据库容器移出面板网络" {
			t.Fatalf("应抛 409「无法将数据库容器移出面板网络」，实际 %v", err)
		}
	})

	t.Run("网络名不在白名单时抛 400 且零请求", func(t *testing.T) {
		docker, transport := newFixture(nil, 0, 0)
		err := docker.detach(context.Background(), testContainerID, "bridge")
		var invalid *shared.InvalidRequestError
		if !errors.As(err, &invalid) || invalid.Status != 400 || invalid.Message != "数据库网络无效" {
			t.Fatalf("应抛 400「数据库网络无效」，实际 %v", err)
		}
		if len(transport.calls) != 0 {
			t.Fatal("不应发起任何引擎请求")
		}
	})
}

func TestCreateAccessScopeDockerConfig(t *testing.T) {
	cases := []struct {
		scope        string
		hostIP       string
		network      string
		hostPort     *int
		expectBindIP string
	}{
		{scopeLocalhost, "127.0.0.1", networkDBPrivateName, nil, "127.0.0.1"},
		{scopeContainerNet, "", networkDBSharedName, nil, ""},
		{scopeAnyHost, "0.0.0.0", networkDBSharedName, intPtr(43306), "0.0.0.0"},
	}
	for _, testCase := range cases {
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
			return testImageList(), nil
		})
		result, err := docker.create(context.Background(), createInput{
			engine: engineMySQL, versionTag: "8.4", imageID: testImageID,
			containerName: "test-" + testCase.scope, accessScope: testCase.scope,
			hostPort: testCase.hostPort, bootstrapPwd: "bootstrap-secret",
			ordinaryUser: databaseSecret{Username: "reader", Password: "strong-password-123"},
		})
		if err != nil {
			t.Fatalf("create(%s) 失败：%v", testCase.scope, err)
		}
		if result.containerID != testContainerID || !result.started {
			t.Fatalf("create(%s) 结果不符：%+v", testCase.scope, result)
		}
		var volumePath, createPath string
		var createBody map[string]any
		for _, call := range transport.calls {
			if strings.HasSuffix(call.Path, "/volumes/create") {
				volumePath = call.Path
			}
			if strings.Contains(call.Path, "/containers/create") {
				createPath = call.Path
				if json.Unmarshal(call.Body, &createBody) != nil {
					t.Fatal("create body 解析失败")
				}
			}
		}
		if volumePath == "" || createPath == "" {
			t.Fatalf("create(%s) 未发起卷与容器请求", testCase.scope)
		}
		hostConfig, _ := createBody["HostConfig"].(map[string]any)
		if networkMode, _ := hostConfig["NetworkMode"].(string); networkMode != testCase.network {
			t.Fatalf("create(%s) NetworkMode 应为 %s，实际 %s", testCase.scope, testCase.network, networkMode)
		}
		mounts, _ := hostConfig["Mounts"].([]any)
		firstMount, _ := mounts[0].(map[string]any)
		if target, _ := firstMount["Target"].(string); target != "/var/lib/mysql" {
			t.Fatalf("create(%s) 挂载目标应为 /var/lib/mysql", testCase.scope)
		}
		if source, _ := firstMount["Source"].(string); source != result.volumeName {
			t.Fatalf("create(%s) 卷名即 Source 应为 %s，实际 %s", testCase.scope, result.volumeName, source)
		}
		bindings, _ := hostConfig["PortBindings"].(map[string]any)
		if testCase.expectBindIP == "" {
			if bindings != nil {
				t.Fatalf("create(%s) 不应有 PortBindings", testCase.scope)
			}
			continue
		}
		rows, _ := bindings["3306/tcp"].([]any)
		binding, _ := rows[0].(map[string]any)
		if hostIP, _ := binding["HostIp"].(string); hostIP != testCase.expectBindIP {
			t.Fatalf("create(%s) HostIp 应为 %s，实际 %s", testCase.scope, testCase.expectBindIP, hostIP)
		}
		if testCase.scope == scopeAnyHost {
			if hostPort, _ := binding["HostPort"].(string); hostPort != "43306" {
				t.Fatalf("create(any-host) HostPort 应为 43306，实际 %s", hostPort)
			}
		}
	}
}

func intPtr(value int) *int { return &value }

func TestDatabaseUsesActualPanelReservedPorts(t *testing.T) {
	docker := newDockerAPI(nil, func(context.Context) ([]contract.ContainerImage, error) { return nil, nil }, []int{22, 49000, 49001})
	for _, port := range []int{49000, 49001, 48100} {
		_, err := docker.create(context.Background(), createInput{engine: engineMySQL, versionTag: "8.4", imageID: testImageID, containerName: "check-port", accessScope: scopeAnyHost, hostPort: &port})
		if err == nil {
			t.Fatal("没有镜像应失败")
		}
		reserved := strings.Contains(err.Error(), "被面板保留")
		if reserved != (port != 48100) {
			t.Fatalf("端口 %d 的保护错误：%v", port, err)
		}
	}
}

func TestCreateStartFailureMapsEngineReasonLocally(t *testing.T) {
	cases := []struct {
		name       string
		startBody  string
		wantReason string
	}{
		{"缺网映射为本地固定文案", `{"message":"failed to set up container networking: network elysian-db-shared not found"}`, "面板数据库网络 elysian-db-shared 不存在"},
		{"未识别形态不编造原因", `{"message":"upstream text ENGINE_PRIVATE_TEXT"}`, ""},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			transport := &scriptedTransport{responder: func(req seam.EngineRequest) seam.EngineResponse {
				if response, ok := existingDatabaseNetwork(req); ok {
					return response
				}
				switch {
				case strings.HasSuffix(req.Path, "/volumes/create"):
					return seam.EngineResponse{Status: 201}
				case strings.Contains(req.Path, "/containers/create"):
					return seam.EngineResponse{Status: 201, Body: []byte(`{"Id":"` + testContainerID + `"}`)}
				case strings.HasSuffix(req.Path, "/start"):
					return seam.EngineResponse{Status: 500, Body: []byte(testCase.startBody)}
				}
				return seam.EngineResponse{Status: 204}
			}}
			docker := newDockerAPI(transport, func(context.Context) ([]contract.ContainerImage, error) {
				return testImageList(), nil
			})
			result, err := docker.create(context.Background(), createInput{
				engine: engineMySQL, versionTag: "8.4", imageID: testImageID, containerName: "mysql-db",
				accessScope: scopeContainerNet, bootstrapPwd: "bootstrap-secret",
				ordinaryUser: databaseSecret{Username: "reader", Password: "strong-password-123"},
			})
			if err != nil {
				t.Fatalf("启动失败不应成为创建错误，容器与登记要留在原地：%v", err)
			}
			if result.started || result.containerID != testContainerID {
				t.Fatalf("create 结果不符：%+v", result)
			}
			if result.startFailure != testCase.wantReason {
				t.Fatalf("startFailure 应为 %q，实际 %q", testCase.wantReason, result.startFailure)
			}
			if strings.Contains(result.startFailure, "failed to set up") || strings.Contains(result.startFailure, "ENGINE_PRIVATE_TEXT") {
				t.Fatalf("不得回显 Engine 正文：%q", result.startFailure)
			}
		})
	}
}

func TestCreateEnsuresMissingDatabaseNetworkBeforeContainer(t *testing.T) {
	transport := &scriptedTransport{responder: func(req seam.EngineRequest) seam.EngineResponse {
		switch {
		case req.Method == "GET" && req.Path == "/networks/"+networkDBSharedName:
			return seam.EngineResponse{Status: 404}
		case req.Method == "POST" && req.Path == "/networks/create":
			return seam.EngineResponse{Status: 201, Body: []byte(`{"Id":"net-1","Warning":""}`)}
		case strings.HasSuffix(req.Path, "/volumes/create"):
			return seam.EngineResponse{Status: 201}
		case strings.Contains(req.Path, "/containers/create"):
			return seam.EngineResponse{Status: 201, Body: []byte(`{"Id":"` + testContainerID + `"}`)}
		}
		return seam.EngineResponse{Status: 204}
	}}
	docker := newDockerAPI(transport, func(context.Context) ([]contract.ContainerImage, error) {
		return testImageList(), nil
	})
	result, err := docker.create(context.Background(), createInput{
		engine: engineMySQL, versionTag: "8.4", imageID: testImageID, containerName: "mysql-db",
		accessScope: scopeContainerNet, bootstrapPwd: "bootstrap-secret",
		ordinaryUser: databaseSecret{Username: "reader", Password: "strong-password-123"},
	})
	if err != nil || !result.started || result.startFailure != "" {
		t.Fatalf("缺网时应在建容器前补网吧，实际 err=%v result=%+v", err, result)
	}
	networkCreate, containerCreate := -1, -1
	for index, call := range transport.calls {
		if call.Method == "POST" && call.Path == "/networks/create" && networkCreate < 0 {
			networkCreate = index
		}
		if strings.Contains(call.Path, "/containers/create") {
			containerCreate = index
		}
	}
	if networkCreate < 0 {
		t.Fatalf("未发起网络创建，调用序列：%v", callPaths(transport.calls))
	}
	if networkCreate > containerCreate {
		t.Fatalf("网络必须在容器创建前就绪：networkCreate=%d containerCreate=%d 序列=%v", networkCreate, containerCreate, callPaths(transport.calls))
	}
	var body map[string]any
	if json.Unmarshal(transport.calls[networkCreate].Body, &body) != nil {
		t.Fatal("网络创建体解析失败")
	}
	if body["Name"] != networkDBSharedName || body["Driver"] != "bridge" {
		t.Fatalf("网络创建参数应与 compose 与 dev-check.sh 同形，实际 %v", body)
	}
}

func TestCreateDoesNotRecreateExistingDatabaseNetwork(t *testing.T) {
	transport := &scriptedTransport{responder: func(req seam.EngineRequest) seam.EngineResponse {
		switch {
		case req.Method == "GET" && req.Path == "/networks/"+networkDBPrivateName:
			return seam.EngineResponse{Status: 200, Body: []byte(`{"Name":"` + networkDBPrivateName + `"}`)}
		case strings.HasSuffix(req.Path, "/volumes/create"):
			return seam.EngineResponse{Status: 201}
		case strings.Contains(req.Path, "/containers/create"):
			return seam.EngineResponse{Status: 201, Body: []byte(`{"Id":"` + testContainerID + `"}`)}
		}
		return seam.EngineResponse{Status: 204}
	}}
	docker := newDockerAPI(transport, func(context.Context) ([]contract.ContainerImage, error) {
		return testImageList(), nil
	})
	result, err := docker.create(context.Background(), createInput{
		engine: engineMySQL, versionTag: "8.4", imageID: testImageID, containerName: "mysql-db",
		accessScope: scopeLocalhost, bootstrapPwd: "bootstrap-secret",
		ordinaryUser: databaseSecret{Username: "reader", Password: "strong-password-123"},
	})
	if err != nil || !result.started {
		t.Fatalf("localhost 创建失败：%v %+v", err, result)
	}
	for _, call := range transport.calls {
		if call.Method == "POST" && call.Path == "/networks/create" {
			t.Fatalf("网络已存在时不得重复创建，调用序列：%v", callPaths(transport.calls))
		}
	}
}

func TestAttachEnsuresMissingDatabaseNetwork(t *testing.T) {
	transport := &scriptedTransport{responder: func(req seam.EngineRequest) seam.EngineResponse {
		switch {
		case strings.HasSuffix(req.Path, "/json"):
			body, _ := json.Marshal(baseInspectBody())
			return seam.EngineResponse{Status: 200, Body: body}
		case req.Method == "GET" && req.Path == "/networks/"+networkDBSharedName:
			return seam.EngineResponse{Status: 404}
		case req.Method == "POST" && req.Path == "/networks/create":
			return seam.EngineResponse{Status: 201, Body: []byte(`{"Id":"net-1","Warning":""}`)}
		case req.Method == "POST" && req.Path == "/networks/"+networkDBSharedName+"/connect":
			return seam.EngineResponse{Status: 200}
		}
		return seam.EngineResponse{Status: 204}
	}}
	docker := newDockerAPI(transport, func(context.Context) ([]contract.ContainerImage, error) { return nil, nil })
	if err := docker.attach(context.Background(), testContainerID, networkDBSharedName); err != nil {
		t.Fatalf("attach 失败：%v", err)
	}
	networkCreate, connect := -1, -1
	for index, call := range transport.calls {
		if call.Method == "POST" && call.Path == "/networks/create" {
			networkCreate = index
		}
		if call.Method == "POST" && call.Path == "/networks/"+networkDBSharedName+"/connect" {
			connect = index
		}
	}
	if networkCreate < 0 || connect < 0 || networkCreate > connect {
		t.Fatalf("接入前必须先建网吧，调用序列：%v", callPaths(transport.calls))
	}
}

// callPaths 把调用序列压成一行，失败信息直接可判读。
func callPaths(calls []seam.EngineRequest) []string {
	paths := make([]string, 0, len(calls))
	for _, call := range calls {
		paths = append(paths, call.Method+" "+call.Path)
	}
	return paths
}

// stoppedManagedVolumeName 与 baseInspectBody 的挂载卷一致，满足受管卷名规则。
const stoppedManagedVolumeName = "elysian-db-00000000-0000-0000-0000-000000000000"

// stoppedRemoveTransport 构造停止态受管容器与卷的引擎应答；volumeLabels 决定卷身份是否匹配。
func stoppedRemoveTransport(t *testing.T, volumeLabels map[string]any) *scriptedTransport {
	t.Helper()
	inspect := baseInspectBody()
	inspect["State"] = map[string]any{"Running": false}
	inspect["Config"] = map[string]any{
		"Image": "mysql:8.4",
		"Labels": map[string]any{
			"elysian.managed":          "true",
			"elysian.database":         "true",
			"elysian.database.engine":  "MySQL",
			"elysian.database.version": "8.4",
			"elysian.database.volume":  stoppedManagedVolumeName,
		},
	}
	inspectRaw, err := json.Marshal(inspect)
	if err != nil {
		t.Fatal(err)
	}
	volumeRaw, err := json.Marshal(map[string]any{"Name": stoppedManagedVolumeName, "Labels": volumeLabels})
	if err != nil {
		t.Fatal(err)
	}
	return &scriptedTransport{responder: func(req seam.EngineRequest) seam.EngineResponse {
		switch {
		case req.Method == "GET" && req.Path == "/containers/"+testContainerID+"/json":
			return seam.EngineResponse{Status: 200, Body: inspectRaw}
		case req.Method == "GET" && req.Path == "/volumes/"+stoppedManagedVolumeName:
			return seam.EngineResponse{Status: 200, Body: volumeRaw}
		case req.Method == "DELETE" && req.Path == "/containers/"+testContainerID:
			return seam.EngineResponse{Status: 204}
		case req.Method == "DELETE" && req.Path == "/volumes/"+stoppedManagedVolumeName:
			return seam.EngineResponse{Status: 204}
		}
		return seam.EngineResponse{Status: 404}
	}}
}

func TestRemoveManagedDeletesStoppedContainerWithoutStop(t *testing.T) {
	transport := stoppedRemoveTransport(t, map[string]any{
		"elysian.database":         "true",
		"elysian.database.engine":  "MySQL",
		"elysian.database.version": "8.4",
	})
	docker := newDockerAPI(transport, func(context.Context) ([]contract.ContainerImage, error) {
		return testImageList(), nil
	})
	if err := docker.removeManaged(context.Background(), testContainerID, stoppedManagedVolumeName, engineMySQL, "8.4"); err != nil {
		t.Fatalf("停止态受管容器应可删除：%v", err)
	}
	stops, containerDeletes, volumeDeletes := 0, 0, 0
	for _, call := range transport.calls {
		switch {
		case call.Method == "POST" && strings.HasSuffix(call.Path, "/stop"):
			stops++
		case call.Method == "DELETE" && call.Path == "/containers/"+testContainerID:
			containerDeletes++
		case call.Method == "DELETE" && call.Path == "/volumes/"+stoppedManagedVolumeName:
			volumeDeletes++
		}
	}
	if stops != 0 || containerDeletes != 1 || volumeDeletes != 1 {
		t.Fatalf("停止态删除应无 /stop 且容器与卷各删一次，实际 %v", callPaths(transport.calls))
	}
}

func TestRemoveManagedRejectsForeignVolumeWhenStopped(t *testing.T) {
	// 卷缺 elysian.database 标签：即使容器已停止，身份核对失败仍拒绝删除。
	transport := stoppedRemoveTransport(t, map[string]any{
		"elysian.database.engine":  "MySQL",
		"elysian.database.version": "8.4",
	})
	docker := newDockerAPI(transport, func(context.Context) ([]contract.ContainerImage, error) {
		return testImageList(), nil
	})
	err := docker.removeManaged(context.Background(), testContainerID, stoppedManagedVolumeName, engineMySQL, "8.4")
	var invalid *shared.InvalidRequestError
	if !errors.As(err, &invalid) || invalid.Status != 409 || invalid.Message != "数据库持久卷身份核对失败" {
		t.Fatalf("卷身份不符仍应 409，实际 %v", err)
	}
	for _, call := range transport.calls {
		if call.Method == "DELETE" {
			t.Fatalf("身份核对失败不得派发删除：%v", callPaths(transport.calls))
		}
	}
}
