// Command elysian 是 Elysian Go 后端的唯一入口：环境校验、HTTP 服务与优雅关闭。
//
// 完整启动序列（go-plan §2）：logs 打开 → 首启凭据 → 装配 → listen。首启凭据生成
// 时补一条 lifecycle 运行日志（不含明文，横幅由 auth 域打 stdout）；监听就绪后打
// stdout 确认行与「服务已启动」运行日志。子命令：`elysian resetpwd`（改密 CLI，
// go-plan §11 D5）与内部隐藏子命令 `elysian __sqlite-worker`（SQLite 托管降权
// 子进程，go-plan §11 D10，由 database 域以自身二进制 fork）及
// `elysian __agent-worker`（由任务内核托管的匿名管道 Worker）。
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"sync/atomic"
	"syscall"
	"time"

	"elysian/server/internal/agent/execution"
	"elysian/server/internal/agent/harness/worker"
	"elysian/server/internal/app"
	"elysian/server/internal/applog"
	"elysian/server/internal/auth"
	"elysian/server/internal/cli"
	"elysian/server/internal/config"
	"elysian/server/internal/database"
	"elysian/server/internal/logs"
	"elysian/server/internal/panel"
	"elysian/server/internal/paths"
	"elysian/server/internal/shared"
	"path/filepath"
)

// shutdownTimeout 优雅关闭时限：存量请求收尾，超时强制退出。
const shutdownTimeout = 10 * time.Second

// connectionIdleTimeout 连接空闲时限（TS Bun serve idleTimeout: 255 的等价物）：
// 依赖安装的一步在宿主上跑 apt，最长 240s 内没有任何响应字节，取 Bun 上限 255s
// 兜底其后（platform 盘点 §11.1）。只作用于「请求之间无字节流动」的空闲连接与
// 请求头读取，不设全局 Read/WriteTimeout——SSE/WS 与长耗时安装步骤不受影响。
const connectionIdleTimeout = 255 * time.Second

func main() {
	err := run()
	if err == nil {
		return
	}
	var ec exitError
	if errors.As(err, &ec) {
		// ely 别名路径：以 CLI 自身退出码退出，不打印「启动失败」前缀。
		os.Exit(ec.code)
	}
	fmt.Fprintf(os.Stderr, "启动失败：%v\n", err)
	os.Exit(1)
}

// exitError 携带进程退出码的错误（ely 别名路径专用）：run 内不直接 os.Exit，保持
// 与其余子命令一致的错误返回形态，main 统一按码退出。
type exitError struct{ code int }

func (e exitError) Error() string { return fmt.Sprintf("ely 以退出码 %d 结束", e.code) }

// cliExit 把 cli.Run 的退出码转为错误返回；0 视为成功。
func cliExit(code int) error {
	if code == 0 {
		return nil
	}
	return exitError{code}
}

func run() (runErr error) {
	if len(os.Args) > 1 && os.Args[1] == "agent-exec-supervisor" {
		if len(os.Args) != 2 {
			return errors.New("容器 supervisor 不接受额外参数")
		}
		return execution.ServeSupervisor(context.Background(), os.Stdin, os.Stdout)
	}
	// Worker 只读匿名管道，不进入凭据、数据库或 HTTP 装配。
	if len(os.Args) > 1 && os.Args[1] == "__agent-worker" {
		if len(os.Args) != 2 {
			return errors.New("Agent Worker 不接受额外命令行参数")
		}
		return worker.Serve(os.Stdin, os.Stdout, os.Stderr)
	}
	// ely 别名分发（CLI 方案 §2）：argv0 精确等于 ely 时进入交互 CLI，先于 config.Load，
	// 不依赖服务端环境变量装配，也不透传 elysian 子命令语义；supervisor／Worker 等内部
	// 子命令判定在前，不受影响。安装形态为 /usr/local/bin/ely → current/elysian 符号
	// 链接，在线维护只切 current，ely 自动跟随版本。
	if isElyInvocation(os.Args[0]) {
		return cliExit(cli.Run(cli.Info{Commit: panel.Commit, BuildTime: panel.BuildTime}, os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
	}
	cfg := config.Load()
	// 运行模式互斥（go-plan §3.1）：Docker 与裸机直执同设即配置错误，启动即失败。
	if cfg.Docker && cfg.BareMetal {
		return errors.New("ELYSIAN_DOCKER=1 与 ELYSIAN_BARE_METAL=1 不能同时设置，请只声明一种运行模式")
	}

	// 子命令分发（go-plan §2）：改密 CLI 与 SQLite 托管子进程。两者都不进入
	// HTTP 服务装配；__sqlite-worker 是隐藏内部子命令，由 database 域 fork 自身
	// 二进制并以 ELYSIAN_SQLITE_FILE / ELYSIAN_SQLITE_CREATE 私有 env 传参。
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "panel-ports", "panel-init", "maintenance-bootstrap", "maintenance-install-check", "maintenance-bootstrap-save", "maintenance-bootstrap-restore":
			ports, err := config.ReadPanelNetwork(filepath.Join(paths.ConfigDir, "panel-network.json"))
			if err != nil {
				return err
			}
			host := panel.SystemHost{Store: panel.Store{Root: paths.ElysianHome}, DockerSocket: cfg.DockerSocket, MissingServiceOK: os.Args[1] == "maintenance-install-check"}
			if os.Args[1] == "maintenance-install-check" {
				return panel.CheckInstall(context.Background(), panel.Store{Root: paths.ElysianHome}, host, ports)
			}
			if os.Args[1] == "maintenance-bootstrap-save" || os.Args[1] == "maintenance-bootstrap-restore" {
				if len(os.Args) != 3 {
					return errors.New("防火墙引导备份命令需要文件路径")
				}
				if os.Args[1] == "maintenance-bootstrap-save" {
					return panel.SaveBootstrapRules(context.Background(), host, ports, os.Args[2])
				}
				return panel.RestoreBootstrapRules(context.Background(), host, os.Args[2])
			}
			if os.Args[1] == "panel-init" {
				return config.AtomicJSON(filepath.Join(paths.ConfigDir, "panel-network.json"), ports)
			}
			if os.Args[1] == "maintenance-bootstrap" {
				return panel.Bootstrap(context.Background(), panel.SystemHost{Store: panel.Store{Root: paths.ElysianHome}, DockerSocket: cfg.DockerSocket}, ports)
			}
			fmt.Printf("%d %d\n", ports.FrontendPort, ports.BackendPort)
			return nil
		case "maintenance-worker", "maintenance-recover":
			return panel.RunCLI(context.Background(), os.Args[1], os.Args[2:], paths.ElysianHome, cfg.DockerSocket)
		case "resetpwd":
			os.Exit(auth.RunResetPasswordCLI(os.Stdin, os.Stdout))
		case "__sqlite-worker":
			os.Exit(database.RunSQLiteWorker(os.Stdin, os.Stdout, os.Getenv))
		}
	}

	if cfg.BareMetal {
		var err error
		cfg.Network, err = config.ReadPanelNetwork(filepath.Join(paths.ConfigDir, "panel-network.json"))
		if err != nil {
			return err
		}
		cfg.ListenHost = "127.0.0.1"
	}

	// 进程文本诊断日志（~/.Elysian/logs/panel.log＋stdout 双写、10 MiB 轮转）：
	// 生命周期、失败请求与 panic 栈。打开失败只降级为 stdout（journal），不阻断启动。
	panelLog, panelLogErr := applog.Open(paths.LogsDir)
	if panelLogErr != nil {
		fmt.Fprintf(os.Stderr, "Elysian 文本日志不可用：%v（继续以 journal 为准）\n", panelLogErr)
	}
	defer func() { _ = panelLog.Close() }()

	// 启动序列第一步：打开日志（建表 + 分片导入；打开失败内部降级为不可用实现）。
	appLogs := logs.OpenService(paths.Default.LogsSqlite, nil)

	// 启动序列第二步：首启凭据保障（dev 开启只打警告行；否则凭据缺失时生成随机
	// 初始密码，横幅打 stdout）。created 时补一条不含明文的 lifecycle 运行日志。
	created, err := auth.FirstBootCredentials(cfg)
	if err != nil {
		return fmt.Errorf("首启凭据保障失败：%w", err)
	}
	if created {
		appLogs.Runtime("info", "server.lifecycle", "面板初始密码已生成（admin）")
	}

	// 启动序列第三步：装配。
	runtime, err := app.New(cfg, appLogs)
	if err != nil {
		return fmt.Errorf("装配 HTTP 服务失败：%w", err)
	}
	var shutdownStarted atomic.Bool
	defer func() {
		if shutdownStarted.Load() {
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
		defer cancel()
		if err := runtime.Close(ctx); err != nil {
			runErr = errors.Join(runErr, fmt.Errorf("关闭 Agent 任务运行服务失败：%w", err))
		}
	}()
	var handler http.Handler = runtime

	// 启动序列第四步：listen（先 listen 再打启动确认，端口被占时如实报错退出）。
	addr := net.JoinHostPort(cfg.ListenHost, strconv.Itoa(cfg.PanelPorts().BackendPort))
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("监听 %s 失败：%w", addr, err)
	}
	var publicServer *http.Server
	var publicListener net.Listener
	if cfg.BareMetal {
		public, private, err := shared.NewPanelGateway(handler, cfg.PanelPorts().FrontendPort, cfg.PanelPorts().BackendPort)
		if err != nil {
			listener.Close()
			return err
		}
		handler = private
		publicListener, err = net.Listen("tcp", ":"+strconv.Itoa(cfg.PanelPorts().FrontendPort))
		if err != nil {
			listener.Close()
			return fmt.Errorf("前端端口监听失败：%w", err)
		}
		publicServer = &http.Server{Handler: public, IdleTimeout: connectionIdleTimeout, ReadHeaderTimeout: connectionIdleTimeout}
	}
	srv := &http.Server{
		Handler:           handler,
		IdleTimeout:       connectionIdleTimeout,
		ReadHeaderTimeout: connectionIdleTimeout,
	}
	if publicServer != nil {
		defer publicServer.Close()
	}
	publicFailure := make(chan error, 1)

	idleClosed := make(chan struct{})
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(sig)
	stopShutdown := make(chan struct{})
	defer close(stopShutdown)
	go func() {
		select {
		case <-sig:
		case <-stopShutdown:
			return
		}
		log.Print("收到退出信号，开始优雅关闭")
		shutdownStarted.Store(true)
		ctx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
		defer cancel()
		// 同时停止任务派发与 HTTP 接收，不能等长请求占满关闭时限后才回收 Worker。
		agentClosed := make(chan error, 1)
		go func() { agentClosed <- runtime.Close(ctx) }()
		if publicServer != nil {
			_ = publicServer.Shutdown(ctx)
		}
		if err := srv.Shutdown(ctx); err != nil {
			log.Printf("优雅关闭未在时限内完成：%v", err)
		}
		select {
		case err := <-agentClosed:
			if err != nil {
				log.Printf("Agent 任务收尾未在时限内完成：%v", err)
			}
		case <-ctx.Done():
			log.Print("Agent 任务收尾已达到关闭时限")
		}
		close(idleClosed)
	}()

	// 终端上的可读性保留：监听确认行照旧打在 stdout（运行日志文件是它的存档，
	// 不是它的替代）；随后补「服务已启动」lifecycle 运行日志与进程文本日志横幅
	//（模式、端口与数据目录——面板故障时运维在 panel.log 里能直接对上环境）。
	fmt.Printf("Elysian server 已监听 http://%s\n", addr)
	appLogs.Runtime("info", "server.lifecycle", fmt.Sprintf("Elysian 服务已启动：http://%s", addr))
	panelLog.Printf("Elysian 运行：模式=%s，后端监听=%s，数据目录=%s，文本日志=%s",
		runModeLabel(cfg), addr, paths.ElysianHome, filepath.Join(paths.LogsDir, applog.PanelLogName))

	if publicServer != nil {
		appLogs.Runtime("info", "server.lifecycle", fmt.Sprintf("面板前端端口：%d；后端回环端口：%d", cfg.PanelPorts().FrontendPort, cfg.PanelPorts().BackendPort))
		go func() {
			if err := publicServer.Serve(publicListener); err != nil && !errors.Is(err, http.ErrServerClosed) {
				log.Printf("面板前端服务异常：%v", err)
				publicFailure <- err
				_ = srv.Close()
			}
		}()
	}
	if err := srv.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("HTTP 服务异常退出：%w", err)
	}
	select {
	case <-idleClosed:
	case err := <-publicFailure:
		return fmt.Errorf("面板前端服务异常退出：%w", err)
	}
	log.Print("Elysian Go 后端已退出")
	return nil
}

// runModeLabel 运行模式的中文横幅标签（仅诊断文本用，不进契约）。
func runModeLabel(cfg *config.Config) string {
	switch cfg.Mode() {
	case config.ModeDocker:
		return "docker"
	case config.ModeBareMetal:
		return "bare-metal"
	default:
		return "local-demo"
	}
}

// isElyInvocation 报告 argv0 是否为 ely 别名形态（busybox 式 argv0 分发，CLI 方案 §2）：
// basename 必须精确等于 ely，用户改名的副本（如 ely-backup、myely）不误入 CLI 菜单，
// 仍按 elysian 的服务端语义执行。
func isElyInvocation(argv0 string) bool {
	return argv0 != "" && filepath.Base(argv0) == "ely"
}
