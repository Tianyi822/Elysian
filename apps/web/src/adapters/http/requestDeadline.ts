export const JSON_READ_TIMEOUT = 15_000
export const JSON_WRITE_TIMEOUT = 60_000

export class RequestTimeoutError extends Error {
  readonly uncertain: boolean
  constructor(write: boolean) {
    super(write
      ? '请求超时，操作结果尚未确认，请重新读取服务端状态后再决定是否重试'
      : '读取超时，请检查面板连接后重试')
    this.name = 'RequestTimeoutError'
    this.uncertain = write
  }
}

/** 时限覆盖连接与响应体读取；取消不会重放写操作。长任务显式传入自己的时限。 */
export async function withRequestDeadline<T>(
  init: RequestInit | undefined,
  operation: (init: RequestInit) => Promise<T>,
  timeoutMs?: number,
): Promise<T> {
  const write = !['GET', 'HEAD'].includes((init?.method ?? 'GET').toUpperCase())
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const deadline = new Promise<never>((_, reject) => {
    onAbort = () => {
      reject(new DOMException('请求已取消', 'AbortError'))
      controller.abort(init?.signal?.reason)
    }
    if (init?.signal?.aborted) { onAbort(); return }
    init?.signal?.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => {
      const error = new RequestTimeoutError(write)
      reject(error)
      controller.abort(error)
    }, timeoutMs ?? (write ? JSON_WRITE_TIMEOUT : JSON_READ_TIMEOUT))
  })
  try {
    if (controller.signal.aborted) return await deadline
    return await Promise.race([operation({ ...init, signal: controller.signal }), deadline])
  } finally {
    clearTimeout(timer)
    if (onAbort) init?.signal?.removeEventListener('abort', onAbort)
  }
}

export function hasUncertainOutcome(error: unknown): boolean {
  return error instanceof RequestTimeoutError && error.uncertain
    || error instanceof Error && error.message.includes('操作结果尚未确认')
}
