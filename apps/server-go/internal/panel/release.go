package panel

import (
	"context"
	"crypto/sha256"
	"debug/elf"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const PrecompiledDelivery = "precompiled/v1"
const maxReleaseArchive = int64(256 << 20)

const releaseDownloadTimeout = 30 * time.Minute
const releaseDownloadIdleTimeout = 2 * time.Minute

var errReleaseDownloadIdle = errors.New("安装包下载长时间未收到数据")

// 固定清单同时用于摘要验证和版本目录安装，卸载工具随 current 一起更新。
var releaseScripts = []string{"install.sh", "install-release.sh", "uninstall.sh", "tui.sh", "platform-lifecycle.sh", "docker-apt.sh", "install-platform.mjs", "release-download.py", "README-deploy.md"}

func releasePayload() []string {
	files := []string{"elysian", "platform-helper"}
	for _, script := range releaseScripts {
		files = append(files, "scripts/"+script)
	}
	return files
}

type releaseManifest struct {
	Schema     string            `json:"schema"`
	Repository string            `json:"repository"`
	Commit     string            `json:"commit"`
	OS         string            `json:"os"`
	Arch       string            `json:"arch"`
	Files      map[string]string `json:"files"`
}

type releaseAsset struct {
	Name   string `json:"name"`
	URL    string `json:"browser_download_url"`
	Digest string `json:"digest"`
	Size   int64  `json:"size"`
	State  string `json:"state"`
}

func (s GitHubSource) artifact(ctx context.Context, sha string) (releaseAsset, error) {
	var empty releaseAsset
	if !commitPattern.MatchString(sha) || runtime.GOOS != "linux" || (runtime.GOARCH != "amd64" && runtime.GOARCH != "arm64") {
		return empty, fmt.Errorf("预编译更新仅支持 Linux amd64／arm64 和完整提交")
	}
	tag := "build-" + sha
	response, err := s.get(ctx, s.api()+"/repos/"+Repository+"/releases/tags/"+tag)
	if err != nil {
		return empty, fmt.Errorf("目标提交的 GitHub 预编译安装包尚未就绪或不可达，请稍后重新检查：%w", err)
	}
	defer response.Body.Close()
	var release struct {
		Tag    string         `json:"tag_name"`
		Draft  bool           `json:"draft"`
		Assets []releaseAsset `json:"assets"`
	}
	if err = json.NewDecoder(io.LimitReader(response.Body, 2<<20)).Decode(&release); err != nil || release.Tag != tag || release.Draft {
		return empty, fmt.Errorf("GitHub 预编译版本信息无效")
	}
	name := "elysian-linux-" + runtime.GOARCH + ".tar.gz"
	for _, asset := range release.Assets {
		if asset.Name != name {
			continue
		}
		expected := "https://github.com/" + Repository + "/releases/download/" + tag + "/" + name
		if asset.URL != expected || asset.State != "uploaded" || asset.Size <= 0 || asset.Size > maxReleaseArchive || !validReleaseDigest(asset.Digest) {
			return empty, fmt.Errorf("GitHub 安装包地址、大小或 SHA256 摘要无效")
		}
		return asset, nil
	}
	return empty, fmt.Errorf("目标提交尚未发布 %s 安装包，请等待 GitHub Actions 完成后重新检查", runtime.GOARCH)
}
func validReleaseDigest(value string) bool {
	if !strings.HasPrefix(value, "sha256:") {
		return false
	}
	digest, err := hex.DecodeString(strings.TrimPrefix(value, "sha256:"))
	return err == nil && len(digest) == sha256.Size && value == strings.ToLower(value)
}
func (s GitHubSource) VerifyArtifact(ctx context.Context, sha string) error {
	_, err := s.artifact(ctx, sha)
	return err
}

// Download 只下载固定 SHA 的预编译包，不回退为服务器源码构建。
func (s GitHubSource) Download(ctx context.Context, sha, destination string) error {
	asset, err := s.artifact(ctx, sha)
	if err != nil {
		return err
	}
	return downloadRelease(ctx, s.client(), "GitHub", asset, sha, destination)
}

func downloadRelease(ctx context.Context, client *http.Client, source string, asset releaseAsset, sha, destination string) error {
	ctx, cancelBudget := context.WithTimeout(ctx, releaseDownloadTimeout)
	defer cancelBudget()
	ctx, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)
	idle := time.AfterFunc(releaseDownloadIdleTimeout, func() { cancel(errReleaseDownloadIdle) })
	defer idle.Stop()
	// 元数据请求的客户端超时不应截断仍在接收数据的安装包；传输使用独立总预算及空闲保护。
	downloadClient := *client
	downloadClient.Timeout = 0
	if err := os.MkdirAll(destination, 0700); err != nil {
		return err
	}
	archive, err := os.CreateTemp(filepath.Dir(destination), "release-*.tar.gz")
	if err != nil {
		return err
	}
	defer os.Remove(archive.Name())
	defer archive.Close()
	progress := &releaseProgressWriter{value: DownloadProgress{FileName: asset.Name, TotalBytes: asset.Size}, started: time.Now()}
	progress.report, _ = ctx.Value(downloadProgressKey{}).(downloadReporter)
	if err = progress.publish("downloading", true); err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, asset.URL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "Elysian-panel-updater")
	response, err := downloadClient.Do(req)
	if err != nil {
		if cause := context.Cause(ctx); cause != nil {
			return releaseDownloadError(source, cause, 0, asset.Size)
		}
		return fmt.Errorf("%s 安装包下载失败：%w", source, err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("%s 安装包下载失败：HTTP %d", source, response.StatusCode)
	}
	digest := sha256.New()
	progress.writer = io.MultiWriter(archive, digest)
	size, copyErr := io.Copy(progress, io.LimitReader(downloadActivityReader{response.Body, idle}, asset.Size+1))
	idle.Stop()
	if err = progress.publish("downloading", true); err != nil {
		return err
	}
	if copyErr != nil {
		cause := context.Cause(ctx)
		if cause == nil {
			cause = copyErr
		}
		return releaseDownloadError(source, cause, size, asset.Size)
	}
	if size != asset.Size {
		return fmt.Errorf("%s 安装包大小不符（已接收 %d / %d 字节），未切换版本", source, size, asset.Size)
	}
	if err = progress.publish("verifying", true); err != nil {
		return err
	}
	if "sha256:"+hex.EncodeToString(digest.Sum(nil)) != asset.Digest {
		return fmt.Errorf("%s 安装包 SHA256 校验失败（实际 %s，预期 %s），未切换版本", source, hex.EncodeToString(digest.Sum(nil)), strings.TrimPrefix(asset.Digest, "sha256:"))
	}
	if _, err = archive.Seek(0, io.SeekStart); err != nil {
		return err
	}
	if err = extractSource(archive, destination); err != nil {
		return fmt.Errorf("预编译安装包解包失败：%w", err)
	}
	if err = validateRelease(destination, sha); err != nil {
		return err
	}
	return progress.publish("ready", true)
}

func releaseDownloadError(source string, cause error, completed, total int64) error {
	reason := "安装包下载中断或本地写入失败"
	if errors.Is(cause, errReleaseDownloadIdle) {
		reason = "安装包下载连续 2 分钟未收到数据"
	} else if errors.Is(cause, context.DeadlineExceeded) {
		reason = "安装包下载超时"
	} else if errors.Is(cause, context.Canceled) {
		reason = "安装包下载已中止"
	}
	return fmt.Errorf("%s %s（已接收 %d / %d 字节），未切换版本", source, reason, completed, total)
}

func validateRelease(directory, sha string) error {
	manifestFile := filepath.Join(directory, "release.json")
	info, err := os.Lstat(manifestFile)
	if err != nil || !info.Mode().IsRegular() || info.Size() > 64<<10 {
		return fmt.Errorf("安装包缺少有效发布清单")
	}
	data, err := os.ReadFile(manifestFile)
	if err != nil || len(data) > 64<<10 {
		return fmt.Errorf("安装包缺少有效发布清单")
	}
	var manifest releaseManifest
	if err = json.Unmarshal(data, &manifest); err != nil || manifest.Schema != "elysian-release/v1" || manifest.Repository != Repository || manifest.Commit != sha || manifest.OS != "linux" || manifest.Arch != runtime.GOARCH {
		return fmt.Errorf("安装包提交、平台或架构与已检查目标不一致")
	}
	machine := elf.EM_X86_64
	if runtime.GOARCH == "arm64" {
		machine = elf.EM_AARCH64
	}
	for _, name := range releasePayload() {
		expected := manifest.Files[name]
		if !validReleaseDigest("sha256:" + expected) {
			return fmt.Errorf("安装包文件摘要缺失：%s", name)
		}
		file := filepath.Join(directory, name)
		info, e := os.Lstat(file)
		if e != nil || !info.Mode().IsRegular() {
			return fmt.Errorf("安装包可执行文件无效：%s", name)
		}
		f, e := os.Open(file)
		if e != nil {
			return e
		}
		hash := sha256.New()
		_, e = io.Copy(hash, f)
		closeErr := f.Close()
		if e != nil || closeErr != nil || hex.EncodeToString(hash.Sum(nil)) != expected {
			return fmt.Errorf("安装包文件 SHA256 校验失败：%s", name)
		}
		if strings.HasPrefix(name, "scripts/") {
			continue
		}
		executable, e := elf.Open(file)
		if e != nil {
			return fmt.Errorf("安装包不是有效 Linux 可执行文件：%s", name)
		}
		valid := executable.Machine == machine && executable.Class == elf.ELFCLASS64 && (executable.Type == elf.ET_EXEC || executable.Type == elf.ET_DYN)
		executable.Close()
		if !valid {
			return fmt.Errorf("安装包可执行文件架构错误：%s", name)
		}
	}
	return nil
}

func stageRelease(directory, install, sha, id string) (string, error) {
	if err := validateRelease(directory, sha); err != nil {
		return "", err
	}
	release := filepath.Join(install, "releases", sha+"-"+id)
	if err := os.MkdirAll(release, 0755); err != nil {
		return "", err
	}
	for _, name := range append(releasePayload(), "release.json") {
		mode := os.FileMode(0755)
		if name == "release.json" || strings.HasPrefix(name, "scripts/") {
			mode = 0644
		}
		if err := os.MkdirAll(filepath.Dir(filepath.Join(release, name)), 0755); err != nil {
			return "", err
		}
		if err := copyRegular(filepath.Join(directory, name), filepath.Join(release, name), mode); err != nil {
			return "", err
		}
	}
	return filepath.Join(release, "elysian"), nil
}
func (h SystemHost) PrepareRelease(ctx context.Context, directory, sha, id string) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	candidate, err := stageRelease(directory, InstallRoot, sha, id)
	if err == nil {
		h.Store.appendLog(id, "预编译安装包校验完成；服务器无需 Go／Bun 编译\n")
	}
	return candidate, err
}
