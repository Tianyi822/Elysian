package websites

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"net/http"
	"path/filepath"
	"time"

	"github.com/go-chi/chi/v5"

	"elysian/server/internal/config"
	"elysian/server/internal/contract"
	"elysian/server/internal/middleware"
	"elysian/server/internal/paths"
	"elysian/server/internal/seam"
	"elysian/server/internal/shared"
)

/*
 * 网站管理片路由（websitesRoutes.ts 逐字移植）。守卫链对齐 database 片：
 * available 为假整片 503 → sameOriginGuard（跨源写 403）→ 各端点 readJsonBody
 * （415/413/400 三拦）。删除是破坏性动作，必须带确认正文 DELETE_WEBSITE_AND_DATA，
 * 缺确认 400。GET 列表与日志保持只读无副作用。
 *
 * 片内次序：503（可用性）→ 403（同源）→ 415/413/400（读体）→ 端点 → 404 兜底
 * （Hono 缺省纯文本 404——TS 版未注册 notFound，正文不承诺逐字、前端不消费）。
 * 体读取上限分两档：POST / 与 PUT /:id/access 用 256 KiB，其余写端点用缺省 64 KiB。
 */

// unavailableMsg 整片不可用的固定文案（非 Docker 模式与容器闸门不满足同文案）。
const unavailableMsg = "真实网站管理仅在 Docker 环境可用"

// serviceUnavailableMsg 防御性兜底（现有装配下不可达，文案登记错误表）。
const serviceUnavailableMsg = "网站服务不可用"

// Deps 网站片的依赖注入。前七个字段是 go-plan §3.8 冻结的跨域形状；其余为域内
// 可注入项（测试用；nil/空落生产实现）。
type Deps struct {
	// EngineAvailable 容器片就绪事实（docker.Stack.Ready）：false 时整片 503。
	EngineAvailable bool
	// Engine Engine API 传输器（HTTP-over-unix，/v1.41 由传输层拼接）。
	Engine seam.DockerTransport
	// Views 容器片共享视图（镜像/容器列表、挂载根策略、自容器 ID）。
	Views seam.DockerViews
	// SelfID 面板自身容器 ID（空串 = 未识别；删除时自容器保护）。
	SelfID string
	// PortOpener 直连端口的防火墙自动开放（firewall 域实现；nil 恒 skipped）。
	PortOpener seam.PortOpener
	// Logs 日志接缝（本域无 WS/显式记录路径，保留冻结形状；当前不消费）。
	Logs seam.Logs
	// Cfg 运行配置（CaddySocket / MountRoot）；nil 落缺省值。
	Cfg *config.Config

	// ---- 域内可注入项（测试用） ----
	// Registry 网站登记；nil 用文件版 ~/.Elysian/config/websites.json。
	Registry Registry
	// RegistryPath 文件版登记路径覆盖（Registry 为 nil 时生效）。
	RegistryPath string
	// Certificates 证书存储；nil 用文件版 ~/.Elysian/config/website-certificates。
	Certificates CertificateStore
	// CertificatesDir 文件版证书目录覆盖（Certificates 为 nil 时生效）。
	CertificatesDir string
	// TrustedRoots 证书校验受信根；nil 用系统根池。
	TrustedRoots []*x509.Certificate
	// RuntimeCatalog 版本目录服务；nil 用官方抓取 + 文件缓存版。
	RuntimeCatalog catalogSource
	// CatalogCachePath 版本目录持久缓存路径覆盖。
	CatalogCachePath string
	// Caddy Caddy 通道覆盖（缺省按 Cfg.CaddySocket 拨真实 socket）。
	Caddy caddyChannel
	// Docker 引擎操作层覆盖（缺省经 Engine/Views 组装）。
	Docker dockerOps
	// PortBindings 宿主端口绑定视图覆盖（缺省摊平 Views.ListContainers）。
	PortBindings func(ctx context.Context) ([]contract.PortBindingView, error)
	// Now 可控时钟；nil 用 time.Now。
	Now func() time.Time
}

// websiteServiceInterface 路由层的服务视图（生产实现与测试假件共用形状）。
type websiteServiceInterface interface {
	RuntimeCatalog(ctx context.Context) (runtimeCatalogReport, error)
	List(ctx context.Context) (websiteListReport, error)
	Create(ctx context.Context, input createRequest) (mutateResult, error)
	Update(ctx context.Context, id string, input updateRequest) (websiteProject, error)
	SetAccess(ctx context.Context, id string, access accessInput) (mutateResult, error)
	SetRunning(ctx context.Context, id string, running bool) (websiteProject, error)
	Logs(ctx context.Context, id string) ([]string, error)
	Remove(ctx context.Context, id string) error
	ReconcileProxy(ctx context.Context) (websiteProxyStatus, error)
}

// NewRouter 网站管理子路由器工厂（app 装配按 shared.WebsitesMount 挂载，
// go-plan §3.8 冻结签名）。EngineAvailable 为假（本地非 Docker 演示、容器闸门
// 不满足或 socket 未就绪）时任意方法任意路径恒 503，同源守卫与读体都不挂。
func NewRouter(deps Deps) chi.Router {
	r := chi.NewRouter()
	if !deps.EngineAvailable || deps.Engine == nil || deps.Views == nil {
		// chi 的 NotFound 不经过 Use 中间件，503 短路须以全捕获路由承载。
		unavailable := unavailableHandler(unavailableMsg)
		r.Handle("/", unavailable)
		r.Handle("/*", unavailable)
		return r
	}
	mountService(r, newProductionService(deps))
	return r
}

// newProductionService 按真实接线组装编排服务。
func newProductionService(deps Deps) websiteServiceInterface {
	caddySocket := CaddyDefaultSocketPath
	mountRoot := "/srv"
	if deps.Cfg != nil {
		if deps.Cfg.CaddySocket != "" {
			caddySocket = deps.Cfg.CaddySocket
		}
		if deps.Cfg.MountRoot != "" {
			mountRoot = deps.Cfg.MountRoot
		}
	}
	now := deps.Now
	if now == nil {
		now = time.Now
	}
	registry := deps.Registry
	if registry == nil {
		registryPath := deps.RegistryPath
		if registryPath == "" {
			registryPath = filepath.Join(paths.ConfigDir, "websites.json")
		}
		registry = NewFileWebsiteRegistry(registryPath)
	}
	certificates := deps.Certificates
	if certificates == nil {
		certificatesDir := deps.CertificatesDir
		if certificatesDir == "" {
			certificatesDir = filepath.Join(paths.ConfigDir, "website-certificates")
		}
		certificates = NewFileWebsiteCertificateStore(certificatesDir)
	}
	caddy := deps.Caddy
	if caddy == nil {
		caddy = caddyChannelAdapter{admin: NewCaddyAdmin(caddySocket), listen: CaddyAdminListen(caddySocket)}
	}
	docker := deps.Docker
	if docker == nil {
		docker = NewWebsiteDocker(deps.Engine, deps.Views.ListImages)
	}
	portBindings := deps.PortBindings
	if portBindings == nil {
		portBindings = func(ctx context.Context) ([]contract.PortBindingView, error) {
			containers, err := deps.Views.ListContainers(ctx)
			if err != nil {
				return nil, err
			}
			bindings := make([]contract.PortBindingView, 0, len(containers))
			for _, container := range containers {
				bindings = append(bindings, container.Ports...)
			}
			return bindings, nil
		}
	}
	opener := deps.PortOpener
	if opener == nil {
		opener = seam.NoopPortOpener()
	}
	catalog := deps.RuntimeCatalog
	if catalog == nil {
		cachePath := deps.CatalogCachePath
		if cachePath == "" {
			cachePath = paths.Default.WebsiteRuntimeCatalog
		}
		catalog = NewRuntimeCatalogService(func(ctx context.Context) (runtimeCatalog, error) {
			return FetchWebsiteRuntimeCatalog(ctx, nil, now().UTC().Format("2006-01-02"))
		}, now, NewFileRuntimeCatalogCache(cachePath), catalogCacheTTL)
	}
	service := NewWebsiteService(serviceDeps{
		registry:     registry,
		docker:       docker,
		caddy:        caddy,
		certificates: certificates,
		trustedRoots: deps.TrustedRoots,
		mountRoot:    mountRoot,
		reservedPorts: func() []int {
			if deps.Views != nil {
				return deps.Views.Policy().ReservedPorts
			}
			return nil
		}(),
		runtimeCatalog:   catalog,
		listPortBindings: portBindings,
		selfContainerID:  deps.SelfID,
		openFirewallPort: func(ctx context.Context, port int, note string) contract.FirewallPortSync {
			return opener.EnsurePortRule(ctx, port, note)
		},
	})
	service.deployments = productionDeploymentManager(service, deploymentEngine{transport: deps.Engine})
	return service
}

// caddyChannelAdapter seam.CaddyAdmin + adminListen 的服务视图适配。
type caddyChannelAdapter struct {
	admin  seam.CaddyAdmin
	listen string
}

func (a caddyChannelAdapter) AdminListen() string { return a.listen }

func (a caddyChannelAdapter) CurrentConfig(ctx context.Context) (json.RawMessage, *seam.CaddyChannelError) {
	return a.admin.CurrentConfig(ctx)
}

func (a caddyChannelAdapter) Load(ctx context.Context, config []byte) *seam.CaddyChannelError {
	return a.admin.Load(ctx, config)
}

// mountService 可用态的端点注册（同源守卫 → 错误映射 → 九个端点 → 404 兜底）。
func mountService(r chi.Router, service websiteServiceInterface) {
	r.Use(middleware.SameOriginGuard())
	r.Use(middleware.EndpointErrorHandler)
	if concrete, ok := service.(*websiteService); ok && concrete.deployments != nil {
		mountDeploymentRoutes(r, concrete.deployments)
	}

	guard := func(w http.ResponseWriter) {
		// 防御性兜底：现有装配下 service 恒可用，分支不可达，文案登记错误表。
		shared.SendError(w, http.StatusServiceUnavailable, serviceUnavailableMsg)
	}

	r.Get("/", func(w http.ResponseWriter, req *http.Request) {
		if service == nil {
			guard(w)
			return
		}
		report, err := service.List(req.Context())
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		shared.SendJSON(w, http.StatusOK, report)
	})
	r.Get("/runtimes", func(w http.ResponseWriter, req *http.Request) {
		if service == nil {
			guard(w)
			return
		}
		report, err := service.RuntimeCatalog(req.Context())
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		shared.SendJSON(w, http.StatusOK, report)
	})
	r.Post("/", func(w http.ResponseWriter, req *http.Request) {
		if service == nil {
			guard(w)
			return
		}
		body, err := middleware.ReadJSONBody(w, req, 256*1024)
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		input, err := validateWebsiteCreateRequest(body)
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		result, err := service.Create(req.Context(), input)
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		shared.SendJSON(w, http.StatusCreated, result)
	})
	r.Put("/{id}", func(w http.ResponseWriter, req *http.Request) {
		if service == nil {
			guard(w)
			return
		}
		body, err := middleware.ReadJSONBody(w, req, 0)
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		input, err := validateWebsiteUpdateRequest(body)
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		project, err := service.Update(req.Context(), chi.URLParam(req, "id"), input)
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		shared.SendJSON(w, http.StatusOK, project)
	})
	r.Put("/{id}/access", func(w http.ResponseWriter, req *http.Request) {
		if service == nil {
			guard(w)
			return
		}
		body, err := middleware.ReadJSONBody(w, req, 256*1024)
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		input, err := validateWebsiteAccessRequest(body)
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		result, err := service.SetAccess(req.Context(), chi.URLParam(req, "id"), input)
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		shared.SendJSON(w, http.StatusOK, result)
	})
	r.Post("/{id}/running", func(w http.ResponseWriter, req *http.Request) {
		if service == nil {
			guard(w)
			return
		}
		body, err := middleware.ReadJSONBody(w, req, 0)
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		running, ok := object(body)["running"].(bool)
		if !ok {
			middleware.WriteError(w, shared.InvalidRequest("启停状态须为布尔值"))
			return
		}
		project, err := service.SetRunning(req.Context(), chi.URLParam(req, "id"), running)
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		shared.SendJSON(w, http.StatusOK, project)
	})
	r.Get("/{id}/logs", func(w http.ResponseWriter, req *http.Request) {
		if service == nil {
			guard(w)
			return
		}
		lines, err := service.Logs(req.Context(), chi.URLParam(req, "id"))
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Pragma", "no-cache")
		shared.SendJSON(w, http.StatusOK, logsBody{Logs: lines})
	})
	r.Post("/proxy/reconcile", func(w http.ResponseWriter, req *http.Request) {
		if service == nil {
			guard(w)
			return
		}
		proxy, err := service.ReconcileProxy(req.Context())
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		shared.SendJSON(w, http.StatusOK, reconcileBody{
			Proxy:   proxy,
			Applied: proxy.State == ProxyStateActive && proxy.Detail == nil,
		})
	})
	r.Delete("/{id}", func(w http.ResponseWriter, req *http.Request) {
		if service == nil {
			guard(w)
			return
		}
		body, err := middleware.ReadJSONBody(w, req, 0)
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		if text, _ := object(body)["confirm"].(string); text != "DELETE_WEBSITE_AND_DATA" {
			middleware.WriteError(w, shared.InvalidRequest("必须确认删除站点及数据"))
			return
		}
		if err := service.Remove(req.Context(), chi.URLParam(req, "id")); err != nil {
			middleware.WriteError(w, err)
			return
		}
		shared.SendJSON(w, http.StatusOK, okBody{OK: true})
	})

	attachFallback(r)
}

// attachFallback 404 兜底：TS 版 websitesRoutes 未注册 notFound，未知路径与方法
// 回落 Hono 缺省纯文本 404（正文不承诺逐字、前端不消费）。
func attachFallback(r chi.Router) {
	fallback := func(w http.ResponseWriter, req *http.Request) {
		http.Error(w, "404 Not Found", http.StatusNotFound)
	}
	r.NotFound(fallback)
	r.MethodNotAllowed(fallback)
}

// unavailableHandler 整片 503 处理器（任意方法含未知路径，先于同源守卫）。
func unavailableHandler(message string) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		shared.SendError(w, http.StatusServiceUnavailable, message)
	}
}

// logsBody / reconcileBody / okBody 响应形状（键序即输出序）。
type logsBody struct {
	Logs []string `json:"logs"`
}

type reconcileBody struct {
	Proxy   websiteProxyStatus `json:"proxy"`
	Applied bool               `json:"applied"`
}

type okBody struct {
	OK bool `json:"ok"`
}
