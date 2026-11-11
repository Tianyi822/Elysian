package panel

import (
	"context"
	"crypto/sha256"
	"debug/elf"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

const PrecompiledDelivery = "precompiled/v1"
const maxReleaseArchive = int64(256 << 20)

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
	if err = os.MkdirAll(destination, 0700); err != nil {
		return err
	}
	archive, err := os.CreateTemp(filepath.Dir(destination), "release-*.tar.gz")
	if err != nil {
		return err
	}
	defer os.Remove(archive.Name())
	defer archive.Close()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, asset.URL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "Elysian-panel-updater")
	response, err := s.client().Do(req)
	if err != nil {
		return fmt.Errorf("GitHub 安装包下载失败：%w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("GitHub 安装包下载失败：HTTP %d", response.StatusCode)
	}
	digest := sha256.New()
	size, err := io.Copy(io.MultiWriter(archive, digest), io.LimitReader(response.Body, asset.Size+1))
	if err != nil || size != asset.Size || "sha256:"+hex.EncodeToString(digest.Sum(nil)) != asset.Digest {
		return fmt.Errorf("GitHub 安装包大小或 SHA256 校验失败，未切换版本")
	}
	if _, err = archive.Seek(0, io.SeekStart); err != nil {
		return err
	}
	if err = extractSource(archive, destination); err != nil {
		return fmt.Errorf("预编译安装包解包失败：%w", err)
	}
	return validateRelease(destination, sha)
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
		h.Store.appendLog(id, "GitHub 预编译安装包校验完成；服务器无需 Go／Bun 编译\n")
	}
	return candidate, err
}
