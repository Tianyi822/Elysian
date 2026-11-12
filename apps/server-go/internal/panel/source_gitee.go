package panel

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const GiteeRepository = "Chentyit/Elysian"
const releaseIndexSchema = "elysian-release-index/v1"

var errGiteeNotFound = errors.New("Gitee 版本或附件不存在")
var errGiteeNotReady = errors.New("Gitee 双架构预编译安装包尚未就绪，请等待流水线完成后重试")

type GiteeSource struct {
	Client *http.Client
	API    string
}

func (s GiteeSource) client() *http.Client {
	if s.Client != nil {
		return s.Client
	}
	return &http.Client{Timeout: 10 * time.Minute, CheckRedirect: func(r *http.Request, via []*http.Request) error {
		if len(via) > 5 || r.URL.Scheme != "https" || r.URL.User != nil || r.URL.Host != "gitee.com" && r.URL.Host != "foruda.gitee.com" {
			return errors.New("Gitee 安装包重定向地址不允许")
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
func (s GiteeSource) get(ctx context.Context, address string) (*http.Response, error) {
	r, err := http.NewRequestWithContext(ctx, "GET", address, nil)
	if err != nil {
		return nil, err
	}
	r.Header.Set("User-Agent", "Elysian-panel-updater")
	r.Header.Set("Accept", "application/json")
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
func (s GiteeSource) json(ctx context.Context, address string, target any, limit int64) error {
	r, err := s.get(ctx, address)
	if err != nil {
		return err
	}
	defer r.Body.Close()
	data, err := io.ReadAll(io.LimitReader(r.Body, limit+1))
	if err != nil {
		return err
	}
	if int64(len(data)) > limit {
		return errors.New("Gitee 元数据过大")
	}
	if err = json.Unmarshal(data, target); err != nil {
		return errors.New("Gitee 元数据无效")
	}
	return nil
}
func (s GiteeSource) endpoint(path string) string {
	return s.api() + "/repos/" + GiteeRepository + path
}

type giteeRelease struct {
	ID         int64  `json:"id"`
	Tag        string `json:"tag_name"`
	Name       string `json:"name"`
	Prerelease *bool  `json:"prerelease"`
}
type indexedArtifact struct {
	Name   string `json:"name"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}
type releaseIndex struct {
	Schema     string                     `json:"schema"`
	Repository string                     `json:"repository"`
	Commit     string                     `json:"commit"`
	OS         string                     `json:"os"`
	Artifacts  map[string]indexedArtifact `json:"artifacts"`
}

func (s GiteeSource) release(ctx context.Context, tag string) (giteeRelease, error) {
	var release giteeRelease
	err := s.json(ctx, s.endpoint("/releases/tags/"+url.PathEscape(tag)), &release, 2<<20)
	if err == nil && (release.ID <= 0 || release.Tag != tag || release.Prerelease == nil) {
		err = errors.New("Gitee 发版信息无效")
	}
	return release, err
}
func (s GiteeSource) tagCommit(ctx context.Context, tag string) (string, error) {
	// Gitee 的 tags API 直接返回剥离附注标签后的 commit；不把可变 target_commitish 当 SHA。
	for page := 1; page <= 100; page++ {
		var tags []struct {
			Name   string `json:"name"`
			Commit struct {
				SHA string `json:"sha"`
			} `json:"commit"`
		}
		if err := s.json(ctx, s.endpoint("/tags?per_page=100&page="+strconv.Itoa(page)), &tags, 4<<20); err != nil {
			return "", err
		}
		for _, entry := range tags {
			if entry.Name == tag {
				if !commitPattern.MatchString(entry.Commit.SHA) {
					return "", errors.New("Gitee 标签提交无效")
				}
				return entry.Commit.SHA, nil
			}
		}
		if len(tags) < 100 {
			break
		}
	}
	return "", errors.New("Gitee 发版标签不存在或超出查询范围")
}
func (s GiteeSource) artifact(ctx context.Context, sha string) (releaseAsset, error) {
	if !commitPattern.MatchString(sha) || runtime.GOOS != "linux" || runtime.GOARCH != "amd64" && runtime.GOARCH != "arm64" {
		return releaseAsset{}, errors.New("预编译更新仅支持 Linux amd64／arm64 和完整提交")
	}
	assets, index, err := s.ready(ctx, sha)
	if err != nil {
		return releaseAsset{}, err
	}
	item := index.Artifacts[runtime.GOARCH]
	asset := assets[item.Name]
	asset.Digest = "sha256:" + item.SHA256
	return asset, nil
}
func (s GiteeSource) ready(ctx context.Context, sha string) (map[string]releaseAsset, releaseIndex, error) {
	var index releaseIndex
	release, err := s.release(ctx, "build-"+sha)
	if err != nil {
		return nil, index, err
	}
	var entries []releaseAsset
	if err = s.json(ctx, s.endpoint(fmt.Sprintf("/releases/%d/attach_files?per_page=100", release.ID)), &entries, 2<<20); err != nil {
		return nil, index, err
	}
	assets := map[string]releaseAsset{}
	for _, entry := range entries {
		if _, exists := assets[entry.Name]; exists {
			return nil, index, errors.New("Gitee 安装包附件重名")
		}
		assets[entry.Name] = entry
	}
	marker, ok := assets["release-index.json"]
	base := "https://gitee.com/" + GiteeRepository + "/releases/download/build-" + sha + "/"
	if !ok {
		return nil, index, errGiteeNotReady
	}
	if marker.URL != base+marker.Name || marker.Size <= 0 || marker.Size > 64<<10 {
		return nil, index, errors.New("Gitee 发布索引地址或大小无效")
	}
	if err = s.json(ctx, marker.URL, &index, 64<<10); err != nil {
		return nil, index, err
	}
	if index.Schema != releaseIndexSchema || index.Repository != Repository || index.Commit != sha || index.OS != "linux" || len(index.Artifacts) != 2 {
		return nil, index, errors.New("Gitee 发布索引身份无效")
	}
	for _, arch := range []string{"amd64", "arm64"} {
		item := index.Artifacts[arch]
		name := "elysian-linux-" + arch + ".tar.gz"
		asset, found := assets[name]
		checksum, hasChecksum := assets[name+".sha256"]
		if !found || !hasChecksum {
			return nil, index, errGiteeNotReady
		}
		if item.Name != name || !validReleaseDigest("sha256:"+item.SHA256) || item.Size <= 0 || item.Size > 100000000 || asset.Size != item.Size || asset.URL != base+name || checksum.URL != base+name+".sha256" || checksum.Size <= 0 || checksum.Size > 1024 {
			return nil, index, errors.New("Gitee 安装包大小、地址或摘要无效")
		}
	}
	resolved, err := s.tagCommit(ctx, "build-"+sha)
	if err != nil {
		return nil, index, err
	}
	if resolved != sha {
		return nil, index, errors.New("Gitee 固定构建标签与提交不一致")
	}
	return assets, index, nil
}
func (s GiteeSource) VerifyArtifact(ctx context.Context, sha string) error {
	_, err := s.artifact(ctx, sha)
	return err
}
func (s GiteeSource) Check(ctx context.Context, channel UpdateChannel) (Update, error) {
	channel = normalizeChannel(channel)
	u := Update{Repository: Repository, CurrentCommit: Commit, Channel: channel, Source: SourceGitee}
	if !validChannel(channel) {
		return u, errors.New("更新策略无效")
	}
	// Gitee latest 是最后更新的 Release，可能是预发布；按显式倒序分页筛选。
	for page := 1; page <= 100; page++ {
		var releases []giteeRelease
		if err := s.json(ctx, s.endpoint("/releases?direction=desc&per_page=100&page="+strconv.Itoa(page)), &releases, 4<<20); err != nil {
			return u, err
		}
		for _, release := range releases {
			if channel == ChannelRelease {
				if release.Prerelease == nil || *release.Prerelease || !strings.HasPrefix(release.Tag, "v") {
					continue
				}
				sha, err := s.tagCommit(ctx, release.Tag)
				if err != nil {
					return u, err
				}
				if _, _, err = s.ready(ctx, sha); err != nil {
					return u, err
				}
				u.TargetCommit = sha
				u.ReleaseTag = release.Tag
				u.Message = release.Name
			} else {
				if !buildTagPattern.MatchString(release.Tag) {
					continue
				}
				sha := strings.TrimPrefix(release.Tag, "build-")
				if _, _, err := s.ready(ctx, sha); err != nil {
					if errors.Is(err, errGiteeNotReady) {
						continue
					}
					return u, err
				}
				u.TargetCommit = sha
			}
			u.Available = u.TargetCommit != Commit
			return u, nil
		}
		if len(releases) < 100 {
			break
		}
	}
	if channel == ChannelRelease {
		u.Message = "上游仓库暂无正式发版"
		return u, nil
	}
	return u, errors.New("暂无已发布的 Gitee 预编译安装包；仅 v* 标签触发构建")
}
func (s GiteeSource) History(ctx context.Context, channel UpdateChannel, limit int) ([]CommitLog, error) {
	u, err := s.Check(ctx, channel)
	if err != nil {
		return nil, err
	}
	if u.TargetCommit == "" {
		return []CommitLog{}, nil
	}
	if limit < 1 || limit > 100 {
		limit = 30
	}
	var rows []struct {
		SHA    string `json:"sha"`
		Commit struct {
			Message string `json:"message"`
			Author  struct {
				Date time.Time `json:"date"`
			} `json:"author"`
		} `json:"commit"`
	}
	err = s.json(ctx, s.endpoint("/commits?sha="+u.TargetCommit+"&per_page="+strconv.Itoa(limit)), &rows, 4<<20)
	if err != nil {
		return nil, err
	}
	result := make([]CommitLog, 0, len(rows))
	for _, row := range rows {
		if !commitPattern.MatchString(row.SHA) {
			return nil, errors.New("Gitee 提交列表无效")
		}
		result = append(result, CommitLog{SHA: row.SHA, Message: firstLine(row.Commit.Message), Time: row.Commit.Author.Date})
	}
	return result, nil
}
func (s GiteeSource) Download(ctx context.Context, sha, destination string) error {
	asset, err := s.artifact(ctx, sha)
	if err != nil {
		return err
	}
	return downloadRelease(ctx, s.client(), "Gitee", asset, sha, destination)
}
