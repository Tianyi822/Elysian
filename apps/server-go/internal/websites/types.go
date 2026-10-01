package websites

import (
	"elysian/server/internal/contract"
)

// 域内视图模型与请求形状（@elysian/contracts 网站部分的 Go 版，暂居域内——契约包
// 骨架期未预置网站类型，见返回值 gaps：集成阶段评估是否上移 internal/contract，
// 当前无其他域消费，无跨域冲突）。JSON 键序即结构体声明序（对齐 TS JSON.stringify
// 插入序），前端 websitesHttpAdapter 按这些形状消费。

// 项目类型取值（TS WebsiteProjectKind）。
const (
	KindJava   = "java"
	KindNode   = "node"
	KindGo     = "go"
	KindPython = "python"
	KindHTML   = "html"
)

// 访问模式与运行状态取值。
const (
	AccessModeDirect = "direct"
	AccessModeDomain = "domain"

	RunStateRunning = "running"
	RunStateStopped = "stopped"

	CategoryProduction  = "production"
	CategoryTesting     = "testing"
	CategoryDevelopment = "development"
)

// websiteCertificate 证书公开元数据 + Caddy 配置核对事实（applied）。
type websiteCertificate struct {
	Issuer         string `json:"issuer"`
	NotAfter       string `json:"notAfter"`
	Fingerprint256 string `json:"fingerprint256"`
	Applied        bool   `json:"applied"`
}

// websiteTraffic 流量统计形状：真实实现无统计来源、恒 0，不伪造数字。
type websiteTraffic struct {
	TodayMb int `json:"todayMb"`
	TotalGb int `json:"totalGb"`
}

// websiteProject 列表投影（TS WebsiteProject）。
type websiteProject struct {
	ID             string              `json:"id"`
	Kind           string              `json:"kind"`
	Name           string              `json:"name"`
	Pid            *int                `json:"pid"`
	ContainerID    *string             `json:"containerId"`
	Port           int                 `json:"port"`
	RuntimeVersion *string             `json:"runtimeVersion"`
	RootDir        string              `json:"rootDir"`
	RunState       string              `json:"runState"`
	AccessMode     string              `json:"accessMode"`
	Domain         *string             `json:"domain"`
	RouteApplied   bool                `json:"routeApplied"`
	ExpiryAt       *string             `json:"expiryAt"`
	Note           *string             `json:"note"`
	Certificate    *websiteCertificate `json:"certificate"`
	Category       string              `json:"category"`
	DeployCommand  *string             `json:"deployCommand"`
	GitURL         *string             `json:"gitUrl"`
	Traffic        websiteTraffic      `json:"traffic"`
}

// websiteProxyStatus 反向代理通道状态报告。
type websiteProxyStatus struct {
	State  string  `json:"state"`
	Detail *string `json:"detail"`
}

// websiteListReport 站点列表响应。
type websiteListReport struct {
	Projects []websiteProject   `json:"projects"`
	Proxy    websiteProxyStatus `json:"proxy"`
}

// mutateResult 创建与访问方式切换的结果：项目之外带回直连端口的防火墙自动开放
// 事实（不联动场景为 null）。
type mutateResult struct {
	Project      websiteProject             `json:"project"`
	FirewallPort *contract.FirewallPortSync `json:"firewallPort"`
}

// 代理状态取值。
const (
	ProxyStateActive      = "active"
	ProxyStateUnavailable = "unavailable"
)

// 维护状态取值。
const (
	MaintenanceMaintained = "maintained"
	MaintenanceLegacy     = "legacy"
)

// catalogEntry 正式运行时版本目录的单项（TS WebsiteRuntimeCatalogEntry）。
type catalogEntry struct {
	Version     string `json:"version"`
	Image       string `json:"image"`
	Maintenance string `json:"maintenance"`
	CheckedAt   string `json:"checkedAt"`
}

// runtimeCatalog 四类运行时的版本目录（键序即输出序）。
type runtimeCatalog struct {
	Java   []catalogEntry `json:"java"`
	Node   []catalogEntry `json:"node"`
	Go     []catalogEntry `json:"go"`
	Python []catalogEntry `json:"python"`
}

// runtimeCatalogReport 版本目录报告（TS WebsiteRuntimeCatalogReport）。
type runtimeCatalogReport struct {
	Catalog   runtimeCatalog `json:"catalog"`
	FetchedAt string         `json:"fetchedAt"`
	Stale     bool           `json:"stale"`
	Detail    *string        `json:"detail"`
}
