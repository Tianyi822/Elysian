package app

import (
	"net/http"
	"strings"

	"elysian/server/internal/auth"
)

// 明确的聊天输出端点使用被动流鉴权，真实终端使用保留 Hijack 的长连接鉴权。
// 选择发生在统一鉴权位置，聊天输出不能先 Validate 再 Check，以免重连续空闲期。
func panelSessionGuard(deps auth.Deps) func(http.Handler) http.Handler {
	regular, stream := auth.RequireSession(deps), auth.RequireSessionStream(deps)
	socket := auth.RequireSessionWebSocket(deps)
	return func(next http.Handler) http.Handler {
		regularHandler, streamHandler := regular(next), stream(next)
		socketHandler := socket(next)
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			if req.Method == http.MethodGet && isRawTerminalPath(req.URL.Path) {
				socketHandler.ServeHTTP(w, req)
				return
			}
			id, found := strings.CutPrefix(req.URL.Path, "/api/agent/runs/")
			id, suffix := strings.CutSuffix(id, "/output")
			if req.Method == http.MethodGet && found && suffix && id != "" && !strings.Contains(id, "/") {
				streamHandler.ServeHTTP(w, req)
				return
			}
			regularHandler.ServeHTTP(w, req)
		})
	}
}

func isRawTerminalPath(path string) bool {
	if path == "/api/terminals/ws" {
		return true
	}
	id, found := strings.CutPrefix(path, "/api/docker/containers/")
	id, suffix := strings.CutSuffix(id, "/terminal")
	return found && suffix && id != "" && !strings.Contains(id, "/")
}
