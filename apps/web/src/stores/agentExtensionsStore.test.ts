import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentMCPCatalogProjection } from '@elysian/contracts'
import { createMockGateway } from '../adapters/mock/gateway'
import { resetAgentExtensionsData } from '../adapters/mock/agent/agentExtensionsMockAdapter'
import { useMessageStore } from './messageStore'
import { useAgentExtensionsStore, selectImportsActive } from './agentExtensionsStore'
import { AgentHttpError } from '../contracts/agentHttpError'
import { advanceAuthGeneration } from '../utils/authGeneration'

/*
 * 技能与 MCP 域 store 测试：走 mock 网关（演示状态机），覆盖六态切换、
 * 导入任务由非终态转终态时静默重读技能目录、requestId 冲突错误留在表单、
 * 启停/删除修订 CAS 的界面反馈、probe 的 resource-busy 分支与目录读取。
 */

const gateway = createMockGateway({ eventStream: 'memory' })

beforeEach(async () => {
  vi.restoreAllMocks()
  resetAgentExtensionsData()
  useAgentExtensionsStore.getState().reset()
  await useMessageStore.getState().clear()
})

describe('技能目录', () => {
  it('loadSkills 从 loading 到 ready；错误态保留旧数据并记录中文错误', async () => {
    const store = useAgentExtensionsStore.getState()
    await store.loadSkills(gateway)
    expect(useAgentExtensionsStore.getState().skillsStatus).toBe('ready')
    expect(useAgentExtensionsStore.getState().skills.length).toBeGreaterThan(0)

    // 详情错误不影响目录快照。
    const skills = useAgentExtensionsStore.getState().skills
    const detail = store.loadSkillDetail(gateway, 'skill-not-exist')
    expect(useAgentExtensionsStore.getState().skillDetail).toMatchObject({ status: 'loading' })
    await detail
    expect(useAgentExtensionsStore.getState().skillDetail).toMatchObject({ status: 'error', errorMessage: '技能不存在' })
    expect(useAgentExtensionsStore.getState().skills).toBe(skills)
    await store.loadSkillDetail(gateway, skills[0]!.id)
    expect(useAgentExtensionsStore.getState().skillDetail).toMatchObject({ status: 'ready', item: { id: skills[0]!.id } })
    store.closeSkillDetail()
    expect(useAgentExtensionsStore.getState().skillDetail).toBeNull()
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
    expect(useMessageStore.getState().messages.at(-1)?.message).toBe('技能修订已变化，请重新读取')
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

  it('重置后旧 Skill 列表和详情请求不能覆盖新读取', async () => {
    const store = useAgentExtensionsStore.getState()
    const skills = await gateway.agentExtensions.listSkills()
    const detail = await gateway.agentExtensions.getSkill(skills[0]!.id)
    let resolveList!: (items: typeof skills) => void
    let rejectDetail!: (error: Error) => void
    vi.spyOn(gateway.agentExtensions, 'listSkills').mockImplementationOnce(() => new Promise(resolve => { resolveList = resolve }))
    vi.spyOn(gateway.agentExtensions, 'getSkill').mockImplementationOnce(() => new Promise((_, reject) => { rejectDetail = reject }))

    const oldList = store.loadSkills(gateway)
    const oldDetail = store.loadSkillDetail(gateway, detail.id)
    store.reset()
    await Promise.all([store.loadSkills(gateway), store.loadSkillDetail(gateway, detail.id)])
    const after = useAgentExtensionsStore.getState()
    resolveList([])
    rejectDetail(new Error('旧详情读取失败'))
    await Promise.all([oldList, oldDetail])

    const current = useAgentExtensionsStore.getState()
    expect(current.skills).toBe(after.skills)
    expect(current.skills).toEqual(skills)
    expect(current.skillDetail).toMatchObject({ status: 'ready', item: detail })
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
    expect(useMessageStore.getState().messages.at(-1)?.tone).toBe('success')
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
  it('批量启停的迟到回执不会覆盖刷新已读到的后续 MCP 和 Skill 修订', async () => {
    await Promise.all([useAgentExtensionsStore.getState().loadMcpServers(gateway), useAgentExtensionsStore.getState().loadSkills(gateway)])
    const servers = useAgentExtensionsStore.getState().mcpServers
    const skills = useAgentExtensionsStore.getState().skills
    const server = servers.find(item => item.id === 'mcp-demo-http')!
    const skill = skills[0]!
    const newerServer = { ...server, revision: server.revision + 2, name: '后续 MCP 修订' }
    const newerSkill = { ...skill, revision: skill.revision + 2, manifest: { ...skill.manifest, name: '后续 Skill 修订' } }
    let resolveServer!: (value: typeof server) => void
    let resolveSkill!: (value: typeof skill) => void
    vi.spyOn(gateway.agentExtensions, 'updateMcpServer').mockImplementationOnce(() => new Promise(done => { resolveServer = done }))
    vi.spyOn(gateway.agentExtensions, 'setSkillEnabled').mockImplementationOnce(() => new Promise(done => { resolveSkill = done }))
    const mcpWrite = useAgentExtensionsStore.getState().setMcpActive(gateway, server, false)
    const skillWrite = useAgentExtensionsStore.getState().setSkillEnabledResult(gateway, skill, !skill.enabled)
    vi.spyOn(gateway.agentExtensions, 'listMcpServers').mockResolvedValueOnce(servers.map(item => item.id === server.id ? newerServer : item))
    vi.spyOn(gateway.agentExtensions, 'listSkills').mockResolvedValueOnce(skills.map(item => item.id === skill.id ? newerSkill : item))
    await Promise.all([useAgentExtensionsStore.getState().loadMcpServers(gateway), useAgentExtensionsStore.getState().loadSkills(gateway)])
    resolveServer({ ...server, revision: server.revision + 1, active: false })
    resolveSkill({ ...skill, revision: skill.revision + 1, enabled: !skill.enabled })
    expect((await mcpWrite).status).toBe('succeeded')
    expect((await skillWrite).status).toBe('succeeded')
    expect(useAgentExtensionsStore.getState().mcpServers.find(item => item.id === server.id)).toEqual(newerServer)
    expect(useAgentExtensionsStore.getState().skills.find(item => item.id === skill.id)).toEqual(newerSkill)
  })

  it('删除回执迟到时不移除随后读到的同 ID 更新修订', async () => {
    await useAgentExtensionsStore.getState().loadSkills(gateway)
    const skills = useAgentExtensionsStore.getState().skills
    const skill = skills[0]!
    const newer = { ...skill, revision: skill.revision + 1 }
    let resolve!: () => void
    vi.spyOn(gateway.agentExtensions, 'deleteSkill').mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const pending = useAgentExtensionsStore.getState().deleteSkillResult(gateway, skill)
    vi.spyOn(gateway.agentExtensions, 'listSkills').mockResolvedValueOnce(skills.map(item => item.id === skill.id ? newer : item))
    await useAgentExtensionsStore.getState().loadSkills(gateway)
    resolve()
    expect((await pending).status).toBe('succeeded')
    expect(useAgentExtensionsStore.getState().skills.find(item => item.id === skill.id)).toEqual(newer)
  })

  it('批量启停保留 HTTP 凭据与 stdio 历史授权、环境变量，不提交秘密', async () => {
    await useAgentExtensionsStore.getState().loadMcpServers(gateway)
    const update = vi.spyOn(gateway.agentExtensions, 'updateMcpServer')
    const http = useAgentExtensionsStore.getState().mcpServers.find(item => item.id === 'mcp-demo-http')!
    const stdio = useAgentExtensionsStore.getState().mcpServers.find(item => item.id === 'mcp-demo-stdio')!
    expect((await useAgentExtensionsStore.getState().setMcpActive(gateway, http, false)).status).toBe('succeeded')
    expect((await useAgentExtensionsStore.getState().setMcpActive(gateway, stdio, false)).status).toBe('succeeded')
    expect(update.mock.calls[0]![1]).not.toHaveProperty('credential')
    expect(update.mock.calls[1]![1].stdio).toEqual({ image: stdio.stdio!.image, command: stdio.stdio!.command, grantId: stdio.stdio!.grantId, grantRevision: stdio.stdio!.grantRevision })
    expect(update.mock.calls[1]![1].stdio).not.toHaveProperty('environment')
    expect(useAgentExtensionsStore.getState().mcpServers.find(item => item.id === http.id)?.hasCredential).toBe(true)
    expect(useAgentExtensionsStore.getState().mcpServers.find(item => item.id === stdio.id)?.stdio?.hasEnvironment).toBe(true)
  })

  it('运行需求原样保留；永久撤销与陈旧修订均在派发前拒绝', async () => {
    await useAgentExtensionsStore.getState().loadMcpServers(gateway)
    const stdio = useAgentExtensionsStore.getState().mcpServers.find(item => item.id === 'mcp-demo-stdio')!
    const configured = { ...stdio, stdio: { image: stdio.stdio!.image, command: stdio.stdio!.command, hasEnvironment: true, requestedAccess: { directories: [{ path: '/srv/data', access: 'ro' as const }], network: [{ scheme: 'https' as const, host: 'api.example.com', port: 443 }], privateCidrs: [] } } }
    useAgentExtensionsStore.setState(state => ({ mcpServers: state.mcpServers.map(item => item.id === stdio.id ? configured : item) }))
    const update = vi.spyOn(gateway.agentExtensions, 'updateMcpServer').mockResolvedValueOnce({ ...configured, active: false, revision: configured.revision + 1 })
    expect((await useAgentExtensionsStore.getState().setMcpActive(gateway, configured, false)).status).toBe('succeeded')
    expect(update.mock.calls[0]![1].stdio?.requestedAccess).toEqual(configured.stdio.requestedAccess)
    expect((await useAgentExtensionsStore.getState().setMcpActive(gateway, configured, true)).status).toBe('failed')
    const revoked = useAgentExtensionsStore.getState().mcpServers.find(item => item.revoked)!
    expect((await useAgentExtensionsStore.getState().setMcpActive(gateway, revoked, true)).status).toBe('failed')
    expect(update).toHaveBeenCalledTimes(1)
  })

  it('Skill 批量写入使用确认时修订，未知结果不改目录也不重投', async () => {
    await useAgentExtensionsStore.getState().loadSkills(gateway)
    const skill = useAgentExtensionsStore.getState().skills[0]!
    const toggle = vi.spyOn(gateway.agentExtensions, 'setSkillEnabled').mockRejectedValueOnce(new Error('网络断开'))
    const remove = vi.spyOn(gateway.agentExtensions, 'deleteSkill').mockRejectedValueOnce(new AgentHttpError('修订已变化', 'revision-conflict', 409))
    expect((await useAgentExtensionsStore.getState().setSkillEnabledResult(gateway, skill, !skill.enabled)).status).toBe('unknown')
    expect(toggle).toHaveBeenCalledExactlyOnceWith(skill.id, skill.revision, !skill.enabled)
    expect(useAgentExtensionsStore.getState().skills[0]).toEqual(skill)
    expect((await useAgentExtensionsStore.getState().deleteSkillResult(gateway, skill)).status).toBe('failed')
    expect(remove).toHaveBeenCalledExactlyOnceWith(skill.id, skill.revision)
    expect(useAgentExtensionsStore.getState().skills.some(item => item.id === skill.id)).toBe(true)
    expect(useAgentExtensionsStore.getState().togglingSkillIds).toEqual([])
    expect(useAgentExtensionsStore.getState().deletingSkill).toBe(false)
  })

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
  it.each([
    { label: '登录代次变化', invalidate: advanceAuthGeneration },
    { label: '重置 store', invalidate: () => useAgentExtensionsStore.getState().reset() },
  ])('$label 阻止迟到的列表和探测回灌', async ({ invalidate }) => {
    const servers = await gateway.agentExtensions.listMcpServers()
    const catalog = await gateway.agentExtensions.probeMcpServer('mcp-demo-http', 2)
    let resolveList!: (items: typeof servers) => void
    let resolveProbe!: (item: typeof catalog) => void
    vi.spyOn(gateway.agentExtensions, 'listMcpServers').mockImplementation(() => new Promise(resolve => { resolveList = resolve }))
    vi.spyOn(gateway.agentExtensions, 'probeMcpServer').mockImplementation(() => new Promise(resolve => { resolveProbe = resolve }))
    const store = useAgentExtensionsStore.getState()
    const list = store.loadMcpServers(gateway)
    const probe = store.probeMcpServer(gateway, 'mcp-demo-http', 2)
    invalidate()
    const state = useAgentExtensionsStore.getState()
    resolveList(servers); resolveProbe(catalog)
    await Promise.all([list, probe])
    expect(useAgentExtensionsStore.getState()).toBe(state)
    expect(useMessageStore.getState().messages).toEqual([])
  })

  it('不同技能的启停可以并行，两份回执都能写回', async () => {
    const store = useAgentExtensionsStore.getState()
    await store.loadSkills(gateway)
    const first = useAgentExtensionsStore.getState().skills[0]!
    const second = useAgentExtensionsStore.getState().skills[1]!
    const firstUpdate = { ...first, enabled: !first.enabled, revision: first.revision + 1 }
    const secondUpdate = { ...second, enabled: !second.enabled, revision: second.revision + 1 }
    let resolveFirst!: (skill: typeof first) => void
    vi.spyOn(gateway.agentExtensions, 'setSkillEnabled')
      .mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve }))
      .mockResolvedValueOnce(secondUpdate)

    const pending = store.setSkillEnabledResult(gateway, first, firstUpdate.enabled)
    await expect(store.setSkillEnabledResult(gateway, second, secondUpdate.enabled)).resolves.toEqual({ status: 'succeeded' })
    expect(useAgentExtensionsStore.getState().togglingSkillIds).toEqual([first.id])
    resolveFirst(firstUpdate)
    await expect(pending).resolves.toEqual({ status: 'succeeded' })
    expect(useAgentExtensionsStore.getState().skills).toEqual(expect.arrayContaining([firstUpdate, secondUpdate]))
    expect(useAgentExtensionsStore.getState().togglingSkillIds).toEqual([])
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
    expect(useMessageStore.getState().messages.at(-1)?.message).toContain('已结束')
  })
})
