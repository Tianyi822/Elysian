package websites

import (
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"sort"
	"strconv"
)

/*
 * Caddy 配置生成与判读的纯函数集（caddyConfig.ts 逐字移植）：零 IO。
 * 面板对宿主 Caddy 的驱动方式是整配置原子替换（POST /load）——配置永远由登记
 * 全量重新推导，路由按域名排序生成保证同输入同输出（可复现、可测）。
 */

const (
	caddyServerName      = "elysian"
	caddyRedirectServer  = "elysian_http"
	caddyProxyHandler    = "reverse_proxy"
	caddyRedirectHandler = "static_response"
)

// CaddyManagedSite 面板管理的一个域名站点投影：只有域名模式生成反向代理路由。
type CaddyManagedSite struct {
	Domain         string
	Port           int
	CertificatePEM *string
	PrivateKeyPEM  *string
}

// caddyAdminSection / caddyLogging / caddyApps 配置骨架（键序即 TS 对象插入序）。
type caddyAdminSection struct {
	Listen string `json:"listen"`
}

type caddyLoggingSection struct {
	Logs caddyLogsRoot `json:"logs"`
}

type caddyLogsRoot struct {
	Default caddyLogLevel `json:"default"`
}

type caddyLogLevel struct {
	Level string `json:"level"`
}

type caddyApps struct {
	HTTP caddyHTTPApp `json:"http"`
	TLS  caddyTLSApp  `json:"tls"`
}

type caddyHTTPApp struct {
	Servers map[string]caddyServer `json:"servers"`
}

type caddyTLSApp struct {
	Certificates caddyCertificates `json:"certificates"`
}

type caddyCertificates struct {
	LoadPEM []caddyLoadedPEM `json:"load_pem"`
}

type caddyLoadedPEM struct {
	Certificate string `json:"certificate"`
	Key         string `json:"key"`
}

type caddyServer struct {
	Listen                []string       `json:"listen"`
	TLSConnectionPolicies []struct{}     `json:"tls_connection_policies,omitempty"`
	AutomaticHTTPS        caddyAutoHTTPS `json:"automatic_https"`
	Routes                []caddyRoute   `json:"routes"`
}

type caddyAutoHTTPS struct {
	Disable bool `json:"disable"`
}

type caddyRoute struct {
	Match  []caddyHostMatcher `json:"match"`
	Handle []json.RawMessage  `json:"handle"`
}

type caddyHostMatcher struct {
	Host []string `json:"host"`
}

type caddyProxyHandle struct {
	Handler   string          `json:"handler"`
	Upstreams []caddyUpstream `json:"upstreams"`
}

type caddyUpstream struct {
	Dial string `json:"dial"`
}

type caddyRedirectHandle struct {
	Handler    string               `json:"handler"`
	StatusCode string               `json:"status_code"`
	Headers    caddyRedirectHeaders `json:"headers"`
}

type caddyRedirectHeaders struct {
	Location []string `json:"Location"`
}

// caddyConfigRoot 整配置根（键序 admin → logging → apps）。
type caddyConfigRoot struct {
	Admin   caddyAdminSection   `json:"admin"`
	Logging caddyLoggingSection `json:"logging"`
	Apps    caddyApps           `json:"apps"`
}

// BuildCaddyConfig 从登记投影生成 Caddy 原生 JSON 配置：域名站一律 reverse_proxy 到
// 127.0.0.1:<port>（容器端口发布的宿主回环）。无域名站点不生成路由；80 全量重定向
// 443；两个 server 都关自动签发。
func BuildCaddyConfig(sites []CaddyManagedSite, adminListen string) []byte {
	ordered := make([]CaddyManagedSite, len(sites))
	copy(ordered, sites)
	// 路由按域名 `<` 比较、certificates/redirect 按 localeCompare 排序——域名经
	// 校验层统一小写 ASCII，两种序一致，同输入同输出。
	sort.SliceStable(ordered, func(i, j int) bool { return ordered[i].Domain < ordered[j].Domain })
	routes := make([]caddyRoute, 0, len(ordered))
	for _, site := range ordered {
		handle, _ := marshalJSONCompact(caddyProxyHandle{
			Handler:   caddyProxyHandler,
			Upstreams: []caddyUpstream{{Dial: "127.0.0.1:" + strconv.Itoa(site.Port)}},
		})
		routes = append(routes, caddyRoute{
			Match:  []caddyHostMatcher{{Host: []string{site.Domain}}},
			Handle: []json.RawMessage{handle},
		})
	}
	redirectRoutes := make([]caddyRoute, 0, len(ordered))
	certificates := make([]caddyLoadedPEM, 0, len(ordered))
	for _, site := range ordered {
		handle, _ := marshalJSONCompact(caddyRedirectHandle{
			Handler:    caddyRedirectHandler,
			StatusCode: "308",
			Headers:    caddyRedirectHeaders{Location: []string{"https://" + site.Domain + "{http.request.uri}"}},
		})
		redirectRoutes = append(redirectRoutes, caddyRoute{
			Match:  []caddyHostMatcher{{Host: []string{site.Domain}}},
			Handle: []json.RawMessage{handle},
		})
		if site.CertificatePEM != nil && site.PrivateKeyPEM != nil {
			certificates = append(certificates, caddyLoadedPEM{Certificate: *site.CertificatePEM, Key: *site.PrivateKeyPEM})
		}
	}
	config := caddyConfigRoot{
		Admin:   caddyAdminSection{Listen: adminListen},
		Logging: caddyLoggingSection{Logs: caddyLogsRoot{Default: caddyLogLevel{Level: "WARN"}}},
		Apps: caddyApps{
			HTTP: caddyHTTPApp{Servers: map[string]caddyServer{
				caddyServerName: {
					Listen:                []string{":443"},
					TLSConnectionPolicies: []struct{}{{}},
					AutomaticHTTPS:        caddyAutoHTTPS{Disable: true},
					Routes:                routes,
				},
				caddyRedirectServer: {
					Listen:         []string{":80"},
					AutomaticHTTPS: caddyAutoHTTPS{Disable: true},
					Routes:         redirectRoutes,
				},
			}},
			TLS: caddyTLSApp{Certificates: caddyCertificates{LoadPEM: certificates}},
		},
	}
	data, err := marshalJSONCompact(config)
	if err != nil {
		// 配置骨架不含不可编码值，此处仅为签名完备。
		return nil
	}
	return data
}

// ManagedHosts 从当前配置提取面板管理 server（apps.http.servers.elysian）的路由 host
// 集合。形状不符（空配置、被外部清空的配置）返回空集合——调用方按「期望路由全部缺失」
// 呈现漂移，不在这里编造。
func ManagedHosts(config any) map[string]struct{} {
	hosts := map[string]struct{}{}
	server, ok := caddyManagedServer(config)
	if !ok {
		return hosts
	}
	routes, ok := server["routes"].([]any)
	if !ok {
		return hosts
	}
	for _, route := range routes {
		row, ok := route.(map[string]any)
		if !ok {
			continue
		}
		matchers, ok := row["match"].([]any)
		if !ok {
			continue
		}
		for _, matcher := range matchers {
			m, ok := matcher.(map[string]any)
			if !ok {
				continue
			}
			hostList, ok := m["host"].([]any)
			if !ok {
				continue
			}
			for _, host := range hostList {
				text, ok := host.(string)
				if ok && text != "" {
					hosts[text] = struct{}{}
				}
			}
		}
	}
	return hosts
}

// hasForeignAppsOrServers 面板写出的配置仅有 http、tls app 和两个命名 server；
// 出现其他键即外部配置。
func hasForeignAppsOrServers(config any) bool {
	root, ok := config.(map[string]any)
	if !ok {
		return false
	}
	appsRaw, present := root["apps"]
	if !present {
		return false
	}
	apps, ok := appsRaw.(map[string]any)
	if !ok {
		return true
	}
	for key := range apps {
		if key != "http" && key != "tls" {
			return true
		}
	}
	if tlsRaw, hasTLS := apps["tls"]; hasTLS {
		tls, ok := tlsRaw.(map[string]any)
		if !ok {
			return true
		}
		for key := range tls {
			if key != "certificates" {
				return true
			}
		}
		if certificatesRaw, hasCerts := tls["certificates"]; hasCerts {
			certificates, ok := certificatesRaw.(map[string]any)
			if !ok {
				return true
			}
			for key := range certificates {
				if key != "load_pem" {
					return true
				}
			}
		}
	}
	if httpRaw, hasHTTP := apps["http"]; hasHTTP {
		http, ok := httpRaw.(map[string]any)
		if !ok {
			return true
		}
		if serversRaw, hasServers := http["servers"]; hasServers {
			servers, ok := serversRaw.(map[string]any)
			if !ok {
				return true
			}
			for key := range servers {
				if key != caddyServerName && key != caddyRedirectServer {
					return true
				}
			}
		}
	}
	return false
}

// HasForeignConfig 外部 app、server、未知域名或 admin 监听不匹配时拒绝覆盖。删除时
// 调用方把删除前登记域名作为已知集合传入（同一 admin socket 下的未知域名路由也视为
// 外部配置）。
func HasForeignConfig(config any, expectedHosts map[string]struct{}, adminListen string) bool {
	if hasForeignAppsOrServers(config) {
		return true
	}
	if adminListen != "" {
		if m, ok := config.(map[string]any); ok {
			if adminRaw, present := m["admin"]; present {
				if admin, ok := adminRaw.(map[string]any); ok {
					if listen, hasListen := admin["listen"]; hasListen {
						if text, isText := listen.(string); !isText || text != adminListen {
							return true
						}
					}
				}
			}
		}
	}
	for host := range ManagedHosts(config) {
		if _, known := expectedHosts[host]; !known {
			return true
		}
	}
	return false
}

// MissingHosts 期望域名集合中不在当前配置里的部分（漂移探测：降级期间创建的域名站点、
// 外部重置）。
func MissingHosts(expectedHosts map[string]struct{}, config any) map[string]struct{} {
	current := ManagedHosts(config)
	missing := map[string]struct{}{}
	for host := range expectedHosts {
		if _, ok := current[host]; !ok {
			missing[host] = struct{}{}
		}
	}
	return missing
}

// caddyManagedServer 取 apps.http.servers.elysian；形状不符回 false。
func caddyManagedServer(config any) (map[string]any, bool) {
	root, ok := config.(map[string]any)
	if !ok {
		return nil, false
	}
	apps, ok := root["apps"].(map[string]any)
	if !ok {
		return nil, false
	}
	http, ok := apps["http"].(map[string]any)
	if !ok {
		return nil, false
	}
	servers, ok := http["servers"].(map[string]any)
	if !ok {
		return nil, false
	}
	server, ok := servers[caddyServerName].(map[string]any)
	if !ok {
		return nil, false
	}
	return server, true
}

// AppliedManagedHosts 只核对面板负责的路由三要素：域名、处理器、目标。额外字段由
// Caddy 自行维护。443 server 的监听若含 :80或缺 :443，整体按未应用处理。
func AppliedManagedHosts(sites []CaddyManagedSite, config any) map[string]struct{} {
	applied := map[string]struct{}{}
	server, ok := caddyManagedServer(config)
	if !ok {
		return applied
	}
	listen, ok := server["listen"].([]any)
	if !ok {
		return applied
	}
	has443, has80 := false, false
	for _, item := range listen {
		if text, isText := item.(string); isText {
			switch text {
			case ":443":
				has443 = true
			case ":80":
				has80 = true
			}
		}
	}
	if !has443 || has80 {
		return applied
	}
	routes, ok := server["routes"].([]any)
	if !ok {
		routes = []any{}
	}
	for _, site := range sites {
		if siteApplied(routes, site.Domain, site.Port) {
			applied[site.Domain] = struct{}{}
		}
	}
	return applied
}

// siteApplied 核对单个站点：恰有一条域名路由、match/handle 各恰一项、host 数组恰含
// 该域名、handle 为 reverse_proxy 且唯一 upstream dial == 127.0.0.1:<port>。
func siteApplied(routes []any, domain string, port int) bool {
	var domainRoutes []any
	for _, route := range routes {
		row, ok := route.(map[string]any)
		if !ok {
			continue
		}
		matchers, ok := row["match"].([]any)
		if !ok {
			continue
		}
		for _, matcher := range matchers {
			m, ok := matcher.(map[string]any)
			if !ok {
				continue
			}
			hostList, ok := m["host"].([]any)
			if !ok {
				continue
			}
			for _, host := range hostList {
				if text, isText := host.(string); isText && text == domain {
					domainRoutes = append(domainRoutes, route)
					break
				}
			}
		}
	}
	if len(domainRoutes) != 1 {
		return false
	}
	route, ok := domainRoutes[0].(map[string]any)
	if !ok {
		return false
	}
	matchers, ok := route["match"].([]any)
	if !ok || len(matchers) != 1 {
		return false
	}
	handles, ok := route["handle"].([]any)
	if !ok || len(handles) != 1 {
		return false
	}
	matcher, ok := matchers[0].(map[string]any)
	if !ok {
		return false
	}
	hostList, ok := matcher["host"].([]any)
	if !ok || len(hostList) != 1 {
		return false
	}
	if text, isText := hostList[0].(string); !isText || text != domain {
		return false
	}
	handle, ok := handles[0].(map[string]any)
	if !ok {
		return false
	}
	if handler, isText := handle["handler"].(string); !isText || handler != caddyProxyHandler {
		return false
	}
	upstreams, ok := handle["upstreams"].([]any)
	if !ok || len(upstreams) != 1 {
		return false
	}
	upstream, ok := upstreams[0].(map[string]any)
	if !ok {
		return false
	}
	dial, isText := upstream["dial"].(string)
	return isText && dial == "127.0.0.1:"+strconv.Itoa(port)
}

// AppliedCertificateFingerprints 与登记的叶证书指纹核对；只反映 Caddy 已加载配置，
// 不代表公网可达。坏 PEM 跳过（漂移显示为未下发）。
func AppliedCertificateFingerprints(config any) map[string]struct{} {
	fingerprints := map[string]struct{}{}
	m, ok := config.(map[string]any)
	if !ok {
		return fingerprints
	}
	apps, ok := m["apps"].(map[string]any)
	if !ok {
		return fingerprints
	}
	tls, ok := apps["tls"].(map[string]any)
	if !ok {
		return fingerprints
	}
	certificates, ok := tls["certificates"].(map[string]any)
	if !ok {
		return fingerprints
	}
	loaded, ok := certificates["load_pem"].([]any)
	if !ok {
		return fingerprints
	}
	for _, item := range loaded {
		row, ok := item.(map[string]any)
		if !ok {
			continue
		}
		certificate, ok := row["certificate"].(string)
		if !ok {
			continue
		}
		parsed, valid := parseSingleCertificatePEM(certificate)
		if !valid {
			continue
		}
		fingerprints[certificateFingerprint256(parsed)] = struct{}{}
	}
	return fingerprints
}

// parseSingleCertificatePEM 解析证书 PEM 的首个 CERTIFICATE 块（对齐 Node
// X509Certificate 取首块语义：登记材料是叶证书+中间证书的整链 PEM，指纹取叶证书）。
func parseSingleCertificatePEM(text string) (*x509.Certificate, bool) {
	blocks := pemCertificateBlock.FindAllString(text, -1)
	if len(blocks) == 0 {
		return nil, false
	}
	decoded, _ := pem.Decode([]byte(blocks[0]))
	if decoded == nil {
		return nil, false
	}
	certificate, err := x509.ParseCertificate(decoded.Bytes)
	if err != nil {
		return nil, false
	}
	return certificate, true
}
