package websites

import (
	"archive/tar"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"

	"time"

	"elysian/server/internal/shared"
)

func (m *deploymentManager) submit(ctx context.Context, in deploymentInput) (deploymentTask, error) {
	if !safeDeploymentID(in.RequestID) {
		return deploymentTask{}, shared.InvalidRequest("请求标识无效")
	}
	// Hash the caller's complete input before defaulting or removing PEM fields.
	// The digest permits exact retries without persisting certificate material.
	rawInput, err := json.Marshal(in)
	if err != nil {
		return deploymentTask{}, shared.InvalidRequest("部署请求格式无效")
	}
	hash := sha256.Sum256(rawInput)
	requestDigest := hex.EncodeToString(hash[:])
	m.mu.Lock()
	for _, t := range m.tasks {
		if t.Input.RequestID == in.RequestID {
			if t.RequestDigest == "" || t.RequestDigest != requestDigest {
				m.mu.Unlock()
				return deploymentTask{}, shared.InvalidRequest("请求标识已用于其他部署")
			}
			copy := *t
			m.mu.Unlock()
			return copy, nil
		}
	}
	m.mu.Unlock()
	src, err := m.getSource(in.SourceID)
	if err != nil {
		return deploymentTask{}, err
	}
	if src.State != "ready" {
		return deploymentTask{}, shared.InvalidRequest("来源尚未准备完成")
	}
	c, build, runtime, err := m.validateConfig(ctx, src, in.Config)
	if err != nil {
		return deploymentTask{}, shared.InvalidRequest(err.Error())
	}
	if in.Config.ToolVersion == "" {
		in.Config.ToolVersion = c.ToolVersion
		if in.Config.ToolVersion == "" {
			in.Config.ToolVersion = map[string]string{"maven": "3.9.11", "gradle": "8.14.3", "pnpm": "10.17.1", "yarn": "1.22.22", "bun": "1.2.22", "uv": "0.8.22", "poetry": "2.2.1"}[c.Tool]
		}
	}
	if !IsValidWebsiteProjectName(in.Name) || in.Port < 1 || in.Port > 65535 {
		return deploymentTask{}, shared.InvalidRequest("项目名称或端口无效")
	}
	if in.Access.Mode != "direct" && in.Access.Mode != "domain" {
		return deploymentTask{}, shared.InvalidRequest("访问方式无效")
	}
	var certificate *WebsiteCertificateRef
	if in.ProjectID != "" {
		row, err := m.service.record(ctx, in.ProjectID)
		if err != nil {
			return deploymentTask{}, err
		}
		if row.Name != in.Name || row.Port != in.Port {
			return deploymentTask{}, shared.InvalidRequest("重新部署保持项目名称与端口，请通过访问设置修改配置")
		}
		in.Access = accessInput{Mode: row.AccessMode}
		if row.Domain != nil {
			in.Access.Domain = *row.Domain
		}
		certificate = row.Certificate
	} else if in.Access.Mode == "domain" {
		if in.Access.CertificatePEM == nil || in.Access.PrivateKeyPEM == nil {
			return deploymentTask{}, shared.InvalidRequest("域名访问需要公开 CA 证书链与私钥")
		}
		material := CertificateMaterial{CertificatePEM: *in.Access.CertificatePEM, PrivateKeyPEM: *in.Access.PrivateKeyPEM}
		metadata, err := ValidateWebsiteCertificate(material, in.Access.Domain, m.service.deps.trustedRoots, time.Now())
		if err != nil {
			return deploymentTask{}, err
		}
		if _, err = m.service.deps.caddy.CurrentConfig(ctx); err != nil {
			return deploymentTask{}, err
		}
		ref, err := m.service.deps.certificates.Save(ctx, material)
		if err != nil {
			return deploymentTask{}, err
		}
		certificate = &WebsiteCertificateRef{Ref: ref, Issuer: metadata.Issuer, NotAfter: metadata.NotAfter, Fingerprint256: metadata.Fingerprint256}
	}
	// PEM 先收口到专用证书存储，任务登记只保留引用。
	in.Access.CertificatePEM = nil
	in.Access.PrivateKeyPEM = nil
	id := newDeploymentID()
	now := time.Now().UTC().Format(time.RFC3339)
	t := deploymentTask{RequestDigest: requestDigest, Port: in.Port, ID: id, SourceID: src.ID, ProjectID: in.ProjectID, Name: in.Name, State: "queued", Stage: "等待构建资源", CreatedAt: now, UpdatedAt: now, Config: in.Config, BuildImage: build, RuntimeImage: runtime, TestResult: "pending", Input: in, StagedCertificate: certificate}
	if src.Mode == "artifact" || in.Config.SkipTests {
		t.TestResult = "skipped"
	} else if len(c.TestSteps) == 0 && in.Config.TestSteps == nil {
		t.TestResult = "absent"
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, existing := range m.tasks {
		if existing.Input.RequestID == in.RequestID {
			if existing.RequestDigest == "" || existing.RequestDigest != requestDigest {
				return deploymentTask{}, shared.InvalidRequest("请求标识已用于其他部署")
			}
			return *existing, nil
		}
		if (activeDeployment(existing.State) || existing.State == "awaiting-config") && ((in.ProjectID != "" && existing.ProjectID == in.ProjectID) || (in.ProjectID == "" && existing.Name == in.Name)) {
			return deploymentTask{}, &shared.InvalidRequestError{Status: 409, Message: "项目已有部署任务"}
		}
	}
	if err = writeDeploymentJSON(filepath.Join(m.root, id+".json"), &t); err != nil {
		return deploymentTask{}, err
	}
	m.tasks[id] = &t
	ctx, cancel := context.WithCancel(context.Background())
	m.cancel[id] = cancel
	go m.execute(ctx, id)
	return t, nil
}
func (m *deploymentManager) execute(parent context.Context, id string) {
	defer func() { m.mu.Lock(); delete(m.cancel, id); m.mu.Unlock() }()
	select {
	case m.workers <- struct{}{}:
	case <-parent.Done():
		_ = m.mutate(id, func(t *deploymentTask) { t.State = "cancelled"; t.Stage = "已取消" })
		return
	}
	defer func() { <-m.workers }()
	ctx, cancel := context.WithTimeout(parent, m.engine.limits.Timeout)
	defer cancel()
	t, err := m.getTask(id)
	if err != nil {
		return
	}
	key := t.ProjectID
	if key == "" {
		key = "deployment-name:" + t.Name
	}
	if !m.service.inProgress.acquire(key) {
		m.fail(id, errors.New("项目正在执行其他操作"), false)
		return
	}
	defer m.service.inProgress.remove(key)
	src, err := m.getSource(t.SourceID)
	if err != nil {
		m.fail(id, err, false)
		return
	}
	c, err := candidateFor(src, t.Config.CandidateID)
	if err != nil {
		m.fail(id, err, false)
		return
	}
	workspace := filepath.Join(m.sourceRoot, id+"-output")
	defer func() {
		latest, _ := m.getTask(id)
		if latest.State != "awaiting-config" {
			_ = os.RemoveAll(workspace)
		}
	}()
	if !exists(filepath.Join(workspace, ".ready")) {
		if src.Mode == "artifact" || c.Kind == KindHTML {
			err = copyDeploymentTree(ctx, filepath.Join(m.sourceDir(src.ID), c.Directory), filepath.Join(workspace, "app"))
			m.log(id, "已构建产物或静态目录：跳过测试与构建")
		} else {
			_ = m.mutate(id, func(t *deploymentTask) { t.State = "building"; t.Stage = "准备精确版本构建镜像" })
			if err = m.engine.pull(ctx, t.BuildImage); err == nil {
				arch := "amd64"
				info, e := m.engine.json(ctx, "GET", "/info", nil)
				if e != nil {
					err = e
				} else {
					a, _ := info["Architecture"].(string)
					switch a {
					case "aarch64", "arm64":
						arch = "arm64"
					case "x86_64", "amd64":
					default:
						err = errors.New("部署机器架构暂不支持：" + a)
					}
				}
				script, _ := buildScript(c, t.Config, arch)
				if err == nil {
					var container string
					container, err = m.engine.create(ctx, t.BuildImage, []string{"sh", "-c", script}, nil, false)
					if err == nil {
						_ = m.mutate(id, func(t *deploymentTask) { t.BuildContainer = container; t.Stage = "安装依赖、测试与构建" })
						err = m.engine.put(ctx, container, filepath.Join(m.sourceDir(src.ID), c.Directory))
						if err == nil {
							err = m.stageTool(ctx, c, container, id, t.Config)
						}
						if err == nil {
							f, e := os.OpenFile(filepath.Join(m.logRoot, id+".log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
							if e != nil {
								err = e
							} else {
								err = m.engine.run(ctx, container, f)
								_ = f.Close()
							}
						}
						if err == nil {
							err = m.exportBuild(ctx, container, filepath.Join(workspace, "app"))
						}
						if cleanupErr := m.removeTaskContainer(id, container); cleanupErr != nil {
							err = errors.Join(err, cleanupErr)
						}
					}
				}
			}
		}
		if err != nil {
			m.fail(id, err, ctx.Err() == context.Canceled)
			return
		}
		if err = os.WriteFile(filepath.Join(workspace, ".ready"), []byte("ready"), 0600); err != nil {
			m.fail(id, err, false)
			return
		}
	}
	_ = m.mutate(id, func(t *deploymentTask) {
		if t.TestResult == "pending" {
			t.TestResult = "passed"
		}
	})
	_, pattern := buildScript(c, t.Config, "amd64")
	app := filepath.Join(workspace, "app")
	artifacts, err := findDeploymentArtifacts(app, pattern, t.Config.Target, c)
	if err != nil {
		m.fail(id, err, false)
		return
	}
	if len(artifacts) != 1 {
		_ = m.mutate(id, func(t *deploymentTask) {
			t.State = "awaiting-config"
			t.Stage = "请选择唯一部署产物"
			t.Artifacts = artifacts
		})
		return
	}
	suggestion, err := suggestArtifactCommand(app, artifacts[0], c, t.Config)
	if err != nil {
		m.fail(id, err, false)
		return
	}
	if t.Config.Target == "service" && (t.Config.Command == "" || (c.Kind == KindJava && c.SuggestedCommand == "" && t.Config.Artifact == "")) {
		_ = m.mutate(id, func(t *deploymentTask) {
			t.State = "awaiting-config"
			t.Stage = "确认产物与启动命令"
			t.Artifacts = artifacts
			t.SuggestedCommand = suggestion
		})
		return
	}
	if err = m.engine.pull(ctx, t.RuntimeImage); err != nil {
		m.fail(id, err, ctx.Err() == context.Canceled)
		return
	}
	if err = m.engine.pull(ctx, WEBSITE_HTML_IMAGE); err != nil {
		m.fail(id, err, ctx.Err() == context.Canceled)
		return
	}
	err = m.publish(ctx, id, app, artifacts[0], c)
	if err != nil {
		m.fail(id, err, ctx.Err() == context.Canceled)
		return
	}
	_ = m.mutate(id, func(t *deploymentTask) { t.State = "succeeded"; t.Stage = "部署成功，端口已就绪" })
	m.log(id, "部署成功")
}
func (m *deploymentManager) exportBuild(ctx context.Context, container, dest string) error {
	// 在隔离容器内把依赖链接展开为普通文件；宿主解包仍拒绝所有链接与特殊文件。
	tmp, err := os.MkdirTemp(m.sourceRoot, "export-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)
	if err = m.engine.export(ctx, container, "/app/.elysian-export", tmp); err != nil {
		return err
	}
	f, err := os.Open(filepath.Join(tmp, "app.tar"))
	if err != nil {
		return err
	}
	defer f.Close()
	if err = os.MkdirAll(dest, 0755); err != nil {
		return err
	}
	b := extractBudget{limits: m.engine.limits}
	return extractTar(ctx, tar.NewReader(f), dest, &b, "")
}
func (m *deploymentManager) fail(id string, err error, cancelled bool) {
	state := "failed"
	if cancelled {
		state = "cancelled"
	}
	_ = m.mutate(id, func(t *deploymentTask) {
		t.State = state
		if unsettledDeployment(*t) {
			t.State = "unknown"
		}
		t.Error = err.Error()
		t.Stage = "部署停止"
		if t.TestResult == "pending" {
			t.TestResult = "failed"
		}
	})
	m.log(id, "任务停止："+err.Error())
}
func findDeploymentArtifacts(root, pattern, target string, c projectCandidate) ([]string, error) {
	if pattern == "" {
		if target == "static" {
			pattern = "*"
		} else {
			pattern = "."
		}
	}
	if _, err := archivePath(root, pattern); err != nil {
		return nil, err
	}
	matches, err := filepath.Glob(filepath.Join(root, pattern))
	if err != nil {
		return nil, errors.New("产物路径模式无效")
	}
	out := []string{}
	for _, p := range matches {
		info, e := os.Stat(p)
		if e != nil {
			continue
		}
		rel, _ := filepath.Rel(root, p)
		if target == "static" {
			if !info.IsDir() || !exists(filepath.Join(p, "index.html")) {
				continue
			}
		}
		if strings.HasSuffix(p, "-sources.jar") || strings.HasSuffix(p, "-javadoc.jar") || strings.HasSuffix(p, ".original") {
			continue
		}
		out = append(out, filepath.ToSlash(rel))
	}
	if len(out) == 0 && target == "static" {
		for _, dir := range []string{"dist", "build", "out", "."} {
			if exists(filepath.Join(root, dir, "index.html")) {
				out = append(out, dir)
			}
		}
	}
	return out, nil
}
func suggestArtifactCommand(root, artifact string, c projectCandidate, cfg buildConfig) (string, error) {
	if cfg.Target == "static" {
		return "", nil
	}
	if c.Kind != KindJava {
		return c.SuggestedCommand, nil
	}
	path := filepath.Join(root, artifact)
	if strings.HasSuffix(artifact, ".jar") {
		if required := jarRequiredVersion(path); required > versionMajor(cfg.RuntimeVersion) {
			return "", errors.New("构建产物的 Java 字节码版本高于所选 JRE，请调整运行版本后重新部署")
		}
		main, err := jarMainClass(path)
		if err != nil {
			return "", errors.New("JAR 产物损坏")
		}
		if main != "" {
			if hasDirectory(filepath.Join(filepath.Dir(path), "dependencies")) || hasDirectory(filepath.Join(root, "lib")) {
				return "java -cp '/app/app.jar:/app/lib/*' " + main, nil
			}
			return "java -jar /app/app.jar", nil
		}
		entry := cfg.Entry
		if entry == "" && len(c.Entries) == 1 {
			entry = c.Entries[0]
		}
		if entry == "" {
			return "", nil
		}
		return "java -cp '/app/app.jar:/app/lib/*' " + entry, nil
	}
	bins, _ := filepath.Glob(filepath.Join(path, "bin", "*"))
	if len(bins) == 1 {
		return "/app/bin/" + filepath.Base(bins[0]), nil
	}
	return "", nil
}
