// Command elysian 是 Elysian Go 后端的唯一入口：环境校验、HTTP 服务与优雅关闭。
//
// 完整启动序列（go-plan §2）：logs 打开 → 首启凭据 → 装配 → listen。首启凭据生成
// 时补一条 lifecycle 运行日志（不含明文，横幅由 auth 域打 stdout）；监听就绪后打
// stdout 确认行与「服务已启动」运行日志。子命令：`elysian resetpwd`（改密 CLI，
// go-plan §11 D5）与内部隐藏子命令 `elysian __sqlite-worker`（SQLite 托管降权
// 子进程，go-plan §11 D10，由 database 域以自身二进制 fork）。
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
	"syscall"
	"time"

	"elysian/server/internal/app"
	"elysian/server/internal/auth"
	"elysian/server/internal/config"
	"elysian/server/internal/database"
	"elysian/server/internal/logs"
	"elysian/server/internal/paths"
)

// shutdownTimeout 优雅关闭时限：存量请求收尾，超时强制退出。
const shutdownTimeout = 10 * time.Second

// connectionIdleTimeout 连接空闲时限（TS Bun serve idleTimeout: 255 的等价物）：
// 依赖安装的一步在宿主上跑 apt，最长 240s 内没有任何响应字节，取 Bun 上限 255s
// 兜底其后（platform 盘点 §11.1）。只作用于「请求之间无字节流动」的空闲连接与
// 请求头读取，不设全局 Read/WriteTimeout——SSE/WS 与长耗时安装步骤不受影响。
const connectionIdleTimeout = 255 * time.Second

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "启动失败：%v\n", err)
		os.Exit(1)
	}
}

func run() error {
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
		case "resetpwd":
			os.Exit(auth.RunResetPasswordCLI(os.Stdin, os.Stdout))
		case "__sqlite-worker":
			os.Exit(database.RunSQLiteWorker(os.Stdin, os.Stdout, os.Getenv))
		}
	}

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
	handler, err := app.New(cfg, appLogs)
	if err != nil {
		return fmt.Errorf("装配 HTTP 服务失败：%w", err)
	}

	// 启动序列第四步：listen（先 listen 再打启动确认，端口被占时如实报错退出）。
	addr := net.JoinHostPort(cfg.ListenHost, strconv.Itoa(config.ListenPort))
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("监听 %s 失败：%w", addr, err)
	}
	srv := &http.Server{
		Handler:           handler,
		IdleTimeout:       connectionIdleTimeout,
		ReadHeaderTimeout: connectionIdleTimeout,
	}

	idleClosed := make(chan struct{})
	go func() {
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
		<-sig
		log.Print("收到退出信号，开始优雅关闭")
		ctx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
		defer cancel()
		if err := srv.Shutdown(ctx); err != nil {
			log.Printf("优雅关闭未在时限内完成：%v", err)
		}
		close(idleClosed)
	}()

	// 终端上的可读性保留：监听确认行照旧打在 stdout（运行日志文件是它的存档，
	// 不是它的替代）；随后补「服务已启动」lifecycle 运行日志。
	fmt.Printf("Elysian server 已监听 http://%s\n", addr)
	appLogs.Runtime("info", "server.lifecycle", fmt.Sprintf("Elysian 服务已启动：http://%s", addr))

	if err := srv.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("HTTP 服务异常退出：%w", err)
	}
	<-idleClosed
	log.Print("Elysian Go 后端已退出")
	return nil
}
