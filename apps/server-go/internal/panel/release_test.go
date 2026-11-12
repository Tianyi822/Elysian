package panel

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"elysian/server/internal/config"
)

type releaseTransport struct{ address *url.URL }

func (r releaseTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	copy := req.Clone(req.Context())
	if copy.URL.Host == "github.com" {
		copy.URL.Scheme = r.address.Scheme
		copy.URL.Host = r.address.Host
	}
	return http.DefaultTransport.RoundTrip(copy)
}
func releaseArchive(t *testing.T, sha, arch string, change func(map[string][]byte)) []byte {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	binary, err := os.ReadFile(executable)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(binary)
	manifest := releaseManifest{Schema: "elysian-release/v1", Repository: Repository, Commit: sha, OS: "linux", Arch: arch, Files: map[string]string{"elysian": hex.EncodeToString(sum[:]), "platform-helper": hex.EncodeToString(sum[:])}}
	script := []byte("#!/usr/bin/env bash\nexit 0\n")
	scriptSum := sha256.Sum256(script)
	for _, name := range releaseScripts {
		manifest.Files["scripts/"+name] = hex.EncodeToString(scriptSum[:])
	}
	raw, _ := json.Marshal(manifest)
	files := map[string][]byte{"elysian": binary, "platform-helper": binary, "release.json": raw}
	for _, name := range releaseScripts {
		files["scripts/"+name] = script
	}
	if change != nil {
		change(files)
	}
	var output bytes.Buffer
	gzipWriter := gzip.NewWriter(&output)
	writer := tar.NewWriter(gzipWriter)
	for name, body := range files {
		if err := writer.WriteHeader(&tar.Header{Name: "elysian-linux-" + runtime.GOARCH + "/" + name, Mode: 0755, Typeflag: tar.TypeReg, Size: int64(len(body))}); err != nil {
			t.Fatal(err)
		}
		if _, err := writer.Write(body); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gzipWriter.Close(); err != nil {
		t.Fatal(err)
	}
	return output.Bytes()
}
func releaseSourceFixture(t *testing.T, sha string, body []byte, change func(*releaseAsset)) (GitHubSource, *[]string) {
	t.Helper()
	requests := []string{}
	sum := sha256.Sum256(body)
	asset := releaseAsset{Name: "elysian-linux-" + runtime.GOARCH + ".tar.gz", URL: "https://github.com/" + Repository + "/releases/download/build-" + sha + "/elysian-linux-" + runtime.GOARCH + ".tar.gz", Digest: "sha256:" + hex.EncodeToString(sum[:]), Size: int64(len(body)), State: "uploaded"}
	if change != nil {
		change(&asset)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests = append(requests, r.URL.Path)
		if strings.HasPrefix(r.URL.Path, "/repos/") {
			json.NewEncoder(w).Encode(map[string]any{"tag_name": "build-" + sha, "draft": false, "assets": []releaseAsset{asset}})
		} else {
			w.Write(body)
		}
	}))
	t.Cleanup(server.Close)
	address, _ := url.Parse(server.URL)
	return GitHubSource{API: server.URL, Client: &http.Client{Transport: releaseTransport{address}}}, &requests
}
func TestPrecompiledDownloadVerifiesAndStagesPinnedRelease(t *testing.T) {
	sha := strings.Repeat("a", 40)
	source, requests := releaseSourceFixture(t, sha, releaseArchive(t, sha, runtime.GOARCH, nil), nil)
	directory := filepath.Join(t.TempDir(), "download")
	var progress []DownloadProgress
	ctx := withDownloadProgress(context.Background(), func(value DownloadProgress) error {
		progress = append(progress, value)
		return nil
	})
	if err := source.Download(ctx, sha, directory); err != nil {
		t.Fatal(err)
	}
	if len(progress) < 4 || progress[0].Status != "downloading" || progress[0].CompletedBytes != 0 || progress[len(progress)-2].Status != "verifying" || progress[len(progress)-1].Status != "ready" {
		t.Fatalf("下载、校验与就绪状态未依次上报：%+v", progress)
	}
	previous := int64(0)
	for _, value := range progress {
		if value.CompletedBytes < previous || value.CompletedBytes > value.TotalBytes || value.TotalBytes <= 0 || value.UpdatedAt.IsZero() {
			t.Fatalf("下载字节不是实测单调进度：%+v", progress)
		}
		previous = value.CompletedBytes
	}
	binary, err := stageRelease(directory, t.TempDir(), sha, "task")
	if err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(binary); err != nil || info.Mode().Perm() != 0755 {
		t.Fatalf("未准备可执行版本：%v %v", info, err)
	}
	if len(*requests) != 2 || !strings.Contains((*requests)[0], "/releases/tags/build-"+sha) || !strings.Contains((*requests)[1], "/releases/download/build-"+sha+"/") {
		t.Fatalf("下载未锁定完整 SHA：%v", *requests)
	}
}

func TestReleaseDownloadHasIndependentBudget(t *testing.T) {
	sha := strings.Repeat("d", 40)
	body := releaseArchive(t, sha, runtime.GOARCH, nil)
	sum := sha256.Sum256(body)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write(body) }))
	defer server.Close()
	asset := releaseAsset{Name: "elysian-linux-" + runtime.GOARCH + ".tar.gz", URL: server.URL, Size: int64(len(body)), Digest: "sha256:" + hex.EncodeToString(sum[:])}
	// 元数据客户端的短超时不能截断安装包；安装包独立总预算为 30 分钟。
	client := &http.Client{Timeout: time.Nanosecond}
	if releaseDownloadTimeout != 30*time.Minute || releaseDownloadIdleTimeout != 2*time.Minute {
		t.Fatal("安装包总预算或无数据保护不符")
	}
	if err := downloadRelease(context.Background(), client, "GitHub", asset, sha, filepath.Join(t.TempDir(), "download")); err != nil {
		t.Fatal(err)
	}
	if client.Timeout != time.Nanosecond {
		t.Fatal("下载修改了共享元数据客户端")
	}
}
func TestPrecompiledDownloadRejectsDigestPlatformCommitAndFiles(t *testing.T) {
	sha := strings.Repeat("b", 40)
	for _, name := range []string{"digest", "commit", "arch", "file", "foreign-url", "size", "html", "manifest", "elf"} {
		t.Run(name, func(t *testing.T) {
			arch, commit := runtime.GOARCH, sha
			if name == "arch" {
				arch = "unsupported"
			}
			if name == "commit" {
				commit = strings.Repeat("c", 40)
			}
			body := releaseArchive(t, commit, arch, func(files map[string][]byte) {
				if name == "file" {
					files["elysian"] = []byte("replaced")
				}
				if name == "manifest" {
					delete(files, "release.json")
				}
				if name == "elf" {
					files["elysian"] = []byte("not an ELF")
					var manifest releaseManifest
					_ = json.Unmarshal(files["release.json"], &manifest)
					sum := sha256.Sum256(files["elysian"])
					manifest.Files["elysian"] = hex.EncodeToString(sum[:])
					files["release.json"], _ = json.Marshal(manifest)
				}
			})
			if name == "html" {
				body = []byte("<html>blocked</html>")
			}
			source, requests := releaseSourceFixture(t, sha, body, func(asset *releaseAsset) {
				if name == "digest" {
					asset.Digest = "sha256:" + strings.Repeat("0", 64)
				}
				if name == "foreign-url" {
					asset.URL = "https://example.com/binary"
				}
				if name == "size" {
					asset.Size++
				}
			})
			if err := source.Download(context.Background(), sha, filepath.Join(t.TempDir(), "download")); err == nil {
				t.Fatal("无效发布包被接受")
			}
			if name == "foreign-url" && len(*requests) != 1 {
				t.Fatal("下载了非 GitHub 文件")
			}
		})
	}
}

type verifyingSource struct {
	channelSource
	verificationError error
}

func (s *verifyingSource) VerifyArtifact(context.Context, string) error { return s.verificationError }

func TestUpdateCheckRequiresPublishedArtifact(t *testing.T) {
	w, r, h := setupWorker(t, "update")
	source := &verifyingSource{verificationError: errors.New("安装包尚未就绪")}
	m := Manager{Store: w.Store, Host: h, Source: source, Ports: r.OldPorts, Enabled: true}
	if _, err := m.CheckFrom(context.Background(), ChannelCommit, SourceGitHub); err == nil {
		t.Fatal("产物未就绪的提交不应成为可更新目标")
	}
	if _, err := os.Stat(w.Store.updateCheckPath(ChannelCommit, SourceGitHub)); !os.IsNotExist(err) {
		t.Fatal("未就绪目标被保存为已检查结果")
	}
	source.verificationError = nil
	if _, err := m.CheckFrom(context.Background(), ChannelCommit, SourceGitHub); err != nil {
		t.Fatal(err)
	}
}

func TestPrecompiledWorkerPreservesTransactionWithoutResourceStops(t *testing.T) {
	w, r, h := resourceFixture(t)
	r.UpdateDelivery = PrecompiledDelivery
	r.ResourcePlan = &ResourcePlan{PreflightID: strings.Repeat("e", 32), Targets: []string{}}
	r.ResourceTargets = nil
	h.available = 1202 << 20
	h.candidate = filepath.Join(w.install(), "releases", "new", "elysian")
	if err := os.MkdirAll(filepath.Dir(h.candidate), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(h.candidate, []byte("new"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := w.Store.save(r); err != nil {
		t.Fatal(err)
	}
	if err := w.Run(context.Background(), r.ID); err != nil {
		t.Fatal(err)
	}
	got, err := w.Store.read(r.ID)
	if err != nil || got.State != "succeeded" || h.stops != 1 || len(h.actions) != 0 {
		t.Fatalf("预编译事务未成功或额外停了业务：%+v %v stops=%d actions=%v", got, err, h.stops, h.actions)
	}
	if credential, err := os.ReadFile(filepath.Join(w.Store.Root, "config", "credentials")); err != nil || string(credential) != "keep-password" {
		t.Fatal("更新未保留凭据")
	}
}

func TestPrecompiledPreflightRejectsLegacyStopAuthorizationAndLowMemory(t *testing.T) {
	w, r, h := resourceFixture(t)
	m := Manager{Store: w.Store, Host: h, Ports: r.OldPorts, Enabled: true}
	input := submitInput{Source: SourceGitHub, Channel: ChannelRelease, ReleaseTag: "v1.2.0", TargetCommit: r.TargetCommit}
	if err := config.AtomicJSON(w.Store.updateCheckPath(input.Channel, input.Source), Update{Repository: Repository, Source: input.Source, Channel: input.Channel, ReleaseTag: input.ReleaseTag, Available: true, TargetCommit: input.TargetCommit}); err != nil {
		t.Fatal(err)
	}
	h.available = 64 << 20
	preview, err := m.PreflightUpdate(context.Background(), input)
	if err != nil || preview.BlockedReason == "" || preview.NeedsRelease {
		t.Fatalf("资源不足应拒绝并保留业务：%+v %v", preview, err)
	}
	input.ResourcePlan = &ResourcePlan{PreflightID: preview.ID, Targets: []string{}}
	if _, err := m.resourceTargets(input); err == nil {
		t.Fatal("受阻预检被接受")
	}
	input.ResourcePlan = nil
	h.available = 1202 << 20
	preview, err = m.PreflightUpdate(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	var record resourcePreflightRecord
	data, _ := os.ReadFile(w.Store.resourcePreflightPath(preview.ID))
	if err := json.Unmarshal(data, &record); err != nil {
		t.Fatal(err)
	}
	record.Delivery = ""
	if err := config.AtomicJSON(w.Store.resourcePreflightPath(preview.ID), record); err != nil {
		t.Fatal(err)
	}
	input.ResourcePlan = &ResourcePlan{PreflightID: preview.ID, Targets: []string{}}
	if _, err := m.resourceTargets(input); err == nil {
		t.Fatal("旧构建授权被用于预编译更新")
	}
}
func TestPrecompiledResourcesAllowTwoGiBHostWithoutStoppingBusiness(t *testing.T) {
	worker, record, host := resourceFixture(t)
	record.UpdateDelivery = PrecompiledDelivery
	record.ResourcePlan = &ResourcePlan{PreflightID: strings.Repeat("e", 32), Targets: []string{}}
	record.ResourceTargets = nil
	host.available = 1202 << 20
	if err := worker.checkBuildResources(context.Background(), &record); err != nil {
		t.Fatal(err)
	}
	if err := worker.prepareBuildResources(context.Background(), &record); err != nil {
		t.Fatal(err)
	}
	if host.stops != 0 || len(host.actions) != 0 {
		t.Fatal("预编译准备停止了业务")
	}
	host.available = 64 << 20
	if err := worker.prepareBuildResources(context.Background(), &record); err == nil {
		t.Fatal("内存极低应拒绝并保留业务")
	}
	if host.stops != 0 || len(host.actions) != 0 {
		t.Fatal("资源不足时扩大了停机范围")
	}
}
