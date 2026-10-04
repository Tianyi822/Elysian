package containerapps

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// testDir 取已解析符号链接的临时目录：macOS 的 t.TempDir() 在 /var（→/private/var）
// 之下，工作区根与其祖先的符号链接会让 AssertWithin 的前缀断言失真；门禁所在的
// Linux 容器无此问题，这里提前解析让两侧测试同语义。
func testDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if resolved, err := filepath.EvalSymlinks(dir); err == nil {
		return resolved
	}
	return dir
}

// --- compose YAML 各形态解析 ---

func TestParseComposeServicesShapes(t *testing.T) {
	// string build、object build、锚点合并、flow 风格、无 build 服务并存。
	content := strings.Join([]string{
		"services:",
		"  web:",
		"    build: ./web",
		"    image: myapp-web",
		"  api:",
		"    build:",
		"      context: ./api",
		"      dockerfile: Dockerfile.dev",
		"      args:",
		"        VERSION: 1.2.3",
		"      target: runtime",
		"  shared:",
		"    build: &sharedbuild",
		"      context: ./shared",
		"  consumer:",
		"    build: *sharedbuild",
		"  db:",
		"    image: mariadb:11",
		"  flowsvc: {build: {context: ./flow, dockerfile: Dockerfile.flow}}",
	}, "\n")
	dir := testDir(t)
	for _, sub := range []string{"web", "api", "shared", "flow"} {
		if err := os.MkdirAll(filepath.Join(dir, sub), 0700); err != nil {
			t.Fatal(err)
		}
	}
	dockerfiles := map[string]string{
		"Dockerfile":      "FROM alpine:3\n",
		"Dockerfile.dev":  "FROM golang:1.23\n",
		"Dockerfile.flow": "FROM alpine:3\n",
	}
	for sub, name := range map[string]string{"web": "Dockerfile", "api": "Dockerfile.dev", "shared": "Dockerfile", "flow": "Dockerfile.flow"} {
		if err := os.WriteFile(filepath.Join(dir, sub, name), []byte(dockerfiles[name]), 0600); err != nil {
			t.Fatal(err)
		}
	}
	entries, err := parseComposeServicePlans(context.Background(), dir, "myapp", "compose.yml", content, nil, func(context.Context, string) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	byName := map[string]composeServicePlan{}
	var order []string
	for _, entry := range entries {
		byName[entry.Service] = entry
		order = append(order, entry.Service)
	}
	want := []string{"web", "api", "shared", "consumer", "db", "flowsvc"}
	if strings.Join(order, ",") != strings.Join(want, ",") {
		t.Fatalf("服务应按 YAML 出现顺序：%v", order)
	}
	if !byName["web"].HasBuild || byName["web"].Plan == nil || byName["web"].Plan.ContextRel != "web" {
		t.Fatalf("string build 的 context 应展开为 web：%+v", byName["web"].Plan)
	}
	api := byName["api"].Plan
	if api == nil || api.ContextRel != "api" || api.DockerfileRel != "api/Dockerfile.dev" || api.Args["VERSION"] != "1.2.3" || api.BuildTarget != "runtime" {
		t.Fatalf("object build 解析不符：%+v", api)
	}
	if byName["api"].Image != "" || byName["web"].Image != "myapp-web" {
		t.Fatalf("image 原样回显不符：web=%q api=%q", byName["web"].Image, byName["api"].Image)
	}
	if byName["consumer"].Plan == nil || byName["consumer"].Plan.ContextRel != "shared" {
		t.Fatalf("锚点别名应展开： %+v", byName["consumer"].Plan)
	}
	if byName["flowsvc"].Plan == nil || byName["flowsvc"].Plan.ContextRel != "flow" || byName["flowsvc"].Plan.DockerfileRel != "flow/Dockerfile.flow" {
		t.Fatalf("flow 风格应可解析：%+v", byName["flowsvc"].Plan)
	}
	if byName["db"].HasBuild || byName["db"].Plan != nil || byName["db"].Image != "mariadb:11" {
		t.Fatalf("无 build 服务应占位并回显 image：%+v", byName["db"])
	}
}

func TestParseComposeBuildRejects(t *testing.T) {
	cases := []struct {
		name    string
		content string
		wantErr string
	}{
		{"缺 context", "services:\n  a:\n    build:\n      dockerfile: Dockerfile\n", "服务 a 的 build 缺少 context"},
		{"未知字段", "services:\n  a:\n    build:\n      context: .\n      secrets: x\n", "服务 a 的 build 含不支持的字段：secrets（仅支持 context、dockerfile、args、target）"},
		{"危险字段 ssh", "services:\n  a:\n    build:\n      context: .\n      ssh: default\n", "服务 a 的 build 含不支持的字段：ssh（仅支持 context、dockerfile、args、target）"},
		{"context 变量", "services:\n  a:\n    build:\n      context: ${CTX}\n", "服务 a 的 build.context 包含变量替换，请写定值后再构建"},
		{"dockerfile 变量", "services:\n  a:\n    build:\n      context: .\n      dockerfile: ${DF}\n", "服务 a 的 build.dockerfile 包含变量替换，请写定值后再构建"},
		{"args 变量", "services:\n  a:\n    build:\n      context: .\n      args:\n        V: ${X}\n", "服务 a 的 build.args 包含变量替换，请写定值后再构建"},
		{"解析失败", "services:\n  a:\n   build: [1, 2\n", "compose 文件解析失败"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := testDir(t)
			if err := os.WriteFile(filepath.Join(dir, "Dockerfile"), []byte("FROM alpine:3\n"), 0600); err != nil {
				t.Fatal(err)
			}
			_, err := parseComposeServicePlans(context.Background(), dir, "s", "compose.yml", tc.content, nil, nil)
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("应报 %q，实际 %v", tc.wantErr, err)
			}
		})
	}
}

func TestParseComposeBuildIgnoresKnownKeys(t *testing.T) {
	dir := testDir(t)
	if err := os.WriteFile(filepath.Join(dir, "Dockerfile"), []byte("FROM alpine:3\n"), 0600); err != nil {
		t.Fatal(err)
	}
	content := "services:\n  a:\n    build:\n      context: .\n      cache_from:\n        - a:b\n      pull: true\n"
	entries, err := parseComposeServicePlans(context.Background(), dir, "s", "compose.yml", content, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(entries[0].Warnings, "\n")
	if !strings.Contains(joined, "服务 a 的 build.cache_from 面板暂不处理，已忽略") {
		t.Fatalf("可忽略字段应点名警告：%s", joined)
	}
}

func TestComposeServiceSelectionOrder(t *testing.T) {
	dir := testDir(t)
	if err := os.WriteFile(filepath.Join(dir, "Dockerfile"), []byte("FROM alpine:3\n"), 0600); err != nil {
		t.Fatal(err)
	}
	content := "services:\n  web:\n    build:\n      context: .\n  db:\n    image: mariadb:11\n"
	ctx := context.Background()
	cases := []struct {
		name     string
		selected []string
		wantErr  string
	}{
		{"重复名", []string{"web", "web"}, "服务 web 重复提交"},
		{"不存在", []string{"ghost"}, "服务不存在：ghost"},
		{"无 build", []string{"db"}, "服务没有 build 配置：db"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := parseComposeServicePlans(ctx, dir, "s", "compose.yml", content, tc.selected, nil)
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("应报 %q，实际 %v", tc.wantErr, err)
			}
		})
	}
	// 空数组视同省略：全部 hasBuild 服务进列表。
	entries, err := parseComposeServicePlans(ctx, dir, "s", "compose.yml", content, []string{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 || entries[0].Plan == nil || entries[1].Plan != nil {
		t.Fatalf("空数组应视同全部：%+v", entries)
	}
}

// --- context 的 ./ 前缀两模式规则 ---

func TestNormalizeDockerfileContextRules(t *testing.T) {
	cases := []struct {
		value string
		want  string
		err   string
	}{
		{".", ".", ""},
		{"", ".", ""},
		{"./", ".", ""},
		{"./web", "web", ""},
		{"web", "web", ""},
		{"./a/b", "a/b", ""},
		{"../x", "", "文件路径不允许 . 与 .. 段"},
		{"/abs", "", "文件路径必须是相对路径"},
		{"a\\b", "", "文件路径不允许反斜杠"},
		{"a//b", "", "文件路径包含空路径段"},
		{"a/./b", "", "文件路径不允许 . 与 .. 段"},
		{strings.Repeat("a/", 12) + "x", "", "文件路径层级过深"},
	}
	for _, tc := range cases {
		got, err := normalizeDockerfileContext(tc.value)
		if tc.err != "" {
			if err == nil || !strings.Contains(err.Error(), tc.err) {
				t.Errorf("context %q 应报 %q，实际 %v", tc.value, tc.err, err)
			}
			continue
		}
		if err != nil || got != tc.want {
			t.Errorf("context %q 应归一为 %q，实际 %q %v", tc.value, tc.want, got, err)
		}
	}
}

func TestResolveComposeContextRules(t *testing.T) {
	workspace := testDir(t)
	// compose 放在子目录 deploy/ 下：context 相对 compose 目录展开。
	composeDir := filepath.Join(workspace, "deploy")
	if err := os.MkdirAll(filepath.Join(workspace, "web"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(composeDir, 0700); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	// compose 目录内一个指向工作区外的符号链接，用于符号链接逃逸。
	if err := os.Symlink(outside, filepath.Join(composeDir, "escape")); err != nil {
		t.Skipf("环境不支持符号链接：%v", err)
	}
	cases := []struct {
		name    string
		value   string
		want    string
		wantErr string
	}{
		{"字面点等于 compose 目录", ".", "deploy", ""},
		{"./ 剥后为空等于 compose 目录", "./", "deploy", ""},
		{"./web 相对 compose 展开", "./web", "deploy/web", ""},
		{"裸相对路径", "web", "deploy/web", ""},
		{"../ 越出工作区", "../x", "", "构建上下文必须是工作区内的相对路径"},
		{"字面 ..", "..", "", "构建上下文必须是工作区内的相对路径"},
		{"绝对路径", "/srv/x", "", "构建上下文必须是工作区内的相对路径"},
		{"展开后越界", "deploy/../../../x", "", "构建上下文必须是工作区内的相对路径"},
		{"符号链接逃逸", "./escape", "", "构建上下文必须是工作区内的相对路径"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := resolveComposeContext(workspace, composeDir, "web", tc.value)
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("应报 %q，实际 %v", tc.wantErr, err)
				}
				return
			}
			if err != nil || got != tc.want {
				t.Fatalf("应展开为 %q，实际 %q %v", tc.want, got, err)
			}
		})
	}
	// 变量替换单独断言文案（含 ${} 与裸 $）。
	for _, value := range []string{"${CTX}", "$CTX"} {
		_, err := resolveComposeContext(workspace, composeDir, "web", value)
		if err == nil || !strings.Contains(err.Error(), "服务 web 的 build.context 包含变量替换，请写定值后再构建") {
			t.Fatalf("变量 %q 应拒绝：%v", value, err)
		}
	}
}

// --- target 清洗 ---

func TestCleanServiceTarget(t *testing.T) {
	cases := []struct {
		service string
		want    string
		ok      bool
	}{
		{"web", "web", true},
		{"My.App", "my-app", true},
		{"api_v2", "api_v2", true},
		{".hidden", "", false},
		{"-lead", "", false},
		{"服务", "", false},
	}
	for _, tc := range cases {
		got, ok := cleanServiceTarget(tc.service)
		if ok != tc.ok || (ok && got != tc.want) {
			t.Errorf("清洗 %q：got %q %v want %q %v", tc.service, got, ok, tc.want, tc.ok)
		}
	}
}

func TestCleanServiceTargetCollision(t *testing.T) {
	dir := testDir(t)
	if err := os.WriteFile(filepath.Join(dir, "Dockerfile"), []byte("FROM alpine:3\n"), 0600); err != nil {
		t.Fatal(err)
	}
	// web.io 清洗成 web-io，与字面 web-io 撞名：后者应按清洗失败拒绝。
	content := "services:\n  \"web.io\":\n    build:\n      context: .\n  web-io:\n    build:\n      context: .\n"
	_, err := parseComposeServicePlans(context.Background(), dir, "s", "compose.yml", content, nil, nil)
	if err == nil || !strings.Contains(err.Error(), "无法转换为合法镜像目标名，请改名后重试") {
		t.Fatalf("撞名应拒绝：%v", err)
	}
}

func TestValidateBuildTarget(t *testing.T) {
	for _, bad := range []string{"", "App", "-x", "a b", "a/b", strings.Repeat("a", 65)} {
		if err := validateBuildTarget(bad); err == nil {
			t.Errorf("target %q 应被拒绝", bad)
		}
	}
	for _, good := range []string{"app", "a1", "my_app-2"} {
		if err := validateBuildTarget(good); err != nil {
			t.Errorf("target %q 应通过：%v", good, err)
		}
	}
}

// --- FROM 静态预检 ---

func TestInspectDockerfile(t *testing.T) {
	deny := func(context.Context, string) error { return errors.New("镜像源无法解析为公网地址") }
	ctx := context.Background()

	// 官方源与 docker.io 缺省跳过（不触 policy）。
	warnings, err := inspectDockerfile(ctx, "FROM alpine:3\nFROM docker.io/library/nginx:1\n", nil, deny)
	if err != nil || len(warnings) != 0 {
		t.Fatalf("官方源应跳过：%v %v", warnings, err)
	}
	// 私网主机名经 policy 拒绝（透传原文）。
	_, err = inspectDockerfile(ctx, "FROM registry.internal:5000/app:1\n", nil, deny)
	if err == nil || err.Error() != "镜像源无法解析为公网地址" {
		t.Fatalf("私网应透传拒绝原文：%v", err)
	}
	// policy 为 nil 时非官方 FROM 一律拒绝。
	_, err = inspectDockerfile(ctx, "FROM mirror.example.com/app:1\n", nil, nil)
	if err == nil || err.Error() != "镜像源校验通道不可用，已中止" {
		t.Fatalf("nil 通道应拒绝：%v", err)
	}
	// ARG 默认值代入后命中官方源。
	warnings, err = inspectDockerfile(ctx, "ARG BASE=alpine:3\nFROM ${BASE}\n", nil, deny)
	if err != nil || len(warnings) != 0 {
		t.Fatalf("ARG 默认值应代入：%v %v", warnings, err)
	}
	// compose args 叠加（args 优先于 ARG 默认值）。
	content := "ARG BASE=alpine:3\nFROM ${BASE}\n"
	_, err = inspectDockerfile(ctx, content, map[string]string{"BASE": "mirror.example.com/app:1"}, deny)
	if err == nil || err.Error() != "镜像源无法解析为公网地址" {
		t.Fatalf("args 应叠加并优先生效：%v", err)
	}
	// 未解析变量进警告、不报错。
	warnings, err = inspectDockerfile(ctx, "FROM ${UNSET}\nFROM $ALSO_UNSET\n", nil, deny)
	if err != nil {
		t.Fatalf("未解析变量不应报错：%v", err)
	}
	if len(warnings) != 2 || !strings.Contains(warnings[0], "第 1 行 FROM 含未解析变量，面板未校验其镜像源") {
		t.Fatalf("未解析变量应逐行进警告：%v", warnings)
	}
	// --platform 剥掉、大小写不敏感。
	warnings, err = inspectDockerfile(ctx, "from --platform=$BUILDPLATFORM alpine:3\n", nil, deny)
	if err != nil || len(warnings) != 0 {
		t.Fatalf("--platform 应剥掉：%v %v", warnings, err)
	}
}

// --- dockerfile 模式计划解析（含 Dockerfile 必须在 context 内） ---

func TestResolveDockerfilePlanRules(t *testing.T) {
	workspace := testDir(t)
	if err := os.MkdirAll(filepath.Join(workspace, "sub"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspace, "Dockerfile"), []byte("FROM alpine:3\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspace, "sub", "Dockerfile"), []byte("FROM alpine:3\n"), 0600); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	allow := func(context.Context, string) error { return nil }

	plan, _, err := resolveDockerfilePlan(ctx, workspace, "myapp", BuildPlanInput{Mode: buildModeDockerfile, Context: "."}, allow)
	_ = plan
	if err != nil {
		t.Fatal(err)
	}
	if plan.Target != "app" || plan.Repository != "elysian/myapp/app" || plan.ContextRel != "." || plan.EngineDockerfile != "Dockerfile" {
		t.Fatalf("缺省 target 与 context 不符：%+v", plan)
	}
	plan, _, err = resolveDockerfilePlan(ctx, workspace, "myapp", BuildPlanInput{Mode: buildModeDockerfile, Context: "./sub", Dockerfile: "sub/Dockerfile"}, allow)
	if err != nil {
		t.Fatal(err)
	}
	if plan.ContextRel != "sub" || plan.DockerfileRel != "sub/Dockerfile" || plan.EngineDockerfile != "Dockerfile" {
		t.Fatalf("sub context 解析不符：%+v", plan)
	}
	// Dockerfile 不在 context 内。
	_, _, err = resolveDockerfilePlan(ctx, workspace, "myapp", BuildPlanInput{Mode: buildModeDockerfile, Context: "./sub", Dockerfile: "Dockerfile"}, allow)
	if err == nil || err.Error() != "Dockerfile 必须位于构建上下文目录内" {
		t.Fatalf("Dockerfile 不在 context 内应拒绝：%v", err)
	}
	// context 目录不存在。
	_, _, err = resolveDockerfilePlan(ctx, workspace, "myapp", BuildPlanInput{Mode: buildModeDockerfile, Context: "./ghost"}, allow)
	if err == nil || err.Error() != "构建上下文目录不存在：ghost" {
		t.Fatalf("context 缺失应报目录不存在：%v", err)
	}
	// Dockerfile 不存在 → 404 文案。
	_, _, err = resolveDockerfilePlan(ctx, workspace, "myapp", BuildPlanInput{Mode: buildModeDockerfile, Context: ".", Dockerfile: "nope"}, allow)
	if err == nil || err.Error() != "工作区内没有该文件：nope" {
		t.Fatalf("Dockerfile 缺失应 404 文案：%v", err)
	}
	// target 非法。
	_, _, err = resolveDockerfilePlan(ctx, workspace, "myapp", BuildPlanInput{Mode: buildModeDockerfile, Context: ".", Target: "Bad Name"}, allow)
	if err == nil || !strings.Contains(err.Error(), "镜像目标名只能由小写字母、数字、下划线和连字符组成") {
		t.Fatalf("非法 target 应拒绝：%v", err)
	}
}

// --- 请求体形状（互斥字段） ---

func TestValidateBuildInputShape(t *testing.T) {
	bad := []BuildPlanInput{
		{Mode: ""},
		{Mode: "other"},
		{Mode: buildModeDockerfile, Compose: "compose.yml"},
		{Mode: buildModeDockerfile, Services: []string{"web"}},
		{Mode: buildModeCompose, Target: "app"},
		{Mode: buildModeCompose, Dockerfile: "Dockerfile"},
		{Mode: buildModeCompose, Context: "."},
		{Mode: buildModeDockerfile, RequestID: "x"}, // preview 不带 requestId
	}
	for i, input := range bad {
		if err := input.validateBuildInputShape(false); err == nil {
			t.Errorf("输入 %d 在 preview 语义下应拒绝：%+v", i, input)
		}
		if err := input.validateBuildInputShape(true); err == nil {
			// preview 专属的 requestId 用例在 submit 语义下合法，其余仍应拒绝。
			if input.RequestID == "" {
				t.Errorf("输入 %d 在 submit 语义下应拒绝：%+v", i, input)
			}
		}
	}
	goodPreview := []BuildPlanInput{
		{Mode: buildModeDockerfile},
		{Mode: buildModeDockerfile, Target: "app", Dockerfile: "Dockerfile", Context: "."},
		{Mode: buildModeCompose, Compose: "compose.yml"},
	}
	for _, input := range goodPreview {
		if err := input.validateBuildInputShape(false); err != nil {
			t.Errorf("preview 合法输入被拒：%+v %v", input, err)
		}
	}
	if err := (BuildPlanInput{Mode: buildModeCompose, Compose: "compose.yml", RequestID: "aaaaaaaa-1111-2222-3333-444444444444"}).validateBuildInputShape(true); err != nil {
		t.Fatalf("submit 合法输入被拒：%v", err)
	}
}
