// Package shared 是纯公共件（go-plan §3.3）：错误类型、挂载常量、Host 允许名单与
// JSON 编码出口。零 IO、零框架依赖，全部域包与公共层共用。
package shared

// InvalidRequestError 请求被拒：请求体/参数不合法、或按面板策略不允许时由校验层带回，
// 端点按 Status 返回 4xx。与 EndpointGuardError 分开命名（业务校验失败 vs 守卫原语失败），
// 共同点是都自带状态码；有了它，业务校验失败不再被一律映射成 500 服务端故障。
type InvalidRequestError struct {
	Status  int
	Message string
}

// Error 实现 error；消息是 API 契约（中文，逐字）。
func (e *InvalidRequestError) Error() string { return e.Message }

// EndpointGuardError 端点守卫失败（同源、Content-Type、体积上限）时带回，
// 端点 handler 按 Status 映射响应。
type EndpointGuardError struct {
	Status  int
	Message string
}

// Error 实现 error；消息是 API 契约（中文，逐字）。
func (e *EndpointGuardError) Error() string { return e.Message }

// InvalidRequest 构造恒 400 的业务校验错误（TS invalidRequest 等价物）。
func InvalidRequest(message string) *InvalidRequestError {
	return &InvalidRequestError{Status: 400, Message: message}
}
