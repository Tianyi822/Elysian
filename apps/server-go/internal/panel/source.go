package panel

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type GitHubSource struct {
	Client *http.Client
	API    string
}

var errGitHubNotFound = errors.New("更新仓库尚未公开或目标版本不存在")

func (s GitHubSource) client() *http.Client {
	if s.Client != nil {
		return s.Client
	}
	return &http.Client{Timeout: 10 * time.Minute, CheckRedirect: func(r *http.Request, via []*http.Request) error {
		if len(via) > 5 || r.URL.Scheme != "https" || (r.URL.Host != "api.github.com" && r.URL.Host != "codeload.github.com") {
			return fmt.Errorf("源码下载重定向地址不允许")
		}
		return nil
	}}
}
func (s GitHubSource) api() string {
	if s.API != "" {
		return s.API
	}
	return "https://api.github.com"
}
func (s GitHubSource) get(ctx context.Context, endpoint string) (*http.Response, error) {
	r, err := http.NewRequestWithContext(ctx, "GET", endpoint, nil)
	if err != nil {
		return nil, err
	}
	r.Header.Set("Accept", "application/vnd.github+json")
	r.Header.Set("User-Agent", "Elysian-panel-updater")
	response, err := s.client().Do(r)
	if err != nil {
		return nil, fmt.Errorf("GitHub 不可达：%w", err)
	}
	if response.StatusCode != 200 {
		response.Body.Close()
		if response.StatusCode == 404 {
			return nil, errGitHubNotFound
		}
		return nil, fmt.Errorf("GitHub 请求失败：HTTP %d（请检查网络或 API 限额）", response.StatusCode)
	}
	return response, nil
}

// defaultBranch 解析仓库的默认分支；Check 与 History 都以它为准，不写死分支名。
func (s GitHubSource) defaultBranch(ctx context.Context) (string, error) {
	r, err := s.get(ctx, s.api()+"/repos/"+Repository)
	if err != nil {
		return "", err
	}
	defer r.Body.Close()
	var repo struct {
		DefaultBranch string `json:"default_branch"`
	}
	if err = json.NewDecoder(io.LimitReader(r.Body, 1024*1024)).Decode(&repo); err != nil || repo.DefaultBranch == "" {
		return "", fmt.Errorf("GitHub 仓库信息无效")
	}
	return repo.DefaultBranch, nil
}

// firstLine 只取提交说明的标题行，正文留给 GitHub。
func firstLine(message string) string { return strings.SplitN(message, "\n", 2)[0] }

func (s GitHubSource) Check(ctx context.Context, channel UpdateChannel) (Update, error) {
	channel = normalizeChannel(channel)
	u := Update{Repository: Repository, CurrentCommit: Commit, Channel: channel, Source: SourceGitHub}
	if !validChannel(channel) {
		return u, fmt.Errorf("更新策略无效")
	}
	if channel == ChannelRelease {
		release, err := s.latestRelease(ctx)
		if err != nil {
			return u, err
		}
		if release.Tag == "" {
			u.Message = "上游仓库暂无正式发版"
			return u, nil
		}
		u.ReleaseTag = release.Tag
		u.Message = release.Name
		u.TargetCommit, err = s.tagCommit(ctx, release.Tag)
		if err != nil {
			return u, err
		}
		u.Available = u.TargetCommit != Commit
		return u, nil
	}
	branch, err := s.defaultBranch(ctx)
	if err != nil {
		return u, err
	}
	u.Branch = branch
	r, err := s.get(ctx, s.api()+"/repos/"+Repository+"/commits/"+url.PathEscape(u.Branch))
	if err != nil {
		return u, err
	}
	defer r.Body.Close()
	var result struct {
		SHA    string `json:"sha"`
		Commit struct {
			Message string `json:"message"`
		} `json:"commit"`
	}
	if err = json.NewDecoder(io.LimitReader(r.Body, 1024*1024)).Decode(&result); err != nil || !commitPattern.MatchString(result.SHA) {
		return u, fmt.Errorf("GitHub 提交信息无效")
	}
	u.TargetCommit = result.SHA
	u.Message = firstLine(result.Commit.Message)
	u.Available = u.TargetCommit != Commit
	return u, nil
}

// History 列出所选来源最近的提交；发版策略以发布标签的固定 SHA 为起点。
// 上限固定由调用方给，越界一律回落到默认值，不接受任意大的拉取。
func (s GitHubSource) History(ctx context.Context, channel UpdateChannel, limit int) ([]CommitLog, error) {
	channel = normalizeChannel(channel)
	if !validChannel(channel) {
		return nil, fmt.Errorf("更新策略无效")
	}
	ref := ""
	if channel == ChannelRelease {
		u, err := s.Check(ctx, channel)
		if err != nil {
			return nil, err
		}
		if u.TargetCommit == "" {
			return []CommitLog{}, nil
		}
		ref = u.TargetCommit
	} else {
		branch, err := s.defaultBranch(ctx)
		if err != nil {
			return nil, err
		}
		ref = branch
	}
	if limit < 1 || limit > 100 {
		limit = 30
	}
	endpoint := s.api() + "/repos/" + Repository + "/commits?sha=" + url.QueryEscape(ref) + "&per_page=" + strconv.Itoa(limit)
	r, err := s.get(ctx, endpoint)
	if err != nil {
		return nil, err
	}
	defer r.Body.Close()
	var result []struct {
		SHA    string `json:"sha"`
		Commit struct {
			Message string `json:"message"`
			Author  struct {
				Time time.Time `json:"date"`
			} `json:"author"`
		} `json:"commit"`
	}
	if err = json.NewDecoder(io.LimitReader(r.Body, 4*1024*1024)).Decode(&result); err != nil {
		return nil, fmt.Errorf("GitHub 提交列表无效")
	}
	commits := make([]CommitLog, 0, len(result))
	for _, item := range result {
		if !commitPattern.MatchString(item.SHA) {
			return nil, fmt.Errorf("GitHub 提交列表无效")
		}
		commits = append(commits, CommitLog{SHA: item.SHA, Message: firstLine(item.Commit.Message), Time: item.Commit.Author.Time})
	}
	return commits, nil
}

type githubRelease struct {
	Tag        string `json:"tag_name"`
	Name       string `json:"name"`
	Draft      *bool  `json:"draft"`
	Prerelease *bool  `json:"prerelease"`
}

// 使用 GitHub 标记的 latest 正式发版，不按标签字典序排序，也不把 target_commitish 当作版本。
func (s GitHubSource) latestRelease(ctx context.Context) (githubRelease, error) {
	var release githubRelease
	r, err := s.get(ctx, s.api()+"/repos/"+Repository+"/releases/latest")
	if errors.Is(err, errGitHubNotFound) {
		// 仓库可访问但没有正式发版属于空状态；私有或不存在的仓库仍报告错误。
		if _, repoErr := s.defaultBranch(ctx); repoErr != nil {
			return release, repoErr
		}
		return release, nil
	}
	if err != nil {
		return release, err
	}
	defer r.Body.Close()
	if err = json.NewDecoder(io.LimitReader(r.Body, 1024*1024)).Decode(&release); err != nil || release.Tag == "" || len(release.Tag) > 1024 || release.Draft == nil || release.Prerelease == nil || *release.Draft || *release.Prerelease {
		return githubRelease{}, fmt.Errorf("GitHub 正式发版信息无效")
	}
	if release.Name == "" {
		release.Name = release.Tag
	}
	return release, nil
}

// 精确读取 tags 引用，兼容轻量标签和附注标签，最终只接受完整 commit SHA。
func (s GitHubSource) tagCommit(ctx context.Context, tag string) (string, error) {
	endpoint := s.api() + "/repos/" + Repository + "/git/ref/tags/" + url.PathEscape(tag)
	for depth := 0; depth < 8; depth++ {
		r, err := s.get(ctx, endpoint)
		if err != nil {
			return "", err
		}
		var result struct {
			Object struct {
				Type string `json:"type"`
				SHA  string `json:"sha"`
			} `json:"object"`
		}
		err = json.NewDecoder(io.LimitReader(r.Body, 1024*1024)).Decode(&result)
		r.Body.Close()
		if err != nil || !commitPattern.MatchString(result.Object.SHA) {
			return "", fmt.Errorf("发版标签对应的提交无效")
		}
		switch result.Object.Type {
		case "commit":
			return result.Object.SHA, nil
		case "tag":
			endpoint = s.api() + "/repos/" + Repository + "/git/tags/" + result.Object.SHA
		default:
			return "", fmt.Errorf("发版标签未指向提交")
		}
	}
	return "", fmt.Errorf("发版标签嵌套过深")
}

func (s GitHubSource) Download(ctx context.Context, sha, destination string) error {
	if !commitPattern.MatchString(sha) {
		return fmt.Errorf("目标提交无效")
	}
	r, err := s.get(ctx, s.api()+"/repos/"+Repository+"/tarball/"+sha)
	if err != nil {
		return err
	}
	defer r.Body.Close()
	if err = extractSource(io.LimitReader(r.Body, 128*1024*1024), destination); err != nil {
		return fmt.Errorf("源码解包失败：%w", err)
	}
	return nil
}

func extractSource(reader io.Reader, destination string) error {
	z, err := gzip.NewReader(reader)
	if err != nil {
		return fmt.Errorf("源码归档无效：%w", err)
	}
	defer z.Close()
	t := tar.NewReader(z)
	var total int64
	count := 0
	prefix := ""
	if err = os.MkdirAll(destination, 0700); err != nil {
		return err
	}
	for {
		h, err := t.Next()
		if err == io.EOF {
			_, err = io.Copy(io.Discard, z)
			return err
		}
		if err != nil {
			return err
		}
		count++
		total += h.Size
		if count > 50000 || h.Size < 0 || total > 1024*1024*1024 {
			return fmt.Errorf("源码归档超过文件或大小限制")
		}
		if path.IsAbs(h.Name) || strings.Contains(h.Name, "\\") {
			return fmt.Errorf("源码归档包含非法路径")
		}
		for _, part := range strings.Split(h.Name, "/") {
			if part == ".." {
				return fmt.Errorf("源码归档包含目录越界")
			}
		}
		parts := strings.SplitN(path.Clean(h.Name), "/", 2)
		if prefix == "" {
			prefix = parts[0]
		}
		if prefix != parts[0] {
			return fmt.Errorf("源码归档包含多个根目录")
		}
		if len(parts) < 2 {
			if h.Typeflag != tar.TypeDir {
				return fmt.Errorf("源码根目录无效")
			}
			continue
		}
		name := filepath.Join(destination, filepath.FromSlash(parts[1]))
		switch h.Typeflag {
		case tar.TypeDir:
			err = os.MkdirAll(name, 0700)
		case tar.TypeReg, tar.TypeRegA:
			if err = os.MkdirAll(filepath.Dir(name), 0700); err != nil {
				return err
			}
			var f *os.File
			f, err = os.OpenFile(name, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
			if err != nil {
				return err
			}
			_, err = io.CopyN(f, t, h.Size)
			e := f.Close()
			if err == nil {
				err = e
			}
		default:
			return fmt.Errorf("源码归档不允许链接或特殊文件")
		}
		if err != nil {
			return err
		}
	}
}
