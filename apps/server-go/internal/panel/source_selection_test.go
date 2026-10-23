package panel

import (
	"context"
	"errors"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestUpdateBindsSourceAlongsideChannel(t *testing.T) {
	for _, choice := range []UpdateSource{SourceGitHub, SourceGitee} {
		for _, channel := range []UpdateChannel{ChannelCommit, ChannelRelease} {
			t.Run(string(choice)+"/"+string(channel), func(t *testing.T) {
				worker, original, host := setupWorker(t, "update")
				if err := os.Remove(worker.Store.taskPath(original.ID)); err != nil {
					t.Fatal(err)
				}
				github, gitee := &channelSource{}, &channelSource{}
				manager := Manager{Store: worker.Store, Host: host, Source: FallbackSource{Primary: github, Fallback: gitee}, Ports: original.OldPorts, Enabled: true, Executable: filepath.Join(worker.install(), "releases", "old", "elysian")}
				other := SourceGitHub
				if choice == SourceGitHub {
					other = SourceGitee
				}
				checked, err := manager.CheckFrom(context.Background(), channel, other)
				if err != nil {
					t.Fatal(err)
				}
				input := submitInput{RequestID: "source-request", Channel: channel, Source: choice, TargetCommit: checked.TargetCommit, ReleaseTag: checked.ReleaseTag}
				if _, err := manager.Submit(context.Background(), "update", input, ""); err == nil {
					t.Fatal("另一来源的检查结果不能授权本来源更新，即使 SHA 相同")
				}
				checked, err = manager.CheckFrom(context.Background(), channel, choice)
				if err != nil || checked.Source != choice {
					t.Fatalf("检查未绑定来源：%+v %v", checked, err)
				}
				if _, err := manager.CheckFrom(context.Background(), channel, other); err != nil {
					t.Fatal(err)
				}
				task, err := manager.Submit(context.Background(), "update", input, "")
				if err != nil || task.UpdateSource != choice {
					t.Fatalf("来源独立缓存或任务快照错误：%+v %v", task, err)
				}
				again, err := manager.Submit(context.Background(), "update", input, "")
				if err != nil || again.ID != task.ID || host.dispatched != 1 {
					t.Fatalf("精确重试没有复用任务：%+v %v", again, err)
				}
				input.Source = other
				if _, err := manager.Submit(context.Background(), "update", input, ""); err == nil {
					t.Fatal("同一请求编号不能跨来源复用")
				}
				stored, err := worker.Store.read(task.ID)
				if err != nil || stored.UpdateSource != choice {
					t.Fatalf("重读任务丢失来源：%+v %v", stored, err)
				}
			})
		}
	}
}

func TestUpdateRoutesSelectAndValidateSource(t *testing.T) {
	worker, original, host := setupWorker(t, "update")
	github, gitee := &channelSource{}, &channelSource{}
	manager := Manager{Store: worker.Store, Host: host, Source: FallbackSource{Primary: github, Fallback: gitee}, Ports: original.OldPorts, Enabled: true}
	for _, endpoint := range []string{"/update", "/commits"} {
		for _, choice := range []string{"", "github", "gitee", "invalid"} {
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
	if len(github.checked) != 2 || len(github.history) != 2 || len(gitee.checked) != 1 || len(gitee.history) != 1 {
		t.Fatalf("未按所选来源检查和读取日志：GitHub=%+v Gitee=%+v", github, gitee)
	}
}

func TestExplicitSourceFailureDoesNotFallBack(t *testing.T) {
	github := &scriptedSource{checkErr: errors.New("GitHub unavailable")}
	gitee := &channelSource{}
	manager := Manager{Store: Store{Root: t.TempDir()}, Source: FallbackSource{Primary: github, Fallback: gitee}}
	if _, err := manager.CheckFrom(context.Background(), ChannelCommit, SourceGitHub); err == nil || len(gitee.checked) != 0 {
		t.Fatalf("手选来源失败不应回退：err=%v Gitee=%+v", err, gitee)
	}
	if _, err := manager.Check(context.Background(), ChannelCommit); err != nil || len(gitee.checked) != 1 {
		t.Fatalf("旧调用的自动回退应继续可用：err=%v Gitee=%+v", err, gitee)
	}
}
