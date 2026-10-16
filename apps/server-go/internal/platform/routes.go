package platform

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"elysian/server/internal/middleware"
	"elysian/server/internal/seam"
	"elysian/server/internal/shared"
)

// 依赖检测与平台内存路由（platformMemoryRoutes.ts / platformDependenciesRoutes.ts
// 等价物）。落在 platform 域而非三域内：「Docker 缺失」这个事实恰恰要在
// docker/database/websites 三域全 503 时仍拿得到。GET 无容器边界、无同源守卫（读
// 端点豁免同源是既有设计）、无操作审计；探测纯读。POST /dependencies/setup/:target/
// :step 才在宿主上执行安装的一步：必须同源，脚本是服务端常量。非 GET 打到探测路径
// 一律 405。探测有真实宿主成本，故 GET 按固定窗口限流（缺省每 60 秒 30 次，超限 429
// 带 Retry-After）。安装步骤不走这道限额，由 setup 自己保证同时只跑一步。

// 缺省限额与窗口：探测单次成本受 3s/5s 超时约束，30 次/分钟已远超正常使用频率。
const (
	defaultProbeRateLimit = 30
	defaultRateWindow     = 60 * time.Second
)

// 步骤白名单（契约 DOCKER_SETUP_STEPS / CADDY_SETUP_STEPS）。
var (
	dockerSetupSteps = []string{"install", "enable"}
	caddySetupSteps  = []string{"install", "configure", "enable"}
)

// 部署缺省 socket 路径（与 config 缺省同值；Deps 未注入时兜底）。
const (
	defaultDockerSocketPath = "/var/run/docker.sock"
	defaultCaddySocketPath  = "/run/caddy/admin.sock"
)

// Deps 路由装配入参（跨域字段形状按 go-plan §3.8 冻结）。域包不读 env、不自测
// /.dockerenv：socket 路径与容器事实由装配层从 config 注入。带注释的未导出字段是
// 域内测试注入位（包内测试可设，装配层不触及）。
type Deps struct {
	AgentFacade    *AgentFacade
	AgentAuthorize func(context.Context) error
	// Transports 探测/宿主安装每次新建传输器（不缓存结果、不缓存连接状态）。
	// nil 回落 seam 桩。
	Transports seam.DockerTransportFactory
	// CaddyAdmins 按需产出 Caddy 管理通道（探测用）。nil 回落桩。
	CaddyAdmins seam.CaddyAdminFactory
	// InContainer /.dockerenv 实存（hostShell 分支判定，只看文件不看 env）。
	InContainer bool
	// Now 限流窗口时钟；nil 用 time.Now。
	Now func() time.Time

	// DockerSocket Engine socket 路径（cfg.DockerSocket）；空串回落部署缺省。
	DockerSocket string
	// CaddySocket Caddy admin socket 路径（cfg.CaddySocket）；空串回落部署缺省。
	CaddySocket string

	// —— 域内测试注入位（包内测试可设）——
	prober     probeService // 缺省现场探测
	setup      setupService // 缺省真实编排
	readUsage  func() memoryUsage
	probeLimit int           // 0 取缺省 30
	rateWindow time.Duration // 0 取缺省 60s
	execFn     execCommand   // nil 用真实本机执行
}

// NewRouter 构造 /api/platform 子路由器（memory 与 dependencies 同挂此处）；由装配层
// 按 shared.PlatformMount 挂载。方法白名单在 handler 内手写（非框架 405），未知路径
// 与 setup 路径的方法不匹配落 Hono 缺省 404（纯文本，前端不消费）。
func NewRouter(deps Deps) chi.Router {
	if deps.Transports == nil {
		deps.Transports = seam.NoopTransportFactory()
	}
	if deps.CaddyAdmins == nil {
		deps.CaddyAdmins = noopCaddyAdminFactory{}
	}
	if deps.DockerSocket == "" {
		deps.DockerSocket = defaultDockerSocketPath
	}
	if deps.CaddySocket == "" {
		deps.CaddySocket = defaultCaddySocketPath
	}
	if deps.Now == nil {
		deps.Now = time.Now
	}

	proberSrv := deps.prober
	if proberSrv == nil {
		proberSrv = prober{
			createTransport: deps.Transports.New,
			createCaddy:     deps.CaddyAdmins.New,
			dockerSocket:    deps.DockerSocket,
			caddySocket:     deps.CaddySocket,
		}
	}
	setupSrv := deps.setup
	if setupSrv == nil {
		transportFactory := deps.Transports
		dockerSocket := deps.DockerSocket
		setupSrv = newDependencySetup(dependencySetupOptions{
			host: newHostRunner(hostRunnerOptions{
				inContainer: deps.InContainer,
				createTransport: func() seam.DockerTransport {
					return transportFactory.New(dockerSocket)
				},
				exec: deps.execFn,
			}),
			socketPath: func() string { return deps.CaddySocket },
		})
	}
	readUsage := deps.readUsage
	if deps.AgentFacade != nil {
		proberSrv, readUsage = deps.AgentFacade.prober, deps.AgentFacade.usage
	}
	if readUsage == nil {
		readUsage = processMemoryUsage
	}
	limit := deps.probeLimit
	if limit <= 0 {
		limit = defaultProbeRateLimit
	}
	window := deps.rateWindow
	if window <= 0 {
		window = defaultRateWindow
	}
	handler := &dependenciesHandler{
		prober: proberSrv,
		setup:  setupSrv,
		limiter: &rateLimiter{
			windowStart: deps.Now(),
			window:      window,
			limit:       limit,
			now:         deps.Now,
		},
	}

	r := chi.NewRouter()
	registerAllMethods(r, "/memory", memoryHandler(readUsage))
	registerAllMethods(r, "/dependencies", handler.getDependencies)
	r.Post("/dependencies/setup/docker/{step}", handler.setupPost("docker"))
	r.Post("/dependencies/setup/caddy/{step}", handler.setupPost("caddy"))
	r.NotFound(notFoundPlain)
	r.MethodNotAllowed(methodNotAllowed)
	return r
}

// registerAllMethods 在 chi 的全部标准方法上注册同一 handler（chi v5 无 Any；等价
// Hono app.all：任意方法都进 handler，方法白名单由 handler 自判，HEAD 同样 405）。
func registerAllMethods(r chi.Router, pattern string, handler http.HandlerFunc) {
	for _, method := range []string{
		http.MethodGet, http.MethodHead, http.MethodPost, http.MethodPut,
		http.MethodPatch, http.MethodDelete, http.MethodConnect, http.MethodOptions,
		http.MethodTrace,
	} {
		r.MethodFunc(method, pattern, handler)
	}
}

// noopCaddyAdminFactory 装配未接通道时的桩：探测如实报通道未接线（仅供骨架/误装配
// 出现，生产行为不受影响）。
type noopCaddyAdminFactory struct{}

func (noopCaddyAdminFactory) New(string) seam.CaddyAdmin {
	return noopCaddyAdmin{}
}

type noopCaddyAdmin struct{}

func (noopCaddyAdmin) CurrentConfig(context.Context) (json.RawMessage, *seam.CaddyChannelError) {
	return nil, &seam.CaddyChannelError{Message: "Caddy 管理通道尚未接线"}
}

func (noopCaddyAdmin) Load(context.Context, []byte) *seam.CaddyChannelError {
	return &seam.CaddyChannelError{Message: "Caddy 管理通道尚未接线"}
}

// memoryHandler GET /api/platform/memory：非 GET（含 HEAD）一律 405，成功回 MiB 采样。
func memoryHandler(readUsage func() memoryUsage) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if strings.ToUpper(r.Method) != http.MethodGet {
			shared.SendError(w, http.StatusMethodNotAllowed, "只允许 GET")
			return
		}
		shared.SendJSON(w, http.StatusOK, sampleFromUsage(readUsage()))
	}
}

// dependenciesHandler 探测与安装共用的路由状态（app 实例闭包内单实例计数）。
type dependenciesHandler struct {
	prober  probeService
	setup   setupService
	limiter *rateLimiter
}

// getDependencies GET /api/platform/dependencies：现场探测并报事实；非 GET 一律 405
// （不触发探测、不占用限额）；超限 429 带 Retry-After。
func (h *dependenciesHandler) getDependencies(w http.ResponseWriter, r *http.Request) {
	if strings.ToUpper(r.Method) != http.MethodGet {
		shared.SendError(w, http.StatusMethodNotAllowed, "只允许 GET")
		return
	}
	allowed, retryAfter := h.limiter.acquire()
	if !allowed {
		w.Header().Set("Retry-After", strconv.Itoa(retryAfter))
		shared.SendError(w, http.StatusTooManyRequests, "依赖检测请求过于频繁，请稍后再试")
		return
	}
	// 检测结果每次都要新事实，不吃任何缓存。
	w.Header().Set("Cache-Control", "no-store")
	shared.SendJSON(w, http.StatusOK, h.prober.Probe())
}

// setupPost POST /api/platform/dependencies/setup/{target}/:step：同源必查 → 步骤名
// 校验 → 执行；请求体不被读取（目标与步骤全在路径里）。成功 200 {ok,message}、
// 失败 422 {error,message}，均带 cache-control: no-store。
func (h *dependenciesHandler) setupPost(target string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !middleware.SameOrigin(r) {
			shared.SendError(w, http.StatusForbidden, "请求来源不允许")
			return
		}
		step := chi.URLParam(r, "step")
		if !stepAllowed(target, step) {
			shared.SendError(w, http.StatusBadRequest, setupFailureStep)
			return
		}
		result := h.setup.Run(target, step)
		w.Header().Set("Cache-Control", "no-store")
		if !result.OK {
			shared.SendError(w, http.StatusUnprocessableEntity, result.Message)
			return
		}
		shared.SendJSON(w, http.StatusOK, result)
	}
}

// stepAllowed 步骤白名单：docker 只认 install/enable，caddy 还有 configure。
func stepAllowed(target, step string) bool {
	steps := dockerSetupSteps
	if target == "caddy" {
		steps = caddySetupSteps
	}
	for _, candidate := range steps {
		if candidate == step {
			return true
		}
	}
	return false
}

// rateLimiter 固定窗口限流（进程内单实例内存态）：窗口起点初始化于路由器构造时刻，
// 请求时窗口过期先重置清零计数。chi 并发服务，计数以互斥保护（语义与 TS 单线程
// 事件循环一致）。
type rateLimiter struct {
	mu          sync.Mutex
	windowStart time.Time
	window      time.Duration
	limit       int
	served      int
	now         func() time.Time
}

// acquire 返回 (是否放行, 拒绝时的 Retry-After 秒数)。
func (l *rateLimiter) acquire() (bool, int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	if now.Sub(l.windowStart) >= l.window {
		l.windowStart = now
		l.served = 0
	}
	if l.served >= l.limit {
		remaining := l.windowStart.Add(l.window).Sub(now)
		seconds := int(math.Ceil(remaining.Seconds()))
		if seconds < 1 {
			seconds = 1
		}
		return false, seconds
	}
	l.served++
	return true, 0
}

// notFoundPlain 未匹配路径：Hono 缺省 404（纯文本，正文不承诺逐字、前端不消费；
// 鉴权由装配层 requireSession 先行）。
func notFoundPlain(w http.ResponseWriter, _ *http.Request) {
	http.Error(w, "404 Not Found", http.StatusNotFound)
}

// methodNotAllowed 方法不匹配的已知路径：memory/dependencies 对非 GET 恒 405「只允许
// GET」（app.all 白名单手写语义，含 HEAD 与自定义方法）；setup 路径的方法不匹配与
// Hono 一样落 404（Hono 无自动 405）。
func methodNotAllowed(w http.ResponseWriter, r *http.Request) {
	relative := strings.TrimPrefix(r.URL.Path, shared.PlatformMount)
	if relative == "/memory" || relative == "/dependencies" {
		shared.SendError(w, http.StatusMethodNotAllowed, "只允许 GET")
		return
	}
	http.Error(w, "404 Not Found", http.StatusNotFound)
}
