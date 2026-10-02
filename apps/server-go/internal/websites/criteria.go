package websites

import (
	"errors"
	"math"
	"regexp"
	"strings"
	"time"
)

// 契约判据纯函数（packages/foundation/contracts/src/websites/websites.ts 的 Go 版，
// 暂居域内；上移 internal/contract 事项登记 gaps）。错误消息是 API 契约，逐字照抄。

// WEBSITE_HTML_IMAGE HTML 使用固定的 Docker 官方 Nginx 镜像。
const WEBSITE_HTML_IMAGE = "nginx:1.30.4-alpine3.24"

// WEBSITE_PROJECT_NAME_MAX_LENGTH 项目名上限（UTF-16 code unit 数）。
const WEBSITE_PROJECT_NAME_MAX_LENGTH = 64

// WEBSITE_DOMAIN_MAX_LENGTH 域名总长上限（ASCII 形态，与 DNS 全名一致）。
const WEBSITE_DOMAIN_MAX_LENGTH = 253

var (
	// 项目名禁用字符：/ \ : 与 C0+DEL 控制字符（冒号与斜杠一样是引擎 bind 字符串的分隔符）。
	websiteProjectNameForbidden = regexp.MustCompile(`[/\\:\x{0000}-\x{001F}\x{007F}]`)

	// RFC 1123 标签形态：字母数字开头结尾，中间可夹连字符。
	websiteDomainLabelPattern = regexp.MustCompile(`^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$`)

	// IPv4 字面量：形态上合法、须显式排除。
	websiteDomainIPLiteral = regexp.MustCompile(`^(\d{1,3})(\.\d{1,3}){3}$`)

	javaReleasePattern  = regexp.MustCompile(`^(8u\d+-b\d+|\d+\.\d+\.\d+(?:\.\d+)?\+\d+)$`)
	javaNormalize       = regexp.MustCompile(`^(\d+(?:\.\d+){0,3})\+(\d+)$`)
	javaImageTag        = regexp.MustCompile(`^eclipse-temurin:(8u\d+-b\d+|\d+(?:\.\d+){0,3}_\d+)-(jre|jdk)$`)
	simpleRelease       = regexp.MustCompile(`^\d+\.\d+\.\d+$`)
	pureDigits          = regexp.MustCompile(`^\d+$`)
	dateOnly            = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
	javaSourceVersion   = regexp.MustCompile(`^(8u\d+-b\d+|\d+(?:\.\d+){0,3}\+\d+)$`)
	javaSourcePrefix    = regexp.MustCompile(`^jdk-?`)
	goSourceVersion     = regexp.MustCompile(`^go(\d+)\.(\d+)(?:\.(\d+))?$`)
	nodeSourceVersion   = regexp.MustCompile(`^v(\d+\.\d+\.\d+)$`)
	pythonSourceVersion = regexp.MustCompile(`^Python (3\.\d+\.\d+)$`)
	pythonFirstLine     = regexp.MustCompile(`^Python (3\.\d+)\.0$`)
)

// IsValidWebsiteProjectName 项目名判据：去空白后 1–64 字符（UTF-16 口径），且不含
// `/`、`\`、`:` 与控制字符，不得为 `.` 或 `..`。名称是站点目录路径段的唯一来源。
func IsValidWebsiteProjectName(name string) bool {
	trimmed := strings.TrimSpace(name)
	length := utf16Length(trimmed)
	if length == 0 || length > WEBSITE_PROJECT_NAME_MAX_LENGTH {
		return false
	}
	if trimmed == "." || trimmed == ".." {
		return false
	}
	return !websiteProjectNameForbidden.MatchString(trimmed)
}

// IsValidWebsitePort 端口判据：1–65535 的整数（JSON 数值以 float64 到达）。
func IsValidWebsitePort(port float64) bool {
	return port == math.Trunc(port) && port >= 1 && port <= 65535
}

// IsValidWebsiteDomain 域名判据：RFC 1123 形态——每标签 `[a-zA-Z0-9]([a-zA-Z0-9-]*
// [a-zA-Z0-9])?`、总长不超过 253、至少两级标签；IP 字面量显式拒绝。
func IsValidWebsiteDomain(domain string) bool {
	trimmed := strings.TrimSpace(domain)
	if trimmed == "" || utf16Length(trimmed) > WEBSITE_DOMAIN_MAX_LENGTH {
		return false
	}
	if websiteDomainIPLiteral.MatchString(trimmed) {
		return false
	}
	labels := strings.Split(trimmed, ".")
	if len(labels) < 2 {
		return false
	}
	for _, label := range labels {
		if !websiteDomainLabelPattern.MatchString(label) {
			return false
		}
	}
	return true
}

// IsWebsiteRuntimeReleaseVersion 正式版判据：java 接受 8uXXX-bNNN 与 1~4 段+构建号，
// 其余接受 X.Y.Z；预发布与浮动 tag 一律拒绝。
func IsWebsiteRuntimeReleaseVersion(kind string, version string) bool {
	if kind == KindJava {
		return javaReleasePattern.MatchString(version)
	}
	return simpleRelease.MatchString(version)
}

// NormalizeWebsiteJavaReleaseVersion Java 初始 GA 的省略零分量展开为完整版本
// （17+35 → 17.0.0+35），正式构建号保持原样。
func NormalizeWebsiteJavaReleaseVersion(version string) string {
	match := javaNormalize.FindStringSubmatch(version)
	if match == nil {
		return version
	}
	parts := strings.Split(match[1], ".")
	for len(parts) < 3 {
		parts = append(parts, "0")
	}
	return strings.Join(parts, ".") + "+" + match[2]
}

// WebsiteRuntimeImageRef version 必须落在正式版本目录内，否则返回 nil；HTML 返回
// 固定镜像。建容器与删除时的镜像核对都从这里取引用，用户无法指定任意镜像。
func WebsiteRuntimeImageRef(kind string, version *string, catalog *runtimeCatalog) *string {
	if kind == KindHTML {
		return stringPtr(WEBSITE_HTML_IMAGE)
	}
	if version == nil || catalog == nil {
		return nil
	}
	for _, entry := range catalogEntriesFor(catalog, kind) {
		if entry.Version == *version {
			return stringPtr(entry.Image)
		}
	}
	return nil
}

// WebsiteDefaultDeployCommand 面板为站点容器配置的启动命令（创建时生成、固化进登记，
// 如实反映容器 Cmd）：与前端契约保持同一规则。java/node/go/python 需要用户填写，
// 返回 nil。
func WebsiteDefaultDeployCommand(kind string) *string {
	if kind == KindHTML {
		return stringPtr("nginx -g daemon off;")
	}
	return nil
}

// catalogEntriesFor 按类型取目录切片；未知类型返回 nil。
func catalogEntriesFor(catalog *runtimeCatalog, kind string) []catalogEntry {
	if catalog == nil {
		return nil
	}
	switch kind {
	case KindJava:
		return catalog.Java
	case KindNode:
		return catalog.Node
	case KindGo:
		return catalog.Go
	case KindPython:
		return catalog.Python
	default:
		return nil
	}
}

// errInvalidRuntimeCatalogResponse 传输与缓存共同校验的唯一错误消息。
var errInvalidRuntimeCatalogResponse = errors.New("正式运行时版本目录响应无效")

// ParseWebsiteRuntimeCatalogReport 传输与缓存的共同校验出口：拒绝预发布、浮动镜像和
// 版本／镜像不匹配。输入是 JSON 解析后的任意值。
func ParseWebsiteRuntimeCatalogReport(value any) (runtimeCatalogReport, error) {
	row, ok := value.(map[string]any)
	if !ok {
		return runtimeCatalogReport{}, errInvalidRuntimeCatalogResponse
	}
	fetchedAt, ok := row["fetchedAt"].(string)
	if !ok || !parseFlexibleTime(fetchedAt) {
		return runtimeCatalogReport{}, errInvalidRuntimeCatalogResponse
	}
	stale, ok := row["stale"].(bool)
	if !ok {
		return runtimeCatalogReport{}, errInvalidRuntimeCatalogResponse
	}
	var detail *string
	if raw, present := row["detail"]; present && raw != nil {
		text, ok := raw.(string)
		if !ok {
			return runtimeCatalogReport{}, errInvalidRuntimeCatalogResponse
		}
		detail = stringPtr(text)
	}
	catalogRaw, ok := row["catalog"].(map[string]any)
	if !ok {
		return runtimeCatalogReport{}, errInvalidRuntimeCatalogResponse
	}
	var report runtimeCatalogReport
	report.FetchedAt = fetchedAt
	report.Stale = stale
	report.Detail = detail
	for _, kind := range []string{KindJava, KindNode, KindGo, KindPython} {
		entriesRaw, ok := catalogRaw[kind].([]any)
		if !ok || len(entriesRaw) == 0 || len(entriesRaw) > 5000 {
			return runtimeCatalogReport{}, errInvalidRuntimeCatalogResponse
		}
		entries := make([]catalogEntry, 0, len(entriesRaw))
		seen := map[string]struct{}{}
		for _, item := range entriesRaw {
			entry, err := parseCatalogEntry(kind, item)
			if err != nil {
				return runtimeCatalogReport{}, err
			}
			if _, dup := seen[entry.Version]; dup {
				return runtimeCatalogReport{}, errInvalidRuntimeCatalogResponse
			}
			seen[entry.Version] = struct{}{}
			entries = append(entries, entry)
		}
		setCatalogEntries(&report.Catalog, kind, entries)
	}
	return report, nil
}

// parseCatalogEntry 校验单项：版本过正式版判据、镜像与版本严格匹配、维护状态与
// 日期形态合法。
func parseCatalogEntry(kind string, item any) (catalogEntry, error) {
	entry, ok := item.(map[string]any)
	if !ok {
		return catalogEntry{}, errInvalidRuntimeCatalogResponse
	}
	version, ok := entry["version"].(string)
	if !ok || !IsWebsiteRuntimeReleaseVersion(kind, version) {
		return catalogEntry{}, errInvalidRuntimeCatalogResponse
	}
	image, ok := entry["image"].(string)
	if !ok {
		return catalogEntry{}, errInvalidRuntimeCatalogResponse
	}
	maintenance, ok := entry["maintenance"].(string)
	if !ok || (maintenance != MaintenanceMaintained && maintenance != MaintenanceLegacy) {
		return catalogEntry{}, errInvalidRuntimeCatalogResponse
	}
	checkedAt, ok := entry["checkedAt"].(string)
	if !ok || !dateOnly.MatchString(checkedAt) {
		return catalogEntry{}, errInvalidRuntimeCatalogResponse
	}
	if kind == KindJava {
		match := javaImageTag.FindStringSubmatch(image)
		if match == nil {
			return catalogEntry{}, errInvalidRuntimeCatalogResponse
		}
		exact := NormalizeWebsiteJavaReleaseVersion(strings.Replace(match[1], "_", "+", 1))
		if version != exact {
			return catalogEntry{}, errInvalidRuntimeCatalogResponse
		}
	} else {
		expect := kind
		if kind == KindGo {
			expect = "golang"
		}
		suffix := ""
		if kind == KindPython {
			suffix = "-slim"
		}
		if image != expect+":"+version+suffix {
			return catalogEntry{}, errInvalidRuntimeCatalogResponse
		}
	}
	return catalogEntry{Version: version, Image: image, Maintenance: maintenance, CheckedAt: checkedAt}, nil
}

// validateTypedCatalog 对服务自身产出的目录做同一套校验（TS 侧 refresh 后经
// parseWebsiteRuntimeCatalogReport 重校验的等价物）。
func validateTypedCatalog(catalog runtimeCatalog) error {
	for _, kind := range []string{KindJava, KindNode, KindGo, KindPython} {
		entries := catalogEntriesFor(&catalog, kind)
		if len(entries) == 0 || len(entries) > 5000 {
			return errInvalidRuntimeCatalogResponse
		}
		seen := map[string]struct{}{}
		for _, entry := range entries {
			parsed, err := parseCatalogEntry(kind, map[string]any{
				"version":     entry.Version,
				"image":       entry.Image,
				"maintenance": entry.Maintenance,
				"checkedAt":   entry.CheckedAt,
			})
			if err != nil {
				return err
			}
			if _, dup := seen[parsed.Version]; dup {
				return errInvalidRuntimeCatalogResponse
			}
			seen[parsed.Version] = struct{}{}
		}
	}
	return nil
}

func setCatalogEntries(catalog *runtimeCatalog, kind string, entries []catalogEntry) {
	switch kind {
	case KindJava:
		catalog.Java = entries
	case KindNode:
		catalog.Node = entries
	case KindGo:
		catalog.Go = entries
	case KindPython:
		catalog.Python = entries
	}
}

// parseFlexibleTime 判定 fetchedAt 可被 Date.parse 解析为有限时间（对齐 TS
// Number.isFinite(Date.parse(...))；覆盖面板自产与缓存自存的 ISO/日期形态）。
func parseFlexibleTime(value string) bool {
	for _, layout := range []string{
		time.RFC3339Nano,
		"2006-01-02T15:04:05.999Z",
		"2006-01-02T15:04:05",
		"2006-01-02T15:04",
		"2006-01-02 15:04:05",
		"2006-01-02",
	} {
		if _, err := time.Parse(layout, value); err == nil {
			return true
		}
	}
	return false
}

func stringPtr(s string) *string { return &s }
