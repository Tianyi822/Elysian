import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockGateway } from '../../adapters/mock/gateway'
import { resetWebsitesData } from '../../adapters/mock/websitesData'
import { useDependencyProbeStore } from '../../stores/dependencyProbeStore'
import { useWebsitesStore } from '../../stores/websitesStore'
import { useWebsiteDeploymentsStore } from '../../stores/websiteDeploymentsStore'
import { renderApp } from '../../test/renderApp'
import { MOCK_WEBSITE_RUNTIME_REPORT } from '../../adapters/mock/websiteRuntimeCatalog'
import type { WebsiteProjectKind } from '@elysian/contracts'

beforeEach(() => {
  resetWebsitesData()
  useWebsitesStore.setState({ status: 'idle', projects: [], createDialogOpen: false, detailTarget: undefined, settingsTarget: undefined, removeTarget: undefined, proxyStatus: { state: 'active', detail: null }, busyProjectIds: [] })
  useWebsiteDeploymentsStore.setState({ tasks: [], loading: false, error: undefined })
  useDependencyProbeStore.getState().reset()
})
async function open() {
  const gateway = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
  renderApp('/websites', { gateway })
  await screen.findByText('您的列表为空')
  return gateway
}
async function prepare(kind: WebsiteProjectKind, user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: '添加项目' }))
  await user.upload(screen.getByLabelText('项目压缩包'), new File(['demo'], 'docs.zip', { type: 'application/zip' }))
  await user.click(screen.getByRole('button', { name: '获取并识别' }))
  await user.click(await screen.findByRole('button', { name: /项目目录与构建工具：/ }))
  await user.click(screen.getByRole('menuitemradio', { name: new RegExp(`${kind === 'html' ? 'HTML' : kind === 'java' ? 'Java' : kind === 'node' ? 'Node' : kind === 'go' ? 'Go' : 'Python'}项目`) }))
}
describe('三步构建与部署', () => {
  it.each(['node', 'python'] as const)('%s 启动命令为空，采用建议才写入', async (kind) => {
    const user = userEvent.setup(); await open(); await prepare(kind, user)
    expect(screen.getByLabelText('启动命令 *')).toHaveValue('')
    await user.click(screen.getByRole('button', { name: '采用建议' }))
    expect(screen.getByLabelText('启动命令 *')).not.toHaveValue('')
  })
  it.each(['missing', 'error'] as const)('Caddy %s 时隐藏访问区域，提交固定直连', async (state) => {
    const user = userEvent.setup(); const gateway = await open()
    act(() => useDependencyProbeStore.setState({ report: { docker: { state: 'ok', detail: null }, caddy: { state, detail: '通道不可用' } }, status: 'checked' }))
    const submit = vi.spyOn(gateway.websites.deployment!, 'submit')
    await prepare('html', user)
    expect(screen.queryByRole('button', { name: /访问方式：/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '构建并部署' }))
    await screen.findByText(/演示部署完成/)
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ access: { mode: 'direct' }, config: expect.objectContaining({ target: 'static', command: '' }) }))
    await user.click(screen.getByRole('button', { name: '关闭弹窗' }))
    expect(await screen.findByRole('article', { name: 'docs' })).toBeInTheDocument()
  })
  it('旧就绪报告失效后创建项目不开放域名选项', async () => {
    const user = userEvent.setup(); await open()
    act(() => useDependencyProbeStore.setState({ report: { docker: { state: 'ok', detail: null }, caddy: { state: 'ok', detail: null } }, status: 'error' }))
    await prepare('html', user)
    expect(screen.queryByRole('button', { name: /访问方式：/ })).not.toBeInTheDocument()
  })
  it('多个候选必须选择，版本搜索位于下拉中', async () => {
    const user = userEvent.setup(); await open()
    await user.click(screen.getByRole('button', { name: '添加项目' }))
    await user.upload(screen.getByLabelText('项目压缩包'), new File(['demo'], 'bundle.zip', { type: 'application/zip' }))
    await user.click(screen.getByRole('button', { name: '获取并识别' }))
    expect(await screen.findByRole('button', { name: '构建并部署' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: /项目目录与构建工具：/ }))
    await user.click(screen.getByRole('menuitemradio', { name: /Go项目/ }))
    expect(screen.queryByRole('textbox', { name: /搜索.*版本/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /构建运行时版本：/ }))
    const search = screen.getByRole('textbox', { name: '搜索构建运行时版本' })
    await user.type(search, '1.16')
    await waitFor(() => expect(screen.queryByRole('menuitemradio', { name: '1.27.1' })).not.toBeInTheDocument())
    expect(screen.getByRole('menuitemradio', { name: '1.16.7' })).toBeInTheDocument()
  })
  it('已构建产物跳过测试与构建，HTML 不依赖运行时目录', async () => {
    const user = userEvent.setup(); const gateway = await open()
    gateway.websites.runtimeCatalog = async () => { throw new Error('版本目录网络不可用') }
    await user.click(screen.getByRole('button', { name: '添加项目' }))
    await user.click(screen.getByLabelText('已构建产物（跳过测试与构建）'))
    await user.upload(screen.getByLabelText('项目压缩包'), new File(['demo'], 'docs.zip', { type: 'application/zip' }))
    await user.click(screen.getByRole('button', { name: '获取并识别' }))
    await user.click(screen.getByRole('button', { name: /项目目录与构建工具：/ }))
    await user.click(screen.getByRole('menuitemradio', { name: /HTML项目/ }))
    await user.click(screen.getByRole('button', { name: '部署并启动' }))
    expect(await screen.findByText('已明确跳过测试')).toBeInTheDocument()
  })
  it('Node 静态目标使用 Nginx，构建版本独立显示', async () => {
    const user = userEvent.setup(); await open(); await prepare('node', user)
    await user.click(screen.getByRole('button', { name: /部署目标：/ }))
    await user.click(screen.getByRole('menuitemradio', { name: 'Nginx 静态站点' }))
    expect(screen.queryByLabelText('启动命令 *')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '构建并部署' }))
    await screen.findByText(/演示部署完成/)
    await user.click(screen.getByRole('button', { name: '关闭弹窗' }))
    const project = await screen.findByRole('article', { name: 'docs' })
    expect(project).toHaveTextContent('Nginx')
    expect(project).toHaveTextContent('构建版本')
  })
  it('公开与私有 Git 传递引用及一次性令牌', async () => {
    const user = userEvent.setup(); const gateway = await open(); const git = vi.spyOn(gateway.websites.deployment!, 'git')
    await user.click(screen.getByRole('button', { name: '添加项目' })); await user.click(screen.getByRole('button', { name: 'Git 仓库' }))
    await user.type(screen.getByLabelText('Git 地址（HTTPS）'), 'https://example.org/app.git')
    await user.type(screen.getByLabelText('分支、标签或提交（可选）'), 'v1.2.3')
    await user.type(screen.getByLabelText('私有仓库令牌（可选）'), 'secret-token')
    await user.click(screen.getByRole('button', { name: '获取并识别' }))
    await screen.findByRole('button', { name: /项目目录与构建工具：/ })
    expect(git).toHaveBeenCalledWith(expect.objectContaining({ ref: 'v1.2.3', token: 'secret-token' }), expect.any(AbortSignal))
    await user.click(screen.getByRole('button', { name: '返回来源' }))
    expect(screen.getByLabelText('私有仓库令牌（可选）')).toHaveValue('')
  })
  it('版本目录失败可以重试，表单输入保留', async () => {
    const user = userEvent.setup(); const gateway = await open()
    const catalog = vi.fn().mockRejectedValueOnce(new Error('版本目录加载失败')).mockResolvedValue(MOCK_WEBSITE_RUNTIME_REPORT)
    gateway.websites.runtimeCatalog = catalog
    await prepare('python', user)
    await user.click(screen.getByRole('button', { name: '重试版本目录' }))
    await waitFor(() => expect(screen.getByRole('button', { name: /^运行时版本：3.14.7$/ })).toBeEnabled())
    expect(screen.getByLabelText('项目名称 *')).toHaveValue('docs')
    expect(catalog).toHaveBeenCalledTimes(2)
  })
  it('关闭任务后可从任务列表恢复，键盘焦点在弹窗内', async () => {
    const user = userEvent.setup(); await open(); await prepare('html', user)
    await user.click(screen.getByRole('button', { name: '构建并部署' })); await screen.findByText(/演示部署完成/)
    await user.click(screen.getByRole('button', { name: '关闭弹窗' }))
    await user.click(screen.getByRole('button', { name: '部署任务' }))
    await user.click(within(screen.getByLabelText('部署任务列表')).getByRole('button', { name: /docs/ }))
    const dialog = await screen.findByRole('dialog')
    await user.tab(); expect(dialog).toContainElement(document.activeElement as HTMLElement)
    expect(await screen.findByRole('log', { name: '部署日志' })).toHaveTextContent('演示环境')
  })
})
