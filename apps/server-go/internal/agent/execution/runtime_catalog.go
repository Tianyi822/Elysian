package execution

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"elysian/server/internal/agent/execution/config"
)

// RuntimeEnvironment is frozen before requesting administrator consent. Image
// is a repository digest; Platform is fixed even when the digest is an index.
type RuntimeEnvironment struct {
	Profile          config.Profile `json:"profile"`
	Version          string         `json:"version"`
	Platform         string         `json:"platform"`
	RequiresDownload bool           `json:"requiresDownload"`
}

type RuntimeProgress struct {
	State   string `json:"state"`
	Current int64  `json:"current"`
	Total   int64  `json:"total"`
}

type runtimePreset struct {
	repository, version, runtime, command string
}

// These are exact official release tags, never moving major/latest aliases.
var runtimePresets = map[string]runtimePreset{
	"bash":   {"docker.io/library/bash", "5.2.37", "bash", "bash"},
	"python": {"docker.io/library/python", "3.12.9-slim-bookworm", "python", "python3"},
	"node":   {"docker.io/library/node", "22.14.0-bookworm-slim", "node", "node"},
}

func runtimeProfile(runtime, image, command string) config.Profile {
	return config.Profile{ID: "runtime-" + runtime, Revision: 1, Enabled: true, Name: runtime + " 运行环境", Image: image, Runtime: runtime, Command: []string{command}, TimeoutSeconds: 300, CPUMillis: 500, MemoryBytes: 256 << 20, PIDs: 64}
}

func MCPRuntimeProfile(image string) config.Profile {
	p := runtimeProfile("bash", image, "bash")
	p.ID, p.Name = "runtime-mcp", "MCP 容器运行环境"
	return p
}

func (e *Executor) runtimePlatform(ctx context.Context) (string, error) {
	var info struct{ OSType, Architecture string }
	if err := e.call(ctx, http.MethodGet, "/info", nil, &info); err != nil {
		return "", err
	}
	arch := info.Architecture
	switch arch {
	case "x86_64":
		arch = "amd64"
	case "aarch64":
		arch = "arm64"
	}
	if info.OSType != "linux" || (arch != "amd64" && arch != "arm64") {
		return "", problem(400, "execution-runtime-platform", "官方运行环境仅支持 Linux amd64 或 arm64")
	}
	return "linux/" + arch, nil
}

type runtimeImage struct {
	OS           string `json:"Os"`
	Architecture string
	RepoDigests  []string
	RepoTags     []string
	Config       struct{ Volumes map[string]any }
}

func (e *Executor) inspectRuntimeImage(ctx context.Context, image, platform string) (*runtimeImage, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	resp, err := e.request(ctx, http.MethodGet, "/images/"+url.PathEscape(image)+"/json", nil, "")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil, nil
	}
	if resp.StatusCode != http.StatusOK {
		return nil, engineError()
	}
	var found runtimeImage
	raw, err := io.ReadAll(io.LimitReader(resp.Body, (1<<20)+1))
	if err != nil || len(raw) > 1<<20 || json.Unmarshal(raw, &found) != nil {
		return nil, protocolError()
	}
	if found.OS+"/"+found.Architecture != platform || len(found.Config.Volumes) > 0 {
		return nil, problem(400, "execution-runtime-image", "运行环境镜像架构不符或声明了额外可写卷")
	}
	if strings.Contains(image, "@") {
		matched := false
		for _, digest := range found.RepoDigests {
			if canonicalRuntimeImage(digest) == canonicalRuntimeImage(image) {
				matched = true
			}
		}
		if !matched {
			return nil, problem(409, "execution-runtime-image", "本机镜像没有匹配申请的仓库摘要")
		}
	}
	return &found, nil
}

func canonicalRuntimeImage(image string) string {
	if strings.HasPrefix(image, "docker.io/library/") {
		return image
	}
	if strings.HasPrefix(image, "library/") {
		return "docker.io/" + image
	}
	if !strings.Contains(strings.Split(image, "@")[0], "/") {
		return "docker.io/library/" + image
	}
	return image
}

func (e *Executor) distributionDigest(ctx context.Context, image, platform string) (string, error) {
	var result struct {
		Descriptor struct{ Digest string }
		Platforms  []struct{ Architecture, OS, Variant string }
	}
	if err := e.call(ctx, http.MethodGet, "/distribution/"+url.PathEscape(image)+"/json", nil, &result); err != nil {
		return "", err
	}
	if !digestImage.MatchString("repository@" + result.Descriptor.Digest) {
		return "", protocolError()
	}
	for _, p := range result.Platforms {
		if p.OS+"/"+p.Architecture == platform && (p.Variant == "" || p.Architecture == "arm64" && p.Variant == "v8") {
			return result.Descriptor.Digest, nil
		}
	}
	return "", problem(400, "execution-runtime-platform", "运行环境没有当前 Docker 主机架构的官方镜像")
}

// ResolveRuntime reads local Docker metadata first and then registry metadata.
// It never pulls, starts a container, or changes persisted configuration.
func (e *Executor) ResolveRuntime(ctx context.Context, runtime string) (RuntimeEnvironment, error) {
	var result RuntimeEnvironment
	preset, ok := runtimePresets[runtime]
	if !ok {
		return result, problem(400, "execution-runtime", "运行环境仅支持 Bash、Python 或 Node")
	}
	platform, err := e.runtimePlatform(ctx)
	if err != nil {
		return result, err
	}
	tag := preset.repository + ":" + preset.version
	local, err := e.inspectRuntimeImage(ctx, tag, platform)
	if err != nil {
		return result, err
	}
	image := ""
	if local != nil {
		for _, candidate := range local.RepoDigests {
			candidate = canonicalRuntimeImage(candidate)
			if strings.HasPrefix(candidate, preset.repository+"@") && digestImage.MatchString(candidate) {
				image = candidate
				break
			}
		}
	}
	if image == "" {
		digest, err := e.distributionDigest(ctx, tag, platform)
		if err != nil {
			return result, err
		}
		image = preset.repository + "@" + digest
	}
	result = RuntimeEnvironment{Profile: runtimeProfile(runtime, image, preset.command), Version: preset.version, Platform: platform}
	result.Profile.Name = runtime + " " + preset.version
	installed, err := e.inspectRuntimeImage(ctx, image, platform)
	result.RequiresDownload = installed == nil
	return result, err
}

// ResolveMCPRuntime only accepts the exact repository digest declared by the
// server. It uses the same read-only preflight as the official presets.
func (e *Executor) ResolveMCPRuntime(ctx context.Context, image string) (RuntimeEnvironment, error) {
	var result RuntimeEnvironment
	if !digestImage.MatchString(image) {
		return result, problem(400, "execution-runtime-image", "MCP 容器镜像必须固定仓库名和完整摘要")
	}
	platform, err := e.runtimePlatform(ctx)
	if err != nil {
		return result, err
	}
	installed, err := e.inspectRuntimeImage(ctx, image, platform)
	if err != nil {
		return result, err
	}
	if installed == nil {
		digest, err := e.distributionDigest(ctx, image, platform)
		if err != nil {
			return result, err
		}
		if !strings.HasSuffix(image, "@"+digest) {
			return result, problem(409, "execution-runtime-image", "MCP 镜像仓库返回的摘要与申请不符")
		}
	}
	return RuntimeEnvironment{Profile: MCPRuntimeProfile(image), Version: "configured", Platform: platform, RequiresDownload: installed == nil}, nil
}

// InspectRuntime verifies an already approved digest and platform using only
// local image metadata. It never resolves tags, contacts a registry or pulls.
// A false result is not evidence that an earlier interrupted pull has stopped.
func (e *Executor) InspectRuntime(ctx context.Context, env RuntimeEnvironment) (bool, error) {
	if err := validateProfile(env.Profile); err != nil {
		return false, err
	}
	if env.Platform != "linux/amd64" && env.Platform != "linux/arm64" {
		return false, problem(400, "execution-runtime-platform", "运行环境架构无效")
	}
	installed, err := e.inspectRuntimeImage(ctx, env.Profile.Image, env.Platform)
	return installed != nil, err
}

// EnsureRuntime is invoked only after the harness durably approves the exact
// environment. The harness owns the goroutine, cancellation and progress log.
// An interrupted stream is unknown; callers must inspect before any retry.
func (e *Executor) EnsureRuntime(ctx context.Context, env RuntimeEnvironment, progress func(RuntimeProgress) error) error {
	if err := validateProfile(env.Profile); err != nil {
		return err
	}
	if env.Platform != "linux/amd64" && env.Platform != "linux/arm64" {
		return problem(400, "execution-runtime-platform", "运行环境架构无效")
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	installed, err := e.inspectRuntimeImage(ctx, env.Profile.Image, env.Platform)
	if err != nil {
		return err
	}
	report := func(p RuntimeProgress) error {
		if progress != nil {
			return progress(p)
		}
		return nil
	}
	if installed != nil {
		return report(RuntimeProgress{State: "ready"})
	}
	if !env.RequiresDownload {
		return problem(409, "execution-runtime-missing", "批准的本机镜像已消失，需要重新申请下载")
	}
	if err := report(RuntimeProgress{State: "pulling"}); err != nil {
		return err
	}
	resp, err := e.request(ctx, http.MethodPost, "/images/create?"+url.Values{"fromImage": {env.Profile.Image}, "platform": {env.Platform}}.Encode(), nil, "")
	if err != nil {
		return &Error{Status: 503, Code: "execution-image-pull-unknown", Message: "运行镜像下载结果未确认，须回读镜像状态后重试", OutcomeUnknown: true}
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return problem(502, "execution-image-pull", "运行镜像下载失败")
	}
	limited := &io.LimitedReader{R: resp.Body, N: 16<<20 + 1}
	scanner := bufio.NewScanner(limited)
	scanner.Buffer(make([]byte, 4096), 128<<10)
	layers := map[string]RuntimeProgress{}
	for scanner.Scan() {
		var event struct {
			ID             string                         `json:"id"`
			Error          string                         `json:"error"`
			ErrorDetail    json.RawMessage                `json:"errorDetail"`
			ProgressDetail struct{ Current, Total int64 } `json:"progressDetail"`
		}
		if json.Unmarshal(scanner.Bytes(), &event) != nil {
			return &Error{Status: 502, Code: "execution-image-pull-unknown", Message: "镜像下载回执无效，须回读镜像状态后重试", OutcomeUnknown: true}
		}
		if event.Error != "" || len(event.ErrorDetail) > 0 && string(event.ErrorDetail) != "null" {
			return problem(502, "execution-image-pull", "运行镜像下载失败")
		}
		if event.ID != "" && event.ProgressDetail.Current >= 0 && event.ProgressDetail.Total >= event.ProgressDetail.Current {
			if _, ok := layers[event.ID]; !ok && len(layers) >= 512 {
				return &Error{Status: 502, Code: "execution-image-pull-unknown", Message: "镜像下载回执超过限制，须回读镜像状态后重试", OutcomeUnknown: true}
			}
			layers[event.ID] = RuntimeProgress{Current: event.ProgressDetail.Current, Total: event.ProgressDetail.Total}
		}
		p := RuntimeProgress{State: "pulling"}
		for _, layer := range layers {
			p.Current += layer.Current
			p.Total += layer.Total
		}
		if err := report(p); err != nil {
			return &Error{Status: 503, Code: "execution-image-pull-unknown", Message: "镜像下载进度无法保存，须回读镜像状态后重试", OutcomeUnknown: true}
		}
	}
	if scanner.Err() != nil || limited.N <= 0 || ctx.Err() != nil {
		return &Error{Status: 503, Code: "execution-image-pull-unknown", Message: "运行镜像下载结果未确认，须回读镜像状态后重试", OutcomeUnknown: true}
	}
	installed, err = e.inspectRuntimeImage(ctx, env.Profile.Image, env.Platform)
	if err != nil || installed == nil {
		return &Error{Status: 503, Code: "execution-image-pull-unknown", Message: "镜像下载尚未获得匹配摘要与架构的确认", OutcomeUnknown: true}
	}
	return report(RuntimeProgress{State: "ready"})
}
