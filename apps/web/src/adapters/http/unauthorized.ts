/*
 * 共享 401 拦截：全部 HTTP 出口在失败分支先经这里上报，会话过期（401）即可
 * 统一走「清会话 → 跳 /login」的同一条路。模块刻意保持最小：各 adapter 的
 * requestJson 私有出口签名互不相同，这里统一绑定请求发起时的登录代次，
 * 避免旧请求迟到的 401 注销后续成功登录的会话。
 */

type UnauthorizedListener = () => void

let listener: UnauthorizedListener | undefined
let authGeneration = 0
const responseGenerations = new WeakMap<Response, number>()

/** XHR、iframe 等出口在发送请求前保存当前代次，收到响应时原样交回。 */
export function captureAuthGeneration(): number { return authGeneration }

/** 仅登录、登出或会话状态切换时推进，普通后台探测不推进。 */
export function advanceAuthGeneration(): void { authGeneration += 1 }

/** 保持 fetch 的请求行为，在异步响应上保存发起时的登录代次。 */
export async function fetchWithSession(...args: Parameters<typeof fetch>): Promise<Response> {
  const generation = captureAuthGeneration()
  const response = await fetch(...args)
  responseGenerations.set(response, generation)
  return response
}

/** 注册全局 401 监听；后注册者覆盖前者（sessionStore 模块在加载时接上）。 */
export function setUnauthorizedListener(next: UnauthorizedListener): void {
  listener = next
}

/**
 * response 为 401 时回 true，调用方随即抛中文错误（「登录状态已失效，请重新登录」）；
 * 只有当前登录代次的响应上报全局监听，旧请求仍失败但不能使新的登录失效。
 * 其余状态回 false，走各出口既有失败路径。登录端点自身不经这里——它的 401 是业务结果。
 */
export function reportUnauthorized(response: Response): boolean {
  return reportUnauthorizedStatus(response.status, responseGenerations.get(response))
}

/** 没有 Response 的出口同时提供发送时保存的代次；直接构造的同步响应默认属于当前代次。 */
export function reportUnauthorizedStatus(status: number, generation = captureAuthGeneration()): boolean {
  if (status !== 401) return false
  if (generation === authGeneration) listener?.()
  return true
}
