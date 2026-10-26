package panel

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func giteeTestSource(t *testing.T, handler http.HandlerFunc) (GiteeSource, string) {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return GiteeSource{Client: srv.Client(), API: srv.URL + "/api/v5"}, srv.URL
}

// giteeGitRepo 构造一个本地裸仓库，模拟 Gitee 的 git 远端。
func giteeGitRepo(t *testing.T) (repoURL string, sha string) {
	t.Helper()
	work := t.TempDir()
	gitRun := func(dir string, args ...string) string {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-c", "user.email=panel@test", "-c", "user.name=panel"}, args...)...)
		cmd.Dir = dir
		var out bytes.Buffer
		cmd.Stdout, cmd.Stderr = &out, &out
		if err := cmd.Run(); err != nil {
			t.Fatalf("fixture git %v 失败：%v %s", args, err, out.String())
		}
		return out.String()
	}
	if err := os.WriteFile(filepath.Join(work, "repo.txt"), []byte("ok"), 0600); err != nil {
		t.Fatal(err)
	}
	gitRun(work, "init", "--quiet")
	gitRun(work, "add", "-A")
	gitRun(work, "commit", "--quiet", "-m", "init")
	sha = strings.TrimSpace(gitRun(work, "rev-parse", "HEAD"))
	bare := t.TempDir()
	gitRun(work, "clone", "--quiet", "--bare", work, bare)
	return "file://" + bare, sha
}

func TestGiteeDownloadViaGitProtocol(t *testing.T) {
	repoURL, sha := giteeGitRepo(t)
	dir := t.TempDir()
	if err := (GiteeSource{Repo: repoURL}).Download(context.Background(), sha, dir); err != nil {
		t.Fatal(err)
	}
	if b, err := os.ReadFile(filepath.Join(dir, "repo.txt")); err != nil || string(b) != "ok" {
		t.Fatalf("未检出源码文件：%v %q", err, b)
	}
	if _, err := os.Stat(filepath.Join(dir, ".git")); !os.IsNotExist(err) {
		t.Fatalf("工作区残留 .git：%v", err)
	}
}

func TestGiteeDownloadViaGitProtocolRejectsUnknownCommit(t *testing.T) {
	repoURL, _ := giteeGitRepo(t)
	err := (GiteeSource{Repo: repoURL}).Download(context.Background(), strings.Repeat("d", 40), t.TempDir())
	if err == nil || !strings.Contains(err.Error(), "源码拉取失败") {
		t.Fatalf("未知提交未被拒绝：%v", err)
	}
}

func TestGiteeDownloadViaGitProtocolRequiresGit(t *testing.T) {
	repoURL, sha := giteeGitRepo(t)
	err := (GiteeSource{Repo: repoURL, Git: "/nonexistent-elysian-git"}).Download(context.Background(), sha, t.TempDir())
	if err == nil || !strings.Contains(err.Error(), "未安装 git") {
		t.Fatalf("缺 git 未被识别：%v", err)
	}
}

func TestGiteeCommitCheckAndHistory(t *testing.T) {
	sha := strings.Repeat("a", 40)
	source, _ := giteeTestSource(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("User-Agent") != "Elysian-panel-updater" {
			t.Error("缺少 Gitee 请求头")
		}
		switch r.URL.Path {
		case "/api/v5/repos/" + GiteeRepository:
			_ = json.NewEncoder(w).Encode(map[string]string{"default_branch": "main"})
		case "/api/v5/repos/" + GiteeRepository + "/commits":
			if r.URL.Query().Get("sha") != "main" {
				t.Errorf("提交查询未使用默认分支：%s", r.URL.RawQuery)
			}
			_, _ = w.Write([]byte(`[{"sha":"` + sha + `","commit":{"message":"标题\n正文不展示","author":{"date":"2026-10-21T15:06:51+08:00"}}}]`))
		default:
			t.Errorf("请求了预期之外的路径：%s", r.URL.String())
			http.NotFound(w, r)
		}
	})

	result, err := source.Check(context.Background(), ChannelCommit)
	if err != nil || result.Repository != Repository || result.Branch != "main" || result.TargetCommit != sha || result.Message != "标题" || !result.Available {
		t.Fatalf("Gitee 提交检查失败：%+v %v", result, err)
	}
	commits, err := source.History(context.Background(), ChannelCommit, 50)
	if err != nil || len(commits) != 1 || commits[0].SHA != sha || commits[0].Message != "标题" {
		t.Fatalf("Gitee 提交历史失败：%+v %v", commits, err)
	}
}

func TestGiteeReleaseCheckSkipsPrerelease(t *testing.T) {
	sha := strings.Repeat("b", 40)
	source, _ := giteeTestSource(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v5/repos/" + GiteeRepository + "/releases":
			if r.URL.Query().Get("direction") != "desc" || r.URL.Query().Get("per_page") != "100" {
				t.Errorf("发版列表参数错误：%s", r.URL.RawQuery)
			}
			_ = json.NewEncoder(w).Encode([]map[string]any{
				{"tag_name": "v2-rc1", "name": "预发布", "prerelease": true},
				{"tag_name": "v1.2.0", "name": "正式版本", "prerelease": false},
			})
		case "/api/v5/repos/" + GiteeRepository + "/commits":
			if r.URL.Query().Get("sha") != "v1.2.0" {
				t.Errorf("发版标签未转为提交：%s", r.URL.RawQuery)
			}
			_, _ = w.Write([]byte(`[{"sha":"` + sha + `","commit":{"message":"正式发版"}}]`))
		default:
			t.Errorf("请求了预期之外的路径：%s", r.URL.String())
			http.NotFound(w, r)
		}
	})

	result, err := source.Check(context.Background(), ChannelRelease)
	if err != nil || result.Channel != ChannelRelease || result.ReleaseTag != "v1.2.0" || result.TargetCommit != sha || !result.Available {
		t.Fatalf("Gitee 发版检查失败：%+v %v", result, err)
	}
}

type scriptedSource struct {
	check       Update
	checkErr    error
	history     []CommitLog
	historyErr  error
	download    func(context.Context, string, string) error
	downloadErr error
}

func (s *scriptedSource) Check(context.Context, UpdateChannel) (Update, error) {
	return s.check, s.checkErr
}
func (s *scriptedSource) History(context.Context, UpdateChannel, int) ([]CommitLog, error) {
	return s.history, s.historyErr
}
func (s *scriptedSource) Download(ctx context.Context, sha, dir string) error {
	if s.download != nil {
		return s.download(ctx, sha, dir)
	}
	return s.downloadErr
}

func TestFallbackSourceUsesGiteeAndCleansPartialDownload(t *testing.T) {
	sha := strings.Repeat("c", 40)
	primary := &scriptedSource{
		checkErr:   errors.New("GitHub 不可达"),
		historyErr: errors.New("GitHub 不可达"),
		download: func(_ context.Context, _, dir string) error {
			if err := os.WriteFile(filepath.Join(dir, "partial"), []byte("partial"), 0600); err != nil {
				return err
			}
			return errors.New("GitHub 下载中断")
		},
	}
	fallback := &scriptedSource{
		check:   Update{TargetCommit: sha, Message: "Gitee 提交", Available: true},
		history: []CommitLog{{SHA: sha, Message: "Gitee 提交"}},
		download: func(_ context.Context, _, dir string) error {
			entries, err := os.ReadDir(dir)
			if err != nil {
				return err
			}
			if len(entries) != 0 {
				return errors.New("回退前未清理部分下载")
			}
			return os.WriteFile(filepath.Join(dir, "ok"), []byte("ok"), 0600)
		},
	}
	source := FallbackSource{Primary: primary, Fallback: fallback}
	result, err := source.Check(context.Background(), ChannelCommit)
	if err != nil || result.TargetCommit != sha {
		t.Fatalf("未回退到 Gitee 检查：%+v %v", result, err)
	}
	commits, err := source.History(context.Background(), ChannelCommit, 50)
	if err != nil || len(commits) != 1 || commits[0].SHA != sha {
		t.Fatalf("未回退到 Gitee 历史：%+v %v", commits, err)
	}
	dir := t.TempDir()
	if err := source.Download(context.Background(), sha, dir); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "ok")); err != nil {
		t.Fatalf("回退下载未写入目标：%v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "partial")); !os.IsNotExist(err) {
		t.Fatalf("部分下载未清理：%v", err)
	}
}

func TestFallbackSourceReportsBothSourcesOnReleaseEmpty(t *testing.T) {
	source := FallbackSource{Primary: &scriptedSource{checkErr: errors.New("GitHub 不可达")}, Fallback: &scriptedSource{check: Update{}}}
	_, err := source.Check(context.Background(), ChannelRelease)
	if err == nil || !strings.Contains(err.Error(), "GitHub 不可达") || !strings.Contains(err.Error(), "Gitee") {
		t.Fatalf("发版回退空结果未报告两个来源：%v", err)
	}
}
