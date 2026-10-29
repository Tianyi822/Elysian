import { memoryFixture } from '../../test/memoryFixture'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentMemoryPage } from '@elysian/contracts'
import { createMockGateway } from '../../adapters/mock/gateway'
import { renderApp } from '../../test/renderApp'
import { useAgentMemoryStore } from '../../stores/agentMemoryStore'
import { useSessionStore } from '../../stores/sessionStore'

beforeEach(() => { useAgentMemoryStore.getState().reset(); useSessionStore.setState({ phase: 'authed', mode: 'demo' }) })

async function seedPage(gateway: ReturnType<typeof createMockGateway>, input: { slug: string; title: string; markdown: string; kind?: 'runbook' | 'reference' | 'sources' }) {
  return memoryFixture(gateway.agentMemory).seedPage('wiki-global', input)
}

describe('知识 Wiki 独立浏览页', () => {
  it('一行一页展示元信息，整行点击打开查看弹窗渲染 Markdown', async () => {
    const user = userEvent.setup(), gateway = createMockGateway({ eventStream: 'memory' })
    await seedPage(gateway, { slug: 'operations/nginx', title: 'Nginx 运维', markdown: '# 检查配置\n\n执行前先检查。', kind: 'runbook' })
    renderApp('/wiki', { gateway })
    const row = await screen.findByRole('button', { name: /Nginx 运维/ })
    expect(within(row).getByText('操作手册')).toBeInTheDocument()
    expect(within(row).getByText('r1')).toBeInTheDocument()
    expect(within(row).getByText('人工维护')).toBeInTheDocument()
    await user.click(row)
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('heading', { name: 'Nginx 运维' })).toBeInTheDocument()
    expect(within(dialog).getByText(/修订 r1/)).toBeInTheDocument()
    expect(within(dialog).getByText(/更新于/)).toBeInTheDocument()
    expect(await within(dialog).findByText('执行前先检查。')).toBeInTheDocument()
  })

  it('弹窗被锁定：外部 pointerdown 与 Escape 都不关闭，只有 X 关闭', async () => {
    const user = userEvent.setup(), gateway = createMockGateway({ eventStream: 'memory' })
    await seedPage(gateway, { slug: 'guide', title: '运维指南', markdown: '内容' })
    renderApp('/wiki', { gateway })
    await user.click(await screen.findByRole('button', { name: /运维指南/ }))
    await screen.findByRole('dialog')
    fireEvent.pointerDown(document.body)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '关闭窗口' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('保存携带 expectedRevision 与人工维护，成功后回到查看态显示新修订', async () => {
    const user = userEvent.setup(), gateway = createMockGateway({ eventStream: 'memory' })
    const page = await seedPage(gateway, { slug: 'guide', title: '运维指南', markdown: '原文' })
    const update = vi.spyOn(gateway.agentMemory, 'updatePage')
    renderApp('/wiki', { gateway })
    await user.click(await screen.findByRole('button', { name: /运维指南/ }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: '编辑' }))
    fireEvent.change(within(dialog).getByLabelText('Markdown 正文'), { target: { value: '先检查，再重载。' } })
    await user.click(within(dialog).getByRole('button', { name: '保存页面' }))
    expect(update).toHaveBeenCalledWith('wiki-global', page.id, expect.objectContaining({ expectedRevision: 1, maintenance: 'manual', markdown: '先检查，再重载。' }))
    expect(await within(screen.getByRole('dialog')).findByText(/修订 r2/)).toBeInTheDocument()
    expect(screen.queryByLabelText('Markdown 正文')).not.toBeInTheDocument()
    // 已无未保存改动，X 直接关闭。
    await user.click(screen.getByRole('button', { name: '关闭窗口' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('编辑未保存时 X 与取消先出确认行，放弃修改才关闭', async () => {
    const user = userEvent.setup(), gateway = createMockGateway({ eventStream: 'memory' })
    await seedPage(gateway, { slug: 'guide', title: '运维指南', markdown: '原文' })
    renderApp('/wiki', { gateway })
    await user.click(await screen.findByRole('button', { name: /运维指南/ }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '编辑' }))
    fireEvent.change(screen.getByLabelText('Markdown 正文'), { target: { value: '未保存草稿' } })
    await user.click(screen.getByRole('button', { name: '关闭窗口' }))
    expect(await screen.findByText('有未保存的内容。')).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '继续编辑' }))
    expect(screen.queryByText('有未保存的内容。')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(await screen.findByText('有未保存的内容。')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '放弃修改' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    // 没有改动时 X 不需要确认。
    await user.click(await screen.findByRole('button', { name: /运维指南/ }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '编辑' }))
    await user.click(screen.getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('修订冲突显示错误，读取最新修订保留草稿后按新修订保存', async () => {
    const user = userEvent.setup(), gateway = createMockGateway({ eventStream: 'memory' })
    const page = await seedPage(gateway, { slug: 'guide', title: '运维指南', markdown: '原文' })
    const update = vi.spyOn(gateway.agentMemory, 'updatePage').mockRejectedValueOnce(new Error('页面修订已更新，请重新读取后确认；当前草稿已保留'))
    renderApp('/wiki', { gateway })
    await user.click(await screen.findByRole('button', { name: /运维指南/ }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '编辑' }))
    fireEvent.change(screen.getByLabelText('Markdown 正文'), { target: { value: '冲突草稿' } })
    await user.click(screen.getByRole('button', { name: '保存页面' }))
    expect(await screen.findByText('页面修订已更新，请重新读取后确认；当前草稿已保留')).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    await gateway.agentMemory.updatePage(page.spaceId, page.id, { ...page, markdown: '并发更新', expectedRevision: 1 })
    await user.click(screen.getByRole('button', { name: '读取最新修订并保留草稿' }))
    await waitFor(() => expect(screen.getByLabelText('Markdown 正文')).toHaveValue('冲突草稿'))
    await user.click(screen.getByRole('button', { name: '保存页面' }))
    expect(update).toHaveBeenLastCalledWith('wiki-global', page.id, expect.objectContaining({ expectedRevision: 2, markdown: '冲突草稿' }))
    expect(await within(screen.getByRole('dialog')).findByText(/修订 r3/)).toBeInTheDocument()
  })

  it('导入原文与已撤回页面只读展示，不出现编辑入口', async () => {
    const user = userEvent.setup(), gateway = createMockGateway({ eventStream: 'memory' })
    await seedPage(gateway, { slug: 'source-1', title: '交接资料', markdown: '导入原文内容', kind: 'sources' })
    const page = await seedPage(gateway, { slug: 'old', title: '旧文档', markdown: '旧内容' })
    await memoryFixture(gateway.agentMemory).seedWithdrawal(page.spaceId, page.id, page.revision)
    renderApp('/wiki', { gateway })
    await user.click(await screen.findByRole('button', { name: /交接资料/ }))
    const sourceDialog = await screen.findByRole('dialog')
    expect(within(sourceDialog).queryByRole('button', { name: '编辑' })).not.toBeInTheDocument()
    expect(within(sourceDialog).getByText(/来源/)).toBeInTheDocument()
    await user.click(within(sourceDialog).getByRole('button', { name: '关闭窗口' }))
    const withdrawnRow = await screen.findByRole('button', { name: /旧文档/ })
    expect(within(withdrawnRow).getByText('已撤回')).toBeInTheDocument()
    await user.click(withdrawnRow)
    const withdrawnDialog = await screen.findByRole('dialog')
    expect(within(withdrawnDialog).queryByRole('button', { name: '编辑' })).not.toBeInTheDocument()
    expect(within(withdrawnDialog).getByText(/已撤回/)).toBeInTheDocument()
  })

  it('正文超 16 KiB 禁止保存并给出超限提示', async () => {
    const user = userEvent.setup(), gateway = createMockGateway({ eventStream: 'memory' })
    await seedPage(gateway, { slug: 'guide', title: '运维指南', markdown: '原文' })
    renderApp('/wiki', { gateway })
    await user.click(await screen.findByRole('button', { name: /运维指南/ }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '编辑' }))
    fireEvent.change(screen.getByLabelText('Markdown 正文'), { target: { value: '汉'.repeat(6000) } })
    expect(screen.getByText('18000 / 16384 字节')).toHaveClass('text-danger')
    expect(screen.getByRole('button', { name: '保存页面' })).toBeDisabled()
    expect(screen.getByLabelText('页面标识')).toHaveValue('guide')
    expect(screen.getByText('创建后不可修改')).toBeInTheDocument()
  })

  it('无空间给出工作台引导，手动刷新读取真实空间后转为无页面引导', async () => {
    const user = userEvent.setup(), gateway = createMockGateway({ eventStream: 'memory' })
    vi.spyOn(gateway.agentMemory, 'listSpaces').mockResolvedValueOnce([])
    renderApp('/wiki', { gateway })
    expect(await screen.findByText('尚无知识空间')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /工作台/ })).not.toBeInTheDocument()
    expect(screen.queryByText('打开完整工作台')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '刷新' }))
    expect(await screen.findByText('当前空间还没有页面')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /工作台/ })).not.toBeInTheDocument()
  })

  it('读取失败显示错误并提供重试，重试清掉错误', async () => {
    const user = userEvent.setup(), gateway = createMockGateway({ eventStream: 'memory' })
    const pages = vi.spyOn(gateway.agentMemory, 'listPages').mockRejectedValueOnce(new Error('空间读取失败'))
    renderApp('/wiki', { gateway })
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('空间读取失败')
    await user.click(within(alert).getByRole('button', { name: '重试' }))
    await waitFor(() => expect(pages).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByText(/空间读取失败/)).not.toBeInTheDocument())
  })

  it('自绘下拉切换知识空间', async () => {
    const user = userEvent.setup(), gateway = createMockGateway({ eventStream: 'memory' })
    const space = await memoryFixture(gateway.agentMemory).seedSpace({ name: '项目知识', kind: 'business' })
    await memoryFixture(gateway.agentMemory).seedPage(space.id, { slug: 'guide', title: '项目指南', markdown: '内容' })
    renderApp('/wiki', { gateway })
    expect(await screen.findByText('当前空间还没有页面')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /知识空间/ }))
    await user.click(await screen.findByRole('menuitemradio', { name: '项目知识' }))
    expect(await screen.findByRole('button', { name: /项目指南/ })).toBeInTheDocument()
  })

  it('重读失败后未保存草稿仍受确认行保护，不因 page 清空被绕过', async () => {
    const user = userEvent.setup(), gateway = createMockGateway({ eventStream: 'memory' })
    await seedPage(gateway, { slug: 'guide', title: '运维指南', markdown: '原文' })
    vi.spyOn(gateway.agentMemory, 'updatePage').mockRejectedValueOnce(new Error('页面修订已更新，请重新读取后确认；当前草稿已保留'))
    renderApp('/wiki', { gateway })
    await user.click(await screen.findByRole('button', { name: /运维指南/ }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '编辑' }))
    fireEvent.change(screen.getByLabelText('Markdown 正文'), { target: { value: '冲突草稿' } })
    await user.click(screen.getByRole('button', { name: '保存页面' }))
    expect(await screen.findByText('页面修订已更新，请重新读取后确认；当前草稿已保留')).toBeInTheDocument()
    vi.spyOn(gateway.agentMemory, 'getPage').mockRejectedValueOnce(new Error('Wiki 页面不存在'))
    await user.click(screen.getByRole('button', { name: '读取最新修订并保留草稿' }))
    await waitFor(() => expect(screen.getByText('Wiki 页面不存在')).toBeInTheDocument())
    expect(screen.getByLabelText('Markdown 正文')).toHaveValue('冲突草稿')
    // 读取失败的窗口内 page 为空，点 X 仍必须先出确认行。
    await user.click(screen.getByRole('button', { name: '关闭窗口' }))
    expect(await screen.findByText('有未保存的内容。')).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByLabelText('Markdown 正文')).toHaveValue('冲突草稿')
    await user.click(screen.getByRole('button', { name: '放弃修改' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('保存在途时「放弃修改」不关闭弹窗，回执落地后回到查看态', async () => {
    const user = userEvent.setup(), gateway = createMockGateway({ eventStream: 'memory' })
    await seedPage(gateway, { slug: 'guide', title: '运维指南', markdown: '原文' })
    // 保存请求挂起直到 finishSave 放行，放行时才执行真实写入，回读能看到 r2。
    const real = gateway.agentMemory.updatePage.bind(gateway.agentMemory)
    let finishSave!: () => Promise<void>
    vi.spyOn(gateway.agentMemory, 'updatePage').mockImplementation((spaceId, id, input) => new Promise<AgentMemoryPage>(done => {
      finishSave = async () => { done(await real(spaceId, id, input)) }
    }))
    renderApp('/wiki', { gateway })
    await user.click(await screen.findByRole('button', { name: /运维指南/ }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '编辑' }))
    fireEvent.change(screen.getByLabelText('Markdown 正文'), { target: { value: '在途草稿' } })
    await user.click(screen.getByRole('button', { name: '关闭窗口' }))
    expect(await screen.findByText('有未保存的内容。')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '保存页面' }))
    await user.click(screen.getByRole('button', { name: '放弃修改' }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByLabelText('Markdown 正文')).toHaveValue('在途草稿')
    await act(async () => { await finishSave() })
    expect(await within(screen.getByRole('dialog')).findByText(/修订 r2/)).toBeInTheDocument()
    expect(await within(screen.getByRole('dialog')).findByText('在途草稿')).toBeInTheDocument()
  })

  it('查看态读取失败显示真实错误并提供弹窗内重试', async () => {
    const user = userEvent.setup(), gateway = createMockGateway({ eventStream: 'memory' })
    await seedPage(gateway, { slug: 'guide', title: '运维指南', markdown: '执行前先检查。' })
    vi.spyOn(gateway.agentMemory, 'getPage').mockRejectedValueOnce(new Error('Wiki 页面读取失败'))
    renderApp('/wiki', { gateway })
    await user.click(await screen.findByRole('button', { name: /运维指南/ }))
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText('Wiki 页面读取失败')).toBeInTheDocument()
    expect(within(dialog).getByText('页面读取失败，可在下方重试。')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: '重试' }))
    expect(await within(screen.getByRole('dialog')).findByText('执行前先检查。')).toBeInTheDocument()
  })

  it('登出立即清空公开展示', async () => {
    const gateway = createMockGateway({ eventStream: 'memory' })
    await seedPage(gateway, { slug: 'guide', title: '运维指南', markdown: '内容' })
    renderApp('/wiki', { gateway })
    await screen.findByRole('button', { name: /运维指南/ })
    act(() => useSessionStore.setState({ phase: 'anonymous' }))
    expect(screen.queryByRole('region', { name: 'Wiki 页面浏览' })).not.toBeInTheDocument()
    expect(useAgentMemoryStore.getState().pages).toHaveLength(0)
  })
})
