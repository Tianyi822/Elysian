package firewall

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"elysian/server/internal/middleware"
	"elysian/server/internal/shared"
)

// firewallRoutes.test.ts 的对等测试：fake service 经挂载后的路由器驱动（chi 父应用
// 与 app 同构：StripTailSlash + Mount），断言分发、参数传递与守卫次序。

const sampleOrigin = "http://localhost:5173"

var sampleRule = FirewallRule{
	ID: "ufw-allow-in-tcp-8080-any.ipv4", Protocol: "tcp", Port: 8080, PortTo: nil,
	Family: "ipv4", Status: "unused", Policy: "allow", Direction: "inbound",
	Source: SourceAllIPs, Note: nil, UpdatedAt: nil,
}

var sampleIpRule = FirewallIpRule{
	ID: "ufwip-deny-from-203.0.113.9.ipv4", Source: "203.0.113.9", Family: "ipv4",
	Policy: "deny", Note: nil, UpdatedAt: nil,
}

var sampleForward = FirewallForwardRule{
	ID: "fwd-tcp-8080-10.0.0.5-80", Protocol: "tcp", Port: 8080, PortTo: nil,
	TargetHost: "10.0.0.5", TargetPort: 80, Note: nil, UpdatedAt: nil,
}

var sampleToggles = FirewallToggles{
	FirewallEnabled: false, PingBlocked: false,
	DefaultIncoming: strp("deny"), DefaultOutgoing: strp("allow"),
}

func scanFixture(enabled bool) FirewallScanProtection {
	cfg := DefaultScanConfig()
	return FirewallScanProtection{
		Enabled: enabled,
		Config:  cfg,
		Stats:   FirewallScanStats{},
		Blocked: []FirewallBlockedIp{},
	}
}

// fakeService 可按方法覆盖的假服务。
type fakeService struct {
	list           func() ([]FirewallRule, error)
	toggles        func() (FirewallToggles, error)
	setToggles     func(FirewallToggles) (FirewallToggles, error)
	create         func(RuleInput) (FirewallRule, error)
	update         func(string, RuleInput) (FirewallRule, error)
	remove         func(string) error
	importRules    func([]RuleInput) (ImportResult, error)
	listIpRules    func() ([]FirewallIpRule, error)
	createIpRule   func(IpRuleInput) (FirewallIpRule, error)
	updateIpRule   func(string, IpRuleInput) (FirewallIpRule, error)
	removeIpRule   func(string) error
	listForwards   func() ([]FirewallForwardRule, error)
	createForward  func(ForwardInput) (FirewallForwardRule, error)
	updateForward  func(string, ForwardInput) (FirewallForwardRule, error)
	removeForward  func(string) error
	scanProtection func() (FirewallScanProtection, error)
	setScanProt    func(bool) (FirewallScanProtection, error)
	setScanConfig  func(ScanConfig) (FirewallScanProtection, error)
	unblockIp      func(string) (FirewallScanProtection, error)
	sync           func() (int, error)
}

func (f *fakeService) List() ([]FirewallRule, error) {
	if f.list != nil {
		return f.list()
	}
	return []FirewallRule{sampleRule}, nil
}

func (f *fakeService) Toggles() (FirewallToggles, error) {
	if f.toggles != nil {
		return f.toggles()
	}
	return sampleToggles, nil
}

func (f *fakeService) SetToggles(t FirewallToggles) (FirewallToggles, error) {
	if f.setToggles != nil {
		return f.setToggles(t)
	}
	return t, nil
}

func (f *fakeService) Create(in RuleInput) (FirewallRule, error) {
	if f.create != nil {
		return f.create(in)
	}
	return sampleRule, nil
}

func (f *fakeService) Update(id string, in RuleInput) (FirewallRule, error) {
	if f.update != nil {
		return f.update(id, in)
	}
	return sampleRule, nil
}

func (f *fakeService) Remove(id string) error {
	if f.remove != nil {
		return f.remove(id)
	}
	return nil
}

func (f *fakeService) ImportRules(inputs []RuleInput) (ImportResult, error) {
	if f.importRules != nil {
		return f.importRules(inputs)
	}
	return ImportResult{Added: []FirewallRule{sampleRule}, Skipped: 0}, nil
}

func (f *fakeService) ListIpRules() ([]FirewallIpRule, error) {
	if f.listIpRules != nil {
		return f.listIpRules()
	}
	return []FirewallIpRule{sampleIpRule}, nil
}

func (f *fakeService) CreateIpRule(in IpRuleInput) (FirewallIpRule, error) {
	if f.createIpRule != nil {
		return f.createIpRule(in)
	}
	return sampleIpRule, nil
}

func (f *fakeService) UpdateIpRule(id string, in IpRuleInput) (FirewallIpRule, error) {
	if f.updateIpRule != nil {
		return f.updateIpRule(id, in)
	}
	return sampleIpRule, nil
}

func (f *fakeService) RemoveIpRule(id string) error {
	if f.removeIpRule != nil {
		return f.removeIpRule(id)
	}
	return nil
}

func (f *fakeService) ListForwards() ([]FirewallForwardRule, error) {
	if f.listForwards != nil {
		return f.listForwards()
	}
	return []FirewallForwardRule{sampleForward}, nil
}

func (f *fakeService) CreateForward(in ForwardInput) (FirewallForwardRule, error) {
	if f.createForward != nil {
		return f.createForward(in)
	}
	return sampleForward, nil
}

func (f *fakeService) UpdateForward(id string, in ForwardInput) (FirewallForwardRule, error) {
	if f.updateForward != nil {
		return f.updateForward(id, in)
	}
	return sampleForward, nil
}

func (f *fakeService) RemoveForward(id string) error {
	if f.removeForward != nil {
		return f.removeForward(id)
	}
	return nil
}

func (f *fakeService) ScanProtection() (FirewallScanProtection, error) {
	if f.scanProtection != nil {
		return f.scanProtection()
	}
	return scanFixture(true), nil
}

func (f *fakeService) SetScanProtection(enabled bool) (FirewallScanProtection, error) {
	if f.setScanProt != nil {
		return f.setScanProt(enabled)
	}
	return scanFixture(enabled), nil
}

func (f *fakeService) SetScanConfig(config ScanConfig) (FirewallScanProtection, error) {
	if f.setScanConfig != nil {
		return f.setScanConfig(config)
	}
	scan := scanFixture(true)
	scan.Config = config
	return scan, nil
}

func (f *fakeService) UnblockIp(ip string) (FirewallScanProtection, error) {
	if f.unblockIp != nil {
		return f.unblockIp(ip)
	}
	return scanFixture(true), nil
}

func (f *fakeService) SyncFromSystem() (int, error) {
	if f.sync != nil {
		return f.sync()
	}
	return 2, nil
}

// mountApp 与 app 装配同构的父应用：剥尾斜杠 + 挂载 + 统一错误映射（错误映射在
// 域路由器内部）。
func mountApp(deps Deps) http.Handler {
	parent := chi.NewRouter()
	parent.Use(middleware.StripTailSlash)
	parent.Mount(shared.FirewallMount, NewRouter(deps))
	return parent
}

// requestOf 构造发往挂载后端点的请求；默认同源合法头（Origin 与 Host 一致）。
func requestOf(method, path string, body string, headers map[string]string) *http.Request {
	req := httptest.NewRequest(method, sampleOrigin+shared.FirewallMount+path, bytes.NewReader([]byte(body)))
	req.Host = "localhost:5173"
	req.Header.Set("Origin", sampleOrigin)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	return req
}

func jsonRequest(method, path string, body any) *http.Request {
	payload, _ := json.Marshal(body)
	return requestOf(method, path, string(payload), map[string]string{
		"Content-Type": "application/json",
	})
}

func doJSON(t *testing.T, handler http.Handler, req *http.Request) (int, map[string]any) {
	t.Helper()
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("响应不是 JSON：%q", rec.Body.String())
	}
	return rec.Code, body
}

func TestRouterUnavailable503(t *testing.T) {
	app := mountApp(Deps{Available: false})

	code, body := doJSON(t, app, requestOf("GET", "", "", nil))
	if code != 503 || body["error"] != "真实防火墙仅在 Docker 容器内可用" {
		t.Errorf("不可用一律 503 且文案逐字：%d %v", code, body)
	}
	code, _ = doJSON(t, app, requestOf("POST", "/nope/deeper", "{}", map[string]string{"Content-Type": "application/json"}))
	if code != 503 {
		t.Errorf("未知路径也应 503：%d", code)
	}
}

func TestRouterRoot(t *testing.T) {
	app := mountApp(Deps{Available: true, service: &fakeService{}})
	code, body := doJSON(t, app, requestOf("GET", "", "", nil))
	if code != 200 {
		t.Fatalf("挂载根应 200：%d", code)
	}
	if body["toggles"] == nil || body["rules"] == nil {
		t.Errorf("根响应应含 toggles 与 rules：%v", body)
	}
	rules, _ := body["rules"].([]any)
	if len(rules) != 1 {
		t.Errorf("rules 应为全量：%v", body["rules"])
	}
	toggles := body["toggles"].(map[string]any)
	if toggles["firewallEnabled"] != false || toggles["defaultIncoming"] != "deny" {
		t.Errorf("toggles 内容错误：%v", toggles)
	}
}

func TestRouterPutTogglesIgnoresRequestDefaults(t *testing.T) {
	app := mountApp(Deps{Available: true, service: &fakeService{}})

	code, body := doJSON(t, app, jsonRequest("PUT", "/toggles", map[string]any{
		"firewallEnabled": true,
		"pingBlocked":     true,
		"defaultIncoming": "allow",
	}))
	if code != 200 {
		t.Fatalf("PUT /toggles 应 200：%d", code)
	}
	toggles := body["toggles"].(map[string]any)
	if toggles["firewallEnabled"] != true || toggles["pingBlocked"] != true {
		t.Errorf("开关值应传递：%v", toggles)
	}
	if toggles["defaultIncoming"] != nil || toggles["defaultOutgoing"] != nil {
		t.Errorf("请求里的默认策略不采信（恒 null 由 service 回读）：%v", toggles)
	}
}

func TestRouterPostRulesPassesThrough(t *testing.T) {
	var gotInput *RuleInput
	svc := &fakeService{create: func(in RuleInput) (FirewallRule, error) {
		gotInput = &in
		return sampleRule, nil
	}}
	app := mountApp(Deps{Available: true, service: svc})

	code, _ := doJSON(t, app, jsonRequest("POST", "/rules", map[string]any{
		"protocol": "tcp", "port": 1000, "portTo": 2000, "policy": "limit", "source": SourceAllIPs,
	}))
	if code != 200 {
		t.Fatalf("POST /rules 应 200：%d", code)
	}
	if gotInput == nil || gotInput.Protocol != "tcp" || gotInput.Port != 1000 ||
		gotInput.PortTo == nil || *gotInput.PortTo != 2000 || gotInput.Policy != "limit" || gotInput.Source != SourceAllIPs {
		t.Errorf("端口段应透传：%+v", gotInput)
	}
}

func TestRouterDeleteRulesDecodesID(t *testing.T) {
	removed := []string{}
	svc := &fakeService{remove: func(id string) error {
		removed = append(removed, id)
		return nil
	}}
	app := mountApp(Deps{Available: true, service: svc})

	code, body := doJSON(t, app, requestOf("DELETE", "/rules/ufw-allow-in-tcp-8080-any.ipv4", "", nil))
	if code != 200 || body["ok"] != true {
		t.Fatalf("DELETE 应 200 {ok:true}：%d %v", code, body)
	}
	if len(removed) != 1 || removed[0] != "ufw-allow-in-tcp-8080-any.ipv4" {
		t.Errorf("应解码规则标识：%v", removed)
	}
}

func TestRouterImportAndSync(t *testing.T) {
	app := mountApp(Deps{Available: true, service: &fakeService{}})

	code, body := doJSON(t, app, jsonRequest("POST", "/rules/import", map[string]any{
		"rules": []any{map[string]any{"protocol": "tcp", "port": 3306}},
	}))
	if code != 200 || body["skipped"] != float64(0) {
		t.Errorf("导入转发错误：%d %v", code, body)
	}

	code, body = doJSON(t, app, requestOf("POST", "/sync", "", nil))
	if code != 200 || body["total"] != float64(2) {
		t.Errorf("POST /sync 应返回同步总数：%d %v", code, body)
	}
}

func TestRouterScanEndpoints(t *testing.T) {
	calls := []string{}
	svc := &fakeService{
		scanProtection: func() (FirewallScanProtection, error) {
			calls = append(calls, "read")
			scan := scanFixture(true)
			scan.Stats = FirewallScanStats{TotalBlockedIps: 1, TotalFailedConnections: 9, CurrentBlockedIps: 1, CurrentFailedConnections: 9}
			scan.Blocked = []FirewallBlockedIp{{IP: "203.0.113.9", BlockedAt: "2026-09-19T00:00:00.000Z"}}
			return scan, nil
		},
		setScanProt: func(enabled bool) (FirewallScanProtection, error) {
			calls = append(calls, fmt.Sprintf("%v", enabled))
			return scanFixture(enabled), nil
		},
	}
	app := mountApp(Deps{Available: true, service: svc})

	code, body := doJSON(t, app, requestOf("GET", "/scan", "", nil))
	if code != 200 {
		t.Fatalf("GET /scan 应 200：%d", code)
	}
	if stats := body["stats"].(map[string]any); stats["totalBlockedIps"] != float64(1) {
		t.Errorf("统计应透传：%v", body)
	}

	code, body = doJSON(t, app, jsonRequest("POST", "/scan/toggle", map[string]any{"enabled": false}))
	if code != 200 || body["enabled"] != false {
		t.Errorf("POST /scan/toggle 应走真实 service：%d %v", code, body)
	}
	if len(calls) != 2 || calls[0] != "read" || calls[1] != "false" {
		t.Errorf("调用次序错误：%v", calls)
	}

	code, _ = doJSON(t, app, jsonRequest("POST", "/scan/toggle", map[string]any{"enabled": "yes"}))
	if code != 400 {
		t.Errorf("开关值非布尔应 400：%d", code)
	}
}

func TestRouterPutScanConfig(t *testing.T) {
	var gotConfig *ScanConfig
	svc := &fakeService{setScanConfig: func(config ScanConfig) (FirewallScanProtection, error) {
		gotConfig = &config
		scan := scanFixture(true)
		scan.Config = config
		return scan, nil
	}}
	app := mountApp(Deps{Available: true, service: svc})

	code, body := doJSON(t, app, jsonRequest("PUT", "/scan/config", map[string]any{
		"ports": []any{22.0, 8080.0}, "windowSeconds": 120, "hitCount": 5, "banSeconds": 1800,
	}))
	if code != 200 {
		t.Fatalf("PUT /scan/config 应 200：%d", code)
	}
	if gotConfig == nil || len(gotConfig.Ports) != 2 || gotConfig.Ports[0] != 22 || gotConfig.Ports[1] != 8080 ||
		gotConfig.WindowSeconds != 120 || gotConfig.HitCount != 5 || gotConfig.BanSeconds != 1800 {
		t.Errorf("配置应传递：%+v", gotConfig)
	}
	if cfg := body["config"].(map[string]any); cfg["hitCount"] != float64(5) {
		t.Errorf("响应配置错误：%v", body)
	}
}

func TestRouterScanUnblock(t *testing.T) {
	unblocked := []string{}
	svc := &fakeService{unblockIp: func(ip string) (FirewallScanProtection, error) {
		unblocked = append(unblocked, ip)
		return scanFixture(true), nil
	}}
	app := mountApp(Deps{Available: true, service: svc})

	code, _ := doJSON(t, app, jsonRequest("POST", "/scan/unblock", map[string]any{"ip": " 203.0.113.9 "}))
	if code != 200 {
		t.Fatalf("POST /scan/unblock 应 200：%d", code)
	}
	if len(unblocked) != 1 || unblocked[0] != "203.0.113.9" {
		t.Errorf("ip 应 trim 后传递：%v", unblocked)
	}
	code, _ = doJSON(t, app, jsonRequest("POST", "/scan/unblock", map[string]any{"ip": ""}))
	if code != 400 {
		t.Errorf("空 ip 应 400：%d", code)
	}
	code, _ = doJSON(t, app, jsonRequest("POST", "/scan/unblock", map[string]any{"ip": 42}))
	if code != 400 {
		t.Errorf("非字符串 ip 应 400：%d", code)
	}
}

func TestRouterIpRuleEndpoints(t *testing.T) {
	calls := []string{}
	svc := &fakeService{
		listIpRules: func() ([]FirewallIpRule, error) {
			calls = append(calls, "list")
			return []FirewallIpRule{sampleIpRule}, nil
		},
		createIpRule: func(in IpRuleInput) (FirewallIpRule, error) {
			calls = append(calls, "create:"+in.Source)
			return sampleIpRule, nil
		},
		updateIpRule: func(id string, in IpRuleInput) (FirewallIpRule, error) {
			calls = append(calls, "update:"+id+":"+in.Policy)
			return sampleIpRule, nil
		},
		removeIpRule: func(id string) error {
			calls = append(calls, "remove:"+id)
			return nil
		},
	}
	app := mountApp(Deps{Available: true, service: svc})

	code, body := doJSON(t, app, requestOf("GET", "/ip-rules", "", nil))
	if code != 200 {
		t.Fatalf("GET /ip-rules 应 200：%d", code)
	}
	if rules, _ := body["rules"].([]any); len(rules) != 1 {
		t.Errorf("rules 错误：%v", body)
	}
	doJSON(t, app, jsonRequest("POST", "/ip-rules", map[string]any{"policy": "deny", "source": "203.0.113.9"}))
	doJSON(t, app, jsonRequest("PUT", "/ip-rules/"+sampleIpRule.ID, map[string]any{"policy": "allow", "source": "203.0.113.9"}))
	doJSON(t, app, requestOf("DELETE", "/ip-rules/"+sampleIpRule.ID, "", nil))
	want := []string{"list", "create:203.0.113.9", "update:" + sampleIpRule.ID + ":allow", "remove:" + sampleIpRule.ID}
	if strings.Join(calls, "|") != strings.Join(want, "|") {
		t.Errorf("调用序列错误：%v（want %v）", calls, want)
	}
}

func TestRouterForwardEndpoints(t *testing.T) {
	calls := []string{}
	svc := &fakeService{
		listForwards: func() ([]FirewallForwardRule, error) {
			calls = append(calls, "list")
			return []FirewallForwardRule{sampleForward}, nil
		},
		createForward: func(in ForwardInput) (FirewallForwardRule, error) {
			calls = append(calls, fmt.Sprintf("create:%v->%s:%v", in.Port, in.TargetHost, in.TargetPort))
			return sampleForward, nil
		},
		updateForward: func(id string, _ ForwardInput) (FirewallForwardRule, error) {
			calls = append(calls, "update:"+id)
			return sampleForward, nil
		},
		removeForward: func(id string) error {
			calls = append(calls, "remove:"+id)
			return nil
		},
	}
	app := mountApp(Deps{Available: true, service: svc})

	code, body := doJSON(t, app, requestOf("GET", "/forwards", "", nil))
	if code != 200 {
		t.Fatalf("GET /forwards 应 200：%d", code)
	}
	if rules, _ := body["rules"].([]any); len(rules) != 1 {
		t.Errorf("rules 错误：%v", body)
	}
	doJSON(t, app, jsonRequest("POST", "/forwards", map[string]any{
		"protocol": "tcp", "port": 8080, "targetHost": "10.0.0.5", "targetPort": 80,
	}))
	doJSON(t, app, jsonRequest("PUT", "/forwards/"+sampleForward.ID, map[string]any{
		"protocol": "tcp", "port": 8080, "targetHost": "10.0.0.5", "targetPort": 80,
	}))
	doJSON(t, app, requestOf("DELETE", "/forwards/"+sampleForward.ID, "", nil))
	want := []string{"list", "create:8080->10.0.0.5:80", "update:" + sampleForward.ID, "remove:" + sampleForward.ID}
	if strings.Join(calls, "|") != strings.Join(want, "|") {
		t.Errorf("调用序列错误：%v（want %v）", calls, want)
	}
}

func TestRouterInvalidRequestKeepsStatus(t *testing.T) {
	svc := &fakeService{
		createForward: func(ForwardInput) (FirewallForwardRule, error) {
			return FirewallForwardRule{}, shared.InvalidRequest(fmt.Sprintf("面板端口不允许配置转发：外部端口段覆盖 %d（工作台自身的访问通道）", PanelPort))
		},
		setScanConfig: func(ScanConfig) (FirewallScanProtection, error) {
			return FirewallScanProtection{}, &shared.InvalidRequestError{Status: 409, Message: "防扫描未启用：先开启开关再调整配置"}
		},
	}
	app := mountApp(Deps{Available: true, service: svc})

	code, body := doJSON(t, app, jsonRequest("POST", "/forwards", map[string]any{
		"protocol": "tcp", "port": PanelPort, "targetHost": "10.0.0.5", "targetPort": 8080,
	}))
	if code != 400 || body["error"] != fmt.Sprintf("面板端口不允许配置转发：外部端口段覆盖 %d（工作台自身的访问通道）", PanelPort) {
		t.Errorf("请求被拒应按自带状态码 4xx 且中文原因原样带回：%d %v", code, body)
	}
	code, body = doJSON(t, app, jsonRequest("PUT", "/scan/config", map[string]any{
		"ports": []any{22.0}, "windowSeconds": 60, "hitCount": 8, "banSeconds": 3600,
	}))
	if code != 409 || body["error"] != "防扫描未启用：先开启开关再调整配置" {
		t.Errorf("前置状态不满足应 409：%d %v", code, body)
	}
}

func TestRouterSystemSideError500(t *testing.T) {
	svc := &fakeService{create: func(RuleInput) (FirewallRule, error) {
		return FirewallRule{}, fmt.Errorf("ufw 执行失败（allow 8080/tcp）：ERROR: problem running ufw init")
	}}
	app := mountApp(Deps{Available: true, service: svc})

	code, body := doJSON(t, app, jsonRequest("POST", "/rules", map[string]any{"protocol": "tcp", "port": 8080, "source": SourceAllIPs}))
	if code != 500 || body["error"] != "ufw 执行失败（allow 8080/tcp）：ERROR: problem running ufw init" {
		t.Errorf("系统侧失败应 500 且中文错误返回：%d %v", code, body)
	}
}

func TestRouterUnknownEndpoint404(t *testing.T) {
	app := mountApp(Deps{Available: true, service: &fakeService{}})

	code, body := doJSON(t, app, requestOf("GET", "/nowhere", "", nil))
	if code != 404 || body["error"] != "未知防火墙端点：GET /nowhere" {
		t.Errorf("未知端点 404 文案应剥挂载前缀后逐字一致：%d %v", code, body)
	}

	// 已注册路径但方法不匹配：Hono all('*') 同样回未知端点。
	code, body = doJSON(t, app, requestOf("GET", "/toggles", "", nil))
	if code != 404 || body["error"] != "未知防火墙端点：GET /toggles" {
		t.Errorf("方法不匹配应走同一兜底：%d %v", code, body)
	}
}

func TestRouterBadJSON400(t *testing.T) {
	app := mountApp(Deps{Available: true, service: &fakeService{}})

	req := requestOf("PUT", "/toggles", "not-json", map[string]string{"Content-Type": "application/json"})
	code, body := doJSON(t, app, req)
	if code != 400 || body["error"] != "请求体不是有效 JSON" {
		t.Errorf("非 JSON 体应 400 带中文错误：%d %v", code, body)
	}
}

func TestRouterMissingShapeFallsThroughToService(t *testing.T) {
	var gotInput *RuleInput
	svc := &fakeService{create: func(in RuleInput) (FirewallRule, error) {
		gotInput = &in
		return FirewallRule{}, fmt.Errorf("端口无效：NaN（应为 1–65535 的整数）")
	}}
	app := mountApp(Deps{Available: true, service: svc})

	code, body := doJSON(t, app, jsonRequest("POST", "/rules", map[string]any{}))
	if code != 500 {
		t.Logf("NaN 透传由 service 校验：%d %v", code, body)
	}
	if gotInput == nil || gotInput.Protocol != "tcp" || gotInput.Source != "" {
		t.Errorf("缺形状按缺省转发 service：%+v", gotInput)
	}
	if gotInput != nil {
		if !isNaN(gotInput.Port) {
			t.Errorf("缺失 port 应宽进为 NaN：%v", gotInput.Port)
		}
	}
}

func TestRouterCrossOrigin403BeforeBody(t *testing.T) {
	called := false
	svc := &fakeService{setToggles: func(t FirewallToggles) (FirewallToggles, error) {
		called = true
		return t, nil
	}}
	app := mountApp(Deps{Available: true, service: svc})

	// 请求体故意不是合法 JSON：若守卫晚于读体，这里会变成解析错误而非 403。
	req := requestOf("PUT", "/toggles", "not-json", map[string]string{
		"Origin":       "http://evil.example",
		"Content-Type": "application/json",
	})
	code, body := doJSON(t, app, req)
	if code != 403 || body["error"] != "请求来源不允许" {
		t.Errorf("跨源 PUT 应在读体之前 403：%d %v", code, body)
	}
	if called {
		t.Error("守卫拒绝时 service 不应被调用")
	}
}

func TestRouterTextPlain415(t *testing.T) {
	app := mountApp(Deps{Available: true, service: &fakeService{}})

	req := requestOf("POST", "/rules", "{}", map[string]string{"Content-Type": "text/plain"})
	code, body := doJSON(t, app, req)
	if code != 415 || body["error"] != "Content-Type 必须为 application/json" {
		t.Errorf("text/plain 应 415：%d %v", code, body)
	}
}

func TestRouterOversizedBody413(t *testing.T) {
	app := mountApp(Deps{Available: true, service: &fakeService{}})

	// 申报即超限：不看流直接拒。
	req := requestOf("POST", "/rules", "{}", map[string]string{"Content-Type": "application/json"})
	req.ContentLength = 64*1024 + 1
	code, _ := doJSON(t, app, req)
	if code != 413 {
		t.Errorf("申报超限应 413：%d", code)
	}

	// 谎报 content-length：实读累计字节数兜底。体本身是合法 JSON，只有体积守卫能拒。
	oversized := `{"note":"` + strings.Repeat("a", 64*1024) + `"}`
	req = requestOf("POST", "/rules", oversized, map[string]string{"Content-Type": "application/json"})
	req.ContentLength = 2
	code, body := doJSON(t, app, req)
	if code != 413 || body["error"] != "请求体过大" {
		t.Errorf("实读超限应 413 带中文错误：%d %v", code, body)
	}
}

func TestRouterSameOriginRelaxed(t *testing.T) {
	app := mountApp(Deps{Available: true, service: &fakeService{}})

	code, _ := doJSON(t, app, jsonRequest("PUT", "/toggles", map[string]any{"firewallEnabled": true, "pingBlocked": false}))
	if code != 200 {
		t.Errorf("同源写请求应正常通过：%d", code)
	}

	// 大小写归一：Host 大小写不同仍视为同源；带 charset 的 Content-Type 前缀匹配放行。
	req := requestOf("POST", "/scan/toggle", `{"enabled":false}`, map[string]string{
		"Content-Type": "application/json; charset=utf-8",
	})
	req.Host = "LOCALHOST:5173"
	code, _ = doJSON(t, app, req)
	if code != 200 {
		t.Errorf("大小写归一与 charset 前缀应放行：%d", code)
	}
}

// ---------- 路由 + 真实 service 的状态码回归（盘点 §8 firewallRoutes.test.ts 末段） ----------

func TestRouterRealServiceStatusCodes(t *testing.T) {
	fake := createFakeDeps(fakeUfwDepsSeed{})
	fake.readWrapper = func(path string, _ func() (string, error)) (string, error) {
		// 无防扫描段的普通规则文件：读状态据此回报「防扫描未启用」。
		return "# before.rules\n*filter\n:ufw-before-input - [0:0]\nCOMMIT\n", nil
	}
	writes := []string{}
	fake.ufwWrapper = func(args []string, _ func() (string, error)) (string, error) {
		return "", fmt.Errorf("测试里不应执行 ufw：%s", strings.Join(args, " "))
	}
	app := mountApp(Deps{Available: true, host: &recordingDeps{fake: fake, writes: &writes}})

	// POST /forwards 命中面板端口：400 + 中文原因，不落盘。
	code, body := doJSON(t, app, jsonRequest("POST", "/forwards", map[string]any{
		"protocol": "tcp", "port": PanelPort, "targetHost": "10.0.0.5", "targetPort": 8080,
	}))
	if code != 400 || body["error"] != fmt.Sprintf("面板端口不允许配置转发：外部端口段覆盖 %d（工作台自身的访问通道）", PanelPort) {
		t.Errorf("面板端口应 400 且零落盘：%d %v", code, body)
	}
	if len(writes) != 0 {
		t.Errorf("不应落盘：%v", writes)
	}

	// 目标地址是网段：400 + 中文原因。
	code, body = doJSON(t, app, jsonRequest("POST", "/forwards", map[string]any{
		"protocol": "tcp", "port": 9090, "targetHost": "10.0.0.0/24", "targetPort": 8080,
	}))
	if code != 400 || body["error"] != "目标地址无效：10.0.0.0/24（应为单个 IPv4 地址，不含网段）" {
		t.Errorf("网段目标应 400：%d %v", code, body)
	}

	// 防扫描未启用：409（前置状态不满足，不是请求体错误）。
	code, body = doJSON(t, app, jsonRequest("PUT", "/scan/config", map[string]any{
		"ports": []any{22.0}, "windowSeconds": 60, "hitCount": 8, "banSeconds": 3600,
	}))
	if code != 409 || body["error"] != "防扫描未启用：先开启开关再调整配置" {
		t.Errorf("未启用应 409：%d %v", code, body)
	}

	// 含面板端口：400，且校验先于开关状态（未启用也按面板端口拒绝）。
	code, body = doJSON(t, app, jsonRequest("PUT", "/scan/config", map[string]any{
		"ports": []any{22.0, float64(PanelPort)}, "windowSeconds": 60, "hitCount": 8, "banSeconds": 3600,
	}))
	if code != 400 || body["error"] != fmt.Sprintf("面板端口不允许加入防扫描监控：%d 是工作台自身的访问通道", PanelPort) {
		t.Errorf("面板端口应 400 且校验先于开关状态：%d %v", code, body)
	}
	if len(writes) != 0 {
		t.Errorf("拒绝不落盘：%v", writes)
	}
}

// recordingDeps 记录落盘的替身接线。
type recordingDeps struct {
	fake   *fakeUfwDeps
	writes *[]string
}

func (r *recordingDeps) RunUfw(args []string) (string, error) {
	return r.fake.RunUfw(args)
}

func (r *recordingDeps) RunSs() (string, error) { return r.fake.RunSs() }

func (r *recordingDeps) RunIptables(args []string) (string, error) {
	return r.fake.RunIptables(args)
}

func (r *recordingDeps) RunIp6tables(args []string) (string, error) {
	return r.fake.RunIp6tables(args)
}

func (r *recordingDeps) ReadText(path string) (string, error) { return r.fake.ReadText(path) }

func (r *recordingDeps) WriteText(path, content string) error {
	*r.writes = append(*r.writes, path)
	return r.fake.WriteText(path, content)
}

func (r *recordingDeps) Exists(path string) bool { return r.fake.Exists(path) }

func (r *recordingDeps) NowIso() string { return r.fake.NowIso() }

func (r *recordingDeps) Paths() FirewallPaths { return r.fake.Paths() }

func (r *recordingDeps) RuleTimes() ruleTimes { return nil }

// isNaN 与 math.IsNaN 等价（局部小助手，避免测试文件到处 import math）。
func isNaN(f float64) bool { return f != f }
