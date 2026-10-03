package websites

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func putFixture(t *testing.T, root string, files map[string]string) {
	t.Helper()
	for name, text := range files {
		p := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Dir(p), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(text), 0644); err != nil {
			t.Fatal(err)
		}
	}
}
func TestArchiveSafety(t *testing.T) {
	for _, name := range []string{"../outside", "/absolute", "a/../../outside", "a\\..\\outside"} {
		t.Run(name, func(t *testing.T) {
			var b bytes.Buffer
			z := zip.NewWriter(&b)
			f, _ := z.Create(name)
			_, _ = f.Write([]byte("x"))
			_ = z.Close()
			p := filepath.Join(t.TempDir(), "a.zip")
			_ = os.WriteFile(p, b.Bytes(), 0600)
			if err := extractArchive(context.Background(), p, t.TempDir(), defaultDeploymentLimits()); err == nil {
				t.Fatal("未拒绝不安全路径")
			}
		})
	}
	for _, flag := range []byte{tar.TypeSymlink, tar.TypeLink, tar.TypeFifo, tar.TypeChar} {
		t.Run(string(flag), func(t *testing.T) {
			var b bytes.Buffer
			gz := gzip.NewWriter(&b)
			tw := tar.NewWriter(gz)
			_ = tw.WriteHeader(&tar.Header{Name: "link", Typeflag: flag, Linkname: "/etc/passwd"})
			_ = tw.Close()
			_ = gz.Close()
			p := filepath.Join(t.TempDir(), "a.tar.gz")
			_ = os.WriteFile(p, b.Bytes(), 0600)
			if err := extractArchive(context.Background(), p, t.TempDir(), defaultDeploymentLimits()); err == nil {
				t.Fatal("未拒绝链接或特殊文件")
			}
		})
	}
	var b bytes.Buffer
	z := zip.NewWriter(&b)
	for _, name := range []string{"project/a", "project/b"} {
		f, _ := z.Create(name)
		_, _ = f.Write([]byte("123456"))
	}
	_ = z.Close()
	p := filepath.Join(t.TempDir(), "a.zip")
	_ = os.WriteFile(p, b.Bytes(), 0600)
	limits := defaultDeploymentLimits()
	limits.ExpandedBytes = 10
	if e := extractArchive(context.Background(), p, t.TempDir(), limits); e == nil {
		t.Fatal("未限制展开大小")
	}
	limits.ExpandedBytes = 100
	limits.Entries = 1
	if e := extractArchive(context.Background(), p, t.TempDir(), limits); e == nil {
		t.Fatal("未限制条目数")
	}
	_ = os.WriteFile(p, []byte("broken"), 0600)
	if e := extractArchive(context.Background(), p, t.TempDir(), limits); e == nil {
		t.Fatal("未拒绝损坏包")
	}
}
func TestAnalyzeAllToolsAndAmbiguity(t *testing.T) {
	root := t.TempDir()
	putFixture(t, root, map[string]string{
		"repo/java/pom.xml": "<project/>", "repo/java/mvnw": "#!/bin/sh", "repo/java/.mvn/wrapper/maven-wrapper.properties": "distributionUrl=apache-maven-3.9.11-bin.zip",
		"repo/java/build.gradle": "plugins { id 'application' }", "repo/java/gradlew": "#!/bin/sh", "repo/java/gradle/wrapper/gradle-wrapper.jar": "fixture", "repo/java/gradle/wrapper/gradle-wrapper.properties": "distributionUrl=gradle-8.14.3-bin.zip",
		"repo/plain/Main.java": "public class Main { public static void main(String[] args){} }", "repo/plain/Other.java": "public class Other { public static void main(String[] args){} }",
		"repo/node/package.json": `{"packageManager":"pnpm@10.17.1","scripts":{"test":"echo test","build":"echo build"}}`, "repo/node/package-lock.json": "{}", "repo/node/pnpm-lock.yaml": "",
		"repo/go/go.mod": "module sample\ngo 1.25.1\n", "repo/go/cmd/a/main.go": "package main\nfunc main(){}", "repo/go/cmd/b/main.go": "package main\nfunc main(){}",
		"repo/python/pyproject.toml": "[project]\nname='sample'", "repo/python/uv.lock": "", "repo/html/index.html": "<h1/>"})
	report, e := analyzeSource(root, "source")
	if e != nil {
		t.Fatal(e)
	}
	tools := map[string]projectCandidate{}
	for _, c := range report.Candidates {
		tools[c.Tool] = c
	}
	for _, tool := range []string{"maven", "gradle", "javac", "pnpm", "npm", "go", "uv", "static"} {
		if _, ok := tools[tool]; !ok {
			t.Errorf("缺少 %s", tool)
		}
	}
	if !tools["maven"].Wrapper || !tools["gradle"].Wrapper {
		t.Fatal("未采用完整 Wrapper")
	}
	if len(tools["javac"].Entries) != 2 || len(tools["go"].Entries) != 2 {
		t.Fatal("未保留多个入口选择")
	}
	if tools["pnpm"].ToolVersion != "10.17.1" || len(tools["pnpm"].Warnings) == 0 {
		t.Fatal("未记录工具版本与冲突")
	}
	if len(tools["pnpm"].TestSteps) == 0 {
		t.Fatal("未识别 Node 测试脚本")
	}
	artifact, e := analyzeSource(root, "artifact")
	if e != nil {
		t.Fatal(e)
	}
	for _, c := range artifact.Candidates {
		if len(c.BuildSteps) > 0 || len(c.TestSteps) > 0 {
			t.Fatal("成品模式不能执行构建测试")
		}
	}
}
func TestBuildConfigAndScripts(t *testing.T) {
	f := fixture(t, nil, nil, nil, nil)
	m := &deploymentManager{service: f.service}
	src := sourceRecord{Mode: "source", Report: &analysisReport{Candidates: []projectCandidate{{ID: "java", Kind: KindJava, Tool: "javac", Entries: []string{"Main"}}}}}
	cfg := buildConfig{CandidateID: "java", BuildVersion: "25.0.4.1+1", RuntimeVersion: "17.0.20.1+1", Target: "service", Command: "java -jar /app/app.jar"}
	if _, _, _, err := m.validateConfig(context.Background(), src, cfg); err == nil {
		t.Fatal("未拒绝较低 JRE")
	}
	script, _ := buildScript(projectCandidate{Tool: "maven", Wrapper: true}, buildConfig{}, "amd64")
	if !strings.Contains(script, "sh ./mvnw -B clean verify") || strings.Contains(script, "-DskipTests") {
		t.Fatal("Maven 默认必须 verify 测试")
	}
	script, _ = buildScript(projectCandidate{Tool: "gradle", Wrapper: true}, buildConfig{SkipTests: true}, "amd64")
	if !strings.Contains(script, "clean build --no-daemon -x test") {
		t.Fatal("未记录明确跳过")
	}
	script, _ = buildScript(projectCandidate{Tool: "go", Entries: []string{"cmd/api"}}, buildConfig{}, "arm64")
	if !strings.Contains(script, "GOARCH='arm64'") || !strings.Contains(script, "go test ./...") {
		t.Fatal("Go 架构或测试错误")
	}
}
func TestGitValidationNoCredentials(t *testing.T) {
	for _, raw := range []string{"git@github.com:org/repo.git", "ssh://example.org/repo", "https://user:token@example.org/repo", "https://example.org/repo?token=secret"} {
		if e := validateGitURL(raw, "", ""); e == nil {
			t.Fatal("未拒绝不支持或含凭据的地址")
		}
	}
	if e := validateGitURL("https://example.org/repo.git", "-bad", ""); e == nil {
		t.Fatal("未拒绝选项引用")
	}
	if e := validateGitURL("https://example.org/repo.git", "release-v1", "secret"); e != nil {
		t.Fatal(e)
	}
	b, _ := json.Marshal(sourceRecord{GitURL: "https://example.org/repo.git"})
	if strings.Contains(string(b), "token") {
		t.Fatal("来源形状包含凭据")
	}
}
func TestProjectLockAtomic(t *testing.T) {
	set := newMutexSet()
	if !set.acquire("project", "create") {
		t.Fatal("首次锁失败")
	}
	if set.acquire("another", "create") || set.has("another") {
		t.Fatal("多键锁必须原子失败")
	}
	set.remove("project")
	set.remove("create")
	if !set.acquire("another", "create") {
		t.Fatal("锁未释放")
	}
}
func TestInterruptedTasksAreDurable(t *testing.T) {
	root, source, logs := t.TempDir(), t.TempDir(), t.TempDir()
	id := newDeploymentID()
	task := deploymentTask{ID: id, State: "building", CreatedAt: time.Now().UTC().Format(time.RFC3339), Name: "app"}
	if e := writeDeploymentJSON(filepath.Join(root, id+".json"), task); e != nil {
		t.Fatal(e)
	}
	m := newDeploymentManager(NewWebsiteService(serviceDeps{registry: NewMemoryWebsiteRegistry()}), deploymentEngine{limits: defaultDeploymentLimits()}, root, source, logs)
	actual, e := m.getTask(id)
	if e != nil {
		t.Fatal(e)
	}
	if actual.State != "interrupted" || !strings.Contains(actual.Error, "未自动重新发布") {
		t.Fatalf("中断事实错误：%+v", actual)
	}
}
func TestVersionRequirementsAndPackageRoots(t *testing.T) {
	for _, tc := range []struct {
		v, r string
		ok   bool
	}{{"22.19.0", ">=18 <23", true}, {"24.0.0", ">=18 <23", false}, {"3.13.7", ">=3.10,<3.14", true}, {"3.9.7", ">=3.10", false}, {"20.0.0", "^18.0.0 || >=20", true}, {"18.2.0", "~18.1", false}, {"3.13.7", ">=3.10,!=3.11.*", true}, {"3.11.9", ">=3.10,!=3.11.*", false}, {"0.3.0", "^0.2.1", false}} {
		if deploymentVersionSatisfies(tc.v, tc.r) != tc.ok {
			t.Errorf("版本范围 %s / %s", tc.v, tc.r)
		}
	}
	root := t.TempDir()
	putFixture(t, root, map[string]string{"project/com/example/Main.java": "package com.example; public class Main { public static void main(String[] args){} }", "project/resources/config.txt": "resource", "project/lib/local.jar": "local"})
	report, e := analyzeSource(root, "source")
	if e != nil {
		t.Fatal(e)
	}
	if len(report.Candidates) != 1 || report.Candidates[0].Directory != "project" || report.Candidates[0].Entries[0] != "com.example.Main" {
		t.Fatalf("包结构的项目根不正确：%+v", report)
	}
}

func TestSourcePollingKeepsRecoveryIdentityAndCopiesReports(t *testing.T) {
	id := newDeploymentID()
	source := &sourceRecord{ID: id, FetchContainer: strings.Repeat("a", 64), Report: &analysisReport{Candidates: []projectCandidate{{ID: "candidate", Entries: []string{"entry"}}}}}
	m := &deploymentManager{sources: map[string]*sourceRecord{id: source}}
	copy, err := m.getSource(id)
	if err != nil {
		t.Fatal(err)
	}
	copy.Report.Candidates[0].Entries[0] = "changed"
	if source.FetchContainer == "" || source.Report.Candidates[0].Entries[0] != "entry" {
		t.Fatal("查询改变了恢复身份或共享了可变报告")
	}
}

func TestArchiveCancelAndChecksum(t *testing.T) {
	var b bytes.Buffer
	gz := gzip.NewWriter(&b)
	tw := tar.NewWriter(gz)
	_ = tw.WriteHeader(&tar.Header{Name: "index.html", Mode: 0644, Size: 1})
	_, _ = tw.Write([]byte("x"))
	_ = tw.Close()
	_ = gz.Close()
	data := append([]byte{}, b.Bytes()...)
	data[len(data)-8] ^= 1
	path := filepath.Join(t.TempDir(), "bad.tar.gz")
	_ = os.WriteFile(path, data, 0600)
	if extractArchive(context.Background(), path, t.TempDir(), defaultDeploymentLimits()) == nil {
		t.Fatal("未拒绝 gzip 校验损坏")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_ = os.WriteFile(path, b.Bytes(), 0600)
	if extractArchive(ctx, path, t.TempDir(), defaultDeploymentLimits()) == nil {
		t.Fatal("上传取消后仍解包")
	}
}

func TestRestartRestoresPublishingCheckpoint(t *testing.T) {
	for _, running := range []bool{true, false} {
		t.Run(map[bool]string{true: "运行中", false: "已停止"}[running], func(t *testing.T) {
			f := fixture(t, nil, nil, nil, nil)
			root := t.TempDir()
			id := newDeploymentID()
			oldID, newID := strings.Repeat("a", 64), strings.Repeat("b", 64)
			previous := WebsiteRecord{ID: newDeploymentID(), Name: "app", Kind: KindNode, RootDir: root, ContainerID: stringPtr(oldID), ContainerName: stringPtr("old"), AccessMode: AccessModeDirect}
			pending := copyRecord(previous)
			pending.ContainerID = stringPtr(newID)
			pending.ContainerName = stringPtr("new")
			pending.CurrentRelease = &releaseRecord{ID: id, Directory: filepath.Join(root, ".releases", id, "app")}
			_ = os.MkdirAll(pending.CurrentRelease.Directory, 0755)
			_ = f.registry.Put(context.Background(), pending)
			f.docker.states[oldID] = false
			f.docker.states[newID] = true
			tasks := t.TempDir()
			task := deploymentTask{ID: id, State: "publishing", CreatedAt: time.Now().UTC().Format(time.RFC3339), Pending: &pending, Previous: &previous, PreviousRunning: running}
			if err := writeDeploymentJSON(filepath.Join(tasks, id+".json"), task); err != nil {
				t.Fatal(err)
			}
			m := newDeploymentManager(f.service, deploymentEngine{limits: defaultDeploymentLimits()}, tasks, t.TempDir(), t.TempDir())
			restored, restoreErr := f.service.record(context.Background(), previous.ID)
			if restoreErr != nil || stringOrEmpty(restored.ContainerID) != oldID {
				t.Fatal("没有恢复旧登记")
			}
			if f.docker.states[oldID] != running {
				t.Fatal("没有恢复旧容器的原运行状态")
			}
			if _, exists := f.docker.states[newID]; exists {
				t.Fatal("新容器未清理")
			}
			if _, err := os.Stat(pending.CurrentRelease.Directory); !os.IsNotExist(err) {
				t.Fatal("失败版本目录未清理")
			}
			interrupted, _ := m.getTask(id)
			if interrupted.State != "interrupted" {
				t.Fatal("任务未标记重启中断")
			}
		})
	}
}

func TestJarBytecodeCompatibilityAndMultiRelease(t *testing.T) {
	root := t.TempDir()
	var b bytes.Buffer
	z := zip.NewWriter(&b)
	for name, version := range map[string]byte{"Main.class": 65, "META-INF/versions/27/Main.class": 71} {
		w, _ := z.Create(name)
		_, _ = w.Write([]byte{0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, version})
	}
	_ = z.Close()
	path := filepath.Join(root, "app.jar")
	_ = os.WriteFile(path, b.Bytes(), 0600)
	if jarRequiredVersion(path) != 21 {
		t.Fatal("多版本 JAR 的最低运行版本错误")
	}
	report, err := analyzeSource(root, "artifact")
	if err != nil || len(report.Candidates) != 1 || report.Candidates[0].RequiredVersion != "21" {
		t.Fatal("未识别成品 JAR 的字节码要求")
	}
	f := fixture(t, nil, nil, nil, nil)
	m := &deploymentManager{service: f.service}
	if _, _, _, err := m.validateConfig(context.Background(), sourceRecord{Mode: "artifact", Report: &report}, buildConfig{CandidateID: report.Candidates[0].ID, Target: "service", Command: "java -jar /app/app.jar", RuntimeVersion: "17.0.20.1+1"}); err == nil {
		t.Fatal("低版本 JRE 未拦截")
	}
}
