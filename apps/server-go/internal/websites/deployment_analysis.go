package websites

import (
	"archive/zip"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

func smallText(path string) string {
	f, e := os.Open(path)
	if e != nil {
		return ""
	}
	defer f.Close()
	b, _ := io.ReadAll(io.LimitReader(f, 1<<20))
	return string(b)
}
func exists(path string) bool { info, e := os.Stat(path); return e == nil && info.Mode().IsRegular() }
func capture(pattern, text string) string {
	m := regexp.MustCompile(pattern).FindStringSubmatch(text)
	if len(m) > 1 {
		return m[1]
	}
	return ""
}
func skippedAnalysisDir(name string) bool {
	switch name {
	case ".git", "node_modules", ".venv", "venv", "__pycache__", ".gradle", ".idea", ".mvn", "target", "build":
		return true
	}
	return false
}
func analyzeSource(root, mode string) (analysisReport, error) {
	report := analysisReport{Candidates: []projectCandidate{}, Warnings: []string{}}
	dirs := map[string]bool{".": true}
	javaRoots := map[string][]string{}
	goEntries := map[string][]string{}
	goTestDirs := map[string]bool{}
	pythonDirs := map[string]bool{}
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, path)
		if d.IsDir() {
			if path != root && skippedAnalysisDir(d.Name()) && !(mode == "artifact" && (d.Name() == "build" || d.Name() == "target")) {
				return filepath.SkipDir
			}
			return nil
		}
		dir := filepath.ToSlash(filepath.Dir(rel))
		name := d.Name()
		switch name {
		case "pom.xml", "build.gradle", "build.gradle.kts", "package.json", "go.mod", "requirements.txt", "pyproject.toml", "index.html":
			dirs[dir] = true
		}
		if strings.HasSuffix(name, ".java") {
			key := dir
			pkg := capture(`(?m)^\s*package\s+([\w.]+)\s*;`, smallText(path))
			packagePath := strings.ReplaceAll(pkg, ".", "/")
			if packagePath != "" && (key == packagePath || strings.HasSuffix(key, "/"+packagePath)) {
				key = strings.TrimSuffix(strings.TrimSuffix(key, packagePath), "/")
				if key == "" {
					key = "."
				}
			}
			if i := strings.Index(key, "/src/"); i >= 0 {
				key = key[:i]
			} else if key == "src" || strings.HasPrefix(key, "src/") {
				key = "."
			}
			javaRoots[key] = append(javaRoots[key], rel)
			dirs[key] = true
		}
		if strings.HasSuffix(name, "_test.go") {
			goTestDirs[dir] = true
		}
		if strings.HasSuffix(name, ".go") && !strings.HasSuffix(name, "_test.go") {
			txt := smallText(path)
			if regexp.MustCompile(`(?m)^package\s+main\b`).MatchString(txt) && strings.Contains(txt, "func main(") {
				goEntries[dir] = append(goEntries[dir], rel)
			}
		}
		if strings.HasSuffix(name, ".py") && filepath.Base(dir) != "tests" {
			pythonDirs[dir] = true
			dirs[dir] = true
		}
		if mode == "artifact" && strings.HasSuffix(name, ".jar") {
			dirs[dir] = true
		}
		return nil
	})
	if err != nil {
		return report, err
	}
	keys := make([]string, 0, len(dirs))
	for d := range dirs {
		keys = append(keys, d)
	}
	sort.Strings(keys)
	add := func(c projectCandidate) {
		c.ID = fmt.Sprintf("candidate-%d", len(report.Candidates)+1)
		if c.Entries == nil {
			c.Entries = []string{}
		}
		if c.Artifacts == nil {
			c.Artifacts = []string{}
		}
		if c.TestSteps == nil {
			c.TestSteps = []string{}
		}
		if c.BuildSteps == nil {
			c.BuildSteps = []string{}
		}
		if c.Warnings == nil {
			c.Warnings = []string{}
		}
		report.Candidates = append(report.Candidates, c)
	}
	for _, dir := range keys {
		base := filepath.Join(root, dir)
		has := func(f string) bool { return exists(filepath.Join(base, f)) }
		start := len(report.Candidates)
		if has("pom.xml") {
			text := smallText(filepath.Join(base, "pom.xml"))
			c := projectCandidate{Directory: dir, Kind: KindJava, Tool: "maven", Wrapper: has("mvnw") && has(".mvn/wrapper/maven-wrapper.properties"), RequiredVersion: capture(`<maven.compiler.(?:release|target|source)>\s*(?:1\.)?(\d+)`, text)}
			if strings.Contains(text, "<packaging>war</packaging>") {
				c.Warnings = []string{"WAR / Tomcat 部署不在支持范围内"}
			}
			if c.Wrapper {
				c.ToolVersion = capture(`apache-maven-([0-9.]+)-`, smallText(filepath.Join(base, ".mvn/wrapper/maven-wrapper.properties")))
			}
			c.BuildSteps = []string{"clean verify", "导出运行依赖"}
			if hasDirectory(filepath.Join(base, "src/test")) {
				c.TestSteps = []string{"Maven verify 生命周期中的测试与检查"}
			}
			c.Artifacts = []string{"target/*.jar"}
			add(c)
		}
		if has("build.gradle") || has("build.gradle.kts") {
			text := smallText(filepath.Join(base, "build.gradle")) + smallText(filepath.Join(base, "build.gradle.kts"))
			c := projectCandidate{Directory: dir, Kind: KindJava, Tool: "gradle", Wrapper: has("gradlew") && has("gradle/wrapper/gradle-wrapper.jar") && has("gradle/wrapper/gradle-wrapper.properties"), RequiredVersion: capture(`(?:JavaLanguageVersion.of|JavaVersion.VERSION_)[(]?(?:1_)?([0-9]+)`, text)}
			if c.Wrapper {
				c.ToolVersion = capture(`gradle-([0-9.]+)-`, smallText(filepath.Join(base, "gradle/wrapper/gradle-wrapper.properties")))
			}
			c.BuildSteps = []string{"clean build --no-daemon"}
			if regexp.MustCompile(`\bapplication\b`).MatchString(text) {
				c.BuildSteps = append(c.BuildSteps, "installDist --no-daemon")
				c.Artifacts = []string{"build/install/*"}
			} else {
				c.Artifacts = []string{"build/libs/*.jar"}
				c.Warnings = []string{"普通 JAR 需要主类与运行依赖；可指定自定义步骤导出依赖"}
			}
			if hasDirectory(filepath.Join(base, "src/test")) {
				c.TestSteps = []string{"Gradle build 依赖的测试与检查"}
			}
			add(c)
		}
		if len(javaRoots[dir]) > 0 && !has("pom.xml") && !has("build.gradle") && !has("build.gradle.kts") {
			c := projectCandidate{Directory: dir, Kind: KindJava, Tool: "javac", Artifacts: []string{"app.jar"}, BuildSteps: []string{"javac 编译包结构与本地 lib/*.jar", "复制资源并打包 JAR"}}
			for _, rel := range javaRoots[dir] {
				text := smallText(filepath.Join(root, rel))
				if regexp.MustCompile(`\bstatic\s+void\s+main\s*\(`).MatchString(text) {
					pkg := capture(`(?m)^\s*package\s+([\w.]+)\s*;`, text)
					cls := strings.TrimSuffix(filepath.Base(rel), ".java")
					if pkg != "" {
						cls = pkg + "." + cls
					}
					c.Entries = append(c.Entries, cls)
				}
			}
			if len(c.Entries) == 1 {
				c.SuggestedCommand = "java -cp '/app/app.jar:/app/lib/*' " + c.Entries[0]
			}
			add(c)
		}
		if has("package.json") {
			var p struct {
				PackageManager string            `json:"packageManager"`
				Main           string            `json:"main"`
				Scripts        map[string]string `json:"scripts"`
				Engines        map[string]string `json:"engines"`
			}
			if e := json.Unmarshal([]byte(smallText(filepath.Join(base, "package.json"))), &p); e != nil {
				return report, fmt.Errorf("%s/package.json 无效", dir)
			}
			tools := []string{}
			if p.PackageManager != "" {
				tool := strings.Split(p.PackageManager, "@")[0]
				switch tool {
				case "npm", "pnpm", "yarn", "bun":
					tools = append(tools, tool)
				default:
					report.Warnings = append(report.Warnings, "不支持 packageManager："+tool)
				}
			}
			for _, lock := range []struct{ f, t string }{{"package-lock.json", "npm"}, {"pnpm-lock.yaml", "pnpm"}, {"yarn.lock", "yarn"}, {"bun.lock", "bun"}, {"bun.lockb", "bun"}} {
				if has(lock.f) {
					found := false
					for _, t := range tools {
						if t == lock.t {
							found = true
						}
					}
					if !found {
						tools = append(tools, lock.t)
					}
				}
			}
			if len(tools) == 0 {
				tools = []string{"npm"}
			}
			for _, tool := range tools {
				c := projectCandidate{Directory: dir, Kind: KindNode, Tool: tool, RequiredVersion: p.Engines["node"], BuildSteps: []string{"安装依赖"}}
				if strings.HasPrefix(p.PackageManager, tool+"@") {
					c.ToolVersion = strings.SplitN(p.PackageManager, "@", 2)[1]
				}
				if _, ok := p.Scripts["test"]; ok {
					c.TestSteps = []string{tool + " run test"}
				}
				if _, ok := p.Scripts["build"]; ok {
					c.BuildSteps = append(c.BuildSteps, tool+" run build")
					c.Artifacts = []string{"dist", "build", "out"}
				}
				if p.Main != "" && has(p.Main) {
					c.Entries = []string{p.Main}
					c.SuggestedCommand = "node " + shellQuote("/app/"+p.Main)
				} else if _, ok := p.Scripts["start"]; ok {
					c.SuggestedCommand = "npm start"
				}
				if len(tools) > 1 {
					c.Warnings = []string{"packageManager 与锁文件存在多个工具，请选择"}
				}
				add(c)
			}
		}
		if has("go.mod") {
			c := projectCandidate{Directory: dir, Kind: KindGo, Tool: "go", RequiredVersion: capture(`(?m)^go\s+([0-9.]+)`, smallText(filepath.Join(base, "go.mod"))), BuildSteps: []string{"go build 目标 main 包"}, Artifacts: []string{"server"}, SuggestedCommand: "/app/server"}
			toolchain := capture(`(?m)^toolchain\s+go([0-9.]+)`, smallText(filepath.Join(base, "go.mod")))
			if toolchain != "" && compareDeploymentVersions(toolchain, c.RequiredVersion) > 0 {
				c.RequiredVersion = toolchain
			}
			for testDir := range goTestDirs {
				if dir == "." || testDir == dir || strings.HasPrefix(testDir, dir+"/") {
					c.TestSteps = []string{"go test ./..."}
					break
				}
			}
			for gd := range goEntries {
				if dir == "." || gd == dir || strings.HasPrefix(gd, dir+"/") {
					entry, _ := filepath.Rel(dir, gd)
					c.Entries = append(c.Entries, filepath.ToSlash(entry))
				}
			}
			sort.Strings(c.Entries)
			add(c)
		}
		if has("requirements.txt") || has("pyproject.toml") || has("app.py") || has("main.py") || has("server.py") || pythonDirs[dir] {
			text := smallText(filepath.Join(base, "pyproject.toml"))
			tool := "pip"
			if has("uv.lock") {
				tool = "uv"
			} else if has("poetry.lock") || strings.Contains(text, "[tool.poetry]") {
				tool = "poetry"
			}
			c := projectCandidate{Directory: dir, Kind: KindPython, Tool: tool, BuildSteps: []string{"创建 /app/.venv 并安装项目依赖"}, RequiredVersion: capture(`requires-python\s*=\s*"([^"]+)"`, text)}
			if has("pytest.ini") || hasDirectory(filepath.Join(base, "tests")) || strings.Contains(text, "[tool.pytest") || strings.Contains(text, "pytest") {
				c.TestSteps = []string{"/app/.venv/bin/python -m pytest"}
			}
			for _, f := range []string{"app.py", "main.py", "server.py"} {
				if has(f) {
					c.Entries = append(c.Entries, f)
				}
			}
			if len(c.Entries) == 1 {
				c.SuggestedCommand = "/app/.venv/bin/python /app/" + c.Entries[0]
			}
			add(c)
		}
		if has("index.html") && len(report.Candidates) == start {
			add(projectCandidate{Directory: dir, Kind: KindHTML, Tool: "static", Artifacts: []string{"."}, BuildSteps: []string{"校验静态目录与 index.html"}})
		}
		if mode == "artifact" && len(report.Candidates) == start {
			matches, _ := filepath.Glob(filepath.Join(base, "*.jar"))
			if len(matches) > 0 {
				c := projectCandidate{Directory: dir, Kind: KindJava, Tool: "artifact"}
				for _, f := range matches {
					c.Artifacts = append(c.Artifacts, filepath.Base(f))
					required := jarRequiredVersion(f)
					if required > versionMajor(c.RequiredVersion) {
						c.RequiredVersion = strconv.Itoa(required)
					}
					main, _ := jarMainClass(f)
					if len(matches) == 1 && main != "" {
						c.SuggestedCommand = "java -jar /app/" + filepath.Base(f)
					}
					if main != "" {
						c.Entries = append(c.Entries, main)
					}
				}
				add(c)
			}
		}
	}
	if len(report.Candidates) == 0 {
		for _, kind := range []string{KindNode, KindPython, KindGo, KindJava, KindHTML} {
			tool := "artifact"
			warnings := []string{"未识别到描述文件，请确认项目类型、入口与步骤"}
			if mode == "source" {
				tool = map[string]string{KindNode: "npm", KindPython: "pip", KindGo: "go", KindJava: "javac", KindHTML: "static"}[kind]
			}
			add(projectCandidate{Directory: ".", Kind: kind, Tool: tool, Warnings: warnings})
		}
	}
	if mode == "artifact" {
		for i := range report.Candidates {
			c := &report.Candidates[i]
			c.Tool = "artifact"
			c.BuildSteps = []string{}
			c.TestSteps = []string{}
			c.Warnings = append(c.Warnings, "已构建产物：明确跳过测试与构建")
		}
	}
	return report, nil
}
func jarMainClass(path string) (string, error) {
	z, e := zip.OpenReader(path)
	if e != nil {
		return "", e
	}
	defer z.Close()
	for _, f := range z.File {
		if strings.EqualFold(f.Name, "META-INF/MANIFEST.MF") {
			r, e := f.Open()
			if e != nil {
				return "", e
			}
			b, e := io.ReadAll(io.LimitReader(r, 64<<10))
			_ = r.Close()
			if e != nil {
				return "", e
			}
			text := strings.ReplaceAll(strings.ReplaceAll(string(b), "\r\n ", ""), "\n ", "")
			return capture(`(?mi)^Main-Class:\s*([^\r\n]+)`, text), nil
		}
	}
	return "", nil
}

func hasDirectory(path string) bool { info, e := os.Stat(path); return e == nil && info.IsDir() }

// 多版本 JAR 的版本目录由 JVM 按运行版本选用；仅基线 class 决定最低 JRE。
func jarRequiredVersion(path string) int {
	z, err := zip.OpenReader(path)
	if err != nil {
		return 0
	}
	defer z.Close()
	required := 0
	for _, file := range z.File {
		if !strings.HasSuffix(file.Name, ".class") || strings.HasPrefix(file.Name, "META-INF/versions/") || filepath.Base(file.Name) == "module-info.class" {
			continue
		}
		reader, err := file.Open()
		if err != nil {
			continue
		}
		var header [8]byte
		_, err = io.ReadFull(reader, header[:])
		_ = reader.Close()
		if err == nil && binary.BigEndian.Uint32(header[:4]) == 0xcafebabe {
			version := int(binary.BigEndian.Uint16(header[6:])) - 44
			if version > required {
				required = version
			}
		}
	}
	return required
}
