package auth

import (
	"bufio"
	"context"
	"net"
	"net/http"
	"sync"
	"time"

	"elysian/server/internal/seam"
	"elysian/server/internal/shared"
)

// RequireSessionWebSocket protects the explicitly selected raw terminal routes.
// Register before validating so revocation cannot miss a late upgrade. Opening
// a terminal retains normal activity renewal; established sockets only Check.
func RequireSessionWebSocket(deps Deps) func(http.Handler) http.Handler {
	return requireSessionWebSocket(deps, func() (<-chan time.Time, func()) {
		ticker := time.NewTicker(time.Second)
		return ticker.C, ticker.Stop
	})
}

func requireSessionWebSocket(deps Deps, startTicks func() (<-chan time.Time, func())) func(http.Handler) http.Handler {
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
			socket := &sessionWebSocketWriter{ResponseWriter: w, ctx: ctx}
			unregister := resolved.sessionConns.Register(id, func() {
				cancel()
				socket.interrupt()
			})
			defer unregister()
			epoch, err := resolved.currentPwdEpoch()
			if err != nil {
				shared.SendError(w, http.StatusInternalServerError, err.Error())
				return
			}
			session, err := resolved.sessions.Validate(id, epoch)
			if err != nil {
				shared.SendError(w, http.StatusInternalServerError, err.Error())
				return
			}
			if session == nil || ctx.Err() != nil {
				shared.SendError(w, http.StatusUnauthorized, UnauthorizedMessage)
				return
			}
			ticks, stopTicks := startTicks()
			done := make(chan struct{})
			go func() {
				defer close(done)
				defer socket.interrupt()
				for {
					select {
					case <-ctx.Done():
						return
					case <-ticks:
						epoch, err := resolved.currentPwdEpoch()
						if err == nil {
							session, checkErr := resolved.sessions.Check(id, epoch)
							err = checkErr
							if err == nil && session != nil {
								continue
							}
						}
						if err != nil {
							resolved.diag("终端会话复验失败：%v\n", err)
						}
						resolved.sessionConns.Revoke(id)
						cancel()
						return
					}
				}
			}()
			defer func() {
				socket.finish()
				cancel()
				<-done
				stopTicks()
			}()
			next.ServeHTTP(socket, req.WithContext(ctx))
		})
	}
}

// Unlike the SSE writer, this wrapper preserves Hijack. The raw connection is
// owned from Hijack until Upgrade binds its framed connection, closing both
// cancellation windows without setting deadlines on a reused HTTP connection.
type sessionWebSocketWriter struct {
	http.ResponseWriter
	ctx         context.Context
	mu          sync.Mutex
	raw         net.Conn
	socket      seam.WsConn
	interrupted bool
	finished    bool
}

func (w *sessionWebSocketWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (w *sessionWebSocketWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	if err := w.ctx.Err(); err != nil {
		return nil, nil, err
	}
	conn, rw, err := http.NewResponseController(w.ResponseWriter).Hijack()
	if err != nil {
		return nil, nil, err
	}
	w.mu.Lock()
	interrupted := w.interrupted || w.finished || w.ctx.Err() != nil
	if !interrupted {
		w.raw = conn
	}
	w.mu.Unlock()
	if interrupted {
		_ = conn.Close()
		return nil, nil, context.Canceled
	}
	return conn, rw, nil
}

// BindSessionWebSocket is called by the shared upgrader before a domain starts
// its PTY. A canceled handshake never reaches the terminal's OnOpen.
func (w *sessionWebSocketWriter) BindSessionWebSocket(conn seam.WsConn) bool {
	w.mu.Lock()
	interrupted := w.interrupted || w.finished || w.ctx.Err() != nil
	if !interrupted {
		w.socket = conn
		w.raw = nil
	}
	w.mu.Unlock()
	if interrupted {
		conn.Close(seam.SessionRevokedCloseCode, seam.SessionRevokedCloseReason)
	}
	return !interrupted
}

func (w *sessionWebSocketWriter) interrupt() {
	w.mu.Lock()
	if w.finished || w.interrupted {
		w.mu.Unlock()
		return
	}
	w.interrupted = true
	raw, socket := w.raw, w.socket
	w.mu.Unlock()
	if socket != nil {
		socket.Close(seam.SessionRevokedCloseCode, seam.SessionRevokedCloseReason)
	} else if raw != nil {
		_ = raw.Close()
	}
}

func (w *sessionWebSocketWriter) finish() {
	w.mu.Lock()
	w.finished = true
	raw, socket := w.raw, w.socket
	w.mu.Unlock()
	if socket != nil {
		socket.Close(1000, "")
	} else if raw != nil {
		_ = raw.Close()
	}
}
