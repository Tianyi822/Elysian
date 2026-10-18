import { beforeEach, describe, expect, it } from 'vitest'
import { AgentHttpError } from '../../http/agent/agentShared'
import { runAgentExtensionsAdapterContract } from '../../agentExtensionsAdapterContract'
import { resetAgentExtensionsData, agentExtensionsSnapshot } from './agentExtensionsData'
import { AgentExtensionsMockAdapter } from './agentExtensionsMockAdapter'

/*
 * 演示数据集测试：确定性种子（固定相对基准时间）、读取驱动的导入状态机、
 * 失败触发词与队列上限、resource-busy 演示服务，以及与 HTTP 实现共享的
 * 适配器契约套件（resetAgentExtensionsData 复位后从种子起步）。
 */

beforeEach(() => {
  resetAgentExtensionsData()
})

describe('确定性种子', () => {
  it('技能、导入记录与 MCP 服务种子相对固定基准时间可复现，复位后一致', () => {
    const first = agentExtensionsSnapshot()
    expect(first.skills).toHaveLength(2)
    expect(first.imports.map((item) => item.task.state)).toEqual(['succeeded', 'failed'])
    expect(first.servers.map((item) => item.value.id)).toEqual(['mcp-demo-http', 'mcp-demo-stdio', 'mcp-demo-busy', 'mcp-demo-revoked'])
    // minutesAgo(4330)：4330 分钟 ≈ 3 天前，相对 DATASET_BASE_TIME 确定。
    expect(first.imports[0]?.task.createdAt).toBe('2026-09-09T07:50:00.000Z')
    const adapter = new AgentExtensionsMockAdapter()
    void adapter.listSkills()
    resetAgentExtensionsData()
    expect(agentExtensionsSnapshot()).toEqual(first)
  })

  it('公开投影不含凭据与环境变量值，只有 hasCredential/hasEnvironment 布尔', async () => {
    const adapter = new AgentExtensionsMockAdapter()
    const servers = await adapter.listMcpServers()
    const http = servers.find((item) => item.id === 'mcp-demo-http')
    const stdio = servers.find((item) => item.id === 'mcp-demo-stdio')
    expect(http?.hasCredential).toBe(true)
    expect(JSON.stringify(servers)).not.toContain('demo-credential')
    expect(stdio?.stdio?.hasEnvironment).toBe(true)
    expect(JSON.stringify(servers)).not.toContain('demo-token')
    expect(JSON.stringify(servers)).not.toContain('MCP_DEMO_TOKEN')
  })
})

describe('导入状态机与错误语义', () => {
  it('来源含 broken 时读取推进到 failed，错误为中文且记录可删除', async () => {
    const adapter = new AgentExtensionsMockAdapter()
    const created = await adapter.createSkillImport({
      requestId: 'demo-broken-1', source: { kind: 'directory', path: '/opt/skills/broken-pack' }, enabled: true,
    })
    expect(created.state).toBe('queued')
    const running = await adapter.getSkillImport(created.id)
    expect(running.state).toBe('running')
    const failed = await adapter.getSkillImport(created.id)
    expect(failed.state).toBe('failed')
    expect(failed.error?.message).toBe('演示导入失败：包内缺少带 frontmatter 的 SKILL.md')
    await adapter.deleteSkillImportRecord(created.id)
    await expect(adapter.getSkillImport(created.id)).rejects.toThrow('技能导入任务不存在')
  })

  it('ZIP 导入缺文件与多余上传分别报 missing-zip / unexpected-zip', async () => {
    const adapter = new AgentExtensionsMockAdapter()
    await expect(adapter.createSkillImport({ requestId: 'demo-zip-missing', source: { kind: 'zip' }, enabled: true }))
      .rejects.toMatchObject({ code: 'missing-zip' })
    await expect(adapter.createSkillImport(
      { requestId: 'demo-zip-extra', source: { kind: 'directory', path: '/opt/skills/x' }, enabled: true },
      new Blob([new Uint8Array([1])]),
    )).rejects.toMatchObject({ code: 'unexpected-zip' })
  })

  it('导入分页按偏移游标翻页，nextCursor 保持十进制字符串', async () => {
    const adapter = new AgentExtensionsMockAdapter()
    for (let index = 0; index < 3; index += 1) {
      await adapter.createSkillImport({ requestId: `demo-page-${index}`, source: { kind: 'zip' }, enabled: true }, new Blob([new Uint8Array([index])]))
    }
    const firstPage = await adapter.listSkillImports({ limit: 2 })
    expect(firstPage.items).toHaveLength(2)
    expect(firstPage.hasMore).toBe(true)
    expect(firstPage.nextCursor).toBe('2')
    const secondPage = await adapter.listSkillImports({ cursor: firstPage.nextCursor, limit: 2 })
    expect(secondPage.items.length).toBeGreaterThan(0)
    expect(secondPage.items[0]?.id).not.toBe(firstPage.items[0]?.id)
  })
})

describe('MCP 演示语义', () => {
  it('mcp-demo-busy 的探测恒被 resource-busy 拒绝，code 供页面深链分支', async () => {
    const adapter = new AgentExtensionsMockAdapter()
    const error = await adapter.probeMcpServer('mcp-demo-busy', 1).then(() => null, (reason: unknown) => reason)
    expect(error).toBeInstanceOf(AgentHttpError)
    expect((error as AgentHttpError).code).toBe('resource-busy')
    expect((error as AgentHttpError).message).toBe('存在冲突执行或未核实的执行结果，暂不能启动 MCP 探测')
  })

  it('探测成功的目录可按 digest 固定读取，修订不匹配报 mcp-revision-not-found', async () => {
    const adapter = new AgentExtensionsMockAdapter()
    const projection = await adapter.probeMcpServer('mcp-demo-http', 2)
    expect(projection.protocolVersion).toBe('2025-11-25')
    expect(Object.keys(projection.modelAliases)).toHaveLength(projection.tools.length)
    const fixed = await adapter.getMcpCatalog('mcp-demo-http', 2, projection.digest)
    expect(fixed.digest).toBe(projection.digest)
    await expect(adapter.getMcpCatalog('mcp-demo-http', 1, projection.digest)).rejects.toMatchObject({ code: 'mcp-revision-not-found' })
    await expect(adapter.getMcpCatalog('mcp-demo-http', 2, 'sha256:不存在')).rejects.toMatchObject({ code: 'mcp-catalog-not-found' })
  })

  it('stdio 授权必须成对提供，缺一半报 invalid-mcp-grant', async () => {
    const adapter = new AgentExtensionsMockAdapter()
    await expect(adapter.createMcpServer({
      name: '残缺授权', transport: 'stdio', active: true, revoked: false,
      stdio: { image: 'img:1', command: ['a'], grantId: 'g1' },
    })).rejects.toMatchObject({ code: 'invalid-mcp-grant' })
  })
})

runAgentExtensionsAdapterContract('mock', () => {
  resetAgentExtensionsData({ empty: true })
  return new AgentExtensionsMockAdapter()
})

it('MCP 更新后保留公开历史修订及旧目录，不回显凭据', async () => {
  resetAgentExtensionsData()
  const adapter = new AgentExtensionsMockAdapter()
  const before = await adapter.getMcpServer('mcp-demo-http', 2)
  const catalog = await adapter.probeMcpServer(before.id, before.revision)
  await adapter.updateMcpServer(before.id, { name: '新名称', transport: 'streamable-http', url: before.url, credential: 'new-private-token', active: true, revoked: false, expectedRevision: before.revision })
  expect(await adapter.getMcpServer(before.id, before.revision)).toEqual(before)
  expect((await adapter.getMcpCatalog(before.id, before.revision, catalog.digest)).digest).toBe(catalog.digest)
  expect(JSON.stringify(await adapter.getMcpServer(before.id, 3))).not.toContain('new-private-token')
})
