import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentMCPCatalogProjection } from '@elysian/contracts'
import { createMockGateway } from '../adapters/mock/gateway'
import { resetAgentExtensionsData } from '../adapters/mock/agent/agentExtensionsMockAdapter'
import { useNotificationStore } from './notificationStore'
import { useAgentExtensionsStore, selectImportsActive } from './agentExtensionsStore'

/*
 * 技能与 MCP 域 store 测试：走 mock 网关（演示状态机），覆盖六态切换、
 * 导入任务由非终态转终态时静默重读技能目录、requestId 冲突错误留在表单、
 * 启停/删除修订 CAS 的界面反馈、probe 的 resource-busy 分支与目录读取。
 */

const gateway = createMockGateway({ eventStream: 'memory' })

beforeEach(() => {
  vi.restoreAllMocks()
  resetAgentExtensionsData()
  useAgentExtensionsStore.getState().reset()
  useNotificationStore.getState().clear()
})

describe('技能目录', () => {
  it('loadSkills 从 loading 到 ready；错误态保留旧数据并记录中文错误', async () => {
    const store = useAgentExtensionsStore.getState()
    await store.loadSkills(gateway)
    expect(useAgentExtensionsStore.getState().skillsStatus).toBe('ready')
    expect(useAgentExtensionsStore.getState().skills.length).toBeGreaterThan(0)

    // 详情读取失败（技能不存在）记录中文错误，不吞旧状态。
    await useAgentExtensionsStore.getState().loadSkillDetail(gateway, 'skill-not-exist')
    expect(useAgentExtensionsStore.getState().skillDetail?.errorMessage).toBe('技能不存在')
  })

  it('启停按修订 CAS 回读新修订；失败给通知且不吞数据', async () => {
    const store = useAgentExtensionsStore.getState()
    await store.loadSkills(gateway)
    const skill = useAgentExtensionsStore.getState().skills[0]
    expect(skill).toBeDefined()
    await store.setSkillEnabled(gateway, skill!.id, skill!.revision, !skill!.enabled)
    const updated = useAgentExtensionsStore.getState().skills.find((item) => item.id === skill!.id)
    expect(updated?.enabled).toBe(!skill!.enabled)
    expect(updated?.revision).toBe(skill!.revision + 1)
    // 旧修订再写：单飞锁解除后执行，失败走通知，列表保持服务端事实。
    await useAgentExtensionsStore.getState().setSkillEnabled(gateway, skill!.id, skill!.revision, true)
    const stillSame = useAgentExtensionsStore.getState().skills.find((item) => item.id === skill!.id)
    expect(stillSame?.revision).toBe(skill!.revision + 1)
    expect(useNotificationStore.getState().notifications.at(-1)?.message).toBe('技能修订已变化，请重新读取')
  })

  it('删除确认走 deleteTarget，成功后从列表消失', async () => {
    const store = useAgentExtensionsStore.getState()
    await store.loadSkills(gateway)
    const skill = useAgentExtensionsStore.getState().skills[0]!
    store.requestDeleteSkill({ skillId: skill.id, name: skill.manifest.name, revision: skill.revision })
    expect(useAgentExtensionsStore.getState().deleteTarget).not.toBeNull()
    store.cancelDeleteSkill()
    expect(useAgentExtensionsStore.getState().deleteTarget).toBeNull()
    store.requestDeleteSkill({ skillId: skill.id, name: skill.manifest.name, revision: skill.revision })
    await useAgentExtensionsStore.getState().confirmDeleteSkill(gateway)
    expect(useAgentExtensionsStore.getState().deleteTarget).toBeNull()
    expect(useAgentExtensionsStore.getState().skills.some((item) => item.id === skill.id)).toBe(false)
  })
})

describe('导入任务', () => {
  it('静默轮询传递 AbortSignal，失败向外抛出且保留旧列表', async () => {
    await useAgentExtensionsStore.getState().loadImports(gateway)
    const previous = useAgentExtensionsStore.getState().imports
    const poll = vi.spyOn(gateway.agentExtensions, 'listSkillImports').mockRejectedValue(new Error('连接中断'))
    const controller = new AbortController()
    await expect(useAgentExtensionsStore.getState().pollImports(gateway, controller.signal)).rejects.toThrow('连接中断')
    expect(poll).toHaveBeenCalledWith({ limit: 50 }, controller.signal)
    expect(useAgentExtensionsStore.getState().imports).toBe(previous)
    expect(useAgentExtensionsStore.getState().importsStatus).toBe('ready')
    controller.abort()
    poll.mockResolvedValueOnce({ items: [], nextCursor: '', hasMore: false })
    await useAgentExtensionsStore.getState().pollImports(gateway, controller.signal)
    expect(useAgentExtensionsStore.getState().imports).toBe(previous)
  })

  it('提交导入受理后进入列表；轮询到终态时静默重读技能目录并通知', async () => {
    const store = useAgentExtensionsStore.getState()
    await store.loadSkills(gateway)
    await store.loadImports(gateway)
    const before = useAgentExtensionsStore.getState().skills.length
    const ok = await useAgentExtensionsStore.getState().submitSkillImport(gateway, {
      requestId: 'store-import-1', source: { kind: 'directory', path: '/opt/skills/store-demo' }, enabled: true,
    })
    expect(ok).toBe(true)
    expect(useAgentExtensionsStore.getState().imports.some((item) => item.requestId === 'store-import-1')).toBe(true)
    expect(selectImportsActive(useAgentExtensionsStore.getState())).toBe(true)

    // 第一次轮询：queued → running。
    await useAgentExtensionsStore.getState().pollImports(gateway)
    expect(useAgentExtensionsStore.getState().imports.find((item) => item.requestId === 'store-import-1')?.state).toBe('running')
    // 第二次轮询：running → succeeded，技能目录被静默重读（多出新技能）。
    await useAgentExtensionsStore.getState().pollImports(gateway)
    expect(useAgentExtensionsStore.getState().imports.find((item) => item.requestId === 'store-import-1')?.state).toBe('succeeded')
    expect(useAgentExtensionsStore.getState().skills.length).toBe(before + 1)
    expect(selectImportsActive(useAgentExtensionsStore.getState())).toBe(false)
    expect(useNotificationStore.getState().notifications.at(-1)?.tone).toBe('success')
  })

  it('同 requestId 不同输入的 409 错误留在 importSubmitError，不抛出到调用方', async () => {
    const store = useAgentExtensionsStore.getState()
    await store.loadImports(gateway)
    const ok = await useAgentExtensionsStore.getState().submitSkillImport(gateway, {
      requestId: 'store-conflict-1', source: { kind: 'directory', path: '/opt/skills/a' }, enabled: true,
    })
    expect(ok).toBe(true)
    const retry = await useAgentExtensionsStore.getState().submitSkillImport(gateway, {
      requestId: 'store-conflict-1', source: { kind: 'directory', path: '/opt/skills/different' }, enabled: true,
    })
    expect(retry).toBe(false)
    expect(useAgentExtensionsStore.getState().importSubmitError).toBe('该请求标识已用于不同的技能导入')
    useAgentExtensionsStore.getState().clearImportSubmitError()
    expect(useAgentExtensionsStore.getState().importSubmitError).toBeNull()
  })

  it('取消导入立即反映 cancelRequestedAt/终态；终态记录删除后从列表移除', async () => {
    const store = useAgentExtensionsStore.getState()
    await store.loadImports(gateway)
    await useAgentExtensionsStore.getState().submitSkillImport(gateway, {
      requestId: 'store-cancel-1', source: { kind: 'directory', path: '/opt/skills/cancel-me' }, enabled: true,
    })
    const task = useAgentExtensionsStore.getState().imports.find((item) => item.requestId === 'store-cancel-1')!
    await useAgentExtensionsStore.getState().cancelSkillImport(gateway, task.id)
    const cancelled = useAgentExtensionsStore.getState().imports.find((item) => item.id === task.id)!
    expect(cancelled.state).toBe('cancelled')
    await useAgentExtensionsStore.getState().deleteSkillImportRecord(gateway, task.id)
    expect(useAgentExtensionsStore.getState().imports.some((item) => item.id === task.id)).toBe(false)
  })
})

describe('MCP 服务', () => {
  it('同修订探测在关闭后重开仍单飞，旧请求不会把已关闭弹窗重新打开', async () => {
    const catalog = await gateway.agentExtensions.probeMcpServer('mcp-demo-http', 2)
    let resolveProbe!: (value: AgentMCPCatalogProjection) => void
    const pending = new Promise<AgentMCPCatalogProjection>((resolve) => { resolveProbe = resolve })
    const probe = vi.spyOn(gateway.agentExtensions, 'probeMcpServer').mockReturnValue(pending)
    const first = useAgentExtensionsStore.getState().probeMcpServer(gateway, 'mcp-demo-http', 2)
    const second = useAgentExtensionsStore.getState().probeMcpServer(gateway, 'mcp-demo-http', 2)
    useAgentExtensionsStore.getState().closeProbe()
    const reopened = useAgentExtensionsStore.getState().probeMcpServer(gateway, 'mcp-demo-http', 2)
    expect(probe).toHaveBeenCalledTimes(1)
    useAgentExtensionsStore.getState().closeProbe()
    resolveProbe(catalog)
    await Promise.all([first, second, reopened])
    expect(useAgentExtensionsStore.getState().probe).toBeNull()
  })

  it('新建服务进列表；保存错误留在 mcpSaveError', async () => {
    const store = useAgentExtensionsStore.getState()
    await store.loadMcpServers(gateway)
    const before = useAgentExtensionsStore.getState().mcpServers.length
    const ok = await useAgentExtensionsStore.getState().createMcpServer(gateway, {
      name: 'store 新建', transport: 'streamable-http', url: 'https://store.example.com/mcp', active: true, revoked: false,
    })
    expect(ok).toBe(true)
    expect(useAgentExtensionsStore.getState().mcpServers.length).toBe(before + 1)
    const bad = await useAgentExtensionsStore.getState().createMcpServer(gateway, {
      name: '', transport: 'streamable-http', url: 'https://x.example.com', active: true, revoked: false,
    })
    expect(bad).toBe(false)
    expect(useAgentExtensionsStore.getState().mcpSaveError).toBe('MCP 服务名称、传输配置或凭据格式无效')
  })

  it('探测 mcp-demo-busy 记录 resourceBusy 与中文原因；探测成功保留目录投影', async () => {
    const store = useAgentExtensionsStore.getState()
    await store.probeMcpServer(gateway, 'mcp-demo-busy', 1)
    const busy = useAgentExtensionsStore.getState().probe
    expect(busy?.status).toBe('error')
    expect(busy?.resourceBusy).toBe(true)
    expect(busy?.errorMessage).toBe('存在冲突执行或未核实的执行结果，暂不能启动 MCP 探测')
    useAgentExtensionsStore.getState().closeProbe()

    await useAgentExtensionsStore.getState().probeMcpServer(gateway, 'mcp-demo-http', 2)
    const ready = useAgentExtensionsStore.getState().probe
    expect(ready?.status).toBe('ready')
    expect(ready?.projection?.protocolVersion).toBe('2025-11-25')

    await useAgentExtensionsStore.getState().loadMcpCatalog(gateway, 'mcp-demo-http', 2, ready?.projection?.digest)
    expect(useAgentExtensionsStore.getState().catalog?.status).toBe('ready')
    await useAgentExtensionsStore.getState().loadMcpCatalog(gateway, 'mcp-demo-http', 2, 'sha256:nope')
    expect(useAgentExtensionsStore.getState().catalog?.status).toBe('error')
    expect(useAgentExtensionsStore.getState().catalog?.errorMessage).toBe('MCP 服务尚无匹配的已验证目录')
  })
})

describe('扩展配置的异步边界', () => {
  it('登出代次变化与 reset 都阻止迟到的列表和探测回灌', async () => {
    const { advanceAuthGeneration } = await import('../adapters/http/unauthorized')
    const servers = await gateway.agentExtensions.listMcpServers()
    const catalog = await gateway.agentExtensions.probeMcpServer('mcp-demo-http', 2)
    let resolveList!: (items: typeof servers) => void
    let resolveProbe!: (item: typeof catalog) => void
    vi.spyOn(gateway.agentExtensions, 'listMcpServers').mockImplementation(() => new Promise(resolve => { resolveList = resolve }))
    vi.spyOn(gateway.agentExtensions, 'probeMcpServer').mockImplementation(() => new Promise(resolve => { resolveProbe = resolve }))
    const store = useAgentExtensionsStore.getState()
    const list = store.loadMcpServers(gateway)
    const probe = store.probeMcpServer(gateway, 'mcp-demo-http', 2)
    advanceAuthGeneration()
    store.reset()
    resolveList(servers); resolveProbe(catalog)
    await Promise.all([list, probe])
    expect(useAgentExtensionsStore.getState()).toMatchObject({ mcpServers: [], mcpStatus: 'idle', probe: null })
    expect(useNotificationStore.getState().notifications).toEqual([])
  })

  it('刷新失败仍保留上次 MCP 和 Skill 表格', async () => {
    const store = useAgentExtensionsStore.getState()
    await store.loadMcpServers(gateway)
    await store.loadSkills(gateway)
    const { mcpServers, skills } = useAgentExtensionsStore.getState()
    vi.spyOn(gateway.agentExtensions, 'listMcpServers').mockRejectedValue(new Error('MCP 读取失败'))
    vi.spyOn(gateway.agentExtensions, 'listSkills').mockRejectedValue(new Error('Skill 读取失败'))
    await store.loadMcpServers(gateway)
    await store.loadSkills(gateway)
    expect(useAgentExtensionsStore.getState()).toMatchObject({ mcpServers, skills, mcpStatus: 'ready', skillsStatus: 'ready', mcpErrorMessage: 'MCP 读取失败', skillsErrorMessage: 'Skill 读取失败' })
  })

  it('首页之外的活动导入继续回读，轮询保留末页游标与完成后的 Skill 回读', async () => {
    const active = await gateway.agentExtensions.createSkillImport({ requestId: 'older-active', enabled: true, source: { kind: 'directory', path: '/opt/skills/older' } })
    const done = { ...active, state: 'succeeded' as const, revision: 1 }
    useAgentExtensionsStore.setState({ importsStatus: 'ready', imports: [active], importsNextCursor: '150', importsHasMore: true })
    vi.spyOn(gateway.agentExtensions, 'listSkillImports').mockResolvedValue({ items: [], nextCursor: '50', hasMore: true })
    const detail = vi.spyOn(gateway.agentExtensions, 'getSkillImport').mockResolvedValue(done)
    const skills = vi.spyOn(gateway.agentExtensions, 'listSkills')
    await useAgentExtensionsStore.getState().pollImports(gateway)
    expect(detail).toHaveBeenCalledWith(active.id, undefined)
    expect(useAgentExtensionsStore.getState()).toMatchObject({ imports: [done], importsNextCursor: '150', importsHasMore: true })
    expect(skills).toHaveBeenCalledTimes(1)
  })

  it('取消抵达时任务已成功，仍回读 Skill 且不显示等待停止', async () => {
    const active = await gateway.agentExtensions.createSkillImport({ requestId: 'cancel-race', enabled: true, source: { kind: 'directory', path: '/opt/skills/race' } })
    useAgentExtensionsStore.getState().acceptSkillImport(gateway, active)
    vi.spyOn(gateway.agentExtensions, 'cancelSkillImport').mockResolvedValue({ ...active, state: 'succeeded', revision: 1 })
    const skills = vi.spyOn(gateway.agentExtensions, 'listSkills')
    await useAgentExtensionsStore.getState().cancelSkillImport(gateway, active.id)
    expect(skills).toHaveBeenCalledTimes(1)
    expect(selectImportsActive(useAgentExtensionsStore.getState())).toBe(false)
    expect(useNotificationStore.getState().notifications.at(-1)?.message).toContain('已结束')
  })
})
