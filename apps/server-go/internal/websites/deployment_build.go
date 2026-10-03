package websites

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

var regexpDeploymentID = regexp.MustCompile(`^[a-f0-9-]{36}$`)

func newDeploymentID() string { return randomUUID() }
func candidateFor(s sourceRecord, id string) (projectCandidate, error) {
	if s.Report != nil {
		for _, c := range s.Report.Candidates {
			if c.ID == id {
				return c, nil
			}
		}
	}
	return projectCandidate{}, errors.New("请选择识别出的项目目录和构建工具")
}
func versionMajor(v string) int { n, _ := strconv.Atoi(capture(`^(\d+)`, v)); return n }
func (m *deploymentManager) validateConfig(ctx context.Context, src sourceRecord, cfg buildConfig) (projectCandidate, string, string, error) {
	c, err := candidateFor(src, cfg.CandidateID)
	if err != nil {
		return c, "", "", err
	}
	if src.Mode == "source" && c.Wrapper && (c.Tool == "maven" || c.Tool == "gradle") && !regexp.MustCompile(`^\d+\.\d+(?:\.\d+)?$`).MatchString(c.ToolVersion) {
		return c, "", "", errors.New("Wrapper 未声明可识别的精确工具版本，请修正 Wrapper distributionUrl")
	}
	if cfg.Target != "service" && cfg.Target != "static" {
		return c, "", "", errors.New("请选择服务或静态站点部署目标")
	}
	if cfg.Target == "static" && c.Kind != KindHTML && c.Kind != KindNode {
		return c, "", "", errors.New("静态部署目标仅支持 HTML 或 Node 项目")
	}
	if cfg.Target == "service" && !(src.Mode == "source" && c.Kind == KindJava && cfg.Command == "") {
		if _, err = WebsiteContainerCmd(c.Kind, stringPtr(cfg.Command)); err != nil {
			return c, "", "", err
		}
	}
	if len(c.Entries) > 1 && cfg.Entry == "" {
		return c, "", "", errors.New("项目包含多个入口，请选择主类或 main 包")
	}
	if c.Tool == "javac" && cfg.Entry == "" && len(c.Entries) != 1 {
		return c, "", "", errors.New("普通 Java 项目需要指定主类")
	}
	if cfg.Entry != "" {
		if c.Kind == KindJava && !regexp.MustCompile(`^[\w.$]+$`).MatchString(cfg.Entry) {
			return c, "", "", errors.New("Java 主类名称无效")
		}
		if c.Kind == KindGo {
			if _, err = archivePath("/app", cfg.Entry); err != nil {
				return c, "", "", err
			}
		}
	}
	for _, steps := range []*[]string{cfg.TestSteps, cfg.BuildSteps} {
		if steps != nil {
			if len(*steps) > 20 {
				return c, "", "", errors.New("自定义步骤最多 20 条")
			}
			for _, step := range *steps {
				if len(step) > 8192 || strings.ContainsRune(step, 0) {
					return c, "", "", errors.New("自定义步骤无效")
				}
			}
		}
	}
	for _, warning := range c.Warnings {
		if strings.Contains(warning, "WAR") {
			return c, "", "", errors.New(warning)
		}
	}
	if c.Kind == KindHTML && (cfg.TestSteps != nil || cfg.BuildSteps != nil) {
		return c, "", "", errors.New("HTML 静态目录只执行校验；自定义构建请使用 Node 项目")
	}
	runtime := ""
	build := ""
	if c.Kind == KindHTML || (cfg.Target == "static" && src.Mode == "artifact") {
		runtime = WEBSITE_HTML_IMAGE
		return c, build, runtime, nil
	}
	catalog, err := m.service.RuntimeCatalog(ctx)
	if err != nil {
		return c, "", "", err
	}
	if cfg.Target == "static" {
		runtime = WEBSITE_HTML_IMAGE
	} else {
		ref := WebsiteRuntimeImageRef(c.Kind, stringPtr(cfg.RuntimeVersion), &catalog.Catalog)
		if ref == nil {
			return c, "", "", errors.New("运行时版本不在正式目录中，请刷新")
		}
		runtime = *ref
	}
	if c.Kind == KindJava && src.Mode == "artifact" && versionMajor(cfg.RuntimeVersion) < versionMajor(c.RequiredVersion) {
		return c, "", "", errors.New("JAR 字节码要求更高的运行 JRE，请调整版本")
	}
	if c.Kind == KindNode && cfg.Target == "service" && c.RequiredVersion != "" && !deploymentVersionSatisfies(cfg.RuntimeVersion, c.RequiredVersion) {
		return c, "", "", errors.New("运行时版本不满足项目声明的 Node 版本要求，请调整")
	}
	if src.Mode == "source" {
		ref := WebsiteRuntimeImageRef(c.Kind, stringPtr(cfg.BuildVersion), &catalog.Catalog)
		if ref == nil {
			return c, "", "", errors.New("构建版本不在正式目录中，请刷新")
		}
		build = *ref
		if c.Kind == KindJava {
			build = strings.Replace(build, "-jre", "-jdk", 1)
			targetMajor := versionMajor(c.RequiredVersion)
			if targetMajor == 0 {
				targetMajor = versionMajor(cfg.BuildVersion)
			}
			if cfg.Target == "service" && versionMajor(cfg.RuntimeVersion) < targetMajor {
				return c, "", "", errors.New("Java 运行 JRE 版本低于项目目标版本，请调整 JDK / JRE 或构建配置")
			}
			required := versionMajor(c.RequiredVersion)
			if required > versionMajor(cfg.BuildVersion) {
				return c, "", "", fmt.Errorf("项目要求 Java %d，构建 JDK 版本不兼容", required)
			}
		}
		if c.Kind == KindHTML && (cfg.TestSteps != nil || cfg.BuildSteps != nil) {
			return c, "", "", errors.New("HTML 静态目录只执行校验；自定义构建请使用 Node 项目")
		}
		if c.Tool == "gradle" {
			version := cfg.ToolVersion
			if version == "" {
				version = c.ToolVersion
			}
			if version == "" {
				version = "8.14.3"
			}
			if versionMajor(cfg.BuildVersion) < 17 && versionMajor(version) >= 9 {
				return c, "", "", errors.New("Gradle 9 需要 Java 17 或以上构建 JDK")
			}
			minimum := map[int]string{17: "7.3.0", 18: "7.5.0", 19: "7.6.0", 20: "8.3.0", 21: "8.5.0", 22: "8.8.0", 23: "8.10.0", 24: "8.14.0", 25: "9.1.0", 26: "9.4.0", 27: "9.8.0"}[versionMajor(cfg.BuildVersion)]
			if minimum != "" && compareDeploymentVersions(version, minimum) < 0 {
				return c, "", "", fmt.Errorf("Gradle %s 与所选构建 JDK 不兼容，需要 Gradle %s 或调整 JDK", version, minimum)
			}
		}
		if (c.Kind == KindNode || c.Kind == KindPython) && c.RequiredVersion != "" && !deploymentVersionSatisfies(cfg.BuildVersion, c.RequiredVersion) {
			return c, "", "", errors.New("构建版本不满足项目声明的版本要求，请调整")
		}
		if c.Kind == KindPython && cfg.Target == "service" && cfg.RuntimeVersion != cfg.BuildVersion {
			return c, "", "", errors.New("Python 独立依赖环境要求构建与运行版本一致，请调整版本")
		}
		if c.Kind == KindGo && c.RequiredVersion != "" && compareDeploymentVersions(cfg.BuildVersion, c.RequiredVersion) < 0 {
			return c, "", "", errors.New("Go 构建版本低于 go.mod 声明版本")
		}
	}
	return c, build, runtime, nil
}
func compareDeploymentVersions(a, b string) int {
	aa := strings.Split(a, ".")
	bb := strings.Split(b, ".")
	for i := 0; i < 3; i++ {
		av, bv := 0, 0
		if i < len(aa) {
			av, _ = strconv.Atoi(aa[i])
		}
		if i < len(bb) {
			bv, _ = strconv.Atoi(bb[i])
		}
		if av < bv {
			return -1
		}
		if av > bv {
			return 1
		}
	}
	return 0
}
func buildScript(c projectCandidate, cfg buildConfig, arch string) (string, string) {
	q := shellQuote
	entry := cfg.Entry
	if entry == "" && len(c.Entries) == 1 {
		entry = c.Entries[0]
	}
	toolVersion := cfg.ToolVersion
	if toolVersion == "" {
		toolVersion = c.ToolVersion
	}
	install := ""
	tests := strings.Join(c.TestSteps, "\n")
	build := ""
	artifact := cfg.Artifact
	switch c.Tool {
	case "javac":
		tests = ""
		build = `mkdir -p .elysian/classes lib
find . -name '*.java' -not -path './.elysian/*' -not -path './src/test/*' | sed 's/\\/\\\\/g; s/"/\\"/g; s/.*/"&"/' > .elysian/sources
javac -encoding UTF-8 -cp 'lib/*' -d .elysian/classes @.elysian/sources
if [ -d src/main/resources ]; then cp -R src/main/resources/. .elysian/classes/; fi
if [ -d resources ]; then cp -R resources/. .elysian/classes/; fi
jar cfe app.jar ` + q(entry) + " -C .elysian/classes ."
		if artifact == "" {
			artifact = "app.jar"
		}
	case "maven":
		mvn := "/app/.elysian-tools/maven/bin/mvn"
		if c.Wrapper {
			mvn = "sh ./mvnw"
		}
		tests = ""
		skip := ""
		if cfg.SkipTests {
			skip = " -DskipTests"
		}
		build = mvn + " -B clean verify" + skip + "\n" + mvn + " -B dependency:copy-dependencies -DincludeScope=runtime -DoutputDirectory=dependencies"
		if artifact == "" {
			artifact = "target/*.jar"
		}
	case "gradle":
		gradle := "/app/.elysian-tools/gradle/bin/gradle"
		if c.Wrapper {
			gradle = "sh ./gradlew"
		}
		tests = ""
		skip := ""
		if cfg.SkipTests {
			skip = " -x test"
		}
		build = gradle + " clean build --no-daemon" + skip
		if len(c.BuildSteps) > 1 {
			build += "\n" + gradle + " installDist --no-daemon"
			if artifact == "" {
				artifact = "build/install/*"
			}
		} else if artifact == "" {
			artifact = "build/libs/*.jar"
		}
	case "npm", "pnpm", "yarn", "bun":
		tool := c.Tool
		if tool != "npm" || toolVersion != "" {
			if toolVersion == "" {
				toolVersion = map[string]string{"pnpm": "10.17.1", "yarn": "1.22.22", "bun": "1.2.22"}[tool]
			}
			if tool == "yarn" && versionMajor(toolVersion) >= 2 {
				install = "npm install -g corepack@0.34.0\ncorepack enable\ncorepack prepare " + q("yarn@"+toolVersion) + " --activate\n"
			} else {
				install = "npm install -g " + q(tool+"@"+toolVersion) + "\n"
			}
		}
		switch tool {
		case "npm":
			install += "if [ -f package-lock.json ]; then npm ci; else npm install; fi"
		case "pnpm":
			install += "pnpm install --frozen-lockfile"
		case "yarn":
			if versionMajor(toolVersion) >= 2 {
				install += "yarn install --immutable"
			} else {
				install += "yarn install --frozen-lockfile"
			}
		case "bun":
			install += "bun install --frozen-lockfile"
		}
		build = ""
		for _, s := range c.BuildSteps {
			if strings.Contains(s, " run build") {
				build = tool + " run build"
			}
		}
		if cfg.Target == "service" && artifact == "" {
			artifact = "."
		}
	case "go":
		install = "export GOTOOLCHAIN=local\ngo mod download"
		if entry == "" {
			entry = "."
		}
		tests = "go test ./..."
		build = "CGO_ENABLED=0 GOOS=linux GOARCH=" + q(arch) + " go build -trimpath -o server " + q("./"+strings.TrimPrefix(entry, "./"))
		if artifact == "" {
			artifact = "server"
		}
	case "pip", "uv", "poetry":
		install = "python -m venv --copies /app/.venv\nexport PATH=/app/.venv/bin:$PATH\n"
		switch c.Tool {
		case "pip":
			install += "if [ -f requirements.txt ]; then python -m pip install -r requirements.txt; fi\nif [ -f pyproject.toml ] && grep -Eq 'build-system|project' pyproject.toml; then python -m pip install .; fi"
		case "uv":
			if toolVersion == "" {
				toolVersion = "0.8.22"
			}
			install += "python -m pip install " + q("uv=="+toolVersion) + "\nUV_PROJECT_ENVIRONMENT=/app/.venv uv sync --frozen"
		case "poetry":
			if toolVersion == "" {
				toolVersion = "2.2.1"
			}
			install += "python -m pip install " + q("poetry=="+toolVersion) + "\npoetry config virtualenvs.create false\npoetry install --no-interaction"
		}
		build = `if [ -f pyproject.toml ] && grep -Eq '\[build-system\]|\[project\]|\[tool.poetry\]' pyproject.toml; then python -m pip wheel --no-deps --wheel-dir .elysian-wheels .; fi`
		if artifact == "" {
			artifact = "."
		}
	case "static", "artifact":
		tests = ""
		build = ""
		if artifact == "" {
			artifact = "."
		}
	}
	if cfg.TestSteps != nil {
		tests = strings.Join(*cfg.TestSteps, "\n")
	}
	if cfg.BuildSteps != nil {
		build = strings.Join(*cfg.BuildSteps, "\n")
	}
	if cfg.SkipTests {
		tests = ""
	}
	script := "set -eu\ncd /app\n" + install + "\n"
	if tests != "" {
		script += "printf '\\n[测试开始]\\n'\n" + tests + "\nprintf '\\n[测试完成]\\n'\n"
	}
	script += "printf '\\n[构建开始]\\n'\n" + build + "\nprintf '\\n[构建完成]\\n'\n"
	script += "mkdir -p /tmp/elysian-export\ntar --hard-dereference -chf /tmp/elysian-export/app.tar -C /app .\n"
	return script, artifact
}
func (m *deploymentManager) stageTool(ctx context.Context, c projectCandidate, id string, cfg buildConfig) error {
	if c.Wrapper || (c.Tool != "maven" && c.Tool != "gradle") {
		return nil
	}
	version := cfg.ToolVersion
	if version == "" {
		version = c.ToolVersion
	}
	image, dir := "", ""
	if c.Tool == "maven" {
		if version == "" {
			version = "3.9.11"
		}
		image = "maven:" + version + "-eclipse-temurin-21"
		dir = "/usr/share/maven"
	} else {
		if version == "" {
			version = "8.14.3"
		}
		image = "gradle:" + version + "-jdk21"
		dir = "/opt/gradle"
	}
	if !regexp.MustCompile(`^\d+\.\d+\.\d+$`).MatchString(version) {
		return errors.New("构建工具需要精确版本")
	}
	if err := m.engine.pull(ctx, image); err != nil {
		return err
	}
	toolContainer, err := m.engine.create(ctx, image, []string{"true"}, nil, false)
	if err != nil {
		return err
	}
	defer m.engine.remove(toolContainer)
	tmp, err := os.MkdirTemp(m.sourceRoot, "tool-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)
	dest := filepath.Join(tmp, ".elysian-tools", c.Tool)
	if err = m.engine.export(ctx, toolContainer, dir, dest); err != nil {
		return err
	}
	return m.engine.put(ctx, id, tmp)
}
func copyDeploymentTree(ctx context.Context, src, dest string) error {
	if err := os.MkdirAll(dest, 0755); err != nil {
		return err
	}
	return filepath.WalkDir(src, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if err = ctx.Err(); err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, path)
		if rel == "." {
			return nil
		}
		if d.Name() == ".git" {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		if !info.IsDir() && !info.Mode().IsRegular() {
			return errors.New("产物包含链接或特殊文件")
		}
		target := filepath.Join(dest, rel)
		if info.IsDir() {
			return os.MkdirAll(target, 0755)
		}
		in, err := os.Open(path)
		if err != nil {
			return err
		}
		defer in.Close()
		out, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, info.Mode().Perm())
		if err != nil {
			return err
		}
		_, err = io.Copy(out, contextReader{ctx, in})
		ce := out.Close()
		if err != nil {
			return err
		}
		return ce
	})
}

// Node engines 与 Python requires-python 常见比较、兼容和通配范围。
func deploymentVersionSatisfies(version, rangeText string) bool {
	for _, branch := range strings.Split(rangeText, "||") {
		matches := regexp.MustCompile(`(>=|<=|>|<|!=|==|=|\^|~=|~)?\s*(\d+(?:\.\d+){0,2})(?:\.([xX*]))?`).FindAllStringSubmatch(branch, -1)
		ok := len(matches) > 0
		for _, m := range matches {
			op, bound := m[1], m[2]
			comparison := compareDeploymentVersions(version, bound)
			switch op {
			case ">=":
				ok = ok && comparison >= 0
			case ">":
				ok = ok && comparison > 0
			case "<=":
				ok = ok && comparison <= 0
			case "<":
				ok = ok && comparison < 0
			case "!=":
				equal := version == bound || strings.HasPrefix(version, bound+".")
				ok = ok && !equal
			case "^":
				prefix := strings.Split(bound, ".")
				n := 1
				if prefix[0] == "0" && len(prefix) > 1 {
					n = 2
					if prefix[1] == "0" && len(prefix) > 2 {
						n = 3
					}
				}
				v := strings.Split(version, ".")
				ok = ok && comparison >= 0 && len(v) >= n && strings.Join(v[:n], ".") == strings.Join(prefix[:n], ".")
			case "~", "~=":
				prefix := strings.Split(bound, ".")
				v := strings.Split(version, ".")
				n := len(prefix) - 1
				if op == "~" {
					n = len(prefix)
					if n > 2 {
						n = 2
					}
				}
				if n < 1 {
					n = 1
				}
				if n > len(v) {
					ok = false
				} else {
					ok = ok && comparison >= 0 && strings.Join(prefix[:n], ".") == strings.Join(v[:n], ".")
				}
			default:
				ok = ok && (version == bound || strings.HasPrefix(version, bound+"."))
			}
		}
		if ok {
			return true
		}
	}
	return strings.TrimSpace(rangeText) == "*"
}
