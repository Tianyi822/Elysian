import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within, waitFor } from '@testing-library/react'
import { Profiler, type ProfilerOnRenderCallback } from 'react'
import * as Tooltip from '@radix-ui/react-tooltip'
import userEvent from '@testing-library/user-event'
import { GatewayProvider } from '../../adapters/GatewayProvider'
import { createMockGateway } from '../../adapters/mock/gateway'
import { AgentHttpError } from '../../contracts/agentHttpError'
import { renderApp } from '../../test/renderApp'
import { resetAgentExtensionsData } from '../../adapters/mock/agent/agentExtensionsMockAdapter'
import { useAgentExtensionsStore } from '../../stores/agentExtensionsStore'
import { useAgentRuntimeStore } from '../../stores/agentRuntimeStore'
import { useSessionStore } from '../../stores/sessionStore'
import { McpSection } from './McpSection'
import { SkillsSection } from './SkillsSection'

beforeEach(() => {
  vi.restoreAllMocks()
  resetAgentExtensionsData()
  useAgentExtensionsStore.getState().reset()
  useAgentRuntimeStore.getState().reset()
  useSessionStore.setState({ phase: 'unknown', mode: undefined, devAccount: false, notice: null })
})

describe('设置表格切换页签', () => {
  it.each([
    { tab: 'models', label: 'gpt-5' },
    { tab: 'mcp', label: '演示检索（HTTP）' },
    { tab: 'skills', label: 'incident-triage' },
  ])('$tab 离开时关闭批量确认，再回来清除选择且不派发旧目标', async ({ tab, label }) => {
    const gateway = makeGateway()
    const writes = [vi.spyOn(gateway.modelSettings, 'updateModelService'), vi.spyOn(gateway.agentExtensions, 'updateMcpServer'), vi.spyOn(gateway.agentExtensions, 'setSkillEnabled')]
    const { router } = renderApp(`/settings?tab=${tab}`, { gateway })
    const user = userEvent.setup()
    await user.click(await screen.findByRole('checkbox', { name: `选择 ${label}` }))
    await user.click(screen.getByRole('button', { name: '批量停用' }))
    expect(screen.getByRole('dialog', { name: '确认批量停用？' })).toBeInTheDocument()
    await act(async () => { await router.navigate('/settings?tab=account') })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '确认批量停用？' })).not.toBeInTheDocument())
    await act(async () => { await router.navigate(`/settings?tab=${tab}`) })
    expect(await screen.findByRole('checkbox', { name: `选择 ${label}` })).toHaveAttribute('aria-checked', 'false')
    writes.forEach(write => expect(write).not.toHaveBeenCalled())
  })
})

describe('设置中的 MCP 配置', () => {
  it('批量启用列明永久撤销的跳过原因，未确认不提交', async () => {
    const gateway = makeGateway()
    const update = vi.spyOn(gateway.agentExtensions, 'updateMcpServer')
    renderApp('/settings?tab=mcp', { gateway })
    const user = userEvent.setup()
    await user.click(await screen.findByRole('checkbox', { name: '选择 演示已撤销服务' }))
    await user.click(screen.getByRole('button', { name: '批量启用' }))
    const dialog = screen.getByRole('dialog', { name: '确认批量启用？' })
    expect(dialog).toHaveTextContent('已永久撤销，不能启停')
    expect(within(dialog).getByRole('button', { name: '确认批量启用' })).toBeDisabled()
    expect(update).not.toHaveBeenCalled()
  })

  it('加载服务、搜索结果，并提供 HTTP 添加表单', async () => {
    renderApp('/settings?tab=mcp')
    expect(await screen.findByRole('table', { name: 'MCP 服务列表' })).toBeInTheDocument()
    expect(screen.getByText('演示检索（HTTP）')).toBeInTheDocument()
    expect(screen.getByText('已配置 Bearer Token')).toBeInTheDocument()

    const user = userEvent.setup()
    await user.type(screen.getByRole('searchbox', { name: '搜索服务名称、地址或镜像' }), 'stdio')
    expect(screen.getByText('演示文件系统（stdio）')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText('演示检索（HTTP）')).not.toBeInTheDocument())
    await user.clear(screen.getByRole('searchbox', { name: '搜索服务名称、地址或镜像' }))
    await user.click(screen.getByRole('button', { name: '新建 MCP 服务' }))
    expect(await screen.findByRole('dialog', { name: '新建 MCP 服务' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '连接方式：Streamable HTTP' })).toHaveTextContent('Streamable HTTP')
    expect(screen.getByRole('switch', { name: '启用服务' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText(/已有凭据不回显/)).toBeInTheDocument()
  })

  it('探测显示本次结果并呈现工具、资源和提示词目录', async () => {
    renderApp('/settings?tab=mcp')
    const row = (await screen.findByText('演示检索（HTTP）')).closest<HTMLElement>('[role="row"]') as HTMLElement
    await userEvent.setup().click(within(row).getByRole('button', { name: '探测' }))
    expect(await screen.findByRole('dialog', { name: 'MCP 探测结果' })).toBeInTheDocument()
    expect(await screen.findByText('本次探测成功')).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'MCP 目录分类' })).toHaveTextContent('工具')
    expect(screen.getByText('演示检索', { exact: true })).toBeInTheDocument()
    expect(screen.getByText(/本次探测成功/)).toBeInTheDocument()
  })

  it('服务名称输入框：确认回车派发于组合结束之后时不保存，随后的人工提交才保存', async () => {
    const gateway = makeGateway()
    const create = vi.spyOn(gateway.agentExtensions, 'createMcpServer')
    renderApp('/settings?tab=mcp', { gateway })
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '新建 MCP 服务' }))
    await user.type(screen.getByLabelText('服务地址'), 'https://mcp.example.com/mcp')
    const field = screen.getByLabelText('服务名称')
    fireEvent.compositionStart(field)
    fireEvent.change(field, { target: { value: '中文检索服务' } })
    fireEvent.compositionEnd(field)
    expect(fireEvent.keyDown(field, { key: 'Enter', keyCode: 13 })).toBe(false)
    fireEvent.submit(field.closest('form')!)
    expect(create).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: '保存配置' }))
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: '中文检索服务', transport: 'streamable-http', url: 'https://mcp.example.com/mcp' }))
  })
})

describe('设置中的 Skill 配置', () => {
  it('多选删除保留确认与逐项结果，不移除共享包或导入记录', async () => {
    const gateway = makeGateway()
    const remove = vi.spyOn(gateway.agentExtensions, 'deleteSkill')
    renderApp('/settings?tab=skills', { gateway })
    const user = userEvent.setup()
    await user.click(await screen.findByRole('checkbox', { name: '选择 incident-triage' }))
    await user.click(screen.getByRole('button', { name: '批量删除' }))
    const dialog = screen.getByRole('dialog', { name: '确认批量删除？' })
    expect(dialog).toHaveTextContent('磁盘共享包文件与导入记录保留')
    expect(remove).not.toHaveBeenCalled()
    const skill = useAgentExtensionsStore.getState().skills.find(item => item.manifest.name === 'incident-triage')!
    await user.click(within(dialog).getByRole('button', { name: '确认批量删除' }))
    const result = await screen.findByRole('dialog', { name: '批量删除结果' })
    expect(result).toHaveTextContent('incident-triage：成功')
    expect(remove).toHaveBeenCalledExactlyOnceWith(skill.id, skill.revision)
    expect(useAgentExtensionsStore.getState().skills.some(item => item.id === skill.id)).toBe(false)
  })

  it('打开详情时自动预览 SKILL.md，列出来源修订并支持文件选择', async () => {
    renderApp('/settings?tab=skills')
    expect(await screen.findByRole('table', { name: 'Skill 配置列表' })).toBeInTheDocument()
    expect(screen.getByText('incident-triage')).toBeInTheDocument()
    const row = screen.getByText('incident-triage').closest<HTMLElement>('[role="row"]') as HTMLElement
    await userEvent.setup().click(within(row).getByRole('button', { name: '查看' }))
    expect(await screen.findByRole('dialog', { name: 'Skill 详情' })).toBeInTheDocument()
    expect(await screen.findByText('SKILL.md', { selector: 'p' })).toBeInTheDocument()
    expect(await screen.findByText(/name: incident-triage/, { selector: 'pre' })).toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('button', { name: 'references\/runbook.md' }))
    expect(await screen.findByText(/演示文件内容/)).toBeInTheDocument()
  })

  it('Git 来源导入成功后打开记录弹窗，不把配置自动加进会话', async () => {
    renderApp('/settings?tab=skills')
    expect(await screen.findByRole('table', { name: 'Skill 配置列表' })).toBeInTheDocument()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '导入 Skill' }))
    expect(await screen.findByRole('dialog', { name: '导入 Skill' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'HTTPS Git' }))
    await user.type(screen.getByLabelText('HTTPS Git 地址'), 'https://github.com/example/operations-skill.git')
    await user.type(screen.getByLabelText('分支、标签或提交'), 'v1.0.0')
    await user.click(screen.getByRole('button', { name: '开始导入' }))
    expect(await screen.findByRole('dialog', { name: 'Skill 导入记录' })).toBeInTheDocument()
    expect(screen.getByText(/https:\/\/github.com\/example\/operations-skill.git/)).toBeInTheDocument()
    expect(screen.getByText('排队中')).toBeInTheDocument()
    expect(screen.queryByText('Session 环境')).not.toBeInTheDocument()
  })

  it('服务器绝对目录输入框：确认回车派发于组合结束之后时不导入，随后的人工提交才导入', async () => {
    const gateway = makeGateway()
    const create = vi.spyOn(gateway.agentExtensions, 'createSkillImport')
    renderApp('/settings?tab=skills', { gateway })
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '导入 Skill' }))
    await user.click(screen.getByRole('button', { name: '服务器目录' }))
    const field = screen.getByLabelText('服务器绝对目录')
    fireEvent.compositionStart(field)
    fireEvent.change(field, { target: { value: '/opt/skills/运维手册' } })
    fireEvent.compositionEnd(field)
    expect(fireEvent.keyDown(field, { key: 'Enter', keyCode: 13 })).toBe(false)
    fireEvent.submit(field.closest('form')!)
    expect(create).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: '开始导入' }))
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    expect(create.mock.calls[0]![0]).toMatchObject({ source: { kind: 'directory', path: '/opt/skills/运维手册' } })
  })

  it('切换设置页签时隐藏弹窗并保留未保存的 MCP 草稿', async () => {
    const { router } = renderApp('/settings?tab=mcp')
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '新建 MCP 服务' }))
    await user.type(screen.getByLabelText('服务名称'), '临时本地 MCP 草稿')
    await act(async () => { await router.navigate('/settings?tab=skills') })
    expect(screen.queryByRole('dialog', { name: '新建 MCP 服务' })).not.toBeInTheDocument()
    expect(await screen.findByRole('table', { name: 'Skill 配置列表' })).toBeInTheDocument()
    await act(async () => { await router.navigate('/settings?tab=mcp') })
    expect(await screen.findByRole('dialog', { name: '新建 MCP 服务' })).toBeInTheDocument()
    expect(screen.getByLabelText('服务名称')).toHaveValue('临时本地 MCP 草稿')
  })
})

const makeGateway = () => createMockGateway({ eventStream: 'memory', eventIntervalMs: 60_000 })

describe('扩展页状态订阅', () => {
  it.each([
    { list: 'listSkills', load: 'loadSkills', section: 'skills', other: 'mcp' },
    { list: 'listMcpServers', load: 'loadMcpServers', section: 'mcp', other: 'skills' },
  ] as const)('$section 刷新失败保留列表，不重渲染 $other', async ({ list, load, section, other }) => {
    const gateway = makeGateway()
    const renders = { skills: vi.fn<ProfilerOnRenderCallback>(), mcp: vi.fn<ProfilerOnRenderCallback>() }
    render(<Tooltip.Provider><GatewayProvider gateway={gateway}>
      <Profiler id="skills" onRender={renders.skills}><SkillsSection active /></Profiler>
      <Profiler id="mcp" onRender={renders.mcp}><McpSection active /></Profiler>
    </GatewayProvider></Tooltip.Provider>)
    expect(await screen.findByRole('table', { name: 'Skill 配置列表' })).toBeInTheDocument()
    expect(await screen.findByRole('table', { name: 'MCP 服务列表' })).toBeInTheDocument()
    renders.skills.mockClear()
    renders.mcp.mockClear()

    vi.spyOn(gateway.agentExtensions, list).mockRejectedValueOnce(new Error('服务暂不可用'))
    await act(() => useAgentExtensionsStore.getState()[load](gateway, { silent: true }))

    expect(screen.getByRole('alert')).toHaveTextContent('刷新失败：服务暂不可用；当前保留的是上次读取结果。')
    expect(screen.getByRole('table', { name: section === 'skills' ? 'Skill 配置列表' : 'MCP 服务列表' })).toBeInTheDocument()
    expect(renders[section]).toHaveBeenCalled()
    expect(renders[other]).not.toHaveBeenCalled()
  })
})

describe('配置边界与请求恢复', () => {
  it.each(['keep', 'replace', 'clear'] as const)('HTTP Token %s：表单不回显，保存不触发探测', async mode => {
    const gateway = makeGateway()
    const update = vi.spyOn(gateway.agentExtensions, 'updateMcpServer')
    const probe = vi.spyOn(gateway.agentExtensions, 'probeMcpServer')
    renderApp('/settings?tab=mcp', { gateway })
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '编辑 演示检索（HTTP）' }))
    expect(screen.getByLabelText('Bearer Token（可选）')).toHaveValue('')
    if (mode === 'replace') await user.type(screen.getByLabelText('Bearer Token（可选）'), 'replacement-token')
    if (mode === 'clear') await user.click(screen.getByRole('button', { name: '清除已保存的 Token' }))
    await user.click(screen.getByRole('button', { name: '保存配置' }))
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    const input = update.mock.calls[0]![1]
    if (mode === 'keep') expect(input).not.toHaveProperty('credential')
    else expect(input.credential).toBe(mode === 'clear' ? '' : 'replacement-token')
    expect(probe).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it.each(['keep', 'replace', 'clear'] as const)('stdio 环境变量 %s 使用省略、完整映射或空映射', async mode => {
    const gateway = makeGateway()
    const update = vi.spyOn(gateway.agentExtensions, 'updateMcpServer')
    renderApp('/settings?tab=mcp', { gateway })
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '编辑 演示文件系统（stdio）' }))
    if (mode !== 'keep') {
      await user.click(screen.getByRole('button', { name: /环境变量处理方式/ }))
      await user.click(screen.getByRole('menuitemradio', { name: mode === 'replace' ? '整体替换环境变量' : '清除全部环境变量' }))
    }
    if (mode === 'replace') {
      await user.type(screen.getByLabelText('变量名 1'), 'bad-key')
      await user.type(screen.getByLabelText('变量值 1'), 'private-value')
      await user.click(screen.getByRole('button', { name: '保存配置' }))
      expect(update).not.toHaveBeenCalled()
      expect(await within(screen.getByRole('dialog')).findByText('第 1 行环境变量名无效或重复')).toBeInTheDocument()
      expect(screen.queryByText(/private-value/)).not.toBeInTheDocument()
      await user.clear(screen.getByLabelText('变量名 1'))
      await user.type(screen.getByLabelText('变量名 1'), 'ACCESS_TOKEN')
    }
    await user.click(screen.getByRole('button', { name: '保存配置' }))
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    const stdio = update.mock.calls[0]![1].stdio!
    if (mode === 'keep') expect(stdio).not.toHaveProperty('environment')
    else expect(stdio.environment).toEqual(mode === 'clear' ? {} : { ACCESS_TOKEN: 'private-value' })
  })

  it('MCP 修订冲突保留草稿，复核最新修订后才提交', async () => {
    const gateway = makeGateway()
    renderApp('/settings?tab=mcp', { gateway })
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '编辑 演示检索（HTTP）' }))
    await user.clear(screen.getByLabelText('服务名称'))
    await user.type(screen.getByLabelText('服务名称'), '仍需保留的草稿')
    await gateway.agentExtensions.updateMcpServer('mcp-demo-http', { name: '其他窗口改名', transport: 'streamable-http', url: 'https://demo.example.com/mcp', active: true, revoked: false, expectedRevision: 2 })
    await user.click(screen.getByRole('button', { name: '保存配置' }))
    expect(await screen.findByRole('button', { name: '使用修订 3 继续编辑' })).toBeInTheDocument()
    expect(screen.getByLabelText('服务名称')).toHaveValue('仍需保留的草稿')
    await user.click(screen.getByRole('button', { name: '使用修订 3 继续编辑' }))
    await user.click(screen.getByRole('button', { name: '保存配置' }))
    expect((await gateway.agentExtensions.getMcpServer('mcp-demo-http', 4)).name).toBe('仍需保留的草稿')
  })

  it('详情只读取目录；探测结果未知保留说明，不重试也不跳到治理页', async () => {
    const gateway = makeGateway()
    const probe = vi.spyOn(gateway.agentExtensions, 'probeMcpServer')
    const catalog = vi.spyOn(gateway.agentExtensions, 'getMcpCatalog')
    const { router } = renderApp('/settings?tab=mcp', { gateway })
    const user = userEvent.setup()
    const httpRow = (await screen.findByText('演示检索（HTTP）')).closest<HTMLElement>('[role="row"]')!
    await user.click(within(httpRow).getByRole('button', { name: '详情' }))
    await waitFor(() => expect(catalog).toHaveBeenCalled())
    expect(probe).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: '关闭MCP 详情 · 演示检索（HTTP）' }))
    const busy = useAgentExtensionsStore.getState().mcpServers.find(item => item.id === 'mcp-demo-busy')!
    const row = screen.getByText(busy.name).closest<HTMLElement>('[role="row"]')!
    await user.click(within(row).getByRole('button', { name: '探测' }))
    expect(await screen.findByText(/存在冲突执行或未核实的执行结果/)).toBeInTheDocument()
    expect(probe).toHaveBeenCalledTimes(1)
    expect(router.state.location.pathname).toBe('/settings')
    const revoked = useAgentExtensionsStore.getState().mcpServers.find(item => item.revoked)!
    expect(within(screen.getByText(revoked.name).closest<HTMLElement>('[role="row"]')!).getByRole('button', { name: '探测', hidden: true })).toBeDisabled()
  })

  it.each([true, false])('导入响应丢失（已受理=%s）时核对原请求，保留原输入和文件', async accepted => {
    const gateway = makeGateway()
    const original = gateway.agentExtensions.createSkillImport.bind(gateway.agentExtensions)
    const create = vi.spyOn(gateway.agentExtensions, 'createSkillImport').mockImplementationOnce(async (input, file) => {
      if (accepted) await original(input, file)
      throw new Error('网络中断，结果未知')
    })
    const { router } = renderApp('/settings?tab=skills', { gateway })
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '导入 Skill' }))
    const file = new File(['PK\x03\x04'], 'demo-skill.zip', { type: 'application/zip' })
    await user.upload(screen.getByLabelText('ZIP 文件（不超过 64 MiB）'), file)
    await user.click(screen.getByRole('button', { name: '开始导入' }))
    expect(await screen.findByRole('button', { name: '核对并重试' })).toBeInTheDocument()
    expect(screen.getByLabelText('ZIP 文件（不超过 64 MiB）')).toBeDisabled()
    await act(async () => { await router.navigate('/settings?tab=mcp'); await router.navigate('/settings?tab=skills') })
    await user.click(screen.getByRole('button', { name: '核对并重试' }))
    expect(await screen.findByRole('dialog', { name: 'Skill 导入记录' })).toBeInTheDocument()
    expect(create).toHaveBeenCalledTimes(accepted ? 1 : 2)
    if (!accepted) expect(create.mock.calls[1]).toEqual(create.mock.calls[0])
    expect(useAgentExtensionsStore.getState().imports.filter(item => item.requestId === create.mock.calls[0]![0].requestId)).toHaveLength(1)
  })

  it('更新 Skill 固定目标修订与启用状态，冲突不丢失来源草稿', async () => {
    const gateway = makeGateway()
    const create = vi.spyOn(gateway.agentExtensions, 'createSkillImport')
    renderApp('/settings?tab=skills', { gateway })
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '更多操作 backup-verify' }))
    await user.click(screen.getByRole('menuitem', { name: '更新 Skill' }))
    expect(screen.getByRole('switch', { name: '导入后启用' })).toBeDisabled()
    expect(screen.getByRole('switch', { name: '导入后启用' })).toHaveAttribute('aria-checked', 'false')
    await user.click(screen.getByRole('button', { name: '服务器目录' }))
    await user.type(screen.getByLabelText('服务器绝对目录'), '/opt/skills/updated')
    await gateway.agentExtensions.setSkillEnabled('skill-demo-backup', 1, true)
    await user.click(screen.getByRole('button', { name: '开始导入' }))
    expect(await screen.findByRole('button', { name: '使用修订 2 继续编辑' })).toBeInTheDocument()
    expect(screen.getByLabelText('服务器绝对目录')).toHaveValue('/opt/skills/updated')
    expect(create.mock.calls[0]![0]).toMatchObject({ skillId: 'skill-demo-backup', expectedRevision: 1, enabled: false })
    await user.click(screen.getByRole('button', { name: '使用修订 2 继续编辑' }))
    await user.click(screen.getByRole('button', { name: '开始导入' }))
    expect(create.mock.calls[1]![0]).toMatchObject({ skillId: 'skill-demo-backup', expectedRevision: 2, enabled: true })
  })

  it.each(['binary', 'too-large'] as const)('不可预览文件（%s）显示原因', async reason => {
    const gateway = makeGateway()
    vi.spyOn(gateway.agentExtensions, 'getSkillFile').mockResolvedValue({ skillId: 'skill-demo-incident', revision: 2, path: 'SKILL.md', previewable: false, reason })
    renderApp('/settings?tab=skills', { gateway })
    const row = (await screen.findByText('incident-triage')).closest<HTMLElement>('[role="row"]')!
    await userEvent.setup().click(within(row).getByRole('button', { name: '查看' }))
    expect(await screen.findByText(reason === 'binary' ? '二进制文件不能预览' : '文件超过 256 KiB，无法预览')).toBeInTheDocument()
  })

  it('MCP 读取失败不影响 Skill 页，拒绝 Agent 权限时不读取扩展', async () => {
    const gateway = makeGateway()
    const list = vi.spyOn(gateway.agentExtensions, 'listMcpServers').mockRejectedValue(new AgentHttpError('MCP 配置损坏', 'mcp-unavailable', 503))
    const { router, unmount } = renderApp('/settings?tab=mcp', { gateway })
    expect(await screen.findByText('MCP 配置读取失败')).toBeInTheDocument()
    await act(async () => { await router.navigate('/settings?tab=skills') })
    expect(await screen.findByRole('table', { name: 'Skill 配置列表' })).toBeInTheDocument()
    unmount()
    list.mockClear()
    vi.spyOn(gateway.session, 'canView').mockImplementation(async area => area !== 'agent')
    renderApp('/settings?tab=mcp', { gateway })
    expect(await screen.findByText('无权限查看「MCP 配置」')).toBeInTheDocument()
    expect(list).not.toHaveBeenCalled()
  })

  it('登录失效清除弹窗、Token 草稿和扩展展示，重新进入为空白表单', async () => {
    const { router } = renderApp('/settings?tab=mcp')
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '新建 MCP 服务' }))
    await user.type(screen.getByLabelText('服务名称'), '会话内草稿')
    await user.type(screen.getByLabelText('Bearer Token（可选）'), 'session-secret')
    await act(async () => { useSessionStore.getState().expire() })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByDisplayValue('session-secret')).not.toBeInTheDocument()
    expect(useAgentExtensionsStore.getState().mcpServers).toEqual([])
    await act(async () => {
      useSessionStore.setState({ phase: 'authed', mode: 'demo' })
      await router.navigate('/settings?tab=mcp')
    })
    await user.click(await screen.findByRole('button', { name: '新建 MCP 服务' }))
    expect(screen.getByLabelText('服务名称')).toHaveValue('')
    expect(screen.getByLabelText('Bearer Token（可选）')).toHaveValue('')
  })
})

describe('MCP 容器运行时权限', () => {
  afterEach(() => {
    sessionStorage.removeItem('elysian:mcp-probe:v1:mcp-demo-stdio:1')
  })

  it('先显示申请，只有确认本次允许后才执行探测', async () => {
    const gateway = createMockGateway({ eventStream: 'memory', eventIntervalMs: 60000 })
    const decide = vi.spyOn(gateway.agentExtensions, 'decideMcpProbeRequest')
    const oldProbe = vi.spyOn(gateway.agentExtensions, 'probeMcpServer')
    const user = userEvent.setup()
    renderApp('/settings?tab=mcp', { gateway })
    const row = (await screen.findByText('演示文件系统（stdio）')).closest<HTMLElement>('[role="row"]')!
    await user.click(within(row).getByRole('button', { name: '探测' }))
    expect(await screen.findByRole('dialog', { name: 'MCP 探测权限' })).toBeInTheDocument()
    // 会话授权已退役：申请不再提供允许范围单选，确认即本次允许。
    expect(screen.queryByRole('radio')).not.toBeInTheDocument()
    expect(screen.getByText('只允许本次探测，不授予聊天会话权限。')).toBeInTheDocument()
    expect(decide).not.toHaveBeenCalled()
    expect(oldProbe).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: '确认并继续' }))
    expect(decide).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ decision: 'allow-once', expectedVersion: 1, requestId: expect.any(String) }))
    expect(await screen.findByText('本次探测成功')).toBeInTheDocument()
  })

  it('页面重新挂载后回读原探测申请，并按原选择重试结果未知的确认', async () => {
    const gateway = createMockGateway({ eventStream: 'memory', eventIntervalMs: 60000 })
    const create = vi.spyOn(gateway.agentExtensions, 'createMcpProbeRequest')
    const read = vi.spyOn(gateway.agentExtensions, 'getMcpProbeRequest')
    const decide = vi.spyOn(gateway.agentExtensions, 'decideMcpProbeRequest')
      .mockRejectedValueOnce(new Error('探测确认结果未知'))
    const user = userEvent.setup()
    const openProbe = async () => {
      const row = (await screen.findByText('演示文件系统（stdio）')).closest<HTMLElement>('[role="row"]')!
      await user.click(within(row).getByRole('button', { name: '探测' }))
    }

    const firstPage = renderApp('/settings?tab=mcp', { gateway })
    await openProbe()
    await user.click(await screen.findByRole('button', { name: '确认并继续' }))
    await screen.findByRole('button', { name: '按原选择重试' })
    const [id, originalDecision] = decide.mock.calls[0]!
    firstPage.unmount()

    read.mockClear()
    renderApp('/settings?tab=mcp', { gateway })
    await openProbe()
    const retry = await screen.findByRole('button', { name: '按原选择重试' })
    expect(create).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledWith(id, expect.any(AbortSignal))
    expect(decide).toHaveBeenCalledTimes(1)
    await user.click(retry)
    expect(decide).toHaveBeenNthCalledWith(2, id, originalDecision)
    expect(await screen.findByText('本次探测成功')).toBeInTheDocument()
  })

  it('已受理的探测在后台仍每秒回读，失败停等手动重试，终态停止', async () => {
    const gateway = createMockGateway({ eventStream: 'memory', eventIntervalMs: 60000 })
    const api = gateway.agentExtensions
    const storedRequest = api.getMcpProbeRequest.bind(api)
    let state: 'waiting' | 'running' | 'completed' = 'waiting'
    const read = vi.spyOn(api, 'getMcpProbeRequest').mockImplementation(async id => ({ ...await storedRequest(id), state }))
    const decide = vi.spyOn(api, 'decideMcpProbeRequest').mockImplementation(async id => {
      state = 'running'
      return { ...await storedRequest(id), state }
    })
    const create = vi.spyOn(api, 'createMcpProbeRequest')
    const user = userEvent.setup()
    renderApp('/settings?tab=mcp', { gateway })
    const row = (await screen.findByText('演示文件系统（stdio）')).closest<HTMLElement>('[role="row"]')!
    await user.click(within(row).getByRole('button', { name: '探测' }))
    const confirm = await screen.findByRole('button', { name: '确认并继续' })
    await waitFor(() => expect(confirm).toBeEnabled())
    read.mockClear()
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    vi.useFakeTimers()
    const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms))
    try {
      fireEvent.click(confirm)
      await advance(0)
      const id = decide.mock.calls[0]![0]
      expect(read).toHaveBeenCalledExactlyOnceWith(id, expect.any(AbortSignal))
      expect(screen.getByText('正在连接服务并读取目录…')).toBeInTheDocument()
      read.mockRejectedValueOnce(new Error('暂时无法读取探测进度'))
      await advance(999)
      expect(read).toHaveBeenCalledTimes(1)
      await advance(1)
      expect(screen.getByText('暂时无法读取探测进度')).toBeInTheDocument()
      await advance(3000)
      expect(read).toHaveBeenCalledTimes(2)

      state = 'completed'
      fireEvent.click(screen.getByRole('button', { name: '重新读取探测状态' }))
      await advance(0)
      expect(read).toHaveBeenNthCalledWith(3, id, expect.any(AbortSignal))
      expect(screen.getByText('本次探测成功')).toBeInTheDocument()
      await advance(3000)
      expect(read).toHaveBeenCalledTimes(3)
      expect(create).toHaveBeenCalledTimes(1)
      expect(decide).toHaveBeenCalledTimes(1)
    } finally {
      visibility.mockRestore()
      vi.useRealTimers()
    }
  })

  it('新 stdio 配置声明业务目录，无需预建授权编号', async () => {
    const gateway = createMockGateway({ eventStream: 'memory', eventIntervalMs: 60000 })
    const create = vi.spyOn(gateway.agentExtensions, 'createMcpServer')
    const user = userEvent.setup()
    renderApp('/settings?tab=mcp', { gateway })
    await user.click(await screen.findByRole('button', { name: '新建 MCP 服务' }))
    await user.type(screen.getByLabelText('服务名称'), '业务文件')
    await user.click(screen.getByRole('button', { name: '连接方式：Streamable HTTP' }))
    await user.click(screen.getByRole('menuitemradio', { name: '容器 stdio' }))
    await user.type(screen.getByLabelText('容器镜像'), 'library/node@sha256:' + 'a'.repeat(64))
    await user.type(screen.getByLabelText('可执行文件'), 'node')
    expect(screen.queryByLabelText('授权编号（可选）')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '添加业务目录' }))
    await user.type(screen.getByLabelText('业务目录 1'), '/srv/projects/shop')
    await user.click(screen.getByRole('button', { name: '保存配置' }))
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ stdio: expect.objectContaining({ requestedAccess: { directories: [{ path: '/srv/projects/shop', access: 'ro' }], network: [], privateCidrs: [] } }) })))
  })
})
