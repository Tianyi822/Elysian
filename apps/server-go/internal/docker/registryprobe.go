package docker

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"elysian/server/internal/shared"
)

// 镜像源测速探针：取 library/alpine 清单的首个可下载层，限量下载 1 MiB 并计时。
// 测的是带宽而非握手延迟——实测中可用源之间的差别在传输速度（11 秒对 142 秒），
// 只测首字节分不出来。仅 GET、无凭证、只由用户点击触发；结果不缓存、不落盘。
// 401 时按标准 registry 令牌流程向 Www-Authenticate 的 realm 取匿名令牌后重试，
// realm 主机同样过公网解析校验，避免镜像源把探针引向内网地址。

const (
	probeTimeout     = 10 * time.Second
	probeSampleBytes = int64(1024 * 1024)
	probeManifestMax = 512 * 1024
	probeTokenMax    = 16 * 1024
	probeRepository  = "library/alpine"
	probeTag         = "latest"

	probeManifestAccept = "application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json"

	probeTimeoutReason  = "测速超时：10 秒内未完成 1 MiB 样本"
	probeTokenReason    = "无法取得镜像源访问令牌"
	probeNoLayerReason  = "镜像清单没有可下载层"
	probeRequestReason  = "镜像源测速请求失败"
	probeOverflowReason = "镜像源测速响应超过大小上限"
)

var (
	bearerChallengePattern = regexp.MustCompile(`(?i)^bearer\s+(.*)$`)
	challengeParamPattern  = regexp.MustCompile(`(?i)\b(realm|service)="([^"]*)"`)
	digestPattern          = regexp.MustCompile(`^[a-z0-9]+(?:[+._-][a-z0-9]+)*:[a-zA-Z0-9=_-]+$`)
)

var errProbeTimeout = errors.New("镜像源测速超时")

// probeResponse 一次探针请求的结构化响应；保留响应头，令牌流程要读 Www-Authenticate。
type probeResponse struct {
	status  int
	headers http.Header
	body    []byte
}

// probeFetcher 探针请求注入点（测试替身）；headers 为附加请求头，重定向不跟随。
type probeFetcher func(ctx context.Context, target registryRequestTarget, path string, headers map[string]string, maxBytes int64) (probeResponse, error)

// probeSampler 测速样本下载注入点（测试替身）；读满 1 MiB、EOF 或超时即停。
type probeSampler func(ctx context.Context, target registryRequestTarget, path string, headers map[string]string) (status int, bytes int64, elapsedMs int64, err error)

// probeResult 测速端点响应形状（键序即 JSON 输出序）。
type probeResult struct {
	OK        bool   `json:"ok"`
	ElapsedMs int64  `json:"elapsedMs,omitempty"`
	Bytes     int64  `json:"bytes,omitempty"`
	Reason    string `json:"reason,omitempty"`
}

// requestProbe 执行一次探针 HTTPS GET：无凭证（可带 Bearer）、上限截断、不跟随重定向。
func requestProbe(ctx context.Context, target registryRequestTarget, path string, headers map[string]string, maxBytes int64) (probeResponse, error) {
	reqCtx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(reqCtx, http.MethodGet, "https://"+target.host+path, nil)
	if err != nil {
		return probeResponse{}, err
	}
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	client := &http.Client{
		Transport:     newRegistryTransport(target),
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	response, err := client.Do(request)
	if err != nil {
		if reqCtx.Err() != nil {
			return probeResponse{}, errProbeTimeout
		}
		return probeResponse{}, err
	}
	defer response.Body.Close()
	body := make([]byte, 0, 4096)
	buf := make([]byte, 32*1024)
	total := int64(0)
	for {
		n, readErr := response.Body.Read(buf)
		if n > 0 {
			total += int64(n)
			if total > maxBytes {
				return probeResponse{}, errors.New(probeOverflowReason)
			}
			body = append(body, buf[:n]...)
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			if reqCtx.Err() != nil {
				return probeResponse{}, errProbeTimeout
			}
			return probeResponse{}, readErr
		}
	}
	return probeResponse{status: response.StatusCode, headers: response.Header, body: body}, nil
}

// downloadProbeSample 限量下载测速样本并计时：读满 1 MiB、EOF 或超时即停。
func downloadProbeSample(ctx context.Context, target registryRequestTarget, path string, headers map[string]string) (int, int64, int64, error) {
	reqCtx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(reqCtx, http.MethodGet, "https://"+target.host+path, nil)
	if err != nil {
		return 0, 0, 0, err
	}
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	client := &http.Client{
		Transport:     newRegistryTransport(target),
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	response, err := client.Do(request)
	if err != nil {
		if reqCtx.Err() != nil {
			return 0, 0, 0, errProbeTimeout
		}
		return 0, 0, 0, err
	}
	defer response.Body.Close()
	start := time.Now()
	read := int64(0)
	buf := make([]byte, 32*1024)
	for read < probeSampleBytes {
		n, readErr := response.Body.Read(buf)
		read += int64(n)
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			if reqCtx.Err() != nil {
				return response.StatusCode, read, time.Since(start).Milliseconds(), errProbeTimeout
			}
			return response.StatusCode, read, time.Since(start).Milliseconds(), readErr
		}
	}
	return response.StatusCode, read, time.Since(start).Milliseconds(), nil
}

// parseBearerChallenge 取 Bearer 挑战里的 realm 与 service；非 Bearer 或无 realm 即失败。
func parseBearerChallenge(challenge string) (realm string, service string, ok bool) {
	matched := bearerChallengePattern.MatchString(strings.TrimSpace(challenge))
	if !matched {
		return "", "", false
	}
	for _, param := range challengeParamPattern.FindAllStringSubmatch(challenge, -1) {
		switch strings.ToLower(param[1]) {
		case "realm":
			realm = param[2]
		case "service":
			service = param[2]
		}
	}
	if realm == "" {
		return "", "", false
	}
	return realm, service, true
}

// probeBearerToken 向挑战的 realm 取匿名令牌；realm 主机过公网解析校验，
// 非 https 或解析不出公网地址一律拒绝，避免镜像源把探针引向内网。
func probeBearerToken(ctx context.Context, fetch probeFetcher, resolve func(hostname string) ([]string, error), challenge string) (string, bool) {
	realm, service, ok := parseBearerChallenge(challenge)
	if !ok {
		return "", false
	}
	realmURL, err := url.Parse(realm)
	if err != nil || realmURL.Scheme != "https" || realmURL.Host == "" {
		return "", false
	}
	target, err := validateRegistryTarget(realmURL.Host, resolve)
	if err != nil {
		return "", false
	}
	requestTarget := registryRequestTarget{host: target.host, addresses: target.addresses}
	query := url.Values{}
	if service != "" {
		query.Set("service", service)
	}
	query.Set("scope", "repository:"+probeRepository+":pull")
	path := realmURL.EscapedPath()
	if path == "" {
		path = "/"
	}
	path += "?" + query.Encode()
	response, err := fetch(ctx, requestTarget, path, nil, probeTokenMax)
	if err != nil || response.status != http.StatusOK {
		return "", false
	}
	record, ok := probeRecord(response.body)
	if !ok {
		return "", false
	}
	token := ""
	if value, ok := asString(mustGet(record, "token")); ok {
		token = value
	} else if value, ok := asString(mustGet(record, "access_token")); ok {
		token = value
	}
	if token == "" || len(token) > 12_000 {
		return "", false
	}
	return token, true
}

// probeRecord 解析探针响应体为有序对象；格式无效即失败。
func probeRecord(body []byte) (*jsonObject, bool) {
	value, err := decodeOrderedJSON(body)
	if err != nil {
		return nil, false
	}
	return asRecord(value)
}

// probeFirstLayerDigest 取清单首个层的 digest；索引清单（只有 manifests）返回空。
func probeFirstLayerDigest(body []byte) string {
	record, ok := probeRecord(body)
	if !ok {
		return ""
	}
	layers, ok := asArray(mustGet(record, "layers"))
	if !ok || len(layers) == 0 {
		return ""
	}
	first, ok := asRecord(layers[0])
	if !ok {
		return ""
	}
	digest, ok := asString(mustGet(first, "digest"))
	if !ok || !digestPattern.MatchString(digest) {
		return ""
	}
	return digest
}

// probeChildIndexDigest 取索引清单首个子清单的 digest。
func probeChildIndexDigest(body []byte) string {
	record, ok := probeRecord(body)
	if !ok {
		return ""
	}
	manifests, ok := asArray(mustGet(record, "manifests"))
	if !ok || len(manifests) == 0 {
		return ""
	}
	first, ok := asRecord(manifests[0])
	if !ok {
		return ""
	}
	digest, ok := asString(mustGet(first, "digest"))
	if !ok || !digestPattern.MatchString(digest) {
		return ""
	}
	return digest
}

// ProbeRegistry 镜像源测速：清单 →（401 走令牌流程重试）→ 首个层限量下载计时。
func (s *dockerService) ProbeRegistry(ctx context.Context, registry string) (probeResult, error) {
	resolve := func(hostname string) ([]string, error) {
		return s.deps.resolveRegistry(ctx, hostname)
	}
	target, err := validateRegistryTarget(registry, resolve)
	if err != nil {
		return probeResult{}, shared.InvalidRequest(err.Error())
	}
	requestTarget := registryRequestTarget{host: target.host, addresses: target.addresses}
	fetch := s.deps.fetchProbe
	sample := s.deps.probeSample

	manifestPath := "/v2/" + probeRepository + "/manifests/" + probeTag
	headers := map[string]string{"accept": probeManifestAccept}
	response, err := fetch(ctx, requestTarget, manifestPath, headers, probeManifestMax)
	if err != nil {
		return probeFailure(err), nil
	}
	if response.status == http.StatusUnauthorized {
		token, ok := probeBearerToken(ctx, fetch, resolve, response.headers.Get("Www-Authenticate"))
		if !ok {
			return probeResult{Reason: probeTokenReason}, nil
		}
		headers["authorization"] = "Bearer " + token
		response, err = fetch(ctx, requestTarget, manifestPath, headers, probeManifestMax)
		if err != nil {
			return probeFailure(err), nil
		}
	}
	if response.status != http.StatusOK {
		return probeResult{Reason: fmt.Sprintf("无法读取镜像清单（HTTP %d）", response.status)}, nil
	}
	digest := probeFirstLayerDigest(response.body)
	if digest == "" {
		if child := probeChildIndexDigest(response.body); child != "" {
			childResponse, err := fetch(ctx, requestTarget, "/v2/"+probeRepository+"/manifests/"+child, headers, probeManifestMax)
			if err != nil {
				return probeFailure(err), nil
			}
			if childResponse.status != http.StatusOK {
				return probeResult{Reason: fmt.Sprintf("无法读取镜像清单（HTTP %d）", childResponse.status)}, nil
			}
			digest = probeFirstLayerDigest(childResponse.body)
		}
	}
	if digest == "" {
		return probeResult{Reason: probeNoLayerReason}, nil
	}
	sampleHeaders := map[string]string{
		"accept": "*/*",
		"range":  fmt.Sprintf("bytes=0-%d", probeSampleBytes-1),
	}
	if token := headers["authorization"]; token != "" {
		sampleHeaders["authorization"] = token
	}
	status, bytes, elapsedMs, err := sample(ctx, requestTarget, "/v2/"+probeRepository+"/blobs/"+digest, sampleHeaders)
	if err != nil {
		return probeFailure(err), nil
	}
	if status != http.StatusOK && status != http.StatusPartialContent {
		return probeResult{Reason: fmt.Sprintf("无法下载测速样本（HTTP %d）", status)}, nil
	}
	if bytes <= 0 {
		return probeResult{Reason: probeNoLayerReason}, nil
	}
	return probeResult{OK: true, ElapsedMs: elapsedMs, Bytes: bytes}, nil
}

// probeFailure 把请求层错误翻成用户可读原因；超时单独成文。
func probeFailure(err error) probeResult {
	if errors.Is(err, errProbeTimeout) {
		return probeResult{Reason: probeTimeoutReason}
	}
	if errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, io.EOF) {
		return probeResult{Reason: probeRequestReason + "：连接中断"}
	}
	message := err.Error()
	if strings.Contains(message, probeOverflowReason) {
		return probeResult{Reason: probeOverflowReason}
	}
	return probeResult{Reason: probeRequestReason}
}
