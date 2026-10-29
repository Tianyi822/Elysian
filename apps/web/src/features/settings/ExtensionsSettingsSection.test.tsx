import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMockGateway } from '../../adapters/mock/gateway'
import { AgentHttpError } from '../../adapters/http/agent/agentShared'
import { renderApp } from '../../test/renderApp'
import { resetAgentExtensionsData } from '../../adapters/mock/agent/agentExtensionsMockAdapter'
import { useAgentExtensionsStore } from '../../stores/agentExtensionsStore'
import { useAgentRuntimeStore } from '../../stores/agentRuntimeStore'
import { useSessionStore } from '../../stores/sessionStore'

beforeEach(() => {
  vi.restoreAllMocks()
  resetAgentExtensionsData()
  useAgentExtensionsStore.getState().reset()
  useAgentRuntimeStore.getState().reset()
  useSessionStore.setState({ phase: 'unknown', mode: undefined, devAccount: false, notice: null })
})

describe('设置中的 MCP 配置', () => {
  it('加载服务、搜索结果，并提供 HTTP 添加表单', async () => {
    renderApp('/settings?tab=mcp')
    expect(await screen.findByRole('region', { name: 'MCP 服务列表' })).toBeInTheDocument()
    expect(screen.getByText('演示检索（HTTP）')).toBeInTheDocument()
    expect(screen.getByText('已配置 Bearer Token')).toBeInTheDocument()

    const user = userEvent.setup()
    await user.type(screen.getByRole('searchbox', { name: '搜索服务名称、地址或镜像' }), 'stdio')
    expect(screen.getByText('演示文件系统（stdio）')).toBeInTheDocument()
    expect(screen.queryByText('演示检索（HTTP）')).not.toBeInTheDocument()
    await user.clear(screen.getByRole('searchbox', { name: '搜索服务名称、地址或镜像' }))
    await user.click(screen.getByRole('button', { name: '新建 MCP 服务' }))
    expect(await screen.findByRole('dialog', { name: '新建 MCP 服务' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '连接方式：Streamable HTTP' })).toHaveTextContent('Streamable HTTP')
    expect(screen.getByRole('switch', { name: '启用服务' })).toHaveAttribute('data-state', 'checked')
    expect(screen.getByText(/已有凭据不回显/)).toBeInTheDocument()
  })

  it('探测显示本次结果并呈现工具、资源和提示词目录', async () => {
    renderApp('/settings?tab=mcp')
    const row = (await screen.findByText('演示检索（HTTP）')).closest('tr') as HTMLElement
    await userEvent.setup().click(within(row).getByRole('button', { name: '探测' }))
    expect(await screen.findByRole('dialog', { name: 'MCP 探测结果' })).toBeInTheDocument()
    expect(await screen.findByText('本次探测成功')).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'MCP 目录分类' })).toHaveTextContent('工具')
    expect(screen.getByText('演示检索', { exact: true })).toBeInTheDocument()
    expect(screen.getByText(/本次探测成功/)).toBeInTheDocument()
  })
})

describe('设置中的 Skill 配置', () => {
  it('打开详情时自动预览 SKILL.md，列出来源修订并支持文件选择', async () => {
    renderApp('/settings?tab=skills')
    expect(await screen.findByRole('region', { name: 'Skill 配置列表' })).toBeInTheDocument()
    expect(screen.getByText('incident-triage')).toBeInTheDocument()
    const row = screen.getByText('incident-triage').closest('tr') as HTMLElement
    await userEvent.setup().click(within(row).getByRole('button', { name: '查看' }))
    expect(await screen.findByRole('dialog', { name: 'Skill 详情' })).toBeInTheDocument()
    expect(await screen.findByText('SKILL.md', { selector: 'p' })).toBeInTheDocument()
    expect(await screen.findByText(/name: incident-triage/, { selector: 'pre' })).toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('button', { name: 'references\/runbook.md' }))
    expect(await screen.findByText(/演示文件内容/)).toBeInTheDocument()
  })

  it('Git 来源导入成功后打开记录弹窗，不把配置自动加进会话', async () => {
    renderApp('/settings?tab=skills')
    expect(await screen.findByRole('region', { name: 'Skill 配置列表' })).toBeInTheDocument()
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

  it('切换设置页签时隐藏弹窗并保留未保存的 MCP 草稿', async () => {
    const { router } = renderApp('/settings?tab=mcp')
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '新建 MCP 服务' }))
    await user.type(screen.getByLabelText('服务名称'), '临时本地 MCP 草稿')
    await act(async () => { await router.navigate('/settings?tab=skills') })
    expect(screen.queryByRole('dialog', { name: '新建 MCP 服务' })).not.toBeInTheDocument()
    expect(await screen.findByRole('region', { name: 'Skill 配置列表' })).toBeInTheDocument()
    await act(async () => { await router.navigate('/settings?tab=mcp') })
    expect(await screen.findByRole('dialog', { name: '新建 MCP 服务' })).toBeInTheDocument()
    expect(screen.getByLabelText('服务名称')).toHaveValue('临时本地 MCP 草稿')
  })
})

const makeGateway = () => createMockGateway({ eventStream: 'memory', eventIntervalMs: 60_000 })

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
    const httpRow = (await screen.findByText('演示检索（HTTP）')).closest('tr')!
    await user.click(within(httpRow).getByRole('button', { name: '详情' }))
    await waitFor(() => expect(catalog).toHaveBeenCalled())
    expect(probe).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: '关闭MCP 详情 · 演示检索（HTTP）' }))
    const busy = useAgentExtensionsStore.getState().mcpServers.find(item => item.id === 'mcp-demo-busy')!
    const row = screen.getByText(busy.name).closest('tr')!
    await user.click(within(row).getByRole('button', { name: '探测' }))
    expect(await screen.findByText(/存在冲突执行或未核实的执行结果/)).toBeInTheDocument()
    expect(probe).toHaveBeenCalledTimes(1)
    expect(router.state.location.pathname).toBe('/settings')
    const revoked = useAgentExtensionsStore.getState().mcpServers.find(item => item.revoked)!
    expect(within(screen.getByText(revoked.name).closest('tr')!).getByRole('button', { name: '探测', hidden: true })).toBeDisabled()
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
    expect(screen.getByRole('switch', { name: '导入后启用' })).toHaveAttribute('data-state', 'unchecked')
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
    const row = (await screen.findByText('incident-triage')).closest('tr')!
    await userEvent.setup().click(within(row).getByRole('button', { name: '查看' }))
    expect(await screen.findByText(reason === 'binary' ? '二进制文件不能预览' : '文件超过 256 KiB，无法预览')).toBeInTheDocument()
  })

  it('MCP 读取失败不影响 Skill 页，拒绝 Agent 权限时不读取扩展', async () => {
    const gateway = makeGateway()
    const list = vi.spyOn(gateway.agentExtensions, 'listMcpServers').mockRejectedValue(new AgentHttpError('MCP 配置损坏', 'mcp-unavailable', 503))
    const { router, unmount } = renderApp('/settings?tab=mcp', { gateway })
    expect(await screen.findByText('MCP 配置读取失败')).toBeInTheDocument()
    await act(async () => { await router.navigate('/settings?tab=skills') })
    expect(await screen.findByRole('region', { name: 'Skill 配置列表' })).toBeInTheDocument()
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
  it('先显示申请，只有确认本次允许后才执行探测', async () => {
    const gateway = createMockGateway({ eventStream: 'memory', eventIntervalMs: 60000 })
    const decide = vi.spyOn(gateway.agentExtensions, 'decideMcpProbeRequest')
    const oldProbe = vi.spyOn(gateway.agentExtensions, 'probeMcpServer')
    const user = userEvent.setup()
    renderApp('/settings?tab=mcp', { gateway })
    const row = (await screen.findByText('演示文件系统（stdio）')).closest('tr')!
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
