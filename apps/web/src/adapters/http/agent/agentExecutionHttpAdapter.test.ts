import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentExecutionGrantInput, AgentExecutionProfileInput } from '@elysian/contracts'
import { runAgentExecutionAdapterContract } from '../../agentExecutionAdapterContract'
import { AgentExecutionMockAdapter } from '../../mock/agent/agentExecutionMockAdapter'
import { executionGrantInput, executionProfileInput } from '../../../test/agentExecutionFixtures'
import { createHttpAgentExecutionAdapter } from './agentExecutionHttpAdapter'
import { AgentHttpError } from './agentShared'
import { parseCapability } from './agentChatGovernance'

afterEach(() => vi.unstubAllGlobals())
runAgentExecutionAdapterContract('HTTP', () => {
  const server = new AgentExecutionMockAdapter()
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit) => {
    const url = new URL(input, 'http://localhost')
    const match = /^\/api\/agent\/(execution-profiles|grants)(?:\/([^/]+))?(\/enabled)?$/.exec(url.pathname)
    if (!match) return new Response('{}', { status: 404 })
    const [, kind, rawID, enabled] = match, id = rawID ? decodeURIComponent(rawID) : undefined
    const body = init.body ? JSON.parse(String(init.body)) : undefined
    try {
      let result: unknown
      if (kind === 'execution-profiles') {
        if (enabled) result = await server.setProfileEnabled(id!, body.expectedRevision, body.enabled)
        else if (init.method === 'POST') result = await server.createProfile(body as AgentExecutionProfileInput)
        else if (init.method === 'PUT') result = await server.updateProfile(id!, body as AgentExecutionProfileInput)
        else result = id ? await server.getProfile(id, url.searchParams.has('revision') ? Number(url.searchParams.get('revision')) : undefined) : await server.listProfiles()
      } else {
        if (enabled) result = await server.setGrantEnabled(id!, body.expectedRevision, body.enabled)
        else if (init.method === 'POST') result = await server.createGrant(body as AgentExecutionGrantInput)
        else if (init.method === 'PUT') result = await server.updateGrant(id!, body as AgentExecutionGrantInput)
        else result = id ? await server.getGrant(id, url.searchParams.has('revision') ? Number(url.searchParams.get('revision')) : undefined) : await server.listGrants()
      }
      return Response.json(result)
    } catch (error) { return Response.json({ error: (error as Error).message, code: (error as AgentHttpError).code }, { status: (error as AgentHttpError).status ?? 500 }) }
  }))
  return createHttpAgentExecutionAdapter()
})

describe('执行配置 HTTP 边界', () => {
  it('新建不提交编号，更新和启停保留 expectedRevision 与完整授权', async () => {
    const fetch = vi.fn(async (_input: string, init: RequestInit) => Response.json({ ...executionGrantInput, ...JSON.parse(String(init.body)), id: 'grant-one', revision: 4, createdAt: '2026-10-20T00:00:00Z' }))
    vi.stubGlobal('fetch', fetch)
    const adapter = createHttpAgentExecutionAdapter()
    await adapter.createGrant({ ...executionGrantInput, id: 'must-not-submit' })
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1].body))).not.toHaveProperty('id')
    await adapter.updateGrant('grant-one', { ...executionGrantInput, expectedRevision: 3 })
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1].body))).toMatchObject({ expectedRevision: 3, resources: executionGrantInput.resources })
    await adapter.setGrantEnabled('grant-one', 4, false)
    expect(fetch.mock.calls[2]?.[0]).toBe('/api/agent/grants/grant-one/enabled')
    expect(JSON.parse(String(fetch.mock.calls[2]?.[1].body))).toEqual({ expectedRevision: 4, enabled: false })
  })

  it('错误修订响应不能当成指定版本，目录可用性完整保留', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...executionProfileInput, id: 'profile', revision: 2, createdAt: '2026-10-20T00:00:00Z' })))
    await expect(createHttpAgentExecutionAdapter().getProfile('profile', 1)).rejects.toThrow('不匹配')
    expect(parseCapability({ name: 'tool', description: 'description', parameters: {}, source: 'builtin', ref: { id: 'builtin', revision: 1 }, readOnly: true, available: false, selected: true, reason: '暂不可用' })).toMatchObject({ available: false, selected: true, reason: '暂不可用' })
  })
})
