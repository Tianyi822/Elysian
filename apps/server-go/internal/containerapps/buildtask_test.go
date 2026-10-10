package containerapps

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"elysian/server/internal/seam"
)

// ---------- fake Engine ----------

// fakeEngineImage fake 引擎里的一个镜像引用。
type fakeEngineImage struct {
	ID     string
	Labels map[string]string
}

// fakeEngineRequest 一次 Request 的记录。
type fakeEngineRequest struct {
	Method string
	Path   string
	Query  url.Values
}

// fakeEngineStream 一次 Stream 的记录（断言引擎调用形状用）。
type fakeEngineStream struct {
	Method      string
	Path        string
	Query       url.Values
	DiscardBody bool
	MaxBytes    int64
	ContentType string
}

// fakeBuildScript 一次 /build 的脚本：Status 为响应码；Lines 是 NDJSON 行；
// Block 为真时挂起等待 ctx 取消（模拟长构建）。
type fakeBuildScript struct {
	Status         int
	Lines          []string
	Block          bool
	DisablePersist bool // 成功后不把产物镜像写进 fake 引擎（测 inspect 回查失败用）
}

// fakeBuildEngine 面板视角的最小引擎替身：镜像列表/inspect/删除 + /build 流。
type fakeBuildEngine struct {
	mu          sync.Mutex
	images      map[string]fakeEngineImage
	nextImageID int
	scripts     []fakeBuildScript
	scriptFn    func(query url.Values) fakeBuildScript
	requests    []fakeEngineRequest
	streams     []fakeEngineStream
	inspectFail bool
	// beforeStream 在每次 Stream 记录后、脚本执行前调用（模拟打包完成后磁盘被改写）。
	beforeStream func(query url.Values)
}

func newFakeBuildEngine() *fakeBuildEngine {
	return &fakeBuildEngine{images: map[string]fakeEngineImage{}}
}

func (f *fakeBuildEngine) imageID(ref string) (string, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	image, ok := f.images[ref]
	return image.ID, ok
}

func (f *fakeBuildEngine) addImage(ref, id string, labels map[string]string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if id == "" {
		f.nextImageID++
		id = fmt.Sprintf("sha256:%064d", f.nextImageID)
	}
	f.images[ref] = fakeEngineImage{ID: id, Labels: labels}
}

// Request 实现 seam.DockerTransport。
func (f *fakeBuildEngine) Request(ctx context.Context, req seam.EngineRequest) (seam.EngineResponse, error) {
	f.mu.Lock()
	f.requests = append(f.requests, fakeEngineRequest{Method: req.Method, Path: req.Path, Query: req.Query})
	images := make(map[string]fakeEngineImage, len(f.images))
	for ref, image := range f.images {
		images[ref] = image
	}
	inspectFail := f.inspectFail
	f.mu.Unlock()

	switch {
	case req.Method == http.MethodGet && req.Path == "/images/json":
		var filter string
		if raw := req.Query.Get("filters"); raw != "" {
			var parsed map[string][]string
			if json.Unmarshal([]byte(raw), &parsed) == nil && len(parsed["reference"]) > 0 {
				filter = parsed["reference"][0]
			}
		}
		type summary struct {
			RepoTags []string          `json:"RepoTags"`
			Labels   map[string]string `json:"Labels"`
		}
		rows := []summary{}
		for ref, image := range images {
			if filter != "" && ref != filter && !strings.HasPrefix(ref, filter+":") {
				continue
			}
			rows = append(rows, summary{RepoTags: []string{ref}, Labels: image.Labels})
		}
		body, _ := json.Marshal(rows)
		return seam.EngineResponse{Status: http.StatusOK, Body: body}, nil

	case req.Method == http.MethodGet && strings.HasPrefix(req.Path, "/images/") && strings.HasSuffix(req.Path, "/json"):
		ref := strings.TrimSuffix(strings.TrimPrefix(req.Path, "/images/"), "/json")
		if inspectFail {
			return seam.EngineResponse{Status: http.StatusInternalServerError, Body: []byte(`{"message":"boom"}`)}, nil
		}
		image, ok := images[ref]
		if !ok {
			return seam.EngineResponse{Status: http.StatusNotFound, Body: []byte(`{"message":"no such image"}`)}, nil
		}
		body, _ := json.Marshal(map[string]any{"Id": image.ID})
		return seam.EngineResponse{Status: http.StatusOK, Body: body}, nil

	case req.Method == http.MethodDelete && strings.HasPrefix(req.Path, "/images/"):
		ref := strings.TrimPrefix(req.Path, "/images/")
		f.mu.Lock()
		_, existed := f.images[ref]
		delete(f.images, ref)
		f.mu.Unlock()
		if !existed {
			return seam.EngineResponse{Status: http.StatusNotFound, Body: []byte(`{"message":"no such image"}`)}, nil
		}
		return seam.EngineResponse{Status: http.StatusOK, Body: []byte(`{"Deleted":[]}`)}, nil
	}
	return seam.EngineResponse{Status: http.StatusNotFound, Body: []byte(`{"message":"unknown"}`)}, nil
}

// Stream 实现 seam.DockerTransport：按脚本回放 NDJSON 或挂起等待取消。
func (f *fakeBuildEngine) Stream(ctx context.Context, req seam.EngineRequest, onChunk func([]byte)) (seam.EngineResponse, error) {
	f.mu.Lock()
	f.streams = append(f.streams, fakeEngineStream{
		Method:      req.Method,
		Path:        req.Path,
		Query:       req.Query,
		DiscardBody: req.DiscardBody,
		MaxBytes:    req.MaxBytes,
		ContentType: req.ContentType,
	})
	var script fakeBuildScript
	if f.scriptFn != nil {
		script = f.scriptFn(req.Query)
	} else if len(f.scripts) > 0 {
		script = f.scripts[0]
		f.scripts = f.scripts[1:]
	} else {
		script = fakeBuildScript{Status: http.StatusOK, Lines: []string{"Step 1/2 : FROM alpine:3"}}
	}
	beforeStream := f.beforeStream
	f.mu.Unlock()
	if beforeStream != nil {
		beforeStream(req.Query)
	}

	if script.Block {
		<-ctx.Done()
		return seam.EngineResponse{}, ctx.Err()
	}
	for _, line := range script.Lines {
		payload, _ := json.Marshal(map[string]string{"stream": line + "\n"})
		onChunk(append(payload, '\n'))
	}
	if script.Status != http.StatusOK {
		payload, _ := json.Marshal(map[string]any{"errorDetail": map[string]string{"message": "engine build failure"}})
		onChunk(append(payload, '\n'))
		return seam.EngineResponse{Status: script.Status}, nil
	}
	// 成功路径：把产物镜像写进 fake 引擎（对齐真实 daemon 行为；标签含 slug 与任务）。
	if script.Status == http.StatusOK && !script.DisablePersist {
		if tags := req.Query["t"]; len(tags) > 0 {
			var labels map[string]string
			if raw := req.Query.Get("labels"); raw != "" {
				_ = json.Unmarshal([]byte(raw), &labels)
			}
			for _, ref := range tags {
				f.addImage(ref, "", labels)
			}
		}
	}
	return seam.EngineResponse{Status: script.Status}, nil
}

// recordedStreams 取 Stream 记录快照。
func (f *fakeBuildEngine) recordedStreams() []fakeEngineStream {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]fakeEngineStream(nil), f.streams...)
}

// ---------- 测试环境 ----------

// buildTestEnv 构建测试环境：真实文件系统工作区 + fake 引擎 + 注入时钟与 id 序列。
type buildTestEnv struct {
	handler  Handler
	manager  *BuildManager
	engine   *fakeBuildEngine
	registry *Registry
	mountDir string
	ids      []string
	// next 用原子计数：并发 Submit 用例里多个 goroutine 同时经 NewID 取号，
	// 普通int 递增会被 race 检测器判为测试假件自身的数据竞争。
	next atomic.Int64
}

// 固定时钟：tag 应派生为 20261004-073000-<id前4>。
var fixedBuildClock = func() time.Time { return time.Date(2026, 10, 4, 7, 30, 0, 0, time.UTC) }

func newBuildTestEnv(t *testing.T) *buildTestEnv {
	t.Helper()
	mountDir := testDir(t)
	stateDir := testDir(t)
	registry := &Registry{MountRoot: mountDir, RegistryPath: filepath.Join(stateDir, "container-apps.json")}
	engine := newFakeBuildEngine()
	env := &buildTestEnv{engine: engine, registry: registry, mountDir: mountDir}
	env.ids = []string{
		"11111111-1111-1111-1111-111111111111",
		"22222222-2222-2222-2222-222222222222",
		"33333333-3333-3333-3333-333333333333",
		"44444444-4444-4444-4444-444444444444",
	}
	manager := newBuildManager(BuildDeps{
		Engine:    engine,
		Policy:    func(context.Context, string) error { return nil },
		Registry:  registry,
		Now:       fixedBuildClock,
		NewID:     func() string { id := env.ids[(env.next.Add(1)-1)%int64(len(env.ids))]; return id },
		StateRoot: filepath.Join(stateDir, "state"),
		LogRoot:   filepath.Join(stateDir, "logs"),
		SpoolRoot: filepath.Join(stateDir, "tmp"),
	}, defaultBuildLimits())
	env.manager = manager
	env.handler = Handler{
		Registry:        registry,
		Time:            fixedBuildClock,
		EngineAvailable: true,
		Engine:          engine,
		Policy:          func(context.Context, string) error { return nil },
		Builds:          manager,
	}
	return env
}

// createApp 建一个工作区并写好 Dockerfile。
func (e *buildTestEnv) createApp(t *testing.T, slug string, dockerfile string) string {
	t.Helper()
	if _, err := e.registry.Create(slug, slug, fixedBuildClock()); err != nil {
		t.Fatal(err)
	}
	dir := WorkspaceDir(e.mountDir, slug)
	if err := os.WriteFile(filepath.Join(dir, "Dockerfile"), []byte(dockerfile), 0600); err != nil {
		t.Fatal(err)
	}
	return dir
}

// waitForBuildTerminal 轮询任务直到终态，并等 worker 完全收尾（cancel 表清空），
// 避免收尾写日志与临时目录清理竞态。
func waitForBuildTerminal(t *testing.T, m *BuildManager, slug, id string) BuildTask {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	var task BuildTask
	for time.Now().Before(deadline) {
		got, err := m.Get(slug, id)
		if err != nil {
			t.Fatalf("取任务失败：%v", err)
		}
		if !activeBuild(got.State) {
			task = got
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if task.ID == "" {
		t.Fatal("任务未在时限内到达终态")
	}
	for time.Now().Before(deadline) {
		m.mu.Lock()
		_, running := m.cancel[id]
		m.mu.Unlock()
		if !running {
			return task
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("任务收尾未在时限内完成")
	return BuildTask{}
}

// ---------- 任务机 ----------

func TestBuildTaskSucceedsDockerfileMode(t *testing.T) {
	env := newBuildTestEnv(t)
	env.createApp(t, "myapp", "FROM alpine:3\nRUN echo hi\n")
	task, _, err := env.manager.Submit(context.Background(), WorkspaceDir(env.mountDir, "myapp"), "myapp", BuildPlanInput{
		Mode:       buildModeDockerfile,
		RequestID:  "aaaaaaaa-1111-2222-3333-444444444444",
		Target:     "app",
		Dockerfile: "Dockerfile",
		Context:    ".",
	})
	if err != nil {
		t.Fatal(err)
	}
	final := waitForBuildTerminal(t, env.manager, "myapp", task.ID)
	if final.State != BuildStateSucceeded || final.Stage != "构建成功" {
		t.Fatalf("应成功：%+v", final)
	}
	if final.Error != "" {
		t.Fatalf("成功任务不得带错误：%q", final.Error)
	}
	// tag 形状：UTC 提交时刻 + 任务 id 前 4 字符。
	wantTag := "20261004-073000-" + task.ID[:4]
	if !buildTagPattern.MatchString(wantTag) {
		t.Fatalf("tag 形状不符：%s", wantTag)
	}
	if len(final.Results) != 1 {
		t.Fatalf("应有一条结果：%+v", final.Results)
	}
	result := final.Results[0]
	if result.Target != "app" || result.Repository != "elysian/myapp/app" || result.Tag != wantTag || result.State != BuildStateSucceeded || result.Error != "" {
		t.Fatalf("结果不符：%+v", result)
	}
	if !strings.HasPrefix(result.ImageID, "sha256:") {
		t.Fatalf("镜像 ID 应为 inspect 回查值：%q", result.ImageID)
	}
	// 引擎调用形状：version=1 钉 classic、双 t 标签、限额参数、标签、流参数。
	streams := env.engine.recordedStreams()
	if len(streams) != 1 {
		t.Fatalf("应有一次构建流：%+v", streams)
	}
	stream := streams[0]
	if stream.Path != "/build" || stream.Method != http.MethodPost {
		t.Fatalf("应 POST /build：%+v", stream)
	}
	if stream.Query.Get("version") != "1" {
		t.Fatalf("必须显式 version=1（classic 构建器）：%v", stream.Query)
	}
	tags := stream.Query["t"]
	if len(tags) != 2 || tags[0] != "elysian/myapp/app:"+wantTag || tags[1] != "elysian/myapp/app:latest" {
		t.Fatalf("应打不可变 tag 与 latest 双标签：%v", tags)
	}
	if stream.Query.Get("memory") != "2147483648" || stream.Query.Get("cpuquota") != "200000" || stream.Query.Get("cpuperiod") != "100000" {
		t.Fatalf("classic 限额参数缺失：%v", stream.Query)
	}
	if stream.Query.Get("rm") != "true" || stream.Query.Get("q") != "false" {
		t.Fatalf("rm/q 参数不符：%v", stream.Query)
	}
	if stream.Query.Get("dockerfile") != "Dockerfile" {
		t.Fatalf("dockerfile 应为相对 context 路径：%v", stream.Query)
	}
	var labels map[string]string
	if err := json.Unmarshal([]byte(stream.Query.Get("labels")), &labels); err != nil {
		t.Fatalf("labels 应为 JSON：%v", err)
	}
	if labels[managedLabelKey] != "true" || labels["elysian.build.task"] != task.ID {
		t.Fatalf("管理标签不符：%v", labels)
	}
	if _, has := stream.Query["buildargs"]; has {
		t.Fatalf("dockerfile 模式无 args 不应带 buildargs：%v", stream.Query)
	}
	if !stream.DiscardBody || stream.MaxBytes != 0 || stream.ContentType != "application/x-tar" {
		t.Fatalf("流参数不符（DiscardBody/无 MaxBytes/tar 体）：%+v", stream)
	}
	// 日志落盘且含 stream 行。
	rawLog, err := os.ReadFile(env.manager.LogPath(task.ID))
	if err != nil || !strings.Contains(string(rawLog), "Step 1/2 : FROM alpine:3") {
		t.Fatalf("构建日志应含流输出：%v %s", err, rawLog)
	}
	// spool 已清理。
	if _, err = os.Stat(spoolTarPath(env.manager.deps.SpoolRoot, task.ID)); !os.IsNotExist(err) {
		t.Fatal("终态后 spool tar 应删除")
	}
}

func TestBuildTaskObjectKeyOrder(t *testing.T) {
	env := newBuildTestEnv(t)
	env.createApp(t, "myapp", "FROM alpine:3\n")
	task, _, err := env.manager.Submit(context.Background(), WorkspaceDir(env.mountDir, "myapp"), "myapp", BuildPlanInput{
		Mode:       buildModeDockerfile,
		RequestID:  "aaaaaaaa-1111-2222-3333-444444444444",
		Dockerfile: "Dockerfile",
		Context:    ".",
	})
	if err != nil {
		t.Fatal(err)
	}
	waitForBuildTerminal(t, env.manager, "myapp", task.ID)
	final, err := env.manager.Get("myapp", task.ID)
	if err != nil {
		t.Fatal(err)
	}
	body := marshalForTest(t, final)
	wantPrefix := `{"id":` + `"` + task.ID + `"` + `,"slug":"myapp","mode":"dockerfile","requestId":"aaaaaaaa-1111-2222-3333-444444444444","state":"succeeded","stage":"构建成功","createdAt":"2026-10-04T07:30:00Z","updatedAt":"2026-10-04T07:30:00Z"`
	if !strings.HasPrefix(body, wantPrefix) {
		t.Fatalf("任务对象键序不符：%s", body)
	}
	if !strings.Contains(body, `"input":{"mode":"dockerfile","requestId":"aaaaaaaa-1111-2222-3333-444444444444","target":"app","dockerfile":"Dockerfile","context":"."}`) {
		t.Fatalf("input 存档不符：%s", body)
	}
	if !strings.Contains(body, `"results":[{"target":"app","repository":"elysian/myapp/app","tag":"20261004-073000-1111","imageId":"sha256:`) {
		t.Fatalf("results 键序不符：%s", body)
	}
	if !strings.HasSuffix(body, `,"error":""}`) {
		t.Fatalf("应以 error 收尾：%s", body)
	}
}

func TestBuildTaskComposeTargetPassthrough(t *testing.T) {
	env := newBuildTestEnv(t)
	dir := env.createApp(t, "mt", "FROM alpine:3 AS base\nFROM base AS runtime\n")
	if err := os.WriteFile(filepath.Join(dir, "compose.yml"), []byte(strings.Join([]string{
		"services:",
		"  web:",
		"    build:",
		"      context: .",
		"      target: runtime",
		"      args:",
		"        VERSION: 9.9.9",
	}, "\n")), 0600); err != nil {
		t.Fatal(err)
	}
	task, _, err := env.manager.Submit(context.Background(), dir, "mt", BuildPlanInput{
		Mode:      buildModeCompose,
		RequestID: "aaaaaaaa-1111-2222-3333-444444444444",
		Compose:   "compose.yml",
	})
	if err != nil {
		t.Fatal(err)
	}
	waitForBuildTerminal(t, env.manager, "mt", task.ID)
	streams := env.engine.recordedStreams()
	if len(streams) != 1 {
		t.Fatalf("应有一次构建流：%+v", streams)
	}
	query := streams[0].Query
	if query.Get("target") != "runtime" {
		t.Fatalf("compose build.target 应透传引擎：%v", query)
	}
	var args map[string]string
	if err := json.Unmarshal([]byte(query.Get("buildargs")), &args); err != nil || args["VERSION"] != "9.9.9" {
		t.Fatalf("compose args 应以 buildargs 透传：%v %v", args, err)
	}
}

func marshalForTest(t *testing.T, v any) string {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func TestBuildTaskComposeMultiServiceFailure(t *testing.T) {
	env := newBuildTestEnv(t)
	dir := env.createApp(t, "stack", "FROM alpine:3\n")
	if err := os.WriteFile(filepath.Join(dir, "compose.yml"), []byte(strings.Join([]string{
		"services:",
		"  web:",
		"    build:",
		"      context: .",
		"  api:",
		"    build:",
		"      context: .",
	}, "\n")), 0600); err != nil {
		t.Fatal(err)
	}
	// 第一次构建成功、第二次失败：web 进 results 且镜像保留，api 失败且任务 error 为
	// 首个失败原文，后续（若有）不再构建。
	env.engine.scripts = []fakeBuildScript{
		{Status: http.StatusOK, Lines: []string{"Step 1/2 : FROM alpine:3", "Successfully built abc"}},
		{Status: http.StatusInternalServerError},
	}
	task, _, err := env.manager.Submit(context.Background(), dir, "stack", BuildPlanInput{
		Mode:      buildModeCompose,
		RequestID: "aaaaaaaa-1111-2222-3333-444444444444",
		Compose:   "compose.yml",
	})
	if err != nil {
		t.Fatal(err)
	}
	final := waitForBuildTerminal(t, env.manager, "stack", task.ID)
	if final.State != BuildStateFailed || final.Stage != "构建失败" {
		t.Fatalf("应失败：%+v", final)
	}
	if final.Error != "构建失败：engine build failure" {
		t.Fatalf("任务级 error 应为首个失败原文：%q", final.Error)
	}
	if len(final.Results) != 2 {
		t.Fatalf("应有两条结果（web 成功 + api 失败）：%+v", final.Results)
	}
	if final.Results[0].Target != "web" || final.Results[0].State != BuildStateSucceeded {
		t.Fatalf("web 应成功：%+v", final.Results[0])
	}
	if final.Results[1].Target != "api" || final.Results[1].State != BuildStateFailed || final.Results[1].Error != "构建失败：engine build failure" {
		t.Fatalf("api 应失败并带原因：%+v", final.Results[1])
	}
	// 已完成 target 的镜像保留（失败任务不 GC）。
	if _, ok := env.engine.imageID("elysian/stack/web:latest"); !ok {
		t.Fatal("失败任务中已完成 target 的镜像必须保留")
	}
	// 三个服务时首服务失败：后续两个都不进 results。
	env2 := newBuildTestEnv(t)
	dir2 := env2.createApp(t, "stack2", "FROM alpine:3\n")
	if err = os.WriteFile(filepath.Join(dir2, "compose.yml"), []byte(strings.Join([]string{
		"services:",
		"  a:",
		"    build:",
		"      context: .",
		"  b:",
		"    build:",
		"      context: .",
		"  c:",
		"    build:",
		"      context: .",
	}, "\n")), 0600); err != nil {
		t.Fatal(err)
	}
	env2.engine.scripts = []fakeBuildScript{{Status: http.StatusInternalServerError}}
	task2, _, err := env2.manager.Submit(context.Background(), dir2, "stack2", BuildPlanInput{
		Mode:      buildModeCompose,
		RequestID: "aaaaaaaa-1111-2222-3333-444444444444",
		Compose:   "compose.yml",
	})
	if err != nil {
		t.Fatal(err)
	}
	final2 := waitForBuildTerminal(t, env2.manager, "stack2", task2.ID)
	if final2.State != BuildStateFailed || len(final2.Results) != 1 || final2.Results[0].Target != "a" {
		t.Fatalf("首服务失败后后续不得再构建：%+v", final2.Results)
	}
}

func TestSubmitRequestIDIdempotency(t *testing.T) {
	env := newBuildTestEnv(t)
	dir := env.createApp(t, "myapp", "FROM alpine:3\n")
	ctx := context.Background()
	input := BuildPlanInput{
		Mode:       buildModeDockerfile,
		RequestID:  "aaaaaaaa-1111-2222-3333-444444444444",
		Dockerfile: "Dockerfile",
		Context:    ".",
		Target:     "app",
	}
	first, _, err := env.manager.Submit(ctx, dir, "myapp", input)
	if err != nil {
		t.Fatal(err)
	}
	waitForBuildTerminal(t, env.manager, "myapp", first.ID)
	// 同参幂等返回原任务。
	again, idempotent, err := env.manager.Submit(ctx, dir, "myapp", input)
	if err != nil || !idempotent || again.ID != first.ID {
		t.Fatalf("同参应幂等返回原任务：%v %v %v", again.ID, idempotent, err)
	}
	// 异参 400。
	other := input
	other.Target = "side"
	if _, _, err = env.manager.Submit(ctx, dir, "myapp", other); err == nil || !strings.Contains(err.Error(), "请求标识已用于其他构建") {
		t.Fatalf("异参应 400：%v", err)
	}
	// 无效 requestId 400。
	bad := input
	bad.RequestID = "not-a-uuid"
	if _, _, err = env.manager.Submit(ctx, dir, "myapp", bad); err == nil || !strings.Contains(err.Error(), "请求标识无效") {
		t.Fatalf("无效 requestId 应 400：%v", err)
	}
}

func TestSubmitWorkspaceActiveConflict(t *testing.T) {
	env := newBuildTestEnv(t)
	dir := env.createApp(t, "busy", "FROM alpine:3\n")
	// 挂起构建占住工作区与 worker。
	env.engine.scriptFn = func(url.Values) fakeBuildScript { return fakeBuildScript{Block: true} }
	first, _, err := env.manager.Submit(context.Background(), dir, "busy", BuildPlanInput{
		Mode:       buildModeDockerfile,
		RequestID:  "aaaaaaaa-1111-2222-3333-444444444444",
		Dockerfile: "Dockerfile",
		Context:    ".",
	})
	if err != nil {
		t.Fatal(err)
	}
	waitForState(t, env.manager, "busy", first.ID, BuildStateBuilding)
	if _, _, err = env.manager.Submit(context.Background(), dir, "busy", BuildPlanInput{
		Mode:       buildModeDockerfile,
		RequestID:  "bbbbbbbb-1111-2222-3333-444444444444",
		Dockerfile: "Dockerfile",
		Context:    ".",
	}); err == nil || !strings.Contains(err.Error(), "工作区已有进行中的构建任务") {
		t.Fatalf("同工作区活跃任务应 409：%v", err)
	}
	if err = env.manager.Cancel("busy", first.ID); err != nil {
		t.Fatal(err)
	}
	final := waitForBuildTerminal(t, env.manager, "busy", first.ID)
	if final.State != BuildStateCancelled || final.Stage != "已取消" || final.Error != "构建已取消" {
		t.Fatalf("取消收口不符：%+v", final)
	}
}

func waitForState(t *testing.T, m *BuildManager, slug, id, state string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		task, err := m.Get(slug, id)
		if err != nil {
			t.Fatal(err)
		}
		if task.State == state {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("任务未进入 %s 态", state)
}

func TestCancelQueuedAndTerminal(t *testing.T) {
	env := newBuildTestEnv(t)
	dir := env.createApp(t, "q", "FROM alpine:3\n")
	env.engine.scriptFn = func(url.Values) fakeBuildScript { return fakeBuildScript{Block: true} }
	blocking, _, err := env.manager.Submit(context.Background(), dir, "q", BuildPlanInput{
		Mode:       buildModeDockerfile,
		RequestID:  "aaaaaaaa-1111-2222-3333-444444444444",
		Dockerfile: "Dockerfile",
		Context:    ".",
	})
	if err != nil {
		t.Fatal(err)
	}
	waitForState(t, env.manager, "q", blocking.ID, BuildStateBuilding)
	// 排队场景用另一工作区构造（同工作区会被互斥拦住）。
	env.createApp(t, "q2", "FROM alpine:3\n")
	queuedTask, _, err := env.manager.Submit(context.Background(), WorkspaceDir(env.mountDir, "q2"), "q2", BuildPlanInput{
		Mode:       buildModeDockerfile,
		RequestID:  "cccccccc-1111-2222-3333-444444444444",
		Dockerfile: "Dockerfile",
		Context:    ".",
	})
	if err != nil {
		t.Fatal(err)
	}
	waitForState(t, env.manager, "q2", queuedTask.ID, BuildStateQueued)
	if err = env.manager.Cancel("q2", queuedTask.ID); err != nil {
		t.Fatal(err)
	}
	cancelled := waitForBuildTerminal(t, env.manager, "q2", queuedTask.ID)
	if cancelled.State != BuildStateCancelled || cancelled.Stage != "已取消" {
		t.Fatalf("排队取消应直接终态：%+v", cancelled)
	}
	// 终态再取消 409。
	if err = env.manager.Cancel("q2", queuedTask.ID); err == nil || !strings.Contains(err.Error(), "构建已结束，无法取消") {
		t.Fatalf("终态取消应 409：%v", err)
	}
	// 不存在的任务 404。
	if err = env.manager.Cancel("q2", "eeeeeeee-1111-2222-3333-444444444444"); err == nil || !strings.Contains(err.Error(), "构建任务不存在") {
		t.Fatalf("未知任务应 404：%v", err)
	}
	// 收口挂起任务并等它终态（避免清理临时目录与写日志竞态）。
	if err := env.manager.Cancel("q", blocking.ID); err != nil {
		t.Fatal(err)
	}
	waitForBuildTerminal(t, env.manager, "q", blocking.ID)
}

func TestSubmitRejectedWhenRepositoryOccupied(t *testing.T) {
	env := newBuildTestEnv(t)
	dir := env.createApp(t, "occ", "FROM alpine:3\n")
	// 预置一个不带管理标签的同仓库镜像：提交 409、preview 报占用。
	env.engine.addImage("elysian/occ/app:latest", "sha256:"+"deadbeef"+strings.Repeat("0", 56), nil)
	_, _, err := env.manager.Submit(context.Background(), dir, "occ", BuildPlanInput{
		Mode:       buildModeDockerfile,
		RequestID:  "aaaaaaaa-1111-2222-3333-444444444444",
		Dockerfile: "Dockerfile",
		Context:    ".",
	})
	if err == nil || !strings.Contains(err.Error(), "镜像 elysian/occ/app 已被非面板构建的镜像占用，请换一个目标名或先删除该镜像") {
		t.Fatalf("占用应 409 逐字文案：%v", err)
	}
	preview, err := PreviewDockerfileBuild(context.Background(), env.engine, dir, "occ", BuildPlanInput{
		Mode: buildModeDockerfile, Dockerfile: "Dockerfile", Context: ".",
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !preview.RepositoryOccupied {
		t.Fatal("preview 应报占用")
	}
	joined := strings.Join(preview.Warnings, "\n")
	if !strings.Contains(joined, "镜像 elysian/occ/app 已被非面板构建的镜像占用，构建将被拒绝") {
		t.Fatalf("占用警告逐字不符：%s", joined)
	}
}

func TestGCKeepsTwoImmutableTags(t *testing.T) {
	env := newBuildTestEnv(t)
	env.createApp(t, "gc", "FROM alpine:3\n")
	// 预置三个旧 tag（面板管理）+ latest。
	managed := map[string]string{managedLabelKey: "true"}
	env.engine.addImage("elysian/gc/app:20260101-000000-aaaa", "", managed)
	env.engine.addImage("elysian/gc/app:20260202-000000-bbbb", "", managed)
	env.engine.addImage("elysian/gc/app:20260303-000000-cccc", "", managed)
	env.engine.addImage("elysian/gc/app:latest", "", managed)
	task, _, err := env.manager.Submit(context.Background(), WorkspaceDir(env.mountDir, "gc"), "gc", BuildPlanInput{
		Mode:       buildModeDockerfile,
		RequestID:  "aaaaaaaa-1111-2222-3333-444444444444",
		Dockerfile: "Dockerfile",
		Context:    ".",
	})
	if err != nil {
		t.Fatal(err)
	}
	waitForBuildTerminal(t, env.manager, "gc", task.ID)
	// 保留：新 tag（20261004-073000-1111）+ 最近的 20260303 + latest。
	for _, kept := range []string{
		"elysian/gc/app:20261004-073000-1111",
		"elysian/gc/app:20260303-000000-cccc",
		"elysian/gc/app:latest",
	} {
		if _, ok := env.engine.imageID(kept); !ok {
			t.Errorf("应保留 %s", kept)
		}
	}
	// 删除：更早的两个面板旧 tag。
	for _, removed := range []string{"elysian/gc/app:20260101-000000-aaaa", "elysian/gc/app:20260202-000000-bbbb"} {
		if _, ok := env.engine.imageID(removed); ok {
			t.Errorf("应回收 %s", removed)
		}
	}
}

func TestGCSkipsUnmanagedImages(t *testing.T) {
	env := newBuildTestEnv(t)
	// 同仓库出现无管理标签的镜像时（面板构建之后用户手动 tag 进来的），GC 只动
	// 面板管理的 tag，用户镜像原样保留。
	managed := map[string]string{managedLabelKey: "true"}
	env.engine.addImage("elysian/skip/app:20260101-000000-aaaa", "", managed)
	env.engine.addImage("elysian/skip/app:20260202-000000-bbbb", "", managed)
	env.engine.addImage("elysian/skip/app:20260303-000000-cccc", "", managed)
	env.engine.addImage("elysian/skip/app:usermade", "", nil)
	env.manager.collectRepository(context.Background(), "task-id", "elysian/skip/app")
	if _, ok := env.engine.imageID("elysian/skip/app:usermade"); !ok {
		t.Fatal("无管理标签的镜像不得被 GC")
	}
	if _, ok := env.engine.imageID("elysian/skip/app:20260303-000000-cccc"); !ok {
		t.Fatal("最新面板 tag 应保留")
	}
	if _, ok := env.engine.imageID("elysian/skip/app:20260101-000000-aaaa"); ok {
		t.Fatal("更早的面板 tag 应回收")
	}
}

func TestInspectFailures(t *testing.T) {
	// inspect 404（Stream 成功但不落镜像）：构建完成但未找到产物镜像。
	env := newBuildTestEnv(t)
	env.createApp(t, "nolook", "FROM alpine:3\n")
	env.engine.scriptFn = func(url.Values) fakeBuildScript {
		return fakeBuildScript{Status: http.StatusOK, DisablePersist: true, Lines: []string{"Successfully built"}}
	}
	task, _, err := env.manager.Submit(context.Background(), WorkspaceDir(env.mountDir, "nolook"), "nolook", BuildPlanInput{
		Mode:       buildModeDockerfile,
		RequestID:  "aaaaaaaa-1111-2222-3333-444444444444",
		Dockerfile: "Dockerfile",
		Context:    ".",
	})
	if err != nil {
		t.Fatal(err)
	}
	final := waitForBuildTerminal(t, env.manager, "nolook", task.ID)
	if final.State != BuildStateFailed || final.Error != "构建完成但未找到产物镜像" {
		t.Fatalf("回查不到应按未找到产物失败：%+v", final)
	}
	// inspect 引擎错误：构建完成后回查产物镜像失败。
	env2 := newBuildTestEnv(t)
	env2.createApp(t, "boom", "FROM alpine:3\n")
	env2.engine.inspectFail = true
	task2, _, err := env2.manager.Submit(context.Background(), WorkspaceDir(env2.mountDir, "boom"), "boom", BuildPlanInput{
		Mode:       buildModeDockerfile,
		RequestID:  "aaaaaaaa-1111-2222-3333-444444444444",
		Dockerfile: "Dockerfile",
		Context:    ".",
	})
	if err != nil {
		t.Fatal(err)
	}
	final2 := waitForBuildTerminal(t, env2.manager, "boom", task2.ID)
	if final2.State != BuildStateFailed || !strings.HasPrefix(final2.Error, "构建完成后回查产物镜像失败") {
		t.Fatalf("inspect 引擎错误应按回查失败：%+v", final2)
	}
}

func TestBuildImageTimeoutFailsTask(t *testing.T) {
	env := newBuildTestEnv(t)
	env.createApp(t, "slow", "FROM alpine:3\n")
	// 注入非缺省单镜像时限：终态文案按注入时限渲染而非硬编码「20 分钟」。
	env.manager.limits.ImageTimeout = 2 * time.Second
	env.engine.scriptFn = func(url.Values) fakeBuildScript { return fakeBuildScript{Block: true} }
	task, _, err := env.manager.Submit(context.Background(), WorkspaceDir(env.mountDir, "slow"), "slow", BuildPlanInput{
		Mode:       buildModeDockerfile,
		RequestID:  "aaaaaaaa-1111-2222-3333-444444444444",
		Dockerfile: "Dockerfile",
		Context:    ".",
	})
	if err != nil {
		t.Fatal(err)
	}
	final := waitForBuildTerminal(t, env.manager, "slow", task.ID)
	if final.State != BuildStateFailed || final.Error != "构建超时（2 秒），已中止" {
		t.Fatalf("单镜像超时应按注入时限渲染文案：%+v", final)
	}
}

// 完善性审查员-6：限额时长的中文渲染——整分钟「N 分钟」、不足一分钟「N 秒」，
// 缺省值渲染与 ADR-0021 引用的缺省句逐字一致。
func TestFormatDurationLimit(t *testing.T) {
	cases := []struct {
		d    time.Duration
		want string
	}{
		{90 * time.Second, "90 秒"},
		{2 * time.Second, "2 秒"},
		{1200 * time.Second, "20 分钟"},
		{3600 * time.Second, "60 分钟"},
		{90*time.Second + 500*time.Millisecond, "90 秒"},
	}
	for _, tc := range cases {
		if got := formatDurationLimit(tc.d); got != tc.want {
			t.Errorf("formatDurationLimit(%v) = %q，期望 %q", tc.d, got, tc.want)
		}
	}
	if got := envLimitsTaskTimeoutText(); got != "构建任务超时（60 分钟），已中止" {
		t.Fatalf("缺省任务时限文案应逐字不变：%q", got)
	}
	if got := envLimitsImageTimeoutText(); got != "构建超时（20 分钟），已中止" {
		t.Fatalf("缺省镜像时限文案应逐字不变：%q", got)
	}
}

func envLimitsTaskTimeoutText() string {
	m := &BuildManager{limits: defaultBuildLimits()}
	return m.taskTimeoutError()
}

func envLimitsImageTimeoutText() string {
	m := &BuildManager{limits: defaultBuildLimits()}
	return m.imageTimeoutError()
}

// 执行安全审查员-1：权威 FROM 预检读 tar 快照——打包完成后磁盘 Dockerfile 被改写
// 成私网源，任务仍应成功（若读磁盘会被私网拒绝）。
func TestBuildTargetInspectsTarSnapshot(t *testing.T) {
	env := newBuildTestEnv(t)
	dir := env.createApp(t, "snap", "FROM alpine:3\n")
	env.engine.beforeStream = func(url.Values) {
		_ = os.WriteFile(filepath.Join(dir, "Dockerfile"), []byte("FROM registry.internal:5000/x:1\n"), 0600)
	}
	task, _, err := env.manager.Submit(context.Background(), dir, "snap", BuildPlanInput{
		Mode:       buildModeDockerfile,
		RequestID:  "aaaaaaaa-1111-2222-3333-444444444444",
		Dockerfile: "Dockerfile",
		Context:    ".",
	})
	if err != nil {
		t.Fatal(err)
	}
	final := waitForBuildTerminal(t, env.manager, "snap", task.ID)
	if final.State != BuildStateSucceeded {
		t.Fatalf("权威预检应基于 tar 快照而非磁盘新内容：%+v", final)
	}
	// 对照：磁盘预检路径（提交时）对私网仍然敏感——把磁盘改回私网后提交新任务
	// 应被拒，证明预检没有整体失效（env 缺省 policy 放行，这里换成拒绝型）。
	env.manager.deps.Policy = func(context.Context, string) error {
		return errors.New("镜像源无法解析为公网地址")
	}
	_, _, err = env.manager.Submit(context.Background(), dir, "snap", BuildPlanInput{
		Mode:       buildModeDockerfile,
		RequestID:  "bbbbbbbb-1111-2222-3333-444444444444",
		Dockerfile: "Dockerfile",
		Context:    ".",
	})
	if err == nil || !strings.Contains(err.Error(), "镜像源无法解析为公网地址") {
		t.Fatalf("磁盘侧早期预检仍应拒绝私网源：%v", err)
	}
}

// 接口安全审查员-1：并发 Submit 下「同工作区活跃唯一」与 requestId 幂等不被
// 无锁引擎往返的窗口破坏。
func TestSubmitConcurrentWorkspaceUniqueness(t *testing.T) {
	env := newBuildTestEnv(t)
	dir := env.createApp(t, "race", "FROM alpine:3\n")
	env.engine.scriptFn = func(url.Values) fakeBuildScript { return fakeBuildScript{Block: true} }
	results := make(chan error, 2)
	ids := make(chan string, 2)
	for _, requestID := range []string{"aaaaaaaa-1111-2222-3333-444444444444", "bbbbbbbb-1111-2222-3333-444444444444"} {
		go func(id string) {
			task, _, err := env.manager.Submit(context.Background(), dir, "race", BuildPlanInput{
				Mode:       buildModeDockerfile,
				RequestID:  id,
				Dockerfile: "Dockerfile",
				Context:    ".",
			})
			if err == nil {
				ids <- task.ID
			}
			results <- err
		}(requestID)
	}
	first := <-results
	second := <-results
	successes := 0
	for _, err := range []error{first, second} {
		if err == nil {
			successes++
		} else if !strings.Contains(err.Error(), "工作区已有进行中的构建任务") {
			t.Fatalf("并发落败方应为同工作区 409 逐字文案：%v", err)
		}
	}
	if successes != 1 {
		t.Fatalf("并发同 slug 提交应恰一个成功，实际 %d", successes)
	}
	taskID := <-ids
	if err := env.manager.Cancel("race", taskID); err != nil {
		t.Fatal(err)
	}
	waitForBuildTerminal(t, env.manager, "race", taskID)
}

func TestSubmitConcurrentSameRequestIDIdempotent(t *testing.T) {
	env := newBuildTestEnv(t)
	dir := env.createApp(t, "idem", "FROM alpine:3\n")
	env.engine.scriptFn = func(url.Values) fakeBuildScript { return fakeBuildScript{Block: true} }
	const requestID = "aaaaaaaa-1111-2222-3333-444444444444"
	type outcome struct {
		task       BuildTask
		idempotent bool
		err        error
	}
	outcomes := make(chan outcome, 2)
	for i := 0; i < 2; i++ {
		go func() {
			task, idempotent, err := env.manager.Submit(context.Background(), dir, "idem", BuildPlanInput{
				Mode:       buildModeDockerfile,
				RequestID:  requestID,
				Dockerfile: "Dockerfile",
				Context:    ".",
			})
			outcomes <- outcome{task: task, idempotent: idempotent, err: err}
		}()
	}
	first := <-outcomes
	second := <-outcomes
	for _, o := range []outcome{first, second} {
		if o.err != nil {
			t.Fatalf("同 requestId 同参并发都应成功：%v", o.err)
		}
	}
	if first.task.ID != second.task.ID {
		t.Fatalf("两个调用方应拿到同一任务：%s vs %s", first.task.ID, second.task.ID)
	}
	// 只建了一个任务文件。
	files, err := filepath.Glob(filepath.Join(env.manager.deps.StateRoot, "*.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 1 {
		t.Fatalf("应只落一个任务文件，实际 %d", len(files))
	}
	if err := env.manager.Cancel("idem", first.task.ID); err != nil {
		t.Fatal(err)
	}
	waitForBuildTerminal(t, env.manager, "idem", first.task.ID)
}

// 接口安全审查员-2：任务 JSON 落盘失败时回滚内存登记，不得留下恒真的 queued 残留。
func TestSubmitRollsBackWhenTaskPersistFails(t *testing.T) {
	env := newBuildTestEnv(t)
	dir := env.createApp(t, "persist", "FROM alpine:3\n")
	// 把任务目录指到一个普通文件上：AtomicJSON 的 MkdirAll 必然 ENOTDIR 失败
	//（用路径形状而不是目录权限，root 运行的门禁容器里 chmod 挡不住）。
	blocked := filepath.Join(testDir(t), "blocked-file")
	if err := os.WriteFile(blocked, []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	env.manager.deps.StateRoot = blocked
	_, _, err := env.manager.Submit(context.Background(), dir, "persist", BuildPlanInput{
		Mode:       buildModeDockerfile,
		RequestID:  "aaaaaaaa-1111-2222-3333-444444444444",
		Dockerfile: "Dockerfile",
		Context:    ".",
	})
	if err == nil {
		t.Fatal("落盘失败应返回错误")
	}
	if env.manager.HasActive("persist") {
		t.Fatal("回滚后不得残留活跃任务")
	}
	// 同 slug 再次 Submit 不被 409 拦（换回可写目录后能正常建任务）。
	env.manager.deps.StateRoot = filepath.Join(testDir(t), "state2")
	task, _, submitErr := env.manager.Submit(context.Background(), dir, "persist", BuildPlanInput{
		Mode:       buildModeDockerfile,
		RequestID:  "bbbbbbbb-1111-2222-3333-444444444444",
		Dockerfile: "Dockerfile",
		Context:    ".",
	})
	if submitErr != nil {
		t.Fatalf("回滚后再次提交不得 409：%v", submitErr)
	}
	waitForBuildTerminal(t, env.manager, "persist", task.ID)
}

// 接口安全审查员-3：删除工作区后的残留任务清理——活跃任务落 failed 固定句并停流。
func TestInterruptActiveAfterWorkspaceDelete(t *testing.T) {
	env := newBuildTestEnv(t)
	dir := env.createApp(t, "gone", "FROM alpine:3\n")
	env.engine.scriptFn = func(url.Values) fakeBuildScript { return fakeBuildScript{Block: true} }
	task, _, err := env.manager.Submit(context.Background(), dir, "gone", BuildPlanInput{
		Mode:       buildModeDockerfile,
		RequestID:  "aaaaaaaa-1111-2222-3333-444444444444",
		Dockerfile: "Dockerfile",
		Context:    ".",
	})
	if err != nil {
		t.Fatal(err)
	}
	waitForState(t, env.manager, "gone", task.ID, BuildStateBuilding)
	// 模拟 remove 的后半段：登记删除成功后中断残留任务。
	if err = env.registry.Delete("gone"); err != nil {
		t.Fatal(err)
	}
	env.manager.InterruptActive("gone", workspaceDeletedMessage)
	final := waitForBuildTerminal(t, env.manager, "gone", task.ID)
	if final.State != BuildStateFailed || final.Error != workspaceDeletedMessage || final.Stage != buildStageFailed {
		t.Fatalf("删除后残留任务应落 failed 固定句：%+v", final)
	}
	// worker 的取消竞态不得把首个终态覆盖成 cancelled。
	if final.State != BuildStateFailed {
		t.Fatalf("首个终态为准：%+v", final)
	}
	// 无任务的工作区调用静默无事。
	env.manager.InterruptActive("no-such", workspaceDeletedMessage)
}

func TestDeletedWorkspaceFailureBeforeInterruptUsesDomainMessage(t *testing.T) {
	env := newBuildTestEnv(t)
	dir := env.createApp(t, "deleted-queued", "FROM alpine:3\n")
	// Pin the worker before execution so deletion definitely wins the gap
	// between accepting the task and reopening its workspace.
	env.manager.workers <- struct{}{}
	task, _, err := env.manager.Submit(context.Background(), dir, "deleted-queued", BuildPlanInput{
		Mode: buildModeDockerfile, RequestID: "cccccccc-1111-2222-3333-444444444444", Dockerfile: "Dockerfile", Context: ".",
	})
	if err != nil {
		<-env.manager.workers
		t.Fatal(err)
	}
	if err = env.registry.Delete("deleted-queued"); err != nil {
		<-env.manager.workers
		t.Fatal(err)
	}
	<-env.manager.workers
	final := waitForBuildTerminal(t, env.manager, "deleted-queued", task.ID)
	if final.State != BuildStateFailed || final.Stage != buildStageFailed || final.Error != workspaceDeletedMessage {
		t.Fatalf("worker 先发现删除时也必须返回固定领域错误：%+v", final)
	}
	env.manager.InterruptActive("deleted-queued", workspaceDeletedMessage)
	if err = env.manager.mutate(task.ID, func(task *BuildTask) { task.State = BuildStateBuilding; task.Stage = "迟到的构建进度" }); !errors.Is(err, errBuildTaskTerminal) {
		t.Fatalf("终态不得接受迟到进度：%v", err)
	}
	env.manager.finishWith(task.ID, BuildStateCancelled, buildStageCancelled, buildErrCancelled)
	retained, err := env.manager.Get("deleted-queued", task.ID)
	if err != nil || retained.State != final.State || retained.Stage != final.Stage || retained.Error != final.Error || retained.UpdatedAt != final.UpdatedAt {
		t.Fatalf("迟到进度或取消覆盖了首个终态：%+v %v", retained, err)
	}
}

func TestRecoveryMarksInterrupted(t *testing.T) {
	stateDir := testDir(t)
	stateRoot := filepath.Join(stateDir, "state")
	spoolRoot := filepath.Join(stateDir, "tmp")
	if err := os.MkdirAll(stateRoot, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(spoolRoot, 0700); err != nil {
		t.Fatal(err)
	}
	building := BuildTask{
		ID: "11111111-1111-1111-1111-111111111111", Slug: "a", Mode: buildModeDockerfile,
		RequestID: "aaaaaaaa-1111-2222-3333-444444444444", State: BuildStateBuilding, Stage: "构建镜像 elysian/a/app",
		CreatedAt: "2026-10-04T07:00:00Z", UpdatedAt: "2026-10-04T07:01:00Z",
		Input:   BuildTaskInput{Mode: buildModeDockerfile, RequestID: "aaaaaaaa-1111-2222-3333-444444444444"},
		Results: []BuildResult{},
	}
	if err := writeBuildTaskJSON(filepath.Join(stateRoot, building.ID+".json"), &building); err != nil {
		t.Fatal(err)
	}
	spool := spoolTarPath(spoolRoot, building.ID)
	if err := os.WriteFile(spool, []byte("half"), 0600); err != nil {
		t.Fatal(err)
	}
	done := building
	done.ID = "22222222-2222-2222-2222-222222222222"
	done.State = BuildStateSucceeded
	done.Stage = "构建成功"
	if err := writeBuildTaskJSON(filepath.Join(stateRoot, done.ID+".json"), &done); err != nil {
		t.Fatal(err)
	}

	mountDir := testDir(t)
	manager := newBuildManager(BuildDeps{
		Engine:    newFakeBuildEngine(),
		Registry:  &Registry{MountRoot: mountDir},
		Now:       fixedBuildClock,
		StateRoot: stateRoot,
		LogRoot:   filepath.Join(stateDir, "logs"),
		SpoolRoot: spoolRoot,
	}, defaultBuildLimits())
	recovered, err := manager.Get("a", building.ID)
	if err != nil {
		t.Fatal(err)
	}
	if recovered.State != BuildStateInterrupted || recovered.Stage != "面板重启中断，未自动重新构建" {
		t.Fatalf("活跃任务应标 interrupted：%+v", recovered)
	}
	if _, err = os.Stat(spool); !os.IsNotExist(err) {
		t.Fatal("恢复时应清 spool")
	}
	kept, err := manager.Get("a", done.ID)
	if err != nil || kept.State != BuildStateSucceeded {
		t.Fatalf("终态任务不受恢复影响：%v", err)
	}
}

// writeBuildTaskJSON 测试辅助：直接写任务 JSON（不经 AtomicJSON 的目录副作用）。
func writeBuildTaskJSON(path string, task *BuildTask) error {
	raw, err := json.Marshal(task)
	if err != nil {
		return err
	}
	return os.WriteFile(path, raw, 0600)
}

func TestCleanupExpiredRemovesOldTerminalTasks(t *testing.T) {
	stateDir := testDir(t)
	stateRoot := filepath.Join(stateDir, "state")
	if err := os.MkdirAll(stateRoot, 0700); err != nil {
		t.Fatal(err)
	}
	old := BuildTask{
		ID: "11111111-1111-1111-1111-111111111111", Slug: "a", Mode: buildModeDockerfile,
		State: BuildStateSucceeded, Stage: "构建成功",
		CreatedAt: "2025-09-01T00:00:00Z", UpdatedAt: "2025-09-01T00:01:00Z",
		Input: BuildTaskInput{Mode: buildModeDockerfile, RequestID: "aaaaaaaa-1111-2222-3333-444444444444"}, Results: []BuildResult{},
	}
	if err := writeBuildTaskJSON(filepath.Join(stateRoot, old.ID+".json"), &old); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(stateDir, "logs"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stateDir, "logs", old.ID+".log"), []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	clock := time.Date(2026, 10, 4, 7, 30, 0, 0, time.UTC)
	manager := newBuildManager(BuildDeps{
		Engine:    newFakeBuildEngine(),
		Registry:  &Registry{MountRoot: testDir(t)},
		Now:       func() time.Time { return clock },
		StateRoot: stateRoot,
		LogRoot:   filepath.Join(stateDir, "logs"),
		SpoolRoot: filepath.Join(stateDir, "tmp"),
	}, defaultBuildLimits())
	if _, err := manager.Get("a", old.ID); err == nil {
		t.Fatal("31 天前的终态任务应被清理")
	}
	if _, err := os.Stat(filepath.Join(stateRoot, old.ID+".json")); !os.IsNotExist(err) {
		t.Fatal("任务 JSON 应删除")
	}
}

// ---------- NDJSON 解码 ----------

func TestBuildStreamDecoder(t *testing.T) {
	var lines []string
	decoder := newBuildStreamDecoder(func(line string) { lines = append(lines, line) })
	// 跨块切行 + stream 行 + error 行 + 未知行。
	decoder.onChunk([]byte(`{"stream":"Step 1/4 : FROM alp`))
	decoder.onChunk([]byte(`ine:3\n"}\n{"stream":" ---> abc\n"}`))
	decoder.onChunk([]byte("\n"))
	decoder.onChunk([]byte(`{"aux":{"ID":"sha256:xyz"}}` + "\n"))
	decoder.onChunk([]byte(`{"errorDetail":{"message":"front failed"}}` + "\n"))
	if message := decoder.errorMessage(); message != "front failed" {
		t.Fatalf("error 行应取 errorDetail.message：%q", message)
	}
	joined := strings.Join(lines, "\n")
	if !strings.Contains(joined, "Step 1/4 : FROM alpine:3") || !strings.Contains(joined, " ---> abc") {
		t.Fatalf("stream 行应写日志：%s", joined)
	}
	if !strings.Contains(joined, `{"aux":{"ID":"sha256:xyz"}}`) {
		t.Fatalf("未知行应原样入日志：%s", joined)
	}
	if strings.Contains(joined, "front failed") {
		t.Fatalf("error 行不得写普通日志：%s", joined)
	}
}

func TestBuildStreamDecoderTailError(t *testing.T) {
	decoder := newBuildStreamDecoder(func(string) {})
	long := strings.Repeat("{\"stream\":\"noise\"}\n", 20000)
	decoder.onChunk([]byte(long))
	decoder.onChunk([]byte(`{"errorDetail":{"message":"tail boom"}}` + "\n"))
	if message := decoder.tailError(); message != "tail boom" {
		t.Fatalf("应从原始尾提取错误：%q", message)
	}
	if len(decoder.tail) > 128*1024 {
		t.Fatalf("原始尾不得超 128 KiB：%d", len(decoder.tail))
	}
}

// 接口安全审查员-1：并发 Submit 的 check-then-act 回归——两个 goroutine 对同
// slug 不同 requestId 同时提交（都越过第一段锁、都做完无锁占用回查后竞争第二段
// 锁），第二段锁内的重查必须保证恰好一个成功、一个 409。
func TestSubmitConcurrentSameSlugExactlyOneWins(t *testing.T) {
	env := newBuildTestEnv(t)
	dir := env.createApp(t, "race", "FROM alpine:3\n")
	env.engine.scriptFn = func(url.Values) fakeBuildScript { return fakeBuildScript{Block: true} }
	const racers = 8
	results := make(chan error, racers)
	ids := make(chan string, racers)
	for i := 0; i < racers; i++ {
		go func(i int) {
			task, _, err := env.manager.Submit(context.Background(), dir, "race", BuildPlanInput{
				Mode:       buildModeDockerfile,
				RequestID:  fmt.Sprintf("aaaaaaaa-1111-2222-3333-%012d", i),
				Dockerfile: "Dockerfile",
				Context:    ".",
			})
			if err == nil {
				ids <- task.ID
			}
			results <- err
		}(i)
	}
	successes, conflicts, others := 0, 0, 0
	for i := 0; i < racers; i++ {
		err := <-results
		switch {
		case err == nil:
			successes++
		case strings.Contains(err.Error(), "工作区已有进行中的构建任务"):
			conflicts++
		default:
			others++
			t.Errorf("意外的错误：%v", err)
		}
	}
	if successes != 1 || conflicts != racers-1 || others != 0 {
		t.Fatalf("应恰好一个成功、其余 409：成功 %d 冲突 %d 其他 %d", successes, conflicts, others)
	}
	winner := <-ids
	waitForState(t, env.manager, "race", winner, BuildStateBuilding)
	if !env.manager.HasActive("race") {
		t.Fatal("胜者任务应处于活跃")
	}
	if err := env.manager.Cancel("race", winner); err != nil {
		t.Fatal(err)
	}
	waitForBuildTerminal(t, env.manager, "race", winner)
}

// 接口安全审查员-2：AtomicJSON 落盘失败的持锁回滚——任务不得残留（HasActive 恒真
// 会让 DELETE 与后续 Submit 恒 409），且再次 Submit 不被 409 挡（仍回同一个落盘错误）。
func TestSubmitRollsBackWhenPersistFails(t *testing.T) {
	mountDir := testDir(t)
	stateDir := testDir(t)
	// 把任务 JSON 目录占位成一个普通文件：CreateTemp 以它为目录必然失败。
	if err := os.WriteFile(filepath.Join(stateDir, "state"), []byte("not a dir"), 0600); err != nil {
		t.Fatal(err)
	}
	engine := newFakeBuildEngine()
	manager := newBuildManager(BuildDeps{
		Engine:    engine,
		Policy:    func(context.Context, string) error { return nil },
		Registry:  &Registry{MountRoot: mountDir, RegistryPath: filepath.Join(stateDir, "container-apps.json")},
		Now:       fixedBuildClock,
		NewID:     func() string { return "11111111-1111-1111-1111-111111111111" },
		StateRoot: filepath.Join(stateDir, "state"),
		LogRoot:   filepath.Join(stateDir, "logs"),
		SpoolRoot: filepath.Join(stateDir, "tmp"),
	}, defaultBuildLimits())
	workspace := filepath.Join(mountDir, "elysian", "apps", "rb")
	if err := os.MkdirAll(workspace, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspace, "Dockerfile"), []byte("FROM alpine:3\n"), 0600); err != nil {
		t.Fatal(err)
	}
	input := BuildPlanInput{
		Mode:       buildModeDockerfile,
		RequestID:  "aaaaaaaa-1111-2222-3333-444444444444",
		Dockerfile: "Dockerfile",
		Context:    ".",
	}
	if _, _, err := manager.Submit(context.Background(), workspace, "rb", input); err == nil {
		t.Fatal("落盘失败应使 Submit 失败")
	}
	if manager.HasActive("rb") {
		t.Fatal("回滚后不得残留活跃任务")
	}
	if rows := manager.List("rb"); len(rows) != 0 {
		t.Fatalf("回滚后任务表应为空：%+v", rows)
	}
	// 再次提交同一个 requestId：requestIndex 已回滚，不得报「已用于其他构建」或 409
	// 互斥，仍应回同一个落盘失败。
	_, _, err := manager.Submit(context.Background(), workspace, "rb", input)
	if err == nil {
		t.Fatal("落盘环境未变，再次提交仍应失败")
	}
	if strings.Contains(err.Error(), "请求标识已用于其他构建") || strings.Contains(err.Error(), "工作区已有进行中的构建任务") {
		t.Fatalf("回滚后不得被幂等或互斥挡住：%v", err)
	}
}
