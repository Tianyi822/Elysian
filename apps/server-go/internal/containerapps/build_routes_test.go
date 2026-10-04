package containerapps

import (
	"archive/tar"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ---------- 路由层构建端点 ----------

// 走路由层的请求辅助（复用既有 do 的同源形状）。

func TestBuildEndpointsUnavailableWithoutEngine(t *testing.T) {
	handler, mountRoot := newTestHandler(t)
	// 不注入引擎与任务机：六个构建端点整组 503。
	_ = handler
	_ = mountRoot
	targets := []struct{ method, path string }{
		{http.MethodPost, "/app/builds/preview"},
		{http.MethodPost, "/app/builds"},
		{http.MethodGet, "/app/builds"},
		{http.MethodGet, "/app/builds/11111111-1111-1111-1111-111111111111"},
		{http.MethodGet, "/app/builds/11111111-1111-1111-1111-111111111111/logs"},
		{http.MethodPost, "/app/builds/11111111-1111-1111-1111-111111111111/cancel"},
	}
	for _, target := range targets {
		response := do(t, handler, target.method, target.path, "application/json", []byte(`{}`))
		if response.Code != http.StatusServiceUnavailable {
			t.Fatalf("%s %s 应 503，实际 %d %s", target.method, target.path, response.Code, response.Body.String())
		}
		if !strings.Contains(response.Body.String(), "Docker 服务未就绪") {
			t.Fatalf("503 文案逐字不符：%s", response.Body.String())
		}
	}
	// 文件端点不受影响。
	files := do(t, handler, http.MethodGet, "/app/files", "", nil)
	if files.Code != http.StatusNotFound {
		// 工作区不存在 → 404（而不是 503）。
		t.Fatalf("文件端点不受引擎不可用影响，应 404，实际 %d", files.Code)
	}
}

func TestBuildRoutesPreviewAndErrors(t *testing.T) {
	env := newBuildTestEnv(t)
	dir := env.createApp(t, "rt", "FROM alpine:3\n")
	if err := os.WriteFile(filepath.Join(dir, "compose.yml"), []byte(strings.Join([]string{
		"services:",
		"  web:",
		"    build:",
		"      context: .",
		"    image: rt-web",
		"  db:",
		"    image: mariadb:11",
	}, "\n")), 0600); err != nil {
		t.Fatal(err)
	}

	// preview（dockerfile 模式）成功：形状与键序。
	preview := do(t, env.handler, http.MethodPost, "/rt/builds/preview", "application/json", []byte(`{"mode":"dockerfile","target":"app","dockerfile":"Dockerfile","context":"."}`))
	if preview.Code != http.StatusOK {
		t.Fatalf("preview 应 200，实际 %d %s", preview.Code, preview.Body.String())
	}
	body := preview.Body.String()
	want := `{"mode":"dockerfile","slug":"rt","target":"app","dockerfile":"Dockerfile","context":".","imageRepository":"elysian/rt/app","contextFiles":2,"contextBytes":` +
		fmt.Sprint(fileSize(t, filepath.Join(dir, "Dockerfile"))+fileSize(t, filepath.Join(dir, "compose.yml")))
	if !strings.HasPrefix(body, want) {
		t.Fatalf("preview 响应前缀不符：\n得到 %s\n期望 %s", body, want)
	}
	if !strings.Contains(body, `"repositoryOccupied":false,"warnings":[]}`) {
		t.Fatalf("preview 应收尾于占用与警告字段：%s", body)
	}

	// preview（compose 模式）：全部服务逐条、无 build 服务占位。
	previewCompose := do(t, env.handler, http.MethodPost, "/rt/builds/preview", "application/json", []byte(`{"mode":"compose","compose":"compose.yml"}`))
	if previewCompose.Code != http.StatusOK {
		t.Fatalf("compose preview 应 200：%d %s", previewCompose.Code, previewCompose.Body.String())
	}
	composeBody := previewCompose.Body.String()
	if !strings.Contains(composeBody, `"service":"web","hasBuild":true,"target":"web"`) {
		t.Fatalf("web 服务条目不符：%s", composeBody)
	}
	if !strings.Contains(composeBody, `"service":"db","hasBuild":false,"target":"","dockerfile":"","context":"","imageRepository":"","contextFiles":0,"contextBytes":0,"imageNameInCompose":"mariadb:11"`) {
		t.Fatalf("db 占位条目不符：%s", composeBody)
	}
	if !strings.Contains(composeBody, `"imageNameInCompose":"rt-web"`) {
		t.Fatalf("compose image 原样回显：%s", composeBody)
	}

	// 逐字错误断言。
	cases := []struct {
		name    string
		method  string
		path    string
		body    string
		want    int
		message string
	}{
		{"工作区不存在", http.MethodPost, "/ghost/builds/preview", `{"mode":"dockerfile"}`, http.StatusNotFound, "容器应用工作区不存在：ghost"},
		{"未知字段", http.MethodPost, "/rt/builds/preview", `{"mode":"dockerfile","extra":1}`, http.StatusBadRequest, "构建请求字段无效"},
		{"两模式互斥", http.MethodPost, "/rt/builds/preview", `{"mode":"dockerfile","compose":"compose.yml"}`, http.StatusBadRequest, "构建请求字段无效"},
		{"compose 模式带 target", http.MethodPost, "/rt/builds/preview", `{"mode":"compose","compose":"compose.yml","target":"x"}`, http.StatusBadRequest, "构建请求字段无效"},
		{"文件不存在", http.MethodPost, "/rt/builds/preview", `{"mode":"dockerfile","dockerfile":"nope","context":"."}`, http.StatusNotFound, "工作区内没有该文件：nope"},
		{"context 目录不存在", http.MethodPost, "/rt/builds/preview", `{"mode":"dockerfile","context":"./ghost"}`, http.StatusBadRequest, "构建上下文目录不存在：ghost"},
		{"Dockerfile 不在 context 内", http.MethodPost, "/rt/builds/preview", `{"mode":"dockerfile","dockerfile":"Dockerfile","context":"./compose-only"}`, http.StatusBadRequest, "Dockerfile 必须位于构建上下文目录内"},
		{"target 非法", http.MethodPost, "/rt/builds/preview", `{"mode":"dockerfile","target":"Bad","dockerfile":"Dockerfile","context":"."}`, http.StatusBadRequest, "镜像目标名只能由小写字母、数字、下划线和连字符组成，且以字母或数字开头"},
		{"compose 解析失败", http.MethodPost, "/rt/builds/preview", `{"mode":"compose","compose":"broken.yml"}`, http.StatusBadRequest, "compose 文件解析失败"},
		{"提交服务不存在", http.MethodPost, "/rt/builds", `{"mode":"compose","requestId":"aaaaaaaa-1111-2222-3333-444444444444","compose":"compose.yml","services":["ghost"]}`, http.StatusBadRequest, "服务不存在：ghost"},
		{"提交服务无 build", http.MethodPost, "/rt/builds", `{"mode":"compose","requestId":"aaaaaaaa-1111-2222-3333-444444444444","compose":"compose.yml","services":["db"]}`, http.StatusBadRequest, "服务没有 build 配置：db"},
		{"提交服务重复", http.MethodPost, "/rt/builds", `{"mode":"compose","requestId":"aaaaaaaa-1111-2222-3333-444444444444","compose":"compose.yml","services":["web","web"]}`, http.StatusBadRequest, "服务 web 重复提交"},
		{"requestId 无效", http.MethodPost, "/rt/builds", `{"mode":"dockerfile","requestId":"nope","dockerfile":"Dockerfile","context":"."}`, http.StatusBadRequest, "请求标识无效"},
		{"任务不存在", http.MethodGet, "/rt/builds/eeeeeeee-1111-2222-3333-444444444444", "", http.StatusNotFound, "构建任务不存在：eeeeeeee-1111-2222-3333-444444444444"},
		{"取消任务不存在", http.MethodPost, "/rt/builds/eeeeeeee-1111-2222-3333-444444444444/cancel", "", http.StatusNotFound, "构建任务不存在：eeeeeeee-1111-2222-3333-444444444444"},
	}
	// broken.yml：坏 YAML；compose-only 目录给「Dockerfile 不在 context 内」用例用。
	if err := os.WriteFile(filepath.Join(dir, "broken.yml"), []byte("services:\n  a: [1,\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "compose-only"), 0700); err != nil {
		t.Fatal(err)
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			response := do(t, env.handler, tc.method, tc.path, "application/json", []byte(tc.body))
			if response.Code != tc.want {
				t.Fatalf("应 %d，实际 %d %s", tc.want, response.Code, response.Body.String())
			}
			if !strings.Contains(response.Body.String(), tc.message) {
				t.Fatalf("文案逐字不符（应含 %q）：%s", tc.message, response.Body.String())
			}
		})
	}
}

func fileSize(t *testing.T, path string) int64 {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return info.Size()
}

func TestBuildRoutesSubmitListLogsCancel(t *testing.T) {
	env := newBuildTestEnv(t)
	env.createApp(t, "flow", "FROM alpine:3\n")
	submitted := do(t, env.handler, http.MethodPost, "/flow/builds", "application/json", []byte(`{"mode":"dockerfile","requestId":"aaaaaaaa-1111-2222-3333-444444444444","target":"app","dockerfile":"Dockerfile","context":"."}`))
	if submitted.Code != http.StatusAccepted {
		t.Fatalf("提交应 202，实际 %d %s", submitted.Code, submitted.Body.String())
	}
	var task BuildTask
	if err := json.Unmarshal(submitted.Body.Bytes(), &task); err != nil {
		t.Fatal(err)
	}
	waitForBuildTerminal(t, env.manager, "flow", task.ID)

	// 列表：no-store + 倒序 + builds 键。
	listed := do(t, env.handler, http.MethodGet, "/flow/builds", "", nil)
	if listed.Code != http.StatusOK {
		t.Fatalf("列表应 200：%d", listed.Code)
	}
	if cache := listed.Header().Get("Cache-Control"); cache != "no-store" {
		t.Fatalf("列表必须 no-store：%q", cache)
	}
	if !strings.Contains(listed.Body.String(), `"builds":[`) || !strings.Contains(listed.Body.String(), task.ID) {
		t.Fatalf("列表形状不符：%s", listed.Body.String())
	}

	// 单任务：no-store。
	got := do(t, env.handler, http.MethodGet, "/flow/builds/"+task.ID, "", nil)
	if got.Code != http.StatusOK || got.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("单任务应 200 且 no-store：%d", got.Code)
	}

	// 日志：offset 推进与 offset 无效。
	logs := do(t, env.handler, http.MethodGet, "/flow/builds/"+task.ID+"/logs?offset=0", "", nil)
	if logs.Code != http.StatusOK {
		t.Fatalf("日志应 200：%d %s", logs.Code, logs.Body.String())
	}
	if !strings.Contains(logs.Body.String(), `"lines":[`) || !strings.Contains(logs.Body.String(), `"next":`) || !strings.Contains(logs.Body.String(), `"total":`) {
		t.Fatalf("日志响应形状不符：%s", logs.Body.String())
	}
	badOffset := do(t, env.handler, http.MethodGet, "/flow/builds/"+task.ID+"/logs?offset=-1", "", nil)
	if badOffset.Code != http.StatusBadRequest || !strings.Contains(badOffset.Body.String(), "日志偏移无效") {
		t.Fatalf("负 offset 应 400：%d %s", badOffset.Code, badOffset.Body.String())
	}

	// 终态取消 409。
	cancelled := do(t, env.handler, http.MethodPost, "/flow/builds/"+task.ID+"/cancel", "", nil)
	if cancelled.Code != http.StatusConflict || !strings.Contains(cancelled.Body.String(), "构建已结束，无法取消") {
		t.Fatalf("终态取消应 409：%d %s", cancelled.Code, cancelled.Body.String())
	}

	// 删除工作区在活跃任务时被拦。
	env2 := newBuildTestEnv(t)
	env2.createApp(t, "busy", "FROM alpine:3\n")
	env2.engine.scriptFn = func(url.Values) fakeBuildScript { return fakeBuildScript{Block: true} }
	started := do(t, env2.handler, http.MethodPost, "/busy/builds", "application/json", []byte(`{"mode":"dockerfile","requestId":"aaaaaaaa-1111-2222-3333-444444444444","dockerfile":"Dockerfile","context":"."}`))
	if started.Code != http.StatusAccepted {
		t.Fatalf("前置提交失败：%d %s", started.Code, started.Body.String())
	}
	removed := do(t, env2.handler, http.MethodDelete, "/busy/", "", nil)
	if removed.Code != http.StatusConflict || !strings.Contains(removed.Body.String(), "工作区有进行中的构建任务，请先取消或等待完成") {
		t.Fatalf("活跃任务应拦删除：%d %s", removed.Code, removed.Body.String())
	}
	var busyTask BuildTask
	if err := json.Unmarshal(started.Body.Bytes(), &busyTask); err != nil {
		t.Fatal(err)
	}
	if err := env2.manager.Cancel("busy", busyTask.ID); err != nil {
		t.Fatal(err)
	}
	waitForBuildTerminal(t, env2.manager, "busy", busyTask.ID)
}

func TestBuildRoutesSameOriginGuard(t *testing.T) {
	env := newBuildTestEnv(t)
	env.createApp(t, "guard", "FROM alpine:3\n")
	request, _ := http.NewRequest(http.MethodPost, testOrigin+"/guard/builds/preview", strings.NewReader(`{"mode":"dockerfile"}`))
	request.Header.Set("Content-Type", "application/json")
	// 不带 Origin：写请求被 SameOriginGuard 拦。
	recorder := httptest.NewRecorder()
	env.handler.Router().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("无 Origin 写请求应 403，实际 %d", recorder.Code)
	}
}

// ---------- 上下文打包 ----------

func TestWriteContextTarOnlyRegularFiles(t *testing.T) {
	dir := testDir(t)
	if err := os.WriteFile(filepath.Join(dir, "Dockerfile"), []byte("FROM alpine:3\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "app.txt"), []byte("hello"), 0600); err != nil {
		t.Fatal(err)
	}
	// 符号链接文件与目录：不进 tar。
	outside := testDir(t)
	if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("leak"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(outside, "secret.txt"), filepath.Join(dir, "link.txt")); err != nil {
		t.Skipf("环境不支持符号链接：%v", err)
	}
	if err := os.Symlink(outside, filepath.Join(dir, "linkdir")); err != nil {
		t.Skipf("环境不支持符号链接：%v", err)
	}
	dest := filepath.Join(testDir(t), "ctx.tar")
	stat, err := writeContextTar(dir, dest)
	if err != nil {
		t.Fatal(err)
	}
	if stat.files != 2 || stat.bytes != int64(len("FROM alpine:3\n")+len("hello")) {
		t.Fatalf("统计只算普通文件：%+v", stat)
	}
	file, err := os.Open(dest)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	names := map[string]int64{}
	reader := tar.NewReader(file)
	for {
		header, headerErr := reader.Next()
		if headerErr == io.EOF {
			break
		}
		if headerErr != nil {
			t.Fatal(headerErr)
		}
		names[header.Name] = header.Size
	}
	if len(names) != 2 || names["Dockerfile"] != int64(len("FROM alpine:3\n")) || names["app.txt"] != int64(len("hello")) {
		t.Fatalf("tar 只应含两个普通文件：%v", names)
	}
	info, err := os.Stat(dest)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("spool tar 应 0600：%v %v", info, err)
	}
}

func TestWriteContextTarRejectsTooManyFiles(t *testing.T) {
	dir := testDir(t)
	for i := 0; i <= maxContextFiles; i++ {
		if err := os.WriteFile(filepath.Join(dir, fmt.Sprintf("f%04d.txt", i)), []byte("x"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	dest := filepath.Join(testDir(t), "ctx.tar")
	_, err := writeContextTar(dir, dest)
	if err == nil || err.Error() != "构建上下文文件数超过上限 512 个，已中止" {
		t.Fatalf("超文件数应按契约文案中止：%v", err)
	}
	if _, statErr := os.Stat(dest); !os.IsNotExist(statErr) {
		t.Fatal("超限后不得留下半成品 tar")
	}
}

func TestStatBuildContextBytesLimit(t *testing.T) {
	dir := testDir(t)
	if err := os.WriteFile(filepath.Join(dir, "Dockerfile"), []byte("FROM alpine:3\n"), 0600); err != nil {
		t.Fatal(err)
	}
	// 稀疏文件：申报大小超 128 MiB 而不占实空间。
	if err := os.WriteFile(filepath.Join(dir, "big.bin"), []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Truncate(filepath.Join(dir, "big.bin"), maxContextBytes+1); err != nil {
		t.Fatal(err)
	}
	stat, err := statBuildContext(dir)
	if err != nil {
		t.Fatal(err)
	}
	if stat.bytes <= maxContextBytes {
		t.Fatalf("稀疏文件应按逻辑大小统计：%d", stat.bytes)
	}
	// preview 超限预警（字节方向）。
	preview, err := PreviewDockerfileBuild(context.Background(), newFakeBuildEngine(), dir, "big", BuildPlanInput{Mode: buildModeDockerfile, Dockerfile: "Dockerfile", Context: "."}, nil)
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(preview.Warnings, "\n")
	if !strings.Contains(joined, buildContextOverLimitWarning) {
		t.Fatalf("字节超限应有预警：%s", joined)
	}
}

// 执行安全审查员-1：readTarEntry 读 tar 快照条目与缺失条目的中文收口。
func TestReadTarEntry(t *testing.T) {
	dir := testDir(t)
	if err := os.WriteFile(filepath.Join(dir, "Dockerfile"), []byte("FROM alpine:3\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "app.txt"), []byte("hello"), 0600); err != nil {
		t.Fatal(err)
	}
	dest := filepath.Join(testDir(t), "ctx.tar")
	if _, err := writeContextTar(dir, dest); err != nil {
		t.Fatal(err)
	}
	content, err := readTarEntry(dest, "Dockerfile")
	if err != nil || string(content) != "FROM alpine:3\n" {
		t.Fatalf("应读出 Dockerfile 条目：%q %v", content, err)
	}
	if _, err = readTarEntry(dest, "missing.txt"); err == nil || !strings.Contains(err.Error(), "构建上下文内没有 missing.txt") {
		t.Fatalf("缺失条目应中文收口：%v", err)
	}
}

// 完善性审查员-2：日志行剥行尾换行、64 KiB 窗口截半行时退回行首，两次拉取衔接后
// 恢复完整行（对齐 mock 侧按最后换行切的口径）。
func TestBuildLogsHalfLineFallback(t *testing.T) {
	env := newBuildTestEnv(t)
	env.createApp(t, "logs", "FROM alpine:3\n")
	task, _, err := env.manager.Submit(context.Background(), WorkspaceDir(env.mountDir, "logs"), "logs", BuildPlanInput{
		Mode:       buildModeDockerfile,
		RequestID:  "aaaaaaaa-1111-2222-3333-444444444444",
		Dockerfile: "Dockerfile",
		Context:    ".",
	})
	if err != nil {
		t.Fatal(err)
	}
	waitForBuildTerminal(t, env.manager, "logs", task.ID)
	// 构造真正跨 64 KiB 边界的日志：行1 65000 字节 + 换行，行2 10000 字节 + 换行
	//（总 75002 字节 > 65536，窗口在行2 中间截断；行1 本身完整在窗口内）。
	long := strings.Repeat("a", 65000)
	second := strings.Repeat("b", 10000)
	if err = os.WriteFile(env.manager.LogPath(task.ID), []byte(long+"\n"+second+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	first := do(t, env.handler, http.MethodGet, "/logs/builds/"+task.ID+"/logs?offset=0", "", nil)
	if first.Code != http.StatusOK {
		t.Fatalf("第一次拉取应 200：%d", first.Code)
	}
	var page1 struct {
		Lines []string `json:"lines"`
		Next  int64    `json:"next"`
		Total int64    `json:"total"`
	}
	if err = json.Unmarshal(first.Body.Bytes(), &page1); err != nil {
		t.Fatal(err)
	}
	// 64 KiB 窗口在行2 中间截断：行2 半行退回，只剩行1，next 指向行2 行首。
	if len(page1.Lines) != 1 || page1.Lines[0] != long {
		t.Fatalf("第一次应只回完整行1：条数 %d 长度 %d", len(page1.Lines), len(page1.Lines[0]))
	}
	if strings.HasSuffix(page1.Lines[0], "\n") || strings.Contains(page1.Lines[0], "\n") {
		t.Fatalf("行内容不得带换行：%q", page1.Lines[0][:20])
	}
	if page1.Next != int64(len(long)+1) {
		t.Fatalf("next 应回退到行2 行首：%d", page1.Next)
	}
	if page1.Total != int64(len(long)+1+len(second)+1) {
		t.Fatalf("total 为文件总大小：%d", page1.Total)
	}
	// 第二次从行首重读：行2 完整恢复。
	secondPage := do(t, env.handler, http.MethodGet, "/logs/builds/"+task.ID+"/logs?offset="+fmt.Sprint(page1.Next), "", nil)
	var page2 struct {
		Lines []string `json:"lines"`
		Next  int64    `json:"next"`
	}
	if err = json.Unmarshal(secondPage.Body.Bytes(), &page2); err != nil {
		t.Fatal(err)
	}
	if len(page2.Lines) != 1 || page2.Lines[0] != second {
		t.Fatalf("第二次应恢复完整行2：%d 字节", len(page2.Lines[0]))
	}
	if page2.Next != page1.Total {
		t.Fatalf("读满后 next 应等于 total：%d", page2.Next)
	}
}

func TestBuildLogsOversizeLineStreamsAcrossWindows(t *testing.T) {
	env := newBuildTestEnv(t)
	env.createApp(t, "bigline", "FROM alpine:3\n")
	task, _, err := env.manager.Submit(context.Background(), WorkspaceDir(env.mountDir, "bigline"), "bigline", BuildPlanInput{
		Mode:       buildModeDockerfile,
		RequestID:  "aaaaaaaa-1111-2222-3333-444444444444",
		Dockerfile: "Dockerfile",
		Context:    ".",
	})
	if err != nil {
		t.Fatal(err)
	}
	waitForBuildTerminal(t, env.manager, "bigline", task.ID)
	// 单行 200000 字节（超出两个整窗）加一条普通短行：前两窗内一个换行都没有，
	// 必须照样下发该段并推进 next，否则分页死循环、该行永远读不完。
	huge := strings.Repeat("x", 200000)
	tail := strings.Repeat("y", 100)
	if err = os.WriteFile(env.manager.LogPath(task.ID), []byte(huge+"\n"+tail+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	collected := []string{}
	offset := int64(0)
	windows := 0
	for {
		page := do(t, env.handler, http.MethodGet, "/bigline/builds/"+task.ID+"/logs?offset="+fmt.Sprint(offset), "", nil)
		if page.Code != http.StatusOK {
			t.Fatalf("拉取应 200：%d %s", page.Code, page.Body.String())
		}
		var body struct {
			Lines []string `json:"lines"`
			Next  int64    `json:"next"`
			Total int64    `json:"total"`
		}
		if err = json.Unmarshal(page.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		collected = append(collected, body.Lines...)
		windows++
		if body.Next <= offset {
			t.Fatalf("next 必须严格前进（offset=%d next=%d），否则分页死循环", offset, body.Next)
		}
		if body.Total != int64(len(huge)+1+len(tail)+1) {
			t.Fatalf("total 应为文件大小：%d", body.Total)
		}
		offset = body.Next
		if offset >= body.Total {
			break
		}
	}
	if windows < 4 {
		t.Fatalf("200000 字节单行至少应分四个窗口下发（ceil(200000/65536)=4）：%d", windows)
	}
	// 超窗单行按 64 KiB 分段：三个整窗段 + 行尾段 + 短行共 5 条下发；无分隔拼接应
	// 还原行内容（换行被窗口边界与行切分消费）。
	if len(collected) != 5 {
		t.Fatalf("应分 5 条下发（三整窗段+行尾段+短行）：%d", len(collected))
	}
	if joined := strings.Join(collected, ""); joined != huge+tail {
		t.Fatalf("分窗送达的内容无损：拼接长度 %d 期望 %d", len(joined), len(huge)+len(tail))
	}
}
