package firewall

import (
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"elysian/server/internal/middleware"
	"elysian/server/internal/seam"
	"elysian/server/internal/shared"
)

// /api/security/firewall 路由（firewallRoutes.ts 等价物）：路由层保持薄，只做分发、
// 守卫调用、请求体解析与 service 调用，业务校验留在 service 层。子路由器内的经手
// 次序：503（可用性）→ 403（同源）→ 415/413/400（读体）→ 端点 → 404 兜底。

// Service 防火墙片的服务接口（TS FirewallAdapter 等价物；路由与测试共用）。
type Service interface {
	List() ([]FirewallRule, error)
	Toggles() (FirewallToggles, error)
	SetToggles(FirewallToggles) (FirewallToggles, error)
	Create(RuleInput) (FirewallRule, error)
	Update(ruleId string, input RuleInput) (FirewallRule, error)
	Remove(ruleId string) error
	ImportRules(inputs []RuleInput) (ImportResult, error)
	ListIpRules() ([]FirewallIpRule, error)
	CreateIpRule(IpRuleInput) (FirewallIpRule, error)
	UpdateIpRule(ruleId string, input IpRuleInput) (FirewallIpRule, error)
	RemoveIpRule(ruleId string) error
	ListForwards() ([]FirewallForwardRule, error)
	CreateForward(ForwardInput) (FirewallForwardRule, error)
	UpdateForward(ruleId string, input ForwardInput) (FirewallForwardRule, error)
	RemoveForward(ruleId string) error
	ScanProtection() (FirewallScanProtection, error)
	SetScanProtection(enabled bool) (FirewallScanProtection, error)
	SetScanConfig(config ScanConfig) (FirewallScanProtection, error)
	UnblockIp(ip string) (FirewallScanProtection, error)
	SyncFromSystem() (int, error)
}

// Deps 路由工厂的注入形状（go-plan §3.8 跨域字段 + 域内测试注入口）。
type Deps struct {
	// Available 为 false 时一切请求 503（非容器/非裸机的强制保护）。
	Available bool
	// DBPath 规则时间账本路径（paths.ElysianPaths.FirewallSqlite）。
	DBPath string
	// Now 为 nil 用 time.Now。
	Now func() time.Time

	// 以下为域内测试注入口，装配层不设值：Service 非 nil 时路由直接使用（fake
	// service 驱动）；否则 host 非 nil 时在其上构造真实 service（不跑启动恢复），
	// 两者都空时走生产装配（接线 + 账本 + 启动恢复）。
	service Service
	host    hostDeps
}

// NewRouter 构造防火墙片子路由器：自带 503/403/读体/404 兜底，由 internal/app 按
// 固定次序挂载到 shared.FirewallMount。
func NewRouter(deps Deps) chi.Router {
	if !deps.Available {
		// 整片 503：任意方法、含未知路径，容器边界保护先于一切守卫。
		r := chi.NewRouter()
		r.HandleFunc("/*", func(w http.ResponseWriter, _ *http.Request) {
			shared.SendError(w, http.StatusServiceUnavailable, "真实防火墙仅在 Docker 容器内可用")
		})
		return r
	}
	svc := deps.service
	if svc == nil {
		if deps.host != nil {
			svc = newService(deps.host)
		} else {
			svc = assembleRealService(deps.DBPath, deps.Now)
		}
	}
	return newRouterWithService(svc)
}

// NewPortOpener 构造端口自动开放接缝（供 websites/database 域创建时联动）。
// 永不返回 error，一切结果以 contract.FirewallPortSync 带回；不可用时与装配层注入
// NoopPortOpener 同行为（恒 skipped）。
func NewPortOpener(deps Deps) seam.PortOpener {
	if !deps.Available {
		return seam.NoopPortOpener()
	}
	// ensurePortRule 只读 show added 与执行 allow，用不到时间账本，不开 sqlite。
	return portOpenerService{host: newExecHostDeps("", deps.Now)}
}

// ---------- 路由装配 ----------

type rootBody struct {
	Toggles FirewallToggles `json:"toggles"`
	Rules   []FirewallRule  `json:"rules"`
}

type togglesBody struct {
	Toggles FirewallToggles `json:"toggles"`
}

type ruleBody struct {
	Rule FirewallRule `json:"rule"`
}

type ipRuleBody struct {
	Rule FirewallIpRule `json:"rule"`
}

type forwardBody struct {
	Rule FirewallForwardRule `json:"rule"`
}

type okBody struct {
	OK bool `json:"ok"`
}

type rulesListBody struct {
	Rules []FirewallIpRule `json:"rules"`
}

type forwardsListBody struct {
	Rules []FirewallForwardRule `json:"rules"`
}

type totalBody struct {
	Total int `json:"total"`
}

func newRouterWithService(svc Service) chi.Router {
	r := chi.NewRouter()
	// panic 兜底走同一条错误映射路径（go-plan §3.3）。
	r.Use(middleware.EndpointErrorHandler)
	// 同源守卫先于读体：跨源写请求在解析任何请求体之前就被拒绝（未知路径同样先过守卫）。
	r.Use(middleware.SameOriginGuard())

	r.Get("/", func(w http.ResponseWriter, req *http.Request) {
		toggles, err := svc.Toggles()
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		rules, err := svc.List()
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		shared.SendJSON(w, http.StatusOK, rootBody{Toggles: toggles, Rules: rules})
	})

	r.Put("/toggles", func(w http.ResponseWriter, req *http.Request) {
		body, ok := readJSONBody(w, req)
		if !ok {
			return
		}
		toggles, err := parseToggles(body)
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		result, err := svc.SetToggles(toggles)
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		shared.SendJSON(w, http.StatusOK, togglesBody{Toggles: result})
	})

	r.Post("/rules", func(w http.ResponseWriter, req *http.Request) {
		body, ok := readJSONBody(w, req)
		if !ok {
			return
		}
		input, err := parseRuleInput(body)
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		rule, err := svc.Create(input)
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		shared.SendJSON(w, http.StatusOK, ruleBody{Rule: rule})
	})

	r.Put("/rules/{id}", func(w http.ResponseWriter, req *http.Request) {
		body, ok := readJSONBody(w, req)
		if !ok {
			return
		}
		input, err := parseRuleInput(body)
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		rule, err := svc.Update(chi.URLParam(req, "id"), input)
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		shared.SendJSON(w, http.StatusOK, ruleBody{Rule: rule})
	})

	r.Delete("/rules/{id}", func(w http.ResponseWriter, req *http.Request) {
		if err := svc.Remove(chi.URLParam(req, "id")); err != nil {
			middleware.WriteError(w, err)
			return
		}
		shared.SendJSON(w, http.StatusOK, okBody{OK: true})
	})

	r.Post("/rules/import", func(w http.ResponseWriter, req *http.Request) {
		body, ok := readJSONBody(w, req)
		if !ok {
			return
		}
		inputs, err := parseRuleInputList(body)
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		result, err := svc.ImportRules(inputs)
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		shared.SendJSON(w, http.StatusOK, result)
	})

	// 不读请求体（无 415/413/空体校验），但仍过同源守卫（POST 非 GET）。
	r.Post("/sync", func(w http.ResponseWriter, _ *http.Request) {
		total, err := svc.SyncFromSystem()
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		shared.SendJSON(w, http.StatusOK, totalBody{Total: total})
	})

	// IP 规则（纯来源封禁）。
	r.Get("/ip-rules", func(w http.ResponseWriter, _ *http.Request) {
		rules, err := svc.ListIpRules()
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		shared.SendJSON(w, http.StatusOK, rulesListBody{Rules: rules})
	})
	r.Post("/ip-rules", func(w http.ResponseWriter, req *http.Request) {
		body, ok := readJSONBody(w, req)
		if !ok {
			return
		}
		input, err := parseIpRuleInput(body)
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		rule, err := svc.CreateIpRule(input)
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		shared.SendJSON(w, http.StatusOK, ipRuleBody{Rule: rule})
	})
	r.Put("/ip-rules/{id}", func(w http.ResponseWriter, req *http.Request) {
		body, ok := readJSONBody(w, req)
		if !ok {
			return
		}
		input, err := parseIpRuleInput(body)
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		rule, err := svc.UpdateIpRule(chi.URLParam(req, "id"), input)
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		shared.SendJSON(w, http.StatusOK, ipRuleBody{Rule: rule})
	})
	r.Delete("/ip-rules/{id}", func(w http.ResponseWriter, req *http.Request) {
		if err := svc.RemoveIpRule(chi.URLParam(req, "id")); err != nil {
			middleware.WriteError(w, err)
			return
		}
		shared.SendJSON(w, http.StatusOK, okBody{OK: true})
	})

	// 端口转发（DNAT）。
	r.Get("/forwards", func(w http.ResponseWriter, _ *http.Request) {
		rules, err := svc.ListForwards()
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		shared.SendJSON(w, http.StatusOK, forwardsListBody{Rules: rules})
	})
	r.Post("/forwards", func(w http.ResponseWriter, req *http.Request) {
		body, ok := readJSONBody(w, req)
		if !ok {
			return
		}
		input, err := parseForwardInput(body)
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		rule, err := svc.CreateForward(input)
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		shared.SendJSON(w, http.StatusOK, forwardBody{Rule: rule})
	})
	r.Put("/forwards/{id}", func(w http.ResponseWriter, req *http.Request) {
		body, ok := readJSONBody(w, req)
		if !ok {
			return
		}
		input, err := parseForwardInput(body)
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		rule, err := svc.UpdateForward(chi.URLParam(req, "id"), input)
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		shared.SendJSON(w, http.StatusOK, forwardBody{Rule: rule})
	})
	r.Delete("/forwards/{id}", func(w http.ResponseWriter, req *http.Request) {
		if err := svc.RemoveForward(chi.URLParam(req, "id")); err != nil {
			middleware.WriteError(w, err)
			return
		}
		shared.SendJSON(w, http.StatusOK, okBody{OK: true})
	})

	// 防扫描：与规则同源的真实实现（内核 xt_recent 双名单 jail + iptables 计数）。
	r.Get("/scan", func(w http.ResponseWriter, _ *http.Request) {
		scan, err := svc.ScanProtection()
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		shared.SendJSON(w, http.StatusOK, scan)
	})
	r.Post("/scan/toggle", func(w http.ResponseWriter, req *http.Request) {
		body, ok := readJSONBody(w, req)
		if !ok {
			return
		}
		row, _ := bodyRow(body)
		enabled, ok := row["enabled"].(bool)
		if !ok {
			middleware.WriteError(w, shared.InvalidRequest("开关值无效"))
			return
		}
		scan, err := svc.SetScanProtection(enabled)
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		shared.SendJSON(w, http.StatusOK, scan)
	})
	r.Put("/scan/config", func(w http.ResponseWriter, req *http.Request) {
		body, ok := readJSONBody(w, req)
		if !ok {
			return
		}
		config, err := parseScanConfigBody(body)
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		scan, err := svc.SetScanConfig(config)
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		shared.SendJSON(w, http.StatusOK, scan)
	})
	r.Post("/scan/unblock", func(w http.ResponseWriter, req *http.Request) {
		body, ok := readJSONBody(w, req)
		if !ok {
			return
		}
		row, _ := bodyRow(body)
		ip, ok := row["ip"].(string)
		if !ok || strings.TrimSpace(ip) == "" {
			middleware.WriteError(w, shared.InvalidRequest("IP 无效"))
			return
		}
		scan, err := svc.UnblockIp(strings.TrimSpace(ip))
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		shared.SendJSON(w, http.StatusOK, scan)
	})

	// 未知端点兜底：剥掉挂载前缀后与「未知防火墙端点：METHOD path」逐字一致
	//（path 为相对路径，剥空归一 /）。方法已注册路径不匹配时同样走这条兜底，
	// 与 Hono 子应用 all('*') 的行为一致。
	notFound := func(w http.ResponseWriter, req *http.Request) {
		path := strings.TrimPrefix(req.URL.Path, shared.FirewallMount)
		if path == "" {
			path = "/"
		}
		shared.SendError(w, http.StatusNotFound, fmt.Sprintf("未知防火墙端点：%s %s", req.Method, path))
	}
	r.NotFound(notFound)
	r.MethodNotAllowed(notFound)

	return r
}

// readJSONBody 读体守卫的薄封装：守卫错误已按状态码写出，回 false 表示响应已发。
func readJSONBody(w http.ResponseWriter, req *http.Request) (any, bool) {
	body, err := middleware.ReadJSONBody(w, req, 0)
	if err != nil {
		middleware.WriteError(w, err)
		return nil, false
	}
	return body, true
}

// ---------- 请求体宽松解析（宽进：结构校验交给 service 的中文报错） ----------

// bodyRow JS `typeof body === 'object'` 的等价判定：对象与数组都算（数组的字段
// 取值恒为 undefined，因此走「缺字段」分支）；null/标量不算。
func bodyRow(body any) (map[string]any, bool) {
	switch v := body.(type) {
	case map[string]any:
		return v, true
	case []any:
		return map[string]any{}, true
	default:
		return nil, false
	}
}

func parseToggles(body any) (FirewallToggles, error) {
	row, ok := bodyRow(body)
	if !ok {
		return FirewallToggles{}, shared.InvalidRequest("开关请求体无效")
	}
	fwEnabled, fwOK := row["firewallEnabled"].(bool)
	pingBlocked, pingOK := row["pingBlocked"].(bool)
	if !fwOK || !pingOK {
		return FirewallToggles{}, shared.InvalidRequest("开关请求体缺少布尔字段")
	}
	// 默认策略是系统侧只读事实：请求里的取值不采信，service 回读真实状态。
	return FirewallToggles{FirewallEnabled: fwEnabled, PingBlocked: pingBlocked}, nil
}

// parsePolicy 宽进：非 deny/limit 一律归 allow。
func parsePolicy(value any) string {
	if value == "deny" {
		return "deny"
	}
	if value == "limit" {
		return "limit"
	}
	return "allow"
}

func strOrNil(row map[string]any, key string) *string {
	if v, ok := row[key].(string); ok {
		return &v
	}
	return nil
}

func parseRuleInput(body any) (RuleInput, error) {
	row, ok := bodyRow(body)
	if !ok {
		return RuleInput{}, shared.InvalidRequest("规则请求体无效")
	}
	var portTo *float64
	if v, exists := row["portTo"]; exists && v != nil {
		n := jsNumber(v)
		portTo = &n
	}
	return RuleInput{
		Protocol:  mapDefault(row["protocol"], "udp", "tcp"),
		Port:      jsNumber(row["port"]),
		PortTo:    portTo,
		Family:    mapDefault(row["family"], "ipv6", "ipv4"),
		Policy:    parsePolicy(row["policy"]),
		Direction: mapDefault(row["direction"], "outbound", "inbound"),
		Source:    strOrEmpty(row["source"]),
		Note:      strOrNil(row, "note"),
	}, nil
}

func parseIpRuleInput(body any) (IpRuleInput, error) {
	row, ok := bodyRow(body)
	if !ok {
		return IpRuleInput{}, shared.InvalidRequest("IP 规则请求体无效")
	}
	return IpRuleInput{
		Policy: parsePolicy(row["policy"]),
		Source: strOrEmpty(row["source"]),
		Note:   strOrNil(row, "note"),
	}, nil
}

func parseForwardInput(body any) (ForwardInput, error) {
	row, ok := bodyRow(body)
	if !ok {
		return ForwardInput{}, shared.InvalidRequest("转发请求体无效")
	}
	var portTo *float64
	if v, exists := row["portTo"]; exists && v != nil {
		n := jsNumber(v)
		portTo = &n
	}
	return ForwardInput{
		Protocol:   mapDefault(row["protocol"], "udp", "tcp"),
		Port:       jsNumber(row["port"]),
		PortTo:     portTo,
		TargetHost: strOrEmpty(row["targetHost"]),
		TargetPort: jsNumber(row["targetPort"]),
		Note:       strOrNil(row, "note"),
	}, nil
}

func parseScanConfigBody(body any) (ScanConfig, error) {
	row, ok := bodyRow(body)
	if !ok {
		return ScanConfig{}, shared.InvalidRequest("防扫描配置请求体无效")
	}
	ports := []float64{}
	if arr, ok := row["ports"].([]any); ok {
		for _, p := range arr {
			ports = append(ports, jsNumber(p))
		}
	}
	return ScanConfig{
		Ports:         ports,
		WindowSeconds: jsNumber(row["windowSeconds"]),
		HitCount:      jsNumber(row["hitCount"]),
		BanSeconds:    jsNumber(row["banSeconds"]),
	}, nil
}

func parseRuleInputList(body any) ([]RuleInput, error) {
	row, ok := bodyRow(body)
	if !ok {
		return nil, shared.InvalidRequest("导入请求体无效")
	}
	rules, ok := row["rules"].([]any)
	if !ok {
		return nil, shared.InvalidRequest("导入请求体缺少规则数组")
	}
	inputs := make([]RuleInput, 0, len(rules))
	for _, item := range rules {
		input, err := parseRuleInput(item)
		if err != nil {
			return nil, err
		}
		inputs = append(inputs, input)
	}
	return inputs, nil
}

// mapDefault 严格等值匹配取 matched，否则取缺省（复刻 JS `=== ? a : b`）。
func mapDefault(value any, matched, def string) string {
	if s, ok := value.(string); ok && s == matched {
		return matched
	}
	return def
}

func strOrEmpty(value any) string {
	if s, ok := value.(string); ok {
		return s
	}
	return ""
}

var _ seam.PortOpener = portOpenerService{}
