import type { AgentAccessDecisionInput, AgentAuthorizationRevokeInput } from '@elysian/contracts'

type Pending = AgentAccessDecisionInput | AgentAuthorizationRevokeInput
const key = (scope: string) => `elysian:agent-authorization-pending:v1:${scope}`
/** 仅保存未确认请求的编号与选择；显示和执行始终以鉴权后的服务端回读为准。 */
export function readAuthorizationPending<T extends Pending>(scope: string): Record<string, T> {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key(scope)) ?? '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, T] => {
      const input = entry[1] as Partial<AgentAccessDecisionInput> | undefined
      return !!input && typeof input.requestId === 'string' && typeof input.expectedRevision === 'number' && Number.isSafeInteger(input.expectedRevision) && input.expectedRevision > 0 &&
        (input.decision === undefined || (['once', 'session', 'denied'].includes(input.decision) && typeof input.expectedDigest === 'string'))
    }))
  } catch { return {} }
}
export function saveAuthorizationPending(scope: string, value: Record<string, Pending>): void {
  try { if (Object.keys(value).length) sessionStorage.setItem(key(scope), JSON.stringify(value)); else sessionStorage.removeItem(key(scope)) } catch { /* 浏览器拒绝存储时同页仍保留精确请求。 */ }
}
