package app

import (
	"net/http"
	"strings"

	"elysian/server/internal/auth"
)

// 只有明确的聊天输出端点使用被动流鉴权；其余请求保留原有会话续期语义。
// 选择发生在统一鉴权位置，不能先 Validate 再 Check，否则自动重连仍会续空闲期。
func panelSessionGuard(deps auth.Deps) func(http.Handler) http.Handler {
	regular, stream := auth.RequireSession(deps), auth.RequireSessionStream(deps)
	return func(next http.Handler) http.Handler {
		regularHandler, streamHandler := regular(next), stream(next)
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
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
