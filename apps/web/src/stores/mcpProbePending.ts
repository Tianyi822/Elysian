import type { AgentMCPProbeDecision, AgentMCPServer } from '@elysian/contracts'

export type McpProbePointer = {
  requestId: string
  id?: string
  decision?: AgentMCPProbeDecision
  cancelRequestId?: string
}

type ProbeTarget = Pick<AgentMCPServer, 'id' | 'revision'>
const key = (server: ProbeTarget) => `elysian:mcp-probe:v1:${server.id}:${server.revision}`

/** 保存请求身份以便刷新后核对；探测状态仍以服务端回读为准。 */
export function readMcpProbePointer(server: ProbeTarget): McpProbePointer | undefined {
  try {
    const value = JSON.parse(sessionStorage.getItem(key(server)) ?? 'null') as McpProbePointer | null
    if (value && typeof value.requestId === 'string') return value
  } catch { /* 存储不可用时仍可在当前页面内保留请求。 */ }
  return undefined
}

export function saveMcpProbePointer(server: ProbeTarget, value: McpProbePointer): void {
  try { sessionStorage.setItem(key(server), JSON.stringify(value)) } catch { /* 同页仍保留原请求。 */ }
}
