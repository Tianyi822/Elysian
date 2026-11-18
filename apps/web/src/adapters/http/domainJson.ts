import { withRequestDeadline } from './requestDeadline'
import { fetchWithSession, reportUnauthorized } from './unauthorized'

type FormatError = (error: unknown) => string | null

export async function readDomainErrorDetail(response: Response, formatError: FormatError = String): Promise<string | null> {
  return response.json().then((body) =>
    body && typeof body === 'object' && 'error' in body
      ? formatError((body as { error: unknown }).error)
      : null,
  ).catch(() => null)
}

type DomainJsonPolicy = {
  networkError?: string
  httpError?: string
  formatError?: FormatError
  deadline?: false
}

export function createDomainJsonClient(label: string, policy: DomainJsonPolicy = {}) {
  async function send(url: string, init?: RequestInit): Promise<Response> {
    let response: Response
    try {
      response = await fetchWithSession(url, init)
    } catch {
      throw new Error(policy.networkError ?? `${label}请求网络失败`)
    }
    if (!response.ok) {
      if (reportUnauthorized(response)) throw new Error('登录状态已失效，请重新登录')
      const detail = policy.httpError ?? await readDomainErrorDetail(response, policy.formatError)
      throw new Error(detail ?? `${label}请求失败：HTTP ${response.status}`)
    }
    return response
  }

  function run<T>(init: RequestInit | undefined, operation: (init?: RequestInit) => Promise<T>, timeoutMs?: number): Promise<T> {
    return policy.deadline === false ? operation(init) : withRequestDeadline(init, operation, timeoutMs)
  }

  return {
    requestJson(url: string, init?: RequestInit, timeoutMs?: number): Promise<unknown> {
      return run(init, async (bounded) => {
        const response = await send(url, bounded)
        try {
          return await response.json()
        } catch {
          throw new Error(`${label}响应不是有效 JSON`)
        }
      }, timeoutMs)
    },
    requestNoContent(url: string, init?: RequestInit): Promise<void> {
      return run(init, async (bounded) => { await send(url, bounded) })
    },
  }
}
