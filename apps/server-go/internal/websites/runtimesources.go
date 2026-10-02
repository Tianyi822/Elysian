package websites

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

/*
 * 运行时版本目录抓取（websiteRuntimeSources.ts 逐字移植）：只从语言官方正式发布记录
 * 与 Docker 官方精确标签构建目录，不维护固定版本表。8 个官方源并行请求，各请求 30s
 * 超时；版本必须同时出现在发布记录与镜像标签（交集纪律），无 rc/beta/ea/浮动 tag。
 */

// sourceFetcher 出网抓取接口（生产 *http.Client；测试注入按主机路由的假件）。
type sourceFetcher interface {
	Do(req *http.Request) (*http.Response, error)
}

// sourceRequestTimeout 单请求超时：30 秒。
const sourceRequestTimeout = 30 * time.Second

// dockerHubRepositories 四类运行时对应的 Docker 官方仓库。
var dockerHubRepositories = map[string]string{
	KindJava:   "eclipse-temurin",
	KindNode:   "node",
	KindGo:     "golang",
	KindPython: "python",
}

// officialKinds 目录键序（java/node/go/python，与契约一致）。
var officialKinds = []string{KindJava, KindNode, KindGo, KindPython}

// sourceResponse 一次官方源响应：状态、头与已读尽的体。
type sourceResponse struct {
	status int
	header http.Header
	body   []byte
}

// sourceGet 执行 GET：网络失败归一为「无法连接官方版本来源：<hostname>」。
func sourceGet(ctx context.Context, fetcher sourceFetcher, rawURL string, headers map[string]string) (sourceResponse, error) {
	rctx, cancel := context.WithTimeout(ctx, sourceRequestTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(rctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return sourceResponse{}, fmt.Errorf("无法连接官方版本来源：%s", hostnameOf(rawURL))
	}
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	response, err := fetcher.Do(req)
	if err != nil {
		return sourceResponse{}, fmt.Errorf("无法连接官方版本来源：%s", hostnameOf(rawURL))
	}
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil {
		return sourceResponse{}, fmt.Errorf("无法连接官方版本来源：%s", hostnameOf(rawURL))
	}
	return sourceResponse{status: response.StatusCode, header: response.Header, body: data}, nil
}

// sourceReadJSON GET + 解析 JSON：非 ok →「官方版本目录读取失败：<hostname>（HTTP <status>）」，
// 坏 JSON →「官方版本目录不是有效 JSON：<hostname>」。
func sourceReadJSON(ctx context.Context, fetcher sourceFetcher, rawURL string, headers map[string]string) (any, http.Header, error) {
	response, err := sourceGet(ctx, fetcher, rawURL, headers)
	if err != nil {
		return nil, nil, err
	}
	if response.status < 200 || response.status >= 300 {
		return nil, nil, fmt.Errorf("官方版本目录读取失败：%s（HTTP %d）", hostnameOf(rawURL), response.status)
	}
	var data any
	if err := json.Unmarshal(response.body, &data); err != nil {
		return nil, nil, fmt.Errorf("官方版本目录不是有效 JSON：%s", hostnameOf(rawURL))
	}
	return data, response.header, nil
}

// hostnameOf 取 URL 主机名；解析失败回原文（错误文案需要主机名）。
func hostnameOf(rawURL string) string {
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Hostname() == "" {
		return rawURL
	}
	return parsed.Hostname()
}

var linkNextPattern = regexp.MustCompile(`<([^>]+)>;\s*rel="next"`)

// readDockerTags Docker Hub 匿名 token + 标签分页（页集合去重、≤128 页；next origin
// 必须仍是 registry-1.docker.io）。
func readDockerTags(ctx context.Context, fetcher sourceFetcher, repository string) (map[string]struct{}, error) {
	auth, _, err := sourceReadJSON(ctx, fetcher, "https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/"+repository+":pull", nil)
	if err != nil {
		return nil, err
	}
	token, ok := objectGet(auth, "token").(string)
	if !ok || token == "" {
		return nil, fmt.Errorf("官方镜像库凭据响应无效")
	}
	tags := map[string]struct{}{}
	pages := map[string]struct{}{}
	next := "https://registry-1.docker.io/v2/library/" + repository + "/tags/list?n=10000"
	for next != "" {
		if _, seen := pages[next]; seen || len(pages) >= 128 {
			return nil, fmt.Errorf("官方镜像库分页无效或超过上限")
		}
		pages[next] = struct{}{}
		data, header, err := sourceReadJSON(ctx, fetcher, next, map[string]string{"Authorization": "Bearer " + token})
		if err != nil {
			return nil, err
		}
		tagList, ok := objectGet(data, "tags").([]any)
		if !ok {
			return nil, fmt.Errorf("官方镜像标签响应无效")
		}
		for _, item := range tagList {
			if tag, isText := item.(string); isText {
				tags[tag] = struct{}{}
			} else {
				return nil, fmt.Errorf("官方镜像标签响应无效")
			}
		}
		match := linkNextPattern.FindStringSubmatch(header.Get("Link"))
		if match == nil {
			next = ""
			continue
		}
		base, err := url.Parse(next)
		if err != nil {
			return nil, fmt.Errorf("官方镜像库分页地址无效")
		}
		resolved, err := base.Parse(match[1])
		if err != nil {
			return nil, fmt.Errorf("官方镜像库分页地址无效")
		}
		if resolved.Scheme != "https" || resolved.Host != "registry-1.docker.io" {
			return nil, fmt.Errorf("官方镜像库分页地址无效")
		}
		next = resolved.String()
	}
	return tags, nil
}

// readJavaReleases Adoptium Java 发布名分页：末页以 404 表示（页数 >128、首页重复
// 检测、形状校验）。
func readJavaReleases(ctx context.Context, fetcher sourceFetcher) ([]string, error) {
	releases := []string{}
	for page := 0; ; page++ {
		if page >= 128 {
			return nil, fmt.Errorf("Java 正式发布目录页数超过上限")
		}
		response, err := sourceGet(ctx, fetcher, fmt.Sprintf("https://api.adoptium.net/v3/info/release_names?architecture=x64&heap_size=normal&image_type=jdk&jvm_impl=hotspot&os=linux&page=%d&page_size=20&release_type=ga&sort_order=DESC", page), nil)
		if err != nil {
			return nil, err
		}
		// Adoptium 超出最后一页时以 404 表示空结果。
		if response.status == http.StatusNotFound && len(releases) > 0 {
			break
		}
		if response.status < 200 || response.status >= 300 {
			return nil, fmt.Errorf("Java 正式发布目录读取失败（HTTP %d）", response.status)
		}
		var data struct {
			Releases []any `json:"releases"`
		}
		if err := json.Unmarshal(response.body, &data); err != nil {
			return nil, fmt.Errorf("Java 正式发布目录不是有效 JSON")
		}
		names := make([]string, 0, len(data.Releases))
		for _, item := range data.Releases {
			text, ok := item.(string)
			if !ok {
				return nil, fmt.Errorf("Java 正式发布目录响应无效")
			}
			names = append(names, text)
		}
		if len(names) == 0 {
			break
		}
		for _, existing := range releases {
			if existing == names[0] {
				return nil, fmt.Errorf("Java 正式发布目录分页重复")
			}
		}
		releases = append(releases, names...)
	}
	return releases, nil
}

// FetchWebsiteRuntimeCatalog 并行请求 8 个官方源并构建版本目录。asOf 为 YYYY-MM-DD
// （未来版本随 asOf 推移自动进入目录）。fetcher 供测试注入；nil 落生产 http.Client。
func FetchWebsiteRuntimeCatalog(ctx context.Context, fetcher sourceFetcher, asOf string) (runtimeCatalog, error) {
	if fetcher == nil {
		fetcher = &http.Client{}
	}
	catalog := runtimeCatalog{}
	tagsByKind := map[string]map[string]struct{}{}
	var (
		mu           sync.Mutex
		firstErr     error
		wg           sync.WaitGroup
		nodeData     []nodeRelease
		schedule     map[string]nodeScheduleWindow
		goData       []goRelease
		pythonData   []pythonRelease
		javaReleases []string
		javaInfo     adoptiumInfo
	)
	fail := func(err error) {
		mu.Lock()
		defer mu.Unlock()
		if firstErr == nil {
			firstErr = err
		}
	}
	run := func(fn func() error) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := fn(); err != nil {
				fail(err)
			}
		}()
	}
	for _, kind := range officialKinds {
		kind := kind
		run(func() error {
			tags, err := readDockerTags(ctx, fetcher, dockerHubRepositories[kind])
			if err != nil {
				return err
			}
			mu.Lock()
			defer mu.Unlock()
			tagsByKind[kind] = tags
			return nil
		})
	}
	run(func() error {
		data, _, err := sourceReadJSON(ctx, fetcher, "https://nodejs.org/dist/index.json", nil)
		if err != nil {
			return err
		}
		list, err := decodeJSONList(data)
		if err != nil {
			return err
		}
		mu.Lock()
		defer mu.Unlock()
		for _, item := range list {
			nodeData = append(nodeData, nodeRelease{
				Version: stringField(item, "version"),
				Date:    stringField(item, "date"),
			})
		}
		return nil
	})
	run(func() error {
		data, _, err := sourceReadJSON(ctx, fetcher, "https://raw.githubusercontent.com/nodejs/Release/main/schedule.json", nil)
		if err != nil {
			return err
		}
		row, ok := data.(map[string]any)
		if !ok {
			return fmt.Errorf("官方版本目录不是有效 JSON：raw.githubusercontent.com")
		}
		windows := map[string]nodeScheduleWindow{}
		for key, value := range row {
			entry, ok := value.(map[string]any)
			if !ok {
				continue
			}
			start, _ := entry["start"].(string)
			end, _ := entry["end"].(string)
			windows[key] = nodeScheduleWindow{Start: start, End: end}
		}
		mu.Lock()
		defer mu.Unlock()
		schedule = windows
		return nil
	})
	run(func() error {
		data, _, err := sourceReadJSON(ctx, fetcher, "https://go.dev/dl/?mode=json&include=all", nil)
		if err != nil {
			return err
		}
		list, err := decodeJSONList(data)
		if err != nil {
			return err
		}
		mu.Lock()
		defer mu.Unlock()
		for _, item := range list {
			goData = append(goData, goRelease{
				Version: stringField(item, "version"),
				Stable:  boolField(item, "stable"),
			})
		}
		return nil
	})
	run(func() error {
		data, _, err := sourceReadJSON(ctx, fetcher, "https://www.python.org/api/v2/downloads/release/?is_published=true&limit=1000", nil)
		if err != nil {
			return err
		}
		list, err := decodeJSONList(data)
		if err != nil {
			return err
		}
		mu.Lock()
		defer mu.Unlock()
		for _, item := range list {
			pythonData = append(pythonData, pythonRelease{
				Name:        stringField(item, "name"),
				PreRelease:  boolField(item, "pre_release"),
				ReleaseDate: stringField(item, "release_date"),
				IsPublished: boolField(item, "is_published"),
			})
		}
		return nil
	})
	run(func() error {
		releases, err := readJavaReleases(ctx, fetcher)
		if err != nil {
			return err
		}
		mu.Lock()
		defer mu.Unlock()
		javaReleases = releases
		return nil
	})
	run(func() error {
		data, _, err := sourceReadJSON(ctx, fetcher, "https://api.adoptium.net/v3/info/available_releases", nil)
		if err != nil {
			return err
		}
		row, ok := data.(map[string]any)
		if !ok {
			return fmt.Errorf("官方版本目录不是有效 JSON：api.adoptium.net")
		}
		info := adoptiumInfo{}
		if list, ok := row["available_lts_releases"].([]any); ok {
			for _, item := range list {
				if v, ok := item.(float64); ok {
					info.AvailableLTS = append(info.AvailableLTS, v)
				}
			}
		}
		if v, ok := row["most_recent_feature_release"].(float64); ok {
			info.MostRecentFeature = v
		}
		mu.Lock()
		defer mu.Unlock()
		javaInfo = info
		return nil
	})
	wg.Wait()
	if firstErr != nil {
		return runtimeCatalog{}, firstErr
	}

	add := func(kind string, version string, tag string) {
		if _, ok := tagsByKind[kind][tag]; !ok {
			return
		}
		for _, entry := range catalogEntriesFor(&catalog, kind) {
			if entry.Version == version {
				return
			}
		}
		setCatalogEntries(&catalog, kind, append(catalogEntriesFor(&catalog, kind), catalogEntry{
			Version:     version,
			Image:       dockerHubRepositories[kind] + ":" + tag,
			Maintenance: MaintenanceLegacy,
			CheckedAt:   asOf,
		}))
	}

	// 全部历史正式版本按发布记录与镜像可用性筛选，版本范围随官方发布自动扩展。
	for _, release := range nodeData {
		match := nodeSourceVersion.FindStringSubmatch(release.Version)
		if match != nil && release.Date <= asOf {
			add(KindNode, match[1], match[1])
		}
	}
	for _, release := range goData {
		match := goSourceVersion.FindStringSubmatch(release.Version)
		if !release.Stable || match == nil {
			continue
		}
		patch := match[3]
		if patch == "" {
			patch = "0"
		}
		version := match[1] + "." + match[2] + "." + patch
		add(KindGo, version, version)
	}
	for _, release := range pythonData {
		// 网站 Python 运行时仅提供 Python 3，Python 2 不属于此目录。
		match := pythonSourceVersion.FindStringSubmatch(release.Name)
		if release.PreRelease || !release.IsPublished || match == nil || truncateDate(release.ReleaseDate) > asOf {
			continue
		}
		add(KindPython, match[1], match[1]+"-slim")
	}
	for _, release := range javaReleases {
		version := javaSourcePrefix.ReplaceAllString(release, "")
		if !javaSourceVersion.MatchString(version) {
			continue
		}
		baseTag := strings.Replace(version, "+", "_", 1)
		// 部分早期 GA 只发布 JDK 镜像，JDK 同样包含运行时；优先用更小的 JRE。
		tag := ""
		for _, candidate := range []string{baseTag + "-jre", baseTag + "-jdk"} {
			if _, ok := tagsByKind[KindJava][candidate]; ok {
				tag = candidate
				break
			}
		}
		if tag != "" {
			add(KindJava, NormalizeWebsiteJavaReleaseVersion(version), tag)
		}
	}

	markMaintenance(&catalog, nodeData, schedule, goData, pythonData, javaInfo, asOf)

	for _, kind := range officialKinds {
		if len(catalogEntriesFor(&catalog, kind)) == 0 {
			return runtimeCatalog{}, fmt.Errorf("%s 正式版本目录为空，拒绝覆盖", kind)
		}
	}
	return catalog, nil
}

// nodeRelease / nodeScheduleWindow / goRelease / pythonRelease / adoptiumInfo
// 官方源的定形切片。
type nodeRelease struct {
	Version string
	Date    string
}

type nodeScheduleWindow struct {
	Start string
	End   string
}

type goRelease struct {
	Version string
	Stable  bool
}

type pythonRelease struct {
	Name        string
	PreRelease  bool
	ReleaseDate string
	IsPublished bool
}

type adoptiumInfo struct {
	AvailableLTS      []float64
	MostRecentFeature float64
}

// decodeJSONList 把官方源 JSON 数组收窄为对象列表；形状不符时报解析失败
// （TS 侧同位置是未捕获 TypeError，同为 500 语义）。
func decodeJSONList(data any) ([]map[string]any, error) {
	list, ok := data.([]any)
	if !ok {
		return nil, fmt.Errorf("官方版本目录响应无效")
	}
	rows := make([]map[string]any, 0, len(list))
	for _, item := range list {
		row, ok := item.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("官方版本目录响应无效")
		}
		rows = append(rows, row)
	}
	return rows, nil
}

// stringField / boolField 安全取对象字段（缺省零值；形状漂移降级为跳过该条）。
func stringField(row map[string]any, key string) string {
	s, _ := row[key].(string)
	return s
}

func boolField(row map[string]any, key string) bool {
	b, _ := row[key].(bool)
	return b
}

// objectGet 安全取对象键（缺省 nil）。
func objectGet(value any, key string) any {
	if row, ok := value.(map[string]any); ok {
		return row[key]
	}
	return nil
}

// truncateDate 取 YYYY-MM-DD 前缀。
func truncateDate(value string) string {
	if len(value) >= 10 {
		return value[:10]
	}
	return value
}

// versionDigits 全部数字段（版本比较键用）。
var versionDigits = regexp.MustCompile(`\d+`)

// versionParts 版本比较键：java 四段+构建号形态展开，其余取全部数字段。
func versionParts(version string) []int {
	match := javaNormalize.FindStringSubmatch(version)
	if match != nil {
		parts := []int{}
		for _, piece := range strings.Split(match[1], ".") {
			parts = append(parts, atoiSafe(piece))
		}
		for len(parts) < 4 {
			parts = append(parts, 0)
		}
		return append(parts, atoiSafe(match[2]))
	}
	numbers := versionDigits.FindAllString(version, -1)
	parts := make([]int, 0, len(numbers))
	for _, number := range numbers {
		parts = append(parts, atoiSafe(number))
	}
	return parts
}

// compareVersions 降序比较（a 更新 → 负值，JS sort 口径）。
func compareVersions(a string, b string) int {
	left := versionParts(a)
	right := versionParts(b)
	for i := 0; i < len(left) || i < len(right); i++ {
		l, r := 0, 0
		if i < len(left) {
			l = left[i]
		}
		if i < len(right) {
			r = right[i]
		}
		if diff := r - l; diff != 0 {
			return diff
		}
	}
	return 0
}

// versionLine 维护期判据的版本线：node/java 取主版本，go/python 取主.次。
func versionLine(kind string, version string) string {
	parts := versionParts(version)
	count := 2
	if kind == KindNode || kind == KindJava {
		count = 1
	}
	if len(parts) > count {
		parts = parts[:count]
	}
	pieces := make([]string, len(parts))
	for i, part := range parts {
		pieces[i] = fmt.Sprintf("%d", part)
	}
	return strings.Join(pieces, ".")
}

// atoiSafe 十进制转整数（失败回 0）。
func atoiSafe(text string) int {
	value := 0
	for i := 0; i < len(text); i++ {
		if text[i] < '0' || text[i] > '9' {
			return 0
		}
		value = value*10 + int(text[i]-'0')
	}
	return value
}

// markMaintenance 维护状态标注：java 取 LTS∪最新 feature、node 取官方 schedule、
// go 取最新两条主线、python 取首次 3.x.0 发布月月底 +5 年。排序与 TS 同构：先按
// 版本降序标注，再按 maintained 优先 + 版本降序稳定排序。
func markMaintenance(catalog *runtimeCatalog, nodeData []nodeRelease, schedule map[string]nodeScheduleWindow, goData []goRelease, pythonData []pythonRelease, javaInfo adoptiumInfo, asOf string) {
	supportedJava := map[string]struct{}{}
	for _, value := range javaInfo.AvailableLTS {
		supportedJava[fmt.Sprintf("%d", int(value))] = struct{}{}
	}
	if javaInfo.MostRecentFeature != 0 {
		supportedJava[fmt.Sprintf("%d", int(javaInfo.MostRecentFeature))] = struct{}{}
	}
	goLinesSet := map[string]struct{}{}
	var goLines []string
	for _, entry := range catalog.Go {
		line := versionLine(KindGo, entry.Version)
		if _, ok := goLinesSet[line]; !ok {
			goLinesSet[line] = struct{}{}
			goLines = append(goLines, line)
		}
	}
	sort.SliceStable(goLines, func(i, j int) bool { return compareVersions(goLines[i], goLines[j]) < 0 })
	if len(goLines) > 2 {
		goLines = goLines[:2]
	}
	goMaintained := map[string]struct{}{}
	for _, line := range goLines {
		goMaintained[line] = struct{}{}
	}
	pythonFirstRelease := map[string]string{}
	for _, release := range pythonData {
		match := pythonFirstLine.FindStringSubmatch(release.Name)
		if match != nil && !release.PreRelease && release.IsPublished {
			if _, ok := pythonFirstRelease[match[1]]; !ok {
				pythonFirstRelease[match[1]] = truncateDate(release.ReleaseDate)
			}
		}
	}
	for _, kind := range officialKinds {
		entries := catalogEntriesFor(catalog, kind)
		sort.SliceStable(entries, func(i, j int) bool { return compareVersions(entries[i].Version, entries[j].Version) < 0 })
		lines := map[string]struct{}{}
		for i := range entries {
			line := versionLine(kind, entries[i].Version)
			supported := false
			switch kind {
			case KindJava:
				_, supported = supportedJava[line]
			case KindNode:
				window, ok := schedule["v"+line]
				supported = ok && window.Start <= asOf && window.End >= asOf
			case KindGo:
				_, supported = goMaintained[line]
			case KindPython:
				supported = pythonMaintained(pythonFirstRelease, line, asOf)
			}
			if _, marked := lines[line]; supported && !marked {
				entries[i].Maintenance = MaintenanceMaintained
			}
			lines[line] = struct{}{}
		}
		sort.SliceStable(entries, func(i, j int) bool {
			if entries[i].Maintenance == entries[j].Maintenance {
				return compareVersions(entries[i].Version, entries[j].Version) < 0
			}
			return entries[i].Maintenance == MaintenanceMaintained
		})
		setCatalogEntries(catalog, kind, entries)
	}
}

// pythonMaintained 维护期 = 首次 3.x.0 发布月月底 +5 年（TS setUTCFullYear(+5,
// month+1, 0) 的等价归一：Go 的 time.Date 对 day=0 回落到上月最后一天）。
func pythonMaintained(firstRelease map[string]string, line string, asOf string) bool {
	first, ok := firstRelease[line]
	if !ok {
		return false
	}
	basis, err := time.Parse("2006-01-02", first)
	if err != nil {
		return false
	}
	end := time.Date(basis.Year()+5, basis.Month()+1, 0, 0, 0, 0, 0, time.UTC)
	return end.Format("2006-01-02") >= asOf
}
