package panel

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"elysian/server/internal/config"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type fakeHost struct {
	rules       []string
	dispatched  int
	starts      int
	stops       int
	healthCalls int
	failHealth  bool
	failBuild   bool
	failStart   bool
	candidate   string
}

func (h *fakeHost) Available() bool { return true }
func (h *fakeHost) Preflight(_ context.Context, old, next config.PanelNetwork) error {
	return validateRules(h.rules, old, next)
}
func (h *fakeHost) Dispatch(context.Context, string, string) error { h.dispatched++; return nil }
func (h *fakeHost) WorkerActive(context.Context, string) bool      { return false }
func (h *fakeHost) Build(context.Context, string, string, string) (string, error) {
	if h.failBuild {
		return "", fmt.Errorf("构建失败")
	}
	return h.candidate, nil
}
func (h *fakeHost) Stop(context.Context) error { h.stops++; return nil }
func (h *fakeHost) Start(context.Context) error {
	h.starts++
	if h.failStart && h.starts == 1 {
		return fmt.Errorf("启动失败")
	}
	return nil
}
func (h *fakeHost) Healthy(context.Context, config.PanelNetwork, string) error {
	h.healthCalls++
	if h.failHealth && h.healthCalls == 1 {
		return fmt.Errorf("健康检查失败")
	}
	return nil
}
func (h *fakeHost) Rules(context.Context) ([]string, error) {
	return append([]string{}, h.rules...), nil
}
func (h *fakeHost) AddRule(_ context.Context, rule string) error {
	for _, r := range h.rules {
		if r == rule {
			return nil
		}
	}
	h.rules = append(h.rules, rule)
	return nil
}
func (h *fakeHost) DeleteRule(_ context.Context, rule string) error {
	rows := []string{}
	for _, r := range h.rules {
		if r != rule {
			rows = append(rows, r)
		}
	}
	h.rules = rows
	return nil
}
func (h *fakeHost) VerifyRules(_ context.Context, p config.PanelNetwork) error {
	found := false
	for _, r := range h.rules {
		if ruleCovers(r, p.BackendPort) {
			return fmt.Errorf("后端规则残留")
		}
		if ruleCovers(r, p.FrontendPort) {
			found = true
		}
	}
	if !found {
		return fmt.Errorf("前端未放行")
	}
	return nil
}

type fakeSource struct{ fail bool }

func (s fakeSource) Check(context.Context) (Update, error) { return Update{}, nil }
func (s fakeSource) History(context.Context, int) ([]CommitLog, error) {
	return nil, nil
}
func (s fakeSource) Download(_ context.Context, _, dir string) error {
	if s.fail {
		return fmt.Errorf("下载失败")
	}
	return os.MkdirAll(dir, 0700)
}

func setupWorker(t *testing.T, kind string) (Worker, taskRecord, *fakeHost) {
	t.Helper()
	root := t.TempDir()
	install := filepath.Join(root, "install")
	old := filepath.Join(install, "releases", "old", "elysian")
	if err := os.MkdirAll(filepath.Dir(old), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(old, []byte("old"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Dir(old), filepath.Join(install, "current")); err != nil {
		t.Fatal(err)
	}
	s := Store{Root: filepath.Join(root, "data-home")}
	p := config.DefaultPanelNetwork()
	if err := config.AtomicJSON(s.networkPath(), p); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(s.Root, "config", "credentials"), []byte("keep-password"), 0600); err != nil {
		t.Fatal(err)
	}
	h := &fakeHost{rules: []string{frontendRule(p.FrontendPort), frontendRule(p.BackendPort)}}
	r := taskRecord{Task: Task{ID: strings.Repeat("a", 32), Kind: kind, State: "queued", OldPorts: p, NewPorts: config.PanelNetwork{FrontendPort: 49000, BackendPort: 49001}, CreatedAt: time.Now().UTC()}, RequestID: "request-one"}
	if kind != "ports" {
		r.NewPorts = p
	}
	if err := s.lock(func() error { return s.save(r) }); err != nil {
		t.Fatal(err)
	}
	return Worker{Store: s, Host: h, Source: fakeSource{}, Install: install}, r, h
}

func TestPortMigrationRemovesOldAndBackendRules(t *testing.T) {
	w, r, h := setupWorker(t, "ports")
	if err := w.Run(context.Background(), r.ID); err != nil {
		t.Fatal(err)
	}
	got, err := w.Store.read(r.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.State != "succeeded" || !got.Committed || len(h.rules) != 1 || h.rules[0] != frontendRule(49000) {
		t.Fatalf("错误的最终状态：%+v %v", got, h.rules)
	}
	p, err := config.ReadPanelNetwork(w.Store.networkPath())
	if err != nil || p != r.NewPorts {
		t.Fatalf("配置没有提交：%v %v", p, err)
	}
	if b, _ := os.ReadFile(filepath.Join(w.Store.Root, "config", "credentials")); string(b) != "keep-password" {
		t.Fatal("凭据发生变化")
	}
}
func TestPortSwapNeverLeavesBackendAllowed(t *testing.T) {
	w, r, h := setupWorker(t, "ports")
	r.NewPorts = config.PanelNetwork{FrontendPort: r.OldPorts.BackendPort, BackendPort: r.OldPorts.FrontendPort}
	if err := w.Store.save(r); err != nil {
		t.Fatal(err)
	}
	if err := w.Run(context.Background(), r.ID); err != nil {
		t.Fatal(err)
	}
	if err := h.VerifyRules(context.Background(), r.NewPorts); err != nil {
		t.Fatal(err)
	}
}
func TestFailedActivationRollsBackPortsRulesAndData(t *testing.T) {
	w, r, h := setupWorker(t, "ports")
	h.failHealth = true
	if err := w.Run(context.Background(), r.ID); err == nil {
		t.Fatal("预期健康检查失败")
	}
	got, _ := w.Store.read(r.ID)
	p, _ := config.ReadPanelNetwork(w.Store.networkPath())
	if got.State != "rolled-back" || p != r.OldPorts || len(h.rules) != 2 || h.healthCalls != 2 {
		t.Fatalf("未恢复原状态：%+v %v %v", got, p, h.rules)
	}
}
func TestDownloadAndBuildFailureLeaveRunningVersion(t *testing.T) {
	for _, stage := range []string{"download", "build"} {
		t.Run(stage, func(t *testing.T) {
			w, r, h := setupWorker(t, "update")
			r.TargetCommit = strings.Repeat("b", 40)
			_ = w.Store.save(r)
			w.Source = fakeSource{fail: stage == "download"}
			h.failBuild = stage == "build"
			if err := w.Run(context.Background(), r.ID); err == nil {
				t.Fatal("预期失败")
			}
			got, _ := w.Store.read(r.ID)
			if got.State != "failed" || h.stops != 0 {
				t.Fatalf("构建失败停掉了原服务：%+v %d", got, h.stops)
			}
		})
	}
}
func TestInterruptedActivationRestoresBeforeStart(t *testing.T) {
	w, r, h := setupWorker(t, "ports")
	r.PreviousBinary = filepath.Join(w.install(), "releases", "old", "elysian")
	r.Snapshot = filepath.Join(w.Store.Root, "backups", "test")
	if err := copyPanelData(w.Store.Root, r.Snapshot); err != nil {
		t.Fatal(err)
	}
	r.SnapshotReady = true
	r.Activated = true
	r.State = "running"
	r.FirewallBefore = append([]string{}, h.rules...)
	r.FirewallCaptured = true
	_ = config.AtomicJSON(w.Store.networkPath(), r.NewPorts)
	h.rules = []string{frontendRule(r.NewPorts.FrontendPort)}
	_ = w.Store.save(r)
	if err := w.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	p, _ := config.ReadPanelNetwork(w.Store.networkPath())
	got, _ := w.Store.read(r.ID)
	if p != r.OldPorts || got.State != "rolled-back" || h.stops != 0 || h.starts != 0 {
		t.Fatalf("启动前恢复不应递归控制自身服务：%v %+v", p, got)
	}
}
func TestSubmitIdempotencyAndConflict(t *testing.T) {
	w, _, h := setupWorker(t, "ports")
	_ = os.Remove(w.Store.taskPath(strings.Repeat("a", 32)))
	m := Manager{Store: w.Store, Host: h, Source: fakeSource{}, Ports: config.DefaultPanelNetwork(), Enabled: true, Executable: filepath.Join(w.install(), "releases", "old", "elysian")}
	input := submitInput{RequestID: "request-one", FrontendPort: 49000, BackendPort: 49001}
	one, err := m.Submit(context.Background(), "ports", input, "http://127.0.0.1:48100")
	if err != nil {
		t.Fatal(err)
	}
	two, err := m.Submit(context.Background(), "ports", input, "http://127.0.0.1:48100")
	if err != nil || one.ID != two.ID || h.dispatched != 1 {
		t.Fatalf("重复执行：%v %v", two, err)
	}
	input.RequestID = "request-two"
	if _, err = m.Submit(context.Background(), "ports", input, "http://127.0.0.1:48100"); err == nil {
		t.Fatal("并发维护应拒绝")
	}
}
func TestRuleConflictsAreNeverDeleted(t *testing.T) {
	p := config.DefaultPanelNetwork()
	for _, rule := range []string{"allow 48100/tcp comment '其他服务'", "allow 48000:49000/tcp", "allow from 10.0.0.0/8 to any port 48101 proto tcp"} {
		if err := validateRules([]string{rule}, p, p); err == nil {
			t.Fatalf("共享规则没有被拦截：%s", rule)
		}
	}
}
func archive(t *testing.T, name string, kind byte) []byte {
	t.Helper()
	var b bytes.Buffer
	z := gzip.NewWriter(&b)
	w := tar.NewWriter(z)
	h := &tar.Header{Name: name, Mode: 0600, Typeflag: kind}
	if kind == tar.TypeReg {
		h.Size = 1
	}
	if err := w.WriteHeader(h); err != nil {
		t.Fatal(err)
	}
	if kind == tar.TypeReg {
		_, _ = w.Write([]byte("x"))
	}
	_ = w.Close()
	_ = z.Close()
	return b.Bytes()
}
func TestSourceRejectsTraversalAndLinks(t *testing.T) {
	for _, name := range []string{"/escape", "repo/../../escape", "repo\\escape"} {
		if err := extractSource(bytes.NewReader(archive(t, name, tar.TypeReg)), t.TempDir()); err == nil {
			t.Fatalf("接受越界路径：%s", name)
		}
	}
	if err := extractSource(bytes.NewReader(archive(t, "repo/link", tar.TypeSymlink)), t.TempDir()); err == nil {
		t.Fatal("接受符号链接")
	}
	root := t.TempDir()
	if err := extractSource(bytes.NewReader(archive(t, "repo/package.json", tar.TypeReg)), root); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(root, "package.json")); string(b) != "x" {
		t.Fatal("未解包源码")
	}
}
func TestGitHubUsesRepositoryDefaultBranchAndPinnedSHA(t *testing.T) {
	sha := strings.Repeat("b", 40)
	archivePath := ""
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/repos/" + Repository:
			_, _ = w.Write([]byte(`{"default_branch":"release-track"}`))
		case "/repos/" + Repository + "/commits/release-track":
			_, _ = w.Write([]byte(`{"sha":"` + sha + `","commit":{"message":"更新说明"}}`))
		default:
			archivePath = r.URL.Path
			_, _ = w.Write(archive(t, "repo/package.json", tar.TypeReg))
		}
	}))
	defer srv.Close()
	s := GitHubSource{Client: srv.Client(), API: srv.URL}
	u, err := s.Check(context.Background())
	if err != nil || u.Branch != "release-track" || u.TargetCommit != sha {
		t.Fatalf("默认分支解析失败：%+v %v", u, err)
	}
	if err := s.Download(context.Background(), u.TargetCommit, t.TempDir()); err != nil {
		t.Fatal(err)
	}
	if archivePath != "/repos/"+Repository+"/tarball/"+sha {
		t.Fatal("下载未锁定提交")
	}
}
func TestGitHubHistoryListsDefaultBranchCommits(t *testing.T) {
	sha := strings.Repeat("c", 40)
	var gotSha, gotLimit string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/repos/" + Repository:
			_, _ = w.Write([]byte(`{"default_branch":"release-track"}`))
		case "/repos/" + Repository + "/commits":
			gotSha, gotLimit = r.URL.Query().Get("sha"), r.URL.Query().Get("per_page")
			_, _ = w.Write([]byte(`[{"sha":"` + sha + `","commit":{"message":"标题\n正文不展示","author":{"date":"2026-10-04T08:00:00Z"}}}]`))
		default:
			t.Errorf("更新了预期之外的路径 %s", r.URL.Path)
		}
	}))
	defer srv.Close()
	s := GitHubSource{Client: srv.Client(), API: srv.URL}
	commits, err := s.History(context.Background(), 50)
	if err != nil {
		t.Fatal(err)
	}
	if gotSha != "release-track" || gotLimit != "50" {
		t.Fatalf("提交列表未按默认分支与上限拉取：sha=%q per_page=%q", gotSha, gotLimit)
	}
	if len(commits) != 1 || commits[0].SHA != sha || commits[0].Message != "标题" {
		t.Fatalf("提交列表解析失败：%+v", commits)
	}
	if commits[0].Time.Year() != 2026 {
		t.Fatalf("提交时间未解析：%+v", commits[0])
	}
}
func TestHealthCorsIsLimitedToOldOriginAndTask(t *testing.T) {
	w, r, h := setupWorker(t, "ports")
	r.Origin = "http://127.0.0.1:48100"
	r.UpdatedAt = time.Now()
	r.State = "succeeded"
	r.Committed = true
	_ = w.Store.save(r)
	m := Manager{Store: w.Store, Host: h, Ports: r.NewPorts}
	for _, origin := range []string{r.Origin, "http://evil.example"} {
		req := httptest.NewRequest("GET", "/api/health?maintenanceTask="+r.ID, nil)
		req.Header.Set("Origin", origin)
		response := httptest.NewRecorder()
		m.Health(response, req)
		if (response.Header().Get("Access-Control-Allow-Origin") != "") != (origin == r.Origin) {
			t.Fatal("健康探测跨源范围错误")
		}
	}
}

func TestUpdateCommitsCandidateOrRestoresOldBinary(t *testing.T) {
	for _, fail := range []bool{false, true} {
		t.Run(fmt.Sprint(fail), func(t *testing.T) {
			w, r, h := setupWorker(t, "update")
			r.TargetCommit = strings.Repeat("c", 40)
			h.candidate = filepath.Join(w.install(), "releases", "new", "elysian")
			if err := os.MkdirAll(filepath.Dir(h.candidate), 0755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(h.candidate, []byte("new"), 0755); err != nil {
				t.Fatal(err)
			}
			h.failHealth = fail
			if err := w.Store.save(r); err != nil {
				t.Fatal(err)
			}
			err := w.Run(context.Background(), r.ID)
			row, _ := w.Store.read(r.ID)
			binary, _ := filepath.EvalSymlinks(filepath.Join(w.install(), "current", "elysian"))
			if fail {
				if err == nil || row.State != "rolled-back" || filepath.Base(filepath.Dir(binary)) != "old" {
					t.Fatalf("更新失败未恢复程序：%v %+v %s", err, row, binary)
				}
			} else {
				if err != nil || row.State != "succeeded" || binary != h.candidate {
					t.Fatalf("更新未提交：%v %+v %s", err, row, binary)
				}
				if _, err := os.Stat(filepath.Join(w.install(), "releases", "old", "elysian")); err != nil {
					t.Fatal("上一成功版本未保留")
				}
			}
		})
	}
}
func TestCommittedJournalIsRetainedOnRecovery(t *testing.T) {
	w, r, h := setupWorker(t, "ports")
	r.State = "running"
	r.Committed = true
	if err := w.Store.save(r); err != nil {
		t.Fatal(err)
	}
	if err := w.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	row, _ := w.Store.read(r.ID)
	if row.State != "succeeded" || h.stops != 0 || h.starts != 0 {
		t.Fatalf("已提交事务不应回滚：%+v", row)
	}
}
func TestSharedPortListAndAllPortsCannotBeMigrated(t *testing.T) {
	p := config.DefaultPanelNetwork()
	for _, rule := range []string{"allow 80,48101/tcp comment '共享'", "allow from 10.0.0.0/8", "allow 48100:48110/tcp comment 'Elysian 面板'"} {
		if validateRules([]string{rule}, p, p) == nil {
			t.Errorf("共享规则未被拒绝：%s", rule)
		}
	}
	if validateRules([]string{"allow 22/tcp", "allow 80,443/tcp"}, p, p) != nil {
		t.Fatal("不应阻止无关规则")
	}
}
func TestWebsiteReservationsAndActiveJobsBlockMaintenance(t *testing.T) {
	root := t.TempDir()
	p := config.DefaultPanelNetwork()
	if err := config.AtomicJSON(filepath.Join(root, "config", "websites.json"), []map[string]any{{"port": p.BackendPort}}); err != nil {
		t.Fatal(err)
	}
	if checkPanelReservations(root, p) == nil {
		t.Fatal("停用网站的预留端口未保护")
	}
	_ = os.Remove(filepath.Join(root, "config", "websites.json"))
	if err := config.AtomicJSON(filepath.Join(root, "state", "website-deployments", "job.json"), map[string]string{"state": "publishing"}); err != nil {
		t.Fatal(err)
	}
	if checkPanelReservations(root, p) == nil {
		t.Fatal("未阻止正在发布的网站任务")
	}
}
func TestBootstrapRestoreTouchesOnlyPanelRules(t *testing.T) {
	h := &fakeHost{rules: []string{frontendRule(48101), "allow 22/tcp"}}
	file := filepath.Join(t.TempDir(), "rules.json")
	p := config.DefaultPanelNetwork()
	if err := SaveBootstrapRules(context.Background(), h, p, file); err != nil {
		t.Fatal(err)
	}
	if err := Bootstrap(context.Background(), h, p); err != nil {
		t.Fatal(err)
	}
	h.rules = append(h.rules, "allow 8080/tcp")
	if err := RestoreBootstrapRules(context.Background(), h, file); err != nil {
		t.Fatal(err)
	}
	if strings.Join(h.rules, "|") != "allow 22/tcp|allow 8080/tcp|"+frontendRule(48101) {
		t.Fatalf("修改了无关规则：%v", h.rules)
	}
}

func TestStartupFailureRestoresOldPortsAndRules(t *testing.T) {
	w, r, h := setupWorker(t, "ports")
	h.failStart = true
	if err := w.Run(context.Background(), r.ID); err == nil {
		t.Fatal("预期启动失败")
	}
	row, _ := w.Store.read(r.ID)
	ports, _ := config.ReadPanelNetwork(w.Store.networkPath())
	if row.State != "rolled-back" || ports != r.OldPorts || h.starts != 2 || len(h.rules) != 2 {
		t.Fatalf("启动失败未回滚：%+v %v", row, ports)
	}
}
func TestLogPaginationPreservesChineseAcrossBoundary(t *testing.T) {
	w, r, h := setupWorker(t, "ports")
	original := strings.Repeat("日", 12000)
	w.Store.appendLog(r.ID, original)
	router := (Manager{Store: w.Store, Host: h, Ports: r.OldPorts}).Router()
	offset := int64(0)
	combined := ""
	for i := 0; i < 3; i++ {
		rr := httptest.NewRecorder()
		request := httptest.NewRequest("GET", fmt.Sprintf("/tasks/%s?offset=%d", r.ID, offset), nil)
		router.ServeHTTP(rr, request)
		var result struct {
			Logs       string `json:"logs"`
			NextOffset int64  `json:"nextOffset"`
			HasMore    bool   `json:"hasMore"`
		}
		if rr.Code != 200 || json.Unmarshal(rr.Body.Bytes(), &result) != nil {
			t.Fatalf("读取日志失败：%d %s", rr.Code, rr.Body)
		}
		combined += result.Logs
		offset = result.NextOffset
		if !result.HasMore {
			break
		}
	}
	if combined != original || offset != int64(len(original)) {
		t.Fatalf("分页损坏中文文本：%d/%d", len(combined), len(original))
	}
}
