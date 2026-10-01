// Command elysian 是 Elysian Go 后端的唯一入口：环境校验、HTTP 服务与优雅关闭。
//
// 完整启动序列（go-plan §2）：logs 打开 → 首启凭据 → 装配 → listen。骨架阶段只有
// 装配与 listen 两步真实存在；logs 打开与首启凭据随各域实现接入。子命令
// `elysian resetpwd`（改密 CLI）与 `elysian __sqlite-worker`（SQLite 托管子进程）
// 分别由 auth 域与 database 域实现后在此分发。
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
	"elysian/server/internal/config"
)

// shutdownTimeout 优雅关闭时限：存量请求收尾，超时强制退出。
const shutdownTimeout = 10 * time.Second

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

	handler, err := app.New(cfg)
	if err != nil {
		return fmt.Errorf("装配 HTTP 服务失败：%w", err)
	}

	addr := net.JoinHostPort(cfg.ListenHost, strconv.Itoa(config.ListenPort))
	srv := &http.Server{Addr: addr, Handler: handler}

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

	log.Printf("Elysian Go 后端已启动，监听 %s", addr)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("HTTP 服务异常退出：%w", err)
	}
	<-idleClosed
	log.Print("Elysian Go 后端已退出")
	return nil
}
