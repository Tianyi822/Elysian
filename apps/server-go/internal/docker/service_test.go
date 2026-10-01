package docker

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"elysian/server/internal/seam"
	"elysian/server/internal/shared"
)

// dockerService 对等测试（dockerService.test.ts 锚点，fake 传输注入）。

const imageIDConst = "1111111111111111111111111111111111111111111111111111111111111111"

func containerInspectForStatus(status string) string {
	return `{"Id":"` + strings.Repeat("c", 64) + `","Name":"/web-1","Created":"2024-05-01T08:00:00Z",
		"State":{"Status":"` + status + `","StartedAt":"2024-05-02T08:00:00Z"},
		"Config":{"Image":"nginx:1.27"},"HostConfig":{},"Mounts":[],"Image":"sha256:` + imageIDConst + `"}`
}

func summaryOf(id string) string {
	return `{"Id":"` + id + `","Names":["/web-1"],"State":"running"}`
}

func listOf(items ...string) string {
	return "[" + strings.Join(items, ",") + "]"
}

func imageInspectJSON(id string) string {
	return `{"Id":"sha256:` + id + `","Size":1000000,"Created":"2024-05-01T08:00:00Z","RepoTags":["nginx:1.27"],"RepoDigests":["nginx@sha256:d"]}`
}

func newService(engine *fakeEngine, mutate func(*serviceDeps)) *dockerService {
	deps := serviceDeps{
		transport:     engine,
		mountRoot:     "/srv",
		reservedPorts: []int{22, 48100, 48101},
	}
	if mutate != nil {
		mutate(&deps)
	}
	return newDockerService(deps)
}

func resolvePublicAlways(ctx context.Context, hostname string) ([]string, error) {
	return []string{"93.184.216.34"}, nil
}

func wantInvalidRequest(t *testing.T, err error, status int, message string) {
	t.Helper()
	invalid, ok := err.(*shared.InvalidRequestError)
	if !ok {
		t.Fatalf("want InvalidRequestError，got %#v", err)
	}
	if invalid.Status != status || invalid.Message != message {
		t.Fatalf("got %d %q，want %d %q", invalid.Status, invalid.Message, status, message)
	}
}

// ---------- 列表 ----------

func TestListContainersListThenInspect(t *testing.T) {
	id := strings.Repeat("c", 64)
	engine := newFakeEngine(func(call engineCall) (int, string, bool) {
		switch {
		case call.Method == "GET" && call.Path == "/containers/json":
			return 200, listOf(summaryOf(id)), true
		case call.Method == "GET" && strings.HasPrefix(call.Path, "/containers/"):
			return 200, containerInspectForStatus("running"), true
		}
		return 0, "", false
	})
	service := newService(engine, nil)
	containers, err := service.ListContainers(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(containers) != 1 || containers[0].Name != "web-1" || containers[0].Status != "running" {
		t.Fatalf("%+v", containers)
	}
	// inspect 只用 inspect 的形状（摘要仅取 Id）。
	if containers[0].ID != strings.Repeat("c", 64) {
		t.Fatalf("id：%s", containers[0].ID)
	}
}

func TestListOverLimit(t *testing.T) {
	entries := make([]string, 501)
	for i := range entries {
		entries[i] = summaryOf(fmt.Sprintf("%064d", i))
	}
	engine := newFakeEngine(func(call engineCall) (int, string, bool) {
		return 200, listOf(entries...), true
	})
	service := newService(engine, nil)
	_, err := service.ListContainers(context.Background())
	if err == nil || err.Error() != "容器数量超过上限 500" {
		t.Fatalf("got %v", err)
	}
}

func TestListInspectFailureFailsWholeList(t *testing.T) {
	id := strings.Repeat("c", 64)
	engine := newFakeEngine(func(call engineCall) (int, string, bool) {
		if call.Method == "GET" && call.Path == "/containers/json" {
			return 200, listOf(summaryOf(id)), true
		}
		return 500, `{"message":"boom"}`, true
	})
	service := newService(engine, nil)
	_, err := service.ListContainers(context.Background())
	if err == nil || err.Error() != "获取容器详情失败（HTTP 500）" {
		t.Fatalf("got %v", err)
	}
}

func TestListTimeoutSharedBudget(t *testing.T) {
	clock := newManualClock()
	releaseInspect := make(chan struct{})
	original := func(call engineCall) (int, string, bool) {
		if call.Method == "GET" && call.Path == "/containers/json" {
			return 200, listOf(summaryOf(strings.Repeat("c", 64))), true
		}
		if strings.HasPrefix(call.Path, "/containers/") {
			<-releaseInspect
			return 200, containerInspectForStatus("running"), true
		}
		return 0, "", false
	}
	engine := newFakeEngine(original)
	service := newService(engine, func(deps *serviceDeps) {
		deps.now = func() time.Time { return time.UnixMilli(clock.Now()) }
	})
	done := make(chan struct{})
	var listErr error
	go func() {
		_, listErr = service.ListContainers(context.Background())
		close(done)
	}()
	// 等列表请求真实发生（deadline 已按 t=0 建），再推进时钟越过预算并放行
	// inspect：整次列表 + inspect 共享 10s。
	deadline := time.Now().Add(5 * time.Second)
	for {
		engine.mu.Lock()
		started := len(engine.calls) > 0
		engine.mu.Unlock()
		if started {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("列表请求未发生")
		}
		time.Sleep(5 * time.Millisecond)
	}
	clock.Advance(10_001)
	close(releaseInspect)
	<-done
	if listErr == nil || listErr.Error() != listTimeoutMessage {
		t.Fatalf("共享预算超时：%v", listErr)
	}
}

// ---------- policy ----------

func TestPolicyPassthrough(t *testing.T) {
	service := newService(newFakeEngine(func(engineCall) (int, string, bool) { return 0, "", false }), nil)
	policy := service.Policy()
	if policy.MountRoot != "/srv" || len(policy.ReservedPorts) != 3 || policy.ReservedPorts[0] != 22 {
		t.Fatalf("%+v", policy)
	}
}

// ---------- action ----------

func actionEngineScript(selfID string) engineScript {
	return func(call engineCall) (int, string, bool) {
		if call.Method == "GET" && strings.HasSuffix(call.Path, "/json") {
			inspect := containerInspectForStatus("running")
			if selfID != "" {
				inspect = `{"Id":"` + selfID + `","Name":"/elysian","Created":"c","State":{"Status":"running","StartedAt":"s"},"Config":{},"HostConfig":{},"Mounts":[],"Image":"i"}`
			}
			return 200, inspect, true
		}
		if call.Method == "POST" && strings.HasSuffix(call.Path, "/stop") {
			return 204, "", true
		}
		if call.Method == "POST" && strings.HasSuffix(call.Path, "/start") {
			return 304, "", true
		}
		if call.Method == "POST" && strings.HasSuffix(call.Path, "/restart") {
			return 204, "", true
		}
		return 0, "", false
	}
}

func TestActionStopWithT10And304StartOK(t *testing.T) {
	engine := newFakeEngine(actionEngineScript(""))
	service := newService(engine, nil)
	if _, err := service.Action(context.Background(), strings.Repeat("c", 64), "stop"); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Action(context.Background(), strings.Repeat("c", 64), "start"); err != nil {
		t.Fatalf("start 304 视为成功：%v", err)
	}
	stopped := false
	for _, call := range engine.Requests() {
		if call.Method == "POST" && strings.HasSuffix(call.Path, "/stop") {
			stopped = true
			if got := call.Query.Get("t"); got != "10" {
				t.Fatalf("stop 应带 t=10：%v", call.Query)
			}
		}
	}
	if !stopped {
		t.Fatal("未发 stop")
	}
}

func TestActionSelfContainerStopRestartBlockedStartAllowed(t *testing.T) {
	selfID := strings.Repeat("b", 64)
	engine := newFakeEngine(actionEngineScript(selfID))
	service := newService(engine, func(deps *serviceDeps) { deps.selfContainerID = selfID })
	for _, action := range []string{"stop", "restart"} {
		_, err := service.Action(context.Background(), "elysian", action)
		wantInvalidRequest(t, err, 400, actionSelfMessage)
	}
	// start 对自容器放行。
	if _, err := service.Action(context.Background(), selfID, "start"); err != nil {
		t.Fatalf("start 放行：%v", err)
	}
}

func TestActionPaused(t *testing.T) {
	engine := newFakeEngine(func(call engineCall) (int, string, bool) {
		if strings.HasSuffix(call.Path, "/json") {
			return 200, containerInspectForStatus("paused"), true
		}
		return 0, "", false
	})
	service := newService(engine, nil)
	_, err := service.Action(context.Background(), strings.Repeat("c", 64), "stop")
	wantInvalidRequest(t, err, 409, actionPausedMessage)
	// 不调 Engine 动作。
	for _, call := range engine.Requests() {
		if call.Method == "POST" {
			t.Fatalf("paused 不应发 POST：%v", call)
		}
	}
}

func TestActionRestartFiresOnRestartingBeforeEngine(t *testing.T) {
	var order []string
	var orderMu sync.Mutex
	record := func(entry string) {
		orderMu.Lock()
		order = append(order, entry)
		orderMu.Unlock()
	}
	engine := newFakeEngine(actionEngineScript(""))
	engine.mu.Lock()
	original := engine.script
	engine.script = func(call engineCall) (int, string, bool) {
		if call.Method == "POST" {
			record("engine")
		}
		return original(call)
	}
	engine.mu.Unlock()
	service := newService(engine, func(deps *serviceDeps) {
		deps.onRestarting = func(string) { record("restarting") }
	})
	if _, err := service.Action(context.Background(), strings.Repeat("c", 64), "restart"); err != nil {
		t.Fatal(err)
	}
	orderMu.Lock()
	defer orderMu.Unlock()
	if len(order) < 2 || order[0] != "restarting" || order[1] != "engine" {
		t.Fatalf("onRestarting 必须先于 Engine 动作：%v", order)
	}
}

func TestActionConcurrentSameID(t *testing.T) {
	gate := make(chan struct{})
	engine := newFakeEngine(func(call engineCall) (int, string, bool) {
		if call.Method == "POST" {
			<-gate
			return 204, "", true
		}
		if strings.HasSuffix(call.Path, "/json") {
			return 200, containerInspectForStatus("running"), true
		}
		return 0, "", false
	})
	service := newService(engine, nil)
	id := strings.Repeat("c", 64)
	first := make(chan error, 1)
	go func() {
		_, err := service.Action(context.Background(), id, "stop")
		first <- err
	}()
	time.Sleep(100 * time.Millisecond)
	_, err := service.Action(context.Background(), id, "stop")
	wantInvalidRequest(t, err, 409, actionBusyMessage)
	close(gate)
	if err := <-first; err != nil {
		t.Fatal(err)
	}
}

func TestActionNotFoundChinese(t *testing.T) {
	engine := newFakeEngine(func(call engineCall) (int, string, bool) {
		if strings.HasSuffix(call.Path, "/json") {
			return 404, `{"message":"No such container"}`, true
		}
		return 0, "", false
	})
	service := newService(engine, nil)
	_, err := service.Action(context.Background(), strings.Repeat("c", 64), "stop")
	wantInvalidRequest(t, err, 404, containerNotFoundMessage)
}

// ---------- create ----------

func createScript(createStatus int, startStatus int) engineScript {
	id := strings.Repeat("e", 64)
	return func(call engineCall) (int, string, bool) {
		if call.Method == "GET" && call.Path == "/containers/json" {
			return 200, "[]", true
		}
		if call.Method == "GET" && call.Path == "/images/json" {
			return 200, listOf(`{"Id":"sha256:` + imageIDConst + `"}`), true
		}
		if call.Method == "GET" && strings.HasPrefix(call.Path, "/images/") {
			return 200, imageInspectJSON(imageIDConst), true
		}
		if call.Method == "POST" && call.Path == "/containers/create" {
			return createStatus, `{"Id":"` + id + `"}`, true
		}
		if call.Method == "POST" && strings.HasSuffix(call.Path, "/start") {
			return startStatus, "", true
		}
		if call.Method == "GET" && strings.HasPrefix(call.Path, "/containers/") {
			return 200, containerInspectForStatus("running"), true
		}
		return 0, "", false
	}
}

func TestCreateOrderAndBody(t *testing.T) {
	engine := newFakeEngine(createScript(201, 204))
	service := newService(engine, nil)
	body := mustDecode(t, `{"imageId":"sha256:`+imageIDConst+`"}`)
	container, err := service.Create(context.Background(), body)
	if err != nil {
		t.Fatal(err)
	}
	if container.Name != "web-1" {
		t.Fatalf("回读 inspect 的名字：%q", container.Name)
	}
	sawCreate := false
	for _, call := range engine.Requests() {
		if call.Method == "POST" && call.Path == "/containers/create" {
			sawCreate = true
			if call.Query.Get("name") != "nginx" {
				t.Fatalf("create 带 name：%v", call.Query)
			}
			if !strings.Contains(call.Body, `"Labels":{"elysian.managed":"true"}`) {
				t.Fatalf("create 体：%s", call.Body)
			}
		}
	}
	if !sawCreate {
		t.Fatal("未发 create")
	}
}

func TestCreateStartFailureRollback(t *testing.T) {
	id := strings.Repeat("e", 64)
	fullScript := func(call engineCall) (int, string, bool) {
		if call.Method == "GET" && call.Path == "/containers/json" {
			return 200, "[]", true
		}
		if call.Method == "GET" && call.Path == "/images/json" {
			return 200, listOf(`{"Id":"sha256:` + imageIDConst + `"}`), true
		}
		if call.Method == "GET" && strings.HasPrefix(call.Path, "/images/") {
			return 200, imageInspectJSON(imageIDConst), true
		}
		if call.Method == "POST" && call.Path == "/containers/create" {
			return 201, `{"Id":"` + id + `"}`, true
		}
		if call.Method == "POST" && strings.HasSuffix(call.Path, "/start") {
			return 500, `{"message":"port taken"}`, true
		}
		if call.Method == "DELETE" {
			return 204, "", true
		}
		return 0, "", false
	}
	service := newService(newFakeEngine(fullScript), nil)
	_, err := service.Create(context.Background(), mustDecode(t, `{"imageId":"`+imageIDConst+`"}`))
	wantInvalidRequest(t, err, 400, "容器启动失败，已撤销创建：port taken")

	// 撤销也失败：附容器 ID。
	deleteFails := func(call engineCall) (int, string, bool) {
		if call.Method == "DELETE" {
			return 409, `{"message":"cannot remove"}`, true
		}
		return fullScript(call)
	}
	service = newService(newFakeEngine(deleteFails), nil)
	_, err = service.Create(context.Background(), mustDecode(t, `{"imageId":"`+imageIDConst+`"}`))
	wantInvalidRequest(t, err, 400, "容器启动失败，已撤销创建：port taken且撤销失败，容器 ID 为 "+id)
}

func TestCreateSerializedGlobally(t *testing.T) {
	engine := newFakeEngine(createScript(201, 204))
	gate := make(chan struct{})
	engine.mu.Lock()
	original := engine.script
	engine.script = func(call engineCall) (int, string, bool) {
		if call.Method == "POST" && call.Path == "/containers/create" {
			<-gate
		}
		return original(call)
	}
	engine.mu.Unlock()
	service := newService(engine, nil)
	body := mustDecode(t, `{"imageId":"`+imageIDConst+`"}`)
	first := make(chan error, 1)
	go func() {
		_, err := service.Create(context.Background(), body)
		first <- err
	}()
	time.Sleep(100 * time.Millisecond)
	second := make(chan error, 1)
	go func() {
		_, err := service.Create(context.Background(), body)
		second <- err
	}()
	time.Sleep(100 * time.Millisecond)
	// 第一个未完成时第二个不得触 Engine create。
	createCalls := 0
	for _, call := range engine.Requests() {
		if call.Method == "POST" && call.Path == "/containers/create" {
			createCalls++
		}
	}
	if createCalls != 1 {
		t.Fatalf("并发 create 未串行（已发 %d 次）", createCalls)
	}
	close(gate)
	if err := <-first; err != nil {
		t.Fatal(err)
	}
	if err := <-second; err != nil {
		t.Fatal(err)
	}
}

// ---------- pull ----------

func pullScript(listCount *int, pullStatus int, pullBody string) engineScript {
	return func(call engineCall) (int, string, bool) {
		if call.Method == "GET" && call.Path == "/images/json" {
			*listCount++
			if *listCount == 1 {
				return 200, "[]", true
			}
			return 200, listOf(`{"Id":"sha256:` + imageIDConst + `"}`), true
		}
		if call.Method == "GET" && strings.HasPrefix(call.Path, "/images/") {
			return 200, imageInspectJSON(imageIDConst), true
		}
		if call.Method == "POST" && call.Path == "/images/create" {
			return pullStatus, pullBody, true
		}
		return 0, "", false
	}
}

func TestPullBasic(t *testing.T) {
	listCount := 0
	engine := newFakeEngine(pullScript(&listCount, 200, "{\"status\":\"Download complete\"}\n"))
	service := newService(engine, func(deps *serviceDeps) { deps.resolveRegistry = resolvePublicAlways })
	image, err := service.Pull(context.Background(), mustDecode(t, `{"name":"nginx","tag":"1.27"}`), nil)
	if err != nil {
		t.Fatal(err)
	}
	if image.Name != "nginx" || image.Tag != "1.27" {
		t.Fatalf("%+v", image)
	}
	for _, call := range engine.Requests() {
		if call.Method == "POST" && call.Path == "/images/create" {
			if got := call.Query.Get("fromImage"); got != "nginx:1.27" {
				t.Fatalf("fromImage：%q", got)
			}
			return
		}
	}
	t.Fatal("未发 pull create")
}

func TestPullAlreadyExists(t *testing.T) {
	listCount := 0
	engine := newFakeEngine(func(call engineCall) (int, string, bool) {
		if call.Method == "GET" && call.Path == "/images/json" {
			listCount++
			return 200, listOf(`{"Id":"sha256:` + imageIDConst + `"}`), true
		}
		if call.Method == "GET" && strings.HasPrefix(call.Path, "/images/") {
			return 200, imageInspectJSON(imageIDConst), true
		}
		return 0, "", false
	})
	service := newService(engine, func(deps *serviceDeps) { deps.resolveRegistry = resolvePublicAlways })
	_, err := service.Pull(context.Background(), mustDecode(t, `{"name":"nginx","tag":"1.27"}`), nil)
	wantInvalidRequest(t, err, 400, "镜像已存在：nginx:1.27")
}

func TestPullCustomRegistryTagUntagChain(t *testing.T) {
	listCount := 0
	sawTag, sawUntag := false, false
	engine := newFakeEngine(func(call engineCall) (int, string, bool) {
		if call.Method == "GET" && call.Path == "/images/json" {
			listCount++
			if listCount == 1 {
				return 200, "[]", true
			}
			return 200, listOf(`{"Id":"sha256:` + imageIDConst + `"}`), true
		}
		if call.Method == "GET" && strings.HasPrefix(call.Path, "/images/") {
			return 200, imageInspectJSON(imageIDConst), true
		}
		if call.Method == "POST" && call.Path == "/images/create" {
			if got := call.Query.Get("fromImage"); got != "mirror.example/library/nginx:1.27" {
				t.Fatalf("fromImage：%q", got)
			}
			return 200, "{\"status\":\"Download complete\"}\n", true
		}
		if call.Method == "POST" && strings.HasSuffix(call.Path, "/tag") {
			sawTag = true
			if call.Query.Get("repo") != "nginx" || call.Query.Get("tag") != "1.27" {
				t.Fatalf("tag 参数：%v", call.Query)
			}
			return 201, "", true
		}
		if call.Method == "DELETE" && strings.HasPrefix(call.Path, "/images/mirror.example") {
			sawUntag = true
			if call.Query.Get("force") != "false" {
				t.Fatalf("force=false：%v", call.Query)
			}
			return 200, "", true
		}
		return 0, "", false
	})
	service := newService(engine, func(deps *serviceDeps) { deps.resolveRegistry = resolvePublicAlways })
	image, err := service.Pull(context.Background(), mustDecode(t, `{"name":"nginx","tag":"1.27","registry":"https://mirror.example"}`), nil)
	if err != nil {
		t.Fatal(err)
	}
	if image.Name != "nginx" || image.Tag != "1.27" || !sawTag || !sawUntag {
		t.Fatalf("链路不完整：%+v tag=%v untag=%v", image, sawTag, sawUntag)
	}
}

func TestPullErrorLinePassthrough(t *testing.T) {
	listCount := 0
	engine := newFakeEngine(pullScript(&listCount, 200, "{\"error\":\"denied\"}\n"))
	service := newService(engine, func(deps *serviceDeps) { deps.resolveRegistry = resolvePublicAlways })
	_, err := service.Pull(context.Background(), mustDecode(t, `{"name":"nginx","tag":"1.27"}`), nil)
	wantInvalidRequest(t, err, 400, "denied")
}

func TestPullProgressBeforeFinish(t *testing.T) {
	listCount := 0
	release := make(chan struct{})
	original := pullScript(&listCount, 200, `{"status":"Download complete"}`+"\n")
	engine := newFakeEngine(original)
	engine.streamFn = func(ctx context.Context, call engineCall, onChunk func([]byte)) (seam.EngineResponse, error) {
		if call.Path == "/images/create" {
			line := `{"status":"Downloading","id":"abc","progressDetail":{"current":50,"total":100}}` + "\n"
			if onChunk != nil {
				onChunk([]byte(line[:19]))
				onChunk([]byte(line[19:]))
			}
			<-release
			return seam.EngineResponse{Status: 200, Body: []byte(line)}, nil
		}
		return engine.Request(ctx, seam.EngineRequest{Method: call.Method, Path: call.Path, Query: call.Query})
	}
	var updates []imagePullProgress
	service := newService(engine, func(deps *serviceDeps) { deps.resolveRegistry = resolvePublicAlways })
	done := make(chan error, 1)
	go func() {
		_, err := service.Pull(context.Background(), mustDecode(t, `{"name":"nginx","tag":"1.27"}`), func(p imagePullProgress) {
			updates = append(updates, p)
		})
		done <- err
	}()
	time.Sleep(150 * time.Millisecond)
	if len(updates) != 1 || updates[0].Phase != "downloading" || updates[0].LayerID != "abc" || *updates[0].CurrentBytes != 50 || *updates[0].TotalBytes != 100 {
		t.Fatalf("进度应在流结束前推送：%+v", updates)
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestPullConcurrent409(t *testing.T) {
	listCount := 0
	release := make(chan struct{})
	engine := newFakeEngine(pullScript(&listCount, 200, `{"status":"Download complete"}`+"\n"))
	engine.streamFn = func(ctx context.Context, call engineCall, onChunk func([]byte)) (seam.EngineResponse, error) {
		if call.Path == "/images/create" {
			<-release
			return seam.EngineResponse{Status: 200, Body: []byte("{\"status\":\"Download complete\"}\n")}, nil
		}
		return engine.Request(ctx, seam.EngineRequest{Method: call.Method, Path: call.Path, Query: call.Query})
	}
	service := newService(engine, func(deps *serviceDeps) { deps.resolveRegistry = resolvePublicAlways })
	firstDone := make(chan error, 1)
	go func() {
		_, err := service.Pull(context.Background(), mustDecode(t, `{"name":"nginx","tag":"1.27"}`), nil)
		firstDone <- err
	}()
	time.Sleep(150 * time.Millisecond)
	_, err := service.Pull(context.Background(), mustDecode(t, `{"name":"redis","tag":"7"}`), nil)
	wantInvalidRequest(t, err, 409, pullBusyMessage)
	close(release)
	if err := <-firstDone; err != nil {
		t.Fatal(err)
	}
}

func TestPullBodyValidation(t *testing.T) {
	service := newService(newFakeEngine(func(engineCall) (int, string, bool) { return 200, "[]", true }), nil)
	cases := []struct {
		body    string
		status  int
		message string
	}{
		{`[]`, 400, "请求体必须是 JSON 对象"},
		{`{"name":"nginx","tag":"1","auth":{}}`, 400, pullAuthMessage},
		{`{"name":"nginx","tag":"1","password":"x"}`, 400, pullAuthMessage},
		{`{"name":123,"tag":"1"}`, 400, "请提供镜像名称与标签"},
		{`{"name":"NGINX bad","tag":"1"}`, 400, "名称仅限小写字母、数字与 : _ . / -，且以字母或数字开头"},
		{`{"name":"nginx","tag":"1","registry":123}`, 400, "镜像源格式无效"},
		{`{"name":"nginx","tag":"1","registry":""}`, 400, "镜像源不能为空"},
	}
	for _, tc := range cases {
		_, err := service.Pull(context.Background(), mustDecode(t, tc.body), nil)
		wantInvalidRequest(t, err, tc.status, tc.message)
	}
}

func TestPullRegistryReferenceConflict(t *testing.T) {
	service := newService(newFakeEngine(func(engineCall) (int, string, bool) { return 200, "[]", true }), func(deps *serviceDeps) {
		deps.resolveRegistry = resolvePublicAlways
	})
	_, err := service.Pull(context.Background(), mustDecode(t, `{"name":"mirror.example/nginx","tag":"1","registry":"https://mirror.example"}`), nil)
	wantInvalidRequest(t, err, 400, registryReferenceConflictMsg)
}

func TestPullEmbeddedPrivateHostRejected(t *testing.T) {
	engine := newFakeEngine(func(engineCall) (int, string, bool) { return 200, "[]", true })
	service := newService(engine, nil)
	_, err := service.Pull(context.Background(), mustDecode(t, `{"name":"evil.internal/nginx","tag":"1"}`), nil)
	if err == nil {
		t.Fatal("内嵌仓库未校验应拒绝")
	}
	for _, call := range engine.Requests() {
		if call.Method == "POST" && call.Path == "/images/create" {
			t.Fatal("校验失败不应触发 Engine 拉取")
		}
	}
}

// ---------- removeContainer ----------

func removeScript(selfID string, deleteStatus int) engineScript {
	return func(call engineCall) (int, string, bool) {
		if call.Method == "GET" && strings.HasSuffix(call.Path, "/json") {
			if selfID != "" {
				return 200, `{"Id":"` + selfID + `","Name":"/elysian","Created":"c","State":{"Status":"running"},"Config":{"Labels":{"` + labelDatabase + `":"false"}},"HostConfig":{},"Mounts":[],"Image":"i"}`, true
			}
			return 200, `{"Id":"` + strings.Repeat("c", 64) + `","Name":"/web-1","Created":"c","State":{"Status":"running"},"Config":{"Labels":{"` + labelDatabase + `":"false"}},"HostConfig":{},"Mounts":[],"Image":"i"}`, true
		}
		if call.Method == "DELETE" {
			return deleteStatus, `{"message":"cannot"}`, true
		}
		return 0, "", false
	}
}

func TestRemoveContainerByNameBlockedForSelf(t *testing.T) {
	selfID := strings.Repeat("b", 64)
	engine := newFakeEngine(removeScript(selfID, 204))
	service := newService(engine, func(deps *serviceDeps) { deps.selfContainerID = selfID })
	err := service.RemoveContainer(context.Background(), "elysian")
	wantInvalidRequest(t, err, 400, actionSelfMessage)
	for _, call := range engine.Requests() {
		if call.Method == "DELETE" {
			t.Fatal("自容器 DELETE 不应发生")
		}
	}
}

func TestRemoveContainerStatuses(t *testing.T) {
	cases := []struct {
		deleteStatus int
		wantStatus   int
		message      string
	}{
		{404, 404, containerNotFoundMessage},
		{409, 409, containerRunningRemoveMessage},
	}
	for _, tc := range cases {
		engine := newFakeEngine(func(call engineCall) (int, string, bool) {
			if call.Method == "GET" && strings.HasSuffix(call.Path, "/json") {
				return 200, `{"Id":"` + strings.Repeat("c", 64) + `","Name":"/web","Created":"c","State":{"Status":"exited"},"Config":{},"HostConfig":{},"Mounts":[],"Image":"i"}`, true
			}
			if call.Method == "DELETE" {
				return tc.deleteStatus, `{"message":"x"}`, true
			}
			return 0, "", false
		})
		service := newService(engine, nil)
		err := service.RemoveContainer(context.Background(), strings.Repeat("c", 64))
		wantInvalidRequest(t, err, tc.wantStatus, tc.message)
	}
	// 成功路径用完整 Id 发 DELETE。
	successEngine := newFakeEngine(removeScript("", 204))
	successService := newService(successEngine, nil)
	if err := successService.RemoveContainer(context.Background(), strings.Repeat("c", 64)); err != nil {
		t.Fatal(err)
	}
	for _, call := range successEngine.Requests() {
		if call.Method == "DELETE" && call.Path != "/containers/"+strings.Repeat("c", 64) {
			t.Fatalf("DELETE 应用完整 Id：%s", call.Path)
		}
	}
}

func TestRemoveContainerDatabaseLabel(t *testing.T) {
	engine := newFakeEngine(func(call engineCall) (int, string, bool) {
		if call.Method == "GET" && strings.HasSuffix(call.Path, "/json") {
			return 200, `{"Id":"` + strings.Repeat("c", 64) + `","Name":"/db","Created":"c","State":{"Status":"exited"},"Config":{"Labels":{"` + labelDatabase + `":"true"}},"HostConfig":{},"Mounts":[],"Image":"i"}`, true
		}
		return 0, "", false
	})
	service := newService(engine, nil)
	err := service.RemoveContainer(context.Background(), strings.Repeat("c", 64))
	wantInvalidRequest(t, err, 409, "数据库容器须在数据库页使用“删除容器及数据”操作")
}

// ---------- removeImage ----------

func TestRemoveImageReferencedByContainerSummaryImageIsRefName(t *testing.T) {
	// 摘要 Image 是引用名（busybox:1.37），必须逐容器 inspect 才不漏判。
	engine := newFakeEngine(func(call engineCall) (int, string, bool) {
		switch {
		case call.Method == "GET" && call.Path == "/containers/json":
			return 200, listOf(summaryOf(strings.Repeat("c", 64))), true
		case call.Method == "GET" && strings.HasPrefix(call.Path, "/containers/"):
			return 200, `{"Id":"` + strings.Repeat("c", 64) + `","Name":"/x","Created":"c","State":{"Status":"exited"},"Config":{},"HostConfig":{},"Mounts":[],"Image":"sha256:` + imageIDConst + `"}`, true
		}
		return 0, "", false
	})
	service := newService(engine, nil)
	err := service.RemoveImage(context.Background(), imageIDConst)
	wantInvalidRequest(t, err, 409, imageInUseMessage)
}

func TestRemoveImageNotFound(t *testing.T) {
	engine := newFakeEngine(func(call engineCall) (int, string, bool) {
		if call.Method == "GET" && call.Path == "/containers/json" {
			return 200, "[]", true
		}
		if call.Method == "GET" && strings.HasPrefix(call.Path, "/images/") {
			return 404, `{"message":"no such image"}`, true
		}
		return 0, "", false
	})
	service := newService(engine, nil)
	err := service.RemoveImage(context.Background(), imageIDConst)
	wantInvalidRequest(t, err, 404, imageNotFoundMessage)
}

func TestRemoveImageWithRepoTagsSequential(t *testing.T) {
	engine := newFakeEngine(func(call engineCall) (int, string, bool) {
		if call.Method == "GET" && call.Path == "/containers/json" {
			return 200, "[]", true
		}
		if call.Method == "GET" && strings.HasPrefix(call.Path, "/images/") {
			return 200, `{"Id":"sha256:` + imageIDConst + `","RepoTags":["nginx:1.27","nginx:latest"]}`, true
		}
		if call.Method == "DELETE" {
			if strings.HasSuffix(call.Path, "nginx%3Alatest") {
				return 409, `{"message":"conflict"}`, true
			}
			return 200, "", true
		}
		return 0, "", false
	})
	service := newService(engine, nil)
	err := service.RemoveImage(context.Background(), "sha256:"+imageIDConst)
	// 字典序 nginx:1.27 < nginx:latest，1.27 先删成功后 latest 失败。
	wantInvalidRequest(t, err, 400, "已移除 nginx:1.27，删除 nginx:latest 失败：conflict")
}

func TestRemoveImageNoRepoTagsByID(t *testing.T) {
	engine := newFakeEngine(func(call engineCall) (int, string, bool) {
		if call.Method == "GET" && call.Path == "/containers/json" {
			return 200, "[]", true
		}
		if call.Method == "GET" && strings.HasPrefix(call.Path, "/images/") {
			return 200, `{"Id":"sha256:` + imageIDConst + `","RepoTags":[]}`, true
		}
		if call.Method == "DELETE" {
			return 200, "", true
		}
		return 0, "", false
	})
	service := newService(engine, nil)
	if err := service.RemoveImage(context.Background(), imageIDConst); err != nil {
		t.Fatal(err)
	}
}

func TestRemoveImageEmptyID(t *testing.T) {
	service := newService(newFakeEngine(func(engineCall) (int, string, bool) { return 0, "", false }), nil)
	err := service.RemoveImage(context.Background(), "sha256:")
	wantInvalidRequest(t, err, 400, "镜像 ID 不能为空")
}

// ---------- 搜索与标签 ----------

func TestSearchImagesTermValidation(t *testing.T) {
	service := newService(newFakeEngine(func(engineCall) (int, string, bool) { return 0, "", false }), nil)
	for _, term := range []string{"", "a", "大", "a b", strings.Repeat("a", 65)} {
		_, err := service.SearchImages(context.Background(), term, "")
		wantInvalidRequest(t, err, 400, "镜像搜索词格式无效")
	}
}

func TestSearchImagesOfficialEngine(t *testing.T) {
	engine := newFakeEngine(func(call engineCall) (int, string, bool) {
		if call.Method == "GET" && call.Path == "/images/search" {
			if call.Query.Get("term") != "nginx" || call.Query.Get("limit") != "10" {
				t.Fatalf("query：%v", call.Query)
			}
			return 200, `[{"name":"nginx"},{"name":"nginx"},{"name":"nginx-alpine"},{"name":"UPPER"}]`, true
		}
		return 0, "", false
	})
	service := newService(engine, nil)
	result, err := service.SearchImages(context.Background(), "nginx", "")
	if err != nil {
		t.Fatal(err)
	}
	if !result.Searchable || len(result.Names) != 2 {
		t.Fatalf("去重截 10：%+v", result)
	}
}

func TestSearchImagesOfficialNon200(t *testing.T) {
	engine := newFakeEngine(func(call engineCall) (int, string, bool) {
		return 503, `{"message":"unavailable"}`, true
	})
	service := newService(engine, nil)
	_, err := service.SearchImages(context.Background(), "nginx", "")
	if err == nil || err.Error() != "搜索官方镜像失败（HTTP 503）" {
		t.Fatalf("got %v", err)
	}
}

func TestSearchImagesCustomCatalogNoHubFallback(t *testing.T) {
	calls := 0
	service := newService(newFakeEngine(func(engineCall) (int, string, bool) { calls++; return 0, "", false }), func(deps *serviceDeps) {
		deps.resolveRegistry = resolvePublicAlways
		deps.fetchCatalog = func(context.Context, registryRequestTarget, string) (catalogResponse, error) {
			return catalogResponse{}, errors.New("镜像源目录查询超时")
		}
	})
	result, err := service.SearchImages(context.Background(), "redis", "https://mirror.example")
	if err != nil {
		t.Fatal(err)
	}
	if result.Searchable || len(result.Names) != 0 {
		t.Fatalf("目录失败不回退 Hub：%+v", result)
	}
	if calls != 0 {
		t.Fatal("自定义源不得走 Engine")
	}
}

func TestImageTagsValidation(t *testing.T) {
	service := newService(newFakeEngine(func(engineCall) (int, string, bool) { return 0, "", false }), nil)
	for _, name := range []string{"", "a b", "a_b!", strings.Repeat("a", 129)} {
		_, err := service.ImageTags(context.Background(), name, "")
		wantInvalidRequest(t, err, 400, "镜像仓库名格式无效")
	}
}

func TestImageTagsOfficialLibraryPrefixAndToken(t *testing.T) {
	var gotRepo string
	service := newService(newFakeEngine(func(engineCall) (int, string, bool) { return 0, "", false }), func(deps *serviceDeps) {
		deps.fetchHubToken = func(ctx context.Context, repository string) (string, error) {
			gotRepo = repository
			return "tok", nil
		}
		deps.fetchTags = func(ctx context.Context, target registryRequestTarget, path string, token string) (catalogResponse, error) {
			if target.host != "registry-1.docker.io" || token != "tok" {
				t.Fatalf("官方源固定主机名与令牌：%+v %q", target, token)
			}
			return catalogResponse{status: 200, json: mustDecode(t, `{"tags":["latest","1.27"]}`)}, nil
		}
	})
	result, err := service.ImageTags(context.Background(), "redis", "")
	if err != nil {
		t.Fatal(err)
	}
	if gotRepo != "library/redis" {
		t.Fatalf("无 / 补 library/：%q", gotRepo)
	}
	if !result.Searchable || len(result.Tags) != 2 {
		t.Fatalf("%+v", result)
	}
}

func TestImageTagsCustomNoToken(t *testing.T) {
	service := newService(newFakeEngine(func(engineCall) (int, string, bool) { return 0, "", false }), func(deps *serviceDeps) {
		deps.resolveRegistry = resolvePublicAlways
		deps.fetchTags = func(ctx context.Context, target registryRequestTarget, path string, token string) (catalogResponse, error) {
			if token != "" {
				t.Fatalf("自定义源不得带令牌：%q", token)
			}
			if target.host != "mirror.example" {
				t.Fatalf("host：%q", target.host)
			}
			return catalogResponse{status: 200, json: mustDecode(t, `{"tags":["1"]}`)}, nil
		}
	})
	result, err := service.ImageTags(context.Background(), "app", "mirror.example")
	if err != nil {
		t.Fatal(err)
	}
	if !result.Searchable || len(result.Tags) != 1 {
		t.Fatalf("%+v", result)
	}
}

func TestImageTagsTokenFailureSurfaces(t *testing.T) {
	service := newService(newFakeEngine(func(engineCall) (int, string, bool) { return 0, "", false }), func(deps *serviceDeps) {
		deps.fetchHubToken = func(ctx context.Context, repository string) (string, error) {
			return "", errors.New("无法取得 Docker Hub 公开镜像访问令牌")
		}
	})
	_, err := service.ImageTags(context.Background(), "redis", "")
	if err == nil || err.Error() != "无法取得 Docker Hub 公开镜像访问令牌" {
		t.Fatalf("got %v", err)
	}
}
