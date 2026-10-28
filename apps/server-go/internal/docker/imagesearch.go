package docker

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// 镜像源目录搜索 / 标签列表 / Docker Hub 匿名令牌（dockerImageSearch.ts 逐字移植）。
// HTTPS 边界：自定义源用已校验 IP 建连（DialContext 钉 addresses[0]）、主机名校验
// TLS（ServerName）、仅 GET 无凭证、超时 4s、响应上限分端点（目录 128 KiB / 标签
// 512 KiB / 令牌 16 KiB）、重定向不跟随（302 原样返回 status，上层判非 200）。

const (
	imageSearchLimit = 10
	catalogTimeout   = 4 * time.Second
	catalogMaxBytes  = 128 * 1024
	catalogPageSize  = 100
	tagsMaxBytes     = 512 * 1024
	imageTagLimit    = 40
	tokenMaxBytes    = 16 * 1024
)

// registryRequestTarget 目录/标签请求目标；addresses 非空时钉 IP 建连。
type registryRequestTarget struct {
	host      string
	addresses []string
}

// catalogResponse 目录/标签请求的结构化响应。
type catalogResponse struct {
	status int
	json   any
}

// catalogFetcher / tagsFetcher 目录与标签请求注入点（测试替身）。
type catalogFetcher func(ctx context.Context, target registryRequestTarget, path string) (catalogResponse, error)
type tagsFetcher func(ctx context.Context, target registryRequestTarget, path string, token string) (catalogResponse, error)

// newRegistryTransport 建连接缝：addresses 非空时钉 IP 建连，TLS 以主机名校验证书
// （防 DNS rebinding TOCTOU），IP 只用于建连。目录、标签与测速探针共用。
func newRegistryTransport(target registryRequestTarget) *http.Transport {
	hostname, _, err := net.SplitHostPort(target.host)
	if err != nil {
		hostname = target.host
	}
	transport := &http.Transport{
		DisableKeepAlives: true,
	}
	if len(target.addresses) > 0 {
		pinned := target.addresses[0]
		transport.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
			_, port, err := net.SplitHostPort(addr)
			if err != nil {
				port = "443"
			}
			dialer := &net.Dialer{}
			return dialer.DialContext(ctx, network, net.JoinHostPort(pinned, port))
		}
		transport.TLSClientConfig = &tls.Config{ServerName: hostname}
	}
	return transport
}

// requestRegistryJSON 执行一次无凭证（可带 Bearer）的 HTTPS GET。
func requestRegistryJSON(ctx context.Context, target registryRequestTarget, path string, maxBytes int64, token string, subject string) (catalogResponse, error) {
	transport := newRegistryTransport(target)

	reqCtx, cancel := context.WithTimeout(ctx, catalogTimeout)
	defer cancel()

	request, err := http.NewRequestWithContext(reqCtx, http.MethodGet, "https://"+target.host+path, nil)
	if err != nil {
		return catalogResponse{}, err
	}
	request.Header.Set("accept", "application/json")
	if token != "" {
		request.Header.Set("authorization", "Bearer "+token)
	}

	// 重定向一律不跟随：302 原样返回状态码，由上层按非 200 判定。
	client := &http.Client{
		Transport:     transport,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	response, err := client.Do(request)
	if err != nil {
		if reqCtx.Err() != nil {
			return catalogResponse{}, fmt.Errorf("镜像源%s查询超时", subject)
		}
		return catalogResponse{}, err
	}
	defer response.Body.Close()

	size := int64(0)
	chunks := make([]byte, 0, 4096)
	buf := make([]byte, 8*1024)
	for {
		n, readErr := response.Body.Read(buf)
		if n > 0 {
			size += int64(n)
			if size > maxBytes {
				return catalogResponse{}, fmt.Errorf("镜像源%s响应超过大小上限", subject)
			}
			chunks = append(chunks, buf[:n]...)
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			if reqCtx.Err() != nil {
				return catalogResponse{}, fmt.Errorf("镜像源%s查询超时", subject)
			}
			return catalogResponse{}, readErr
		}
	}

	if response.StatusCode != http.StatusOK {
		return catalogResponse{status: response.StatusCode, json: nil}, nil
	}
	value, err := decodeOrderedJSON(chunks)
	if err != nil {
		return catalogResponse{}, fmt.Errorf("镜像源%s响应格式无效", subject)
	}
	return catalogResponse{status: http.StatusOK, json: value}, nil
}

// requestRegistryCatalog 目录请求（128 KiB 上限）。
func requestRegistryCatalog(ctx context.Context, target registryRequestTarget, path string) (catalogResponse, error) {
	return requestRegistryJSON(ctx, target, path, catalogMaxBytes, "", "目录")
}

// requestRegistryTags 标签请求（512 KiB 上限，可带令牌）。
func requestRegistryTags(ctx context.Context, target registryRequestTarget, path string, token string) (catalogResponse, error) {
	return requestRegistryJSON(ctx, target, path, tagsMaxBytes, token, "标签")
}

// requestDockerHubToken 匿名获取 Hub 公开镜像访问令牌（scope 编码是逐字契约）。
func requestDockerHubToken(ctx context.Context, repository string) (string, error) {
	scope := "repository:" + repository + ":pull"
	path := "/token?service=registry.docker.io&scope=" + url.QueryEscape(scope)
	response, err := requestRegistryJSON(ctx, registryRequestTarget{host: "auth.docker.io"}, path, tokenMaxBytes, "", "令牌")
	if err != nil {
		return "", err
	}
	token := ""
	if record, ok := asRecord(response.json); ok {
		if t, ok := asString(mustGet(record, "token")); ok {
			token = t
		} else if t, ok := asString(mustGet(record, "access_token")); ok {
			token = t
		}
	}
	if response.status != http.StatusOK || token == "" || len(token) > 12_000 {
		return "", errors.New("无法取得 Docker Hub 公开镜像访问令牌")
	}
	return token, nil
}

var tagPattern = regexp.MustCompile(`^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$`)
var tagDatePattern = regexp.MustCompile(`^(?:19|20)\d{6}$`)
var tagNumericPattern = regexp.MustCompile(`^\d+(?:\.\d+)*(?:[-_][a-zA-Z0-9_.-]+)?$`)
var catalogNamePattern = regexp.MustCompile(`^[a-z0-9._/-]+$`)

// tagRank latest=0、数字版本形=1、其他=2、日期快照形=3。
func tagRank(tag string) int {
	if tag == "latest" {
		return 0
	}
	if tagDatePattern.MatchString(tag) {
		return 3
	}
	if tagNumericPattern.MatchString(tag) {
		return 1
	}
	return 2
}

// numericCollatorCompare Intl.Collator('en', {numeric:true, sensitivity:'base'}) 的
// ASCII 近似（盘点风险 2）：按数字段/非数字段切分，数字段按数值比较（"10" > "7"），
// 非数字段小写比较；返回 -1/0/1（a<b/a==b/a>b）。
func numericCollatorCompare(a, b string) int {
	ai, bi := 0, 0
	for ai < len(a) && bi < len(b) {
		aDigit := a[ai] >= '0' && a[ai] <= '9'
		bDigit := b[bi] >= '0' && b[bi] <= '9'
		if aDigit && bDigit {
			aj := ai
			for aj < len(a) && a[aj] >= '0' && a[aj] <= '9' {
				aj++
			}
			bj := bi
			for bj < len(b) && b[bj] >= '0' && b[bj] <= '9' {
				bj++
			}
			an, aerr := strconv.ParseUint(a[ai:aj], 10, 64)
			bn, berr := strconv.ParseUint(b[bi:bj], 10, 64)
			if aerr != nil || berr != nil || an != bn {
				// 数值不可比（超范围）或不相等：按数字串比较（去前导零后字典序）。
				as := strings.TrimLeft(a[ai:aj], "0")
				bs := strings.TrimLeft(b[bi:bj], "0")
				if len(as) != len(bs) {
					if len(as) < len(bs) {
						return -1
					}
					return 1
				}
				if c := strings.Compare(as, bs); c != 0 {
					return c
				}
			} else if an < bn {
				return -1
			} else if an > bn {
				return 1
			}
			ai, bi = aj, bj
			continue
		}
		ca := foldASCII(a[ai])
		cb := foldASCII(b[bi])
		if ca != cb {
			if ca < cb {
				return -1
			}
			return 1
		}
		ai++
		bi++
	}
	switch {
	case len(a)-ai < len(b)-bi:
		return -1
	case len(a)-ai > len(b)-bi:
		return 1
	default:
		return 0
	}
}

func foldASCII(ch byte) byte {
	if ch >= 'A' && ch <= 'Z' {
		return ch + ('a' - 'A')
	}
	return ch
}

// registryTagsResult 标签查询结果。
type registryTagsResult struct {
	tags       []string
	searchable bool
}

// listRegistryTags 拉取并排序标签：过滤、去重、latest/数字/日期三档排序、截 40。
func listRegistryTags(ctx context.Context, target registryRequestTarget, repository string, fetch tagsFetcher, token string) registryTagsResult {
	segments := strings.Split(repository, "/")
	for i, segment := range segments {
		segments[i] = url.PathEscape(segment)
	}
	path := "/v2/" + strings.Join(segments, "/") + "/tags/list"
	response, err := fetch(ctx, target, path, token)
	if err != nil {
		return registryTagsResult{tags: []string{}, searchable: false}
	}
	record, ok := asRecord(response.json)
	if response.status != http.StatusOK || !ok {
		return registryTagsResult{tags: []string{}, searchable: false}
	}
	rawTags, ok := asArray(mustGet(record, "tags"))
	if !ok {
		return registryTagsResult{tags: []string{}, searchable: false}
	}
	seen := make(map[string]bool)
	tags := make([]string, 0, len(rawTags))
	for _, entry := range rawTags {
		tag, ok := asString(entry)
		if !ok || len(tag) > 128 || !tagPattern.MatchString(tag) {
			continue
		}
		if seen[tag] {
			continue
		}
		seen[tag] = true
		tags = append(tags, tag)
	}
	sort.SliceStable(tags, func(i, j int) bool {
		ri, rj := tagRank(tags[i]), tagRank(tags[j])
		if ri != rj {
			return ri < rj
		}
		return numericCollatorCompare(tags[j], tags[i]) < 0
	})
	if len(tags) > imageTagLimit {
		tags = tags[:imageTagLimit]
	}
	return registryTagsResult{tags: tags, searchable: true}
}

// catalogStart term 的字典序前驱（redis → redir）。
func catalogStart(term string) string {
	if term == "" {
		return term
	}
	runes := []rune(term)
	last := runes[len(runes)-1]
	return string(runes[:len(runes)-1]) + string(last-1)
}

// registryNamesResult 目录搜索结果。
type registryNamesResult struct {
	names      []string
	searchable bool
}

// searchCatalog 自定义源目录搜索：只留以 term 开头且合法的去重前 10 条。
func searchCatalog(ctx context.Context, target validatedRegistryTarget, term string, fetch catalogFetcher) registryNamesResult {
	path := fmt.Sprintf("/v2/_catalog?n=%d&last=%s", catalogPageSize, url.QueryEscape(catalogStart(term)))
	response, err := fetch(ctx, registryRequestTarget{host: target.host, addresses: target.addresses}, path)
	if err != nil {
		return registryNamesResult{names: []string{}, searchable: false}
	}
	record, ok := asRecord(response.json)
	if response.status != http.StatusOK || !ok {
		return registryNamesResult{names: []string{}, searchable: false}
	}
	repositories, ok := asArray(mustGet(record, "repositories"))
	if !ok {
		return registryNamesResult{names: []string{}, searchable: false}
	}
	namePattern := catalogNamePattern
	seen := make(map[string]bool)
	names := make([]string, 0, imageSearchLimit)
	for _, entry := range repositories {
		name, ok := asString(entry)
		if !ok || !strings.HasPrefix(name, term) || !namePattern.MatchString(name) {
			continue
		}
		if seen[name] {
			continue
		}
		seen[name] = true
		names = append(names, name)
		if len(names) >= imageSearchLimit {
			break
		}
	}
	return registryNamesResult{names: names, searchable: true}
}
