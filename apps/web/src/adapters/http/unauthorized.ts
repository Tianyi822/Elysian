/*
 * 共享 401 拦截：全部 HTTP 出口在失败分支先经这里上报，会话过期（401）即可
 * 统一走「清会话 → 跳 /login」的同一条路。模块刻意保持最小：各 adapter 的
 * requestJson 私有出口签名互不相同，这里不重构出口、只提供上报接缝
 * （接线清单见设计文档「401 统一拦截」一节）。
 */

type UnauthorizedListener = () => void

let listener: UnauthorizedListener | undefined

/** 注册全局 401 监听；后注册者覆盖前者（sessionStore 模块在加载时接上）。 */
export function setUnauthorizedListener(next: UnauthorizedListener): void {
  listener = next
}

/**
 * response 为 401 时上报监听并回 true，调用方随即抛中文错误（「登录状态已失效，请重新登录」）；
 * 其余状态回 false，走各出口既有失败路径。登录端点自身不经这里——它的 401 是业务结果。
 */
export function reportUnauthorized(response: Response): boolean {
  return reportUnauthorizedStatus(response.status)
}

/** XHR、SSE 循环等拿不到 Response 对象的出口按状态号上报；reportUnauthorized 是它的薄封装。 */
export function reportUnauthorizedStatus(status: number): boolean {
  if (status !== 401) return false
  listener?.()
  return true
}
