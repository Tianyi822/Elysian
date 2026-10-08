package panel

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReleaseResolvesTagAndPinsDownloadAndHistory(t *testing.T) {
	for _, annotated := range []bool{false, true} {
		t.Run(map[bool]string{false: "轻量标签", true: "附注标签"}[annotated], func(t *testing.T) {
			sha, tagSHA := strings.Repeat("d", 40), strings.Repeat("e", 40)
			archived, historyRef := "", ""
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("User-Agent") != "Elysian-panel-updater" || r.Header.Get("Accept") != "application/vnd.github+json" {
					t.Error("缺少 GitHub 请求头")
				}
				switch r.URL.Path {
				case "/repos/" + Repository + "/releases/latest":
					// target_commitish 可以是正在变化的分支，不能用于构建目标。
					_ = json.NewEncoder(w).Encode(map[string]any{"tag_name": "stable/v1.2.0", "name": "正式版本", "draft": false, "prerelease": false, "target_commitish": "main"})
				case "/repos/" + Repository + "/git/ref/tags/stable/v1.2.0":
					kind, target := "commit", sha
					if annotated {
						kind, target = "tag", tagSHA
					}
					_ = json.NewEncoder(w).Encode(map[string]any{"object": map[string]string{"type": kind, "sha": target}})
				case "/repos/" + Repository + "/git/tags/" + tagSHA:
					_ = json.NewEncoder(w).Encode(map[string]any{"object": map[string]string{"type": "commit", "sha": sha}})
				case "/repos/" + Repository + "/tarball/" + sha:
					archived = sha
					_, _ = w.Write(archive(t, "repo/package.json", '0'))
				case "/repos/" + Repository + "/commits":
					historyRef = r.URL.Query().Get("sha")
					_, _ = w.Write([]byte(`[]`))
				default:
					t.Errorf("发版策略请求了错误来源：%s", r.URL.String())
					http.NotFound(w, r)
				}
			}))
			defer srv.Close()
			source := GitHubSource{Client: srv.Client(), API: srv.URL}
			result, err := source.Check(context.Background(), ChannelRelease)
			if err != nil || result.Channel != ChannelRelease || result.ReleaseTag != "stable/v1.2.0" || result.TargetCommit != sha || result.Branch != "" || !result.Available {
				t.Fatalf("未锁定发版提交：%+v %v", result, err)
			}
			if err := source.Download(context.Background(), result.TargetCommit, t.TempDir()); err != nil {
				t.Fatal(err)
			}
			if _, err := source.History(context.Background(), ChannelRelease, 50); err != nil {
				t.Fatal(err)
			}
			if archived != sha || historyRef != sha {
				t.Fatalf("下载或日志未锁定提交：%s %s", archived, historyRef)
			}
		})
	}
}

func TestReleaseEmptyAndUpstreamErrorsNeverFallBackToBranch(t *testing.T) {
	for _, tc := range []struct {
		name       string
		status     int
		body       string
		repoStatus int
		wantError  string
	}{
		{"暂无正式发版", 404, "", 200, ""},
		{"仓库不可访问", 404, "", 404, "更新仓库"},
		{"限流", 403, "", 200, "HTTP 403"},
		{"预发布", 200, `{"tag_name":"v2-rc1","draft":false,"prerelease":true}`, 200, "正式发版信息无效"},
		{"草稿", 200, `{"tag_name":"v2","draft":true,"prerelease":false}`, 200, "正式发版信息无效"},
		{"缺失标签", 200, `{"draft":false,"prerelease":false}`, 200, "正式发版信息无效"},
		{"错误响应", 200, `not-json`, 200, "正式发版信息无效"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/repos/" + Repository + "/releases/latest":
					w.WriteHeader(tc.status)
					_, _ = w.Write([]byte(tc.body))
				case "/repos/" + Repository:
					w.WriteHeader(tc.repoStatus)
					_, _ = w.Write([]byte(`{"default_branch":"main"}`))
				default:
					t.Errorf("不应回落提交或读取标签：%s", r.URL.Path)
					http.NotFound(w, r)
				}
			}))
			defer srv.Close()
			source := GitHubSource{Client: srv.Client(), API: srv.URL}
			result, err := source.Check(context.Background(), ChannelRelease)
			if tc.wantError != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantError) {
					t.Fatalf("错误未透传：%+v %v", result, err)
				}
			} else {
				if err != nil || result.Available || result.TargetCommit != "" || result.Message != "上游仓库暂无正式发版" {
					t.Fatalf("空状态错误：%+v %v", result, err)
				}
				rows, err := source.History(context.Background(), ChannelRelease, 50)
				if err != nil || len(rows) != 0 {
					t.Fatalf("无发版时日志未返回空列表：%v %v", rows, err)
				}
			}
		})
	}
}

func TestReleaseRejectsInvalidTagTargetsAndRecognizesCurrentVersion(t *testing.T) {
	for _, tc := range []struct {
		name, kind, sha string
		status          int
		wantError       bool
	}{
		{"当前提交", "commit", strings.Repeat("a", 40), 200, false},
		{"非法提交", "commit", "short", 200, true},
		{"非提交对象", "tree", strings.Repeat("a", 40), 200, true},
		{"循环附注", "tag", strings.Repeat("a", 40), 200, true},
		{"标签删除", "commit", strings.Repeat("a", 40), 404, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			previous := Commit
			Commit = strings.Repeat("a", 40)
			t.Cleanup(func() { Commit = previous })
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.HasSuffix(r.URL.Path, "/releases/latest") {
					_, _ = w.Write([]byte(`{"tag_name":"v1","draft":false,"prerelease":false}`))
					return
				}
				w.WriteHeader(tc.status)
				_ = json.NewEncoder(w).Encode(map[string]any{"object": map[string]string{"type": tc.kind, "sha": tc.sha}})
			}))
			defer srv.Close()
			result, err := (GitHubSource{Client: srv.Client(), API: srv.URL}).Check(context.Background(), ChannelRelease)
			if (err != nil) != tc.wantError {
				t.Fatalf("标签校验错误：%+v %v", result, err)
			}
			if !tc.wantError && result.Available {
				t.Fatal("同一提交被误判为可更新")
			}
		})
	}
}

type channelSource struct {
	fakeSource
	checked    []UpdateChannel
	history    []UpdateChannel
	downloaded string
}

func (s *channelSource) Check(_ context.Context, channel UpdateChannel) (Update, error) {
	s.checked = append(s.checked, channel)
	result := Update{Repository: Repository, Channel: channel, TargetCommit: strings.Repeat("f", 40), Available: true}
	if channel == ChannelRelease {
		result.ReleaseTag = "v1.2.0"
	} else {
		result.Branch = "main"
	}
	return result, nil
}
func (s *channelSource) History(_ context.Context, channel UpdateChannel, _ int) ([]CommitLog, error) {
	s.history = append(s.history, channel)
	return []CommitLog{}, nil
}
func (s *channelSource) Download(ctx context.Context, sha, dir string) error {
	s.downloaded = sha
	return s.fakeSource.Download(ctx, sha, dir)
}

func TestUpdateChecksBindStrategyTagAndCommit(t *testing.T) {
	worker, original, host := setupWorker(t, "update")
	if err := os.Remove(worker.Store.taskPath(original.ID)); err != nil {
		t.Fatal(err)
	}
	source := &channelSource{}
	manager := Manager{Store: worker.Store, Host: host, Source: source, Ports: original.OldPorts, Enabled: true, Executable: filepath.Join(worker.install(), "releases", "old", "elysian")}
	commit, err := manager.Check(context.Background(), ChannelCommit)
	if err != nil {
		t.Fatal(err)
	}
	input := submitInput{RequestID: "release-request", Channel: ChannelRelease, ReleaseTag: "v1.2.0", TargetCommit: commit.TargetCommit}
	if _, err := manager.Submit(context.Background(), "update", input, ""); err == nil {
		t.Fatal("提交检查结果不能授权发版更新，即使 SHA 相同")
	}
	release, err := manager.Check(context.Background(), ChannelRelease)
	if err != nil {
		t.Fatal(err)
	}
	for _, bad := range []submitInput{
		{RequestID: input.RequestID, Channel: ChannelRelease, ReleaseTag: "v9", TargetCommit: release.TargetCommit},
		{RequestID: input.RequestID, Channel: ChannelRelease, ReleaseTag: release.ReleaseTag, TargetCommit: strings.Repeat("a", 40)},
		{RequestID: input.RequestID, Channel: "unknown", TargetCommit: release.TargetCommit},
		{RequestID: input.RequestID, Channel: ChannelCommit, ReleaseTag: release.ReleaseTag, TargetCommit: release.TargetCommit},
	} {
		if _, err := manager.Submit(context.Background(), "update", bad, ""); err == nil {
			t.Fatalf("接受了未检查的目标：%+v", bad)
		}
	}
	// 两种检查互不覆盖，提交检查可再次刷新而不撤销已锁定的发版结果。
	if _, err := manager.Check(context.Background(), ChannelCommit); err != nil {
		t.Fatal(err)
	}
	task, err := manager.Submit(context.Background(), "update", input, "")
	if err != nil || task.UpdateChannel != ChannelRelease || task.ReleaseTag != release.ReleaseTag || task.TargetCommit != release.TargetCommit {
		t.Fatalf("未持久化发版策略：%+v %v", task, err)
	}
	again, err := manager.Submit(context.Background(), "update", input, "")
	if err != nil || again.ID != task.ID || host.dispatched != 1 {
		t.Fatalf("幂等提交重复执行：%+v %v", again, err)
	}
	input.Channel = ChannelCommit
	input.ReleaseTag = ""
	if _, err := manager.Submit(context.Background(), "update", input, ""); err == nil {
		t.Fatal("同一请求编号不能跨策略复用")
	}
	stored, err := manager.Store.read(task.ID)
	if err != nil || stored.UpdateChannel != ChannelRelease || stored.ReleaseTag != release.ReleaseTag {
		t.Fatalf("重读任务丢失策略：%+v %v", stored, err)
	}
}

func TestUpdateRoutesSelectAndValidateChannel(t *testing.T) {
	worker, original, host := setupWorker(t, "update")
	source := &channelSource{}
	manager := Manager{Store: worker.Store, Host: host, Source: source, Ports: original.OldPorts, Enabled: true}
	for _, endpoint := range []string{"/update", "/commits"} {
		for _, channel := range []string{"", "commit", "release", "invalid"} {
			response := httptest.NewRecorder()
			manager.Router().ServeHTTP(response, httptest.NewRequest("GET", endpoint+"?channel="+channel, nil))
			expected := 200
			if channel == "invalid" {
				expected = 400
			}
			if response.Code != expected {
				t.Fatalf("%s %s: %d %s", endpoint, channel, response.Code, response.Body.String())
			}
		}
	}
	for _, channels := range [][]UpdateChannel{source.checked, source.history} {
		if len(channels) != 3 || channels[0] != ChannelCommit || channels[1] != ChannelCommit || channels[2] != ChannelRelease {
			t.Fatalf("路由策略传递错误：%v", channels)
		}
	}
}

func TestReleaseWorkerUsesPersistedCommit(t *testing.T) {
	worker, record, host := setupWorker(t, "update")
	source := &channelSource{}
	worker.Source = source
	record.UpdateChannel = ChannelRelease
	record.ReleaseTag = "v1.2.0"
	record.TargetCommit = strings.Repeat("d", 40)
	host.candidate = filepath.Join(worker.install(), "releases", "new", "elysian")
	if err := os.MkdirAll(filepath.Dir(host.candidate), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(host.candidate, []byte("new"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := worker.execute(context.Background(), &record); err != nil {
		t.Fatal(err)
	}
	if source.downloaded != record.TargetCommit || len(source.checked) != 0 || record.State != "succeeded" {
		t.Fatalf("执行时重新解析版本或未使用固定提交：%+v %+v", source, record)
	}
	logs, err := os.ReadFile(worker.Store.logPath(record.ID))
	if err != nil || !strings.Contains(string(logs), "最新发版 v1.2.0") {
		t.Fatalf("日志未记录策略：%s %v", logs, err)
	}
}
