package panel

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

// GiteeRepository 是仓库所有者维护的镜像，可显式选择，也供旧调用自动回退使用。
const GiteeRepository = "Chentyit/Elysian"

type GiteeSource struct {
	Client  *http.Client
	API     string
	Archive string
}

var errGiteeNotFound = errors.New("Gitee 镜像不存在或目标版本尚未同步")

func (s GiteeSource) client() *http.Client {
	if s.Client != nil {
		return s.Client
	}
	return &http.Client{Timeout: 10 * time.Minute, CheckRedirect: func(r *http.Request, via []*http.Request) error {
		if len(via) > 5 || r.URL.Scheme != "https" || r.URL.Host != "gitee.com" {
			return fmt.Errorf("Gitee 下载重定向地址不允许")
		}
		return nil
	}}
}

func (s GiteeSource) api() string {
	if s.API != "" {
		return s.API
	}
	return "https://gitee.com/api/v5"
}

func (s GiteeSource) archive() string {
	if s.Archive != "" {
		return s.Archive
	}
	return "https://gitee.com/" + GiteeRepository + "/repository/archive"
}

func (s GiteeSource) get(ctx context.Context, endpoint string) (*http.Response, error) {
	r, err := http.NewRequestWithContext(ctx, "GET", endpoint, nil)
	if err != nil {
		return nil, err
	}
	r.Header.Set("Accept", "application/json")
	r.Header.Set("User-Agent", "Elysian-panel-updater")
	response, err := s.client().Do(r)
	if err != nil {
		return nil, fmt.Errorf("Gitee 不可达：%w", err)
	}
	if response.StatusCode != 200 {
		response.Body.Close()
		if response.StatusCode == 404 {
			return nil, errGiteeNotFound
		}
		return nil, fmt.Errorf("Gitee 请求失败：HTTP %d（请检查网络或 API 限额）", response.StatusCode)
	}
	return response, nil
}

func (s GiteeSource) defaultBranch(ctx context.Context) (string, error) {
	r, err := s.get(ctx, s.api()+"/repos/"+GiteeRepository)
	if err != nil {
		return "", err
	}
	defer r.Body.Close()
	var repo struct {
		DefaultBranch string `json:"default_branch"`
	}
	if err = json.NewDecoder(io.LimitReader(r.Body, 1024*1024)).Decode(&repo); err != nil || repo.DefaultBranch == "" {
		return "", fmt.Errorf("Gitee 仓库信息无效")
	}
	return repo.DefaultBranch, nil
}

type giteeCommit struct {
	SHA    string `json:"sha"`
	Commit struct {
		Message string `json:"message"`
		Author  struct {
			Time time.Time `json:"date"`
		} `json:"author"`
	} `json:"commit"`
}

func (s GiteeSource) commits(ctx context.Context, ref string, limit int) ([]giteeCommit, error) {
	endpoint := s.api() + "/repos/" + GiteeRepository + "/commits?sha=" + url.QueryEscape(ref) + "&per_page=" + strconv.Itoa(limit)
	r, err := s.get(ctx, endpoint)
	if err != nil {
		return nil, err
	}
	defer r.Body.Close()
	var result []giteeCommit
	if err = json.NewDecoder(io.LimitReader(r.Body, 4*1024*1024)).Decode(&result); err != nil {
		return nil, fmt.Errorf("Gitee 提交列表无效")
	}
	return result, nil
}

func (s GiteeSource) Check(ctx context.Context, channel UpdateChannel) (Update, error) {
	channel = normalizeChannel(channel)
	u := Update{Repository: Repository, CurrentCommit: Commit, Channel: channel, Source: SourceGitee}
	if !validChannel(channel) {
		return u, fmt.Errorf("更新策略无效")
	}
	if channel == ChannelRelease {
		release, err := s.latestRelease(ctx)
		if err != nil {
			return u, err
		}
		u.Message = "Gitee 镜像暂无正式发版"
		if release.Tag == "" {
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
	commits, err := s.commits(ctx, branch, 1)
	if err != nil {
		return u, err
	}
	if len(commits) == 0 || !commitPattern.MatchString(commits[0].SHA) {
		return u, fmt.Errorf("Gitee 提交信息无效")
	}
	u.TargetCommit = commits[0].SHA
	u.Message = firstLine(commits[0].Commit.Message)
	u.Available = u.TargetCommit != Commit
	return u, nil
}

func (s GiteeSource) History(ctx context.Context, channel UpdateChannel, limit int) ([]CommitLog, error) {
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
			return nil, fmt.Errorf("Gitee 镜像暂无正式发版")
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
	items, err := s.commits(ctx, ref, limit)
	if err != nil {
		return nil, err
	}
	commits := make([]CommitLog, 0, len(items))
	for _, item := range items {
		if !commitPattern.MatchString(item.SHA) {
			return nil, fmt.Errorf("Gitee 提交列表无效")
		}
		commits = append(commits, CommitLog{SHA: item.SHA, Message: firstLine(item.Commit.Message), Time: item.Commit.Author.Time})
	}
	return commits, nil
}

type giteeRelease struct {
	Tag        string `json:"tag_name"`
	Name       string `json:"name"`
	Draft      *bool  `json:"draft"`
	Prerelease bool   `json:"prerelease"`
}

func (s GiteeSource) latestRelease(ctx context.Context) (giteeRelease, error) {
	r, err := s.get(ctx, s.api()+"/repos/"+GiteeRepository+"/releases?direction=desc&per_page=100")
	if errors.Is(err, errGiteeNotFound) {
		// 仓库存在但没有 Release 时 Gitee 返回空列表；仓库本身不存在才报错。
		if _, repoErr := s.defaultBranch(ctx); repoErr != nil {
			return giteeRelease{}, repoErr
		}
		return giteeRelease{}, nil
	}
	if err != nil {
		return giteeRelease{}, err
	}
	defer r.Body.Close()
	var releases []giteeRelease
	if err = json.NewDecoder(io.LimitReader(r.Body, 1024*1024)).Decode(&releases); err != nil {
		return giteeRelease{}, fmt.Errorf("Gitee 正式发版信息无效")
	}
	for _, release := range releases {
		if release.Tag == "" || len(release.Tag) > 1024 || release.Prerelease || (release.Draft != nil && *release.Draft) {
			continue
		}
		if release.Name == "" {
			release.Name = release.Tag
		}
		return release, nil
	}
	return giteeRelease{}, nil
}

func (s GiteeSource) tagCommit(ctx context.Context, tag string) (string, error) {
	commits, err := s.commits(ctx, tag, 1)
	if err != nil {
		return "", err
	}
	if len(commits) == 0 || !commitPattern.MatchString(commits[0].SHA) {
		return "", fmt.Errorf("Gitee 发版标签对应的提交无效")
	}
	return commits[0].SHA, nil
}

func (s GiteeSource) Download(ctx context.Context, sha, destination string) error {
	if !commitPattern.MatchString(sha) {
		return fmt.Errorf("目标提交无效")
	}
	r, err := s.download(ctx, s.archive()+"/"+sha+".tar.gz")
	if err != nil {
		return err
	}
	defer r.Body.Close()
	if err = extractSource(io.LimitReader(r.Body, 128*1024*1024), destination); err != nil {
		if errors.Is(err, errSourceNotArchive) {
			return fmt.Errorf("源码解包失败：Gitee 返回了网页而非源码归档（该仓库源码下载可能需要登录，如尚未通过 Gitee 开源审核）")
		}
		return fmt.Errorf("源码解包失败：%w", err)
	}
	return nil
}

func (s GiteeSource) download(ctx context.Context, endpoint string) (*http.Response, error) {
	r, err := http.NewRequestWithContext(ctx, "GET", endpoint, nil)
	if err != nil {
		return nil, err
	}
	r.Header.Set("Accept", "application/x-gzip")
	r.Header.Set("User-Agent", "Elysian-panel-updater")
	response, err := s.client().Do(r)
	if err != nil {
		return nil, fmt.Errorf("Gitee 源码下载不可达：%w", err)
	}
	if response.StatusCode != 200 {
		response.Body.Close()
		if response.StatusCode == 404 {
			return nil, errGiteeNotFound
		}
		return nil, fmt.Errorf("Gitee 源码下载失败：HTTP %d", response.StatusCode)
	}
	return response, nil
}
