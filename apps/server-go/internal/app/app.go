// Package app 是装配层（go-plan §2）：app.New 逐域挂载与跨域注入 + 跨域 import 守卫
// 测试。本包是唯一允许 import 全部域包的位置。
//
// 完整经手次序（go-plan §3.5，次序即行为）：
//
//	RequestID → StripTailSlash → OperationAudit(logs，仅 /api/*) →
//	RequireSession(auth) → health → auth → platform(memory→dependencies) →
//	firewall → ssh → users → files → terminals → logs → docker →
//	databases → websites → /api 兜底 404（纯文本）→ 非 /api SPA。
//
// OperationAudit 在 RequireSession 之前（401 也落审计），RequireSession 挡全部片
// （豁免恰好四条：/api/health 与 auth 三端点，以 StripTailSlash 剥层前的原始路径剥
// 单个尾斜杠后精确匹配——双尾斜杠形不在豁免清单，无会话必 401）。挂载次序
// 对齐 TS app.ts:153-216 的同一次序。
package app

import (
	"fmt"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strings"

	"github.com/go-chi/chi/v5"

	"elysian/server/internal/agent/harness"
	"elysian/server/internal/auth"
	"elysian/server/internal/config"
	"elysian/server/internal/containerapps"
	"elysian/server/internal/database"
	"elysian/server/internal/docker"
	"elysian/server/internal/files"
	"elysian/server/internal/firewall"
	"elysian/server/internal/logs"
	"elysian/server/internal/middleware"
	"elysian/server/internal/panel"
	"elysian/server/internal/paths"
	"elysian/server/internal/platform"
	"elysian/server/internal/seam"
	"elysian/server/internal/security"
	"elysian/server/internal/shared"
	"elysian/server/internal/terminals"
	"elysian/server/internal/websites"
	"elysian/server/web"
)

// New 装配完整 HTTP Runtime，调用方退出时必须调用 Close 回收后台任务资源。
//
// 签名在集成期带 logs 显式注入，与冻结形状的偏差及理由：main 启动序列的
// 「首启凭据运行日志」与「服务已启动」两条 lifecycle 日志必须与审计中间件、
// 各域写进同一个日志服务实例（TS 侧 index.ts 即把 logs.service 传进 createApp）；
// 若装配层自开一份，同库双连接、启动日志与运行日志分家。nil 时装配层按缺省路径
// 自行打开（tests 以假件注入，不碰磁盘）。
func New(cfg *config.Config, appLogs seam.Logs) (*Runtime, error) {
	return newAssembly(cfg, appLogs, auth.Deps{
		// 生产恒开启鉴权；dev 固定账号与 Cookie Secure 由 env 快照注入。
		Enabled:      true,
		DevAccount:   cfg.AuthDev,
		CookieSecure: cfg.CookieSecure,
	})
}

// newAssembly 实际装配：authDeps 由调用方给全（生产给 Enabled/DevAccount/
// CookieSecure，测试可注 Enabled=false 或内存 store）。共享实例在装配期创建一次：
// 会话撤销表穿 auth 片（触发端）与 terminals 片（登记端），会话 store 穿
// RequireSession 与 auth 片——漏穿只有静默缺断连/滑动丢失，没有测试会红。
func newAssembly(cfg *config.Config, appLogs seam.Logs, authDeps auth.Deps, factories ...harnessFactory) (*Runtime, error) {
	if cfg.Mode() != config.ModeLocalDemo {
		if err := cfg.LoadAgentRuntime(paths.Default.AgentRuntime); err != nil {
			return nil, err
		}
	}
	if appLogs == nil {
		// 生产便利路径：按缺省路径打开（打开失败内部降级为不可用实现，不返回错误）。
		appLogs = logs.OpenService(paths.Default.LogsSqlite, nil)
	}

	// 会话撤销表：auth 片（登出/改密/退出其他会话触发撤销）与 terminals 片（/ws
	// 升级登记 closer）必须共享同一实例（go-plan §3.6，terminals 盘点风险 10）；
	// 测试注入非 nil 时以注入件为准（auth 与 terminals 穿同一注入件）。
	sessionConns := authDeps.SessionConns
	if sessionConns == nil {
		sessionConns = auth.NewSessionConnections()
		authDeps.SessionConns = sessionConns
	}
	// 会话 store：文件版首载后不重读文件，RequireSession 与 auth 片必须共享同一
	// 内存镜像（两个实例各自持镜像会导致滑动过期丢失）；显式构造一次注入两侧，
	// 不依赖 auth 包内的进程级单例。测试注入非 nil 时以注入件为准。
	if authDeps.Sessions == nil {
		authDeps.Sessions = auth.NewFileSessionStore(paths.Default.PanelSessions, authDeps.Now)
	}

	// 容器管理片最先装配：database/websites 的可用性与引擎事实由它分发。
	stack, err := docker.Assemble(docker.Deps{
		ReservedPorts: []int{22, cfg.PanelPorts().FrontendPort, cfg.PanelPorts().BackendPort},
		Mode:          cfg.Mode(),
		SocketPath:    cfg.DockerSocket,
		MountRoot:     cfg.MountRoot,
		Logs:          appLogs,
		Kit:           terminals.NewKit(),
	})
	if err != nil {
		return nil, fmt.Errorf("装配容器管理片失败：%w", err)
	}

	// 防火墙片：可用性统一取 cfg.HostOpsAvailable()；端口自动开放接缝与防火墙片
	// 同源（防火墙不可用时恒 skipped，行为与装配层注入 NoopPortOpener 一致）。
	firewallDeps := firewall.Deps{
		Available: cfg.HostOpsAvailable(),
		Ports:     cfg.PanelPorts(),
		Mode:      cfg.Mode(),
		DBPath:    paths.Default.FirewallSqlite,
	}
	firewallRouter, err := firewall.NewRouterChecked(firewallDeps)
	if err != nil {
		return nil, fmt.Errorf("防火墙入口恢复失败：%w", err)
	}
	portOpener := firewall.NewPortOpener(firewallDeps)

	securityDeps := security.Deps{Available: cfg.HostOpsAvailable()}
	platformRouter := platform.NewRouter(platform.Deps{
		Transports:   docker.NewTransportFactory(),
		CaddyAdmins:  websites.NewCaddyAdminFactory(),
		InContainer:  cfg.InContainer(),
		DockerSocket: cfg.DockerSocket,
		CaddySocket:  cfg.CaddySocket,
	})

	panelStore := panel.Store{Root: paths.ElysianHome}
	panelManager := panel.Manager{Store: panelStore, Host: panel.SystemHost{Store: panelStore, DockerSocket: cfg.DockerSocket}, Source: panel.GitHubSource{}, Ports: cfg.PanelPorts(), Enabled: cfg.BareMetal}
	factory := harnessFactory(newProductionHarness)
	if len(factories) > 0 && factories[0] != nil {
		factory = factories[0]
	}
	agentRouter, closeAgent, agentErr := factory(cfg, stack.Views)
	if agentErr != nil {
		appLogs.Runtime("error", "server.agent", "Agent 任务运行服务不可用："+agentErr.Error())
		agentRouter = harness.UnavailableRouter("Agent 任务存储或工具装配不可用，请查看面板运行日志")
	}
	runtime := &Runtime{closeDone: make(chan struct{})}
	var fileTransfers *files.TransferManager
	if cfg.HostOpsAvailable() {
		fileTransfers = files.NewTransferManager(paths.TmpDir+"/files-downloads", security.NewSystemAccounts())
		runtime.closeFuncs = append(runtime.closeFuncs, fileTransfers.Close)
	}
	if closeAgent != nil {
		runtime.closeFuncs = append(runtime.closeFuncs, closeAgent)
	}
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.StripTailSlash)

	// /api/*：审计先于鉴权（401 也落审计），鉴权先于全部域挂载（401 先于 503/403/404）。
	r.Group(func(api chi.Router) {
		api.Use(logs.OperationAuditMiddleware(appLogs))
		api.Use(auth.RequireSession(authDeps))
		api.Use(panelManager.WriteGuard)
		api.Mount("/api/panel", panelManager.Router())
		api.Mount("/api/agent", agentRouter)

		// 存活检查：鉴权豁免清单之首，供容器存活检查。
		api.Get(shared.HealthPath, func(w http.ResponseWriter, r *http.Request) {
			if cfg.BareMetal {
				panelManager.Health(w, r)
				return
			}
			shared.SendJSON(w, http.StatusOK, healthBody{OK: true})
		})

		// 挂载次序对齐 TS app.ts:153-216（次序即行为：越晚挂载越难被路径前缀遮蔽）。
		api.Mount(shared.AuthMount, auth.NewRouter(authDeps))
		api.Mount(shared.PlatformMount, platformRouter)
		api.Mount(shared.FirewallMount, firewallRouter)
		api.Mount(shared.SshMount, security.NewSshRouter(securityDeps))
		api.Mount(shared.UsersMount, security.NewUsersRouter(securityDeps))
		api.Mount(shared.FilesMount, files.NewRouter(files.Deps{
			Available: cfg.HostOpsAvailable(),
			Accounts:  security.NewSystemAccounts(),
			Transfers: fileTransfers,
		}))
		api.Mount(shared.TerminalMount, terminals.NewRouter(terminals.Deps{
			Available:    cfg.HostOpsAvailable(),
			Logs:         appLogs,
			SessionConns: sessionConns,
		}))
		api.Mount(shared.LogsMount, logs.NewRouter(logs.Deps{Service: appLogs}))
		api.Mount(shared.DockerMount, stack.Router)
		// 容器应用工作区：配置文件的存放、内容读写、compose 路径自检与镜像构建
		//（构建按 ADR-0021：引擎 /build classic 构建器，任务模型同 websites）。
		containerAppsRegistry := &containerapps.Registry{MountRoot: cfg.MountRoot}
		appBuilds := containerapps.NewProductionBuildManager(containerapps.BuildDeps{
			Engine:   stack.Engine,
			Policy:   docker.CheckRegistryHost,
			Registry: containerAppsRegistry,
		})
		api.Mount(shared.ContainerAppsMount, containerapps.Handler{
			Registry:        containerAppsRegistry,
			EngineAvailable: stack.Ready,
			Engine:          stack.Engine,
			Policy:          docker.CheckRegistryHost,
			Logs:            appLogs,
			Builds:          appBuilds,
		}.Router())
		api.Mount(shared.DatabaseMount, database.NewRouter(database.Deps{
			EngineAvailable: stack.Ready,
			SqliteAvailable: cfg.HostOpsAvailable(),
			Engine:          stack.Engine,
			Views:           stack.Views,
			SelfID:          stack.SelfID,
			PortOpener:      portOpener,
			Logs:            appLogs,
		}))
		api.Mount(shared.WebsitesMount, websites.NewRouter(websites.Deps{
			EngineAvailable: stack.Ready,
			Engine:          stack.Engine,
			Views:           stack.Views,
			SelfID:          stack.SelfID,
			PortOpener:      portOpener,
			Logs:            appLogs,
			Cfg:             cfg,
		}))

		// 全局 /api 404：会话有效而未匹配任何域挂载的请求回纯文本正文（对齐 Hono
		// 缺省 404；正文不承诺逐字、前端不消费）。各域内 404 才是
		// {"error":"未知…端点…"} JSON。
		api.HandleFunc("/api/*", func(w http.ResponseWriter, r *http.Request) {
			http.Error(w, "404 Not Found", http.StatusNotFound)
		})
	})

	// 非 /api 路径：嵌入前端静态资源 + SPA 回落 index.html，禁目录列表（go-plan §8）。
	r.HandleFunc("/*", spaHandler(web.DistFS()))

	// 父层兜底：panic 经 recover 落 server.http 运行日志后回固定内部错误文案
	//（TS app.onError 等价物；各片内部错误由片自身映射与审计中间件记录，不到这里）。
	runtime.handler = parentErrorHandler(r, appLogs)
	return runtime, nil
}

// parentErrorHandler 父层错误边界：只有「公共中间件或装配层抛出」的错误（Go 语义
// 是 panic）到得了这里——先记一条 server.http 运行日志（消息格式与 TS app.onError
// 逐字一致），再回固定 500 文案；panic 值的原始文本可能携带内部细节，绝不回显给
// 客户端。
func parentErrorHandler(next http.Handler, appLogs seam.Logs) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			rec := recover()
			if rec == nil {
				return
			}
			if rec == http.ErrAbortHandler {
				panic(rec)
			}
			err, ok := rec.(error)
			if !ok {
				err = fmt.Errorf("%v", rec)
			}
			if appLogs != nil {
				appLogs.Runtime("error", "server.http",
					fmt.Sprintf("请求处理失败：%s %s — %s", r.Method, r.URL.Path, err.Error()))
			}
			shared.SendError(w, http.StatusInternalServerError, "服务内部错误")
		}()
		next.ServeHTTP(w, r)
	})
}

// healthBody 存活检查响应体；键序即 JSON 输出序。
type healthBody struct {
	OK bool `json:"ok"`
}

// spaHandler 服务嵌入的前端静态资源：命中文件直出（按扩展名定 Content-Type），
// 未命中回落 index.html（占位 dist 无 index.html 时如实 404）；仅 GET/HEAD。
func spaHandler(dist fs.FS) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "404 Not Found", http.StatusNotFound)
			return
		}
		name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
		if name == "" {
			name = "index.html"
		}
		data, err := fs.ReadFile(dist, path.Join("dist", name))
		if err != nil {
			index, indexErr := fs.ReadFile(dist, "dist/index.html")
			if indexErr != nil {
				// 占位 dist 没有前端产物：如实 404，不影响 /api/* 路由与 404 语义。
				http.Error(w, "404 Not Found", http.StatusNotFound)
				return
			}
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(index)
			return
		}
		if ct := mime.TypeByExtension(path.Ext(name)); ct != "" {
			w.Header().Set("Content-Type", ct)
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(data)
	}
}
