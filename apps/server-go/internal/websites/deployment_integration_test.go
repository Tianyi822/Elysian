package websites

import (
	"archive/zip"
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"elysian/server/internal/contract"
	"elysian/server/internal/docker"
)

// 显式运行：ELYSIAN_DEPLOY_INTEGRATION=1 go test -run TestDeploymentRealProjects -timeout 40m。
// 测试只创建自己的目录、构建与运行容器，结束时删除。常规门禁不依赖外网镜像库。
func TestDeploymentRealProjects(t *testing.T) {
	if os.Getenv("ELYSIAN_DEPLOY_INTEGRATION") != "1" {
		t.Skip("真实部署验收需显式开启")
	}
	mount := os.Getenv("ELYSIAN_DOCKER_MOUNT_ROOT")
	if mount == "" {
		t.Fatal("请指定与 Docker 宿主同路径挂载的 ELYSIAN_DOCKER_MOUNT_ROOT")
	}
	root := filepath.Join(mount, ".deployment-test-"+newDeploymentID())
	if e := os.MkdirAll(root, 0755); e != nil {
		t.Fatal(e)
	}
	defer os.RemoveAll(root)
	transport := docker.NewTransportFactory().New("/var/run/docker.sock")
	ops := NewWebsiteDocker(transport, func(ctx context.Context) ([]contract.ContainerImage, error) { return nil, nil })
	catalog := &fakeCatalogSource{report: runtimeCatalogReport{Catalog: runtimeCatalog{Java: []catalogEntry{{Version: "21.0.8+9", Image: "eclipse-temurin:21.0.8_9-jre"}}, Node: []catalogEntry{{Version: "22.19.0", Image: "node:22.19.0"}}, Go: []catalogEntry{{Version: "1.25.1", Image: "golang:1.25.1"}}, Python: []catalogEntry{{Version: "3.13.7", Image: "python:3.13.7-slim"}}}}}
	s := NewWebsiteService(serviceDeps{registry: NewMemoryWebsiteRegistry(), docker: ops, mountRoot: root, runtimeCatalog: catalog, caddy: &fakeCaddyChannel{calls: new([]string), listen: testAdminListen}, listPortBindings: func(context.Context) ([]contract.PortBindingView, error) { return nil, nil }})
	limits := defaultDeploymentLimits()
	limits.Timeout = 15 * time.Minute
	m := newDeploymentManager(s, deploymentEngine{transport: transport, limits: limits}, filepath.Join(t.TempDir(), "tasks"), filepath.Join(t.TempDir(), "sources"), filepath.Join(t.TempDir(), "logs"))
	java := `import com.sun.net.httpserver.HttpServer;import java.net.InetSocketAddress;public class Main{public static void main(String[] args)throws Exception{HttpServer s=HttpServer.create(new InetSocketAddress("0.0.0.0",Integer.parseInt(args[0])),0);s.createContext("/",e->{byte[] b="ok".getBytes();e.sendResponseHeaders(200,b.length);e.getResponseBody().write(b);e.close();});s.start();}}`
	fixtures := []struct {
		name, kind, version, command, target, mode string
		files                                      map[string]string
		custom                                     []string
	}{
		{"html", KindHTML, "", "", "static", "source", map[string]string{"project/index.html": "<h1>ok</h1>"}, nil},
		{"html-artifact", KindHTML, "", "", "static", "artifact", map[string]string{"project/index.html": "<h1>ready</h1>"}, nil},
		{"node-service", KindNode, "22.19.0", "node /app/app.js", "service", "source", map[string]string{"project/package.json": `{"name":"fixture","version":"1.0.0","main":"app.js","scripts":{"test":"node -e \"if(1+1!==2)process.exit(1)\""}}`, "project/app.js": `require('http').createServer((q,r)=>r.end('ok')).listen(process.env.PORT||47082,'0.0.0.0')`}, nil},
		{"node-static", KindNode, "22.19.0", "", "static", "source", map[string]string{"project/package.json": `{"name":"fixture","version":"1.0.0","scripts":{"test":"node -e \"if(1+1!==2)process.exit(1)\"","build":"mkdir -p dist && cp index.html dist/index.html"}}`, "project/index.html": "<h1>built</h1>"}, nil},
		{"go", KindGo, "1.25.1", "/app/server", "service", "source", map[string]string{"project/go.mod": "module fixture\n\ngo 1.25.1\n", "project/main.go": "package main\nimport(\"net/http\";\"os\")\nfunc main(){http.ListenAndServe(\"0.0.0.0:\"+os.Args[1],http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){w.Write([]byte(\"ok\"))}))}\n", "project/main_test.go": "package main\nimport \"testing\"\nfunc TestAddition(t *testing.T){if 1+1!=2{t.Fatal(\"failed\")}}\n"}, nil},
		{"python", KindPython, "3.13.7", "/app/.venv/bin/python /app/app.py", "service", "source", map[string]string{"project/requirements.txt": "", "project/app.py": "from http.server import HTTPServer,SimpleHTTPRequestHandler\nHTTPServer(('0.0.0.0',47085),SimpleHTTPRequestHandler).serve_forever()\n"}, nil},
		{"java", KindJava, "21.0.8+9", "java -cp '/app/app.jar:/app/lib/*' Main", "service", "source", map[string]string{"project/Main.java": java}, nil},
		{"maven", KindJava, "21.0.8+9", "java -jar /app/app.jar", "service", "source", map[string]string{"project/pom.xml": `<project><modelVersion>4.0.0</modelVersion><groupId>fixture</groupId><artifactId>server</artifactId><version>1.0.0</version><properties><maven.compiler.release>21</maven.compiler.release></properties><build><plugins><plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-jar-plugin</artifactId><version>3.4.2</version><configuration><archive><manifest><mainClass>Main</mainClass></manifest></archive></configuration></plugin></plugins></build></project>`, "project/src/main/java/Main.java": java}, nil},
		{"gradle", KindJava, "21.0.8+9", "/app/bin/fixture", "service", "source", map[string]string{"project/settings.gradle": "rootProject.name = 'fixture'", "project/build.gradle": "plugins { id 'application' }\napplication { mainClass = 'Main' }\n", "project/src/main/java/Main.java": java}, nil},
	}

	download := func(raw string) string {
		t.Helper()
		client := &http.Client{Timeout: 60 * time.Second}
		response, err := client.Get(raw)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		if response.StatusCode != 200 {
			t.Fatalf("Wrapper 官方文件获取失败：%s（%d）", raw, response.StatusCode)
		}
		b, err := io.ReadAll(io.LimitReader(response.Body, 2<<20))
		if err != nil {
			t.Fatal(err)
		}
		return string(b)
	}
	mavenFiles := map[string]string{}
	for name, text := range fixtures[7].files {
		mavenFiles[name] = text
	}
	mavenFiles["project/mvnw"] = download("https://raw.githubusercontent.com/apache/maven-wrapper/maven-wrapper-3.3.4/maven-wrapper-distribution/src/resources/mvnw")
	mavenFiles["project/.mvn/wrapper/maven-wrapper.properties"] = "distributionUrl=https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/3.9.11/apache-maven-3.9.11-bin.zip\nwrapperUrl=https://repo.maven.apache.org/maven2/org/apache/maven/wrapper/maven-wrapper/3.3.4/maven-wrapper-3.3.4.jar\n"
	gradleFiles := map[string]string{}
	for name, text := range fixtures[8].files {
		gradleFiles[name] = text
	}
	gradleFiles["project/gradlew"] = download("https://raw.githubusercontent.com/gradle/gradle/v8.14.3/gradlew")
	gradleFiles["project/gradle/wrapper/gradle-wrapper.jar"] = download("https://raw.githubusercontent.com/gradle/gradle/v8.14.3/gradle/wrapper/gradle-wrapper.jar")
	gradleFiles["project/gradle/wrapper/gradle-wrapper.properties"] = "distributionUrl=https\\://services.gradle.org/distributions/gradle-8.14.3-bin.zip\n"
	fixtures = append(fixtures, struct {
		name, kind, version, command, target, mode string
		files                                      map[string]string
		custom                                     []string
	}{"maven-wrapper", KindJava, "21.0.8+9", "java -jar /app/app.jar", "service", "source", mavenFiles, nil}, struct {
		name, kind, version, command, target, mode string
		files                                      map[string]string
		custom                                     []string
	}{"gradle-wrapper", KindJava, "21.0.8+9", "/app/bin/fixture", "service", "source", gradleFiles, nil}, struct {
		name, kind, version, command, target, mode string
		files                                      map[string]string
		custom                                     []string
	}{"jar-dependency", KindJava, "21.0.8+9", "java -cp '/app/app.jar:/app/lib/*' Main", "service", "source", map[string]string{"project/Main.java": strings.Replace(java, `"ok".getBytes()`, `sample.Helper.text().getBytes()`, 1), "project/libsrc/sample/Helper.java": `package sample; public class Helper { public static String text(){return "dependency-ok";} }`}, []string{"mkdir -p lib lib-classes classes", "javac -d lib-classes libsrc/sample/Helper.java", "jar cf lib/helper.jar -C lib-classes .", "javac -cp lib/helper.jar -d classes Main.java", "jar cf app.jar -C classes ."}})
	for index, fixture := range fixtures {
		t.Run(fixture.name, func(t *testing.T) {
			port := 47080 + index
			if fixture.kind == KindJava || fixture.kind == KindGo {
				fixture.command += " " + fmt.Sprint(port)
			}
			var b bytes.Buffer
			zw := zip.NewWriter(&b)
			for name, text := range fixture.files {
				f, e := zw.Create(name)
				if e != nil {
					t.Fatal(e)
				}
				_, _ = f.Write([]byte(text))
			}
			_ = zw.Close()
			src, e := m.archive(context.Background(), "fixture.zip", fixture.mode, bytes.NewReader(b.Bytes()))
			if e != nil {
				t.Fatal(e)
			}
			var c projectCandidate
			for _, candidate := range src.Report.Candidates {
				if candidate.Kind == fixture.kind {
					c = candidate
					break
				}
			}
			if c.ID == "" {
				t.Fatalf("未识别项目：%+v", src.Report)
			}
			cfg := buildConfig{CandidateID: c.ID, BuildVersion: fixture.version, RuntimeVersion: fixture.version, Command: fixture.command, Target: fixture.target}
			if len(fixture.custom) > 0 {
				cfg.BuildSteps = &fixture.custom
			}
			if len(c.Entries) == 1 {
				cfg.Entry = c.Entries[0]
			}
			input := deploymentInput{SourceID: src.ID, RequestID: newDeploymentID(), Name: "fixture-" + fixture.name, Port: port, Access: accessInput{Mode: AccessModeDirect}, Config: cfg}
			task, e := m.submit(context.Background(), input)
			if e != nil {
				t.Fatal(e)
			}
			defer func() {
				latest, _ := m.getTask(task.ID)
				if latest.ProjectID != "" {
					if e := s.Remove(context.Background(), latest.ProjectID); e != nil {
						t.Errorf("清理项目：%s", e)
					}
				}
			}()
			deadline := time.Now().Add(15 * time.Minute)
			for time.Now().Before(deadline) {
				time.Sleep(250 * time.Millisecond)
				task, e = m.getTask(task.ID)
				if e != nil {
					t.Fatal(e)
				}
				if task.State == "awaiting-config" {
					if len(task.Artifacts) != 1 {
						t.Fatalf("产物不唯一：%+v", task.Artifacts)
					}
					cfg.Artifact = task.Artifacts[0]
					_ = m.mutate(task.ID, func(t *deploymentTask) { t.Config = cfg; t.State = "queued" })
					go m.execute(context.Background(), task.ID)
					continue
				}
				if task.State == "succeeded" {
					break
				}
				if task.State == "failed" || task.State == "cancelled" {
					logs, _ := os.ReadFile(filepath.Join(m.logRoot, task.ID+".log"))
					t.Fatalf("部署失败：%s\n%s", task.Error, logs)
				}
			}
			if task.State != "succeeded" {
				t.Fatalf("部署未完成：%s", task.State)
			}
			row, e := s.record(context.Background(), task.ProjectID)
			if e != nil {
				t.Fatal(e)
			}
			if fixture.target == "static" && row.CurrentRelease != nil && row.CurrentRelease.RuntimeVersion != "" {
				t.Fatal("静态版本错误记录为语言运行时版本")
			}
			if row.CurrentRelease == nil || row.ContainerID == nil {
				t.Fatal("未登记独立运行容器与发布版本")
			}
			if e = s.assertRecordContainer(context.Background(), row); e != nil {
				t.Fatal(e)
			}
			if fixture.mode == "artifact" && task.TestResult != "skipped" {
				t.Fatal("成品包必须记录跳过")
			}
			t.Logf("成功：%s / %s / %s", task.State, task.TestResult, stringOrEmpty(row.ContainerID))
			if fixture.name == "jar-dependency" {
				var archive bytes.Buffer
				writer := zip.NewWriter(&archive)
				e := filepath.WalkDir(row.CurrentRelease.Directory, func(path string, d os.DirEntry, e error) error {
					if e != nil {
						return e
					}
					if d.IsDir() {
						return nil
					}
					name, _ := filepath.Rel(row.CurrentRelease.Directory, path)
					out, e := writer.Create(name)
					if e != nil {
						return e
					}
					f, e := os.Open(path)
					if e != nil {
						return e
					}
					defer f.Close()
					_, e = io.Copy(out, f)
					return e
				})
				if e != nil {
					t.Fatal(e)
				}
				_ = writer.Close()
				prepared, e := m.archive(context.Background(), "prebuilt.jar.zip", "artifact", bytes.NewReader(archive.Bytes()))
				if e != nil {
					t.Fatal(e)
				}
				var choice projectCandidate
				for _, candidate := range prepared.Report.Candidates {
					if candidate.Kind == KindJava && candidate.Directory == "." {
						choice = candidate
						break
					}
				}
				prebuilt, e := m.submit(context.Background(), deploymentInput{SourceID: prepared.ID, RequestID: newDeploymentID(), Name: "fixture-prebuilt-jar", Port: 47120, Access: accessInput{Mode: AccessModeDirect}, Config: buildConfig{CandidateID: choice.ID, Artifact: "app.jar", RuntimeVersion: fixture.version, Entry: "Main", Command: "java -cp '/app/app.jar:/app/lib/*' Main 47120", Target: "service"}})
				if e != nil {
					t.Fatal(e)
				}
				defer func() {
					latest, _ := m.getTask(prebuilt.ID)
					if latest.ProjectID != "" {
						_ = s.Remove(context.Background(), latest.ProjectID)
					}
				}()
				deadline := time.Now().Add(2 * time.Minute)
				for time.Now().Before(deadline) {
					time.Sleep(250 * time.Millisecond)
					prebuilt, _ = m.getTask(prebuilt.ID)
					if !activeDeployment(prebuilt.State) {
						break
					}
				}
				if prebuilt.State != "succeeded" || prebuilt.TestResult != "skipped" {
					t.Fatalf("成品 JAR 部署失败：%s / %s", prebuilt.State, prebuilt.Error)
				}
				t.Log("普通 JAR 与外部依赖成品包部署通过")
			}
			if fixture.name == "node-service" {
				wait := func(task deploymentTask) deploymentTask {
					t.Helper()
					deadline := time.Now().Add(4 * time.Minute)
					for time.Now().Before(deadline) {
						current, e := m.getTask(task.ID)
						if e != nil {
							t.Fatal(e)
						}
						if !activeDeployment(current.State) {
							return current
						}
						time.Sleep(100 * time.Millisecond)
					}
					t.Fatal("任务等待超时")
					return task
				}
				archiveNode := func(script, test string) sourceRecord {
					t.Helper()
					var b bytes.Buffer
					zw := zip.NewWriter(&b)
					for name, text := range map[string]string{"package.json": fmt.Sprintf(`{"name":"fixture","version":"1.0.0","main":"app.js","scripts":{"test":%q}}`, test), "app.js": script} {
						f, _ := zw.Create(name)
						_, _ = f.Write([]byte(text))
					}
					_ = zw.Close()
					src, e := m.archive(context.Background(), "node.zip", "source", bytes.NewReader(b.Bytes()))
					if e != nil {
						t.Fatal(e)
					}
					return src
				}
				originalID := stringOrEmpty(row.ContainerID)
				attempt := func(src sourceRecord, custom []string) deploymentTask {
					t.Helper()
					chosen := cfg
					chosen.CandidateID = src.Report.Candidates[0].ID
					if custom != nil {
						chosen.BuildSteps = &custom
					}
					next := deploymentInput{SourceID: src.ID, ProjectID: row.ID, RequestID: newDeploymentID(), Name: row.Name, Port: row.Port, Access: accessInput{Mode: AccessModeDirect}, Config: chosen}
					job, e := m.submit(context.Background(), next)
					if e != nil {
						t.Fatal(e)
					}
					duplicate, e := m.submit(context.Background(), next)
					if e != nil || duplicate.ID != job.ID {
						t.Fatal("重复请求未合并")
					}
					return job
				}
				assertOld := func() {
					t.Helper()
					current, e := s.record(context.Background(), row.ID)
					if e != nil || stringOrEmpty(current.ContainerID) != originalID {
						t.Fatal("失败影响了旧项目登记")
					}
					info, e := ops.Inspect(context.Background(), originalID)
					if e != nil || object(info["State"])["Running"] != true {
						t.Fatal("旧项目未继续运行")
					}
				}
				badTests := archiveNode(fixture.files["project/app.js"], `node -e "process.exit(1)"`)
				failed := wait(attempt(badTests, nil))
				if failed.State != "failed" {
					t.Fatalf("测试失败未停止：%s", failed.State)
				}
				assertOld()
				goodSource := archiveNode(fixture.files["project/app.js"], `node -e "process.exit(0)"`)
				failed = wait(attempt(goodSource, []string{"exit 1"}))
				if failed.State != "failed" {
					t.Fatal("构建失败未停止")
				}
				assertOld()
				cancellable := attempt(goodSource, []string{"sleep 30"})
				for i := 0; i < 100; i++ {
					current, _ := m.getTask(cancellable.ID)
					if current.State == "building" {
						break
					}
					time.Sleep(50 * time.Millisecond)
				}
				if _, e := s.SetRunning(context.Background(), row.ID, false); e == nil {
					t.Fatal("启停没有与部署互斥")
				}
				m.mu.Lock()
				cancel := m.cancel[cancellable.ID]
				m.mu.Unlock()
				cancel()
				cancelled := wait(cancellable)
				if cancelled.State != "cancelled" {
					t.Fatalf("取消状态错误：%s", cancelled.State)
				}
				assertOld()
				startFailure := archiveNode("process.exit(1)", `node -e "process.exit(0)"`)
				failed = wait(attempt(startFailure, nil))
				if failed.State != "failed" {
					t.Fatal("启动失败没有停止")
				}
				assertOld()
				success := wait(attempt(goodSource, nil))
				if success.State != "succeeded" {
					t.Fatalf("重新部署失败：%s", success.Error)
				}
				replaced, _ := s.record(context.Background(), row.ID)
				if replaced.PreviousRelease == nil || stringOrEmpty(replaced.ContainerID) == originalID {
					t.Fatal("未保留旧版本或没有独立新容器")
				}
				rollback, e := m.rollback(context.Background(), row.ID)
				if e != nil {
					t.Fatal(e)
				}
				rolled := wait(rollback)
				if rolled.State != "succeeded" {
					t.Fatalf("回滚失败：%s", rolled.Error)
				}
				recovered, _ := s.record(context.Background(), row.ID)
				if recovered.CurrentRelease.SourceID != src.ID || recovered.PreviousRelease == nil {
					t.Fatal("回滚版本记录错误")
				}
				t.Log("测试失败、构建失败、取消、操作互斥、重复提交、启动恢复、重新部署及回滚均通过")
			}

		})
	}
}

func TestDeploymentRealGitSources(t *testing.T) {
	if os.Getenv("ELYSIAN_DEPLOY_INTEGRATION") != "1" {
		t.Skip("真实 Git 验收需显式开启")
	}
	transport := docker.NewTransportFactory().New("/var/run/docker.sock")
	catalog := &fakeCatalogSource{report: runtimeCatalogReport{Catalog: runtimeCatalog{Go: []catalogEntry{{Version: "1.25.1", Image: "golang:1.25.1"}}}}}
	s := NewWebsiteService(serviceDeps{registry: NewMemoryWebsiteRegistry(), runtimeCatalog: catalog})
	m := newDeploymentManager(s, deploymentEngine{transport: transport, limits: defaultDeploymentLimits()}, filepath.Join(t.TempDir(), "tasks"), filepath.Join(t.TempDir(), "sources"), filepath.Join(t.TempDir(), "logs"))
	publicCommit := ""
	for _, tc := range []struct{ name, url, ref, token, state string }{
		{"公开默认分支", "https://github.com/octocat/Hello-World.git", "", "", "ready"},
		{"固定提交", "https://github.com/octocat/Hello-World.git", "7fd1a60b01f91b314f59955a4e4d5fc325923f18", "", "ready"},
		{"私有认证失败", "https://github.com/elysian-deployment-fixture/nonexistent-private.git", "", "elysian-fixture-sensitive-token", "failed"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if tc.name == "固定提交" {
				tc.ref = publicCommit
			}
			source, err := m.git(tc.url, tc.ref, tc.token, "source")
			if err != nil {
				t.Fatal(err)
			}
			deadline := time.Now().Add(2 * time.Minute)
			for time.Now().Before(deadline) {
				time.Sleep(250 * time.Millisecond)
				source, err = m.getSource(source.ID)
				if err != nil {
					t.Fatal(err)
				}
				if source.State != "preparing" {
					break
				}
			}
			if source.State != tc.state {
				t.Fatalf("Git 状态：%s / %s", source.State, source.Error)
			}
			if source.State == "ready" && (len(source.Commit) != 40 || exists(filepath.Join(m.sourceDir(source.ID), ".git/config"))) {
				t.Fatal("实际提交未固定或 Git 凭据配置残留")
			}
			if tc.name == "公开默认分支" {
				publicCommit = source.Commit
			}
			if tc.ref != "" && source.Commit != tc.ref {
				t.Fatal("没有固定指定提交")
			}
			if tc.token != "" {
				for _, root := range []string{m.root, m.sourceRoot, m.logRoot} {
					_ = filepath.WalkDir(root, func(path string, d os.DirEntry, e error) error {
						if e == nil && !d.IsDir() {
							b, _ := os.ReadFile(path)
							if bytes.Contains(b, []byte(tc.token)) {
								t.Error("令牌泄漏到持久文件")
							}
						}
						return e
					})
				}
			}
		})
	}
}
