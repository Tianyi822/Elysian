import type { AgentMCPProbeDecision, AgentMCPProbeRequest } from '@elysian/contracts'
import { AgentHttpError } from '../../http/agent/agentShared'
import { agentExtensionsDemo } from './agentExtensionsData'

/** 每个演示 gateway 隔离，决策只推进模拟探测，绝不执行外部操作。 */
export function createMcpProbeMock() {
  const requests = new Map<string, AgentMCPProbeRequest>()
  const read = (id: string) => { const value = requests.get(id); if (!value) throw new AgentHttpError('探测申请不存在', 'not-found', 404); return structuredClone(value) }
  return {
    async createMcpProbeRequest(serverId: string, input: { revision: number; requestId: string }) {
      const old = [...requests.values()].find(item => item.requestId === input.requestId)
      if (old) { if (old.serverId !== serverId || old.serverRevision !== input.revision) throw new AgentHttpError('请求编号冲突', 'conflict', 409); return structuredClone(old) }
      const server = await agentExtensionsDemo.getServer(serverId, input.revision)
      const id = `probe-${requests.size + 1}`, scope = server.stdio?.requestedAccess ?? { directories: [], network: [], privateCidrs: [] }
      const value: AgentMCPProbeRequest = { id, version: 1, requestId: input.requestId, serverId, serverRevision: input.revision, serverName: server.name, state: 'waiting', digest: id, createdAt: '2026-10-20T00:00:00Z', command: server.stdio?.command ?? [], access: { ...scope, kind: 'mcp', revision: 1, digest: id, scopeKey: id, sessionAllowed: false, reason: '启动此服务以读取工具、资源与提示词目录。', ...(server.stdio ? { runtime: { name: server.name, image: server.stdio.image, platform: 'linux/amd64', requiresDownload: false } } : {}) } }
      requests.set(id, value); return structuredClone(value)
    },
    async getMcpProbeRequest(id: string) { return read(id) },
    async decideMcpProbeRequest(id: string, input: AgentMCPProbeDecision) {
      const value = read(id)
      if (value.version !== input.expectedVersion || value.digest !== input.expectedDigest) throw new AgentHttpError('探测申请已变化', 'conflict', 409)
      if (value.state !== 'waiting') return value
      value.state = input.decision === 'deny' ? 'denied' : 'running'; requests.set(id, value)
      if (input.decision === 'allow-once') {
        try { value.catalog = await agentExtensionsDemo.probe(value.serverId, value.serverRevision); value.state = 'completed' }
        catch (cause) { value.state = 'failed'; value.error = cause instanceof Error ? cause.message : '探测失败' }
        requests.set(id, value)
      }
      return structuredClone(value)
    },
    async cancelMcpProbeRequest(id: string) { const value = read(id); if (['waiting', 'preparing', 'running'].includes(value.state)) { value.state = 'cancelled'; requests.set(id, value) }; return structuredClone(value) },
  }
}
