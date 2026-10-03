package websites

import (
	"context"
	"encoding/json"
	"errors"

	"io"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"elysian/server/internal/paths"
	"elysian/server/internal/seam"
	"elysian/server/internal/shared"
)

type deploymentManager struct {
	mu                        sync.Mutex
	service                   *websiteService
	engine                    deploymentEngine
	root, sourceRoot, logRoot string
	sources                   map[string]*sourceRecord
	tasks                     map[string]*deploymentTask
	cancel                    map[string]context.CancelFunc
	workers                   chan struct{}
}

func newDeploymentManager(s *websiteService, e deploymentEngine, root, sourceRoot, logRoot string) *deploymentManager {
	m := &deploymentManager{service: s, engine: e, root: root, sourceRoot: sourceRoot, logRoot: logRoot, sources: map[string]*sourceRecord{}, tasks: map[string]*deploymentTask{}, cancel: map[string]context.CancelFunc{}, workers: make(chan struct{}, e.limits.Concurrency)}
	for _, dir := range []string{root, sourceRoot, logRoot} {
		_ = os.MkdirAll(dir, 0700)
	}
	ownerPath := filepath.Join(root, "owner-id")
	m.engine.owner = strings.TrimSpace(smallText(ownerPath))
	if !safeDeploymentID(m.engine.owner) {
		m.engine.owner = newDeploymentID()
		_ = os.WriteFile(ownerPath, []byte(m.engine.owner), 0600)
	}
	if e.transport != nil {
		m.cleanupContainers()
	}
	files, _ := filepath.Glob(filepath.Join(sourceRoot, "*", "source.json"))
	for _, f := range files {
		var src sourceRecord
		if json.Unmarshal([]byte(smallText(f)), &src) == nil && safeDeploymentID(src.ID) {
			if src.State == "preparing" {
				if src.FetchContainer != "" {
					e.remove(src.FetchContainer)
					src.FetchContainer = ""
				}
				src.State = "interrupted"
				src.Error = "面板重启中断了来源准备，请重新提交"
				_ = writeDeploymentJSON(f, &src)
			}
			m.sources[src.ID] = &src
		}
	}
	files, _ = filepath.Glob(filepath.Join(root, "*.json"))
	for _, f := range files {
		var t deploymentTask
		if json.Unmarshal([]byte(smallText(f)), &t) == nil && safeDeploymentID(t.ID) {
			if activeDeployment(t.State) {
				t.State = "interrupted"
				t.Stage = "面板重启中断"
				t.Error = "任务因面板重启中断，未自动重新发布"
				if t.Pending != nil {
					ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
					if err := m.restoreInterrupted(ctx, &t); err != nil {
						t.Error += "；恢复失败，需要处理：" + err.Error()
					}
					cancel()
				}
				if t.BuildContainer != "" {
					e.remove(t.BuildContainer)
					t.BuildContainer = ""
				}
				_ = writeDeploymentJSON(f, &t)
			}
			if t.State == "interrupted" {
				_ = os.RemoveAll(filepath.Join(sourceRoot, t.ID+"-output"))
			}
			m.tasks[t.ID] = &t
		}
	}
	m.cleanup()
	go func() {
		for range time.NewTicker(time.Hour).C {
			m.cleanup()
		}
	}()
	return m
}
func productionDeploymentManager(s *websiteService, engine deploymentEngine) *deploymentManager {
	limits := defaultDeploymentLimits()
	read := func(key string, current int64) int64 {
		n, e := strconv.ParseInt(os.Getenv(key), 10, 64)
		if e == nil && n > 0 {
			return n
		}
		return current
	}
	limits.ArchiveBytes = read("ELYSIAN_DEPLOY_ARCHIVE_BYTES", limits.ArchiveBytes)
	limits.ExpandedBytes = read("ELYSIAN_DEPLOY_EXPANDED_BYTES", limits.ExpandedBytes)
	limits.Entries = int(read("ELYSIAN_DEPLOY_ENTRIES", int64(limits.Entries)))
	limits.CPUs = read("ELYSIAN_DEPLOY_CPUS", limits.CPUs)
	limits.Memory = read("ELYSIAN_DEPLOY_MEMORY_BYTES", limits.Memory)
	limits.Timeout = time.Duration(read("ELYSIAN_DEPLOY_TIMEOUT_SECONDS", int64(limits.Timeout/time.Second))) * time.Second
	limits.Concurrency = int(read("ELYSIAN_DEPLOY_CONCURRENCY", 1))
	engine.limits = limits
	return newDeploymentManager(s, engine, filepath.Join(paths.StateDir, "website-deployments"), filepath.Join(paths.TmpDir, "website-sources"), filepath.Join(paths.LogsDir, "website-deployments"))
}
func safeDeploymentID(id string) bool { return regexpDeploymentID.MatchString(id) }
func writeDeploymentJSON(path string, v any) error {
	b, e := json.Marshal(v)
	if e != nil {
		return e
	}
	f, e := os.CreateTemp(filepath.Dir(path), ".write-*")
	if e != nil {
		return e
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if e = f.Chmod(0600); e == nil {
		_, e = f.Write(b)
	}
	if e == nil {
		e = f.Sync()
	}
	ce := f.Close()
	if e != nil {
		return e
	}
	if ce != nil {
		return ce
	}
	return os.Rename(tmp, path)
}
func (m *deploymentManager) sourceDir(id string) string {
	return filepath.Join(m.sourceRoot, id, "content")
}
func (m *deploymentManager) saveSource(s *sourceRecord) error {
	return writeDeploymentJSON(filepath.Join(m.sourceRoot, s.ID, "source.json"), s)
}
func (m *deploymentManager) cleanup() {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now()
	for id, s := range m.sources {
		expiry, _ := time.Parse(time.RFC3339, s.ExpiresAt)
		used := false
		for _, t := range m.tasks {
			if t.SourceID == id && t.State == "awaiting-config" && expiry.Before(now) {
				t.State = "failed"
				t.Stage = "来源保留期已到期"
				t.Error = "临时来源保留 24 小时，请重新上传或拉取"
				_ = writeDeploymentJSON(filepath.Join(m.root, t.ID+".json"), t)
				_ = os.RemoveAll(filepath.Join(m.sourceRoot, t.ID+"-output"))
			}
			if t.SourceID == id && activeDeployment(t.State) {
				used = true
			}
		}
		if !used && expiry.Before(now) {
			delete(m.sources, id)
			_ = os.RemoveAll(filepath.Join(m.sourceRoot, id))
		}
	}
	for id, t := range m.tasks {
		created, _ := time.Parse(time.RFC3339, t.CreatedAt)
		if !activeDeployment(t.State) && t.State != "awaiting-config" && created.Add(30*24*time.Hour).Before(now) {
			delete(m.tasks, id)
			_ = os.Remove(filepath.Join(m.root, id+".json"))
			_ = os.Remove(filepath.Join(m.logRoot, id+".log"))
		}
	}
}
func (m *deploymentManager) newSource(kind, mode, name string) (*sourceRecord, error) {
	if mode != "source" && mode != "artifact" {
		return nil, shared.InvalidRequest("请选择源码或已构建产物")
	}
	now := time.Now()
	s := &sourceRecord{ID: newDeploymentID(), Type: kind, Mode: mode, State: "preparing", Name: name, CreatedAt: now.UTC().Format(time.RFC3339), ExpiresAt: now.Add(24 * time.Hour).UTC().Format(time.RFC3339)}
	if err := os.MkdirAll(m.sourceDir(s.ID), 0700); err != nil {
		return nil, err
	}
	m.mu.Lock()
	m.sources[s.ID] = s
	err := m.saveSource(s)
	m.mu.Unlock()
	return s, err
}
func (m *deploymentManager) archive(ctx context.Context, name, mode string, r io.Reader) (sourceRecord, error) {
	s, err := m.newSource("archive", mode, filepath.Base(name))
	if err != nil {
		return sourceRecord{}, err
	}
	f, err := os.CreateTemp(filepath.Join(m.sourceRoot, s.ID), "upload-*")
	if err != nil {
		return sourceRecord{}, err
	}
	filename := f.Name()
	defer os.Remove(filename)
	n, err := io.Copy(f, io.LimitReader(contextReader{ctx, r}, m.engine.limits.ArchiveBytes+1))
	ce := f.Close()
	if err == nil {
		err = ce
	}
	if err == nil && n > m.engine.limits.ArchiveBytes {
		err = &shared.InvalidRequestError{Status: 413, Message: "压缩包超过上传上限"}
	}
	if err == nil {
		err = extractArchive(ctx, filename, m.sourceDir(s.ID), m.engine.limits)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if err != nil {
		s.State = "failed"
		s.Error = "上传或解压失败：" + err.Error()
		_ = os.RemoveAll(m.sourceDir(s.ID))
		_ = m.saveSource(s)
		var limit *shared.InvalidRequestError
		if errors.As(err, &limit) {
			return *s, limit
		}
		return *s, shared.InvalidRequest(err.Error())
	}
	report, err := analyzeSource(m.sourceDir(s.ID), mode)
	if err != nil {
		s.State = "failed"
		s.Error = err.Error()
	} else {
		s.Report = &report
		s.State = "ready"
	}
	if e := m.saveSource(s); err == nil {
		err = e
	}
	return *s, err
}
func validateGitURL(raw, ref, token string) error {
	u, e := url.Parse(raw)
	if e != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return shared.InvalidRequest("Git 仅支持不含凭据的 HTTPS 地址")
	}
	if len(raw) > 2048 || len(ref) > 256 || strings.HasPrefix(ref, "-") || strings.ContainsAny(ref, "\x00\n\r") || len(token) > 8192 || strings.ContainsAny(token, "\x00\n\r") {
		return shared.InvalidRequest("Git 地址、引用或令牌无效")
	}
	return nil
}
func (m *deploymentManager) git(raw, ref, token, mode string) (sourceRecord, error) {
	if err := validateGitURL(raw, ref, token); err != nil {
		return sourceRecord{}, err
	}
	s, err := m.newSource("git", mode, strings.TrimSuffix(filepath.Base(raw), ".git"))
	if err != nil {
		return sourceRecord{}, err
	}
	m.mu.Lock()
	s.GitURL = raw
	s.Ref = ref
	ctx, cancel := context.WithTimeout(context.Background(), m.engine.limits.Timeout)
	m.cancel[s.ID] = cancel
	err = m.saveSource(s)
	copy := *s
	m.mu.Unlock()
	if err != nil {
		cancel()
		return copy, err
	}
	go m.prepareGit(ctx, s.ID, raw, ref, token)
	return copy, nil
}
func (m *deploymentManager) prepareGit(ctx context.Context, id, raw, ref, token string) {
	// 令牌只传入 tmpfs；不放在 argv、环境、持久日志或登记。Git 工作区不携带 .git。
	var err error
	var container string
	var commit string
	report, err := m.service.RuntimeCatalog(ctx)
	image := ""
	if err == nil && len(report.Catalog.Go) > 0 {
		image = report.Catalog.Go[0].Image
	}
	if image == "" && err == nil {
		err = errors.New("没有可用的官方 Git 获取环境（Go 构建镜像）")
	}
	if err == nil {
		err = m.engine.pull(ctx, image)
	}
	if err == nil {
		container, err = m.engine.create(ctx, image, []string{"sh", "-c", "sleep " + strconv.FormatInt(int64(m.engine.limits.Timeout/time.Second)+60, 10)}, []string{"GIT_TERMINAL_PROMPT=0", "GIT_CONFIG_NOSYSTEM=1", "GIT_ASKPASS=sh /run/credentials/askpass"}, true)
	}
	defer m.engine.remove(container)
	if container != "" {
		m.mu.Lock()
		if s := m.sources[id]; s != nil {
			s.FetchContainer = container
			s.FetchImage = image
			err = m.saveSource(s)
		}
		m.mu.Unlock()
	}
	if err == nil {
		_, err = m.engine.json(ctx, "POST", "/containers/"+container+"/start", nil)
	}
	if err == nil {
		err = m.engine.secret(ctx, container, token)
	}
	if ref == "" {
		ref = "HEAD"
	}
	script := "set -eu; git -c core.hooksPath=/dev/null init /app; cd /app; git remote add origin " + shellQuote(raw) + "; git -c core.hooksPath=/dev/null fetch --no-tags --depth=1 origin " + shellQuote(ref) + "; git -c core.hooksPath=/dev/null checkout --detach FETCH_HEAD; git rev-parse HEAD > .elysian-commit; rm -rf .git"
	if err == nil {
		err = m.engine.exec(ctx, container, []string{"sh", "-c", script}, io.Discard)
	}
	if err == nil {
		err = m.engine.export(ctx, container, "/app", m.sourceDir(id))
	}
	if err == nil {
		commit = strings.TrimSpace(smallText(filepath.Join(m.sourceDir(id), ".elysian-commit")))
		_ = os.Remove(filepath.Join(m.sourceDir(id), ".elysian-commit"))
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if c := m.cancel[id]; c != nil {
		c()
		delete(m.cancel, id)
	}
	s := m.sources[id]
	if s != nil {
		s.FetchContainer = ""
	}
	if s == nil {
		return
	}
	if err != nil {
		s.State = "failed"
		s.Error = "Git 获取失败，请检查 HTTPS 地址、引用、认证与网络"
		_ = os.RemoveAll(m.sourceDir(id))
	} else {
		r, e := analyzeSource(m.sourceDir(id), s.Mode)
		if e != nil {
			s.State = "failed"
			s.Error = e.Error()
		} else {
			s.State = "ready"
			s.Commit = commit
			s.Report = &r
		}
	}
	_ = m.saveSource(s)
}
func (m *deploymentManager) getSource(id string) (sourceRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s := m.sources[id]
	if s == nil {
		return sourceRecord{}, &shared.InvalidRequestError{Status: 404, Message: "来源不存在或已过期"}
	}
	b, _ := json.Marshal(s)
	var copy sourceRecord
	_ = json.Unmarshal(b, &copy)
	copy.FetchContainer = ""
	return copy, nil
}
func (m *deploymentManager) mutate(id string, fn func(*deploymentTask)) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	t := m.tasks[id]
	if t == nil {
		return errors.New("部署任务不存在")
	}
	b, _ := json.Marshal(t)
	var updated deploymentTask
	_ = json.Unmarshal(b, &updated)
	fn(&updated)
	updated.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	if err := writeDeploymentJSON(filepath.Join(m.root, id+".json"), &updated); err != nil {
		return err
	}
	m.tasks[id] = &updated
	return nil
}
func (m *deploymentManager) getTask(id string) (deploymentTask, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	t := m.tasks[id]
	if t == nil {
		return deploymentTask{}, &shared.InvalidRequestError{Status: 404, Message: "部署任务不存在"}
	}
	b, _ := json.Marshal(t)
	var copy deploymentTask
	_ = json.Unmarshal(b, &copy)
	return copy, nil
}
func (m *deploymentManager) log(id, text string) {
	f, e := os.OpenFile(filepath.Join(m.logRoot, id+".log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if e == nil {
		_, _ = io.WriteString(f, text+"\n")
		_ = f.Close()
	}
}

// 仅清理本安装标识的一次性容器，覆盖创建容器后尚未落任务检查点的重启窗口。
func (m *deploymentManager) cleanupContainers() {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	filters, _ := json.Marshal(map[string][]string{"label": {"elysian.website.deployment-owner=" + m.engine.owner}})
	response, err := m.engine.transport.Request(ctx, seam.EngineRequest{Method: "GET", Path: "/containers/json", Query: url.Values{"all": {"true"}, "filters": {string(filters)}}})
	if err != nil || response.Status != 200 {
		return
	}
	var containers []struct {
		ID     string            `json:"Id"`
		Labels map[string]string `json:"Labels"`
	}
	if json.Unmarshal(response.Body, &containers) != nil {
		return
	}
	for _, container := range containers {
		if containerIDPattern.MatchString(container.ID) && container.Labels["elysian.website.deployment-owner"] == m.engine.owner && (container.Labels["elysian.website.build"] == "true" || container.Labels["elysian.website.probe"] == "true") {
			m.engine.remove(container.ID)
		}
	}
}
