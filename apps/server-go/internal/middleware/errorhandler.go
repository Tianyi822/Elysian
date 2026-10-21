package middleware

import (
	"errors"
	"fmt"
	"net/http"
	"runtime/debug"

	"elysian/server/internal/applog"
	"elysian/server/internal/shared"
)

// 错误映射（go-plan §3.5，TS endpointErrorHandler 等价物）：EndpointGuardError /
// InvalidRequestError 按自带 Status 回 4xx（Message 原文回显），其余一切错误一律 500
//（服务端故障不伪装成 400）；响应体统一 {"error":"<中文消息>"}。每域路由器统一走
// EndpointErrorHandler，panic 经 recover 兜底同路径。

// EndpointErrorHandler 错误映射中间件：拦截 handler panic，按错误类型映射响应；
// 正常路径直接放行（handler 侧主动写错误用 WriteError）。panic 栈落进程文本日志
// panel.log（applog 未打开时 no-op），给面板故障留磁盘证据。
func EndpointErrorHandler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			rec := recover()
			if rec == nil {
				return
			}
			applog.Default().PanicStack(debug.Stack())
			var err error
			if e, ok := rec.(error); ok {
				err = e
			} else {
				err = fmt.Errorf("%v", rec)
			}
			WriteError(w, err)
		}()
		next.ServeHTTP(w, r)
	})
}

// WriteError 按错误类型写出统一错误响应：自带 4xx 状态的业务/守卫错误按 Status 回显
// Message，其余一律 500。
func WriteError(w http.ResponseWriter, err error) {
	var guard *shared.EndpointGuardError
	var invalid *shared.InvalidRequestError
	switch {
	case errors.As(err, &guard):
		shared.SendError(w, guard.Status, guard.Message)
	case errors.As(err, &invalid):
		shared.SendError(w, invalid.Status, invalid.Message)
	default:
		shared.SendError(w, http.StatusInternalServerError, err.Error())
	}
}
