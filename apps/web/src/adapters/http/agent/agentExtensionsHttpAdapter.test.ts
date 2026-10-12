import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentMCPCatalogProjection,
  AgentMCPServer,
  AgentSkill,
  AgentSkillImportTask,
} from '@elysian/contracts'
import { runAgentExtensionsAdapterContract } from '../../agentExtensionsAdapterContract'
import { createHttpAgentExtensionsAdapter, parseCapabilityRevocationPage, parseMCPCatalogProjection, parseSkillFilePreview, parseSkillImportTask } from './agentExtensionsHttpAdapter'

/*
 * HTTP 适配器测试分两层：
 * 1. 接线断言（vi.stubGlobal fetch）：请求落到 /api/agent/** 精确路径与查询串、
 *    请求体字段与 requestId 白名单（probe/启停/取消/删除记录不带 requestId）、
 *    multipart 只有 metadata+archive 两段、ZIP 超限与缺段在发起前被拦截；
 * 2. 契约套件（runAgentExtensionsAdapterContract）：在有状态假服务端上跑一遍与
 *    mock 相同的行为断言（假服务端镜像 extensions_routes.go 的可观察语义：
 *    读取推进导入状态机、requestId 幂等与 409、修订 CAS、目录 404 等）。
 */

type FakeCall = { url: string; method: string; body?: string; contentType?: string }

describe('技能预览与撤销记录解析', () => {
  it('保留空文本及大整数游标字符串，拒绝缺失预览内容与未知撤销类型', () => {
    expect(parseSkillFilePreview({ skillId: 'skill-1', revision: 2, path: 'empty.txt', previewable: true, content: '' }).content).toBe('')
    expect(parseSkillFilePreview({ skillId: 'skill-1', revision: 2, path: 'binary.bin', previewable: false, reason: 'binary' }).reason).toBe('binary')
    expect(() => parseSkillFilePreview({ skillId: 'skill-1', revision: 2, path: 'text.txt', previewable: true })).toThrow('预览响应无效')
    const row = { cursor: '9007199254740993', kind: 'skill', id: 'skill-1', revision: 0, reason: '已核实撤销', createdAt: '2026-10-11T00:00:00Z' }
    expect(parseCapabilityRevocationPage({ items: [row], nextCursor: row.cursor, hasMore: true })).toEqual({ items: [row], nextCursor: row.cursor, hasMore: true })
    expect(() => parseCapabilityRevocationPage({ items: [{ ...row, kind: 'unknown' }], nextCursor: '', hasMore: false })).toThrow('撤销记录响应无效')
  })

  it('文件读取固定修订并编码路径，撤销查询保留游标和信号', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ skillId: 'skill-a', revision: 2, path: 'references/a b.md', previewable: true, content: '内容' }), { headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [], nextCursor: '', hasMore: false }), { headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetcher)
    const adapter = createHttpAgentExtensionsAdapter()
    const controller = new AbortController()
    await adapter.getSkillFile('skill-a', 2, 'references/a b.md', controller.signal)
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/agent/skills/skill-a/files?revision=2&path=references%2Fa%20b.md')
    await adapter.listCapabilityRevocations({ kind: 'skill', id: 'skill-a', cursor: '9007199254740993', limit: 20 }, controller.signal)
    expect(fetcher.mock.calls[1]?.[0]).toBe('/api/agent/capability-revocations?kind=skill&id=skill-a&cursor=9007199254740993&limit=20')
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ signal: controller.signal })
  })
})

type FakeState = {
  skills: { revisions: AgentSkill[] }[]
  imports: { task: AgentSkillImportTask; canonical: string; reads: number; enabled: boolean }[]
  servers: { value: AgentMCPServer; credential: string; environment: Record<string, string> }[]
  catalogs: { serverId: string; revision: number; projection: AgentMCPCatalogProjection }[]
  calls: FakeCall[]
  sequence: { skill: number; import: number; server: number }
}

function fakeSkill(id: string, name: string, revision: number, enabled: boolean): AgentSkill {
  return {
    id, revision, createdAt: '2026-09-12T08:00:00.000Z', enabled,
    source: { kind: 'directory', path: `/opt/skills/${id}` },
    manifest: { name, description: `假服务端技能 ${name}` },
    digest: `sha256-fake-${id}-${revision}`, bytes: 4096,
    files: [{ path: 'SKILL.md', size: 2048, digest: `sha256-fake-${id}-skillmd` }],
  }
}

function fakeCatalog(serverId: string, revision: number): AgentMCPCatalogProjection {
  return {
    protocolVersion: '2025-11-25',
    capabilities: { tools: true, resources: true, prompts: true },
    tools: [{ name: `${serverId}-tool`, title: '假工具', inputSchema: { type: 'object' } }],
    resources: [{ uri: 'fake://status', name: 'fake-status' }],
    prompts: [{ name: 'fake-prompt', arguments: [{ name: 'topic', required: true }] }],
    digest: `sha256-fake-catalog-${serverId}-${revision}`,
    fetchedAt: '2026-09-12T08:00:00.000Z',
    modelAliases: { [`${serverId}-tool`]: 'mcp_fake_tool_alias' },
    resourceAliases: { 'fake://status': 'resource_fake_alias' },
    promptAliases: { 'fake-prompt': 'prompt_fake_alias' },
  }
}

function createFakeServer() {
  const state: FakeState = { skills: [], imports: [], servers: [], catalogs: [], calls: [], sequence: { skill: 0, import: 0, server: 0 } }

  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const fail = (status: number, code: string, error: string): Response => json(status, { error, code })

  const latest = (id: string): AgentSkill | undefined => {
    const stored = state.skills.find((item) => item.revisions[item.revisions.length - 1]?.id === id)
    return stored?.revisions[stored.revisions.length - 1]
  }

  const finish = (record: FakeState['imports'][number]): void => {
    record.task.endedAt = '2026-09-12T08:00:01.000Z'
    if (record.task.cancelRequestedAt) {
      record.task.state = 'cancelled'
    } else if ((record.task.source.path ?? record.task.source.url ?? '').includes('broken')) {
      record.task.state = 'failed'
      record.task.error = { code: 'skill-package-invalid', message: '包内缺少带 frontmatter 的 SKILL.md' }
    } else {
      record.task.state = 'succeeded'
      state.sequence.skill += 1
      const created = fakeSkill(`skill-fake-${state.sequence.skill}`, `fake-${state.sequence.skill}`, 1, record.enabled)
      state.skills.push({ revisions: [created] })
      record.task.skillId = created.id
      record.task.revision = 1
    }
  }

  const touch = (record: FakeState['imports'][number]): AgentSkillImportTask => {
    record.reads += 1
    if (record.reads === 1 && record.task.state === 'queued' && !record.task.cancelRequestedAt) {
      record.task.state = 'running'
      record.task.startedAt = '2026-09-12T08:00:00.500000Z'
    } else if (record.reads >= 2 && (record.task.state === 'queued' || record.task.state === 'running')) {
      finish(record)
    }
    return structuredClone(record.task)
  }

  const readBody = async (init: RequestInit | undefined): Promise<string> => {
    const body = init?.body
    if (body === undefined) return ''
    if (typeof body === 'string') return body
    // Blob 可能来自 jsdom realm（undici Response 不认跨 realm 实例），统一走 .text()。
    if (typeof (body as { text?: unknown }).text === 'function') return await (body as Blob).text()
    return String(body)
  }

  const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : String((input as Request).url ?? input)
    const path = url.split('?')[0] ?? url
    const rawQuery = url.split('?')[1] ?? ''
    const query = new URLSearchParams(rawQuery)
    const method = (init?.method ?? 'GET').toUpperCase()
    const bodyText = await readBody(init)
    const contentType = init?.headers instanceof Headers ? (init.headers.get('content-type') ?? undefined) : undefined
    state.calls.push({ url, method, body: bodyText, contentType })

    if (path === '/api/agent/skills' && method === 'GET') {
      return json(200, state.skills.map((item) => item.revisions[item.revisions.length - 1]).filter(Boolean))
    }
    if (path.startsWith('/api/agent/skills/imports')) {
      const rest = path.slice('/api/agent/skills/imports'.length)
      if (rest === '' && method === 'GET') {
        const offset = query.get('cursor') ? Number(query.get('cursor')) : 0
        const limit = query.get('limit') ? Number(query.get('limit')) : 50
        const items = state.imports.slice().reverse().slice(offset, offset + limit).map(touch)
        const hasMore = offset + limit < state.imports.length
        return json(200, { items, nextCursor: hasMore ? String(offset + limit) : '', hasMore })
      }
      if (rest === '' && method === 'POST') {
        let metadata: { requestId?: string; source?: { kind?: string; path?: string; url?: string }; enabled?: boolean }
        let archiveSignature = ''
        if (contentType?.startsWith('multipart/form-data')) {
          const boundary = /boundary=(.+)$/.exec(contentType ?? '')?.[1] ?? ''
          const parts = bodyText.split(`--${boundary}`).filter((part) => part.trim() !== '' && part.trim() !== '--')
          const metadataPart = parts[0] ?? ''
          const archivePart = parts[1] ?? ''
          if (!metadataPart.includes('name="metadata"') || metadataPart.includes('filename=')) {
            return fail(400, 'invalid-upload', '技能上传第一部分必须是 metadata JSON')
          }
          if (!archivePart.includes('name="archive"')) {
            return fail(400, 'invalid-upload', '技能上传第二部分必须是 archive')
          }
          if (parts.length > 2) {
            return fail(400, 'invalid-upload', '技能上传包含多余部分或未完整结束')
          }
          metadata = JSON.parse(metadataPart.split('\r\n\r\n')[1] ?? '{}')
          archiveSignature = String(archivePart.length)
        } else {
          metadata = JSON.parse(bodyText === '' ? '{}' : bodyText)
        }
        if (metadata.requestId === undefined || metadata.source?.kind === undefined || metadata.enabled === undefined) {
          return fail(400, 'invalid-input', '请求字段无效或含未声明的字段')
        }
        const canonical = JSON.stringify({ ...metadata, archive: archiveSignature })
        for (const record of state.imports) {
          if (record.task.requestId === metadata.requestId) {
            if (record.canonical !== canonical) return fail(409, 'request-conflict', '该请求标识已用于不同的技能导入')
            return json(200, structuredClone(record.task))
          }
        }
        state.sequence.import += 1
        const task: AgentSkillImportTask = {
          id: `import-fake-${state.sequence.import}`,
          requestId: metadata.requestId,
          state: 'queued',
          source: metadata.source as AgentSkillImportTask['source'],
          createdAt: '2026-09-12T08:00:00.000Z',
        }
        state.imports.push({ task, canonical, reads: 0, enabled: metadata.enabled === true })
        return json(202, structuredClone(task))
      }
      const id = rest.slice(1).split('/')[0]
      const action = rest.slice(1).split('/')[1]
      const record = state.imports.find((item) => item.task.id === id)
      if (record === undefined) return fail(404, 'import-not-found', '技能导入任务不存在')
      if (action === undefined && method === 'GET') return json(200, touch(record))
      if (action === 'cancel' && method === 'POST') {
        if (record.task.state === 'queued' || record.task.state === 'running') {
          if (!record.task.cancelRequestedAt) {
            record.task.cancelRequestedAt = '2026-09-12T08:00:00.750000Z'
            if (record.task.state === 'queued') {
              record.task.state = 'cancelled'
              record.task.endedAt = '2026-09-12T08:00:00.750000Z'
            }
          }
          return json(202, structuredClone(record.task))
        }
        return json(200, structuredClone(record.task))
      }
      if (action === undefined && method === 'DELETE') {
        if (record.task.state === 'queued' || record.task.state === 'running') {
          return fail(409, 'import-not-finished', '导入任务尚未结束，不能删除记录')
        }
        state.imports = state.imports.filter((item) => item !== record)
        return json(200, structuredClone(record.task))
      }
      return fail(404, 'not-stubbed', `测试未实现的端点：${method} ${url}`)
    }
    if (path.startsWith('/api/agent/skills/')) {
      const id = decodeURIComponent(path.slice('/api/agent/skills/'.length))
      const stored = state.skills.find((item) => item.revisions.some((entry) => entry.id === id))
      if (method === 'GET') {
        if (stored === undefined) return fail(404, 'skill-not-found', '技能不存在')
        const revision = query.get('revision')
        const found = revision === null
          ? stored.revisions[stored.revisions.length - 1]
          : stored.revisions.find((entry) => String(entry.revision) === revision)
        if (found === undefined) return fail(404, 'skill-revision-not-found', '技能修订不存在')
        return json(200, found)
      }
      if (method === 'PUT') {
        const input = JSON.parse(bodyText) as { expectedRevision?: number; enabled?: boolean }
        if (typeof input.enabled !== 'boolean' || typeof input.expectedRevision !== 'number') {
          return fail(400, 'invalid-enabled-input', '启停操作必须指定 enabled 和当前修订')
        }
        const current = latest(id)
        if (current === undefined) return fail(404, 'skill-not-found', '技能不存在')
        if (current.revision !== input.expectedRevision) return fail(409, 'skill-revision-conflict', '技能修订已变化，请重新读取')
        if (current.enabled === input.enabled) return json(200, current)
        const next = { ...structuredClone(current), revision: current.revision + 1, enabled: input.enabled }
        stored?.revisions.push(next)
        return json(200, next)
      }
      if (method === 'DELETE') {
        const revision = query.get('revision')
        const current = latest(id)
        if (current === undefined) return fail(404, 'skill-not-found', '技能不存在')
        if (revision === null || String(current.revision) !== revision) return fail(409, 'skill-revision-conflict', '技能修订已变化，请重新读取')
        state.skills = state.skills.filter((item) => item !== stored)
        return json(200, current)
      }
    }
    if (path === '/api/agent/mcp-servers' && method === 'GET') {
      return json(200, state.servers.map((item) => item.value))
    }
    if (path === '/api/agent/mcp-servers' && method === 'POST') {
      const input = JSON.parse(bodyText) as Record<string, unknown>
      if (input.requestId !== undefined) return fail(400, 'invalid-input', '请求字段无效或含未声明的字段')
      state.sequence.server += 1
      const id = `mcp-fake-${state.sequence.server}`
      const stdioInput = input.stdio as Record<string, unknown> | undefined
      const server: AgentMCPServer = {
        id, revision: 1, name: String(input.name ?? ''), transport: input.transport as AgentMCPServer['transport'],
        ...(input.url !== undefined ? { url: String(input.url) } : {}),
        ...(stdioInput !== undefined ? {
          stdio: {
            image: String(stdioInput.image ?? ''),
            command: (stdioInput.command ?? []) as string[],
            hasEnvironment: Object.keys((stdioInput.environment ?? {}) as Record<string, string>).length > 0,
            ...(stdioInput.grantId !== undefined ? { grantId: String(stdioInput.grantId) } : {}),
            ...(stdioInput.grantRevision !== undefined ? { grantRevision: Number(stdioInput.grantRevision) } : {}),
          },
        } : {}),
        active: Boolean(input.active), revoked: Boolean(input.revoked), hasCredential: String(input.credential ?? '') !== '',
      }
      state.servers.push({
        value: server,
        credential: String(input.credential ?? ''),
        environment: { ...((stdioInput?.environment ?? {}) as Record<string, string>) },
      })
      return json(201, server)
    }
    if (path.startsWith('/api/agent/mcp-servers/')) {
      const rest = path.slice('/api/agent/mcp-servers/'.length)
      const id = rest.split('/')[0] ?? ''
      const action = rest.split('/')[1]
      const stored = state.servers.find((item) => item.value.id === id)
      if (action === 'probe' && method === 'POST') {
        const body = JSON.parse(bodyText) as Record<string, unknown>
        if (Object.keys(body).length !== 1 || typeof body.revision !== 'number' || body.revision < 1) {
          return fail(400, 'invalid-revision', '探测必须固定服务修订')
        }
        if (stored === undefined || stored.value.revision !== body.revision) return fail(404, 'mcp-revision-not-found', 'MCP 配置修订不存在')
        const projection = fakeCatalog(id, body.revision)
        const existing = state.catalogs.find((item) => item.serverId === id && item.revision === body.revision && item.projection.digest === projection.digest)
        if (existing === undefined) state.catalogs.push({ serverId: id, revision: body.revision, projection })
        return json(200, projection)
      }
      if (action === 'catalog' && method === 'GET') {
        const revision = Number(query.get('revision') ?? '')
        const digest = query.get('digest') ?? ''
        if (stored === undefined || stored.value.revision !== revision) return fail(404, 'mcp-revision-not-found', 'MCP 配置修订不存在')
        const record = state.catalogs.find((item) => item.serverId === id && item.revision === revision && (digest === '' || item.projection.digest === digest))
        if (record === undefined) return fail(404, 'mcp-catalog-not-found', 'MCP 服务尚无匹配的已验证目录')
        return json(200, record.projection)
      }
      if (action === undefined && method === 'GET') {
        if (stored === undefined) return fail(404, 'mcp-not-found', 'MCP 服务不存在')
        const revision = query.get('revision')
        if (revision === null || String(stored.value.revision) !== revision) return fail(404, 'mcp-revision-not-found', 'MCP 配置修订不存在')
        return json(200, stored.value)
      }
      if (action === undefined && method === 'PUT') {
        const input = JSON.parse(bodyText) as Record<string, unknown> & { expectedRevision?: number }
        if (stored === undefined) return fail(404, 'mcp-not-found', 'MCP 服务不存在')
        if (input.expectedRevision !== stored.value.revision) return fail(409, 'revision-conflict', 'MCP 配置已修改，请重新读取后重试')
        const stdio = input.stdio as Record<string, unknown> | undefined
        if (stdio !== undefined && stdio.environment !== undefined) {
          stored.environment = { ...(stdio.environment as Record<string, string>) }
        }
        stored.value = {
          ...structuredClone(stored.value),
          revision: stored.value.revision + 1,
          name: String(input.name ?? stored.value.name),
          active: Boolean(input.active),
          ...(stdio !== undefined ? {
            stdio: {
              ...(stored.value.stdio ?? { image: '', command: [] }),
              image: String(stdio.image ?? ''),
              command: (stdio.command ?? []) as string[],
              hasEnvironment: Object.keys(stored.environment).length > 0,
              ...(stdio.grantId !== undefined ? { grantId: String(stdio.grantId) } : {}),
              ...(stdio.grantRevision !== undefined ? { grantRevision: Number(stdio.grantRevision) } : {}),
            },
          } : {}),
          hasCredential: stored.credential !== '',
        }
        return json(200, stored.value)
      }
    }
    return fail(404, 'not-stubbed', `测试未登记的 Agent 端点：${method} ${url}`)
  })

  return { fetchImpl, state }
}

let server: ReturnType<typeof createFakeServer>

beforeEach(() => {
  server = createFakeServer()
  vi.stubGlobal('fetch', server.fetchImpl)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('HTTP 接线断言', () => {
  it('listSkills 落到 GET /api/agent/skills，不带查询参数', async () => {
    const adapter = createHttpAgentExtensionsAdapter()
    await adapter.listSkills()
    expect(server.fetchImpl).toHaveBeenCalledTimes(1)
    expect(server.fetchImpl.mock.calls[0]?.[0]).toBe('/api/agent/skills')
  })

  it('getSkill 带 revision 走查询参数；缺省不发送 revision', async () => {
    const adapter = createHttpAgentExtensionsAdapter()
    server.state.skills.push({ revisions: [fakeSkill('skill-1', 'demo', 3, true)] })
    await adapter.getSkill('skill-1', 3)
    expect(server.fetchImpl.mock.calls[0]?.[0]).toBe('/api/agent/skills/skill-1?revision=3')
    await adapter.getSkill('skill-1')
    expect(server.fetchImpl.mock.calls[1]?.[0]).toBe('/api/agent/skills/skill-1')
  })

  it('启停 PUT 体只有 expectedRevision 与 enabled，绝无 requestId', async () => {
    const adapter = createHttpAgentExtensionsAdapter()
    server.state.skills.push({ revisions: [fakeSkill('skill-1', 'demo', 2, true)] })
    await adapter.setSkillEnabled('skill-1', 2, false)
    const call = server.state.calls[0]
    expect(call?.url).toBe('/api/agent/skills/skill-1')
    expect(call?.method).toBe('PUT')
    expect(JSON.parse(call?.body ?? '{}')).toEqual({ expectedRevision: 2, enabled: false })
  })

  it('删除技能把 revision 放在查询参数', async () => {
    const adapter = createHttpAgentExtensionsAdapter()
    server.state.skills.push({ revisions: [fakeSkill('skill-1', 'demo', 4, true)] })
    await adapter.deleteSkill('skill-1', 4)
    expect(server.state.calls[0]?.url).toBe('/api/agent/skills/skill-1?revision=4')
    expect(server.state.calls[0]?.method).toBe('DELETE')
  })

  it('导入列表带 cursor 与 limit；取消无请求体；记录删除为 DELETE', async () => {
    const adapter = createHttpAgentExtensionsAdapter()
    server.state.imports.push({
      task: { id: 'import-9', requestId: 'req-9', state: 'succeeded', source: { kind: 'zip' }, createdAt: '2026-09-12T08:00:00.000Z', endedAt: '2026-09-12T08:00:01.000Z' },
      canonical: 'fake-import-9', reads: 9, enabled: true,
    })
    await adapter.listSkillImports({ cursor: '4', limit: 10 })
    expect(server.state.calls[0]?.url).toBe('/api/agent/skills/imports?cursor=4&limit=10')
    await adapter.cancelSkillImport('import-9')
    expect(server.state.calls[1]?.method).toBe('POST')
    expect(server.state.calls[1]?.body).toBe('')
    expect(server.state.calls[1]?.url).toBe('/api/agent/skills/imports/import-9/cancel')
    await adapter.deleteSkillImportRecord('import-9')
    expect(server.state.calls[2]?.method).toBe('DELETE')
  })

  it('JSON 导入 POST 体带 requestId；multipart 组包只有 metadata+archive 两段且不带 filename', async () => {
    const adapter = createHttpAgentExtensionsAdapter()
    await adapter.createSkillImport({ requestId: 'req-json-1', source: { kind: 'directory', path: '/opt/skills/a' }, enabled: true })
    const jsonCall = server.state.calls[0]
    expect(JSON.parse(jsonCall?.body ?? '{}')).toEqual({
      requestId: 'req-json-1', source: { kind: 'directory', path: '/opt/skills/a' }, enabled: true,
    })
    const archive = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'application/zip' })
    await adapter.createSkillImport({ requestId: 'req-zip-1', source: { kind: 'zip' }, enabled: false }, archive)
    const zipCall = server.state.calls[1]
    expect(zipCall?.contentType).toMatch(/^multipart\/form-data; boundary=/)
    expect(zipCall?.body).toContain('Content-Disposition: form-data; name="metadata"')
    expect(zipCall?.body).toContain('Content-Disposition: form-data; name="archive"')
    expect(zipCall?.body).not.toContain('filename=')
    // 两段之后就是收尾边界，没有第三段。
    const boundary = /boundary=(.+)$/.exec(zipCall?.contentType ?? '')?.[1] ?? ''
    const parts = (zipCall?.body ?? '').split(`--${boundary}`).filter((part) => part.trim() !== '' && part.trim() !== '--')
    expect(parts).toHaveLength(2)
  })

  it('ZIP 缺文件、目录来源携带 ZIP、超过 64 MiB 都在发起前被拦截（不发请求）', async () => {
    const adapter = createHttpAgentExtensionsAdapter()
    await expect(adapter.createSkillImport({ requestId: 'req-bad-1', source: { kind: 'zip' }, enabled: true }))
      .rejects.toThrow('ZIP 导入必须选择上传文件')
    await expect(adapter.createSkillImport(
      { requestId: 'req-bad-2', source: { kind: 'directory', path: '/opt/skills/a' }, enabled: true },
      new Blob([new Uint8Array([1])]),
    )).rejects.toThrow('本地目录来源不接受 ZIP 上传')
    await expect(adapter.createSkillImport(
      { requestId: 'req-bad-3', source: { kind: 'directory', path: 'relative/path' }, enabled: true },
    )).rejects.toThrow('绝对路径')
    await expect(adapter.createSkillImport(
      { requestId: 'req-bad-4', source: { kind: 'git', url: 'http://insecure.example.com/repo.git', ref: 'v1' }, enabled: true },
    )).rejects.toThrow('HTTPS')
    await expect(adapter.createSkillImport(
      { requestId: 'req-bad-5', source: { kind: 'zip' }, enabled: true },
      new Blob([new Uint8Array(64 * 1024 * 1024 + 1)]),
    )).rejects.toThrow('64 MiB')
    expect(server.fetchImpl).not.toHaveBeenCalled()
  })

  it('MCP 新建/更新体不带 requestId；probe 体精确为 {"revision":N}；catalog 查询串逐段编码', async () => {
    const adapter = createHttpAgentExtensionsAdapter()
    const created = await adapter.createMcpServer({
      name: '演示', transport: 'streamable-http', url: 'https://mcp.example.com/mcp', active: true, revoked: false,
    })
    const createBody = JSON.parse(server.state.calls[0]?.body ?? '{}')
    expect(createBody.requestId).toBeUndefined()
    expect(createBody).toEqual({ name: '演示', transport: 'streamable-http', url: 'https://mcp.example.com/mcp', active: true, revoked: false })

    await adapter.updateMcpServer(created.id, {
      name: '演示改名', transport: 'streamable-http', url: 'https://mcp.example.com/mcp', active: true, revoked: false, expectedRevision: 1,
    })
    const updateBody = JSON.parse(server.state.calls[1]?.body ?? '{}')
    expect(updateBody.expectedRevision).toBe(1)
    expect(updateBody.requestId).toBeUndefined()

    await adapter.getMcpServer(created.id, 2)
    expect(server.state.calls[2]?.url).toBe(`/api/agent/mcp-servers/${created.id}?revision=2`)

    const projection = await adapter.probeMcpServer(created.id, 2)
    expect(server.state.calls[3]?.body).toBe('{"revision":2}')
    expect(projection.protocolVersion).toBe('2025-11-25')

    await adapter.getMcpCatalog(created.id, 2, projection.digest)
    expect(server.state.calls[4]?.url).toBe(`/api/agent/mcp-servers/${created.id}/catalog?revision=2&digest=${encodeURIComponent(projection.digest)}`)
  })

  it('stdio 输入体：environment 省略即不发送、空对象原样发送（清除语义）', async () => {
    const adapter = createHttpAgentExtensionsAdapter()
    await adapter.createMcpServer({
      name: 'stdio 演示', transport: 'stdio', active: true, revoked: false,
      stdio: { image: 'img:1', command: ['a', 'b'], grantId: 'g1', grantRevision: 2, environment: { A: '1' } },
    })
    const createBody = JSON.parse(server.state.calls[0]?.body ?? '{}') as { stdio: Record<string, unknown> }
    expect(createBody.stdio.environment).toEqual({ A: '1' })

    const updated = await adapter.updateMcpServer('mcp-fake-1', {
      name: 'stdio 演示', transport: 'stdio', active: true, revoked: false,
      stdio: { image: 'img:1', command: ['a'] },
      expectedRevision: 1,
    })
    const updateBody = JSON.parse(server.state.calls[1]?.body ?? '{}') as { stdio: Record<string, unknown> }
    expect('environment' in updateBody.stdio).toBe(false)
    expect(updated.stdio?.hasEnvironment).toBe(true)

    await adapter.updateMcpServer('mcp-fake-1', {
      name: 'stdio 演示', transport: 'stdio', active: true, revoked: false,
      stdio: { image: 'img:1', command: ['a'], environment: {} },
      expectedRevision: 2,
    })
    const clearBody = JSON.parse(server.state.calls[2]?.body ?? '{}') as { stdio: Record<string, unknown> }
    expect(clearBody.stdio.environment).toEqual({})
  })
})

describe('parse 纯函数', () => {
  it('parseSkillImportTask 拒绝漂移形状与非法状态', () => {
    expect(() => parseSkillImportTask({ id: 'i', requestId: 'r', state: 'paused', createdAt: 'x', source: { kind: 'zip' } })).toThrow('技能导入任务响应无效')
    expect(() => parseSkillImportTask({ id: 'i', requestId: 'r', state: 'queued', createdAt: 'x', source: { kind: 'unknown' } })).toThrow('来源无效')
    expect(() => parseSkillImportTask({ id: 'i', requestId: 'r', state: 'queued', createdAt: 'x', source: { kind: 'zip' }, revision: '3' })).toThrow('技能导入任务响应无效')
  })

  it('parseMCPCatalogProjection 校验协议版本、别名与能力位', () => {
    const projection = fakeCatalog('mcp-1', 1)
    expect(parseMCPCatalogProjection(projection).modelAliases).toEqual(projection.modelAliases)
    expect(() => parseMCPCatalogProjection({ ...projection, protocolVersion: '2024-11-05' })).toThrow('协议版本无效')
    expect(() => parseMCPCatalogProjection({ ...projection, capabilities: { tools: 'yes', resources: true, prompts: true } })).toThrow('无效')
    expect(() => parseMCPCatalogProjection({ ...projection, modelAliases: { a: 1 } })).toThrow('别名无效')
  })
})

runAgentExtensionsAdapterContract('HTTP', () => createHttpAgentExtensionsAdapter())
