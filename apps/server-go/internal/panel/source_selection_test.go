package panel

import (
	"context"
	"errors"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"elysian/server/internal/config"
)

func TestUpdateUsesGitHubForDefaultAndLegacyAutoRequests(t *testing.T) {
	for _, choice := range []UpdateSource{"", SourceAuto, SourceGitHub} {
		for _, channel := range []UpdateChannel{ChannelRelease} {
			t.Run(string(choice)+"/"+string(channel), func(t *testing.T) {
				worker, original, host := setupWorker(t, "update")
				if err := os.Remove(worker.Store.taskPath(original.ID)); err != nil {
					t.Fatal(err)
				}
				source := &channelSource{}
				manager := Manager{Store: worker.Store, Host: host, Source: source, Ports: original.OldPorts, Enabled: true, Executable: filepath.Join(worker.install(), "releases", "old", "elysian")}
				checked, err := manager.CheckFrom(context.Background(), channel, choice)
				if err != nil || checked.Source != SourceGitHub {
					t.Fatalf("检查未绑定 GitHub：%+v %v", checked, err)
				}
				input := submitInput{RequestID: "source-request", Channel: channel, Source: choice, TargetCommit: checked.TargetCommit, ReleaseTag: checked.ReleaseTag}
				task, err := manager.Submit(context.Background(), "update", input, "")
				if err != nil || task.UpdateSource != SourceGitHub {
					t.Fatalf("新任务未固定 GitHub：%+v %v", task, err)
				}
				again, err := manager.Submit(context.Background(), "update", input, "")
				if err != nil || again.ID != task.ID || host.dispatched != 1 {
					t.Fatalf("精确重试没有复用任务：%+v %v", again, err)
				}
				input.Source = SourceGitee
				if _, err := manager.Submit(context.Background(), "update", input, ""); err == nil {
					t.Fatal("同一请求编号不能改成 Gitee")
				}
			})
		}
	}
}

func TestUpdateRoutesAcceptBothExplicitSources(t *testing.T) {
	worker, original, host := setupWorker(t, "update")
	if err := os.Remove(worker.Store.taskPath(original.ID)); err != nil {
		t.Fatal(err)
	}
	source := &channelSource{}
	manager := Manager{Store: worker.Store, Host: host, Source: source, Sources: map[UpdateSource]Source{SourceGitee: source}, Ports: original.OldPorts, Enabled: true}
	for _, endpoint := range []string{"/update", "/commits"} {
		for _, choice := range []string{"", "auto", "github", "gitee", "invalid"} {
			response := httptest.NewRecorder()
			manager.Router().ServeHTTP(response, httptest.NewRequest("GET", endpoint+"?channel=commit&source="+choice, nil))
			expected := 200
			if choice == "invalid" {
				expected = 400
			}
			if response.Code != expected {
				t.Fatalf("%s source=%s: %d %s", endpoint, choice, response.Code, response.Body.String())
			}
		}
	}
	for _, endpoint := range []string{"/update", "/update/preflight"} {
		response := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "http://127.0.0.1"+endpoint, strings.NewReader(`{"source":"gitee","channel":"commit","requestId":"retired-source"}`))
		req.Header.Set("Origin", "http://127.0.0.1")
		req.Header.Set("Content-Type", "application/json")
		manager.Router().ServeHTTP(response, req)
		if response.Code != 400 {
			t.Fatalf("%s: %d %s", endpoint, response.Code, response.Body.String())
		}
	}
	if len(source.checked) != 4 || len(source.history) != 4 || host.dispatched != 0 {
		t.Fatalf("禁用来源触发了上游调用或派发：%+v", source)
	}
}

func TestHistoricalGiteeRequestReconcilesWithoutDispatch(t *testing.T) {
	worker, original, host := setupWorker(t, "update")
	original.RequestID, original.UpdateSource, original.State = "legacy-gitee", SourceGitee, "failed"
	if err := worker.Store.save(original); err != nil {
		t.Fatal(err)
	}
	manager := Manager{Store: worker.Store, Host: host, Source: &channelSource{}, Ports: original.OldPorts, Enabled: true}
	input := submitInput{RequestID: original.RequestID, Source: SourceGitee, TargetCommit: original.TargetCommit}
	task, err := manager.Submit(context.Background(), "update", input, "")
	if err != nil || task.ID != original.ID || task.UpdateSource != SourceGitee || host.dispatched != 0 {
		t.Fatalf("旧任务对账错误：%+v %v", task, err)
	}
	input.Source = SourceGitHub
	if _, err = manager.Submit(context.Background(), "update", input, ""); err == nil {
		t.Fatal("旧 Gitee 请求不能改投 GitHub")
	}
	input.RequestID, input.Source = "new-gitee-request", SourceGitee
	if _, err = manager.Submit(context.Background(), "update", input, ""); err == nil {
		t.Fatalf("新 Gitee 请求未拒绝：%v", err)
	}
}

func TestGiteeCheckCannotAuthorizeGitHubUpdate(t *testing.T) {
	worker, record, host := setupWorker(t, "update")
	manager := Manager{Store: worker.Store, Host: host, Enabled: true}
	input := submitInput{Source: SourceGitHub, Channel: ChannelCommit, TargetCommit: record.TargetCommit}
	u := Update{Repository: Repository, Source: SourceGitee, Channel: ChannelCommit, Available: true, TargetCommit: record.TargetCommit}
	if err := config.AtomicJSON(worker.Store.updateCheckPath(input.Channel, input.Source), u); err != nil {
		t.Fatal(err)
	}
	if err := manager.checkedUpdate(input); err == nil {
		t.Fatal("旧 Gitee 检查不能授权 GitHub 更新")
	}
}

func TestWorkerRejectsHistoricalGiteeBeforeDownload(t *testing.T) {
	worker, record, _ := setupWorker(t, "update")
	source := &channelSource{}
	worker.Source, record.UpdateSource = source, SourceGitee
	if err := worker.execute(context.Background(), &record); err == nil {
		t.Fatalf("应明确拒绝旧来源：%v", err)
	}
	if source.downloaded != "" || record.Activated || record.PanelStopIntent {
		t.Fatalf("拒绝前产生了外部变更：%+v", record)
	}
}

type failingSource struct {
	channelSource
	checks int
}

func (s *failingSource) Check(context.Context, UpdateChannel) (Update, error) {
	s.checks++
	return Update{}, errors.New("GitHub 不可达")
}
func TestDefaultSourceFailureDoesNotFallBack(t *testing.T) {
	if _, ok := DefaultSource().(GitHubSource); !ok {
		t.Fatal("默认来源必须仅为 GitHub")
	}
	source := &failingSource{}
	manager := Manager{Store: Store{Root: t.TempDir()}, Source: source}
	for _, choice := range []UpdateSource{"", SourceAuto, SourceGitHub} {
		if _, err := manager.CheckFrom(context.Background(), ChannelCommit, choice); err == nil || err.Error() != "GitHub 不可达" {
			t.Fatalf("未保留 GitHub 失败：%v", err)
		}
	}
	if source.checks != 3 {
		t.Fatalf("失败后重复尝试：%d", source.checks)
	}
}
