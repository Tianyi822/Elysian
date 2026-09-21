/*
 * 错误契约：自带状态码的错误类。端点守卫（同源、Content-Type、体积上限）失败抛
 * EndpointGuardError，业务校验失败抛 InvalidRequestError；路由层按自带 status 映射
 * 4xx 响应，其余系统侧错误一律 500。独立成零依赖模块：服务层要抛这些错误，
 * 但不该因此依赖任何 Web 框架的中间件类型。
 */

/** 带状态码的错误：端点守卫（同源、Content-Type、体积上限）失败时抛出，端点 handler 按 status 映射响应。 */
export class EndpointGuardError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

/**
 * 请求被拒：请求体/参数不合法、或按面板策略不允许时由校验层抛出，端点 handler 按 status
 * 返回 4xx。与 EndpointGuardError 分开命名（守卫原语失败 vs 业务校验失败），共同点是都自带
 * 状态码；有了它，业务校验失败不再被一律映射成 500 服务端故障。
 */
export class InvalidRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'InvalidRequestError'
  }
}

/** 请求体/参数不合法或按策略不允许（400）：校验函数直接抛它。 */
export function invalidRequest(message: string): InvalidRequestError {
  return new InvalidRequestError(400, message)
}
