import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentOperationApproval, AgentRuntimeAccess } from '@elysian/contracts'
import { createAgentChatGovernance, parseApproval, parseRuntimeAccess } from './agentChatGovernance'
import { createHttpAgentExtensionsAdapter } from './agentExtensionsHttpAdapter'

const access: AgentRuntimeAccess = { revision: 2, digest: 'digest', scopeKey: 'scope', kind: 'file', directories: [{ path: '/srv/project', access: 'rw' }], network: [], privateCidrs: [], resources: [], sessionAllowed: true }
const approval: AgentOperationApproval = { id: 'approval/a', runId: 'run', operationId: 'op', status: 'pending', createdAt: '', expiresAt: '', access,
  operation: { id: 'op', runId: 'run', taskId: 'task', modelRequestId: 'model', callIndex: 0, modelCallId: 'tool', argumentsJson: '{"path":"/srv/project/config"}', capability: { name: 'files_read', description: '读取文件', parameters: {}, source: 'builtin', ref: { id: 'files_read', revision: 1 }, readOnly: true }, snapshotDigest: 'snapshot', workspaceRevision: 1, policy: 'approval-required', status: 'waiting-approval', callId: 'call', createdAt: '' } }

afterEach(() => vi.unstubAllGlobals())

describe('运行时授权 HTTP 契约', () => {
  it('校验实际授权范围及下载标志，保留旧审批兼容', () => {
    expect(parseApproval(approval)).toMatchObject({ access })
    expect(parseApproval({ ...approval, operation: { ...approval.operation, capability: { ...approval.operation.capability, source: 'mcp', originalName: 'read_config', catalogDigest: 'catalog' } } })).toMatchObject({ operation: { capability: { originalName: 'read_config', catalogDigest: 'catalog' } } })
    const { access: _access, ...legacy } = approval
    expect(parseApproval(legacy)).not.toHaveProperty('access')
    expect(() => parseRuntimeAccess({ ...access, directories: [{ path: '/srv', access: 'write' }] })).toThrow()
    expect(() => parseRuntimeAccess({ ...access, runtime: { name: 'Bash', image: 'image', platform: 'linux/amd64', requiresDownload: 'yes' } })).toThrow()
  })

  it('逐次确认透传精确幂等请求，不提供会话授权管理', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json(approval))
    vi.stubGlobal('fetch', fetch)
    const api = createAgentChatGovernance()
    const decision = { requestId: 'decision', expectedRevision: 2, expectedDigest: 'digest', decision: 'once' as const }
    await api.decideAccess(approval.id, decision)
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/agent/approvals/approval%2Fa/access-decision')
    expect(JSON.parse(fetch.mock.calls[0]?.[1].body)).toEqual(decision)
    expect(api).not.toHaveProperty('authorizations')
    expect(api).not.toHaveProperty('revokeAuthorization')
  })

  it('MCP 探测请求与决定独立于聊天，要求仅本次权限', async () => {
    const request = { id: 'probe/a', version: 1, requestId: 'prepare', serverId: 'mcp/a', serverRevision: 2, serverName: 'MCP', state: 'waiting', digest: 'probe', createdAt: '', access: { ...access, kind: 'mcp', sessionAllowed: false }, command: ['node', 'server.js'] }
    const fetch = vi.fn().mockResolvedValueOnce(Response.json(request)).mockResolvedValueOnce(Response.json({ ...request, state: 'running' })).mockResolvedValueOnce(Response.json({ ...request, access }))
    vi.stubGlobal('fetch', fetch)
    const api = createHttpAgentExtensionsAdapter()
    await api.createMcpProbeRequest('mcp/a', { revision: 2, requestId: 'prepare' })
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/agent/mcp-servers/mcp%2Fa/probe-request')
    const decision = { requestId: 'allow', expectedVersion: 1, expectedDigest: 'probe', decision: 'allow-once' as const }
    await api.decideMcpProbeRequest('probe/a', decision)
    expect(JSON.parse(fetch.mock.calls[1]?.[1].body)).toEqual(decision)
    await expect(api.getMcpProbeRequest('probe/a')).rejects.toThrow('不能使用会话授权')
  })
})
