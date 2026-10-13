package auth

import (
	"context"
	"net/http"
	"sync"
	"time"

	"elysian/server/internal/seam"
	"elysian/server/internal/shared"
)

// RequireSessionStream 用于装配层明确选择的只读长连接。开流与重连都不续空闲期；
// 主动撤销立即取消请求，CLI 改密与自然过期每秒被动复验。不向业务域泄露登录身份。
func RequireSessionStream(deps Deps) func(http.Handler) http.Handler {
	return requireSessionStream(deps, func() (<-chan time.Time, func()) {
		ticker := time.NewTicker(time.Second)
		return ticker.C, ticker.Stop
	})
}

func requireSessionStream(deps Deps, startTicks func() (<-chan time.Time, func())) func(http.Handler) http.Handler {
	resolved := resolveDeps(deps)
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			if !resolved.enabled {
				next.ServeHTTP(w, req)
				return
			}
			id, ok := seam.ParseSessionCookie(req.Header.Get("Cookie"))
			if !ok {
				shared.SendError(w, http.StatusUnauthorized, UnauthorizedMessage)
				return
			}
			if resolved.sessionConns == nil {
				shared.SendError(w, http.StatusInternalServerError, "会话连接撤销服务不可用")
				return
			}
			ctx, cancel := context.WithCancel(req.Context())
			defer cancel()
			// 必须先登记再直读 epoch 和会话。注销若先于登记，复核会拒绝；若晚于
			// 登记，cancel 会被撤销表调用，不能留下通过旧校验后迟到的长连接。
			unregister := resolved.sessionConns.Register(id, cancel)
			defer unregister()
			check := func() (bool, error) {
				epoch, err := resolved.currentPwdEpoch()
				if err != nil {
					return false, err
				}
				session, err := resolved.sessions.Check(id, epoch)
				return session != nil, err
			}
			valid, err := check()
			if err != nil {
				shared.SendError(w, http.StatusInternalServerError, err.Error())
				return
			}
			if !valid || ctx.Err() != nil {
				shared.SendError(w, http.StatusUnauthorized, UnauthorizedMessage)
				return
			}
			stream := &sessionStreamWriter{ResponseWriter: w, ctx: ctx}
			ticks, stopTicks := startTicks()
			done := make(chan struct{})
			go func() {
				defer close(done)
				defer stream.interrupt()
				for {
					select {
					case <-ctx.Done():
						return
					case <-ticks:
						valid, err := check()
						if err != nil {
							resolved.diag("会话输出流复验失败：%v\n", err)
							cancel()
							return
						}
						if !valid {
							resolved.sessionConns.Revoke(id)
							cancel()
							return
						}
					}
				}
			}()
			defer func() {
				stream.finish()
				cancel()
				<-done
				stopTicks()
				// 等待监控退出后再复原，避免迟到的取消把后续复用连接的请求截断。
				_ = http.NewResponseController(w).SetWriteDeadline(time.Time{})
			}()
			next.ServeHTTP(stream, req.WithContext(ctx))
		})
	}
}

// 保留 ResponseController 透传；取消后拒绝新写入并打断进行中的写入。deadlineMu
// 防止业务的五秒写时限覆盖撤销已经设置的立即超时；不在写阻塞期间持这把锁。
type sessionStreamWriter struct {
	http.ResponseWriter
	ctx         context.Context
	deadlineMu  sync.Mutex
	interrupted bool
	finished    bool
}

func (w *sessionStreamWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (w *sessionStreamWriter) Write(data []byte) (int, error) {
	if err := w.ctx.Err(); err != nil {
		return 0, err
	}
	return w.ResponseWriter.Write(data)
}

func (w *sessionStreamWriter) WriteHeader(status int) {
	if w.ctx.Err() == nil {
		w.ResponseWriter.WriteHeader(status)
	}
}

func (w *sessionStreamWriter) FlushError() error {
	if err := w.ctx.Err(); err != nil {
		return err
	}
	return http.NewResponseController(w.ResponseWriter).Flush()
}

func (w *sessionStreamWriter) Flush() { _ = w.FlushError() }

func (w *sessionStreamWriter) SetWriteDeadline(deadline time.Time) error {
	w.deadlineMu.Lock()
	defer w.deadlineMu.Unlock()
	if w.interrupted || w.ctx.Err() != nil {
		return context.Canceled
	}
	return http.NewResponseController(w.ResponseWriter).SetWriteDeadline(deadline)
}

func (w *sessionStreamWriter) interrupt() {
	w.deadlineMu.Lock()
	defer w.deadlineMu.Unlock()
	if w.finished {
		return
	}
	w.interrupted = true
	_ = http.NewResponseController(w.ResponseWriter).SetWriteDeadline(time.Now())
}

func (w *sessionStreamWriter) finish() {
	w.deadlineMu.Lock()
	defer w.deadlineMu.Unlock()
	// 正常返回只回收监控，不制造写超时；HTTP/2 的已触发超时不能靠清空期限撤回。
	w.finished = true
}
